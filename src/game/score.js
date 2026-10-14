// ============================================================================
// TINY WARFARE — src/game/score.js
//
// Local player's match score and kill streak. Every award emits
// 'score:award' { points, label, total, streak, group } for the HUD popups
// and for scorestreaks, which spend this score. Awards from one kill share a
// `group` so the HUD can show them as a single line.
//
// Per kill: KILL, plus HEADSHOT, multi-kills (DOUBLE KILL...), FIRST BLOOD
// (the match's first kill), PAYBACK (the enemy who last killed you), AVENGER
// (the enemy who just killed a teammate), LONGSHOT (past the weapon's range),
// and a bonus every fifth kill without dying. A wound on an enemy that a
// teammate finishes within combat's ASSIST_WINDOW pays an ASSIST.
//
// The streak counts kills since the last death; score is per match.
// ============================================================================

import { WEAPONS } from '../weapons/data.js';

export const SCORE = Object.freeze({
  KILL: 100,
  HEADSHOT: 50,
  MULTI_KILL: 50,         // per extra kill inside MULTI_WINDOW
  MULTI_WINDOW: 3,        // s between kills that chain a multi-kill
  STREAK_BONUS_EVERY: 5,  // bonus each fifth kill without dying
  STREAK_BONUS: 100,
  ASSIST: 50,
  FIRST_BLOOD: 100,
  PAYBACK: 50,
  AVENGER: 50,
  AVENGE_WINDOW: 5,       // s after a teammate's death that avenging counts
  LONGSHOT: 50,
});

/** m from the victim past which a kill is a LONGSHOT, by weapon. */
export const LONGSHOT_RANGE = Object.freeze({
  awp: 60,
  shotgun: 20,
  glock: 30,
  usp: 30,
  deagle: 35,
  mp5: 35,
  default: 45,            // rifles and the LMG
});

const MULTI_LABELS = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'FURY KILL', 'FRENZY KILL'];

/** Range for a LONGSHOT with this weapon, or Infinity (knife, grenades, streaks). */
export function longshotRange(weaponId) {
  const def = WEAPONS[weaponId];
  if (!def || def.melee || !(def.slot === 1 || def.slot === 2)) return Infinity;
  return LONGSHOT_RANGE[weaponId] ?? LONGSHOT_RANGE.default;
}

/** Stable key for an actor in kill events (network id online, else callsign). */
function actorKey(id, name) {
  if (id) return 'id:' + id;
  return name ? 'name:' + name : null;
}

export default class MatchScore {
  constructor(game) {
    this.game = game;
    this.total = 0;
    this.streak = 0;
    this._time = 0;
    this._group = 0;
    this.reset();

    const ev = game.events;
    ev.on('kill', (e) => this._onKill(e));
    ev.on('objective:score', (e) => { if (e) this.award(e.points, e.label); });
    ev.on('player:death', () => { this.streak = 0; this._chain = 0; });
    ev.on('ui:start', () => this.reset());
    ev.on('ui:restart', () => this.reset());
  }

  reset() {
    this.total = 0;
    this.streak = 0;
    this._chain = 0;
    this._lastKillAt = -Infinity;
    this._firstBlood = false;
    this._nemesis = null;          // who last killed the player
    this._avenge = new Map();      // killer key -> time they killed a teammate
  }

  update(dt) {
    this._time += dt;
  }

  /** Add points with a label (and the kill they belong to); returns the new total. */
  award(points, label, group = null) {
    const value = Math.max(0, Math.round(Number(points) || 0));
    if (!value) return this.total;
    this.total += value;
    this.game.events.emit('score:award', {
      points: value,
      label: String(label || ''),
      total: this.total,
      streak: this.streak,
      group,
    });
    return this.total;
  }

  _mode() {
    return this.game.state?.mode;
  }

  _onKill(e) {
    if (!e) return;
    const ffa = this._mode() === 'ffa';
    const teamKill = !ffa && e.killerTeam && e.victimTeam && e.killerTeam === e.victimTeam;
    const suicide = (e.killerIsLocal && e.victimIsLocal) || (e.killerName && e.killerName === e.victimName && !e.killerId);
    const killerKey = actorKey(e.killerId, e.killerName);
    const victimKey = actorKey(e.victimId, e.victimName);
    const firstBlood = !teamKill && !suicide && !this._firstBlood;
    if (firstBlood) this._firstBlood = true;

    if (e.victimIsLocal) {
      if (!e.killerIsLocal && !teamKill) this._nemesis = killerKey;
      return;
    }
    // A teammate went down: their killer is worth more for a few seconds.
    const playerTeam = (this.game.player && this.game.player.team) || 'ct';
    if (!ffa && !e.killerIsLocal && !teamKill && e.victimTeam === playerTeam && killerKey) {
      this._avenge.set(killerKey, this._time);
    }
    if (!e.killerIsLocal) {
      if (e.assistIsLocal && !teamKill && !ffa) this.award(SCORE.ASSIST, 'ASSIST', ++this._group);
      return;
    }
    if (teamKill || suicide) return;

    const group = ++this._group;
    this.streak += 1;
    this._chain = this._time - this._lastKillAt <= SCORE.MULTI_WINDOW ? this._chain + 1 : 1;
    this._lastKillAt = this._time;

    this.award(SCORE.KILL, 'KILL', group);
    if (e.headshot) this.award(SCORE.HEADSHOT, 'HEADSHOT', group);
    if (this._chain >= 2) {
      this.award(SCORE.MULTI_KILL, MULTI_LABELS[Math.min(this._chain, MULTI_LABELS.length - 1)], group);
    }
    if (firstBlood) this.award(SCORE.FIRST_BLOOD, 'FIRST BLOOD', group);
    if (victimKey && victimKey === this._nemesis) {
      this._nemesis = null;
      this.award(SCORE.PAYBACK, 'PAYBACK', group);
    }
    const avengedAt = victimKey ? this._avenge.get(victimKey) : undefined;
    if (avengedAt !== undefined) {
      this._avenge.delete(victimKey);
      if (this._time - avengedAt <= SCORE.AVENGE_WINDOW) this.award(SCORE.AVENGER, 'AVENGER', group);
    }
    if (Number.isFinite(e.distance) && e.distance >= longshotRange(e.weaponId)) {
      this.award(SCORE.LONGSHOT, 'LONGSHOT', group);
    }
    if (this.streak % SCORE.STREAK_BONUS_EVERY === 0) {
      this.award(SCORE.STREAK_BONUS, `${this.streak} KILL STREAK`, group);
    }
  }
}
