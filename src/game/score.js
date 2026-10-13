// ============================================================================
// TINY WARFARE — src/game/score.js
//
// Local player's match score and kill streak. Every award emits
// 'score:award' { points, label, total, streak } for the HUD popups and for
// scorestreaks, which spend this score.
//
// The streak counts kills since the last death; score is per match.
// ============================================================================

export const SCORE = Object.freeze({
  KILL: 100,
  HEADSHOT: 50,
  MULTI_KILL: 50,         // per extra kill inside MULTI_WINDOW
  MULTI_WINDOW: 3,        // s between kills that chain a multi-kill
  STREAK_BONUS_EVERY: 5,  // bonus each fifth kill without dying
  STREAK_BONUS: 100,
});

const MULTI_LABELS = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'FURY KILL', 'FRENZY KILL'];

export default class MatchScore {
  constructor(game) {
    this.game = game;
    this.total = 0;
    this.streak = 0;
    this._time = 0;
    this._lastKillAt = -Infinity;
    this._chain = 0;

    const ev = game.events;
    ev.on('kill', (e) => this._onKill(e));
    ev.on('player:death', () => { this.streak = 0; this._chain = 0; });
    ev.on('ui:start', () => this.reset());
    ev.on('ui:restart', () => this.reset());
  }

  reset() {
    this.total = 0;
    this.streak = 0;
    this._chain = 0;
    this._lastKillAt = -Infinity;
  }

  update(dt) {
    this._time += dt;
  }

  /** Add points with a label; returns the new total. */
  award(points, label) {
    const value = Math.max(0, Math.round(Number(points) || 0));
    if (!value) return this.total;
    this.total += value;
    this.game.events.emit('score:award', {
      points: value,
      label: String(label || ''),
      total: this.total,
      streak: this.streak,
    });
    return this.total;
  }

  _onKill(e) {
    if (!e || !e.killerIsLocal || e.victimIsLocal) return;
    if (e.killerTeam && e.victimTeam && e.killerTeam === e.victimTeam) return;
    this.streak += 1;
    this._chain = this._time - this._lastKillAt <= SCORE.MULTI_WINDOW ? this._chain + 1 : 1;
    this._lastKillAt = this._time;

    this.award(SCORE.KILL, 'KILL');
    if (e.headshot) this.award(SCORE.HEADSHOT, 'HEADSHOT');
    if (this._chain >= 2) {
      this.award(SCORE.MULTI_KILL, MULTI_LABELS[Math.min(this._chain, MULTI_LABELS.length - 1)]);
    }
    if (this.streak % SCORE.STREAK_BONUS_EVERY === 0) {
      this.award(SCORE.STREAK_BONUS, `${this.streak} KILL STREAK`);
    }
  }
}
