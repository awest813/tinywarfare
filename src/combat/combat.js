// ---------------------------------------------------------------------------
// TINY WARFARE — Combat resolution (spec section F)
//
// Owns: hitscan resolution for player AND bot shots (ray vs vertical capsule),
// wall penetration, grenade projectile physics (bounce via world.raycast,
// restitution 0.45 / friction 0.7), HE radial damage with LOS, flashbang blind
// math (view angle + LOS + distance), smoke LOS registry (public losBlocked),
// bomb detonation damage, and the kill / money / killfeed flow.
//
// Emits:   kill, fx:impact, fx:tracer, fx:blood, fx:explosion, fx:flash,
//          fx:smoke, hud:hitmarker, hud:flash, econ:kill
// Listens: weapon:fire, bot:fire, grenade:throw, bomb:detonated, bot:death,
//          player:death, round:start
//
// Hot-path discipline: every per-frame / per-bullet computation runs on
// pre-allocated scratch vectors and scalar math. The only allocations happen
// at event boundaries (cloned vectors inside emitted payloads, which the spec
// itself mandates) and at grenade-throw time (pooled after first use).
// ---------------------------------------------------------------------------

import { isFfa } from '../game/hostility.js';
import * as THREE from 'three';
import { resolveHumanPlayerName } from '../player/profile.js';
import { WEAPONS } from '../weapons/data.js';

// s: a wound this recent earns an assist when someone else lands the kill.
export const ASSIST_WINDOW = 10;

// --- Ballistics tuning -----------------------------------------------------
const MAX_RANGE = 250;             // hitscan max travel (m)
const LEG_ZONE = 0.5;              // bottom of capsule counted as legs (m)
const LEG_MULT = 0.75;             // leg damage multiplier
const MELEE_RANGE = 1.8;           // knife reach (m)
// A remote human's shot or throw (host side, see _remoteActionAllowed):
const REMOTE_ORIGIN_SLACK = 3.0;   // m from their chest: interpolation lag at a sprint
const REMOTE_FIRE_CAP = 0.6;       // s of cycle time that may arrive in one burst
const REMOTE_GRENADE_CAP = 3;      // grenades thrown back to back
const REMOTE_GRENADE_REFILL = 6;   // s for another
const BACKSTAB_MULT = 1.9;         // 34 -> ~65 per spec table

// A character is a broad body capsule plus a separate head sphere. The sphere
// is sized from the soldier actually drawn: the Marine's helmet is 0.218 m
// wide at game scale (operative_*.glb 'Helmet', 0.234 m x 1.83/1.965), and the
// sphere is HEAD_HITBOX_SCALE times that across. It was 0.364 m (1.7x), so a
// shot through the air beside the helmet still counted as a headshot.
const HELMET_WIDTH = 0.218;
const HEAD_HITBOX_SCALE = 1.2;
export const HEAD_RADIUS = (HELMET_WIDTH * HEAD_HITBOX_SCALE) / 2; // 0.131 m
// The body capsule's top stays where it was with the old 0.18 m head, so the
// smaller head does not turn into a body hit beside the helmet.
const BODY_TOP_DROP = 0.18;
export const BOT_CROUCH_VISUAL_SCALE = 0.78;

/** Height above the feet of the head sphere's centre, for a hitbox `height` tall. */
export function headCentreHeight(height) {
  return height - HEAD_RADIUS;
}

// --- Penetration -----------------------------------------------------------
const PEN_PROBE = 0.4;             // max wall thickness probe (m)
const PEN_MAX_THICKNESS = 0.35;    // wall a penetration-1.0 round beats (m)
const PEN_DMG_SCALE = 0.55;        // damage a penetration-1.0 round keeps

// --- Grenades --------------------------------------------------------------
const GRENADE_RADIUS = 0.07;
const GRENADE_GRAVITY = 20;
const GRENADE_RESTITUTION = 0.45;
const GRENADE_FRICTION = 0.7;      // tangential velocity kept on bounce
const GRENADE_ROLL_DRAG = 4;       // 1/s horizontal decel while rolling
const FUSE_HE = 1.6;
const FUSE_FLASH = 1.6;
const FUSE_SMOKE = 3.0;
const FUSE_SEMTEX = 2.0;           // from the throw; semtex sticks on contact
const FUSE_STUN = 1.4;
const STUN_RANGE = 11;
const SEMTEX_STICK_RADIUS = 0.6;   // m from a body's centre line            // smoke pops on rest OR after this

const HE_RADIUS = 9;
const HE_MAX_DMG = 98;              // fallback only; data.js damage is the peak
const HE_FALLOFF_EXP = 1.6;

const FLASH_RANGE = 18;
const FLASH_HOLD = 2.2;            // full-blind seconds at intensity 1
const FLASH_FADE = 1.5;

const SMOKE_RADIUS = 3.2;
const SMOKE_DURATION = 15;
const SMOKE_LIFT = 1.1;            // cloud sphere center sits above the pop point

const BOMB_RADIUS = 16;
const BOMB_MAX_DMG = 420;          // near-guaranteed kill on-site

// Fallback so an unknown weapon id never crashes resolution ('c4', stubs...).
const FALLBACK_DEF = Object.freeze({
  damage: 25,
  headshotMult: 4,
  penetration: 0.3,
  falloffStart: 25,
  falloffEnd: 90,
  falloffMinScale: 0.55,
  killReward: 300,
  tracerEvery: 1,
});


