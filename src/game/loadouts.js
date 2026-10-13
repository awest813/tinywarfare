// ============================================================================
// TINY WARFARE — src/game/loadouts.js
//
// Create-a-class for respawn modes. Five editable classes, each a primary,
// secondary, lethal, tactical, and one perk, saved on this device. The
// selected class applies at every spawn; while dead, keys 1-5 pick the class
// for the next life.
//
// Perks are read by the systems they change (player speed, weapon handling,
// bot hearing, explosive damage) through hasPerk(player, id).
// ============================================================================

export const LOADOUT_STORAGE_KEY = 'tiny-strike-classes-v1';

export const PRIMARIES = Object.freeze(['m4a1', 'ak47', 'mp5', 'awp']);
export const SECONDARIES = Object.freeze(['usp', 'glock', 'deagle']);
export const LETHALS = Object.freeze(['hegrenade']);
export const TACTICALS = Object.freeze(['flashbang', 'smokegrenade']);

export const PERKS = Object.freeze({
  lightweight: Object.freeze({ id: 'lightweight', label: 'LIGHTWEIGHT', detail: 'Move and sprint 8% faster' }),
  quickhands: Object.freeze({ id: 'quickhands', label: 'QUICK HANDS', detail: 'Reload 35% and swap weapons 40% faster' }),
  ghost: Object.freeze({ id: 'ghost', label: 'GHOST', detail: 'Hidden from enemy UAV; quieter footsteps' }),
  flakjacket: Object.freeze({ id: 'flakjacket', label: 'FLAK JACKET', detail: 'Take 55% less explosive damage' }),
});
export const PERK_IDS = Object.freeze(Object.keys(PERKS));

export const PERK_TUNING = Object.freeze({
  LIGHTWEIGHT_SPEED: 1.08,
  QUICKHANDS_RELOAD: 0.65,
  QUICKHANDS_SWAP: 0.6,
  GHOST_FOOTSTEP_RANGE: 0.45,
  FLAK_SCALE: 0.45,
});

export const EXPLOSIVE_WEAPONS = Object.freeze(new Set(['hegrenade', 'airstrike', 'c4']));

export const DEFAULT_CLASSES = Object.freeze([
  Object.freeze({ name: 'ASSAULT', primary: 'm4a1', secondary: 'usp', lethal: 'hegrenade', tactical: 'flashbang', perk: 'quickhands' }),
  Object.freeze({ name: 'CLOSE QUARTERS', primary: 'mp5', secondary: 'deagle', lethal: 'hegrenade', tactical: 'flashbang', perk: 'lightweight' }),
  Object.freeze({ name: 'RECON SNIPER', primary: 'awp', secondary: 'usp', lethal: 'hegrenade', tactical: 'smokegrenade', perk: 'ghost' }),
  Object.freeze({ name: 'RIFLEMAN', primary: 'ak47', secondary: 'glock', lethal: 'hegrenade', tactical: 'smokegrenade', perk: 'flakjacket' }),
  Object.freeze({ name: 'CUSTOM', primary: 'm4a1', secondary: 'deagle', lethal: 'hegrenade', tactical: 'flashbang', perk: 'lightweight' }),
]);

/** True when `actor` (player or bot) runs the given perk. */
export function hasPerk(actor, id) {
  return !!actor && actor.perk === id;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Repair a stored or edited class against the allowed item lists. */
export function sanitizeClass(value, fallback) {
  const src = value && typeof value === 'object' ? value : {};
  const name = String(src.name || fallback.name)
    .replace(/[^\p{L}\p{N} &'-]/gu, '')
    .trim()
    .slice(0, 16)
    .toUpperCase() || fallback.name;
  return {
    name,
    primary: pick(src.primary, PRIMARIES, fallback.primary),
    secondary: pick(src.secondary, SECONDARIES, fallback.secondary),
    lethal: pick(src.lethal, LETHALS, fallback.lethal),
    tactical: pick(src.tactical, TACTICALS, fallback.tactical),
    perk: pick(src.perk, PERK_IDS, fallback.perk),
  };
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export default class Loadouts {
  constructor(game, storage = defaultStorage()) {
    this.game = game;
    this.storage = storage;
    this.classes = DEFAULT_CLASSES.map((entry) => ({ ...entry }));
    this.selected = 0;
    this._load();

    if (game && game.events) {
      game.events.on('input:keydown', (p) => this._onKey(p && p.key));
    }
  }

  active() {
    return this.classes[this.selected] || this.classes[0];
  }

  select(index) {
    const i = Math.floor(Number(index));
    if (!(i >= 0 && i < this.classes.length)) return false;
    if (i === this.selected) return true;
    this.selected = i;
    this._save();
    this.game?.events?.emit('loadout:select', { index: i, loadout: this.active() });
    return true;
  }

  /** Patch one class; unknown items are repaired to that slot's default. */
  edit(index, patch) {
    const i = Math.floor(Number(index));
    if (!(i >= 0 && i < this.classes.length)) return null;
    this.classes[i] = sanitizeClass({ ...this.classes[i], ...patch }, DEFAULT_CLASSES[i]);
    this._save();
    this.game?.events?.emit('loadout:edit', { index: i, loadout: this.classes[i] });
    return this.classes[i];
  }

  resetClass(index) {
    const i = Math.floor(Number(index));
    if (!(i >= 0 && i < this.classes.length)) return null;
    this.classes[i] = { ...DEFAULT_CLASSES[i] };
    this._save();
    this.game?.events?.emit('loadout:edit', { index: i, loadout: this.classes[i] });
    return this.classes[i];
  }

  // While dead in a respawn mode, the weapon keys pick the next class.
  _onKey(key) {
    const g = this.game;
    if (!g || g.state?.mode !== 'tdm' || !g.player || g.player.alive !== false) return;
    if (!/^[1-5]$/.test(String(key))) return;
    this.select(Number(key) - 1);
  }

  _load() {
    const storage = this.storage;
    if (!storage || typeof storage.getItem !== 'function') return;
    try {
      const parsed = JSON.parse(storage.getItem(LOADOUT_STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return;
      if (Array.isArray(parsed.classes)) {
        this.classes = DEFAULT_CLASSES.map((fallback, i) => sanitizeClass(parsed.classes[i], fallback));
      }
      const selected = Math.floor(Number(parsed.selected));
      if (selected >= 0 && selected < this.classes.length) this.selected = selected;
    } catch {
      // Corrupt or blocked storage: keep the defaults.
    }
  }

  _save() {
    const storage = this.storage;
    if (!storage || typeof storage.setItem !== 'function') return;
    try {
      storage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify({ selected: this.selected, classes: this.classes }));
    } catch {
      // Private mode: the choice still applies for this session.
    }
  }
}
