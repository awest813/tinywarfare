import test from 'node:test';
import assert from 'node:assert/strict';
import Gamepads from '../src/core/gamepad.js';

function rig(phase = 'live') {
  const pad = { index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad] }, configurable: true, writable: true });
  const log = [];
  const held = new Set();
  const input = {
    locked: true,
    move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 },
    setMoveVector(x, y) { this.move = { x, y }; },
    addVirtualLook(dx, dy) { this.look.dx += dx; this.look.dy += dy; },
    setVirtualButton(b, on) { log.push(`btn${b}:${on}`); on ? held.add('btn' + b) : held.delete('btn' + b); },
    setVirtualAction(a, on) { log.push(`${a}:${on}`); on ? held.add(a) : held.delete(a); },
    pulseVirtualAction(a) { log.push(`pulse:${a}`); },
    virtualWheel(d) { log.push(`wheel:${d}`); },
    releaseLock() { log.push('pause'); },
    requestLock(o) { log.push('lock:' + JSON.stringify(o)); },
  };
  const handlers = {};
  const game = { input, state: { phase }, events: { on(n, f) { handlers[n] = f; }, emit() {} } };
  const gp = new Gamepads(game);
  const press = (i, on) => { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; };
  const step = (n = 1, dt = 1 / 60) => { for (let k = 0; k < n; k++) gp.update(dt); };
  return { pad, input, log, held, gp, press, step, handlers };
}

test('sticks: radial deadzones, forward is +y, look follows a curve', () => {
  const { pad, input, step } = rig();
  pad.axes = [0.1, -0.1, 0.08, 0.05]; // inside both deadzones
  step();
  assert.deepEqual(input.move, { x: 0, y: 0 });
  assert.equal(input.look.dx, 0);
  pad.axes = [0, -1, 1, 0];
  step();
  assert.ok(input.move.y > 0.99, 'stick up walks forward');
  const full = input.look.dx;
  assert.ok(full > 20 && full < 30, `full deflection ~24 px a 60 Hz frame (${full})`);
  input.look.dx = 0;
  pad.axes = [0, 0, 0.5, 0];
  step();
  assert.ok(input.look.dx < full * 0.35, 'half deflection turns well under half speed');
});

test('triggers fire and aim; X taps reload but holds for Use; L3 sprint latches until the stick returns', () => {
  const { pad, log, held, press, step } = rig();
  press(7, true); press(6, true); step();
  assert.ok(held.has('btn0') && held.has('btn2'));
  press(7, false); press(6, false); step();
  assert.ok(!held.has('btn0') && !held.has('btn2'));

  press(2, true); step(5); press(2, false); step();
  assert.ok(log.includes('pulse:reload'), 'a tap reloads');
  assert.ok(!log.includes('use:true'));
  log.length = 0;
  press(2, true); step(30);
  assert.ok(held.has('use'), 'a hold is Use (plant / defuse)');
  press(2, false); step();
  assert.ok(!held.has('use') && !log.includes('pulse:reload'), 'and does not also reload');

  pad.axes = [0, -1, 0, 0];
  press(10, true); step(); press(10, false); step(10);
  assert.ok(held.has('sprint'), 'L3 latches sprint while pushing forward');
  pad.axes = [0, 0, 0, 0]; step();
  assert.ok(!held.has('sprint'), 'and lets go when the stick returns');
});

test('Start pauses; everything held is released on unlock; Start in a paused match relocks', () => {
  const { input, log, held, press, step, handlers } = rig();
  press(0, true); press(7, true); step();
  assert.ok(held.has('jump') && held.has('btn0'));
  press(0, false); press(7, false); press(9, true); step();
  assert.ok(log.includes('pause'));
  press(9, false); step();
  input.locked = false;
  handlers['input:unlock']();
  press(1, true); step();
  assert.equal(held.size, 0, 'nothing is held while unlocked');
  press(1, false); press(9, true); step();
  assert.ok(log.some((l) => l.startsWith('lock:')), 'Start resumes');
});
