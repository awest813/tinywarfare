import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTO_GRAPHICS_SLOW_SECONDS, createAutoGraphics } from '../src/gfx/auto-graphics.js';

function rig({ graphics = 'auto', hasSsao = true, preset = 'high', pixelsLeft = true } = {}) {
  const calls = [];
  const game = { gfxPreset: preset, fps: 60, state: { phase: 'live' } };
  const settings = { graphics };
  let ssao = hasSsao;
  const auto = createAutoGraphics(game, settings, {
    disableSsao: () => { calls.push('ssao'); const had = ssao; ssao = false; return had; },
    capPixelRatio: () => { calls.push('pixels'); return pixelsLeft; },
    rememberFloor: (floor) => calls.push(floor),
    notify: (text) => calls.push('notice:' + text),
  });
  // One reading per second (each a fresh value, as a real reading is).
  let tick = 0;
  const seconds = (fps, n) => { for (let i = 0; i < n; i++) { game.fps = fps + (++tick) * 1e-6; auto.update(); } };
  return { game, auto, calls, seconds };
}

test('a slow match steps graphics down one stage at a time', () => {
  const { calls, seconds } = rig();
  seconds(25, AUTO_GRAPHICS_SLOW_SECONDS - 1);
  assert.deepEqual(calls, [], 'not before enough slow seconds');
  seconds(25, 1);
  assert.deepEqual(calls.filter((c) => !c.startsWith('notice')), ['ssao']);
  seconds(25, AUTO_GRAPHICS_SLOW_SECONDS);
  assert.deepEqual(calls.filter((c) => !c.startsWith('notice')), ['ssao', 'pixels']);
  seconds(25, AUTO_GRAPHICS_SLOW_SECONDS);
  assert.deepEqual(calls.filter((c) => !c.startsWith('notice')), ['ssao', 'pixels', 'low']);
  seconds(25, AUTO_GRAPHICS_SLOW_SECONDS * 3);
  assert.equal(calls.filter((c) => !c.startsWith('notice')).length, 3, 'and then stops');
});

test('a fast device, a menu, or a pinned setting never steps down', () => {
  const fast = rig();
  fast.seconds(70, 30);
  assert.deepEqual(fast.calls, []);
  const menu = rig();
  menu.game.state.phase = 'menu';
  menu.seconds(20, 30);
  assert.deepEqual(menu.calls, []);
  const pinned = rig({ graphics: 'high' });
  pinned.seconds(20, 30);
  assert.deepEqual(pinned.calls, []);
  // A dip shorter than the window resets.
  const dip = rig();
  dip.seconds(25, AUTO_GRAPHICS_SLOW_SECONDS - 1);
  dip.seconds(60, 1);
  dip.seconds(25, AUTO_GRAPHICS_SLOW_SECONDS - 1);
  assert.deepEqual(dip.calls, []);
});

test('without ambient occlusion to drop, the first step lowers the resolution', () => {
  const { calls, seconds } = rig({ hasSsao: false });
  seconds(25, AUTO_GRAPHICS_SLOW_SECONDS);
  assert.deepEqual(calls.filter((c) => !c.startsWith('notice')), ['ssao', 'pixels']);
});

test('a slow device on Low is remembered for the Chromebook preset; Chromebook is the floor', () => {
  const low = rig({ preset: 'low', hasSsao: false, pixelsLeft: false });
  low.seconds(25, AUTO_GRAPHICS_SLOW_SECONDS);
  assert.deepEqual(low.calls.filter((c) => !c.startsWith('notice')), ['ssao', 'pixels', 'chromebook']);
  assert.ok(low.calls.includes('notice:NEXT TIME THE GAME STARTS ON LOW POWER GRAPHICS'));
  const bottom = rig({ preset: 'chromebook' });
  bottom.seconds(10, 60);
  assert.deepEqual(bottom.calls, []);
});
