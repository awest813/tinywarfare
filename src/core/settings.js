// Device-local gameplay preferences. These deliberately live outside the
// player profile: aim feel, display brightness and physical keyboard layout
// belong to this browser, not to a ranked identity shared between devices.

import {
  GRAPHICS_PRESETS,
  autoGraphicsPreset,
  graphicsProfile,
  lighterPreset,
} from '../gfx/profiles.js';

export const SETTINGS_STORAGE_KEY = 'tiny-strike-settings-v1';

export const SETTINGS_LIMITS = Object.freeze({
  lookSensitivity: Object.freeze({ min: 0.25, max: 3, step: 0.05, default: 1 }),
  brightnessEv: Object.freeze({ min: -0.5, max: 0.5, step: 0.05, default: 0 }),
  volume: Object.freeze({ min: 0, max: 1, step: 0.05, default: 0.8 }),
  fov: Object.freeze({ min: 65, max: 100, step: 1, default: 74 }),
  // Multiplier on look speed while aiming down sights or scoped (on top of
  // the zoom compensation that keeps on-screen tracking speed constant).
  adsSensitivity: Object.freeze({ min: 0.5, max: 1.5, step: 0.05, default: 1 }),
});

// Graphics preset (src/gfx/profiles.js): 'auto' picks by device (and steps
// down when a match runs slowly); the others pin it.
export const GRAPHICS_OPTIONS = Object.freeze(['auto', ...GRAPHICS_PRESETS]);

// v2 moved Crouch off Ctrl: holding Ctrl while pressing W closes the browser
// tab. Layouts still on the v1 defaults are migrated once.
const BINDINGS_VERSION = 2;

export const KEY_BINDING_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'moveForward', label: 'Move Forward', canonicalKey: 'w', defaultKey: 'w' }),
  Object.freeze({ id: 'moveBackward', label: 'Move Backward', canonicalKey: 's', defaultKey: 's' }),
  Object.freeze({ id: 'moveLeft', label: 'Move Left', canonicalKey: 'a', defaultKey: 'a' }),
  Object.freeze({ id: 'moveRight', label: 'Move Right', canonicalKey: 'd', defaultKey: 'd' }),
  // Sprint precedes Walk so a saved v1 layout (Walk on Shift) migrates to
  // Sprint on Shift with Walk falling back to its new default.
  Object.freeze({ id: 'sprint', label: 'Sprint', canonicalKey: 'shift', defaultKey: 'shift' }),
  Object.freeze({ id: 'walk', label: 'Walk', canonicalKey: 'c', defaultKey: 'x' }),
  Object.freeze({ id: 'crouch', label: 'Crouch / Slide', canonicalKey: 'control', defaultKey: 'c' }),
  Object.freeze({ id: 'jump', label: 'Jump / Next Spectator', canonicalKey: ' ', defaultKey: ' ' }),
  Object.freeze({ id: 'use', label: 'Use / Objective', canonicalKey: 'e', defaultKey: 'e' }),
  Object.freeze({ id: 'reload', label: 'Reload', canonicalKey: 'r', defaultKey: 'r' }),
  Object.freeze({ id: 'buy', label: 'Buy Menu', canonicalKey: 'b', defaultKey: 'b' }),
  Object.freeze({ id: 'scoreboard', label: 'Scoreboard', canonicalKey: 'tab', defaultKey: 'tab' }),
  Object.freeze({ id: 'lastWeapon', label: 'Last Weapon', canonicalKey: 'q', defaultKey: 'q' }),
  Object.freeze({ id: 'weapon1', label: 'Primary Weapon', canonicalKey: '1', defaultKey: '1' }),
  Object.freeze({ id: 'weapon2', label: 'Sidearm', canonicalKey: '2', defaultKey: '2' }),
  Object.freeze({ id: 'weapon3', label: 'Knife', canonicalKey: '3', defaultKey: '3' }),
  Object.freeze({ id: 'weapon4', label: 'Grenade', canonicalKey: '4', defaultKey: '4' }),
  Object.freeze({ id: 'streak1', label: 'Scorestreak 1', canonicalKey: '5', defaultKey: '5' }),
  Object.freeze({ id: 'streak2', label: 'Scorestreak 2', canonicalKey: '6', defaultKey: '6' }),
  Object.freeze({ id: 'streak3', label: 'Care Package Bonus', canonicalKey: '7', defaultKey: '7' }),
]);

