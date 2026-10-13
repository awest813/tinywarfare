// ============================================================================
// TINY WARFARE — src/game/tdm.js
//
// Team Deathmatch: one continuous 'live' phase, every kill scores for the
// killer's side, everyone respawns a few seconds after dying, and the match
// ends at the score limit or when the clock runs out.
//
// Rounds stays the single owner of game.state; it hands the live phase to
// this module whenever state.mode === 'tdm'. Phase flow:
//   'menu' -> 'freeze' (short get-ready, no buying) -> 'live' -> 'gameEnd'
// There is no bomb, no economy, and no roundEnd phase.
//
// Solo + bots only for now: online rooms keep Search & Destroy until the
// room protocol carries a mode (see docs/ROADMAP.md, Phase 1).
// ============================================================================

import * as THREE from 'three';
import { createObjective } from './objectives.js';

export const GAME_MODES = Object.freeze({
  sd: Object.freeze({ id: 'sd', label: 'SEARCH & DESTROY', short: 'S&D', detail: 'ROUNDS · BOMB' }),
  tdm: Object.freeze({ id: 'tdm', label: 'TEAM DEATHMATCH', short: 'TDM', detail: 'RESPAWN · FIRST TO 50' }),
  kc: Object.freeze({ id: 'kc', label: 'KILL CONFIRMED', short: 'KC', detail: 'COLLECT TAGS · FIRST TO 30' }),
  dom: Object.freeze({ id: 'dom', label: 'DOMINATION', short: 'DOM', detail: 'HOLD FLAGS · FIRST TO 150' }),
});

/** Modes driven by the respawn engine in this file. */
export const RESPAWN_MODES = Object.freeze(new Set(['tdm', 'kc', 'dom']));

export function isRespawnMode(mode) {
  return RESPAWN_MODES.has(mode);
}

/** Per-mode rules: score limit, points per kill, and the get-ready brief. */
export const MODE_RULES = Object.freeze({
  tdm: Object.freeze({ scoreLimit: 50, killScore: 1, brief: 'FIRST TEAM TO 50 KILLS WINS' }),
  kc: Object.freeze({ scoreLimit: 30, killScore: 0, brief: 'COLLECT ENEMY TAGS TO SCORE · DENY YOURS' }),
  dom: Object.freeze({ scoreLimit: 150, killScore: 0, brief: 'CAPTURE AND HOLD A · B · C' }),
});

export function modeRules(mode) {
  return MODE_RULES[mode] || MODE_RULES.tdm;
}
export const DEFAULT_MODE_ID = 'sd';

export function normalizeModeId(value) {
  return Object.prototype.hasOwnProperty.call(GAME_MODES, value) ? value : DEFAULT_MODE_ID;
}

export const TDM = Object.freeze({
  SCORE_LIMIT: 50,
  TIME_LIMIT: 600,        // s
  READY_TIME: 4,          // s of 'freeze' before the first fight
  RESPAWN_DELAY: 3,       // s from death to respawn
  SAFE_DISTANCE: 16,      // m: never spawn closer than this to a living enemy
  SPAWN_PROTECTION: 1.5,  // s of damage immunity after a respawn (firing ends it)
});

// Starter class until create-a-class lands (Phase 3).
const LOADOUT = Object.freeze({
  ct: Object.freeze({ primary: 'm4a1', secondary: 'usp', lethal: 'hegrenade' }),
  t: Object.freeze({ primary: 'ak47', secondary: 'glock', lethal: 'hegrenade' }),
});

export function tdmLoadout(team) {
  return team === 't' ? LOADOUT.t : LOADOUT.ct;
}

const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();

/**
 * Score candidate spawn points: far from living enemies (hard floor at
 * SAFE_DISTANCE), out of their sight, and preferably near a teammate so the
 * team stays together. Pure function over plain data so it is testable.
 *
 * @param {Array<{pos: THREE.Vector3, yaw?: number}>} candidates
 * @param {Array<THREE.Vector3>} enemies  living enemy feet positions
 * @param {Array<THREE.Vector3>} friends  living teammate feet positions
 * @param {{ raycast?: Function, random?: () => number }} [opts]
 * @returns {{pos: THREE.Vector3, yaw: number} | null}
 */
