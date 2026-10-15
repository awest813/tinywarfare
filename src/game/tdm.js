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
// Online rooms run the same engine on the authority (the room host). It
// scores remote deaths, picks respawn points for remote players and sends
// them as 'respawn' messages; other clients only replicate its state
// (networkSnapshot / applyNetworkSnapshot) and run the respawn countdown.
// ============================================================================

import * as THREE from 'three';
import { createObjective } from './objectives.js';

export const GAME_MODES = Object.freeze({
  sd: Object.freeze({ id: 'sd', label: 'SEARCH & DESTROY', short: 'S&D', detail: 'ROUNDS · BOMB' }),
  tdm: Object.freeze({ id: 'tdm', label: 'TEAM DEATHMATCH', short: 'TDM', detail: 'RESPAWN · FIRST TO 50' }),
  kc: Object.freeze({ id: 'kc', label: 'KILL CONFIRMED', short: 'KC', detail: 'COLLECT TAGS · FIRST TO 30' }),
  dom: Object.freeze({ id: 'dom', label: 'DOMINATION', short: 'DOM', detail: 'HOLD FLAGS · FIRST TO 150' }),
  hp: Object.freeze({ id: 'hp', label: 'HARDPOINT', short: 'HP', detail: 'HOLD THE MOVING ZONE · FIRST TO 150' }),
  ffa: Object.freeze({ id: 'ffa', label: 'FREE-FOR-ALL', short: 'FFA', detail: 'NO TEAMS · FIRST TO 30' }),
});

/** Modes driven by the respawn engine in this file. */
export const RESPAWN_MODES = Object.freeze(new Set(['tdm', 'kc', 'dom', 'hp', 'ffa']));

export function isRespawnMode(mode) {
  return RESPAWN_MODES.has(mode);
}

