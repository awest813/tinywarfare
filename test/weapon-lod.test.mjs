// Distant third-person guns swap to a box silhouette (src/gfx/weapons/lod.js).
// A merged rifle is ~30k triangles and is drawn again into the shadow map;
// past 15 m that is a few dozen pixels. These tests pin the stand-in: one
// mesh, a few dozen triangles, the same bounds as the gun it replaces, and
// the distance rule that shows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { buildWeaponObject, buildWeaponSilhouette, collapseWeaponObject } from '../src/gfx/weapons/build.js';
import { WeaponMaterials } from '../src/gfx/weapons/materials.js';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from '../src/gfx/weapons/catalogue.js';
import { weaponProxy } from '../src/gfx/weapons/registry.js';
import { weaponLodMode, WEAPON_LOD_IN, WEAPON_LOD_OUT } from '../src/gfx/weapons/lod.js';
import { bakeMasks, setMask } from '../src/gfx/materials/masks.js';
import Bots from '../src/ai/bots.js';

function stubLibrary() {
  const cache = new Map();
  return {
    get(name, opts = {}) {
      const key = `${name}|${JSON.stringify(opts)}`;
      let m = cache.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ name: key });
        cache.set(key, m);
      }
      return m;
    },
    bakeMasks: (geo, opts) => bakeMasks(geo, opts),
    setMask: (geo, opts) => setMask(geo, opts),
  };
}

function meshes(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}

function triangles(root) {
  let n = 0;
  for (const mesh of meshes(root)) {
    const geo = mesh.geometry;
    const idx = geo.getIndex();
    n += (idx ? idx.count : geo.getAttribute('position').count) / 3;
  }
  return n;
}

function bounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let any = false;
  root.traverse((o) => {
    if (!o.isMesh) return;
    any = true;
    box.union(new THREE.Box3().setFromObject(o));
  });
  return any ? box : null;
}

test('every gun has a silhouette of a few dozen triangles and the same bulk', () => {
  for (const id of PROCEDURAL_WEAPON_IDS) {
    const mats = new WeaponMaterials(stubLibrary());
    const full = buildWeaponObject(buildWeaponModel(id), mats, { viewmodel: false });
    const merged = collapseWeaponObject(full, mats);
    const proxy = buildWeaponSilhouette(merged, mats);
    assert.ok(proxy, id);
    assert.equal(meshes(proxy).length, 1, `${id} silhouette is one draw`);
    const tris = triangles(proxy);
    assert.ok(tris <= 48 && tris >= 12, `${id} silhouette is ${tris} triangles`);
    assert.ok(tris < merged.userData.tris / 50, `${id} silhouette is not a second copy of the gun`);

    const src = bounds(merged);
    const dst = bounds(proxy);
    const srcSize = src.getSize(new THREE.Vector3());
    const dstSize = dst.getSize(new THREE.Vector3());
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(Math.abs(srcSize[axis] - dstSize[axis]) < 0.02,
        `${id} ${axis} extent ${dstSize[axis].toFixed(3)} vs gun ${srcSize[axis].toFixed(3)}`);
    }
    // The stand-in occupies the gun's own box, so the swap does not slide it.
    assert.ok(src.min.distanceTo(dst.min) < 0.02 && src.max.distanceTo(dst.max) < 0.02, id);
  }
});

test('silhouette clones share geometry, and a viewmodel is never the stand-in', () => {
  const lib = stubLibrary();
  const a = weaponProxy('m4a1', lib, { castShadow: true });
  const b = weaponProxy('m4a1', lib, { castShadow: false });
  assert.equal(meshes(a)[0].geometry, meshes(b)[0].geometry);
  assert.equal(meshes(a)[0].castShadow, true);
  assert.equal(meshes(b)[0].castShadow, false);
  assert.equal(weaponProxy('knife', lib), null);
});

test('the silhouette takes over past 15 m and the gun returns inside 12 m', () => {
  assert.equal(weaponLodMode('near', (WEAPON_LOD_OUT - 0.1) ** 2, true), 'near');
  assert.equal(weaponLodMode('near', (WEAPON_LOD_OUT + 0.1) ** 2, true), 'far');
  // Between the two distances a gun that has already swapped stays swapped.
  assert.equal(weaponLodMode('far', ((WEAPON_LOD_IN + WEAPON_LOD_OUT) / 2) ** 2, true), 'far');
  assert.equal(weaponLodMode('far', (WEAPON_LOD_IN - 0.1) ** 2, true), 'near');
  assert.equal(weaponLodMode('far', 0, false), 'near');

  const bots = Object.create(Bots.prototype);
  const detail = { visible: true };
  const proxy = { visible: false };
  const bot = { heldWeapon: detail, heldWeaponProxy: proxy, _weaponLod: 'near' };
  bots._applyWeaponLod(bot, 8 * 8, false);
  assert.equal(detail.visible, true);
  assert.equal(proxy.visible, false);
  bots._applyWeaponLod(bot, 20 * 20, false);
  assert.equal(detail.visible, false);
  assert.equal(proxy.visible, true);
  bots._applyWeaponLod(bot, 13 * 13, false);
  assert.equal(proxy.visible, true, '13 m stays on the silhouette');
  bots._applyWeaponLod(bot, 13 * 13, true);
  assert.equal(detail.visible, false);
  assert.equal(proxy.visible, false, 'a grenade lob stows both');
  bots._applyWeaponLod(bot, 13 * 13, false);
  assert.equal(proxy.visible, true, 'the lob remembers which gun was showing');
  bots._applyWeaponLod(bot, 5 * 5, false);
  assert.equal(detail.visible, true);
  assert.equal(proxy.visible, false);
});
