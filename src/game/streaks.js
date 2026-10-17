// ============================================================================
// TINY WARFARE — src/game/streaks.js
//
// Scorestreaks for respawn modes (solo vs bots). The player picks two of the
// streaks below; score earned since the last death charges them, each is
// earned once per life and kept until used, even across a death.
//
//   UAV                 500  every enemy shows on the radar for 30 s
//   COUNTER-UAV         600  jams the enemy UAV and scatters bot hunting, 25 s
//   CARE PACKAGE        750  a crate drops where you aim; walk over it for a
//                            random streak (bonus slot) or a full resupply
//   PRECISION AIRSTRIKE 900  three bombs walk along the line of sight,
//                            starting where the crosshair meets the ground
//
// Keys: slot one (5), slot two (6), bonus slot from a care package (7).
// The bot side calls in its own UAV after every ENEMY_UAV_KILLS team kills;
// while it is up, enemy bots home in on their nearest target.
// ============================================================================

import * as THREE from 'three';
import { isRespawnMode } from './tdm.js';
import { PERK_TUNING, hasPerk } from './loadouts.js';

export const STREAKS = Object.freeze({
  uav: Object.freeze({ id: 'uav', label: 'UAV', cost: 500, duration: 30, detail: 'Enemies on the radar for 30 s' }),
  counteruav: Object.freeze({ id: 'counteruav', label: 'COUNTER-UAV', cost: 600, duration: 25, detail: 'Jams the enemy UAV and their hunt for 25 s' }),
  carepackage: Object.freeze({ id: 'carepackage', label: 'CARE PACKAGE', cost: 750, detail: 'Supply drop: a random scorestreak or full resupply' }),
  airstrike: Object.freeze({ id: 'airstrike', label: 'PRECISION AIRSTRIKE', cost: 900, detail: 'Three bombs walk out from your aim point' }),
});
export const STREAK_IDS = Object.freeze(Object.keys(STREAKS));
export const DEFAULT_STREAKS = Object.freeze(['uav', 'airstrike']);
export const STREAK_KEYS = Object.freeze(['5', '6', '7']); // slot 1, slot 2, bonus
export const STREAK_STORAGE_KEY = 'tiny-strike-streaks-v1';

export const AIRSTRIKE = Object.freeze({
  DELAY: 2.2,        // s from call-in to the first impact
  SPACING: 6,        // m between impacts along the run
  INTERVAL: 0.28,    // s between impacts
  BOMBS: 3,
  RADIUS: 9,         // m
  DAMAGE: 400,       // lethal within ~5 m
  RANGE: 140,        // m: furthest designation
});

export const CARE_PACKAGE = Object.freeze({
  RANGE: 40,          // m: furthest drop point
  FALL_TIME: 3,       // s from call-in to touchdown
  PICKUP_RADIUS: 1.6, // m
  LIFETIME: 60,       // s on the ground before it is recovered
  REWARDS: Object.freeze(['uav', 'counteruav', 'airstrike', 'resupply']),
});

export const ENEMY_UAV_KILLS = 10;

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Two distinct known streaks, cheapest first. */
export function sanitizeStreakPicks(value) {
  const picks = Array.isArray(value) ? value.filter((id) => STREAK_IDS.includes(id)) : [];
  const unique = [...new Set(picks)].slice(0, 2);
  for (const id of DEFAULT_STREAKS) if (unique.length < 2 && !unique.includes(id)) unique.push(id);
  return unique.sort((a, b) => STREAKS[a].cost - STREAKS[b].cost);
}

export default class Scorestreaks {
  constructor(game, storage = defaultStorage()) {
    this.game = game;
    this.storage = storage;
    this.selected = this._loadPicks();
    this.reset();

    const ev = game.events;
    ev.on('score:award', (a) => this._onAward(a));
    ev.on('player:death', () => { this.points = 0; this._earnedThisLife.clear(); });
    ev.on('kill', (e) => this._onKill(e));
    ev.on('input:keydown', (p) => this._onKey(p && p.key));
    ev.on('ui:start', () => this.reset());
    ev.on('ui:restart', () => this.reset());
    // Crates and queued bombs must not outlive the match behind the menu.
    ev.on('ui:menu', () => this.reset());
  }

