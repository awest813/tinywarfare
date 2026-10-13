// ============================================================================
// TINY WARFARE — src/game/streaks.js
//
// Scorestreaks for respawn modes (solo vs bots). Score earned since the last
// death charges the streaks; each one is earned once per life and kept until
// used, even across a death. Activate with the streak keys (5 / 6).
//
//   UAV                 500  every enemy shows on the radar for 30 s
//   PRECISION AIRSTRIKE 900  three bombs walk along the line of sight,
//                            starting where the crosshair meets the ground
//
// The bot side calls in its own UAV after every ENEMY_UAV_KILLS team kills;
// while it is up, enemy bots home in on their nearest target.
// ============================================================================

import * as THREE from 'three';
import { isRespawnMode } from './tdm.js';
import { PERK_TUNING, hasPerk } from './loadouts.js';

export const STREAKS = Object.freeze({
  uav: Object.freeze({ id: 'uav', key: '5', label: 'UAV', cost: 500, duration: 30 }),
  airstrike: Object.freeze({ id: 'airstrike', key: '6', label: 'PRECISION AIRSTRIKE', cost: 900 }),
});
export const STREAK_ORDER = Object.freeze(['uav', 'airstrike']);

export const AIRSTRIKE = Object.freeze({
  DELAY: 2.2,        // s from call-in to the first impact
  SPACING: 6,        // m between impacts along the run
  INTERVAL: 0.28,    // s between impacts
  BOMBS: 3,
  RADIUS: 9,         // m
  DAMAGE: 400,       // lethal within ~5 m
  RANGE: 140,        // m: furthest designation
});

export const ENEMY_UAV_KILLS = 10;

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

export default class Scorestreaks {
  constructor(game) {
    this.game = game;
    this.reset();

    const ev = game.events;
    ev.on('score:award', (a) => this._onAward(a));
    ev.on('player:death', () => { this.points = 0; this._earnedThisLife.clear(); });
    ev.on('kill', (e) => this._onKill(e));
    ev.on('input:keydown', (p) => this._onKey(p && p.key));
    ev.on('ui:start', () => this.reset());
    ev.on('ui:restart', () => this.reset());
  }

  reset() {
    this.points = 0;
    this.ready = new Set();
    this._earnedThisLife = new Set();
    this.uavTime = 0;
    this.enemyUavTime = 0;
    this._enemyTeamKills = 0;
    this._strikes = [];
    this._time = 0;
  }

  /** Streaks only run in solo respawn modes. */
  enabled() {
    const g = this.game;
    return isRespawnMode(g.state.mode) && !(g.multiplayer && g.multiplayer.active);
  }

  uavActive() {
    return this.enabled() && this.uavTime > 0;
  }

  /** True while the bot team opposing `team` has a UAV up over it. */
  enemyUavActive() {
    return this.enabled() && this.enemyUavTime > 0;
  }

  /** Cost of a streak for the local player (Hardline discounts it). */
  costOf(id) {
    const base = STREAKS[id] ? STREAKS[id].cost : Infinity;
    return Math.round(base * (hasPerk(this.game.player, 'hardline') ? PERK_TUNING.HARDLINE_COST : 1));
  }

  /** HUD view: each streak with progress (0..1) and ready flag. */
  status() {
    return STREAK_ORDER.map((id) => {
      const s = STREAKS[id];
      return {
        id,
        key: s.key,
        label: s.label,
        cost: this.costOf(id),
        progress: Math.min(1, this.points / this.costOf(id)),
        ready: this.ready.has(id),
      };
    });
  }

  activate(id) {
    if (!this.enabled() || !this.ready.has(id)) return false;
    const g = this.game;
    if (g.state.phase !== 'live' || !(g.player && g.player.alive)) return false;
    if (id === 'uav') {
      this.uavTime = STREAKS.uav.duration;
    } else if (id === 'airstrike') {
      if (!this._callAirstrike()) return false;
    } else {
      return false;
    }
    this.ready.delete(id);
    g.events.emit('streak:activate', { id, label: STREAKS[id].label });
    return true;
  }

  update(dt) {
    this._time += dt;
    if (this.uavTime > 0) this.uavTime = Math.max(0, this.uavTime - dt);
    if (this.enemyUavTime > 0) this.enemyUavTime = Math.max(0, this.enemyUavTime - dt);
    if (this.game.state.phase !== 'live') {
      this._strikes.length = 0;
      return;
    }
    if (!this._strikes.length) return;
    const due = this._strikes.filter((strike) => this._time >= strike.at);
    if (!due.length) return;
    this._strikes = this._strikes.filter((strike) => this._time < strike.at);
    for (const strike of due) this._detonate(strike.pos);
  }

