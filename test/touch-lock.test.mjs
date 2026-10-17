// Gameplay focus on touch devices: the automatic lock ends with play, any
// unlock during play is a pause, latches drop with the inputs, punctuation
// binds hold under Shift, and a departed remote is not a live target.
import test from 'node:test';
import assert from 'node:assert/strict';

import Input from '../src/core/input.js';
import GameSettings from '../src/core/settings.js';
import TouchControls from '../src/core/touch-controls.js';
import Multiplayer from '../src/network/multiplayer.js';

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { (this.listeners.get(name) || this.listeners.set(name, []).get(name)).push(fn); }
  removeEventListener() {}
  dispatch(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event); }
}

function rig(t, { phase = 'live' } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new Target();
  globalThis.document = Object.assign(new Target(), { visibilityState: 'visible', pointerLockElement: null });
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  const handlers = new Map();
  const log = [];
  const events = {
    on(name, fn) { (handlers.get(name) || handlers.set(name, []).get(name)).push(fn); },
    off() {},
    emit(name, data) { log.push(name); for (const fn of handlers.get(name) || []) fn(data); },
  };
  const canvas = { requestPointerLock() {} };
  const game = { debug: false, canvas, events, state: { phase }, hud: {}, player: { alive: true } };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);
  game.input = input;
  input.setTouchMode(true);
  const el = () => ({
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, toggleAttribute() {},
    querySelectorAll() { return []; }, style: {},
  });
  const tc = Object.create(TouchControls.prototype);
  Object.assign(tc, {
    game, enabled: true, root: el(), _el: { crouch: el(), scope: el() }, _landscape: true, _active: false,
    _modal: false, _scoreOpen: false, _crouched: false, _aiming: false, _pointerReleases: [], _lastWeapon: '',
    _paused: false, _syncOrientation() {},
  });
  // As TouchControls._bind wires them.
  events.on('input:lock', () => { tc._paused = false; });
  events.on('input:unlock', () => tc._onUnlock());
  return { game, input, tc, canvas, log };
}

test('the automatic touch lock ends with play, so menu fields take keys again', (t) => {
  const { game, input, tc } = rig(t);
  tc.update();
  assert.equal(input.locked, true, 'play takes gameplay focus');
  game.state.phase = 'gameEnd';
  tc.update();
  assert.equal(input.locked, false, 'the end screen has no lock');
  let prevented = false;
  input._onKeyDown({ key: 'w', code: 'KeyW', preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'W types into the callsign field');
});

test('Escape out of a real lock during play pauses instead of re-locking next frame', (t) => {
  const { input, tc, canvas, log } = rig(t);
  tc.update();
  input._onMouseDown({ button: 0, target: canvas, sourceCapabilities: { firesTouchEvents: false } });
  document.pointerLockElement = canvas;
  document.dispatch('pointerlockchange');
  assert.equal(input._virtualLock, false, 'a trackpad click upgraded to a real lock');
  document.pointerLockElement = null;
  document.dispatch('pointerlockchange');
  tc.update();
  assert.equal(input.locked, false, 'still unlocked a frame later: the pause overlay shows');
  assert.equal(tc._paused, true);
  assert.equal(log.filter((n) => n === 'input:lock').length, 1);
});

test('pausing drops the crouch and aim latches with the held inputs', (t) => {
  const { input, tc } = rig(t);
  tc.update();
  tc._setCrouch(true);
  tc._setAim(true);
  assert.equal(input.isDown('control'), true);
  tc._paused = true;
  input.releaseLock();                 // the pause button
  assert.equal(tc._crouched, false);
  assert.equal(tc._aiming, false);
  input.requestLock();                 // resume
  tc._setCrouch(!tc._crouched);        // one tap crouches
  assert.equal(input.isDown('control'), true);
});

test('a key bound to punctuation holds and releases under Shift (sprint)', (t) => {
  const { game, input } = rig(t);
  input.setTouchMode(false);
  assert.equal(game.settings.rebind('moveRight', ';').changed, true);
  const press = (type, key, code, shiftKey) => input[type === 'down' ? '_onKeyDown' : '_onKeyUp']({ key, code, shiftKey, preventDefault() {} });
  input.locked = true;
  press('down', ';', 'Semicolon', false);
  assert.equal(input.isDown('d'), true);
  press('down', 'Shift', 'ShiftLeft', true);
  press('up', ':', 'Semicolon', true);   // released while Shift is down
  assert.equal(input.isDown('d'), false, 'no stuck strafe');
  press('down', ':', 'Semicolon', true); // pressed while sprinting
  assert.equal(input.isDown('d'), true);
});

test('a remote who leaves the room is no longer a live target', () => {
  const remote = { networkId: 'p', alive: true, mesh: null };
  const mp = Object.create(Multiplayer.prototype);
  Object.assign(mp, {
    active: false, mode: 'humans', roster: [{ id: 'p' }], remotePlayers: [remote],
    _remoteById: new Map([['p', remote]]), _destroyRemoteVisual() {},
    game: { state: { round: 1 }, hud: null, events: { emit() {} } },
  });
  mp._removeRemote('p');
  assert.equal(mp.remotePlayers.length, 0);
  assert.equal(remote.alive, false, 'a bot holding this target drops it');
});
