// ============================================================================
// TINY WARFARE — src/game/hostility.js
//
// Who may shoot whom. Team modes: different teams are hostile. Free-for-all:
// everyone except yourself. Visual teams (uniforms, model sets) are unchanged
// in FFA; only these checks consult the mode.
// ============================================================================

export function isFfa(game) {
  return !!game && !!game.state && game.state.mode === 'ffa';
}

/** True when `a` and `b` are enemies (actors with a `.team`). */
export function hostile(game, a, b) {
  if (!a || !b || a === b) return false;
  if (isFfa(game)) return true;
  return (a.team || 'ct') !== (b.team || 'ct');
}

/** Team-only form for code that has teams but not both actors. */
export function hostileTeams(game, teamA, teamB) {
  if (isFfa(game)) return true;
  return teamA !== teamB;
}
