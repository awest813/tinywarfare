import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { installBilinearShadows } from '../src/gfx/shadow-bilinear.js';

test('the Chromebook shadow filter patches only the unfiltered directional tap', () => {
  const before = THREE.ShaderChunk.shadowmap_pars_fragment;
  const fake = { ShaderChunk: { shadowmap_pars_fragment: before } };
  assert.equal(installBilinearShadows(fake), true);
  const after = fake.ShaderChunk.shadowmap_pars_fragment;
  assert.notEqual(after, before);
  assert.equal((after.match(/texture2DCompare\( shadowMap, owUv/g) || []).length, 4, 'four taps');
  assert.ok(after.includes('SHADOWMAP_TYPE_PCF_SOFT'), 'the PCF paths are untouched');
  assert.equal(installBilinearShadows(fake), true, 'idempotent');
  assert.equal(fake.ShaderChunk.shadowmap_pars_fragment, after);
  assert.equal(installBilinearShadows({ ShaderChunk: { shadowmap_pars_fragment: 'unrelated' } }), false);
});