  reset() {
    this.points = 0;
    this.ready = new Set();
    this.bonus = null;
    this._earnedThisLife = new Set();
    this.uavTime = 0;
    this.counterTime = 0;
    this.enemyUavTime = 0;
    this._enemyTeamKills = 0;
    this._strikes = [];
    for (const pkg of this._packages || []) this._removePackage(pkg);
    this._packages = [];
    this._time = 0;
  }

  /** Choose the two streaks to run (persisted on this device). */
  selectStreaks(list) {
    this.selected = sanitizeStreakPicks(list);
    try {
      this.storage?.setItem?.(STREAK_STORAGE_KEY, JSON.stringify(this.selected));
    } catch {
      // Private mode: the choice still applies for this session.
    }
    for (const id of [...this.ready]) if (!this.selected.includes(id)) this.ready.delete(id);
    return this.selected;
  }

  /**
   * Streaks run in respawn modes, solo or online. Online, radar streaks and
   * care packages stay on the caller's client; ordnance runs on the authority.
   */
  enabled() {
    return isRespawnMode(this.game.state.mode);
  }

  _replica() {
    const mp = this.game.multiplayer;
    return !!(mp && mp.active && !mp.isAuthority());
  }

  uavActive() {
    return this.enabled() && this.uavTime > 0;
  }

  /** The player's Counter-UAV is jamming the bot side. */
  counterUavActive() {
    return this.enabled() && this.counterTime > 0;
  }

  /** True while the bot side has a UAV up (and it is not jammed). */
  enemyUavActive() {
    return this.enabled() && this.enemyUavTime > 0 && this.counterTime <= 0;
  }

  /** Cost of a streak for the local player (Hardline discounts it). */
  costOf(id) {
    const base = STREAKS[id] ? STREAKS[id].cost : Infinity;
    return Math.round(base * (hasPerk(this.game.player, 'hardline') ? PERK_TUNING.HARDLINE_COST : 1));
  }

  /** The picks in play: locked ones are swapped for unlocked streaks. */
  effectiveSelected() {
    const progression = this.game.progression;
    const picks = progression && typeof progression.resolveStreaks === 'function'
      ? progression.resolveStreaks(this.selected, STREAK_IDS)
      : this.selected;
    return [...picks].sort((x, y) => STREAKS[x].cost - STREAKS[y].cost);
  }

  /** HUD view: the two picked streaks plus any bonus from a care package. */
  status() {
    const rows = this.effectiveSelected().map((id, slot) => ({
      id,
      slot,
      key: STREAK_KEYS[slot],
      label: STREAKS[id].label,
      cost: this.costOf(id),
      progress: Math.min(1, this.points / this.costOf(id)),
      ready: this.ready.has(id),
    }));
    if (this.bonus) {
      rows.push({ id: this.bonus, slot: 2, key: STREAK_KEYS[2], label: STREAKS[this.bonus].label, cost: 0, progress: 1, ready: true, bonus: true });
    }
    return rows;
  }

  /** Activate the streak in a slot (0, 1, or 2 for the bonus). */
  activateSlot(slot) {
    if (slot === 2) return this.bonus ? this.activate(this.bonus, true) : false;
    const id = this.effectiveSelected()[slot];
    return id ? this.activate(id) : false;
  }

  /** Touch shortcut: fire the first ready streak. */
  activateFirstReady() {
    for (const row of this.status()) if (row.ready && this.activateSlot(row.slot)) return true;
    return false;
  }

