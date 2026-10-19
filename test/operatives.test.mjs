// The third-person soldiers: the low-poly Marine with Quaternius' Universal
// Animation Library (CC0) retargeted onto it and IK-authored weapon holds
// (tools/build-operatives.mjs), driven by the layered controller in
// src/ai/operative-anim.js. These pin the contract the game relies on — clip
// names, gun seats on the right hand, one skeleton the body merge accepts —
// and that the animation does what it claims: the retarget follows its
// source, the holds put the gun on the aim line with both hands on it, the
// corpses stay down, and the runtime layering keeps the muzzle where the
// soldier is looking while the legs do something else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import Bots from '../src/ai/bots.js';
import { CONFIG } from '../src/shared/config.js';
import {
  buildAnimationSet, OperativeAnimator,
  LOCOMOTION_CLIPS, HOLD_CLIPS, DEATH_CLIPS, HIT_CLIPS, ACTION_CLIPS,
} from '../src/ai/operative-anim.js';
import { buildWeaponModel } from '../src/gfx/weapons/catalogue.js';

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

const wp = (o) => o.getWorldPosition(new THREE.Vector3());
const degreesBetween = (a, b) => Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) * 180 / Math.PI;
const GAME_SCALE = 1.83 / 1.965; // bots.js CHAR_TARGET_HEIGHT / bodyHeight

/** Pose a scene with one clip at a time (seconds). */
function pose(gltf, name, time) {
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clip = gltf.animations.find((c) => c.name === name);
  assert.ok(clip, `clip ${name}`);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(Math.min(time, clip.duration));
  gltf.scene.updateMatrixWorld(true);
  return () => { mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene); };
}