  // --------------------------------------------------------------------------

  _onAward(a) {
    if (!this.enabled() || !a) return;
    this.points += Math.max(0, Number(a.points) || 0);
    for (const id of STREAK_ORDER) {
      if (this._earnedThisLife.has(id) || this.points < this.costOf(id)) continue;
      this._earnedThisLife.add(id);
      this.ready.add(id);
      this.game.events.emit('streak:ready', { id, label: STREAKS[id].label, key: STREAKS[id].key });
    }
  }

  _onKill(e) {
    if (!this.enabled() || !e || this.game.state.phase !== 'live') return;
    const playerTeam = (this.game.player && this.game.player.team) || 'ct';
    if (!e.killerTeam || e.killerTeam === playerTeam || e.killerIsLocal) return;
    this._enemyTeamKills += 1;
    if (this._enemyTeamKills % ENEMY_UAV_KILLS === 0) {
      this.enemyUavTime = STREAKS.uav.duration;
      this.game.events.emit('streak:enemy', { id: 'uav', label: 'ENEMY UAV' });
    }
  }

  _onKey(key) {
    for (const id of STREAK_ORDER) {
      if (STREAKS[id].key === key) this.activate(id);
    }
  }

  _callAirstrike() {
    const g = this.game;
    const cam = g.camera;
    const player = g.player;
    if (!cam || !player || !player.position) return false;
    cam.getWorldDirection(_dir);
    _origin.copy(player.position);
    _origin.y += player.eyeHeight || 1.6;

    // Where the crosshair meets the world, else straight ahead at range.
    let target = null;
    const world = g.world;
    if (world && typeof world.raycast === 'function') {
      const hit = world.raycast(_origin, _dir, AIRSTRIKE.RANGE);
      if (hit && hit.point) target = hit.point.clone();
      else if (hit && Number.isFinite(hit.distance)) target = _origin.clone().addScaledVector(_dir, hit.distance);
    }
    if (!target && _dir.y < -0.01) {
      // Open ground is not part of the raycast solids: meet the floor plane.
      const t = -_origin.y / _dir.y;
      if (t > 0 && t <= AIRSTRIKE.RANGE) target = _origin.clone().addScaledVector(_dir, t);
    }
    if (!target) target = _origin.clone().addScaledVector(_dir, 40);
    target.y = Math.max(0, Math.min(target.y, _origin.y));

    // The run walks away from the caller along their horizontal facing.
    const run = new THREE.Vector3(_dir.x, 0, _dir.z);
    if (run.lengthSq() < 1e-6) run.set(-Math.sin(player.yaw || 0), 0, -Math.cos(player.yaw || 0));
    run.normalize();
    for (let i = 0; i < AIRSTRIKE.BOMBS; i++) {
      this._strikes.push({
        at: this._time + AIRSTRIKE.DELAY + i * AIRSTRIKE.INTERVAL,
        pos: target.clone().addScaledVector(run, i * AIRSTRIKE.SPACING),
      });
    }
    g.events.emit('streak:airstrike', { target: target.clone(), dir: run.clone() });
    return true;
  }

  _detonate(pos) {
    const g = this.game;
    const center = pos.clone();
    // Ordnance falls from above: land on the first surface under this point
    // (a roof, a crate, else the ground plane).
    const world = g.world;
    if (world && typeof world.raycast === 'function') {
      _origin.set(pos.x, 80, pos.z);
      _dir.set(0, -1, 0);
      const hit = world.raycast(_origin, _dir, 100);
      center.y = hit && hit.point ? hit.point.y : 0;
    }
    center.y += 0.6;
    g.events.emit('fx:explosion', { pos: center.clone(), radius: AIRSTRIKE.RADIUS });
    const combat = g.combat;
    const player = g.player;
    if (combat && typeof combat._radialDamage === 'function') {
      combat._radialDamage(center, AIRSTRIKE.RADIUS, AIRSTRIKE.DAMAGE, player || null,
        player ? player.team : null, 'airstrike', true, false);
    }
    if (combat && typeof combat._shakePlayer === 'function') combat._shakePlayer(center, 40, 1.4);
  }
}