  activate(id, fromBonus = false) {
    if (!this.enabled()) return false;
    if (fromBonus ? this.bonus !== id : !this.ready.has(id)) return false;
    const g = this.game;
    if (g.state.phase !== 'live' || !(g.player && g.player.alive)) return false;
    if (id === 'uav') {
      this.uavTime = STREAKS.uav.duration;
    } else if (id === 'counteruav') {
      this.counterTime = STREAKS.counteruav.duration;
    } else if (id === 'airstrike') {
      if (!this._callAirstrike()) return false;
    } else if (id === 'carepackage') {
      if (!this._callCarePackage()) return false;
    } else {
      return false;
    }
    if (fromBonus) this.bonus = null;
    else this.ready.delete(id);
    g.events.emit('streak:activate', { id, label: STREAKS[id].label });
    return true;
  }

  update(dt) {
    this._time += dt;
    if (this.uavTime > 0) this.uavTime = Math.max(0, this.uavTime - dt);
    if (this.counterTime > 0) this.counterTime = Math.max(0, this.counterTime - dt);
    if (this.enemyUavTime > 0) this.enemyUavTime = Math.max(0, this.enemyUavTime - dt);
    if (this.game.state.phase !== 'live') {
      this._strikes.length = 0;
      return;
    }
    this._updatePackages();
    if (!this._strikes.length) return;
    const due = this._strikes.filter((strike) => this._time >= strike.at);
    if (!due.length) return;
    this._strikes = this._strikes.filter((strike) => this._time < strike.at);
    for (const strike of due) this._detonate(strike.pos, strike.caller);
  }

  /** Care packages on the radar. */
  radarMarkers() {
    return this._packages.map((pkg) => ({ x: pkg.pos.x, z: pkg.pos.z, kind: 'package', landed: pkg.landed }));
  }

  // --------------------------------------------------------------------------

  _loadPicks() {
    try {
      const raw = this.storage?.getItem?.(STREAK_STORAGE_KEY);
      return sanitizeStreakPicks(raw ? JSON.parse(raw) : DEFAULT_STREAKS);
    } catch {
      return sanitizeStreakPicks(DEFAULT_STREAKS);
    }
  }

  _onAward(a) {
    if (!this.enabled() || !a) return;
    this.points += Math.max(0, Number(a.points) || 0);
    this.effectiveSelected().forEach((id, slot) => {
      if (this._earnedThisLife.has(id) || this.points < this.costOf(id)) return;
      this._earnedThisLife.add(id);
      this.ready.add(id);
      this.game.events.emit('streak:ready', { id, label: STREAKS[id].label, key: STREAK_KEYS[slot], slot });
    });
  }

  _onKill(e) {
    if (!this.enabled() || !e || this.game.state.phase !== 'live') return;
    const playerTeam = (this.game.player && this.game.player.team) || 'ct';
    if (!e.killerTeam || e.killerTeam === playerTeam || e.killerIsLocal) return;
    this._enemyTeamKills += 1;
    if (this._enemyTeamKills % ENEMY_UAV_KILLS === 0) {
      this.enemyUavTime = STREAKS.uav.duration;
      this.game.events.emit('streak:enemy', { id: 'uav', label: 'ENEMY UAV', jammed: this.counterTime > 0 });
    }
  }

  _onKey(key) {
    const slot = STREAK_KEYS.indexOf(key);
    if (slot >= 0) this.activateSlot(slot);
  }

  /** Where the crosshair meets the world within `range`, else on the floor plane. */
  _aimPoint(range) {
    const g = this.game;
    const cam = g.camera;
    const player = g.player;
    if (!cam || !player || !player.position) return null;
    cam.getWorldDirection(_dir);
    _origin.copy(player.position);
    _origin.y += player.eyeHeight || 1.6;

    let target = null;
    const world = g.world;
    if (world && typeof world.raycast === 'function') {
      const hit = world.raycast(_origin, _dir, range);
      if (hit && hit.point) target = hit.point.clone();
      else if (hit && Number.isFinite(hit.distance)) target = _origin.clone().addScaledVector(_dir, hit.distance);
    }
    if (!target && _dir.y < -0.01) {
      // Open ground is not part of the raycast solids: meet the floor plane.
      const t = -_origin.y / _dir.y;
      if (t > 0 && t <= range) target = _origin.clone().addScaledVector(_dir, t);
    }
    if (!target) target = _origin.clone().addScaledVector(_dir, Math.min(40, range));
    target.y = Math.max(0, Math.min(target.y, _origin.y));
    return target;
  }