for (const file of ['assets/models/operative_us.glb', 'assets/models/operative_ru.glb']) {
  test(`${file} carries the layered clip set, hand seats and a mergeable body`, async () => {
    const gltf = await load(file);
    const names = gltf.animations.map((c) => c.name);
    for (const clip of [...LOCOMOTION_CLIPS, ...HOLD_CLIPS, ...DEATH_CLIPS, ...HIT_CLIPS]) {
      assert.ok(names.includes(clip), `missing clip ${clip}`);
    }
    const set = buildAnimationSet(gltf.animations, gltf.scene.userData);
    assert.ok(set, 'the runtime accepts the clip set');
    for (const name of ['Walk', 'Jog', 'Sprint', 'CrouchWalk']) {
      assert.ok(set.speeds[name] > 0.3 && set.speeds[name] < 8, `${name} ground speed ${set.speeds[name]}`);
    }
    assert.ok(set.speeds.CrouchWalk < set.speeds.Walk && set.speeds.Walk < set.speeds.Jog, 'gaits get faster');
    // The UAL sprint covers about the jog's ground per second (longer, slower
    // strides); the runtime speeds it up to the sprint pace, so it only has to
    // land near the jog, not above it.
    assert.ok(set.speeds.Sprint > set.speeds.Jog * 0.85, `sprint ${set.speeds.Sprint} vs jog ${set.speeds.Jog}`);
    assert.ok(set.handBasisL, 'the support-hand basis ships in the scene extras');
    // Legs and torso never fight over a bone.
    for (const name of LOCOMOTION_CLIPS) {
      for (const track of set.lower[name].tracks) assert.ok(!/^spine|^neck|^head|arm|hand|Finger|Thumb/.test(track.name), track.name);
    }
    for (const name of HOLD_CLIPS) {
      for (const track of set.upper[name].tracks) assert.ok(!/^(Hip|thigh|shin|foot|toe)/.test(track.name), track.name);
    }

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

test('the retargeted limbs point where the UAL source points them, mirrors included', async () => {
  const ual = await load('assets/models/source/ual_clips.glb');
  const marine = await load('assets/models/operative_us.glb');
  const node = (scene, name) => scene.getObjectByName(name);
  const pairs = [
    ['DEF-upper_armR', 'DEF-forearmR', 'upper_armR', 'forearmR'],
    ['DEF-forearmL', 'DEF-handL', 'forearmL', 'handL'],
    ['DEF-thighL', 'DEF-shinL', 'thighL', 'shinL'],
    ['DEF-shinR', 'DEF-footR', 'shinR', 'footR'],
  ];
  const mirror = (n) => n.replace(/L$/, '#').replace(/R$/, 'L').replace(/#$/, 'R');
  for (const [name, source, mirrored] of [
    ['Jog', 'Jog_Fwd_Loop'], ['CrouchWalk', 'Crouch_Fwd_Loop'], ['Death_A', 'Death01'], ['Death_A_M', 'Death01', true],
  ]) {
    const clip = ual.animations.find((c) => c.name === source);
    const t = Math.round(clip.duration * 0.5 * 30) / 30; // on a baked key (30 fps)
    const doneU = pose(ual, source, t);
    const doneM = pose(marine, name, t);
    for (const [a, b, c, d] of pairs) {
      const src = wp(node(ual.scene, mirrored ? mirror(b) : b)).sub(wp(node(ual.scene, mirrored ? mirror(a) : a))).normalize();
      if (mirrored) src.x = -src.x;
      const dst = wp(node(marine.scene, d)).sub(wp(node(marine.scene, c))).normalize();
      const deg = degreesBetween(src, dst);
      assert.ok(deg < 3, `${name}: ${c} is ${deg.toFixed(1)} degrees off its source`);
    }
    doneU();
    doneM();
  }
});

test('every death ends on the ground (one-shot clips must not wrap to frame 0)', async () => {
  const marine = await load('assets/models/operative_us.glb');
  for (const name of DEATH_CLIPS) {
    const clip = marine.animations.find((c) => c.name === name);
    const done = pose(marine, name, clip.duration);
    const head = wp(marine.scene.getObjectByName('head')).y;
    assert.ok(head < 0.7, `${name} leaves the head ${head.toFixed(2)} m up`);
    done();
  }
});

test('the authored holds put the bore on the aim line and both hands on the gun', async () => {
  const marine = await load('assets/models/operative_us.glb');
  const forward = new THREE.Vector3(0, 0, 1); // the Marine faces +Z
  for (const [clip, seatName, gunId] of [['Rifle_Aim', 'AK', 'm4a1'], ['Pistol_Aim', 'Pistol', 'glock']]) {
    const done = pose(marine, clip, 0);
    const seat = marine.scene.getObjectByName(seatName);
    const q = seat.getWorldQuaternion(new THREE.Quaternion());
    const bore = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    assert.ok(degreesBetween(bore, forward) < 1.5, `${clip}: bore is ${degreesBetween(bore, forward).toFixed(1)} degrees off`);
    const grip = buildWeaponModel(gunId).nodes.gripL;
    const support = new THREE.Vector3(...grip.pos).multiplyScalar(1 / GAME_SCALE).applyQuaternion(q).add(wp(seat));
    const err = support.distanceTo(wp(marine.scene.getObjectByName('handL')));
    assert.ok(err < 0.015, `${clip}: support hand ${(err * 100).toFixed(1)} cm off the grip`);
    // the stock (or the pistol) is at shoulder height, not at the hip
    assert.ok(wp(seat).y > 1.35 && wp(seat).y < 1.65, `${clip}: grip height ${wp(seat).y.toFixed(2)}`);
    done();
  }
});

test('the layered runtime keeps the muzzle on the aim line and the support hand on any rifle', async () => {
  const gltf = await load('assets/models/operative_us.glb');
  const set = buildAnimationSet(gltf.animations, gltf.scene.userData);
  const root = new THREE.Group();
  const inst = gltf.scene;
  inst.rotation.y = Math.PI; // as bots.js mounts it
  inst.scale.setScalar(GAME_SCALE);
  root.add(inst);
  root.updateMatrixWorld(true);
  const mixer = new THREE.AnimationMixer(inst);
  const animator = new OperativeAnimator(inst, mixer, set);

  // A stand-in for the held AK: same seat, same scale compensation, same data.
  const seat = inst.getObjectByName('AK');
  const weapon = new THREE.Object3D();
  weapon.userData.model = { nodes: buildWeaponModel('ak47').nodes };
  weapon.position.copy(seat.position);
  weapon.quaternion.copy(seat.quaternion);
  weapon.scale.setScalar(1 / seat.parent.getWorldScale(new THREE.Vector3()).x);
  seat.parent.add(weapon);

  const scenarios = [
    { name: 'standing', pitch: 0 },
    { name: 'aiming up', pitch: 0.45 },
    { name: 'crouched, aiming down', crouch: true, pitch: -0.35 },
    { name: 'jogging forward', vz: -4.6 },
    { name: 'strafing right', vx: 4.6 },
    { name: 'backpedalling to the right', vx: 1.2, vz: 2.2, pitch: 0.2 },
  ];
  for (const sc of scenarios) {
    animator.reset();
    root.position.set(0, 0, 0);
    const actor = {
      pos: root.position, yaw: 0, aimPitch: sc.pitch || 0, crouching: !!sc.crouch,
      onGround: true, aimBlend: 1, moveSpeed: Math.hypot(sc.vx || 0, sc.vz || 0),
    };
    for (let i = 0; i < 45; i++) {
      root.position.x += (sc.vx || 0) / 30;
      root.position.z += (sc.vz || 0) / 30;
      root.updateMatrixWorld(true);
      animator.update(actor, 1 / 30, { family: 'Rifle', weapon, ik: true, root });
    }
    root.updateMatrixWorld(true);
    // Yaw 0 looks down world -Z; pitch tips that up.
    const aim = new THREE.Vector3(0, Math.sin(actor.aimPitch), -Math.cos(actor.aimPitch));
    const bore = new THREE.Vector3(0, 0, -1).applyQuaternion(weapon.getWorldQuaternion(new THREE.Quaternion()));
    const off = degreesBetween(bore, aim);
    assert.ok(off < 4, `${sc.name}: muzzle ${off.toFixed(1)} degrees off the aim line`);
    const grip = new THREE.Vector3().fromArray(weapon.userData.model.nodes.gripL.pos).applyMatrix4(weapon.matrixWorld);
    const err = grip.distanceTo(wp(inst.getObjectByName('handL')));
    assert.ok(err < 0.015, `${sc.name}: support hand ${(err * 100).toFixed(1)} cm off the AK's handguard`);
  }
  assert.ok(animator.twist > 0.3, 'a backpedal turns the hips off the line of travel');
});

test('plant and defuse kneel, and a grenade throw winds up and releases before the hold returns', async () => {
  const gltf = await load('assets/models/operative_us.glb');
  const set = buildAnimationSet(gltf.animations, gltf.scene.userData);
  for (const name of ACTION_CLIPS) assert.ok(gltf.animations.some((c) => c.name.endsWith(name)), `missing clip ${name}`);
  assert.ok(set.lower.Kneel && set.upper.Kneel_Work && set.upper.Slash && set.upper.Lob, 'the action layers are built');
  const inst = gltf.scene;
  inst.scale.setScalar(GAME_SCALE);
  const mixer = new THREE.AnimationMixer(inst);
  const animator = new OperativeAnimator(inst, mixer, set);
  const pos = new THREE.Vector3();
  const actor = { pos, yaw: 0, aimPitch: 0, onGround: true, aimBlend: 1, moveSpeed: 0 };
  const run = (secs) => { for (let t = 0; t < secs; t += 1 / 30) animator.update(actor, 1 / 30, { family: 'Rifle', ik: false }); };
  const hipY = () => { inst.updateMatrixWorld(true); return wp(inst.getObjectByName('Hip')).y; };

  run(0.5);
  const standing = hipY();
  actor.kneeling = true;
  run(1.5);
  assert.equal(animator.lowerName, 'Kneel');
  assert.equal(animator.upperName, 'Kneel_Work');
  assert.ok(hipY() < standing - 0.3, `kneeling drops the hips (${standing.toFixed(2)} -> ${hipY().toFixed(2)})`);
  run(6); // past the clip's own stand-up: the hold ping-pongs inside the kneel
  assert.ok(hipY() < standing - 0.3, 'still on the knees after the clip length');
  actor.kneeling = false;
  run(0.6);
  assert.equal(animator.lowerName, 'Idle');

  actor.gesture = 'lob';
  const seen = [];
  for (let t = 0; t < 0.8; t += 1 / 30) {
    animator.update(actor, 1 / 30, { family: 'Rifle', ik: false });
    if (seen[seen.length - 1] !== animator.upperName) seen.push(animator.upperName);
  }
  assert.equal(actor.gesture, null, 'the gesture is consumed');
  assert.deepEqual(seen, ['Slash', 'Lob', 'Rifle_Aim']);
});
