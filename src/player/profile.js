const PROFILE_KEY = 'tiny-strike-player-profile-v1';
const NAME_KEY = 'tiny-strike-player-name';
const LEGACY_NAME_KEY = 'goldeneye-name';
const DEFAULT_NAME = 'Operative';
const DEFAULT_CHARACTER_ID = 'vanguard';

const CALLSIGN_PREFIXES = Object.freeze([
  'Arctic', 'Black', 'Blue', 'Brave', 'Crimson', 'Echo', 'Ember', 'Frost',
  'Ghost', 'Iron', 'Jade', 'Night', 'Onyx', 'Rogue', 'Silent', 'Steel',
]);
const CALLSIGN_NOUNS = Object.freeze([
  'Cobra', 'Falcon', 'Fox', 'Hawk', 'Jackal', 'Lynx', 'Mantis', 'Raven',
  'Saber', 'Scout', 'Shade', 'Viper', 'Wolf', 'Wraith', 'Zenith', 'Zero',
]);

const character = (definition) => Object.freeze({
  ...definition,
  teams: Object.freeze({
    ct: Object.freeze({ ...definition.teams.ct }),
    t: Object.freeze({ ...definition.teams.t }),
  }),
});

// These are intentionally fixed, game-owned palettes. Multiplayer traffic only
// carries a character ID, never client-provided material values.
export const PLAYER_CHARACTERS = Object.freeze([
  character({
    id: 'vanguard',
    label: 'Vanguard',
    description: 'Classic tactical kit',
    swatch: '#5279a5',
    skin: '#c98f6d',
    headgear: 'helmet',
    teams: {
      // U.S. coyote brown vs Russian EMR green: the faction read. Enemy
      // identification itself comes from the red crosshair and blue tags.
      ct: { uniform: '#8a7652', dark: '#3f3524', sleeve: '#6d5d40' },
      t: { uniform: '#4d5a3a', dark: '#252c1b', sleeve: '#3a452c' },
    },
  }),
  character({
    id: 'ranger',
    label: 'Ranger',
    description: 'Field green recon gear',
    swatch: '#74895c',
    skin: '#a96848',
    headgear: 'cap',
    teams: {
      ct: { uniform: '#7d7655', dark: '#38351f', sleeve: '#625c40' },
      t: { uniform: '#556347', dark: '#2a3122', sleeve: '#414c36' },
    },
  }),
  character({
    id: 'breacher',
    label: 'Breacher',
    description: 'Heavy sandstorm armor',
    swatch: '#b18457',
    skin: '#78452f',
    headgear: 'wrap',
    teams: {
      ct: { uniform: '#9a8661', dark: '#4a3d2a', sleeve: '#7b6b4c' },
      t: { uniform: '#5f6a50', dark: '#2f3527', sleeve: '#4a533e' },
    },
  }),
  character({
    id: 'shadow',
    label: 'Shadow',
    description: 'Low-profile covert kit',
    swatch: '#594f69',
    skin: '#d3a17f',
    headgear: 'balaclava',
    teams: {
      ct: { uniform: '#5c5444', dark: '#26221a', sleeve: '#463f32' },
      t: { uniform: '#3f4636', dark: '#1d2119', sleeve: '#30362a' },
    },
  }),
]);

const CHARACTER_BY_ID = new Map(PLAYER_CHARACTERS.map((entry) => [entry.id, entry]));

function canStore(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
}

export function normalizePlayerName(value) {
  const cleaned = String(value || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return cleaned || DEFAULT_NAME;
}

function secureRandom() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      const value = new Uint32Array(1);
      globalThis.crypto.getRandomValues(value);
      return value[0] / 0x100000000;
    }
  } catch {
    // Fall through to Math.random in privacy-restricted browser contexts.
  }
  return Math.random();
}

function randomIndex(length, random) {
  let value;
  try { value = Number(random()); } catch { value = secureRandom(); }
  if (!Number.isFinite(value)) value = secureRandom();
  value = Math.max(0, Math.min(0.999999999999, value));
  return Math.floor(value * length);
}

export function generateRandomPlayerName(random = secureRandom) {
  const prefix = CALLSIGN_PREFIXES[randomIndex(CALLSIGN_PREFIXES.length, random)];
  const noun = CALLSIGN_NOUNS[randomIndex(CALLSIGN_NOUNS.length, random)];
  const tag = 100 + randomIndex(900, random);
  return `${prefix}${noun}-${tag}`;
}

/**
 * Legacy clients and servers used these names when a human identity had not
 * arrived yet. The optional numeric suffix was added by some dedupe paths.
 * Keep this separate from normalizePlayerName(): "Operative" is still a
 * valid explicit profile choice, while network/display fallbacks must never
 * mistake a placeholder echo for a real callsign.
 */
export function isPlaceholderName(value) {
  return /^operative\s*\d*$/i.test(String(value || '').trim());
}