const DEFINITION_BY_ID = new Map(KEY_BINDING_DEFINITIONS.map((entry) => [entry.id, entry]));
const CANONICAL_KEYS = new Set(KEY_BINDING_DEFINITIONS.map((entry) => entry.canonicalKey));
const FORBIDDEN_BINDINGS = new Set([
  'escape', 'meta', 'os', 'dead', 'unidentified', 'process', 'compose',
  // macOS sends Caps Lock's keyup only when it turns off: a hold would latch.
  'capslock',
]);

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function canStore(storage) {
  return storage &&
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function';
}

function clampStep(value, limits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return limits.default;
  const clamped = Math.max(limits.min, Math.min(limits.max, number));
  const steps = Math.round((clamped - limits.min) / limits.step);
  return Number((limits.min + steps * limits.step).toFixed(4));
}

export function normalizePhysicalKey(value) {
  if (typeof value !== 'string') return null;
  if (value === ' ' || value === 'Spacebar') return ' ';
  const key = String(value).trim().toLowerCase();
  return key || null;
}

export function canBindPhysicalKey(value) {
  const key = normalizePhysicalKey(value);
  return !!key && key.length <= 24 && !FORBIDDEN_BINDINGS.has(key);
}

// The browser's keyboard layout map (navigator.keyboard.getLayoutMap()), when
// available: letter keys are bound by position, so a label shows what the
// player's own layout prints there (Z on AZERTY's W key, Ц on Russian).
let keyboardLayout = null;

export function setKeyboardLayoutMap(map) {
  keyboardLayout = map && typeof map.get === 'function' ? map : null;
}

const PUNCTUATION_CODES = Object.freeze({
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash',
  '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  intlbackslash: 'IntlBackslash', intlro: 'IntlRo', intlyen: 'IntlYen',
});

export function formatKeyLabel(value) {
  const key = normalizePhysicalKey(value);
  if (!key) return 'UNBOUND';
  if (keyboardLayout && /^[a-z]$/.test(key)) {
    const printed = keyboardLayout.get('Key' + key.toUpperCase());
    if (typeof printed === 'string' && printed.trim()) return printed.toUpperCase();
  }
  // Punctuation is bound by position too (input.js PUNCTUATION_BY_CODE).
  const punctCode = PUNCTUATION_CODES[key];
  if (keyboardLayout && punctCode) {
    const printed = keyboardLayout.get(punctCode);
    if (typeof printed === 'string' && printed.trim()) return printed.toUpperCase();
  }
  const labels = {
    ' ': 'SPACE',
    control: 'CTRL',
    shift: 'SHIFT',
    alt: 'ALT',
    tab: 'TAB',
    enter: 'ENTER',
    backspace: 'BACKSPACE',
    capslock: 'CAPS LOCK',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    pageup: 'PAGE UP',
    pagedown: 'PAGE DOWN',
    intlbackslash: '<',
    intlro: 'RO',
    intlyen: '¥',
  };
  return labels[key] || key.toUpperCase();
}

export function canonicalKeyForAction(actionId) {
  return DEFINITION_BY_ID.get(String(actionId || ''))?.canonicalKey ?? null;
}

export function bindingDefinition(actionId) {
  return DEFINITION_BY_ID.get(String(actionId || '')) ?? null;
}

function defaultBindings() {
  return Object.fromEntries(
    KEY_BINDING_DEFINITIONS.map((entry) => [entry.id, entry.defaultKey])
  );
}

