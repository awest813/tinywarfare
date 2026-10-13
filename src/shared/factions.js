// ---------------------------------------------------------------------------
// Factions — display identity for the two sides.
//
// Gameplay, network, storage, and leaderboard code keep the stable team ids
// 'ct' (defenders: defuse/retake) and 't' (attackers: plant). Everything a
// player reads goes through this table, so the setting can change without
// breaking saved data or the room protocol.
// ---------------------------------------------------------------------------

export const FACTIONS = Object.freeze({
  ct: Object.freeze({
    id: 'ct',
    short: 'US',
    name: 'U.S. FORCES',
    member: 'U.S. SOLDIER',
  }),
  t: Object.freeze({
    id: 't',
    short: 'RU',
    name: 'RUSSIAN FORCES',
    member: 'RUSSIAN SOLDIER',
  }),
});

/** Faction record for a team id; anything other than 't' is the defenders. */
export function faction(team) {
  return team === 't' ? FACTIONS.t : FACTIONS.ct;
}

/** "US 3 : 5 RU" style score line. */
export function scoreLine(ct, t, gap = ' : ') {
  return `${FACTIONS.ct.short} ${ct | 0}${gap}${t | 0} ${FACTIONS.t.short}`;
}
