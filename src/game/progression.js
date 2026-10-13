// ============================================================================
// TINY WARFARE — src/game/progression.js
//
// Device-local progression for every solo mode: match XP raises a military
// rank that unlocks weapons, equipment, perks, and scorestreaks; kills with a
// weapon raise its level, which unlocks attachments for it.
//
// This is separate from the server career (leaderboard), which stays the
// ranked, cross-device record. Saved in LOCAL_PROGRESS_KEY.
//
// Locked items never block play: a class or streak pick holding something
// locked is resolved to the first unlocked alternative at spawn.
// ============================================================================

import { ATTACHMENT_IDS, LETHALS, PERK1_IDS, PERK2_IDS, PRIMARIES, SECONDARIES, TACTICALS } from './loadouts.js';

export const LOCAL_PROGRESS_KEY = 'tiny-strike-progress-v1';
export const MAX_RANK = 30;

export const RANK_TITLES = Object.freeze([
  'PRIVATE', 'PRIVATE FIRST CLASS', 'SPECIALIST', 'CORPORAL', 'SERGEANT',
  'STAFF SERGEANT', 'SERGEANT FIRST CLASS', 'MASTER SERGEANT', 'FIRST SERGEANT',
  'SERGEANT MAJOR', 'SECOND LIEUTENANT', 'FIRST LIEUTENANT', 'CAPTAIN', 'MAJOR',
  'LIEUTENANT COLONEL', 'COLONEL', 'BRIGADIER GENERAL', 'MAJOR GENERAL',
  'LIEUTENANT GENERAL', 'GENERAL',
]);

/** Rank at which each item unlocks (anything absent is available at rank 1). */
export const UNLOCK_RANK = Object.freeze({
  shotgun: 2,
  quickhands: 2,
  counteruav: 3,
  deagle: 3,
  semtex: 4,
  flakjacket: 4,
  awp: 5,
  scavenger: 5,
  carepackage: 6,
  stun: 6,
  lmg: 7,
  hardline: 8,
});

/** Weapon level (from kills with it) at which each attachment unlocks. */
export const ATTACHMENT_LEVEL = Object.freeze({ none: 1, laser: 2, grip: 3, extmag: 4, suppressor: 5 });
export const WEAPON_XP_PER_KILL = 100;
export const WEAPON_LEVEL_XP = Object.freeze([0, 300, 900, 1800, 3000]); // level 1..5

export const MATCH_XP = Object.freeze({ WIN: 500, DRAW: 300, LOSS: 150 });

/** Total XP needed to reach `rank` (rank 1 needs 0). */
export function xpForRank(rank) {
  const r = Math.max(1, Math.min(MAX_RANK, Math.floor(rank))) - 1;
  return 600 * r + 150 * r * r;
}

export function rankFromXp(xp) {
  let rank = 1;
  while (rank < MAX_RANK && xp >= xpForRank(rank + 1)) rank++;
  return rank;
}

export function rankTitle(rank) {
  return RANK_TITLES[Math.min(RANK_TITLES.length - 1, Math.floor((rank - 1) * RANK_TITLES.length / MAX_RANK))];
}