  _callAirstrike() {
    const player = this.game.player;
    const target = this._aimPoint(AIRSTRIKE.RANGE);
    if (!target) return false;

    // The run walks away from the caller along their horizontal facing.
    const run = new THREE.Vector3(_dir.x, 0, _dir.z);
    if (run.lengthSq() < 1e-6) run.set(-Math.sin(player.yaw || 0), 0, -Math.cos(player.yaw || 0));
    run.normalize();
    if (this._replica()) {
      // The authority owns damage: it flies the run and relays the blasts.
      const mp = this.game.multiplayer;
      if (typeof mp.sendStreak === 'function') mp.sendStreak('airstrike', { target, dir: run });
      this.game.events.emit('streak:airstrike', { target: target.clone(), dir: run.clone(), _network: true });
      return true;
    }
    this._scheduleStrike(target, run, null);
    this.game.events.emit('streak:airstrike', { target: target.clone(), dir: run.clone() });
    return true;
  }

  _scheduleStrike(target, run, caller) {
    // Red signal smoke marks the run for everyone (relayed online).
    const mark = target.clone();
    mark.y = this._surfaceY(target.x, target.z);
    this.game.events.emit('fx:marker', { pos: mark, duration: AIRSTRIKE.DELAY + 2.5, color: { r: 0.85, g: 0.18, b: 0.12 } });
    for (let i = 0; i < AIRSTRIKE.BOMBS; i++) {
      this._strikes.push({
        at: this._time + AIRSTRIKE.DELAY + i * AIRSTRIKE.INTERVAL,
        pos: target.clone().addScaledVector(run, i * AIRSTRIKE.SPACING),
        caller,
      });
    }
  }

