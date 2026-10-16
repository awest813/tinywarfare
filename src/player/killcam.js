// ============================================================================
// TINY WARFARE — src/player/killcam.js
//
// Killcam: a short replay of how you died, seen over your killer's shoulder.
//
// Recording: every actor's feet position, facing, aim pitch, crouch, speed,
// weapon and alive state go into a ring buffer about 30 times a second, and
// every tracer is kept with its time. That is a few kilobytes and a fraction
// of a millisecond a frame.
//
// Playback: once your death has landed (the camera collapse), two stand-in
// soldiers ("ghosts", the same skinned operatives the bots and remote players
// use) replay the killer and you from 1.7 s before the kill, the camera rides
// behind the killer's shoulder along their recorded aim, the recorded tracers
// fly again with their gunshots, and the last quarter-second before the shot
// through your fall plays at half speed. Everything else in the world is live.
//
// It runs in every mode. In a respawn mode played solo, the respawn waits for
// the replay to finish unless the player skips it (Jump, a click or a tap);
// a skipped killcam respawns at the usual time. Online, the room decides when
// you respawn, and the replay simply ends there.
// ============================================================================

import * as THREE from 'three';
import { getCharacterPalette } from './profile.js';

export const KILLCAM = Object.freeze({
  SAMPLE: 1 / 30,     // s between recorded poses
  HISTORY: 4,         // s of poses and tracers kept
  BEFORE: 1.7,        // s of replay before the kill
  AFTER: 0.3,         // s after it (the fall)
  SLOW_FROM: 0.25,    // s before the kill where slow motion starts
  SLOW_RATE: 0.45,    // playback speed in slow motion
  START_AFTER: 1.1,   // s after death the replay starts (the collapse lands first)
  BACK: 1.55,         // m behind the killer's eye
  BACK_SLOW: 1.15,    // ...pushing in to this during slow motion
  RIGHT: 0.48,        // m over the right shoulder
  UP: 0.18,           // m above the eye
});

const MATCH_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd']);
// Per sample: t, x, y, z, yaw, pitch, crouch, alive, speed
const STRIDE = 9;
const RING = Math.ceil(KILLCAM.HISTORY / KILLCAM.SAMPLE) + 2;
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.08;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function actorPos(actor) {
  const p = actor && (actor.position || actor.pos);
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null;
}

/** Ring buffer of one actor's poses. */
class PoseTrack {
  constructor() {
    this.data = new Float32Array(RING * STRIDE);
    this.weapons = new Array(RING).fill(null);
    this.head = 0;   // next write slot
    this.count = 0;
  }

  push(t, actor, pitch, speed, weaponId) {
    const p = actorPos(actor);
    if (!p) return;
    const o = this.head * STRIDE;
    const d = this.data;
    d[o] = t;
    d[o + 1] = p.x;
    d[o + 2] = p.y;
    d[o + 3] = p.z;
    d[o + 4] = Number(actor.yaw) || 0;
    d[o + 5] = Number(pitch) || 0;
    d[o + 6] = actor.crouching ? 1 : 0;
    d[o + 7] = actor.alive === false ? 0 : 1;
    d[o + 8] = Number(speed) || 0;
    this.weapons[this.head] = weaponId || null;
    this.head = (this.head + 1) % RING;
    this.count = Math.min(RING, this.count + 1);
  }

  /** Oldest recorded time, or Infinity when empty. */
  oldest() {
    if (!this.count) return Infinity;
    const i = (this.head - this.count + RING) % RING;
    return this.data[i * STRIDE];
  }

  /** Interpolated pose at time t into `out` (clamped to the recorded span). */
  sample(t, out) {
    if (!this.count) return null;
    const d = this.data;
    let prev = -1;
    let next = -1;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - this.count + k + RING) % RING;
      if (d[i * STRIDE] <= t) prev = i;
      else { next = i; break; }
    }
    if (prev < 0) prev = next;
    if (next < 0) next = prev;
    const a = prev * STRIDE;
    const b = next * STRIDE;
    const span = d[b] - d[a];
    const f = span > 1e-6 ? Math.min(1, Math.max(0, (t - d[a]) / span)) : 0;
    out.x = d[a + 1] + (d[b + 1] - d[a + 1]) * f;
    out.y = d[a + 2] + (d[b + 2] - d[a + 2]) * f;
    out.z = d[a + 3] + (d[b + 3] - d[a + 3]) * f;
    out.yaw = lerpAngle(d[a + 4], d[b + 4], f);
    out.pitch = d[a + 5] + (d[b + 5] - d[a + 5]) * f;
    out.crouch = f < 0.5 ? d[a + 6] : d[b + 6];
    out.alive = f < 0.5 ? d[a + 7] : d[b + 7];
    out.speed = d[a + 8] + (d[b + 8] - d[a + 8]) * f;
    out.weaponId = this.weapons[f < 0.5 ? prev : next];
    return out;
  }
}