/** Per-mode rules: score limit, points per kill, and the get-ready brief. */
export const MODE_RULES = Object.freeze({
  tdm: Object.freeze({ scoreLimit: 50, killScore: 1, brief: 'FIRST TEAM TO 50 KILLS WINS' }),
  kc: Object.freeze({ scoreLimit: 30, killScore: 0, brief: 'COLLECT ENEMY TAGS TO SCORE · DENY YOURS' }),
  dom: Object.freeze({ scoreLimit: 150, killScore: 0, brief: 'CAPTURE AND HOLD A · B · C' }),
  hp: Object.freeze({ scoreLimit: 150, killScore: 0, brief: 'HOLD THE HARDPOINT · IT MOVES EVERY MINUTE' }),
  ffa: Object.freeze({ scoreLimit: 30, killScore: 0, brief: 'NO TEAMS · FIRST SOLDIER TO 30 KILLS WINS' }),
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
 * Objective spawn pull. Respawns maximised distance from enemies (up to 45 m),
 * and in Hardpoint the enemies sit on the zone, so every respawn landed as far
 * from the objective as the map allowed and the zone stood empty half the
 * match while bots walked back.
 */
export const SPAWN_ANCHOR = Object.freeze({
  CAP: 30,    // m from the nearest enemy past which a spawn gains nothing
  PULL: 18,   // score for spawning on an anchor, fading to 0 at REACH
  REACH: 45,  // m
});

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
  // Objective anchors (the live hardpoint, held flags) pull spawns toward the
  // fight; with them, distance from enemies stops paying past ANCHOR_CAP.
  const anchors = Array.isArray(opts.anchors) ? opts.anchors : [];
  const cap = anchors.length ? SPAWN_ANCHOR.CAP : 45;

  // Pass 1, cheap: distances give each candidate its best possible score
  // (sight lines can only take points away).
  const rows = [];
  for (const candidate of candidates) {
    const pos = candidate && candidate.pos;
    if (!pos) continue;
    let nearestEnemy = Infinity;
    let nearestEnemyPos = null;
    for (const enemy of enemies) {
      const d = Math.hypot(enemy.x - pos.x, enemy.z - pos.z);
      if (d < nearestEnemy) { nearestEnemy = d; nearestEnemyPos = enemy; }
    }
    let nearestFriend = Infinity;
    for (const friend of friends) {
      nearestFriend = Math.min(nearestFriend, Math.hypot(friend.x - pos.x, friend.z - pos.z));
    }
    let bound = Math.min(nearestEnemy, cap);
    if (nearestEnemy < TDM.SAFE_DISTANCE) bound -= 100;
    if (nearestFriend < 22) bound += 8;
    if (anchors.length) {
      let nearestAnchor = Infinity;
      for (const a of anchors) nearestAnchor = Math.min(nearestAnchor, Math.hypot(a.x - pos.x, a.z - pos.z));
      bound += SPAWN_ANCHOR.PULL * Math.max(0, 1 - nearestAnchor / SPAWN_ANCHOR.REACH);
    }
    bound += random() * 6;
    rows.push({ candidate, pos, bound, nearestEnemyPos });
  }

  // Pass 2: sight-line raycasts best-first, stopping once no remaining
  // candidate could beat the best so far. Raycasting every candidate against
  // every enemy cost 20-30 ms per free-for-all spawn (a frame hitch).
  rows.sort((a, b) => b.bound - a.bound);
  let best = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    if (row.bound <= bestScore) break;
    let seen = 0;
    if (raycast) {
      const pos = row.pos;
      for (const enemy of enemies) {
        const d = Math.hypot(enemy.x - pos.x, enemy.z - pos.z);
        if (d >= 60) continue;
        _eye.set(pos.x, pos.y + 1.6, pos.z);
        _to.set(enemy.x - _eye.x, enemy.y + 1.6 - _eye.y, enemy.z - _eye.z);
        const dist = _to.length();
        if (dist > 1e-3 && !raycast(_eye, _to.multiplyScalar(1 / dist), dist)) {
          seen++;
          if (row.bound - seen * 40 <= bestScore) break; // cannot win any more
        }
      }
    }
    const score = row.bound - seen * 40;
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (!best) return null;
  // Face the nearest enemy's general direction so the action is ahead.
  const pos = best.pos;
  const yaw = best.nearestEnemyPos
    ? Math.atan2(-(best.nearestEnemyPos.x - pos.x), -(best.nearestEnemyPos.z - pos.z))
    : (best.candidate.yaw || 0);
  return { pos: pos.clone(), yaw };
}

export default class TeamDeathmatch {
  constructor(game) {
    this.game = game;
    this._playerRespawnAt = null;
    this._botRespawns = new Map(); // bot -> respawn time
    this._time = 0;
    this._candidates = null;
    this.objective = null;
    this.ffaKills = new Map();      // actor -> kills (free-for-all)
    this._remoteRespawns = new Map(); // remote human -> respawn time (authority)
    this._ffaRows = null;           // replicated FFA standings (non-authority)

    const ev = game.events;
    ev.on('bot:death', (p) => this._onBotDeath(p));
    ev.on('player:death', (p) => this._onPlayerDeath(p));
    ev.on('remote:death', (p) => this._onRemoteDeath(p));
  }

  active() {
    return isRespawnMode(this.game.state.mode);
  }

  /** True when this client simulates the match (solo, or the room host). */
  authority() {
    const mp = this.game.multiplayer;
    return !mp || !mp.active || mp.isAuthority();
  }

  _online() {
    const mp = this.game.multiplayer;
    return !!(mp && mp.active);
  }

  _remotes() {
    const mp = this.game.multiplayer;
    return mp && mp.active && Array.isArray(mp.remotePlayers) ? mp.remotePlayers : [];
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
    this._remoteRespawns.clear();
    this._candidates = null;
    if (this.objective) this.objective.stop();
    this.objective = createObjective(s.mode, game);
    this.ffaKills = new Map();
    this._ffaRows = null;

    s.round = 1;
    s.phase = 'freeze';
    s.timer = TDM.READY_TIME;
    s.canBuy = false;

    const bots = game.bots;
    if (bots && typeof bots.resetForRound === 'function') bots.resetForRound();
    if (bots && typeof bots.prepareTdm === 'function') bots.prepareTdm();
    // Free-for-all has no sides: team spawn clusters would open the match
    // with point-blank kills, so every bot starts at its own safe spawn.
    if (s.mode === 'ffa' && bots && Array.isArray(bots.all) && typeof bots.respawnTdmBot === 'function') {
      for (const bot of bots.all) bots.respawnTdmBot(bot, this._spawnFor(bot.team, bot), TDM.SPAWN_PROTECTION);
    }

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
    // Just took over a room's simulation: carry on from replicated state.
    if (this._ffaRows) this._adoptReplicaState();

    if (this._playerRespawnAt !== null && this._time >= this._playerRespawnAt) {
      this._respawnPlayer();
    }
    const bots = this.game.bots && Array.isArray(this.game.bots.all) ? this.game.bots.all : [];
    for (const bot of bots) {
      // Bots that died before this client became the authority (or that a
      // death event missed) still come back.
      if (!bot.alive && !this._botRespawns.has(bot)) this._botRespawns.set(bot, this._time + TDM.RESPAWN_DELAY);
    }
    for (const [bot, at] of this._botRespawns) {
      if (this._time < at) continue;
      this._botRespawns.delete(bot);
      if (!bot.alive) this._respawnBot(bot);
    }
    this._updateRemotes(dt);
    if (this.objective) this.objective.update(dt);

    const limit = this.rules().scoreLimit;
    if (s.scores.ct >= limit || s.scores.t >= limit || s.timer <= 0) {
      this._endMatch();
    }
  }

  /** Rebuild FFA kill counts from the last standings the old authority sent. */
  _adoptReplicaState() {
    const rows = this._ffaRows;
    this._ffaRows = null;
    const player = this.game.player;
    const byId = new Map();
    if (player) {
      const localId = player.networkId || (this.game.multiplayer && this.game.multiplayer.localId);
      if (localId) byId.set(String(localId), player);
    }
    for (const remote of this._remotes()) if (remote.networkId) byId.set(String(remote.networkId), remote);
    for (const bot of (this.game.bots && this.game.bots.all) || []) byId.set('bot:' + bot.name, bot);
    for (const row of rows) {
      const actor = row.isLocal ? player : byId.get(String(row.id));
      if (actor && row.kills > 0) this.ffaKills.set(actor, Math.max(this.ffaKills.get(actor) || 0, row.kills));
    }
  }

  /** Non-authority frame: keep the countdown and objective visuals moving. */
  replicaUpdate(dt) {
    this._time += dt;
    if (this.objective && typeof this.objective.replicaUpdate === 'function') this.objective.replicaUpdate(dt);
  }

  /** Non-authority: show the respawn countdown while the authority decides. */
  awaitRespawn() {
    this._playerRespawnAt = this._time + TDM.RESPAWN_DELAY;
  }

  /** Non-authority: the authority sent this seat back in at `spawn`. */
  respawnLocal(spawn) {
    this._playerRespawnAt = null;
    const player = this.game.player;
    if (!player) return;
    const at = spawn || this._spawnFor(player.team || 'ct', player);
    if (typeof player.resetForRound === 'function') player.resetForRound(at);
    player.armor = 0;
    if (typeof player.protect === 'function') player.protect(TDM.SPAWN_PROTECTION);
    this._equipPlayer();
    this.game.events.emit('player:respawn', { pos: at ? at.pos : null });
  }

  /** Authority: what replicas need beyond phase/scores/timer. */
  networkSnapshot() {
    const objective = this.objective && typeof this.objective.networkSnapshot === 'function'
      ? this.objective.networkSnapshot()
      : null;
    const ffa = this.game.state.mode === 'ffa'
      ? this.ffaStandings().slice(0, 24).map((row) => ({ id: row.id, name: row.name, kills: row.kills }))
      : null;
    return { objective, ffa };
  }

  /** Replica: apply the authority's objective and standings. */
  applyNetworkSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    if (this.objective && data.objective && typeof this.objective.applyNetworkSnapshot === 'function') {
      this.objective.applyNetworkSnapshot(data.objective);
    }
    if (Array.isArray(data.ffa)) {
      const localId = this.game.multiplayer && this.game.multiplayer.localId;
      this._ffaRows = data.ffa
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({
          actor: null,
          id: typeof row.id === 'string' ? row.id : null,
          name: row.id && row.id === localId ? 'You' : String(row.name || 'Soldier').slice(0, 24),
          kills: Math.max(0, Math.floor(Number(row.kills) || 0)),
          isLocal: !!row.id && row.id === localId,
        }));
      // Scores are per-viewer in FFA: own kills vs the best of everyone else.
      const s = this.game.state;
      const mine = this._ffaRows.find((row) => row.isLocal);
      s.scores.ct = mine ? mine.kills : 0;
      s.scores.t = this._ffaRows.reduce((best, row) => (row.isLocal ? best : Math.max(best, row.kills)), 0);
    }
  }

  // --------------------------------------------------------------------------

  _updateRemotes(dt) {
    const remotes = this._remotes();
    if (!remotes.length && !this._remoteRespawns.size) return;
    const mp = this.game.multiplayer;
    for (const remote of remotes) {
      if (remote.spawnProtection > 0) remote.spawnProtection = Math.max(0, remote.spawnProtection - dt);
      // Late joiners and anyone missed by a death event still get deployed.
      if (!remote.alive && !this._remoteRespawns.has(remote)) {
        this._remoteRespawns.set(remote, this._time + TDM.RESPAWN_DELAY);
      }
    }
    for (const [remote, at] of this._remoteRespawns) {
      if (!remotes.includes(remote)) { this._remoteRespawns.delete(remote); continue; }
      if (this._time < at) continue;
      this._remoteRespawns.delete(remote);
      if (remote.alive) continue;
      const spawn = this._spawnFor(remote.team || 'ct', remote);
      remote.health = 100;
      remote.armor = 0;
      remote.spectating = false;
      remote.spawnProtection = TDM.SPAWN_PROTECTION;
      if (spawn && spawn.pos) {
        remote.position.copy(spawn.pos);
        if (remote.targetPosition) remote.targetPosition.copy(spawn.pos);
        remote.yaw = spawn.yaw || 0;
        remote.targetYaw = remote.yaw;
      }
      if (mp && typeof mp._setRemoteAlive === 'function') mp._setRemoteAlive(remote, true);
      else remote.alive = true;
      if (mp && typeof mp.sendRespawn === 'function') mp.sendRespawn(remote.networkId, spawn);
      if (this.game.hud) this.game.hud._sbDirty = true;
    }
  }

  _onRemoteDeath(p) {
    if (!this.active() || this.game.state.phase !== 'live' || !this.authority()) return;
    const remote = p && p.player;
    if (!remote) return;
    this._score(remote.team);
    this._ffaCredit(p.killer, remote);
    if (this.objective) this.objective.onDeath(remote.team, remote.pos || remote.position);
    this._remoteRespawns.set(remote, this._time + TDM.RESPAWN_DELAY);
  }

  _onBotDeath(p) {
    if (!this.active() || this.game.state.phase !== 'live' || !this.authority()) return;
    const bot = p && p.bot;
    if (!bot) return;
    this._score(bot.team);
    this._ffaCredit(p.killer, bot);
    if (this.objective) {
      this.objective.onDeath(bot.team, bot.pos);
      this._retaskKiller(p.killer);
    }
    this._botRespawns.set(bot, this._time + TDM.RESPAWN_DELAY);
  }

  _onPlayerDeath(p) {
    if (!this.active() || this.game.state.phase !== 'live') return;
    if (!this.authority()) {
      this.awaitRespawn();
      return;
    }
    const player = this.game.player;
    this._score(player ? player.team : 'ct');
    this._ffaCredit(p && p.killer, player);
    if (this.objective && player) {
      this.objective.onDeath(player.team, player.position);
      this._retaskKiller(p && p.killer);
    }
    this._playerRespawnAt = this._time + TDM.RESPAWN_DELAY;
  }

  /**
   * Free-for-all: each kill scores for its killer. state.scores mirrors the
   * HUD: `ct` is the local player's kills, `t` the best of everyone else.
   */
  /** Kill Confirmed: the killing bot drops its errand to pick a fresh goal (its tag). */
  _retaskKiller(killer) {
    const pulls = this.objective && typeof this.objective.pullsKiller === 'function' && this.objective.pullsKiller();
    const bots = this.game.bots;
    if (!pulls || !killer || typeof killer !== 'object' || !bots || typeof bots.retask !== 'function') return;
    bots.retask(killer);
  }

  _ffaCredit(killer, victim) {
    if (this.game.state.mode !== 'ffa' || !killer || killer === victim) return;
    const player = this.game.player;
    const actor = killer === 'player' ? player : killer;
    if (!actor || typeof actor !== 'object') return;
    this.ffaKills.set(actor, (this.ffaKills.get(actor) || 0) + 1);
    const s = this.game.state;
    s.scores.ct = this.ffaKills.get(player) || 0;
    let lead = 0;
    for (const [who, n] of this.ffaKills) if (who !== player && n > lead) lead = n;
    s.scores.t = lead;
  }

  /** Free-for-all standings, best first: [{ actor, name, kills }]. */
  ffaStandings() {
    if (this._ffaRows && !this.authority()) {
      return [...this._ffaRows].sort((a, b) => b.kills - a.kills || (a.isLocal ? -1 : b.isLocal ? 1 : 0));
    }
    const player = this.game.player;
    const bots = (this.game.bots && this.game.bots.all) || [];
    const everyone = [player, ...this._remotes(), ...bots].filter(Boolean);
    const idOf = (actor) => (actor.networkId ? String(actor.networkId) : actor === player ? null : 'bot:' + actor.name);
    return everyone
      .map((actor) => ({
        actor,
        id: idOf(actor),
        name: actor === player ? 'You' : actor.name,
        kills: this.ffaKills.get(actor) || 0,
        isLocal: actor === player,
      }))
      .sort((a, b) => b.kills - a.kills || (a.isLocal ? -1 : b.isLocal ? 1 : 0));
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
    // Online, the room must hear the authority is alive again too.
    const mp = this.game.multiplayer;
    if (this._online() && mp.localId && typeof mp.sendRespawn === 'function') mp.sendRespawn(mp.localId, spawn);
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
    // What the player actually carries (locked picks already swapped), for
    // resupplies.
    this.equippedLoadout = loadout;
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
    // Navigation nodes are validated walkable ground across the whole map,
    // and so is the straight run between two linked nodes: edge midpoints
    // double the choice. With only the nodes, a free-for-all (nine enemies)
    // often had no spot both 16 m clear and out of sight, and a soak saw up
    // to a fifth of FFA kills land within 3 s of a respawn.
    const nodes = world && world.waypoints && world.waypoints.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) if (node && node.pos) list.push({ pos: node.pos, yaw: 0 });
      const edges = world.waypoints.edges;
      if (Array.isArray(edges)) {
        for (const edge of edges) {
          const a = nodes[edge[0]];
          const b = nodes[edge[1]];
          if (!a || !b || !a.pos || !b.pos || Math.abs(a.pos.y - b.pos.y) > 0.6) continue;
          if (a.pos.distanceTo(b.pos) < 6) continue;
          list.push({ pos: a.pos.clone().add(b.pos).multiplyScalar(0.5), yaw: 0 });
        }
      }
    }
    this._candidates = list;
    return list;
  }

  _spawnFor(team, self) {
    const enemies = [];
    const friends = [];
    const ffa = this.game.state.mode === 'ffa';
    const add = (actor, pos) => {
      if (!actor || actor === self || !actor.alive || !pos) return;
      (!ffa && actor.team === team ? friends : enemies).push(pos);
    };
    const bots = this.game.bots;
    if (bots && Array.isArray(bots.all)) for (const b of bots.all) add(b, b.pos);
    const player = this.game.player;
    if (player) add(player, player.position);
    for (const remote of this._remotes()) add(remote, remote.position);
    // Objectives pull spawns (Domination: flags this team holds; Hardpoint:
    // the live zone).
    const anchors = this.objective && typeof this.objective.spawnAnchors === 'function'
      ? this.objective.spawnAnchors(team) : [];

    const world = this.game.world;
    const raycast = world && typeof world.raycast === 'function'
      ? (origin, dir, dist) => world.raycast(origin, dir, dist)
      : null;
    const spawn = pickSafeSpawn(this._spawnCandidates(), enemies, friends, { raycast, anchors });
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
    this._remoteRespawns.clear();
    // FFA standings are built before the objective goes away.
    const payload = this.endPayload();
    if (this.objective) {
      this.objective.stop();
      this.objective = null;
    }
    this.game.events.emit('game:end', payload);
  }

  /** The game:end payload for this viewer (authority or replica). */
  endPayload() {
    const s = this.game.state;
    if (s.mode === 'ffa') {
      const standings = this.ffaStandings();
      const place = Math.max(1, standings.findIndex((row) => row.isLocal) + 1);
      const player = this.game.player;
      const team = (player && player.team) || 'ct';
      // A shared first place is a draw, not a win for whoever sorts first.
      const top = standings[0] ? standings[0].kills : 0;
      const draw = place === 1 && standings.length > 1 && standings[1].kills === top;
      return {
        winner: draw ? null : place === 1 ? team : (team === 'ct' ? 't' : 'ct'),
        draw,
        mode: s.mode,
        scores: { ct: s.scores.ct, t: s.scores.t },
        ffa: {
          place,
          total: standings.length,
          leader: standings[0] ? standings[0].name : '',
          leaderKills: standings[0] ? standings[0].kills : 0,
        },
      };
    }
    const winner = s.scores.ct > s.scores.t ? 'ct' : s.scores.t > s.scores.ct ? 't' : null;
    return {
      winner,
      draw: winner === null,
      mode: s.mode,
      scores: { ct: s.scores.ct, t: s.scores.t },
    };
  }

  /** Replica reached gameEnd: drop objective props and stop the countdown. */
  endReplica() {
    this._playerRespawnAt = null;
    const payload = this.endPayload();
    if (this.objective) {
      this.objective.stop();
      this.objective = null;
    }
    return payload;
  }
}
