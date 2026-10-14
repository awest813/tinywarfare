// The third-person soldiers: the low-poly Marine with the pack's animation set
// retargeted onto it (tools/build-operatives.mjs). These pin the contract the
// game relies on — clip names, gun seats on the right hand, one skeleton that
// the body merge accepts — and that the retarget actually follows the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import Bots from '../src/ai/bots.js';
import { CONFIG } from '../src/shared/config.js';

globalThis.self ??= globalThis; // GLTFLoader stages embedded images via self.URL

async function load(path) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const warn = console.warn;
  console.warn = () => {}; // textures do not decode in Node
  try {
    return await new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', resolve, reject));
  } finally {
    console.warn = warn;
  }
}

const REQUIRED_CLIPS = ['Idle', 'Idle_Shoot', 'Walk', 'Walk_Shoot', 'Run_Gun', 'Run_Shoot', 'Duck', 'Death', 'HitReact', 'Jump'];

for (const file of ['assets/models/operative_us.glb', 'assets/models/operative_ru.glb']) {
  test(`${file} carries the full clip set, hand seats and a mergeable body`, async () => {
    const gltf = await load(file);
    const names = gltf.animations.map((c) => c.name);
    for (const clip of REQUIRED_CLIPS) assert.ok(names.includes(clip), `missing clip ${clip}`);

    for (const seat of ['AK', 'SMG', 'Sniper', 'Pistol']) {
      const node = gltf.scene.getObjectByName(seat);
      assert.ok(node, `seat ${seat}`);
      assert.equal(node.parent.name, 'handR', `${seat} hangs off the right hand`);
    }

    const visuals = Object.assign(Object.create(Bots.prototype), {
      game: { materials: {} },
      _charAssets: { ct: null, t: null },
      _externalActors: new Set(),
      all: [],
      _cfg: CONFIG.BOT,
      time: 0,
    });
    assert.equal(visuals._optimizeCharacterAsset('ct', gltf.scene), true, 'the body merge accepts the asset');
    let tris = 0;
    gltf.scene.traverse((o) => { if (o.isMesh) tris += o.geometry.index.count / 3; });
    assert.ok(tris > 800 && tris < 4000, `low-poly body (${tris} triangles)`);
  });
}

test('the retargeted limbs point where the source animation points them', async () => {
  const pack = await load('assets/models/soldier_ct.glb');
  const marine = await load('assets/models/operative_us.glb');
  const bones = (scene) => { const m = new Map(); scene.traverse((o) => { if (o.isBone) m.set(o.name, o); }); return m; };
  const pb = bones(pack.scene);
  const mb = bones(marine.scene);
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  const pairs = [
    ['UpperArmR', 'LowerArmR', 'upper_armR', 'forearmR'],
    ['LowerArmL', 'Middle1L', 'forearmL', 'handL'],
    ['UpperLegL', 'LowerLegL', 'thighL', 'shinL'],
    ['LowerLegR', 'FootR', 'shinR', 'footR'],
  ];
  for (const name of ['Run_Gun', 'Duck', 'Death']) {
    const pm = new THREE.AnimationMixer(pack.scene);
    const mm = new THREE.AnimationMixer(marine.scene);
    const pc = pack.animations.find((c) => c.name === name);
    pm.clipAction(pc).play();
    mm.clipAction(marine.animations.find((c) => c.name === name)).play();
    pm.setTime(pc.duration * 0.5);
    mm.setTime(pc.duration * 0.5);
    pack.scene.updateMatrixWorld(true);
    marine.scene.updateMatrixWorld(true);
    for (const [a, b, c, d] of pairs) {
      const src = wp(pb.get(b)).sub(wp(pb.get(a))).normalize();
      const dst = wp(mb.get(d)).sub(wp(mb.get(c))).normalize();
      const degrees = Math.acos(Math.min(1, src.dot(dst))) * 180 / Math.PI;
      assert.ok(degrees < 3, `${name}: ${c} is ${degrees.toFixed(1)} degrees off its source`);
    }
    pm.stopAllAction();
    mm.stopAllAction();
  }
});
