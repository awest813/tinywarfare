// ============================================================================
// TINY WARFARE — tools/build-operatives.mjs
//
// Builds the third-person soldier models from the low-poly Marine
// (assets/models/source/marine.glb) and the animation set of the original
// character pack (assets/models/soldier_ct.glb):
//
//   node tools/build-operatives.mjs
//     -> assets/models/operative_us.glb   (U.S. forces, the Marine's own camo)
//     -> assets/models/operative_ru.glb   (Russian forces, greener / darker)
//
// The Marine ships one 'Action' clip on its own rig; the game drives soldiers
// with the pack's 17 named clips (Idle, Walk, Run_Gun, Duck, Death, ...). Those
// are RETARGETED here:
//
//   1. Both rigs are put in a common reference pose. The pack rests in a
//      T-pose; the Marine in an A-pose, so each mapped Marine limb is swung
//      (minimal rotation) until it points where the pack's limb points.
//   2. Every frame of every pack clip is sampled; each mapped Marine bone takes
//      the pack bone's WORLD rotation times a constant correction
//      C = packRest^-1 * marineReference, so the pack's rest pose reproduces
//      the Marine's reference pose exactly. Unmapped bones (IK controls, extra
//      spine, breast, toes) keep their rest.
//   3. The pelvis translation is scaled by the ratio of hip heights.
//
// The pack's held-weapon seats (AK, SMG, Sniper, Pistol — the game hangs its
// procedural guns off them, see bots.js _attachHeldWeapon) are recreated on the
// Marine's right hand with the same hand-relative placement.
//
// The output is written by editing the Marine's own glTF JSON and binary
// chunk (new animations, new seat nodes, material tint), so its meshes,
// skin and embedded textures go out byte-for-byte. Node cannot decode the
// textures, which rules out a load-and-re-export.
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// GLTFLoader reaches for `self.URL` to stage embedded images.
globalThis.self ??= globalThis;

const ROOT = new URL('../', import.meta.url);
const SOURCE = 'assets/models/source/marine.glb';
const PACK = 'assets/models/soldier_ct.glb';
const FPS = 30;

// pack bone -> Marine bone (names as three sanitizes them: dots removed)
const BONE_MAP = {
  Body_1: 'Hip',
  Abdomen: 'spine001',
  Torso: 'spine003',
  Neck: 'neck',
  Head: 'head',
  ShoulderL: 'shoulderL', UpperArmL: 'upper_armL', LowerArmL: 'forearmL', Middle1L: 'handL',
  Middle2L: 'Finger_1L', Middle3L: 'Finger_2L', Thumb1L: 'Thumb_1L', Thumb2L: 'Thumb_2L',
  ShoulderR: 'shoulderR', UpperArmR: 'upper_armR', LowerArmR: 'forearmR', Middle1R: 'handR',
  Middle2R: 'Finger_1R', Middle3R: 'Finger_2R', Thumb1R: 'Thumb_1R', Thumb2R: 'Thumb_2R',
  UpperLegL: 'thighL', LowerLegL: 'shinL', FootL: 'footL',
  UpperLegR: 'thighR', LowerLegR: 'shinR', FootR: 'footR',
};

// Limb directions to align for the reference pose: [packBone, packTip, marineBone, marineTip]
const ALIGN = [];
for (const s of ['L', 'R']) {
  ALIGN.push(
    [`Shoulder${s}`, `UpperArm${s}`, `shoulder${s}`, `upper_arm${s}`],
    [`UpperArm${s}`, `LowerArm${s}`, `upper_arm${s}`, `forearm${s}`],
    [`LowerArm${s}`, `Middle1${s}`, `forearm${s}`, `hand${s}`],
    [`Middle1${s}`, `Middle2${s}`, `hand${s}`, `Finger_1${s}`],
    [`Middle2${s}`, `Middle3${s}`, `Finger_1${s}`, `Finger_2${s}`],
    [`Thumb1${s}`, `Thumb2${s}`, `Thumb_1${s}`, `Thumb_2${s}`],
    [`UpperLeg${s}`, `LowerLeg${s}`, `thigh${s}`, `shin${s}`],
    [`LowerLeg${s}`, `Foot${s}`, `shin${s}`, `foot${s}`],
  );
}

