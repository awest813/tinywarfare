// ============================================================================
// TINY WARFARE — when a held gun drops to its silhouette.
//
// A third-person rifle is about 30k triangles and is drawn again into the
// shadow map. Past 15 m it covers a few dozen pixels, so the soldier carries
// the box silhouette instead. Coming back inside 12 m restores the real gun,
// and the gap between the two stops it flickering on the line.
// ============================================================================

export const WEAPON_LOD_OUT = 15;
export const WEAPON_LOD_IN = 12;
export const WEAPON_LOD_OUT_SQ = WEAPON_LOD_OUT * WEAPON_LOD_OUT;
export const WEAPON_LOD_IN_SQ = WEAPON_LOD_IN * WEAPON_LOD_IN;

/**
 * 'near' keeps the detailed gun, 'far' the silhouette.
 * Without a proxy there is nothing to swap to.
 * @param {'near' | 'far' | undefined} previous
 * @param {number} dist2  camera-to-soldier distance, squared
 * @param {boolean} hasProxy
 */
export function weaponLodMode(previous, dist2, hasProxy) {
  if (!hasProxy) return 'near';
  const prev = previous === 'far' ? 'far' : 'near';
  if (prev === 'near' && dist2 > WEAPON_LOD_OUT_SQ) return 'far';
  if (prev === 'far' && dist2 < WEAPON_LOD_IN_SQ) return 'near';
  return prev;
}
