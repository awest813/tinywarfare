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

/**
 * Rank at which each item unlocks (anything absent is available at rank 1).
 * Spread across the ladder: everything used to unlock by rank 8, so a first
 * match handed out up to six at once and ranks 9-30 (35-55 matches) had
 * nothing left to earn.
 */
export const UNLOCK_RANK = Object.freeze({
  shotgun: 2,
  quickhands: 3,
  counteruav: 4,
  deagle: 6,
  semtex: 8,
  flakjacket: 10,
  awp: 12,
  scavenger: 14,
  carepackage: 17,
  stun: 20,
  lmg: 24,
  hardline: 28,
});

/** Rank of the last unlock: past it the career is all titles. */
export const FINAL_UNLOCK_RANK = Math.max(...Object.values(UNLOCK_RANK));

const MAX_STORED_XP = 1e9;

/** Weapon level (from kills with it) at which each attachment unlocks. */
export const ATTACHMENT_LEVEL = Object.freeze({ none: 1, laser: 2, grip: 3, extmag: 4, suppressor: 5 });
export const WEAPON_XP_PER_KILL = 100;
export const WEAPON_LEVEL_XP = Object.freeze([0, 300, 900, 1800, 3000]); // level 1..5

export const MATCH_XP = Object.freeze({ WIN: 500, DRAW: 300, LOSS: 150, ABANDON: 0 });

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
    this._matchKills = {};   // primary kills not yet paid as weapon XP
    this._paidScore = 0;     // match score already paid as XP (a pagehide pays early)
    this._inMatch = false;   // one result per match, whatever fires game:end twice
    this._paidEarly = null;  // what a pagehide / hidden tab paid, for the end screen

    const ev = game && game.events;
    if (ev) {
      ev.on('kill', (e) => this._onKill(e));
      ev.on('game:end', (r) => this._onGameEnd(r || {}));
      const fresh = () => { this._matchKills = {}; this._paidScore = 0; this._paidEarly = null; this._inMatch = true; };
      ev.on('ui:start', fresh);
      ev.on('ui:restart', fresh);
      // Quitting mid-match keeps what was earned (score and weapon kills, no
      // result bonus) instead of losing all of it.
      ev.on('ui:menu', () => this._onAbandon(true));
      // The server career follows a progress key across devices; this save
      // does not. See syncCareer().
      ev.on('progress:updated', (d) => this.syncCareer(d && d.progression));
    }
    try {
      // Not the end of the match: a page put in the back/forward cache comes
      // back mid-match, and its game:end must still pay the rest and the result.
      globalThis.addEventListener?.('pagehide', () => this._onAbandon(false));
      // A mobile browser can discard a backgrounded tab without a pagehide:
      // hiding the page is the last reliable moment to save.
      globalThis.document?.addEventListener?.('visibilitychange', () => {
        if (globalThis.document.visibilityState === 'hidden') this._onAbandon(false);
      });
      // Another tab saved: adopt it now, so this one's menu shows the same
      // rank and its next save builds on it.
      globalThis.addEventListener?.('storage', (e) => {
        if (e && e.key !== LOCAL_PROGRESS_KEY && e.key !== null) return;
        const before = this.rank();
        if (this._mergeStored()) this.game?.events?.emit('progress:sync', { before, after: this.rank(), summary: this.summary() });
      });
    } catch { /* no window */ }
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
   * it as 'progress:local'. `earlier` is a breakdown already paid for part of
   * this match (the page was hidden mid-match): the one emitted covers both.
   */
  awardMatch({ score = 0, result = 'loss', kills = {}, earlier = null } = {}) {
    // A second tab may have saved since this one loaded: build on that, not
    // over it (each tab adds its own match to the larger total).
    this._mergeStored();
    const before = this.rank();
    const beforeLevels = {};
    for (const id of Object.keys(kills)) beforeLevels[id] = this.weaponLevel(id);

    const bonus = result === 'win' ? MATCH_XP.WIN : result === 'draw' ? MATCH_XP.DRAW
      : result === 'abandon' ? MATCH_XP.ABANDON : MATCH_XP.LOSS;
    const earned = Math.max(0, Math.round(Number(score) || 0)) + bonus;
    this.xp = Math.min(MAX_STORED_XP, this.xp + earned);
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
    let breakdown = { score: Math.round(Number(score) || 0), bonus, result, earned, before, after, unlocks, weaponUps, summary: this.summary() };
    if (earlier) {
      const ups = new Map((earlier.weaponUps || []).map((up) => [up.id, up]));
      for (const up of weaponUps) {
        const prev = ups.get(up.id);
        ups.set(up.id, prev ? { ...up, attachments: [...prev.attachments, ...up.attachments] } : up);
      }
      breakdown = {
        ...breakdown,
        score: breakdown.score + (earlier.score || 0),
        earned: earned + (earlier.earned || 0),
        before: Math.min(before, earlier.before ?? before),
        unlocks: [...(earlier.unlocks || []), ...unlocks],
        weaponUps: [...ups.values()],
      };
    }
    this.game?.events?.emit('progress:local', breakdown);
    return breakdown;
  }

  /**
   * Raise the unlock XP to at least the synced career XP.
   *
   * Unlocks live in this browser's storage, so a new device or a recovered
   * progress key started back at rank 1 with a high career beside it. Career
   * XP only comes from finished matches, which paid this track too, and the
   * server tapers and caps it, so as a floor it never grants more than was
   * earned. It only ever raises: a lower career (another key) changes nothing.
   * Returns true when the rank went up.
   */
  syncCareer(career) {
    const xp = Number(career && career.xp);
    if (!Number.isFinite(xp)) return false;
    const before = this.rank();
    const merged = this._mergeStored();
    if (xp > this.xp) {
      this.xp = Math.min(MAX_STORED_XP, Math.floor(xp));
      this._save();
    } else if (!merged) {
      return false;
    }
    const after = this.rank();
    this.game?.events?.emit('progress:sync', { before, after, summary: this.summary() });
    return after > before;
  }

  // --------------------------------------------------------------------------

  _onKill(e) {
    if (!e || !e.killerIsLocal || e.victimIsLocal) return;
    if (this.game?.state?.mode !== 'ffa' && e.killerTeam && e.victimTeam && e.killerTeam === e.victimTeam) return;
    const id = String(e.weaponId || '');
    // Weapon levels unlock attachments, which only primaries take: a knife,
    // grenade or airstrike kill must not end on "KNIFE LEVEL 2 · LASER".
    if (!PRIMARIES.includes(id)) return;
    this._matchKills[id] = (this._matchKills[id] || 0) + 1;
  }

  _onGameEnd(r) {
    if (!this._inMatch) return;
    this._inMatch = false;
    const team = (this.game.player && this.game.player.team) || 'ct';
    const result = r.draw ? 'draw' : r.winner === team ? 'win' : 'loss';
    this.awardMatch({ score: this._unpaidScore(), result, kills: this._matchKills, earlier: this._paidEarly });
    this._matchKills = {};
    this._paidEarly = null;
  }

  /**
   * Pay what the match has earned so far, without a result bonus. `ends` is
   * false for a pagehide, which may be the page going into the back/forward
   * cache rather than away for good.
   */
  _onAbandon(ends) {
    // The phase is already 'menu' when ui:menu fires, so track the match here.
    if (!this._inMatch) return;
    if (ends) this._inMatch = false;
    const score = this._unpaidScore();
    const kills = this._matchKills;
    if (!(score > 0) && !Object.keys(kills).length) return;
    const paid = this.awardMatch({ score, result: 'abandon', kills, earlier: this._paidEarly });
    this._paidEarly = ends ? null : paid;
    this._matchKills = {};
  }

  _unpaidScore() {
    const total = Math.max(0, Math.round(Number(this.game.score ? this.game.score.total : 0) || 0));
    const unpaid = Math.max(0, total - this._paidScore);
    this._paidScore = Math.max(this._paidScore, total);
    return unpaid;
  }

  _load() {
    const stored = this._readStored();
    if (!stored) return;
    this.xp = stored.xp;
    this.weaponXp = stored.weaponXp;
  }

  /** The saved progress, cleaned, or null. */
  _readStored() {
    try {
      const parsed = JSON.parse(this.storage?.getItem?.(LOCAL_PROGRESS_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return null;
      // A non-finite save (Infinity parses from 1e400) would write back null
      // and wipe the career on the next load.
      const xp = Number(parsed.xp);
      const out = { xp: Number.isFinite(xp) ? Math.max(0, Math.min(MAX_STORED_XP, Math.floor(xp))) : 0, weaponXp: {} };
      const weaponXp = parsed.weaponXp && typeof parsed.weaponXp === 'object' ? parsed.weaponXp : {};
      for (const [id, xp] of Object.entries(weaponXp)) {
        const n = Number(xp);
        if (/^[a-z0-9]{1,24}$/.test(id) && Number.isFinite(n)) out.weaponXp[id] = Math.max(0, Math.min(MAX_STORED_XP, Math.floor(n)));
      }
      return out;
    } catch {
      // Corrupt or blocked storage: start fresh.
      return null;
    }
  }

  /**
   * Take the larger of this tab's progress and the saved one. A tab left open
   * since before another tab's matches would otherwise save its older total
   * over them. Returns true when anything rose.
   */
  _mergeStored() {
    const stored = this._readStored();
    if (!stored) return false;
    let changed = false;
    if (stored.xp > this.xp) { this.xp = stored.xp; changed = true; }
    for (const [id, n] of Object.entries(stored.weaponXp)) {
      if (n > (this.weaponXp[id] || 0)) { this.weaponXp[id] = n; changed = true; }
    }
    return changed;
  }

  _save() {
    try {
      this.storage?.setItem?.(LOCAL_PROGRESS_KEY, JSON.stringify({ xp: this.xp, weaponXp: this.weaponXp }));
    } catch {
      // Private mode: progress still counts for this session.
    }
  }
}