const SEATS = ['AK', 'SMG', 'Sniper', 'Pistol'];

// The Marine embeds two atlases: texture 0 is multicam (only the goggles use
// it as shipped), texture 1 an urban grey. Material Soldier1 is the goggles,
// Soldier2 everything else.
const GOGGLES = [0.26, 0.24, 0.22, 1]; // smoked lenses: the orange ones read as red eyes
const VARIANTS = [
  // U.S. forces: multicam.
  { file: 'assets/models/operative_us.glb', materials: {
    Soldier1: { factor: GOGGLES },
    Soldier2: { texture: 0 },
  } },
  // Russian forces: the grey atlas through a green filter, so the two sides
  // separate at a glance (the radar and name tags do the rest).
  { file: 'assets/models/operative_ru.glb', materials: {
    Soldier1: { factor: GOGGLES },
    Soldier2: { texture: 1, factor: [0.62, 0.8, 0.52, 1] },
  } },
];

// --------------------------------------------------------------------------

async function loadGltf(path) {
  const bytes = await readFile(new URL(path, ROOT));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  // Textures cannot decode in Node; the warnings are expected and harmless here.
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', resolve, reject));
  } finally {
    console.warn = warn;
  }
}

function bonesByName(scene) {
  const map = new Map();
  scene.traverse((o) => { if (o.isBone) map.set(o.name, o); });
  return map;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const worldPos = (o) => o.getWorldPosition(new THREE.Vector3());
const worldQuat = (o) => o.getWorldQuaternion(new THREE.Quaternion());

/** Set a bone's world rotation, keeping its local position. */
function setWorldQuat(bone, q) {
  const parentQ = bone.parent ? worldQuat(bone.parent) : new THREE.Quaternion();
  bone.quaternion.copy(parentQ.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

// --------------------------------------------------------------------------

const pack = await loadGltf(PACK);
const marine = await loadGltf(SOURCE);
const packBones = bonesByName(pack.scene);
const mBones = bonesByName(marine.scene);
for (const [p, m] of Object.entries(BONE_MAP)) {
  if (!packBones.has(p)) throw new Error('pack bone missing: ' + p);
  if (!mBones.has(m)) throw new Error('marine bone missing: ' + m);
}

pack.scene.updateMatrixWorld(true);
marine.scene.updateMatrixWorld(true);

// Marine rest (A-pose) locals, kept for unmapped bones.
const mRestLocal = new Map();
for (const [name, b] of mBones) mRestLocal.set(name, { p: b.position.clone(), q: b.quaternion.clone() });
const mHipRestWorld = worldPos(mBones.get('Hip'));

// 1. Reference pose: swing Marine limbs onto the pack's T-pose directions.
for (const [pb, pt, mb, mt] of ALIGN) {
  const dirP = worldPos(packBones.get(pt)).sub(worldPos(packBones.get(pb))).normalize();
  const bone = mBones.get(mb);
  const dirM = worldPos(mBones.get(mt)).sub(worldPos(bone)).normalize();
  const swing = new THREE.Quaternion().setFromUnitVectors(dirM, dirP);
  setWorldQuat(bone, swing.multiply(worldQuat(bone)));
}
marine.scene.updateMatrixWorld(true);

// Constant per-bone corrections C = packRestWorld^-1 * marineReferenceWorld.
const correction = new Map();
for (const [p, m] of Object.entries(BONE_MAP)) {
  correction.set(m, worldQuat(packBones.get(p)).invert().multiply(worldQuat(mBones.get(m))));
}
// Reference-pose locals of mapped bones (also what a seat is placed against).
const mRefWorld = new Map();
for (const m of Object.values(BONE_MAP)) mRefWorld.set(m, worldQuat(mBones.get(m)));

const packHip = packBones.get('Body_1');
const packHipRest = worldPos(packHip);
const hipScale = worldPos(mBones.get('thighL')).y / worldPos(packBones.get('UpperLegL')).y;

// Marine bones in parent-before-child order.
const order = [];
marine.scene.traverse((o) => { if (o.isBone) order.push(o); });

// 2. Retarget every pack clip.
const clips = [];
for (const clip of pack.animations) {
  const mixer = new THREE.AnimationMixer(pack.scene);
  const action = mixer.clipAction(clip);
  action.play();
  const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const times = new Float32Array(frames);
  const rot = new Map(); // marine bone -> Float32Array(frames*4)
  for (const m of Object.values(BONE_MAP)) rot.set(m, new Float32Array(frames * 4));
  const hipPos = new Float32Array(frames * 3);

  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / FPS);
    times[f] = t;
    mixer.setTime(t);
    pack.scene.updateMatrixWorld(true);

    // Rebuild the Marine pose top-down: mapped bones take the pack's world
    // rotation (corrected); everything else keeps its rest local.
    for (const bone of order) {
      const rest = mRestLocal.get(bone.name);
      bone.position.copy(rest.p);
      bone.quaternion.copy(rest.q);
      const packName = Object.keys(BONE_MAP).find((k) => BONE_MAP[k] === bone.name);
      if (bone.name === 'Hip') {
        const delta = worldPos(packHip).sub(packHipRest).multiplyScalar(hipScale);
        const want = mHipRestWorld.clone().add(delta);
        bone.parent.updateMatrixWorld(true);
        bone.position.copy(bone.parent.worldToLocal(want));
      }
      if (packName) {
        const wq = worldQuat(packBones.get(packName)).multiply(correction.get(bone.name));
        bone.parent.updateMatrixWorld(true);
        const parentQ = worldQuat(bone.parent);
        bone.quaternion.copy(parentQ.invert().multiply(wq));
      }
      bone.updateMatrixWorld(true);
    }
    for (const [m, arr] of rot) {
      const q = mBones.get(m).quaternion;
      // keep the hemisphere continuous so interpolation never takes the long way
      if (f > 0) {
        const d = arr[(f - 1) * 4] * q.x + arr[(f - 1) * 4 + 1] * q.y + arr[(f - 1) * 4 + 2] * q.z + arr[(f - 1) * 4 + 3] * q.w;
        if (d < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      }
      arr.set([q.x, q.y, q.z, q.w], f * 4);
    }
    const hp = mBones.get('Hip').position;
    hipPos.set([hp.x, hp.y, hp.z], f * 3);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(pack.scene);
  clips.push({ name: clip.name, times, rot, hipPos });
}

// Put the Marine back into the reference pose for seat placement.
for (const bone of order) {
  const rest = mRestLocal.get(bone.name);
  bone.position.copy(rest.p);
  bone.quaternion.copy(rest.q);
}
marine.scene.updateMatrixWorld(true);
for (const [m, q] of mRefWorld) setWorldQuat(mBones.get(m), q);
marine.scene.updateMatrixWorld(true);

// 3. Held-weapon seats on the right hand, same hand-relative placement as the
// pack's (which are authored on Index1R; Middle1R is the hand we mapped).
pack.scene.updateMatrixWorld(true);
const packHand = packBones.get('Middle1R');
const mHand = mBones.get('handR');
const packHandLen = worldPos(packBones.get('Middle2R')).distanceTo(worldPos(packHand));
const mHandLen = worldPos(mBones.get('Finger_1R')).distanceTo(worldPos(mHand));
const handScale = mHandLen / packHandLen;
const seats = [];
for (const name of SEATS) {
  let seat = null;
  pack.scene.traverse((o) => { if (o.name === name) seat = o; });
  if (!seat) throw new Error('pack seat missing: ' + name);
  // Seat pose relative to the pack hand, scale stripped.
  const seatWorld = new THREE.Matrix4();
  seat.matrixWorld.decompose(_p, _q, _s);
  seatWorld.compose(_p, _q, new THREE.Vector3(1, 1, 1));
  const handWorld = new THREE.Matrix4().compose(worldPos(packHand), worldQuat(packHand), new THREE.Vector3(1, 1, 1));
  const rel = handWorld.clone().invert().multiply(seatWorld);
  const relPos = new THREE.Vector3();
  const relQ = new THREE.Quaternion();
  rel.decompose(relPos, relQ, _s);
  // In the Marine hand's frame: undo the hand's correction, scale the offset.
  const cInv = correction.get('handR').clone().invert();
  const pos = relPos.multiplyScalar(handScale).applyQuaternion(cInv);
  const quat = cInv.clone().multiply(relQ);
  seats.push({ name, translation: pos.toArray(), rotation: quat.toArray() });
}

// --------------------------------------------------------------------------
// 4. Write the GLBs by editing the source glTF.

const srcBytes = await readFile(new URL(SOURCE, ROOT));
const jsonLen = srcBytes.readUInt32LE(12);
const baseJson = JSON.parse(srcBytes.subarray(20, 20 + jsonLen).toString('utf8'));
const binHeader = 20 + jsonLen;
const binLen = srcBytes.readUInt32LE(binHeader);
const baseBin = srcBytes.subarray(binHeader + 8, binHeader + 8 + binLen);

const sanitize = (name) => THREE.PropertyBinding.sanitizeNodeName(name);

function buildVariant(variant) {
  const json = JSON.parse(JSON.stringify(baseJson));
  const nodeIndex = new Map(json.nodes.map((n, i) => [sanitize(n.name), i]));
  const chunks = [];
  let offset = baseBin.length;
  const pad4 = () => { const r = offset % 4; if (r) { chunks.push(Buffer.alloc(4 - r)); offset += 4 - r; } };
  const addView = (typed) => {
    pad4();
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    chunks.push(buf);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
    offset += buf.length;
    return json.bufferViews.length - 1;
  };
  const addAccessor = (typed, type, count, minMax) => {
    const view = addView(typed);
    const acc = { bufferView: view, componentType: 5126, count, type };
    if (minMax) Object.assign(acc, minMax);
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };

  json.animations = [];
  for (const clip of clips) {
    const input = addAccessor(clip.times, 'SCALAR', clip.times.length, {
      min: [clip.times[0]], max: [clip.times[clip.times.length - 1]],
    });
    const samplers = [];
    const channels = [];
    for (const [bone, data] of clip.rot) {
      samplers.push({ input, output: addAccessor(data, 'VEC4', clip.times.length), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex.get(bone), path: 'rotation' } });
    }
    samplers.push({ input, output: addAccessor(clip.hipPos, 'VEC3', clip.times.length), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex.get('Hip'), path: 'translation' } });
    json.animations.push({ name: clip.name, samplers, channels });
  }

  const hand = json.nodes[nodeIndex.get('handR')];
  hand.children = hand.children || [];
  for (const seat of seats) {
    json.nodes.push({ name: seat.name, translation: seat.translation, rotation: seat.rotation });
    hand.children.push(json.nodes.length - 1);
  }

  for (const material of json.materials) {
    const edit = variant.materials[material.name];
    if (!edit) continue;
    const pbr = material.pbrMetallicRoughness = material.pbrMetallicRoughness || {};
    if (edit.factor) pbr.baseColorFactor = edit.factor;
    if (edit.texture !== undefined) pbr.baseColorTexture = { ...(pbr.baseColorTexture || {}), index: edit.texture };
  }
  json.asset.generator = 'tools/build-operatives.mjs (from Khronos glTF Blender I/O)';

  pad4();
  const bin = Buffer.concat([baseBin, ...chunks]);
  json.buffers[0].byteLength = bin.length;
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

const box = new THREE.Box3().setFromObject(marine.scene);
for (const variant of VARIANTS) {
  const out = buildVariant(variant);
  await writeFile(new URL(variant.file, ROOT), out);
  console.log(`${variant.file}: ${(out.length / 1024).toFixed(0)} KB, ${clips.length} clips`);
}
console.log(`body height ${box.max.y.toFixed(4)} m (use as CHAR_MODELS bodyHeight); hip scale ${hipScale.toFixed(3)}; hand scale ${handScale.toFixed(3)}`);