  /** Authority: run a streak a remote player called (only ordnance comes here). */
  runRemote(message, caller) {
    if (!this.enabled() || !message || !caller || !caller.alive) return false;
    if (this.game.state.phase !== 'live' || message.streakId !== 'airstrike') return false;
    const t = message.target;
    if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) return false;
    const target = new THREE.Vector3(t.x, t.y, t.z);
    // Calls land within the caller's reach, like a local call.
    if (caller.position && target.distanceTo(caller.position) > AIRSTRIKE.RANGE + 5) return false;
    const d = message.dir;
    const run = d && Number.isFinite(d.x) && Number.isFinite(d.z) ? new THREE.Vector3(d.x, 0, d.z) : new THREE.Vector3(0, 0, -1);
    if (run.lengthSq() < 1e-6) run.set(0, 0, -1);
    run.normalize();
    this._scheduleStrike(target, run, caller);
    this.game.events.emit('streak:airstrike', { target: target.clone(), dir: run.clone(), callerId: caller.networkId || null });
    return true;
  }

  _surfaceY(x, z) {
    const world = this.game.world;
    if (!world || typeof world.raycast !== 'function') return 0;
    _origin.set(x, 80, z);
    _dir.set(0, -1, 0);
    const hit = world.raycast(_origin, _dir, 100);
    return hit && hit.point ? hit.point.y : 0;
  }

  _callCarePackage() {
    const target = this._aimPoint(CARE_PACKAGE.RANGE);
    if (!target) return false;
    const ground = this._surfaceY(target.x, target.z);
    const pkg = {
      pos: new THREE.Vector3(target.x, ground, target.z),
      landAt: this._time + CARE_PACKAGE.FALL_TIME,
      expires: this._time + CARE_PACKAGE.FALL_TIME + CARE_PACKAGE.LIFETIME,
      landed: false,
      mesh: this._buildPackageMesh(),
    };
    this._packages.push(pkg);
    this.game.events.emit('streak:package-inbound', { pos: pkg.pos.clone() });
    this.game.events.emit('fx:marker', { pos: pkg.pos.clone(), duration: CARE_PACKAGE.FALL_TIME + 3, color: { r: 0.35, g: 0.8, b: 0.3 } });
    return true;
  }

  _updatePackages() {
    const player = this.game.player;
    for (const pkg of [...this._packages]) {
      const fall = Math.max(0, (pkg.landAt - this._time) / CARE_PACKAGE.FALL_TIME);
      if (pkg.mesh) {
        pkg.mesh.position.set(pkg.pos.x, pkg.pos.y + 0.45 + fall * fall * 40, pkg.pos.z);
        // Turns on the way down (time based, not per frame); settles on landing.
        if (fall > 0) pkg.mesh.rotation.y = (pkg.landAt - this._time) * 0.9;
      }
      if (!pkg.landed && this._time >= pkg.landAt) {
        pkg.landed = true;
        this.game.events.emit('fx:dust', { pos: pkg.pos.clone() });
        this.game.events.emit('streak:package-landed', { pos: pkg.pos.clone() });
      }
      if (this._time >= pkg.expires) {
        this._removePackage(pkg);
        continue;
      }
      if (!pkg.landed || !player || !player.alive || !player.position) continue;
      const near = Math.hypot(player.position.x - pkg.pos.x, player.position.z - pkg.pos.z) <= CARE_PACKAGE.PICKUP_RADIUS &&
        Math.abs(player.position.y - pkg.pos.y) < 2.5;
      if (near) this._collect(pkg);
    }
  }

  _collect(pkg) {
    this._removePackage(pkg);
    const pool = CARE_PACKAGE.REWARDS.filter((id) => id === 'resupply' || !this.bonus);
    const reward = pool[Math.floor(Math.random() * pool.length)];
    if (reward === 'resupply') this._resupply();
    else this.bonus = reward;
    this.game.events.emit('streak:package', {
      reward,
      label: reward === 'resupply' ? 'FULL RESUPPLY' : STREAKS[reward].label,
      key: STREAK_KEYS[2],
    });
  }

  _resupply() {
    const weapons = this.game.weapons;
    const loadouts = this.game.loadouts;
    const equipped = this.game.rounds && this.game.rounds.tdm && this.game.rounds.tdm.equippedLoadout;
    if (weapons && typeof weapons.resupply === 'function') {
      weapons.resupply(equipped || (loadouts && typeof loadouts.active === 'function' ? loadouts.active() : null));
    }
  }

  _removePackage(pkg) {
    if (pkg.mesh && pkg.mesh.parent) pkg.mesh.parent.remove(pkg.mesh);
    if (this._packages) this._packages = this._packages.filter((p) => p !== pkg);
  }

  _buildPackageMesh() {
    const scene = this.game.scene;
    if (!scene) return null;
    if (!this._pkgGeo) {
      this._pkgGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
      this._pkgMat = new THREE.MeshStandardMaterial({
        color: 0x4a5a33, roughness: 0.75, metalness: 0.2, emissive: 0x2a3a10, emissiveIntensity: 0.35,
      });
    }
    const mesh = new THREE.Mesh(this._pkgGeo, this._pkgMat);
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  _detonate(pos, caller = null) {
    const g = this.game;
    const center = pos.clone();
    // Ordnance falls from above: land on the first surface under this point
    // (a roof, a crate, else the ground plane).
    const world = g.world;
    if (world && typeof world.raycast === 'function') {
      center.y = this._surfaceY(pos.x, pos.z);
    }
    center.y += 0.6;
    // Bigger fireball than a frag of the same damage radius.
    g.events.emit('fx:explosion', { pos: center.clone(), radius: AIRSTRIKE.RADIUS, scale: 1.5 });
    const combat = g.combat;
    const attacker = caller || g.player || null;
    if (combat && typeof combat._radialDamage === 'function') {
      combat._radialDamage(center, AIRSTRIKE.RADIUS, AIRSTRIKE.DAMAGE, attacker,
        attacker ? attacker.team : null, 'airstrike', true, false);
    }
    if (combat && typeof combat._shakePlayer === 'function') combat._shakePlayer(center, 40, 1.4);
  }
}