// Every single character input.js can still produce: letters, digits and
// punctuation are read by position (as their US unshifted character), so a
// binding saved before that switch to a layout's own character ('ц' on
// Russian, 'ö' on German) can never fire again. It falls back to its default
// instead of leaving the action silently dead.
// (Numpad + and * have no position mapping and arrive as typed: keep them.)
const REACHABLE_CHAR = /^[a-z0-9 ;',./\\[\]\-=`+*]$/;

function reachable(key) {
  return key.length > 1 || REACHABLE_CHAR.test(key);
}

function sanitizeBindings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const bindings = {};
  const used = new Set();
  const pending = [];

  // Preserve every valid, unique stored choice first. A second pass repairs
  // malformed/duplicate entries without discarding the rest of the layout.
  for (const definition of KEY_BINDING_DEFINITIONS) {
    const requested = normalizePhysicalKey(source[definition.id] ?? definition.defaultKey);
    if (canBindPhysicalKey(requested) && reachable(requested) && !used.has(requested)) {
      bindings[definition.id] = requested;
      used.add(requested);
    } else {
      pending.push(definition);
    }
  }

  const fallbackKeys = KEY_BINDING_DEFINITIONS.map((entry) => entry.defaultKey);
  for (const definition of pending) {
    const fallback = [definition.defaultKey, ...fallbackKeys].find((key) => !used.has(key));
    bindings[definition.id] = fallback;
    used.add(fallback);
  }
  return bindings;
}

export default class GameSettings {
  constructor(game = null, storage = defaultStorage()) {
    this.game = game;
    this.storage = storage;
    this.lookSensitivity = SETTINGS_LIMITS.lookSensitivity.default;
    this.brightnessEv = SETTINGS_LIMITS.brightnessEv.default;
    this.volume = SETTINGS_LIMITS.volume.default;
    this.fov = SETTINGS_LIMITS.fov.default;
    this.announcer = true;
    this.showFps = false;
    this.killcam = true;
    this.aimToggle = false;
    this.crouchToggle = false;
    this.invertY = false;
    this.adsSensitivity = SETTINGS_LIMITS.adsSensitivity.default;
    this.graphics = 'auto';
    // Set when Auto found High too slow on this device: start on Low.
    this.graphicsAutoFloor = '';
    this.bindings = defaultBindings();
    this._physicalToCanonical = new Map();
    this._load();
    this._rebuildLookup();
  }

  get(actionId) {
    return this.bindings[String(actionId || '')] ?? null;
  }

  getLabel(actionId) {
    return formatKeyLabel(this.get(actionId));
  }

  isPhysicalBinding(physicalKey) {
    const key = normalizePhysicalKey(physicalKey);
    return !!key && this._physicalToCanonical.has(key);
  }

  setLookSensitivity(value) {
    const next = clampStep(value, SETTINGS_LIMITS.lookSensitivity);
    if (next === this.lookSensitivity) return next;
    this.lookSensitivity = next;
    this._commit('lookSensitivity');
    return next;
  }

  setBrightnessEv(value) {
    const next = clampStep(value, SETTINGS_LIMITS.brightnessEv);
    if (next === this.brightnessEv) return next;
    this.brightnessEv = next;
    this._commit('brightnessEv');
    return next;
  }

  /** Master volume, 0 (muted) to 1. */
  setVolume(value) {
    const next = clampStep(value, SETTINGS_LIMITS.volume);
    if (next === this.volume) return next;
    this.volume = next;
    this._commit('volume');
    return next;
  }

  /** Horizontal-ish camera field of view in degrees (hip fire). */
  setFov(value) {
    const next = clampStep(value, SETTINGS_LIMITS.fov);
    if (next === this.fov) return next;
    this.fov = next;
    this._commit('fov');
    return next;
  }

  /** Replay of how you died, after each death. */
  setKillcam(on) {
    const next = !!on;
    if (next === this.killcam) return next;
    this.killcam = next;
    this._commit('killcam');
    return next;
  }

  /** Right mouse button: hold to aim (default) or click to toggle. */
  setAimToggle(on) {
    const next = !!on;
    if (next === this.aimToggle) return next;
    this.aimToggle = next;
    this._commit('aimToggle');
    return next;
  }

  /** Crouch key (and a controller's B): hold to crouch (default) or press to toggle. */
  setCrouchToggle(on) {
    const next = !!on;
    if (next === this.crouchToggle) return next;
    this.crouchToggle = next;
    this._commit('crouchToggle');
    return next;
  }

  /** Invert vertical look for mouse, touch and controller. */
  setInvertY(on) {
    const next = !!on;
    if (next === this.invertY) return next;
    this.invertY = next;
    this._commit('invertY');
    return next;
  }