export function pickSafeSpawn(candidates, enemies, friends, opts = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const raycast = typeof opts.raycast === 'function' ? opts.raycast : null;
  let best = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const pos = candidate && candidate.pos;
    if (!pos) continue;
    let nearestEnemy = Infinity;
    let nearestEnemyPos = null;
    let seen = 0;
    for (const enemy of enemies) {
      const d = Math.hypot(enemy.x - pos.x, enemy.z - pos.z);
      if (d < nearestEnemy) { nearestEnemy = d; nearestEnemyPos = enemy; }
      if (raycast && d < 60) {
        _eye.set(pos.x, pos.y + 1.6, pos.z);
        _to.set(enemy.x - _eye.x, enemy.y + 1.6 - _eye.y, enemy.z - _eye.z);
        const dist = _to.length();
        if (dist > 1e-3 && !raycast(_eye, _to.multiplyScalar(1 / dist), dist)) seen++;
      }
    }
    let nearestFriend = Infinity;
    for (const friend of friends) {
      nearestFriend = Math.min(nearestFriend, Math.hypot(friend.x - pos.x, friend.z - pos.z));
    }

    let score = Math.min(nearestEnemy, 45);
    if (nearestEnemy < TDM.SAFE_DISTANCE) score -= 100;
    score -= seen * 40;
    if (nearestFriend < 22) score += 8;
    score += random() * 6;
    if (score > bestScore) {
      bestScore = score;
      // Face the nearest enemy's general direction so the action is ahead.
      const yaw = nearestEnemyPos
        ? Math.atan2(-(nearestEnemyPos.x - pos.x), -(nearestEnemyPos.z - pos.z))
        : (candidate.yaw || 0);
      best = { pos: pos.clone(), yaw };
    }
  }
  return best;
}

export default class TeamDeathmatch {
  constructor(game) {
    this.game = game;
    this._playerRespawnAt = null;
    this._botRespawns = new Map(); // bot -> respawn time
    this._time = 0;
    this._candidates = null;
    this.objective = null;

    const ev = game.events;
    ev.on('bot:death', (p) => this._onBotDeath(p));
    ev.on('player:death', () => this._onPlayerDeath());
  }

  active() {
    return isRespawnMode(this.game.state.mode);
  }

  rules() {
    return modeRules(this.game.state.mode);
  }

  /** Remove any objective props (called when any match starts). */
  stopObjective() {
    if (this.objective) this.objective.stop();
    this.objective = null;
  }

  /** Seconds until the local player respawns, or null when alive/not TDM. */
  playerRespawnIn() {
    if (!this.active() || this._playerRespawnAt === null) return null;
    return Math.max(0, this._playerRespawnAt - this._time);
  }

  startMatch() {
    const game = this.game;
    const s = game.state;
    this._time = 0;
    this._playerRespawnAt = null;
    this._botRespawns.clear();
    this._candidates = null;
    if (this.objective) this.objective.stop();
    this.objective = createObjective(s.mode, game);

    s.round = 1;
    s.phase = 'freeze';
    s.timer = TDM.READY_TIME;
    s.canBuy = false;

    const bots = game.bots;
    if (bots && typeof bots.resetForRound === 'function') bots.resetForRound();
    if (bots && typeof bots.prepareTdm === 'function') bots.prepareTdm();

    const player = game.player;
    if (player) {
      const spawn = this._spawnFor(player.team || 'ct', player);
      if (typeof player.resetForRound === 'function') player.resetForRound(spawn);
      player.armor = 0;
      player.hasKit = false;
    }
    this._equipPlayer();

    game.events.emit('round:start', { round: s.round, mode: s.mode });
    game.events.emit('round:phase', { phase: 'freeze' });
  }

  goLive() {
    const s = this.game.state;
    s.phase = 'live';
    s.timer = TDM.TIME_LIMIT;
    this.game.events.emit('round:phase', { phase: 'live' });
  }

  update(dt) {
    const s = this.game.state;
    this._time += dt;
    s.timer = Math.max(0, s.timer - dt);

    if (this._playerRespawnAt !== null && this._time >= this._playerRespawnAt) {
      this._respawnPlayer();
    }
    for (const [bot, at] of this._botRespawns) {
      if (this._time < at) continue;
      this._botRespawns.delete(bot);
      if (!bot.alive) this._respawnBot(bot);
    }
    if (this.objective) this.objective.update(dt);

    const limit = this.rules().scoreLimit;
    if (s.scores.ct >= limit || s.scores.t >= limit || s.timer <= 0) {
      this._endMatch();
    }
  }

  // --------------------------------------------------------------------------

  _onBotDeath(p) {
    if (!this.active() || this.game.state.phase !== 'live') return;
    const bot = p && p.bot;
    if (!bot) return;
    this._score(bot.team);
    if (this.objective) this.objective.onDeath(bot.team, bot.pos);
    this._botRespawns.set(bot, this._time + TDM.RESPAWN_DELAY);
  }