export default class Killcam {
  constructor(game) {
    this.game = game;
    this.time = 0;
    this.active = false;
    this.clip = null;           // { killer, tDeath, startAt, playhead, ... }
    this.skipped = false;
    this._tracks = new Map();   // actor -> PoseTrack
    this._tracers = [];         // { t, from, to, weaponId, pellet, suppressed }
    this._sampleAge = 0;
    this._ghosts = { victim: null, killer: null };
    this._pose = {};
    this._pose2 = {};

    const ev = game.events;
    ev.on('fx:tracer', (p) => this._recordTracer(p));
    ev.on('player:death', (d) => this._onPlayerDeath(d || {}));
    ev.on('input:mousedown', (d) => { if (d && d.button === 0) this.skip(); });
    for (const name of ['player:respawn', 'round:start', 'ui:menu', 'ui:start', 'ui:restart', 'game:end', 'map:changed']) {
      ev.on(name, () => this.cancel());
    }
    for (const name of ['round:start', 'map:changed', 'ui:start']) {
      ev.on(name, () => { this._tracks.clear(); this._tracers.length = 0; });
    }
  }

  enabled() {
    return this.game.settings?.killcam !== false;
  }

  /** True while a solo respawn should wait for the replay. */
  holdsRespawn() {
    if (this.skipped || !this.clip) return false;
    if (this.game.multiplayer?.active) return false;
    return true;
  }

  /** Seconds of replay left (for the HUD), or 0. */
  remaining() {
    const c = this.clip;
    if (!c) return 0;
    if (!this.active) return this._duration() + Math.max(0, c.startAt - this.time);
    return Math.max(0, this._timeLeft(c.playhead));
  }

  /** 0..1 progress through the replay. */
  progress() {
    const c = this.clip;
    if (!c || !this.active) return 0;
    const total = this._duration();
    return total > 0 ? Math.min(1, 1 - this._timeLeft(c.playhead) / total) : 1;
  }

  /** Who the replay is about, for the HUD. */
  info() {
    const c = this.clip;
    return c ? { killer: c.killer, weaponId: c.weaponId, distance: c.distance, headshot: c.headshot } : null;
  }

  skip() {
    if (!this.clip || this.skipped) return;
    this.skipped = true;
    this._end();
  }

  cancel() {
    this.skipped = false;
    this._end();
  }

  // --------------------------------------------------------------------------

  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    const g = this.game;
    const phase = g.state && g.state.phase;