/** A position or direction with three finite components (network input). */
function finiteVec(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export default class Combat {
  constructor(game) {
    this.game = game;

    // Public smoke registry: [{ pos: Vector3, radius, until }]
    this.smokes = [];

    this._time = 0;
    this._shotCounter = 0;
    this._warned = new Set();
    // Who wounded whom, for assist credit: victim -> Map(human key -> time).
    this._hurtBy = new WeakMap();

    // Grenade projectile pool (meshes created lazily on first throw).
    this._projectiles = [];
    this._grenAssets = null;
    this._networkAuthoritySnapshot = null;

    // --- scratch vectors (never allocated in hot paths) ---
    this._sOrigin = new THREE.Vector3();   // current bullet segment origin
    this._sDir = new THREE.Vector3();      // normalized bullet direction
    this._sEnd = new THREE.Vector3();      // visible tracer end point
    this._tracerFrom = new THREE.Vector3();
    this._muzzleTmp = new THREE.Vector3();
    this._wallPoint = new THREE.Vector3();
    this._wallNormal = new THREE.Vector3();
    this._exitPoint = new THREE.Vector3();
    this._exitNormal = new THREE.Vector3();
    this._probeOrigin = new THREE.Vector3();
    this._negDir = new THREE.Vector3();
    this._hitPos = new THREE.Vector3();
    this._center = new THREE.Vector3();    // detonation center (plain-obj safe)
    this._nrm = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._v5 = new THREE.Vector3();
    this._v6 = new THREE.Vector3();
    this._v7 = new THREE.Vector3();
    this._v8 = new THREE.Vector3();

    // capsule-test result registers (avoid per-test object allocation)
    this._capY = 0;          // hit height of the most recent capsule test
    this._hitChar = null;    // nearest character hit by _testCharacters
    this._hitIsPlayer = false;
    this._hitFeetY = 0;
    this._hitHeight = 0;
    this._capYBest = 0;
    this._capPart = 'body';
    this._hitPartBest = 'body';

    const ev = game.events;
    ev.on('weapon:fire', (e) => this._onWeaponFire(e));
    ev.on('bot:fire', (e) => this._onBotFire(e));
    ev.on('grenade:throw', (e) => this._onGrenadeThrow(e));
    // A bot's frag: its own event, since grenade:throw drives the player's
    // viewmodel, sound and spawn protection.
    ev.on('bot:grenade', (e) => { if (e && e.bot) this._onGrenadeThrow({ ...e, thrower: e.bot }); });
    ev.on('bomb:detonated', (e) => this._onBombDetonated(e));
    ev.on('bot:death', (e) => this._onBotDeath(e));
    ev.on('remote:death', (e) => this._onRemoteDeath(e));
    ev.on('player:death', (e) => this._onPlayerDeath(e));
    ev.on('round:start', () => this._onRoundStart());
    // Grenades still in flight when a player quits to the menu went off
    // there, scoring kills into a finished match.
    ev.on('ui:menu', () => this._onRoundStart());
    // ...and so did ones in the air when the match ended: kills, score and
    // a killcam on the end screen, after the result was already paid.
    ev.on('game:end', () => this._onRoundStart());
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * True if the segment a→b passes within the radius of any active smoke.
   * Pure scalar math — safe to call from bot perception every think tick.
   * a/b may be THREE.Vector3 or any {x,y,z}.
   */
  losBlocked(a, b) {
    const s = this.smokes;
    const n = s.length;
    if (n === 0 || !a || !b) return false;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz;
    for (let i = 0; i < n; i++) {
      const sm = s[i];
      const p = sm.pos;
      let t = 0;
      if (len2 > 1e-8) {
        t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }
      const cx = a.x + abx * t - p.x;
      const cy = a.y + aby * t - p.y;
      const cz = a.z + abz * t - p.z;
      if (cx * cx + cy * cy + cz * cz < sm.radius * sm.radius) return true;
    }
    return false;
  }

  /** Live frag and semtex grenades, for bots to run from. */
  liveExplosives() {
    const out = [];
    for (const p of this._projectiles) {
      if (p.active && (p.type === 'hegrenade' || p.type === 'semtex')) out.push(p);
    }
    return out;
  }

  update(dt) {
    this._time += dt;

    const mp = this.game.multiplayer;
    const replica = !!(mp && mp.active && typeof mp.isAuthority === 'function' && !mp.isAuthority());
    if (!replica && this._projectiles.length) this._updateProjectiles(dt);

    // prune expired smokes (small array, reverse splice keeps `smokes` public
    // and stable for readers)
    const s = this.smokes;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].until <= this._time) s.splice(i, 1);
    }
  }

  /**
   * Whether a remote human's shot or throw is believable: it leaves from
   * near their body, and they are not firing faster than their gun cycles
   * (each shot spends the weapon's own cycle time from a small budget, so
   * claiming a different weapon per shot gains nothing). Grenades share a
   * slow budget. The client's message used to be taken as given.
   */
  _remoteActionAllowed(shooter, origin, cost) {
    const at = shooter.position || shooter.pos;
    if (at && Math.hypot(origin.x - at.x, origin.y - (at.y + 1.3), origin.z - at.z) > REMOTE_ORIGIN_SLACK) return false;
    const now = this._time;
    const key = cost.grenade ? '_grenadeBudget' : '_fireBudget';
    const cap = cost.grenade ? REMOTE_GRENADE_CAP : REMOTE_FIRE_CAP;
    const rate = cost.grenade ? 1 / REMOTE_GRENADE_REFILL : 1;
    const last = shooter[key + 'At'];
    let budget = Number.isFinite(shooter[key]) ? shooter[key] : cap;
    if (Number.isFinite(last)) budget = Math.min(cap, budget + Math.max(0, now - last) * rate);
    shooter[key + 'At'] = now;
    if (budget < cost.amount) { shooter[key] = budget; return false; }
    shooter[key] = budget - cost.amount;
    return true;
  }

  /** Resolve a non-host human's shot on the authoritative host. */
  fireRemote(e, shooter) {
    if (!e || !shooter || !shooter.alive || !finiteVec(e.origin) || !finiteVec(e.dir)) return;
    const shotDef = this._def(e.melee ? 'knife' : e.weaponId || 'usp');
    const cycle = 60 / Math.max(30, Number(shotDef && shotDef.rpm) || 600);
    if (!this._remoteActionAllowed(shooter, e.origin, { amount: cycle * 0.8 })) return;
    shooter.spawnProtection = 0; // firing ends a fresh spawn's immunity
    // The authority hears the shot here; replicas hear it from the tracer.
    this.game.events.emit('audio:shot', { origin: e.origin, weaponId: e.melee ? 'knife' : e.weaponId, suppressed: !!e.suppressed });
    if (!e.melee) {
      this.game.events.emit('remote:fire', { origin: e.origin, team: shooter.team, suppressed: !!e.suppressed });
    }
    const weaponId = e.weaponId || 'usp';
    const def = this._def(weaponId);
    this._sOrigin.set(e.origin.x, e.origin.y, e.origin.z);
    this._sDir.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._sDir.lengthSq() < 1e-10) return;
    this._sDir.normalize();
    if (e.melee) {
      shooter.gesture = 'slash';
      this._resolveMelee(shooter, shooter.team, false, weaponId, def);
    } else {
      this._suppressedShot = !!e.suppressed;
      try {
        this._fireBullet(weaponId, def, shooter, shooter.team, false, null);
        this._firePellets(e, weaponId, def, shooter, shooter.team, false);
      } finally {
        this._suppressedShot = false;
      }
    }
  }

  /** Spawn a non-host human's grenade in the authoritative simulation; true when thrown. */
  throwRemoteGrenade(e, shooter) {
    if (!e || !shooter || !shooter.alive || !finiteVec(e.origin)) return false;
    if (!this._remoteActionAllowed(shooter, e.origin, { grenade: true, amount: 1 })) return false;
    shooter.spawnProtection = 0;
    this._onGrenadeThrow({
      type: e.grenadeType || 'hegrenade',
      origin: e.origin,
      dir: e.dir,
      strength: e.strength,
      thrower: shooter,
    });
    return true;
  }

  /** Apply a host-replicated flashbang to this client's local camera/HUD. */
  applyNetworkFlash(pos) {
    if (pos) this._flashLocalPlayer(pos);
  }

  /** Apply a host-replicated stun grenade (slows, never blinds). */
  applyNetworkStun(pos) {
    if (!pos) return;
    this._v7.set(pos.x, pos.y, pos.z);
    this._stunLocalPlayer(this._v7);
  }

  _stunLocalPlayer(pos) {
    const pl = this.game.player;
    if (!pl || !pl.alive || !pl.position || typeof pl.stun !== 'function') return;
    this._v6.copy(pl.position);
    this._v6.y += 1.4;
    const d = this._v6.distanceTo(pos);
    if (d <= STUN_RANGE && this._losClear(pos, this._v6)) {
      const seconds = 1.2 + 2.6 * (1 - d / STUN_RANGE);
      pl.stun(seconds);
      this.game.events.emit('hud:stun', { duration: seconds });
    }
  }

  networkAuthoritySnapshot() {
    const mp = this.game.multiplayer;
    return {
      projectiles: this._projectiles.filter((projectile) => projectile.active).map((projectile) => ({
        type: projectile.type,
        pos: { x: projectile.pos.x, y: projectile.pos.y, z: projectile.pos.z },
        vel: { x: projectile.vel.x, y: projectile.vel.y, z: projectile.vel.z },
        spin: { x: projectile.spin.x, y: projectile.spin.y, z: projectile.spin.z },
        fuse: Math.max(0, Number(projectile.fuse) || 0),
        resting: !!projectile.resting,
        grounded: !!projectile.grounded,
        throwerId: projectile.thrower?.networkId ||
          (projectile.thrower === this.game.player ? mp?.localId || null : null),
        throwerName: projectile.thrower?.name || null,
        throwerTeam: projectile.throwerTeam,
      })),
      smokes: this.smokes.map((smoke) => ({
        pos: { x: smoke.pos.x, y: smoke.pos.y, z: smoke.pos.z },
        radius: smoke.radius,
        remaining: Math.max(0, smoke.until - this._time),
      })),
    };
  }

  /** Store transient combat state without simulating it on a replica. */
  applyNetworkSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    this.suspendNetworkAuthority();
    this._networkAuthoritySnapshot = snapshot;
    return true;
  }

  /** Retire authority-only objects immediately after this client is demoted. */
  suspendNetworkAuthority() {
    for (const projectile of this._projectiles) {
      if (projectile.active) this._release(projectile);
    }
    this.smokes.length = 0;
    return true;
  }

  /** Rehydrate grenades/smoke when this replica receives the authority lease. */
  resumeNetworkAuthority() {
    const snapshot = this._networkAuthoritySnapshot;
    if (!snapshot) return false;
    for (const projectile of this._projectiles) {
      if (projectile.active) this._release(projectile);
    }
    const entries = Array.isArray(snapshot.projectiles) ? snapshot.projectiles.slice(0, 24) : [];
    for (const state of entries) {
      if (!state || !state.pos || !state.vel) continue;
      const projectile = this._acquireProjectile(state.type || 'hegrenade');
      projectile.pos.set(Number(state.pos.x) || 0, Number(state.pos.y) || 0, Number(state.pos.z) || 0);
      projectile.vel.set(Number(state.vel.x) || 0, Number(state.vel.y) || 0, Number(state.vel.z) || 0);
      projectile.spin.set(
        Number(state.spin?.x) || 0,
        Number(state.spin?.y) || 0,
        Number(state.spin?.z) || 0,
      );
      projectile.fuse = Math.max(0, Number(state.fuse) || 0);
      projectile.resting = !!state.resting;
      projectile.grounded = !!state.grounded;
      projectile.thrower = this._networkThrower(state.throwerId, state.throwerName);
      projectile.throwerTeam = state.throwerTeam === 't' ? 't' : 'ct';
      projectile.mesh.position.copy(projectile.pos);
    }

    this.smokes.length = 0;
    const smokes = Array.isArray(snapshot.smokes) ? snapshot.smokes.slice(0, 16) : [];
    for (const state of smokes) {
      const remaining = Math.max(0, Number(state?.remaining) || 0);
      if (!state?.pos || remaining <= 0) continue;
      const cloud = new THREE.Vector3(
        Number(state.pos.x) || 0,
        Number(state.pos.y) || 0,
        Number(state.pos.z) || 0,
      );
      // A client resyncing mid-smoke must see the cloud that blocks vision.
      const key = cloud.x.toFixed(1) + ',' + cloud.z.toFixed(1);
      if (!this._shownSmokes) this._shownSmokes = new Map();
      if (!(this._shownSmokes.get(key) > this._time)) {
        this.game.events.emit('fx:smoke', { pos: cloud.clone().setY(cloud.y - SMOKE_LIFT), duration: remaining, _network: true });
      }
      this._shownSmokes.set(key, this._time + remaining);
      this.smokes.push({
        pos: cloud,
        radius: Math.max(0.1, Number(state.radius) || SMOKE_RADIUS),
        until: this._time + remaining,
      });
    }
    this._networkAuthoritySnapshot = null;
    return true;
  }

  // =========================================================================
  // Fire event intake
  // =========================================================================

  _onWeaponFire(e) {
    // weapon:fire is the player's channel per spec.
    if (!e || !e.origin || !e.dir) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const weaponId = e.weaponId || 'usp';
    const def = this._def(weaponId);
    const shooter = this.game.player || null;
    const team = (shooter && shooter.team) || 'ct';

    this._sOrigin.set(e.origin.x, e.origin.y, e.origin.z);
    this._sDir.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._sDir.lengthSq() < 1e-10) return;
    this._sDir.normalize();

    if (e.melee) {
      this._resolveMelee(shooter, team, true, weaponId, def);
    } else {
      // One trigger pull is one hitmarker, however many pellets connect: the
      // shotgun used to flash and tick up to eight of them per blast.
      const agg = this._markerAgg = { hit: false, headshot: false, kill: false };
      // A suppressed round draws the faint tracer effects.js has for it.
      this._suppressedShot = !!e.suppressed;
      try {
        this._fireBullet(weaponId, def, shooter, team, true, null);
        this._firePellets(e, weaponId, def, shooter, team, true);
      } finally {
        this._markerAgg = null;
        this._suppressedShot = false;
      }
      if (agg.hit) this.game.events.emit('hud:hitmarker', { headshot: agg.headshot, kill: agg.kill });
    }
  }

  /** Shotgun pellets beyond the first: each is its own hitscan. */
  _firePellets(e, weaponId, def, shooter, team, byPlayer) {
    const pellets = Array.isArray(e.pellets) ? e.pellets : null;
    if (!pellets) return;
    const max = Math.min(pellets.length, Math.max(0, (def.pellets || 1) - 1), 15);
    for (let i = 0; i < max; i++) {
      const d = pellets[i];
      if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)) continue;
      this._sOrigin.set(e.origin.x, e.origin.y, e.origin.z);
      this._sDir.set(d.x, d.y, d.z);
      if (this._sDir.lengthSq() < 1e-10) continue;
      this._sDir.normalize();
      // Extra pellets still draw tracers, but one blast is one sound.
      this._pelletTracer = true;
      try {
        this._fireBullet(weaponId, def, shooter, team, byPlayer, null);
      } finally {
        this._pelletTracer = false;
      }
    }
  }

  _onBotFire(e) {
    if (!e || !e.origin || !e.dir) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const weaponId = e.weaponId || 'ak47';
    const def = this._def(weaponId);
    const shooter = e.bot || null;
    const team = (shooter && shooter.team) || 't';

    this._sOrigin.set(e.origin.x, e.origin.y, e.origin.z);
    this._sDir.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._sDir.lengthSq() < 1e-10) return;
    this._sDir.normalize();

    // gun tip provided in the event, else eye pos (spec F)
    const muzzle = (e.muzzle && e.muzzle.isVector3) ? e.muzzle : null;
    this._fireBullet(weaponId, def, shooter, team, false, muzzle);
    this._firePellets(e, weaponId, def, shooter, team, false);
  }

  // =========================================================================
  // Hitscan
  // =========================================================================

  _fireBullet(weaponId, def, shooter, shooterTeam, byPlayer, muzzleOverride) {
    // Resolve the tracer origin BEFORE resolution mutates scratch state.
    this._tracerFrom.copy(this._sOrigin);
    if (byPlayer) {
      const vm = this.game.viewmodel;
      if (vm && typeof vm.getMuzzleWorldPos === 'function') {
        const m = vm.getMuzzleWorldPos(this._muzzleTmp);
        if (m && m.isVector3) this._tracerFrom.copy(m);
        else this._tracerFrom.copy(this._muzzleTmp);
      }
    } else if (muzzleOverride) {
      this._tracerFrom.copy(muzzleOverride);
    }

    this._resolveBullet(weaponId, def, shooter, shooterTeam, byPlayer);

    // one tracer per shot, muzzle → first visible termination point
    this._shotCounter++;
    const every = def.tracerEvery != null ? def.tracerEvery : 1;
    if (every > 0 && this._shotCounter % every === 0) {
      this.game.events.emit('fx:tracer', {
        from: this._tracerFrom.clone(),
        to: this._sEnd.clone(),
        weaponId,
        shooterId: shooter && shooter.networkId ? shooter.networkId
          : (shooter === this.game.player ? this.game.player.networkId : null),
        pellet: this._pelletTracer || undefined,
        suppressed: this._suppressedShot || undefined,
        // Who fired, for the near-miss crack (audio): never your own rounds,
        // nor a teammate's outside free-for-all.
        team: shooterTeam || undefined,
        byPlayer: byPlayer || undefined,
      });
    }
  }

  /**
   * Marches the bullet: up to two segments (one wall penetration max).
   * Sets this._sEnd to the end of the FIRST segment (the visible tracer end).
   */
  _resolveBullet(weaponId, def, shooter, shooterTeam, byPlayer) {
    const ev = this.game.events;
    let remaining = MAX_RANGE;
    let traveled = 0;
    let dmgScale = 1;
    let canPen = (def.penetration || 0) > 0.01;

    // default end: full range (overwritten on first-segment termination)
    this._sEnd.copy(this._sOrigin).addScaledVector(this._sDir, remaining);

    for (let seg = 0; seg < 2; seg++) {
      const world = this.game.world;

      // 1) world geometry along this segment
      let hasWall = false;
      let wallDist = Infinity;
      let wallSurface = 'concrete';
      if (world && typeof world.raycast === 'function') {
        const hit = world.raycast(this._sOrigin, this._sDir, remaining);
        if (hit) {
          hasWall = true;
          wallDist = hit.distance;
          // copy immediately — world may reuse internal vectors
          this._wallPoint.copy(hit.point);
          this._wallNormal.copy(hit.normal);
          wallSurface = hit.surface
            || (hit.mesh && hit.mesh.userData && hit.mesh.userData.surface)
            || 'concrete';
        }
      }

      // 2) nearest character strictly before the wall
      const charT = this._testCharacters(
        this._sOrigin, this._sDir, Math.min(remaining, wallDist), shooter
      );

      if (charT >= 0) {
        // Bullet stops on any character; only enemies take damage (spec F).
        const target = this._hitChar;
        this._hitPos.copy(this._sOrigin).addScaledVector(this._sDir, charT);
        if (seg === 0) this._sEnd.copy(this._hitPos);

        const targetTeam = target.team || (this._hitIsPlayer ? 'ct' : 't');
        const ffa = isFfa(this.game);
        if (ffa ? target !== shooter : targetTeam !== shooterTeam) {
          const part = this._hitPartBest;
          const headshot = part === 'head';
          const zone = headshot
            ? (def.headshotMult != null ? def.headshotMult : 4)
            : (part === 'legs' ? LEG_MULT : 1);
          const dist = traveled + charT;
          const dmg = Math.max(
            1,
            Math.round((def.damage != null ? def.damage : 25)
              * this._falloff(def, dist) * zone * dmgScale)
          );
          if (target.spawnProtection > 0) {
            // Fresh spawns are immune: a glancing spark, never false blood.
            ev.emit('fx:impact', { point: this._hitPos.clone(), normal: this._sDir.clone().negate(), surface: 'metal', pellet: this._pelletTracer || undefined });
          } else {
            ev.emit('fx:blood', {
              point: this._hitPos.clone(),
              dir: this._sDir.clone(),
            });
          }
          this._applyDamage(target, this._hitIsPlayer, dmg, shooter, weaponId, headshot, part, byPlayer);
        }
        return;
      }

      if (!hasWall) return; // flew off into the sky

      // 3) wall impact (entry)
      ev.emit('fx:impact', {
        point: this._wallPoint.clone(),
        normal: this._wallNormal.clone(),
        surface: wallSurface,
        pellet: this._pelletTracer || undefined,
      });
      if (seg === 0) this._sEnd.copy(this._wallPoint);

      // 4) penetration — one max
      if (!canPen) return;
      canPen = false;

      // Probe: step past the entry point, cast back toward it. The backside
      // face of a thin wall faces the probe origin, so a front-face raycast
      // finds it; anything thicker than the probe yields no hit (we would be
      // casting from inside the solid).
      this._probeOrigin.copy(this._wallPoint).addScaledVector(this._sDir, PEN_PROBE);
      this._negDir.copy(this._sDir).negate();
      let back = null;
      if (world && typeof world.raycast === 'function') {
        back = world.raycast(this._probeOrigin, this._negDir, PEN_PROBE - 0.005);
      }
      if (!back) return;
      const thickness = PEN_PROBE - back.distance;
      // The weapon's penetration rating decides how much wall it beats and how
      // much damage survives: it used to be a bare on/off switch, so a Glock
      // (0.25) wallbanged exactly like the LMG (1.1). Now the Glock gets through
      // a door or a fence (~9 cm), a rifle most interior walls.
      const pen = Math.min(1.1, Math.max(0, def.penetration || 0));
      if (thickness <= 0 || thickness > PEN_MAX_THICKNESS * pen) return;

      this._exitPoint.copy(back.point);
      this._exitNormal.copy(back.normal);
      const exitSurface = back.surface
        || (back.mesh && back.mesh.userData && back.mesh.userData.surface)
        || 'concrete';

      // exit impact on the far side
      ev.emit('fx:impact', {
        point: this._exitPoint.clone(),
        normal: this._exitNormal.clone(),
        surface: exitSurface,
      });

      traveled += wallDist + thickness;
      remaining -= wallDist + thickness;
      if (remaining <= 0.25) return;
      dmgScale *= Math.min(0.75, PEN_DMG_SCALE * (0.5 + 0.5 * pen));
      this._sOrigin.copy(this._exitPoint).addScaledVector(this._sDir, 0.01);
      // A thin slab laid against a thicker one (Dustyard's open door leaves on
      // the 0.6 m mid wall) "exits" straight into the next solid. Raycasts
      // from inside a solid hit nothing (front faces only), so the bullet then
      // crossed the whole wall: rifles killed through concrete at mid. The
      // probe only measured the slab; the wall is thicker, so the round stops.
      if (Array.isArray(world.colliders) && world.colliders.some((box) => box.containsPoint(this._sOrigin))) return;
    }
  }

  _resolveMelee(shooter, shooterTeam, byPlayer, weaponId, def) {
    const ev = this.game.events;
    const world = this.game.world;

    let hasWall = false;
    let wallDist = Infinity;
    let wallSurface = 'concrete';
    if (world && typeof world.raycast === 'function') {
      const hit = world.raycast(this._sOrigin, this._sDir, MELEE_RANGE);
      if (hit) {
        hasWall = true;
        wallDist = hit.distance;
        this._wallPoint.copy(hit.point);
        this._wallNormal.copy(hit.normal);
        wallSurface = hit.surface || 'concrete';
      }
    }

    const charT = this._testCharacters(
      this._sOrigin, this._sDir, Math.min(MELEE_RANGE, wallDist), shooter
    );

    if (charT >= 0) {
      const target = this._hitChar;
      const targetTeam = target.team || (this._hitIsPlayer ? 'ct' : 't');
      if (!isFfa(this.game) && targetTeam === shooterTeam) return; // no friendly stabs
      this._hitPos.copy(this._sOrigin).addScaledVector(this._sDir, charT);

      // Backstab: victim facing points away from the attacker, i.e. roughly
      // along the attack direction (yaw 0 faces -Z).
      const vyaw = target.yaw || 0;
      const facX = -Math.sin(vyaw);
      const facZ = -Math.cos(vyaw);
      const horiz = Math.hypot(this._sDir.x, this._sDir.z) || 1;
      const backstab = (facX * this._sDir.x + facZ * this._sDir.z) / horiz > 0.35;

      const base = def.damage != null ? def.damage : 34;
      const dmg = backstab
        ? (def.damageBack != null ? def.damageBack : Math.round(base * BACKSTAB_MULT))
        : base;
      const part = this._hitPartBest;

      if (target.spawnProtection > 0) {
        // Same as a bullet on a fresh spawn: a glancing spark, never false blood.
        ev.emit('fx:impact', { point: this._hitPos.clone(), normal: this._sDir.clone().negate(), surface: 'metal' });
      } else {
        ev.emit('fx:blood', {
          point: this._hitPos.clone(),
          dir: this._sDir.clone(),
        });
      }
      this._applyDamage(target, this._hitIsPlayer, dmg, shooter, weaponId, false, part, byPlayer);
      return;
    }

    // knife scraping a wall — little spark/chip
    if (hasWall && wallDist <= MELEE_RANGE) {
      ev.emit('fx:impact', {
        point: this._wallPoint.clone(),
        normal: this._wallNormal.clone(),
        surface: wallSurface,
      });
    }
  }

  _applyDamage(target, isPlayer, dmg, shooter, weaponId, headshot, part, byPlayer) {
    if (!target || typeof target.takeDamage !== 'function') return;
    // The round is decided and the bots stand frozen: a kill now would be a
    // free one (cash, score, XP) on a target that cannot answer.
    if (this.game.state && this.game.state.phase === 'roundEnd') return;
    const shielded = target.spawnProtection > 0;
    // Stamp the wound before takeDamage: a kill emits its 'kill' event from
    // inside it, and the killer's own hit must not read as an assist.
    this._noteWound(target, shooter);
    target.takeDamage(dmg, { from: shooter, weapon: weaponId, headshot, part });
    if (shielded) return; // no hit marker for a hit that did nothing
    // Player hit feedback — bot targets only ('bot:death' fires synchronously
    // inside takeDamage, so `alive` is already settled here).
    if (byPlayer && !isPlayer) {
      const agg = this._markerAgg;
      if (agg) {
        agg.hit = true;
        agg.headshot = agg.headshot || !!headshot;
        agg.kill = agg.kill || !target.alive;
      } else {
        this.game.events.emit('hud:hitmarker', { headshot, kill: !target.alive });
      }
    }
  }

  // =========================================================================
  // Character capsule tests
  // =========================================================================

  /**
   * Nearest character hit along the ray, or -1. Skips the shooter, dead
   * characters, and anything beyond maxDist. Results land in instance
   * registers: _hitChar/_hitIsPlayer/_hitFeetY/_hitHeight/_capYBest.
   */
  _testCharacters(o, d, maxDist, shooter) {
    let bestT = -1;
    this._hitChar = null;
    const g = this.game;
    const cfg = g.config || {};

    // --- the player ---
    const pl = g.player;
    if (pl && pl.alive && pl !== shooter) {
      let fx = 0, fy = 0, fz = 0, radius = -1, height = 0;
      if (typeof pl.hitCapsule === 'function') {
        const cap = pl.hitCapsule();
        if (cap && cap.pos) {
          fx = cap.pos.x; fy = cap.pos.y; fz = cap.pos.z;
          radius = cap.radius; height = cap.height;
        }
      }
      if (radius < 0 && pl.position) {
        fx = pl.position.x; fy = pl.position.y; fz = pl.position.z;
        radius = (cfg.PLAYER && cfg.PLAYER.RADIUS) || 0.35;
        height = (cfg.PLAYER && cfg.PLAYER.HEIGHT_STAND) || 1.83;
      }
      // Seen by everyone else the player is the operative's crouch clip, which
      // stands ~78% of full height, not the 1.25 m movement capsule — and bots
      // aim 1.35 m above the feet, so a crouched player was nearly unhittable.
      if (pl.crouching) height = Math.max(height, ((cfg.PLAYER && cfg.PLAYER.HEIGHT_STAND) || 1.83) * BOT_CROUCH_VISUAL_SCALE);
      if (radius > 0) {
        const t = this._rayCharacter(
          o.x, o.y, o.z, d.x, d.y, d.z, maxDist,
          fx, fy, fz, radius, height
        );
        if (t >= 0) {
          bestT = t;
          this._hitChar = pl;
          this._hitIsPlayer = true;
          this._hitFeetY = fy;
          this._hitHeight = height;
          this._capYBest = this._capY;
          this._hitPartBest = this._capPart;
        }
      }
    }

    // --- bots ---
    const bots = g.bots && g.bots.all;
    if (bots) {
      const defRadius = (cfg.BOT && cfg.BOT.RADIUS) || 0.35;
      const defHeight = (cfg.BOT && cfg.BOT.HEIGHT) || 1.83;
      for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (!b || b === shooter || !b.alive || !b.pos) continue;
        const radius = b.radius != null ? b.radius : defRadius;
        let height = b.height != null ? b.height : defHeight;
        // The Duck clip/primitive crouch pose remains about 78% of standing
        // height, while movement uses a shorter clearance capsule. Combat must
        // follow the visible head or carefully aimed shots pass over it.
        if (b.crouching) height = Math.max(height, defHeight * BOT_CROUCH_VISUAL_SCALE);
        const t = this._rayCharacter(
          o.x, o.y, o.z, d.x, d.y, d.z, maxDist,
          b.pos.x, b.pos.y, b.pos.z, radius, height
        );
        if (t >= 0 && (bestT < 0 || t < bestT)) {
          bestT = t;
          this._hitChar = b;
          this._hitIsPlayer = false;
          this._hitFeetY = b.pos.y;
          this._hitHeight = height;
          this._capYBest = this._capY;
          this._hitPartBest = this._capPart;
        }
      }
    }

    // --- remote human players (authoritative host only for damage) ---
    const remotes = g.multiplayer && g.multiplayer.remotePlayers;
    if (Array.isArray(remotes)) {
      const defRadius = (cfg.PLAYER && cfg.PLAYER.RADIUS) || 0.35;
      const defHeight = (cfg.PLAYER && cfg.PLAYER.HEIGHT_STAND) || 1.83;
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        if (!r || r === shooter || !r.alive || !r.position) continue;
        const radius = r.radius != null ? r.radius : defRadius;
        let height = r.height != null ? r.height : defHeight;
        // Same rule as bots: a crouched (or sliding) remote is drawn with the
        // operative crouch clip, taller than its movement capsule.
        if (r.crouching) height = Math.max(height, defHeight * BOT_CROUCH_VISUAL_SCALE);
        const t = this._rayCharacter(
          o.x, o.y, o.z, d.x, d.y, d.z, maxDist,
          r.position.x, r.position.y, r.position.z, radius, height
        );
        if (t >= 0 && (bestT < 0 || t < bestT)) {
          bestT = t;
          this._hitChar = r;
          this._hitIsPlayer = false;
          this._hitFeetY = r.position.y;
          this._hitHeight = height;
          this._capYBest = this._capY;
          this._hitPartBest = this._capPart;
        }
      }
    }

    return bestT;
  }

  /**
   * Ray vs the compound character hitbox. The body keeps the movement radius
   * for forgiving torso/limb contact, but ends at the neck; a much smaller
   * sphere owns headshot classification. Returns the first physical contact
   * and stores its part/height in the scratch registers.
   */
  _rayCharacter(ox, oy, oz, dx, dy, dz, maxDist, fx, fy, fz, radius, height) {
    const headRadius = HEAD_RADIUS;
    // The sphere's top meets the top of the head: on the 1.83 m operative its
    // centre is at 1.70 m, the helmet's own centre (1.704 m).
    const headY = fy + headCentreHeight(height);
    // The body's rounded shoulder volume rises toward the head; the sphere
    // still exclusively decides headshot classification.
    const bodyHeight = Math.max(radius * 2, height - BODY_TOP_DROP);

    const bodyT = this._rayCapsule(
      ox, oy, oz, dx, dy, dz, maxDist,
      fx, fy, fz, radius, bodyHeight
    );
    const bodyY = this._capY;
    const headT = this._raySphere(
      ox, oy, oz, dx, dy, dz,
      fx, headY, fz, headRadius, maxDist
    );

    // A headshot is a ray that reaches the head FIRST (2 cm of grace for the
    // two volumes' shared surface). One that enters the chest and would carry
    // on up into the head — a shot from below, or through the neck — is a body
    // hit, as the shooter can see it was.
    if (headT >= 0 && (bodyT < 0 || headT <= bodyT + 0.02)) {
      this._capY = oy + dy * headT;
      this._capPart = 'head';
      return bodyT >= 0 ? Math.min(bodyT, headT) : headT;
    }
    if (bodyT >= 0) {
      this._capY = bodyY;
      this._capPart = bodyY <= fy + LEG_ZONE ? 'legs' : 'body';
      return bodyT;
    }
    this._capPart = 'body';
    return -1;
  }

  /**
   * Ray vs vertical capsule, all-scalar. Direction must be normalized.
   * Capsule: feet at (fx,fy,fz), axis +Y, given radius/height.
   * Returns distance t along the ray (>= 0) or -1; stores hit height in _capY.
   */
  _rayCapsule(ox, oy, oz, dx, dy, dz, maxDist, fx, fy, fz, radius, height) {
    const y0 = fy + radius;              // bottom sphere center height
    const y1 = fy + height - radius;     // top sphere center height
    const rx = ox - fx;
    const rz = oz - fz;
    const a = dx * dx + dz * dz;
    const c = rx * rx + rz * rz - radius * radius;

    if (a > 1e-9) {
      const b = 2 * (rx * dx + rz * dz);
      const disc = b * b - 4 * a * c;
      // The 2D projected ray misses the circle -> misses cylinder AND caps.
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / (2 * a);
      if (t < 0 && c < 0) {
        // origin inside the infinite cylinder
        if (oy > fy && oy < fy + height) {
          this._capY = oy;
          return 0.0005; // point-blank body contact
        }
        t = -1; // above/below — caps decide
      }
      if (t >= 0 && t <= maxDist) {
        const y = oy + dy * t;
        if (y >= y0 && y <= y1) {
          // side hit is provably the earliest capsule contact
          this._capY = y;
          return t;
        }
      }
    } else if (c > 0) {
      return -1; // vertical ray outside the cylinder footprint
    }

    // sphere caps
    let best = -1;
    let t = this._raySphere(ox, oy, oz, dx, dy, dz, fx, y1, fz, radius, maxDist);
    if (t >= 0) {
      best = t;
      this._capY = oy + dy * t;
    }
    t = this._raySphere(ox, oy, oz, dx, dy, dz, fx, y0, fz, radius, maxDist);
    if (t >= 0 && (best < 0 || t < best)) {
      best = t;
      this._capY = oy + dy * t;
    }
    return best;
  }

  _raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
    const px = ox - cx;
    const py = oy - cy;
    const pz = oz - cz;
    const b = px * dx + py * dy + pz * dz;
    const c = px * px + py * py + pz * pz - r * r;
    if (c > 0 && b > 0) return -1; // outside and pointing away
    const disc = b * b - c;
    if (disc < 0) return -1;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = c < 0 ? 0.0005 : -1; // inside the sphere -> immediate
    if (t < 0 || t > maxDist) return -1;
    return t;
  }

  _falloff(def, dist) {
    const start = def.falloffStart != null ? def.falloffStart : 25;
    const end = def.falloffEnd != null ? def.falloffEnd : 90;
    const min = def.falloffMinScale != null ? def.falloffMinScale : 0.55;
    if (dist <= start) return 1;
    if (dist >= end) return min;
    return 1 - (1 - min) * ((dist - start) / (end - start));
  }

  // =========================================================================
  // Grenades
  // =========================================================================

  _onGrenadeThrow(e) {
    if (!e || !finiteVec(e.origin) || !finiteVec(e.dir)) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority() && !e.thrower) return;
    const type = e.type || 'hegrenade';
    const p = this._acquireProjectile(type);
    p.throwId = (this._throwSeq = (this._throwSeq || 0) + 1);

    p.pos.set(e.origin.x, e.origin.y, e.origin.z);
    this._v1.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._v1.lengthSq() < 1e-8) this._v1.set(0, 0, -1);
    this._v1.normalize();

    // A remote throw's strength comes off the wire: keep it finite and sane.
    const strength = Number.isFinite(e.strength) ? Math.max(0, Math.min(20, e.strength)) : 14;
    p.vel.copy(this._v1).multiplyScalar(strength);

    // inherit thrower velocity ×0.3 (only the player throws per spec, but
    // stay generic if a bot ever appears in the payload)
    const thrower = e.thrower || e.bot || this.game.player || null;
    if (thrower && thrower.velocity && thrower.velocity.isVector3) {
      p.vel.addScaledVector(thrower.velocity, 0.3);
    }
    p.thrower = thrower;
    p.throwerTeam = (thrower && thrower.team) || 'ct';
    p.fuse = type === 'smokegrenade' ? FUSE_SMOKE
      : type === 'flashbang' ? FUSE_FLASH
        : type === 'semtex' ? FUSE_SEMTEX
          : type === 'stun' ? FUSE_STUN
            : FUSE_HE;
    p.stuckTo = null;
    p.spin.set(
      (Math.random() * 2 - 1) * 9,
      (Math.random() * 2 - 1) * 9,
      (Math.random() * 2 - 1) * 9
    );

    // nudge out of the thrower's face — but never through a wall
    const world = this.game.world;
    let nudge = 0.25;
    if (world && typeof world.raycast === 'function') {
      const block = world.raycast(p.pos, this._v1, nudge + GRENADE_RADIUS);
      if (block) {
        nudge = Math.max(block.distance - GRENADE_RADIUS - 0.02, 0);
        p.vel.multiplyScalar(-0.15); // thrown point-blank into a wall: drop it
      }
    }
    p.pos.addScaledVector(this._v1, nudge);
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.set(0, 0, 0);
  }

  _buildGrenadeAssets() {
    this._grenAssets = {
      geo: {
        hegrenade: new THREE.SphereGeometry(GRENADE_RADIUS, 12, 10),
        flashbang: new THREE.CylinderGeometry(0.045, 0.045, 0.14, 10),
        smokegrenade: new THREE.CylinderGeometry(0.055, 0.055, 0.15, 10),
        semtex: new THREE.BoxGeometry(0.09, 0.05, 0.12),
        stun: new THREE.CylinderGeometry(0.042, 0.042, 0.13, 10),
      },
      mat: {
        hegrenade: new THREE.MeshStandardMaterial({ color: 0x35452c, roughness: 0.55, metalness: 0.45 }),
        flashbang: new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.35, metalness: 0.7 }),
        smokegrenade: new THREE.MeshStandardMaterial({ color: 0x4c5a52, roughness: 0.6, metalness: 0.5 }),
        semtex: new THREE.MeshStandardMaterial({ color: 0x7a6a3a, roughness: 0.8, metalness: 0.1, emissive: 0x3a0000, emissiveIntensity: 0.4 }),
        stun: new THREE.MeshStandardMaterial({ color: 0x6b7e8c, roughness: 0.35, metalness: 0.7 }),
      },
    };
  }

  _acquireProjectile(type) {
    if (!this._grenAssets) this._buildGrenadeAssets();
    let p = null;
    for (let i = 0; i < this._projectiles.length; i++) {
      if (!this._projectiles[i].active) { p = this._projectiles[i]; break; }
    }
    if (!p) {
      p = {
        active: false,
        type: '',
        mesh: null,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        fuse: 0,
        resting: false,
        grounded: false,
        thrower: null,
        throwerTeam: 'ct',
      };
      p.mesh = new THREE.Mesh(this._grenAssets.geo.hegrenade, this._grenAssets.mat.hegrenade);
      p.mesh.castShadow = true;
      p.mesh.visible = false;
      if (this.game.scene) this.game.scene.add(p.mesh);
      this._projectiles.push(p);
    }
    const key = this._grenAssets.geo[type] ? type : 'hegrenade';
    p.mesh.geometry = this._grenAssets.geo[key];
    p.mesh.material = this._grenAssets.mat[key];
    p.mesh.visible = true;
    p.active = true;
    p.type = type;
    p.resting = false;
    p.grounded = false;
    return p;
  }

  _updateProjectiles(dt) {
    const world = this.game.world;
    const canRay = !!(world && typeof world.raycast === 'function');

    for (let i = 0; i < this._projectiles.length; i++) {
      const p = this._projectiles[i];
      if (!p.active) continue;

      p.fuse -= dt;
      if (p.type === 'smokegrenade') {
        if (p.resting || p.fuse <= 0) {
          this._popSmoke(p);
          this._release(p);
          continue;
        }
      } else if (p.fuse <= 0) {
        if (p.type === 'flashbang') this._detonateFlash(p);
        else if (p.type === 'stun') this._detonateStun(p);
        else this._detonateHE(p);
        this._release(p);
        continue;
      }

      if (p.type === 'semtex') {
        if (p.stuckTo) {
          const host = p.stuckTo;
          const at = host.pos || host.position;
          if (at && host.alive !== false) {
            // On the chest surface facing where it came from, blinking.
            p.pos.set(at.x + (p.stickDx || 0), at.y + 1.2, at.z + (p.stickDz || 0));
            p.mesh.position.copy(p.pos);
            p.blinkT = (p.blinkT || 0) + dt;
            const on = Math.floor(p.blinkT * 8) % 2 === 0;
            if (p.mesh.material && p.mesh.material.emissive) {
              p.mesh.material.emissive.setHex(on ? 0xff3020 : 0x220000);
              p.mesh.material.emissiveIntensity = on ? 2.4 : 0.4;
            }
          }
          continue;
        }
        if (!p.resting) {
          const victim = this._semtexVictim(p);
          if (victim) {
            p.stuckTo = victim;
            p.resting = true;
            const at = victim.pos || victim.position;
            const ox = p.pos.x - at.x;
            const oz = p.pos.z - at.z;
            const len = Math.hypot(ox, oz) || 1;
            p.stickDx = (ox / len) * 0.36; // body radius: sits on the surface
            p.stickDz = (oz / len) * 0.36;
            if (p.mesh && p.mesh.material && !p.mesh.material._ownSemtex) {
              p.mesh.material = p.mesh.material.clone(); // blink this one only
              p.mesh.material._ownSemtex = true;
            }
            p.vel.set(0, 0, 0);
            this.game.events.emit('grenade:stuck', { victim, thrower: p.thrower });
            continue;
          }
        }
      }

      if (p.resting) continue;

      if (!p.grounded) p.vel.y -= GRENADE_GRAVITY * dt;

      // integrate along motion with a ray to prevent tunneling. Displaced by
      // the average of the old and new velocity (exact under constant
      // gravity, as the player's jump is): moving by the new one alone made
      // a throw land ~0.9 m shorter at 30 fps than at 144.
      this._v1.copy(p.vel).multiplyScalar(dt);
      if (!p.grounded) this._v1.y += 0.5 * GRENADE_GRAVITY * dt * dt;
      const dist = this._v1.length();
      if (dist > 1e-7) {
        this._v2.copy(this._v1).multiplyScalar(1 / dist);
        let hit = null;
        if (canRay) hit = world.raycast(p.pos, this._v2, dist + GRENADE_RADIUS);
        if (hit) {
          this._nrm.copy(hit.normal);
          const move = Math.max(hit.distance - GRENADE_RADIUS - 0.005, 0);
          p.pos.addScaledVector(this._v2, move);
          if (p.type === 'semtex') {
            // sticks where it lands, walls and ceilings included
            p.vel.set(0, 0, 0);
            p.resting = true;
            p.mesh.position.copy(p.pos);
            continue;
          }

          const vn = p.vel.dot(this._nrm);
          if (vn < 0) {
            // split into tangential (× friction) + reflected normal (× restitution)
            this._v3.copy(this._nrm).multiplyScalar(vn);
            p.vel.sub(this._v3).multiplyScalar(GRENADE_FRICTION);
            p.vel.addScaledVector(this._nrm, -vn * GRENADE_RESTITUTION);
          }
          if (this._nrm.y > 0.6) {
            if (p.vel.lengthSq() < 1.0) {
              p.vel.set(0, 0, 0);
              p.resting = true;
            } else if (Math.abs(p.vel.y) < 1.3) {
              p.vel.y = 0;
              p.grounded = true; // start rolling
            }
          }
          p.spin.multiplyScalar(0.55); // bounces bleed spin
        } else {
          p.pos.add(this._v1);
          // fallback floor at y=0 if the world can't raycast (stub worlds)
          if (!canRay && p.pos.y < GRENADE_RADIUS) {
            p.pos.y = GRENADE_RADIUS;
            if (p.vel.y < 0) p.vel.y = -p.vel.y * GRENADE_RESTITUTION;
            p.vel.x *= GRENADE_FRICTION;
            p.vel.z *= GRENADE_FRICTION;
            if (p.vel.lengthSq() < 1.0) { p.vel.set(0, 0, 0); p.resting = true; }
          }
        }
      }

      // rolling: hug the floor, drag to a stop, fall off ledges
      if (p.grounded && !p.resting) {
        const drag = Math.exp(-GRENADE_ROLL_DRAG * dt); // frame-rate independent
        p.vel.x *= drag;
        p.vel.z *= drag;
        let onFloor = false;
        if (canRay) {
          this._v4.set(0, -1, 0);
          this._v5.copy(p.pos);
          this._v5.y += 0.1;
          const ground = world.raycast(this._v5, this._v4, 0.4);
          if (ground) {
            p.pos.y = ground.point.y + GRENADE_RADIUS;
            if (p.vel.y < 0) p.vel.y = 0;
            onFloor = true;
          }
        }
        if (!onFloor) p.grounded = false; // rolled off an edge
        if (p.vel.lengthSq() < 0.25) {
          p.vel.set(0, 0, 0);
          p.resting = true;
        }
      }

      if (p.pos.y < -60) { // escaped the world somehow
        this._release(p);
        continue;
      }

      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
    }
  }

  _release(p) {
    p.active = false;
    p.resting = false;
    p.grounded = false;
    p.thrower = null;
    if (p.mesh) {
      p.mesh.visible = false;
      // A stuck semtex blinked on its own material copy; drop it.
      if (p.mesh.material && p.mesh.material._ownSemtex) {
        p.mesh.material.dispose();
        p.mesh.material = this._grenAssets.mat.semtex || this._grenAssets.mat.hegrenade;
      }
    }
    p.blinkT = 0;
  }

  // =========================================================================
  // Detonations
  // =========================================================================

  _detonateHE(p) {
    const weaponId = p.type === 'semtex' ? 'semtex' : 'hegrenade';
    this.game.events.emit('fx:explosion', { pos: p.pos.clone(), radius: HE_RADIUS });
    // A semtex stuck to someone is lethal to its host.
    const host = p.type === 'semtex' ? p.stuckTo : null;
    if (host && host.alive !== false && typeof host.takeDamage === 'function') {
      const shielded = host.spawnProtection > 0;
      this._noteWound(host, p.thrower);
      host.takeDamage(250, { from: p.thrower, weapon: weaponId, headshot: false, part: 'body' });
      if (this._isPlayer(p.thrower) && !shielded) this.game.events.emit('hud:hitmarker', { headshot: false, kill: host.alive === false });
    }
    // Peak damage comes from the weapon data (150: a kill inside ~2 m); the
    // old flat 98 meant a grenade at someone's feet could never kill.
    const peak = Number(this._def(weaponId)?.damage) || HE_MAX_DMG;
    this._radialDamage(p.pos, HE_RADIUS, peak, p.thrower, p.throwerTeam, weaponId, true, false);
    this._shakePlayer(p.pos, HE_RADIUS * 1.8, 0.9);
  }

  /** First enemy body a flying semtex passes through, if any. */
  _semtexVictim(p) {
    const bodies = [];
    const pl = this.game.player;
    if (pl && pl.alive && pl.position) bodies.push(pl);
    const bots = this.game.bots && this.game.bots.all;
    if (bots) for (const b of bots) if (b && b.alive && b.pos) bodies.push(b);
    const remotes = this.game.multiplayer && this.game.multiplayer.remotePlayers;
    if (Array.isArray(remotes)) for (const r of remotes) if (r && r.alive && r.position) bodies.push(r);
    for (const body of bodies) {
      if (body === p.thrower || (!isFfa(this.game) && body.team === p.throwerTeam)) continue;
      const at = body.pos || body.position;
      const dy = p.pos.y - at.y;
      if (dy < 0 || dy > 1.9) continue;
      if (Math.hypot(p.pos.x - at.x, p.pos.z - at.z) <= SEMTEX_STICK_RADIUS) return body;
    }
    return null;
  }

  /** Stun: slows movement and aim of everyone caught in the burst. */
  _detonateStun(p) {
    const ev = this.game.events;
    ev.emit('fx:flash', { pos: p.pos.clone(), stun: true });
    const bots = this.game.bots;
    if (bots && typeof bots.applyStun === 'function') bots.applyStun(p.pos, STUN_RANGE);
    this._stunLocalPlayer(p.pos);
  }

  _detonateFlash(p) {
    const ev = this.game.events;
    ev.emit('fx:flash', { pos: p.pos.clone() });

    // bots handle their own LOS/range check
    const bots = this.game.bots;
    if (bots && typeof bots.applyFlash === 'function') bots.applyFlash(p.pos);

    this._flashLocalPlayer(p.pos);
  }

  _flashLocalPlayer(pos) {
    // Player blind = f(view angle, LOS, distance).
    const pl = this.game.player;
    const cam = this.game.camera;
    if (!pl || !pl.alive || !cam) return;

    if (typeof pl.eyePos === 'function') this._v6.copy(pl.eyePos());
    else if (pl.position) { this._v6.copy(pl.position); this._v6.y += 1.62; }
    else return;

    const d = this._v6.distanceTo(pos);
    if (d > FLASH_RANGE) return;
    if (!this._losClear(pos, this._v6)) return;

    cam.getWorldDirection(this._v7);
    this._v8.copy(pos).sub(this._v6).multiplyScalar(1 / Math.max(d, 1e-4));
    const dot = this._v7.dot(this._v8);

    // looking at it (dot >= 0.3) -> full; behind you -> weak residual
    const face = dot >= 0.3 ? 1 : Math.max(0.18, 0.18 + 0.82 * (dot + 1) / 1.3);
    const distF = d <= 7 ? 1 : Math.max(0.3, 1 - 0.7 * ((d - 7) / (FLASH_RANGE - 7)));
    const intensity = Math.min(1, face * distF);
    if (intensity < 0.04) return;

    this.game.events.emit('hud:flash', {
      intensity,
      duration: FLASH_HOLD * intensity + FLASH_FADE,
    });
  }

  _popSmoke(p) {
    this.game.events.emit('fx:smoke', { pos: p.pos.clone(), duration: SMOKE_DURATION });
    const cloud = p.pos.clone();
    cloud.y += SMOKE_LIFT; // sphere centered at torso/eye height blocks vision best
    this.smokes.push({ pos: cloud, radius: SMOKE_RADIUS, until: this._time + SMOKE_DURATION });
  }

  _onBombDetonated(e) {
    if (!e || !e.pos) return;
    this._center.set(e.pos.x, e.pos.y, e.pos.z);
    this.game.events.emit('fx:explosion', { pos: this._center.clone(), radius: BOMB_RADIUS });
    // The bomb hurts everyone, through cover — being on-site is lethal.
    this._radialDamage(this._center, BOMB_RADIUS, BOMB_MAX_DMG, null, null, 'c4', false, true);
    this._shakePlayer(this._center, 45, 1.6);
  }

  /**
   * Radial explosion damage: dmg = maxDmg × (1 − d/radius)^1.6, optional LOS
   * gate, optional teammate immunity (self-damage always applies).
   */
  _radialDamage(center, radius, maxDmg, attacker, attackerTeam, weaponId, requireLOS, hurtTeammates) {
    const g = this.game;
    const ev = g.events;
    const byPlayer = this._isPlayer(attacker);
    const ffa = isFfa(g);
    // Called-in ordnance never hits the soldier who called it.
    const sparesCaller = weaponId === 'airstrike';

    // --- player ---
    const pl = g.player;
    if (pl && pl.alive && pl.position && typeof pl.takeDamage === 'function') {
      this._v6.copy(pl.position);
      this._v6.y += 0.9; // chest center
      const d = this._v6.distanceTo(center);
      if (d <= radius) {
        const isSelf = attacker === pl;
        const friendly = !ffa && attackerTeam != null && attackerTeam === pl.team && !isSelf;
        if (!(isSelf && sparesCaller) && (hurtTeammates || !friendly)
          && (!requireLOS || this._losClear(center, this._v6))) {
          const dmg = Math.max(1, Math.round(maxDmg * Math.pow(1 - d / radius, HE_FALLOFF_EXP)));
          this._noteWound(pl, attacker);
          pl.takeDamage(dmg, { from: attacker, weapon: weaponId, headshot: false, part: 'body' });
        }
      }
    }

    // --- bots ---
    const bots = g.bots && g.bots.all;
    if (bots) {
      for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (!b || !b.alive || !b.pos || typeof b.takeDamage !== 'function') continue;
        this._v6.copy(b.pos);
        this._v6.y += (b.height != null ? b.height : 1.83) * 0.5;
        const d = this._v6.distanceTo(center);
        if (d > radius) continue;
        const friendly = !ffa && attackerTeam != null && b.team === attackerTeam && attacker !== b;
        if (friendly && !hurtTeammates) continue;
        if (requireLOS && !this._losClear(center, this._v6)) continue;
        const dmg = Math.max(1, Math.round(maxDmg * Math.pow(1 - d / radius, HE_FALLOFF_EXP)));
        // A spawn-protected bot takes nothing, so it earns no hitmarker
        // (bullets already check this in _applyDamage).
        const shielded = b.spawnProtection > 0;
        this._noteWound(b, attacker);
        b.takeDamage(dmg, { from: attacker, weapon: weaponId, headshot: false, part: 'body' });
        if (byPlayer && !shielded) ev.emit('hud:hitmarker', { headshot: false, kill: !b.alive });
      }
    }

    // --- remote human players ---
    const remotes = g.multiplayer && g.multiplayer.remotePlayers;
    if (Array.isArray(remotes)) {
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        if (!r || !r.alive || !r.position || typeof r.takeDamage !== 'function') continue;
        if (sparesCaller && r === attacker) continue;
        this._v6.copy(r.position);
        this._v6.y += (r.height != null ? r.height : 1.83) * 0.5;
        const d = this._v6.distanceTo(center);
        if (d > radius) continue;
        const friendly = !ffa && attackerTeam != null && r.team === attackerTeam && attacker !== r;
        if (friendly && !hurtTeammates) continue;
        if (requireLOS && !this._losClear(center, this._v6)) continue;
        const dmg = Math.max(1, Math.round(maxDmg * Math.pow(1 - d / radius, HE_FALLOFF_EXP)));
        this._noteWound(r, attacker);
        r.takeDamage(dmg, { from: attacker, weapon: weaponId, headshot: false, part: 'body' });
      }
    }
  }

  /** World-geometry LOS between two points (small end slack for wall-huggers). */
  _losClear(from, to) {
    const w = this.game.world;
    if (!w || typeof w.raycast !== 'function') return true;
    this._v7.copy(from);
    this._v7.y += 0.25;
    this._v8.copy(to).sub(this._v7);
    const d = this._v8.length();
    if (d < 1e-4) return true;
    this._v8.multiplyScalar(1 / d);
    const hit = w.raycast(this._v7, this._v8, Math.max(d - 0.3, 0.01));
    return !hit;
  }

  _shakePlayer(center, range, maxStrength) {
    const pl = this.game.player;
    if (!pl || typeof pl.addShake !== 'function' || !pl.position) return;
    this._v6.copy(pl.position);
    this._v6.y += 0.9;
    const d = this._v6.distanceTo(center);
    if (d < range) pl.addShake(maxStrength * (1 - d / range));
  }

  // =========================================================================
  // Kill / money / killfeed flow
  // =========================================================================

  _onBotDeath(e) {
    if (!e || !e.bot) return;
    const bot = e.bot;
    const weaponId = this._weaponIdOf(e.weapon);
    const headshot = !!e.headshot;
    const killer = e.killer != null ? e.killer : null;
    const killerIsLocal = this._isPlayer(killer);

    let killerName;
    let killerTeam;
    let reward = 0;
    if (this._isPlayer(killer)) {
      killerName = this._localPlayerName();
      killerTeam = (this.game.player && this.game.player.team) || 'ct';
      // money — combat's allowed exception on game.state
      const def = this._def(weaponId);
      reward = def.killReward != null ? def.killReward : 300;
      const econ = this.game.config && this.game.config.ECON;
      const maxMoney = econ && econ.MAX_MONEY != null ? econ.MAX_MONEY : 16000;
      this.game.state.money = Math.min(maxMoney, (this.game.state.money || 0) + reward);
      this.game.events.emit('econ:kill', { weaponId, reward });
    } else if (killer && killer.name) {
      killerName = killer.isRemotePlayer
        ? this._humanCallsign(killer.name, killer.networkId)
        : killer.name;
      killerTeam = killer.team || 't';
      if (killer.isRemotePlayer) {
        const def = this._def(weaponId);
        reward = def.killReward != null ? def.killReward : 300;
      }
    } else if (weaponId === 'c4') {
      killerName = 'C4';
      killerTeam = 't';
    } else {
      killerName = bot.name || 'World';
      killerTeam = bot.team || 't';
    }

    this.game.events.emit('kill', {
      killerName,
      victimName: bot.name || 'Bot',
      weaponId,
      headshot,
      killerTeam,
      victimTeam: bot.team || 't',
      killerId: killer && killer.networkId ? killer.networkId : (this._isPlayer(killer) ? this.game.player.networkId : null),
      victimId: null,
      killerIsLocal,
      victimIsLocal: false,
      reward,
      ...this._killCredit(bot, bot.pos, killer, bot.team || 't'),
    });
  }

  _onRemoteDeath(e) {
    if (!e || !e.player) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const victim = e.player;
    const killer = e.killer || null;
    const killerIsLocal = this._isPlayer(killer);
    const weaponId = this._weaponIdOf(e.weapon);
    let killerName = 'World';
    let killerTeam = victim.team === 'ct' ? 't' : 'ct';
    let reward = 0;
    if (this._isPlayer(killer)) {
      killerName = this._localPlayerName();
      killerTeam = this.game.player.team;
      const def = this._def(weaponId);
      reward = def.killReward != null ? def.killReward : 300;
      const maxMoney = this.game.config.ECON.MAX_MONEY;
      this.game.state.money = Math.min(maxMoney, (this.game.state.money || 0) + reward);
      this.game.events.emit('econ:kill', { weaponId, reward });
    } else if (killer && killer.name) {
      killerName = killer.isRemotePlayer
        ? this._humanCallsign(killer.name, killer.networkId)
        : killer.name;
      killerTeam = killer.team || killerTeam;
      if (killer.isRemotePlayer) {
        const def = this._def(weaponId);
        reward = def.killReward != null ? def.killReward : 300;
      }
    } else if (weaponId === 'c4') {
      killerName = 'C4';
      killerTeam = 't';
    }
    this.game.events.emit('kill', {
      killerName,
      victimName: this._humanCallsign(victim.name, victim.networkId),
      weaponId,
      headshot: !!e.headshot,
      killerTeam,
      victimTeam: victim.team,
      killerId: killer && killer.networkId ? killer.networkId : (this._isPlayer(killer) ? this.game.player.networkId : null),
      victimId: victim.networkId,
      killerIsLocal,
      victimIsLocal: false,
      reward,
      ...this._killCredit(victim, victim.position || victim.pos, killer, victim.team),
    });
  }

  _onPlayerDeath(e) {
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const ev = e || {};
    const weaponId = this._weaponIdOf(ev.weapon);
    const killer = ev.killer != null ? ev.killer : null;
    const killerIsLocal = this._isPlayer(killer);

    let killerName = 'World';
    let killerTeam = 't';
    let reward = 0;
    if (this._isPlayer(killer)) {
      killerName = this._localPlayerName();
      killerTeam = (this.game.player && this.game.player.team) || 'ct';
    } else if (killer && killer.name) {
      killerName = killer.isRemotePlayer
        ? this._humanCallsign(killer.name, killer.networkId)
        : killer.name;
      killerTeam = killer.team || 't';
      if (killer.isRemotePlayer) {
        const def = this._def(weaponId);
        reward = def.killReward != null ? def.killReward : 300;
      }
    } else if (weaponId === 'c4') {
      killerName = 'C4';
      killerTeam = 't';
    }

    this.game.events.emit('kill', {
      killerName,
      victimName: this._localPlayerName(),
      weaponId,
      headshot: !!ev.headshot,
      killerTeam,
      victimTeam: (this.game.player && this.game.player.team) || 'ct',
      killerId: killer && killer.networkId ? killer.networkId : null,
      victimId: this.game.player && this.game.player.networkId,
      killerIsLocal,
      victimIsLocal: true,
      reward,
      ...this._killCredit(this.game.player, this.game.player && this.game.player.position, killer,
        (this.game.player && this.game.player.team) || 'ct'),
    });
  }

  // =========================================================================
  // Housekeeping / helpers
  // =========================================================================

  _onRoundStart() {
    for (let i = 0; i < this._projectiles.length; i++) {
      if (this._projectiles[i].active) this._release(this._projectiles[i]);
    }
    this.smokes.length = 0;
  }

  _networkThrower(id, name) {
    const player = this.game.player;
    if (id && player?.networkId === id) return player;
    const multiplayer = this.game.multiplayer;
    if (id && multiplayer?._remoteById?.has(id)) return multiplayer._remoteById.get(id);
    const bots = this.game.bots?.all || [];
    if (name) return bots.find((bot) => bot.name === name) || null;
    return null;
  }

  /** Remember that a human (the local player or a remote one) hurt `target`. */
  _noteWound(target, shooter) {
    const key = this._humanKey(shooter);
    if (!key || !target || target === shooter || target.spawnProtection > 0) return;
    if (!this._hurtBy) this._hurtBy = new WeakMap();
    let hurt = this._hurtBy.get(target);
    if (!hurt) { hurt = new Map(); this._hurtBy.set(target, hurt); }
    hurt.set(key, this._time || 0);
  }

  _humanKey(actor) {
    if (this._isPlayer(actor)) return 'local';
    if (actor && actor.isRemotePlayer && actor.networkId) return String(actor.networkId);
    return null;
  }

  /**
   * Extra kill-event fields: how far the killer was from the victim, and the
   * humans who wounded the victim within ASSIST_WINDOW without landing the
   * kill (by network id, so every client can tell whether it assisted; the
   * relay re-aims assistIsLocal like killerIsLocal).
   */
  _killCredit(victim, victimPos, killer, victimTeam) {
    const credit = { distance: null, assistIds: [], assistIsLocal: false };
    const killerPos = this._isPlayer(killer)
      ? this.game.player && this.game.player.position
      : killer && (killer.pos || killer.position);
    if (killerPos && victimPos && Number.isFinite(killerPos.x) && Number.isFinite(victimPos.x)) {
      credit.distance = Math.round(Math.hypot(killerPos.x - victimPos.x, killerPos.y - victimPos.y, killerPos.z - victimPos.z) * 10) / 10;
    }
    const hurt = this._hurtBy ? this._hurtBy.get(victim) : null;
    if (hurt) this._hurtBy.delete(victim);
    if (!hurt || isFfa(this.game)) return credit;
    const killerKey = this._humanKey(killer);
    const localTeam = (this.game.player && this.game.player.team) || 'ct';
    for (const [key, at] of hurt) {
      if (key === killerKey || (this._time || 0) - at > ASSIST_WINDOW) continue;
      if (key === 'local') {
        if (localTeam === victimTeam) continue;
        credit.assistIsLocal = true;
        const id = this.game.player && this.game.player.networkId;
        if (id) credit.assistIds.push(String(id));
      } else {
        const remote = this._remoteById ? this._remoteById(key) : null;
        if (remote && remote.team === victimTeam) continue;
        credit.assistIds.push(key);
      }
    }
    return credit;
  }

  _remoteById(id) {
    const mp = this.game.multiplayer;
    const list = mp && mp.active && Array.isArray(mp.remotePlayers) ? mp.remotePlayers : [];
    return list.find((r) => r && String(r.networkId) === id) || null;
  }

  _isPlayer(x) {
    return !!x && (x === this.game.player || x === 'player' || x.isPlayer === true);
  }

  _localPlayerName() {
    const mp = this.game.multiplayer;
    return mp && mp.active
      ? this._humanCallsign(
          mp.localName,
          mp.localId || this.game.player?.networkId || 'local',
          this.game.profile?.name,
        )
      : 'You';
  }

  _humanCallsign(value, playerId, preferred = '') {
    const multiplayer = this.game.multiplayer;
    if (multiplayer && typeof multiplayer._humanCallsign === 'function') {
      return multiplayer._humanCallsign(value, playerId);
    }
    return resolveHumanPlayerName(value, playerId, preferred);
  }

  _weaponIdOf(w) {
    if (typeof w === 'string' && w) return w;
    if (w && typeof w.id === 'string') return w.id;
    return 'world';
  }

  _def(id) {
    const d = WEAPONS && WEAPONS[id];
    if (d) return d;
    if (id !== 'c4' && id !== 'world' && id !== 'airstrike' && !this._warned.has(id)) {
      this._warned.add(id);
      console.warn(`[combat] unknown weapon id "${id}" — using fallback stats`);
    }
    return FALLBACK_DEF;
  }
}