  _onPlayerDeath() {
    if (!this.active() || this.game.state.phase !== 'live') return;
    const player = this.game.player;
    this._score(player ? player.team : 'ct');
    if (this.objective && player) this.objective.onDeath(player.team, player.position);
    this._playerRespawnAt = this._time + TDM.RESPAWN_DELAY;
  }

  /** A death scores for the side opposite the victim. */
  _score(victimTeam) {
    const points = this.rules().killScore;
    if (!points) return;
    const s = this.game.state;
    const side = victimTeam === 't' ? 'ct' : 't';
    s.scores[side] = (s.scores[side] || 0) + points;
  }

  _respawnPlayer() {
    this._playerRespawnAt = null;
    const player = this.game.player;
    if (!player) return;
    const spawn = this._spawnFor(player.team || 'ct', player);
    player.resetForRound(spawn);
    player.armor = 0;
    if (typeof player.protect === 'function') player.protect(TDM.SPAWN_PROTECTION);
    this._equipPlayer();
    this.game.events.emit('player:respawn', { pos: spawn ? spawn.pos : null });
  }

  _respawnBot(bot) {
    const bots = this.game.bots;
    if (!bots || typeof bots.respawnTdmBot !== 'function') return;
    bots.respawnTdmBot(bot, this._spawnFor(bot.team, bot), TDM.SPAWN_PROTECTION);
  }

  _equipPlayer() {
    const weapons = this.game.weapons;
    const player = this.game.player;
    if (!weapons || typeof weapons.resetForRound !== 'function') return;
    const loadouts = this.game.loadouts;
    const progression = this.game.progression;
    const chosen = loadouts && typeof loadouts.active === 'function'
      ? loadouts.active()
      : tdmLoadout(player ? player.team : 'ct');
    // Locked items swap for unlocked ones; play is never blocked.
    const loadout = progression && typeof progression.resolveLoadout === 'function' && loadouts
      ? progression.resolveLoadout(chosen)
      : chosen;
    if (player) {
      player.perk = loadout.perk || null;
      player.perk2 = loadout.perk2 || null;
      player.attachment = loadout.attachment && loadout.attachment !== 'none' ? loadout.attachment : null;
    }
    weapons.resetForRound({ died: true });
    weapons.give(loadout.secondary);
    weapons.give(loadout.lethal);
    if (loadout.tactical) weapons.give(loadout.tactical);
    weapons.give(loadout.primary);
    weapons.equip(loadout.primary);
  }

  _spawnCandidates() {
    if (this._candidates) return this._candidates;
    const world = this.game.world;
    const list = [];
    if (world && world.spawns) {
      for (const team of ['ct', 't']) {
        for (const spawn of world.spawns[team] || []) if (spawn && spawn.pos) list.push(spawn);
      }
    }
    // Navigation nodes are validated walkable ground across the whole map.
    const nodes = world && world.waypoints && world.waypoints.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) if (node && node.pos) list.push({ pos: node.pos, yaw: 0 });
    }
    this._candidates = list;
    return list;
  }

  _spawnFor(team, self) {
    const enemies = [];
    const friends = [];
    const add = (actor, pos) => {
      if (!actor || actor === self || !actor.alive || !pos) return;
      (actor.team === team ? friends : enemies).push(pos);
    };
    const bots = this.game.bots;
    if (bots && Array.isArray(bots.all)) for (const b of bots.all) add(b, b.pos);
    const player = this.game.player;
    if (player) add(player, player.position);

    const world = this.game.world;
    const raycast = world && typeof world.raycast === 'function'
      ? (origin, dir, dist) => world.raycast(origin, dir, dist)
      : null;
    const spawn = pickSafeSpawn(this._spawnCandidates(), enemies, friends, { raycast });
    if (spawn) return spawn;
    const own = world && world.spawns && world.spawns[team];
    const fallback = own && own[0];
    return fallback ? { pos: fallback.pos.clone(), yaw: fallback.yaw || 0 } : null;
  }

  _endMatch() {
    const s = this.game.state;
    if (s.phase === 'gameEnd') return;
    s.phase = 'gameEnd';
    s.timer = 0;
    s.canBuy = false;
    this._playerRespawnAt = null;
    this._botRespawns.clear();
    if (this.objective) {
      this.objective.stop();
      this.objective = null;
    }
    const winner = s.scores.ct > s.scores.t ? 'ct' : s.scores.t > s.scores.ct ? 't' : null;
    this.game.events.emit('game:end', {
      winner,
      draw: winner === null,
      mode: s.mode,
      scores: { ct: s.scores.ct, t: s.scores.t },
    });
  }
}