export function weaponLevelFromXp(xp) {
  let level = 1;
  while (level < WEAPON_LEVEL_XP.length && xp >= WEAPON_LEVEL_XP[level]) level++;
  return level;
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export default class Progression {
  constructor(game, storage = defaultStorage()) {
    this.game = game;
    this.storage = storage;
    this.xp = 0;
    this.weaponXp = {};
    this._load();
    this._matchKills = {};

    const ev = game && game.events;
    if (ev) {
      ev.on('kill', (e) => this._onKill(e));
      ev.on('game:end', (r) => this._onGameEnd(r || {}));
      ev.on('ui:start', () => { this._matchKills = {}; });
      ev.on('ui:restart', () => { this._matchKills = {}; });
    }
  }

  rank() {
    return rankFromXp(this.xp);
  }

  /** { rank, title, xp, floor, next, fraction } for the HUD. */
  summary() {
    const rank = this.rank();
    const floor = xpForRank(rank);
    const next = rank >= MAX_RANK ? floor : xpForRank(rank + 1);
    return {
      rank,
      title: rankTitle(rank),
      xp: this.xp,
      floor,
      next,
      fraction: next > floor ? (this.xp - floor) / (next - floor) : 1,
    };
  }

  unlockRank(id) {
    return UNLOCK_RANK[id] || 1;
  }

  isUnlocked(id) {
    return this.rank() >= this.unlockRank(id);
  }

  weaponLevel(id) {
    return weaponLevelFromXp(this.weaponXp[id] || 0);
  }

  attachmentUnlocked(weaponId, attachment) {
    return this.weaponLevel(weaponId) >= (ATTACHMENT_LEVEL[attachment] || 1);
  }

  /** A playable copy of `loadout` with every locked item swapped out. */
  resolveLoadout(loadout) {
    if (!loadout) return loadout;
    const pick = (value, list) => (this.isUnlocked(value) ? value : list.find((id) => this.isUnlocked(id)) || list[0]);
    const out = { ...loadout };
    out.primary = pick(out.primary, PRIMARIES);
    out.secondary = pick(out.secondary, SECONDARIES);
    out.lethal = pick(out.lethal, LETHALS);
    out.tactical = pick(out.tactical, TACTICALS);
    out.perk = pick(out.perk, PERK1_IDS);
    out.perk2 = pick(out.perk2, PERK2_IDS);
    if (!ATTACHMENT_IDS.includes(out.attachment) || !this.attachmentUnlocked(out.primary, out.attachment)) out.attachment = 'none';
    return out;
  }

  /** Streak picks with locked entries replaced by unlocked ones. */
  resolveStreaks(selected, allIds) {
    const out = [];
    for (const id of selected) {
      if (this.isUnlocked(id) && !out.includes(id)) out.push(id);
    }
    for (const id of allIds) {
      if (out.length >= selected.length) break;
      if (this.isUnlocked(id) && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * Apply one finished match. Returns the breakdown the HUD shows, and emits
   * it as 'progress:local'.
   */
  awardMatch({ score = 0, result = 'loss', kills = {} } = {}) {
    const before = this.rank();
    const beforeLevels = {};
    for (const id of Object.keys(kills)) beforeLevels[id] = this.weaponLevel(id);

    const bonus = result === 'win' ? MATCH_XP.WIN : result === 'draw' ? MATCH_XP.DRAW : MATCH_XP.LOSS;
    const earned = Math.max(0, Math.round(Number(score) || 0)) + bonus;
    this.xp += earned;
    for (const [id, n] of Object.entries(kills)) {
      this.weaponXp[id] = (this.weaponXp[id] || 0) + n * WEAPON_XP_PER_KILL;
    }
    this._save();

    const after = this.rank();
    const unlocks = Object.keys(UNLOCK_RANK).filter((id) => UNLOCK_RANK[id] > before && UNLOCK_RANK[id] <= after);
    const weaponUps = [];
    for (const id of Object.keys(kills)) {
      const level = this.weaponLevel(id);
      if (level <= beforeLevels[id]) continue;
      const newAttachments = Object.keys(ATTACHMENT_LEVEL)
        .filter((a) => ATTACHMENT_LEVEL[a] > beforeLevels[id] && ATTACHMENT_LEVEL[a] <= level);
      weaponUps.push({ id, level, attachments: newAttachments });
    }
    const breakdown = { score: Math.round(Number(score) || 0), bonus, result, earned, before, after, unlocks, weaponUps, summary: this.summary() };
    this.game?.events?.emit('progress:local', breakdown);
    return breakdown;
  }

  // --------------------------------------------------------------------------

  _onKill(e) {
    if (!e || !e.killerIsLocal || e.victimIsLocal) return;
    if (e.killerTeam && e.victimTeam && e.killerTeam === e.victimTeam) return;
    const id = String(e.weaponId || '');
    if (!id) return;
    this._matchKills[id] = (this._matchKills[id] || 0) + 1;
  }

  _onGameEnd(r) {
    const team = (this.game.player && this.game.player.team) || 'ct';
    const result = r.draw ? 'draw' : r.winner === team ? 'win' : 'loss';
    const score = this.game.score ? this.game.score.total : 0;
    this.awardMatch({ score, result, kills: this._matchKills });
    this._matchKills = {};
  }

  _load() {
    try {
      const parsed = JSON.parse(this.storage?.getItem?.(LOCAL_PROGRESS_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return;
      this.xp = Math.max(0, Math.floor(Number(parsed.xp) || 0));
      const weaponXp = parsed.weaponXp && typeof parsed.weaponXp === 'object' ? parsed.weaponXp : {};
      for (const [id, xp] of Object.entries(weaponXp)) {
        if (/^[a-z0-9]{1,24}$/.test(id)) this.weaponXp[id] = Math.max(0, Math.floor(Number(xp) || 0));
      }
    } catch {
      // Corrupt or blocked storage: start fresh.
    }
  }

  _save() {
    try {
      this.storage?.setItem?.(LOCAL_PROGRESS_KEY, JSON.stringify({ xp: this.xp, weaponXp: this.weaponXp }));
    } catch {
      // Private mode: progress still counts for this session.
    }
  }
}