  setAdsSensitivity(value) {
    const next = clampStep(value, SETTINGS_LIMITS.adsSensitivity);
    if (next === this.adsSensitivity) return next;
    this.adsSensitivity = next;
    this._commit('adsSensitivity');
    return next;
  }

  /** Frame-rate readout in the corner of the screen. */
  setShowFps(on) {
    const next = !!on;
    if (next === this.showFps) return next;
    this.showFps = next;
    this._commit('showFps');
    return next;
  }

  /** Spoken announcer lines (speech synthesis) on/off. */
  setAnnouncer(on) {
    const next = !!on;
    if (next === this.announcer) return next;
    this.announcer = next;
    this._commit('announcer');
    return next;
  }

  /** 'auto' | 'high' | 'low' | 'chromebook' (applies on the next load). */
  setGraphics(value) {
    const next = GRAPHICS_OPTIONS.includes(value) ? value : 'auto';
    if (next === this.graphics) return next;
    this.graphics = next;
    // A deliberate pick also clears Auto's memory of a slow device.
    this.graphicsAutoFloor = '';
    this._commit('graphics');
    return next;
  }

  /**
   * Auto's verdict on this device: the lightest preset it had to step down
   * to. Later visits on Auto never start above it.
   */
  setGraphicsAutoFloor(preset) {
    const next = GRAPHICS_PRESETS.includes(preset) && preset !== 'high' ? preset : '';
    if (next === this.graphicsAutoFloor) return next;
    this.graphicsAutoFloor = next;
    this._commit('graphics');
    return next;
  }

  /**
   * The preset to start with. `device` is { touch, chromeOS, gpu }; a bare
   * boolean is the older touch-only form.
   */
  graphicsPreset(device = {}) {
    if (this.graphics !== 'auto') return this.graphics;
    const env = typeof device === 'boolean' ? { touch: device } : device;
    return lighterPreset(autoGraphicsPreset(env), this.graphicsAutoFloor || 'high');
  }

  /** The tier the older modules branch on: 'high' or 'low'. */
  graphicsQuality(device = {}) {
    return graphicsProfile(this.graphicsPreset(device)).tier;
  }

  rebind(actionId, physicalKey) {
    const id = String(actionId || '');
    const definition = DEFINITION_BY_ID.get(id);
    const key = normalizePhysicalKey(physicalKey);
    if (!definition || !canBindPhysicalKey(key)) {
      return Object.freeze({ changed: false, rejected: true, actionId: id, key: null });
    }

    const previousKey = this.bindings[id];
    if (key === previousKey) {
      return Object.freeze({ changed: false, rejected: false, actionId: id, key });
    }

    const swappedActionId = KEY_BINDING_DEFINITIONS.find(
      (entry) => entry.id !== id && this.bindings[entry.id] === key
    )?.id ?? null;

    this.bindings[id] = key;
    if (swappedActionId) this.bindings[swappedActionId] = previousKey;
    this._rebuildLookup();
    this._commit('bindings', { actionId: id, key, swappedActionId });
    return Object.freeze({
      changed: true,
      rejected: false,
      actionId: id,
      key,
      swappedActionId,
    });
  }

  /**
   * Translate one physical KeyboardEvent key into the stable semantic key all
   * gameplay systems already consume. A displaced default returns null rather
   * than falling through, otherwise its old action would remain active too.
   */
  resolveInputKey(physicalKey) {
    const key = normalizePhysicalKey(physicalKey);
    if (!key) return null;
    const canonical = this._physicalToCanonical.get(key);
    if (canonical) return canonical;
    return CANONICAL_KEYS.has(key) ? null : key;
  }

  reset() {
    this.lookSensitivity = SETTINGS_LIMITS.lookSensitivity.default;
    this.brightnessEv = SETTINGS_LIMITS.brightnessEv.default;
    this.volume = SETTINGS_LIMITS.volume.default;
    this.fov = SETTINGS_LIMITS.fov.default;
    this.announcer = true;
    this.showFps = false;
    this.killcam = true;
    this.aimToggle = false;
    this.crouchToggle = false;
    this.invertY = false;
    this.adsSensitivity = SETTINGS_LIMITS.adsSensitivity.default;
    this.graphics = 'auto';
    this.graphicsAutoFloor = '';
    this.bindings = defaultBindings();
    this._rebuildLookup();
    this._commit('reset');
  }

