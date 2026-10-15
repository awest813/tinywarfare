// Shared map metadata. World builders and UI selectors should both consume
// this catalog so route IDs, display names, and theme colors never drift.
export const DEFAULT_MAP_ID = 'dustyard';

export const MAP_CATALOG = Object.freeze([
  Object.freeze({
    id: 'dustyard',
    name: 'Dustyard',
    location: 'Moroccan freight district',
    description: 'Sun-baked lanes, tight markets, and long courtyard duels.',
    tempo: 'Balanced',
    colors: ['#d6a563', '#7a4828', '#241812'],
  }),
  Object.freeze({
    id: 'frostline',
    name: 'Frostline',
    location: 'Arctic listening station',
    description: 'Snowbound chokepoints connected by a frozen service tunnel.',
    tempo: 'Long range',
    colors: ['#b9e8f2', '#397087', '#101e2b'],
    // Out of the Search & Destroy rotation: a soak had the attackers win 8-2
    // twice, the defenders dying before they could retake a planted site.
    excludedModes: Object.freeze(['sd']),
  }),
  Object.freeze({
    id: 'neon_foundry',
    name: 'Neon Foundry',
    location: 'After-hours steelworks',
    description: 'Molten machinery, vivid signage, and dangerous close angles.',
    tempo: 'Fast',
    colors: ['#fa6f45', '#6338a2', '#111023'],
  }),
  Object.freeze({
    id: 'harbor',
    name: 'Harbor',
    location: 'Storm coast container port',
    description: 'Rain-slick docks, stacked cargo, and exposed rotations.',
    tempo: 'Tactical',
    colors: ['#62a8b7', '#34525a', '#101b20'],
  }),
  Object.freeze({
    id: 'citadel',
    name: 'Citadel',
    location: 'Mountain fortress',
    description: 'Ancient ramparts meet modern cover across layered elevations.',
    tempo: 'Vertical',
    colors: ['#d0bb82', '#665f47', '#191b17'],
  }),
]);

const MAP_IDS = new Set(MAP_CATALOG.map((map) => map.id));

export function normalizeMapId(value) {
  return MAP_IDS.has(value) ? value : DEFAULT_MAP_ID;
}

export function mapById(value) {
  const id = normalizeMapId(value);
  return MAP_CATALOG.find((map) => map.id === id) || MAP_CATALOG[0];
}

/** Whether a map is in the rotation for a game mode. */
export function mapSupportsMode(mapId, mode) {
  const map = MAP_CATALOG.find((entry) => entry.id === mapId);
  return !!map && !(map.excludedModes || []).includes(mode);
}

/** The map to play `mode` on: `mapId` when it runs that mode, else the default. */
export function mapForMode(mapId, mode) {
  const id = normalizeMapId(mapId);
  if (mapSupportsMode(id, mode)) return id;
  if (mapSupportsMode(DEFAULT_MAP_ID, mode)) return DEFAULT_MAP_ID;
  const fallback = MAP_CATALOG.find((entry) => mapSupportsMode(entry.id, mode));
  return fallback ? fallback.id : DEFAULT_MAP_ID;
}
