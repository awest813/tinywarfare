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

/** Small inline flag insignia (decorative; aria-hidden at the use site). */
export const FLAG_SVG = Object.freeze({
  ct: '<svg viewBox="0 0 19 10" width="17" height="9" aria-hidden="true">' +
    '<rect width="19" height="10" fill="#b22234"/>' +
    '<rect y="1.54" width="19" height="0.77" fill="#fff"/><rect y="3.08" width="19" height="0.77" fill="#fff"/>' +
    '<rect y="4.62" width="19" height="0.77" fill="#fff"/><rect y="6.15" width="19" height="0.77" fill="#fff"/>' +
    '<rect y="7.69" width="19" height="0.77" fill="#fff"/><rect width="7.6" height="5.4" fill="#3c3b6e"/></svg>',
  t: '<svg viewBox="0 0 15 10" width="15" height="10" aria-hidden="true">' +
    '<rect width="15" height="3.34" fill="#fff"/><rect y="3.33" width="15" height="3.34" fill="#0039a6"/>' +
    '<rect y="6.66" width="15" height="3.34" fill="#d52b1e"/></svg>',
});

/** Faction record for a team id; anything other than 't' is the defenders. */
export function faction(team) {
  return team === 't' ? FACTIONS.t : FACTIONS.ct;
}

/** "US 3 : 5 RU" style score line. */
export function scoreLine(ct, t, gap = ' : ') {
  return `${FACTIONS.ct.short} ${ct | 0}${gap}${t | 0} ${FACTIONS.t.short}`;
}