    if (this.clip) {
      const input = g.input;
      if (input && typeof input.wasActionPressed === 'function' && input.wasActionPressed('jump')) this.skip();
    }
    if (this.clip && !this.active && this.time >= this.clip.startAt) this._begin();
    if (this.active) {
      this._advance(dt);
      return;
    }
    if (!MATCH_PHASES.has(phase)) return;
    this._sampleAge += dt;
    if (this._sampleAge >= KILLCAM.SAMPLE) {
      this._sampleAge %= KILLCAM.SAMPLE;
      this._record();
    }
  }

  /**
   * Owns the camera while the replay plays. Returns true when it set it.
   * Called by the spectator, after every actor has moved this frame.
   */
  applyCamera(camera) {
    const c = this.clip;
    if (!this.active || !c || !camera) return false;
    const k = this._ghosts.killer;
    if (!k || !k.pose) return false;
    const pose = k.pose;
    const eye = _a.set(pose.x, pose.y + (pose.crouch ? EYE_CROUCH : EYE_STAND), pose.z);
    const yaw = pose.yaw;
    const pitch = Math.max(-1.2, Math.min(1.2, pose.pitch));
    const cp = Math.cos(pitch);
    const fwd = _dir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    const slow = c.playhead >= c.tDeath - KILLCAM.SLOW_FROM;
    c.push += ((slow ? 1 : 0) - c.push) * Math.min(1, c.lastDt * 4);
    const back = KILLCAM.BACK + (KILLCAM.BACK_SLOW - KILLCAM.BACK) * c.push;
    // Behind, right and a little above the eye; pulled in if a wall is there.
    const want = _b.copy(eye)
      .addScaledVector(fwd, -back)
      .add({ x: Math.cos(yaw) * KILLCAM.RIGHT, y: KILLCAM.UP, z: -Math.sin(yaw) * KILLCAM.RIGHT });
    const off = want.clone().sub(eye);
    const len = off.length();
    if (len > 1e-4) {
      off.multiplyScalar(1 / len);
      const hit = this.game.world?.raycast?.(eye, off, len + 0.25);
      const reach = hit && Number.isFinite(hit.distance) ? Math.max(0.15, hit.distance - 0.25) : len;
      camera.position.copy(eye).addScaledVector(off, Math.min(len, reach));
    } else {
      camera.position.copy(eye);
    }
    if (camera.rotation.order !== 'YXZ') camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    camera.rotation.z = 0;
    return true;
  }

  // ------------------------------------------------------------- recording --

  _actors() {
    const g = this.game;
    const out = [];
    if (g.player) out.push(g.player);
    for (const b of (g.bots && g.bots.all) || []) out.push(b);
    if (g.multiplayer && g.multiplayer.active) for (const r of g.multiplayer.remotePlayers || []) out.push(r);
    return out;
  }

  _record() {
    const g = this.game;
    const t = this.time;
    for (const actor of this._actors()) {
      let track = this._tracks.get(actor);
      if (!track) { track = new PoseTrack(); this._tracks.set(actor, track); }
      const isPlayer = actor === g.player;
      const pitch = isPlayer || actor.isRemotePlayer ? actor.pitch : actor.aimPitch;
      const speed = isPlayer
        ? Math.hypot(actor.velocity?.x || 0, actor.velocity?.z || 0)
        : (actor.moveSpeed2D ?? actor.moveSpeed ?? 0);
      const weaponId = isPlayer ? g.weapons?.currentId : actor.weaponId;
      track.push(t, actor, pitch, speed, weaponId);
    }
    // Forget tracers that have aged out.
    const cutoff = t - KILLCAM.HISTORY;
    let drop = 0;
    while (drop < this._tracers.length && this._tracers[drop].t < cutoff) drop++;
    if (drop) this._tracers.splice(0, drop);
  }

  _recordTracer(p) {
    if (this.active || !p || !p.from || !p.to) return;
    if (!MATCH_PHASES.has(this.game.state?.phase)) return;
    this._tracers.push({
      t: this.time,
      from: { x: p.from.x, y: p.from.y, z: p.from.z },
      to: { x: p.to.x, y: p.to.y, z: p.to.z },
      weaponId: p.weaponId,
      pellet: p.pellet,
      suppressed: p.suppressed,
    });
    if (this._tracers.length > 400) this._tracers.splice(0, this._tracers.length - 400);
  }

  _onPlayerDeath(death) {
    const g = this.game;
    const player = g.player;
    const killer = player && player.lastKiller;
    this.cancel();
    if (!this.enabled() || !killer || typeof killer !== 'object' || killer === player) return;
    const kt = this._tracks.get(killer);
    const vt = this._tracks.get(player);
    // Need the killer's recent past; a body that only just appeared has none.
    if (!kt || !vt || kt.oldest() > this.time - KILLCAM.BEFORE * 0.6) return;
    const kp = actorPos(killer);
    const pp = actorPos(player);
    this.skipped = false;
    this.clip = {
      killer,
      tDeath: this.time,
      startAt: this.time + KILLCAM.START_AFTER,
      playhead: 0,
      lastDt: 0,
      push: 0,
      tracerCursor: 0,
      fell: false,
      weaponId: (typeof death.weapon === 'string' ? death.weapon : death.weapon?.id) || killer.weaponId || null,
      distance: kp && pp ? Math.round(Math.hypot(kp.x - pp.x, kp.z - pp.z)) : null,
      headshot: !!death.headshot,
    };
  }

  // -------------------------------------------------------------- playback --

  _duration() {
    return (KILLCAM.BEFORE - KILLCAM.SLOW_FROM) + (KILLCAM.SLOW_FROM + KILLCAM.AFTER) / KILLCAM.SLOW_RATE;
  }

  _timeLeft(playhead) {
    const c = this.clip;
    const slowStart = c.tDeath - KILLCAM.SLOW_FROM;
    const end = c.tDeath + KILLCAM.AFTER;
    if (playhead >= slowStart) return Math.max(0, (end - playhead) / KILLCAM.SLOW_RATE);
    return (slowStart - playhead) + (end - slowStart) / KILLCAM.SLOW_RATE;
  }

  _begin() {
    const c = this.clip;
    const g = this.game;
    const bots = g.bots;
    if (!bots || typeof bots.createOperativeVisual !== 'function') { this._end(); return; }
    const player = g.player;
    const victim = this._ghost('victim', player.team,
      getCharacterPalette(g.profile?.characterId || 'vanguard', player.team));
    const killer = this._ghost('killer', c.killer.team,
      c.killer.visualPalette || getCharacterPalette('vanguard', c.killer.team));
    if (!victim || !killer) { this._end(); return; }
    victim.track = this._tracks.get(player);
    killer.track = this._tracks.get(c.killer);
    c.playhead = c.tDeath - KILLCAM.BEFORE;
    c.tracerCursor = this._tracers.findIndex((tr) => tr.t >= c.playhead);
    if (c.tracerCursor < 0) c.tracerCursor = this._tracers.length;
    // The live killer is hidden while its ghost plays; put back at the end.
    c.killerMesh = c.killer.mesh || null;
    c.killerMeshVisible = c.killerMesh ? c.killerMesh.visible : false;
    for (const ghost of [victim, killer]) {
      bots.setOperativeAlive?.(ghost, true);
      ghost.mesh.visible = true;
    }
    this.active = true;
    this._advance(0);
    g.events.emit('killcam:start', this.info());
  }

  _advance(dt) {
    const c = this.clip;
    const g = this.game;
    const slow = c.playhead >= c.tDeath - KILLCAM.SLOW_FROM;
    const step = dt * (slow ? KILLCAM.SLOW_RATE : 1);
    const from = c.playhead;
    c.playhead += step;
    c.lastDt = dt;
    if (c.killerMesh) c.killerMesh.visible = false;

    // Tracers whose time has come.
    const fx = g.effects;
    while (c.tracerCursor < this._tracers.length && this._tracers[c.tracerCursor].t <= c.playhead) {
      const tr = this._tracers[c.tracerCursor++];
      if (tr.t < from) continue;
      // Straight to the effects and the audio: re-emitting would be relayed
      // to the room (and counted by everything listening for real shots).
      fx?._onTracer?.(tr);
      if (!tr.pellet) g.audio?._onBotFire?.({ origin: tr.from, weaponId: tr.weaponId });
      const kp = this._ghosts.killer.pose;
      if (kp && Math.hypot(tr.from.x - kp.x, tr.from.z - kp.z) < 1.6) this._ghosts.killer.fireAnim = 1;
    }

    for (const role of ['killer', 'victim']) {
      const ghost = this._ghosts[role];
      const pose = ghost.track.sample(c.playhead, role === 'killer' ? this._pose : this._pose2);
      if (!pose) continue;
      ghost.pose = pose;
      ghost.position.set(pose.x, pose.y, pose.z);
      ghost.yaw = pose.yaw;
      ghost.pitch = pose.pitch;
      ghost.crouching = pose.crouch > 0.5;
      ghost.moveSpeed2D = pose.speed;
      if (pose.weaponId && pose.weaponId !== ghost.weaponId) ghost.weaponId = pose.weaponId;
      ghost.mesh.position.copy(ghost.position);
      ghost.mesh.rotation.y = ghost.yaw;
    }
    // The victim falls at the kill (in slow motion).
    if (!c.fell && c.playhead >= c.tDeath) {
      c.fell = true;
      const v = this._ghosts.victim;
      const k = this._ghosts.killer.pose;
      // Fall away from the shooter.
      const side = k ? Math.sign((v.position.x - k.x) * Math.cos(v.yaw) - (v.position.z - k.z) * Math.sin(v.yaw)) || 1 : 1;
      g.bots?.setOperativeAlive?.(v, false, { fallAxis: 'z', fallSign: side });
    }
    for (const ghost of [this._ghosts.killer, this._ghosts.victim]) {
      g.bots?.updateOperativeVisual?.(ghost, step);
    }

    if (c.playhead >= c.tDeath + KILLCAM.AFTER) this._end();
  }

  _end() {
    const c = this.clip;
    const wasActive = this.active;
    this.active = false;
    if (c && c.killerMesh) c.killerMesh.visible = c.killerMeshVisible;
    for (const ghost of Object.values(this._ghosts)) if (ghost && ghost.mesh) ghost.mesh.visible = false;
    this.clip = null;
    if (wasActive) this.game.events?.emit?.('killcam:end', { skipped: this.skipped });
  }

  /** A reusable stand-in soldier, rebuilt when its side or look changes. */
  _ghost(role, team, palette) {
    const bots = this.game.bots;
    let ghost = this._ghosts[role];
    if (!ghost) {
      const position = new THREE.Vector3();
      ghost = {
        name: 'killcam-' + role,
        team,
        position,
        pos: position,
        yaw: 0,
        pitch: 0,
        crouching: false,
        moveSpeed2D: 0,
        moveSpeed: 0,
        alive: true,
        onGround: true,
        walking: false,
        useDown: false,
        velocity: new THREE.Vector3(),
        weaponId: null,
        isKillcamGhost: true,
        height: 1.83,
      };
      const mesh = bots.createOperativeVisual(ghost, palette);
      mesh.name = 'killcam-ghost-' + role;
      this.game.scene.add(mesh);
      this._ghosts[role] = ghost;
      return ghost;
    }
    if (ghost.team !== team || ghost.visualPalette !== palette) {
      ghost.team = team;
      bots.rebuildOperativeVisual(ghost, palette);
    }
    return ghost;
  }
}
