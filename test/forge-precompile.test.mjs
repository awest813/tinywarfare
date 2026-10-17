// The surface bake programs compile side by side before the map build when
// the driver supports parallel compiles, into the same kind of target the
// bakes draw into (so their program keys match), and not at all without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { TextureForge } from '../src/gfx/materials/generator.js';
import { LIBRARY } from '../src/gfx/materials/library.js';

function fakeRenderer(parallel) {
  const calls = [];
  let target = null;
  return {
    calls,
    capabilities: { getMaxAnisotropy: () => 8 },
    extensions: { has: (name) => parallel && name === 'KHR_parallel_shader_compile' },
    getRenderTarget: () => target,
    setRenderTarget: (t) => { target = t; },
    compileAsync(scene) {
      const materials = [];
      scene.traverse((o) => { if (o.material) materials.push(o.material); });
      calls.push({ materials, target });
      return Promise.resolve(scene);
    },
  };
}

test('every surface program is compiled in one parallel batch, into a render target', async () => {
  const renderer = fakeRenderer(true);
  const forge = new TextureForge(renderer, {});
  const surfaces = Object.entries(LIBRARY).map(([key, def]) => [key, def.glsl]);
  assert.equal(await forge.precompile(surfaces), true);
  assert.equal(renderer.calls.length, 1);
  const { materials, target } = renderer.calls[0];
  assert.ok(target && target.isWebGLRenderTarget, 'compiled for an off-screen target, like the bakes');
  assert.equal(new Set(materials).size, surfaces.length + 3, 'every surface, plus detail, macro and Sobel');
  assert.equal(renderer.getRenderTarget(), null, 'the previous target is restored');
  // The bake reuses the very material that was compiled.
  assert.ok(materials.includes(forge._material(surfaces[0][0], surfaces[0][1])));
  assert.ok(materials.every((m) => m instanceof THREE.ShaderMaterial));
});

test('without parallel compiles nothing is compiled ahead', async () => {
  const renderer = fakeRenderer(false);
  const forge = new TextureForge(renderer, {});
  assert.equal(await forge.precompile([['concrete', LIBRARY.concrete.glsl]]), false);
  assert.equal(renderer.calls.length, 0);
});