  snapshot() {
    return Object.freeze({
      lookSensitivity: this.lookSensitivity,
      brightnessEv: this.brightnessEv,
      volume: this.volume,
      fov: this.fov,
      announcer: this.announcer,
      showFps: this.showFps,
      killcam: this.killcam,
      aimToggle: this.aimToggle,
      crouchToggle: this.crouchToggle,
      invertY: this.invertY,
      adsSensitivity: this.adsSensitivity,
      graphics: this.graphics,
      bindings: Object.freeze({ ...this.bindings }),
    });
  }

  _load() {
    if (!canStore(this.storage)) return;
    try {
      const raw = this.storage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      this.lookSensitivity = clampStep(
        parsed.lookSensitivity,
        SETTINGS_LIMITS.lookSensitivity
      );
      this.brightnessEv = clampStep(parsed.brightnessEv, SETTINGS_LIMITS.brightnessEv);
      this.volume = clampStep(parsed.volume ?? SETTINGS_LIMITS.volume.default, SETTINGS_LIMITS.volume);
      this.fov = clampStep(parsed.fov ?? SETTINGS_LIMITS.fov.default, SETTINGS_LIMITS.fov);
      this.announcer = parsed.announcer !== false;
      this.showFps = parsed.showFps === true;
      this.killcam = parsed.killcam !== false;
      this.aimToggle = parsed.aimToggle === true;
      this.crouchToggle = parsed.crouchToggle === true;
      this.invertY = parsed.invertY === true;
      this.adsSensitivity = clampStep(parsed.adsSensitivity ?? SETTINGS_LIMITS.adsSensitivity.default, SETTINGS_LIMITS.adsSensitivity);
      this.graphics = GRAPHICS_OPTIONS.includes(parsed.graphics) ? parsed.graphics : 'auto';
      this.graphicsAutoFloor = ['low', 'chromebook'].includes(parsed.graphicsAutoFloor)
        ? parsed.graphicsAutoFloor
        : parsed.graphicsAutoLow === true ? 'low' : '';
      const stored = parsed.bindings && typeof parsed.bindings === 'object' ? { ...parsed.bindings } : parsed.bindings;
      if (stored && !(parsed.bindingsVersion >= BINDINGS_VERSION) &&
        normalizePhysicalKey(stored.crouch) === 'control') {
        // Walk leaves C for X when it sat on the old default; Crouch then
        // takes C unless the player gave C to something else.
        if (normalizePhysicalKey(stored.walk) === 'c') stored.walk = 'x';
        const cTaken = Object.entries(stored).some(([id, key]) => id !== 'crouch' && normalizePhysicalKey(key) === 'c');
        if (!cTaken) stored.crouch = 'c';
      }
      this.bindings = sanitizeBindings(stored);
    } catch {
      // Privacy modes and corrupted JSON both fall back to safe defaults.
    }
  }

  _rebuildLookup() {
    this._physicalToCanonical.clear();
    for (const definition of KEY_BINDING_DEFINITIONS) {
      const physical = this.bindings[definition.id];
      this._physicalToCanonical.set(physical, definition.canonicalKey);
    }
  }

  _commit(kind, detail = {}) {
    if (canStore(this.storage)) {
      try {
        this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
          lookSensitivity: this.lookSensitivity,
          brightnessEv: this.brightnessEv,
          volume: this.volume,
          fov: this.fov,
          announcer: this.announcer,
          showFps: this.showFps,
          killcam: this.killcam,
          aimToggle: this.aimToggle,
          crouchToggle: this.crouchToggle,
          invertY: this.invertY,
          adsSensitivity: this.adsSensitivity,
          graphics: this.graphics,
          graphicsAutoFloor: this.graphicsAutoFloor,
          bindingsVersion: BINDINGS_VERSION,
          bindings: this.bindings,
        }));
      } catch {
        // The setting remains live for this session when persistence is denied.
      }
    }
    this.game?.events?.emit?.('settings:changed', {
      kind,
      ...detail,
      settings: this.snapshot(),
    });
  }
}
