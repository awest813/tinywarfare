import assert from 'node:assert/strict';
import test from 'node:test';

import Input from '../src/core/input.js';
import GameSettings, {
  KEY_BINDING_DEFINITIONS,
  SETTINGS_STORAGE_KEY,
  formatKeyLabel,
} from '../src/core/settings.js';
import { exposureWithBrightnessEv } from '../src/gfx/sky/index.js';
import { BASE_LOOK_SENSITIVITY, lookSensitivityFor } from '../src/player/player.js';
import HUD from '../src/ui/hud.js';
import Weapons from '../src/weapons/weapons.js';

class MemoryStorage {
  constructor(seed = {}) {
    this.data = new Map(Object.entries(seed));
    this.writes = [];
  }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) {
    this.data.set(key, String(value));
    this.writes.push([key, String(value)]);
  }
}

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.listenerOptions = new Map();
  }
  addEventListener(name, listener, options) {
    const list = this.listeners.get(name) || [];
    list.push(listener);
    this.listeners.set(name, list);
    const optionList = this.listenerOptions.get(name) || [];
    optionList.push(options);
    this.listenerOptions.set(name, optionList);
  }
}

function eventBus() {
  const emitted = [];
  const listeners = new Map();
  return {
    emitted,
    on(name, listener) {
      const list = listeners.get(name) || [];
      list.push(listener);
      listeners.set(name, list);
    },
    emit(name, detail) {
      emitted.push({ name, detail });
      for (const listener of listeners.get(name) || []) listener(detail);
    },
  };
}

function installInputGlobals(t) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new FakeTarget();
  globalThis.document = new FakeTarget();
  globalThis.document.visibilityState = 'visible';
  globalThis.document.pointerLockElement = null;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
}

test('settings persist sensitivity, brightness and a unique swapped keyboard layout', () => {
  const storage = new MemoryStorage();
  const events = eventBus();
  const game = { events };
  const settings = new GameSettings(game, storage);
  game.settings = settings;

  assert.equal(settings.lookSensitivity, 1);
  assert.equal(settings.brightnessEv, 0);
  assert.equal(settings.get('moveForward'), 'w');
  assert.equal(formatKeyLabel(settings.get('jump')), 'SPACE');

  settings.setLookSensitivity(1.75);
  settings.setBrightnessEv(-0.3);
  const swapped = settings.rebind('moveForward', 's');
  assert.equal(swapped.swappedActionId, 'moveBackward');
  assert.equal(settings.get('moveForward'), 's');
  assert.equal(settings.get('moveBackward'), 'w');

  const restored = new GameSettings(null, storage);
  assert.equal(restored.lookSensitivity, 1.75);
  assert.equal(restored.brightnessEv, -0.3);
  assert.equal(restored.get('moveForward'), 's');
  assert.equal(restored.get('moveBackward'), 'w');
  assert.ok(storage.writes.every(([key]) => key === SETTINGS_STORAGE_KEY));
  assert.ok(events.emitted.some((entry) => entry.name === 'settings:changed'));
});

test('a displaced default key is disabled and corrupt storage repairs safely', () => {
  const settings = new GameSettings(null, null);
  settings.rebind('moveForward', 'i');
  assert.equal(settings.resolveInputKey('i'), 'w');
  assert.equal(settings.resolveInputKey('w'), null, 'the old W binding must not keep moving');
  assert.equal(settings.resolveInputKey('k'), 'k', 'unrelated keys still pass through');

  const corrupt = new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({
      lookSensitivity: 99,
      brightnessEv: -99,
      bindings: Object.fromEntries(KEY_BINDING_DEFINITIONS.map((entry) => [entry.id, 'z'])),
    }),
  });
  const repaired = new GameSettings(null, corrupt);
  assert.equal(repaired.lookSensitivity, 3);
  assert.equal(repaired.brightnessEv, -0.5);
  assert.equal(new Set(Object.values(repaired.bindings)).size, KEY_BINDING_DEFINITIONS.length);

  const malformed = new GameSettings(null, new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: '{ definitely not json',
  }));
  assert.equal(malformed.lookSensitivity, 1);
  assert.equal(malformed.get('scoreboard'), 'tab');

  const wrongTypes = new GameSettings(null, new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({
      bindings: { moveForward: {}, moveBackward: true, reload: 42 },
    }),
  }));
  assert.equal(wrongTypes.get('moveForward'), 'w');
  assert.equal(wrongTypes.get('moveBackward'), 's');
  assert.equal(wrongTypes.get('reload'), 'r');
});