function seededRandom(value) {
  const text = String(value || '');
  let state = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    state ^= text.charCodeAt(i);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state += 0x6d2b79f5;
    let number = state;
    number = Math.imul(number ^ (number >>> 15), number | 1);
    number ^= number + Math.imul(number ^ (number >>> 7), number | 61);
    return ((number ^ (number >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Resolve a human name received from gameplay/network state. Missing legacy
 * placeholders get a callsign derived from the stable player ID, so every
 * client and every HUD surface chooses the same replacement.
 */
export function resolveHumanPlayerName(value, playerId, preferred = '') {
  const name = normalizePlayerName(value);
  if (!isPlaceholderName(name)) return name;
  const preferredName = normalizePlayerName(preferred);
  if (!isPlaceholderName(preferredName)) return preferredName;
  const identity = String(playerId || '').trim();
  return generateRandomPlayerName(identity ? seededRandom(identity) : secureRandom);
}

export function normalizeCharacterId(value) {
  const id = String(value || '').trim().toLowerCase();
  return CHARACTER_BY_ID.has(id) ? id : DEFAULT_CHARACTER_ID;
}

export function getCharacterPreset(value) {
  return CHARACTER_BY_ID.get(normalizeCharacterId(value));
}

export function getCharacterPalette(value, team = 'ct') {
  const preset = getCharacterPreset(value);
  return Object.freeze({
    id: preset.id,
    skin: preset.skin,
    headgear: preset.headgear,
    ...(preset.teams[team === 't' ? 't' : 'ct']),
  });
}

export class PlayerProfile {
  constructor(game = null, options = {}) {
    this.game = game;
    if (options.storage !== undefined) {
      this.storage = options.storage;
    } else {
      try { this.storage = globalThis.localStorage; } catch { this.storage = null; }
    }
    this.random = typeof options.random === 'function' ? options.random : secureRandom;
    this.characters = PLAYER_CHARACTERS;
    this.presets = PLAYER_CHARACTERS;

    const stored = this._read();
    this.name = stored.name;
    this.characterId = stored.characterId;
    this._nameCustomized = stored.nameCustomized;
    this._persist();
  }

  get callsign() { return this.name; }
  get appearanceId() { return this.characterId; }

  get() {
    return Object.freeze({
      name: this.name,
      characterId: this.characterId,
      callsign: this.name,
      appearanceId: this.characterId,
    });
  }

  getProfile() { return this.get(); }

  setName(value) { return this.update({ name: value }); }
  setCallsign(value) { return this.setName(value); }
  setCharacter(value) { return this.update({ characterId: value }); }
  setAppearance(value) { return this.setCharacter(value); }

  update(next = {}) {
    const previous = this.get();
    const hasRequestedName = Object.prototype.hasOwnProperty.call(next, 'name') ||
      Object.prototype.hasOwnProperty.call(next, 'callsign');
    const requestedName = next.name ?? next.callsign ?? this.name;
    const requestedCharacter = next.characterId ?? next.appearanceId ?? this.characterId;
    const normalizedName = normalizePlayerName(requestedName);
    const customizedChanged = hasRequestedName && !this._nameCustomized &&
      (normalizedName !== this.name || normalizedName.toLowerCase() === DEFAULT_NAME.toLowerCase());
    this.name = normalizedName;
    this.characterId = normalizeCharacterId(requestedCharacter);
    if (customizedChanged) this._nameCustomized = true;
    const profile = this.get();
    if (profile.name === previous.name && profile.characterId === previous.characterId && !customizedChanged) {
      return profile;
    }

    this._persist();
    const multiplayer = this.game?.multiplayer;
    const isolatedGuest = multiplayer?._unrankedIdentityConflict === true;
    if (this.game?.player) {
      // A duplicate-tab guest is a separate human seat. Profile storage still
      // belongs to the ranked window, so appearance/profile edits must not
      // replace the guest's live callsign with that shared ranked identity.
      if (!isolatedGuest) this.game.player.name = profile.name;
      this.game.player.characterId = profile.characterId;
    }
    if (multiplayer) {
      if (!isolatedGuest) multiplayer.localName = profile.name;
      if (multiplayer._ui?.name) {
        multiplayer._ui.name.value = isolatedGuest ? multiplayer.localName : profile.name;
      }
    }
    this.game?.events?.emit('profile:changed', { ...profile, profile, previous });
    return profile;
  }

  _read() {
    if (!canStore(this.storage)) {
      return {
        name: generateRandomPlayerName(this.random),
        characterId: DEFAULT_CHARACTER_ID,
        nameCustomized: false,
      };
    }
    let saved = null;
    let legacyName = null;
    try {
      const raw = this.storage.getItem(PROFILE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      saved = null;
    }
    try {
      legacyName = this.storage.getItem(NAME_KEY) || this.storage.getItem(LEGACY_NAME_KEY);
    } catch {
      legacyName = null;
    }
    const rawName = saved?.name ?? saved?.callsign ?? legacyName;
    const normalizedName = normalizePlayerName(rawName);
    const explicitlyCustomizedPlaceholder = saved?.nameCustomized === true &&
      isPlaceholderName(rawName);
    const shouldGenerate = isPlaceholderName(normalizedName) && !explicitlyCustomizedPlaceholder;
    return {
      name: shouldGenerate ? generateRandomPlayerName(this.random) : normalizedName,
      characterId: normalizeCharacterId(saved?.characterId ?? saved?.appearanceId),
      nameCustomized: shouldGenerate ? false : saved?.nameCustomized !== false,
    };
  }

  _persist() {
    if (!canStore(this.storage)) return;
    const profile = {
      name: this.name,
      characterId: this.characterId,
      nameCustomized: this._nameCustomized,
    };
    try {
      this.storage.setItem(PROFILE_KEY, JSON.stringify(profile));
      // Retain the old standalone keys so older builds and existing leaderboard
      // sessions migrate without splitting one person into multiple identities.
      this.storage.setItem(NAME_KEY, this.name);
      this.storage.setItem(LEGACY_NAME_KEY, this.name);
    } catch {
      // Browsers may expose localStorage but reject writes in privacy contexts.
    }
  }
}

export {
  PROFILE_KEY,
  NAME_KEY,
  LEGACY_NAME_KEY,
  DEFAULT_NAME,
  DEFAULT_CHARACTER_ID,
};

export default PlayerProfile;
