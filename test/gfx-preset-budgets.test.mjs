// The lighter presets' per-pixel budgets: parallax steps and range, effect
// light slots, and the frame-rate cap setting.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRAPHICS_PROFILES } from '../src/gfx/profiles.js';
import { applyParallaxBudget } from '../src/gfx/materials/index.js';
import { LIBRARY } from '../src/gfx/materials/library.js';
import { DEFAULT_PARAMS } from '../src/gfx/materials/shader.js';

test('parallax is capped and shortened on the lighter presets, untouched on High', () => {
  const brick = () => ({ ...DEFAULT_PARAMS, ...LIBRARY.brick.mat });
  const params = (gfx) => applyParallaxBudget(brick(), gfx.parallaxSteps, gfx.parallaxRange);
  const high = params(GRAPHICS_PROFILES.high);
  const medium = params(GRAPHICS_PROFILES.medium);
  const low = params(GRAPHICS_PROFILES.low);
  assert.equal(high.parallaxLayers, 24);
  assert.deepEqual(high.parallaxFade, brick().parallaxFade);
  assert.equal(medium.parallaxLayers, 12);
  assert.equal(low.parallaxLayers, 8);
  assert.ok(medium.parallaxFade[1] < high.parallaxFade[1] && low.parallaxFade[1] < medium.parallaxFade[1]);
  assert.ok(low.parallax > 0, 'Low keeps the effect up close');
  const flat = applyParallaxBudget({ parallax: 0, parallaxLayers: 22, parallaxFade: [6, 14] }, 8, 0.5);
  assert.deepEqual(flat.parallaxFade, [6, 14], 'a surface without parallax is left alone');
});

test('lighter presets share one effect light and redraw shadows every other frame', () => {
  const { high, medium, low } = GRAPHICS_PROFILES;
  assert.equal(high.fxLightSlots, 5);
  assert.equal(medium.fxLightSlots, 3);
  assert.equal(low.fxLightSlots, 3);
  assert.equal(high.shadowInterval, 1);
  assert.equal(medium.shadowInterval, 2);
  assert.equal(medium.postAa, 'fxaa');
});

test('frame-rate cap: none by default, only listed values, saved and reset', async () => {
  const { default: GameSettings, FPS_CAP_OPTIONS } = await import('../src/core/settings.js');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const settings = new GameSettings(null, storage);
  assert.deepEqual(FPS_CAP_OPTIONS, [0, 30, 60, 120]);
  assert.equal(settings.fpsCap, 0);
  assert.equal(settings.setFpsCap('60'), 60);
  assert.equal(new GameSettings(null, storage).fpsCap, 60);
  assert.equal(settings.setFpsCap(45), 0, 'an unlisted value is no cap');
  settings.setFpsCap(30);
  settings.reset();
  assert.equal(settings.fpsCap, 0);
});