test('blocked storage keeps settings live for the current session', () => {
  const storage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const settings = new GameSettings(null, storage);
  assert.doesNotThrow(() => settings.setBrightnessEv(0.4));
  assert.doesNotThrow(() => settings.rebind('reload', 'f'));
  assert.equal(settings.brightnessEv, 0.4);
  assert.equal(settings.get('reload'), 'f');
});

test('input remaps hardware before gameplay while semantic touch actions stay fixed', (t) => {
  installInputGlobals(t);
  const events = eventBus();
  const game = { debug: false, canvas: {}, events };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);
  assert.equal(globalThis.window.listenerOptions.get('keydown')[0].capture, true);
  game.input = input;

  game.settings.rebind('moveForward', 'i');
  input._onKeyDown({ key: 'i', repeat: false });
  assert.equal(input.isDown('w'), true);
  assert.ok(events.emitted.some((entry) =>
    entry.name === 'input:keydown' && entry.detail.key === 'w'
  ));
  input._onKeyUp({ key: 'i' });
  assert.equal(input.isDown('w'), false);

  input._onKeyDown({ key: 'w', repeat: false });
  assert.equal(input.isDown('w'), false, 'the displaced physical W key is inert');

  input.setVirtualAction('moveForward', true);
  assert.equal(input.isDown('w'), true, 'touch still means Move Forward after remapping');
  input.setVirtualAction('moveForward', false);
});

test('the digit row survives Shift and Cmd release never leaves keys held', (t) => {
  installInputGlobals(t);
  const events = eventBus();
  const game = { debug: false, canvas: {}, events };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);
  game.input = input;

  input._onKeyDown({ key: '1', code: 'Digit1', repeat: false });
  input._onKeyDown({ key: 'Shift', code: 'ShiftLeft', repeat: false, shiftKey: true });
  input._onKeyUp({ key: '!', code: 'Digit1', shiftKey: true });
  assert.equal(input.isDown('1'), false, 'a shifted keyup releases the digit');
  input._onKeyDown({ key: '@', code: 'Digit2', repeat: false, shiftKey: true });
  assert.equal(input.isDown('2'), true, 'weapon slots work while walking');
  input._onKeyUp({ key: 'Shift', code: 'ShiftLeft' });
  input._onKeyUp({ key: '2', code: 'Digit2' });

  input._onKeyDown({ key: 'w', code: 'KeyW', repeat: false });
  input._onKeyDown({ key: 'Meta', code: 'MetaLeft', repeat: false, metaKey: true });
  input._onKeyUp({ key: 'Meta', code: 'MetaLeft' });
  assert.equal(input.isDown('w'), false, 'releasing Cmd drops keys whose keyup macOS swallows');
});

test('key capture consumes the assignment, Escape cancels, and Tab navigates while unlocked', (t) => {
  installInputGlobals(t);
  const events = eventBus();
  const game = { debug: false, canvas: {}, events };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);

  let captured = null;
  let prevented = false;
  let stopped = false;
  assert.equal(input.captureNextKey((key, meta) => { captured = { key, meta }; }), true);
  input._onKeyDown({
    key: 'f',
    repeat: false,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.deepEqual(captured, { key: 'f', meta: { cancelled: false } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(input.isDown('f'), false);
  assert.equal(events.emitted.some((entry) => entry.name === 'input:keydown'), false);

  input.captureNextKey((key, meta) => { captured = { key, meta }; });
  input._onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(captured.key, null);
  assert.equal(captured.meta.cancelled, true);

  prevented = false;
  input._onKeyDown({ key: 'Tab', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'Tab must navigate the unlocked Settings panel');
  input._onKeyUp({ key: 'Tab' });
  input.locked = true;
  input._onKeyDown({ key: 'Tab', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'locked Tab remains the scoreboard key');

  input._onKeyUp({ key: 'Tab' });
  game.settings.rebind('scoreboard', 'x');
  prevented = false;
  input._onKeyDown({ key: 'Tab', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'a displaced physical Tab still cannot move browser focus');
  assert.equal(input.isDown('tab'), false, 'displaced Tab does not enter gameplay state');

  game.settings.rebind('reload', 'f5');
  prevented = false;
  input._onKeyDown({ key: 'F5', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'a browser-reserved key is suppressed when bound');
  assert.equal(input.isDown('r'), true);

  game.settings.reset();
  prevented = false;
  input._onKeyDown({
    key: 'r',
    ctrlKey: true,
    repeat: false,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true, 'crouch plus reload cannot refresh the page');
});

test('look and brightness helpers preserve authored defaults and scoped ratios', () => {
  assert.equal(lookSensitivityFor(1), BASE_LOOK_SENSITIVITY);
  assert.equal(lookSensitivityFor(3), BASE_LOOK_SENSITIVITY * 3);
  // Scoped turn rate follows the zoom (tan ratio), as ADS does.
  const scoped = (fov) => Weapons.prototype.adsSensitivityScale.call({ _fovCurrent: fov, _baseFov: () => 74 });
  const tanRatio = (fov) => Math.tan((fov * Math.PI) / 360) / Math.tan((74 * Math.PI) / 360);
  assert.ok(Math.abs(scoped(26) - tanRatio(26)) < 1e-12);
  assert.ok(Math.abs(scoped(11) - tanRatio(11)) < 1e-12);
  assert.equal(scoped(74), 1);
  assert.equal(exposureWithBrightnessEv(0.95, 0), 0.95);
  assert.ok(Math.abs(exposureWithBrightnessEv(0.95, 0.5) - 0.95 * Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(exposureWithBrightnessEv(0.95, -0.5) - 0.95 / Math.SQRT2) < 1e-12);
});

test('the default menu keeps Settings collapsed and uses its existing quick-action slot', () => {
  const hud = Object.create(HUD.prototype);
  hud.game = { settings: new GameSettings(null, null) };
  const html = hud._html();

  assert.match(html, /id="hud-settings-open"[^>]*>SETTINGS/);
  assert.match(html, /id="hud-menu-settings"[^>]*hidden/);
  assert.equal((html.match(/data-binding-action=/g) || []).length, KEY_BINDING_DEFINITIONS.length);
  assert.doesNotMatch(html, /id="hud-controls-open"/);
});

test('v1 layouts move Crouch off Ctrl (Ctrl+W closes the tab)', () => {
  const v1 = new GameSettings(null, new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({ bindings: { walk: 'c', crouch: 'control', sprint: 'shift' } }),
  }));
  assert.equal(v1.get('crouch'), 'c');
  assert.equal(v1.get('walk'), 'x');
  assert.equal(v1.resolveInputKey('c'), 'control', 'C crouches (and slides)');
  assert.equal(v1.resolveInputKey('control'), null, 'Ctrl is no longer bound');

  const custom = new GameSettings(null, new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({ bindings: { walk: 'v', crouch: 'control', reload: 'c' } }),
  }));
  assert.equal(custom.get('crouch'), 'control', 'a player who gave C away keeps their layout');

  const v2 = new GameSettings(null, new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({ bindingsVersion: 2, bindings: { crouch: 'control', walk: 'c' } }),
  }));
  assert.equal(v2.get('crouch'), 'control', 'a deliberate v2 choice of Ctrl is respected');
});

test('volume and field of view are clamped and persisted', () => {
  const storage = new MemoryStorage();
  const settings = new GameSettings(null, storage);
  assert.equal(settings.volume, 0.8);
  assert.equal(settings.fov, 74);
  assert.equal(settings.setVolume(2), 1);
  assert.equal(settings.setFov(40), 65);
  const reloaded = new GameSettings(null, storage);
  assert.equal(reloaded.volume, 1);
  assert.equal(reloaded.fov, 65);
});

test('graphics: auto picks by device, remembers a slow one, and a pick overrides it', async () => {
  const { default: GameSettings, GRAPHICS_OPTIONS } = await import('../src/core/settings.js');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const settings = new GameSettings(null, storage);
  assert.deepEqual(GRAPHICS_OPTIONS, ['auto', 'high', 'low', 'chromebook']);
  assert.equal(settings.graphics, 'auto');
  assert.equal(settings.graphicsQuality(false), 'high', 'a desktop starts on High');
  assert.equal(settings.graphicsQuality(true), 'low', 'a phone starts on Low');
  settings.setGraphicsAutoFloor('low');
  assert.equal(new GameSettings(null, storage).graphicsQuality(false), 'low', 'a slow desktop is remembered');
  settings.setGraphics('high');
  assert.equal(settings.graphicsAutoFloor, '', 'a deliberate pick clears it');
  assert.equal(new GameSettings(null, storage).graphicsQuality(true), 'high', 'and pins the tier');
  settings.setGraphics('nonsense');
  assert.equal(settings.graphics, 'auto');
  settings.setGraphics('low');
  settings.reset();
  assert.equal(settings.graphics, 'auto');
});

test('graphics: Chromebook preset, device detection, and the remembered floor', async () => {
  const { default: GameSettings } = await import('../src/core/settings.js');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const settings = new GameSettings(null, storage);
  const mali = { chromeOS: true, gpu: 'ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)' };
  const n100 = { chromeOS: true, gpu: 'ANGLE (Intel, Mesa Intel(R) Graphics (ADL-N), OpenGL ES 3.2)' };
  const irisCrOS = { chromeOS: true, gpu: 'ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL ES 3.2)' };
  const uhdWin = { gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' };
  const rtx = { gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' };
  assert.equal(settings.graphicsPreset(mali), 'chromebook');
  assert.equal(settings.graphicsPreset(n100), 'chromebook');
  assert.equal(settings.graphicsPreset(irisCrOS), 'high', 'a Chromebook Plus starts on High and steps down if it must');
  assert.equal(settings.graphicsPreset(uhdWin), 'low');
  assert.equal(settings.graphicsPreset(rtx), 'high');
  assert.equal(settings.graphicsPreset({ gpu: 'Google SwiftShader' }), 'chromebook', 'software rendering');
  assert.equal(settings.graphicsPreset({ touch: true }), 'low');
  assert.equal(settings.graphicsQuality(mali), 'low', 'Chromebook runs the Low tier underneath');

  settings.setGraphicsAutoFloor('chromebook');
  const later = new GameSettings(null, storage);
  assert.equal(later.graphicsPreset(rtx), 'chromebook', 'Auto never starts above the remembered floor');
  assert.equal(later.graphicsAutoFloor, 'chromebook');
  later.setGraphics('chromebook');
  assert.equal(later.graphicsPreset(rtx), 'chromebook');
  assert.equal(later.graphicsAutoFloor, '', 'a deliberate pick clears the floor');

  store.set('tiny-strike-settings-v1', JSON.stringify({ graphics: 'auto', graphicsAutoLow: true }));
  assert.equal(new GameSettings(null, storage).graphicsPreset(rtx), 'low', 'the older saved flag still means Low');
});

test('graphics: Auto classifies weak Chromebooks, Chromebook tablets and phones', async () => {
  const { autoGraphicsPreset } = await import('../src/gfx/profiles.js');
  const cros = (gpu, touch = false) => autoGraphicsPreset({ chromeOS: true, touch, gpu });
  assert.equal(cros('ANGLE (AMD, AMD Radeon R5 Graphics (STONEY), OpenGL ES 3.2)'), 'chromebook', 'Stoney Ridge');
  assert.equal(cros('ANGLE (Qualcomm, Adreno (TM) 618, OpenGL ES 3.2)'), 'chromebook', 'Snapdragon 7c');
  assert.equal(cros('ANGLE (AMD, AMD Radeon(TM) Graphics (renoir), OpenGL ES 3.2)'), 'high', 'Ryzen Vega');
  assert.equal(cros('ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)', true), 'chromebook', 'a Chromebook tablet is a Chromebook first');
  assert.equal(autoGraphicsPreset({ touch: true, gpu: 'ANGLE (ARM, Mali-G710, OpenGL ES 3.2)' }), 'low', 'a Mali flagship phone stays on Low');
  assert.equal(autoGraphicsPreset({ gpu: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11)' }), 'high');
  assert.equal(autoGraphicsPreset({ gpu: 'Research Graphics Adapter' }), 'high', 'no accidental "arc" match');
});

test('graphics: ChromeOS detection reads client hints, then the user agent', async () => {
  const { isChromeOS } = await import('../src/gfx/profiles.js');
  assert.equal(isChromeOS({ userAgentData: { platform: 'Chrome OS' }, userAgent: '' }), true);
  assert.equal(isChromeOS({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36' }), true);
  assert.equal(isChromeOS({ userAgentData: { platform: 'Windows' }, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), false);
});

test('movement keys work by position on any keyboard layout, labelled in that layout', async (t) => {
  installInputGlobals(t);
  const events = eventBus();
  const game = { debug: false, canvas: {}, events };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);
  game.input = input;
  // Russian layout: the W key types 'ц'.
  input._onKeyDown({ key: 'ц', code: 'KeyW', repeat: false });
  assert.equal(input.isDown('w'), true, 'W moves on a Russian keyboard');
  input._onKeyUp({ key: 'ц', code: 'KeyW' });
  assert.equal(input.isDown('w'), false);
  // AZERTY: the key in W's place types 'z' and still moves forward.
  input._onKeyDown({ key: 'z', code: 'KeyW', repeat: false });
  assert.equal(input.isDown('w'), true);
  input._onKeyUp({ key: 'z', code: 'KeyW' });
  // Labels follow the player's layout when the browser provides it.
  const { setKeyboardLayoutMap, formatKeyLabel } = await import('../src/core/settings.js');
  setKeyboardLayoutMap(new Map([['KeyW', 'z'], ['KeyA', 'q']]));
  t.after(() => setKeyboardLayoutMap(null));
  assert.equal(formatKeyLabel('w'), 'Z');
  assert.equal(formatKeyLabel('a'), 'Q');
  assert.equal(formatKeyLabel('shift'), 'SHIFT');
});

test('saved bindings that can no longer fire fall back; Caps Lock cannot be bound; ISO keys bind by position', (t) => {
  const storage = new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({
      bindingsVersion: 2,
      bindings: { moveForward: 'ц', buy: 'ö', reload: ';', jump: '[', use: 'f' },
    }),
  });
  const settings = new GameSettings(null, storage);
  assert.equal(settings.get('moveForward'), 'w', 'a layout character from before position binding falls back');
  assert.equal(settings.get('buy'), 'b');
  assert.equal(settings.get('reload'), ';', 'reachable custom keys are kept');
  assert.equal(settings.get('jump'), '[');
  assert.equal(settings.get('use'), 'f');
  assert.equal(settings.rebind('crouch', 'CapsLock').rejected, true, 'Caps Lock is refused');

  installInputGlobals(t);
  const input = new Input({ events: eventBus(), settings: new GameSettings(null, new MemoryStorage()) });
  assert.equal(input._normalizePhysicalKey({ code: 'IntlBackslash', key: '<' }), 'intlbackslash');
  assert.equal(input._normalizePhysicalKey({ code: 'IntlBackslash', key: '>' }), 'intlbackslash',
    'the same key under Shift is still the same key');
  assert.equal(formatKeyLabel('intlbackslash'), '<');
});

test('mouse: a real fast flick survives the spike filter; a lone jump out of stillness does not', (t) => {
  installInputGlobals(t);
  const input = new Input({ events: eventBus(), debug: false });
  input.locked = true;
  const move = (x) => input._onMouseMove({ movementX: x, movementY: 0 });
  // Lone spike from rest, well after locking.
  move(2400);
  assert.equal(input.consumeLook().dx, 0, 'a lone 2400-count jump is dropped');
  // A flick: ramps through frames of 300, 700, 950, 950, 600 counts.
  input._moveAt = -Infinity;
  for (const x of [300, 700, 950, 950, 600]) move(x);
  assert.equal(input.consumeLook().dx, 3500, 'every frame of the flick turns the view');
  // Right after a lock even a ramped big event is dropped (Chrome's jump).
  input._lockedAt = performance.now();
  move(300); move(900);
  assert.equal(input.consumeLook().dx, 300);
});

test('wheel: one mouse notch is one step; a trackpad swipe is a step, not a dozen', (t) => {
  installInputGlobals(t);
  const events = eventBus();
  const input = new Input({ events, debug: false });
  input.locked = true;
  const wheel = (dy) => input._onWheel({ deltaY: dy, deltaMode: 0, preventDefault() {} });
  const steps = () => events.emitted.filter((e) => e.name === 'input:wheel').length;
  wheel(100);
  assert.equal(steps(), 1, 'a notch steps once');
  for (let i = 0; i < 30; i++) wheel(10); // a 300 px two-finger swipe, back to back
  assert.ok(steps() <= 3, `a swipe takes at most a couple of steps (${steps() - 1})`);
});

test('invert look, aim sensitivity and toggle crouch persist and reset', () => {
  const storage = new MemoryStorage();
  const settings = new GameSettings(null, storage);
  assert.equal(settings.invertY, false);
  assert.equal(settings.crouchToggle, false);
  assert.equal(settings.adsSensitivity, 1);
  settings.setInvertY(true);
  settings.setCrouchToggle(true);
  assert.equal(settings.setAdsSensitivity(9), 1.5, 'clamped to its range');
  settings.setAdsSensitivity(0.7);
  const restored = new GameSettings(null, storage);
  assert.equal(restored.invertY, true);
  assert.equal(restored.crouchToggle, true);
  assert.equal(restored.adsSensitivity, 0.7);
  restored.reset();
  assert.equal(restored.invertY, false);
  assert.equal(restored.crouchToggle, false);
  assert.equal(restored.adsSensitivity, 1);
});

test('numpad + and * bindings survive a reload', () => {
  const storage = new MemoryStorage();
  const settings = new GameSettings(null, storage);
  settings.rebind('weapon4', '+');
  settings.rebind('streak1', '*');
  const restored = new GameSettings(null, storage);
  assert.equal(restored.get('weapon4'), '+');
  assert.equal(restored.get('streak1'), '*');
});

test('graphics: effects density steps down with the preset', async () => {
  const { GRAPHICS_PROFILES } = await import('../src/gfx/profiles.js');
  const { high, low, chromebook } = GRAPHICS_PROFILES;
  assert.equal(high.fxScale, 1);
  assert.ok(low.fxScale < high.fxScale && chromebook.fxScale < low.fxScale);
  assert.ok(chromebook.fxScale >= 0.25, 'effects never thin to nothing');
});
