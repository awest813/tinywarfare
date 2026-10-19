// ============================================================================
// TINY WARFARE — tools/build-operatives.mjs
//
// Builds the third-person soldiers from the low-poly Marine
// (assets/models/source/marine.glb):
//
//   node tools/build-operatives.mjs
//     -> assets/models/operative_us.glb   (U.S. forces, multicam)
//     -> assets/models/operative_ru.glb   (Russian forces, greener / darker)
//
// THE ANIMATION SET is built in three parts, for a layered runtime controller
// (src/ai/bots.js) that runs the legs and the torso separately:
//
//   1. LOCOMOTION, HITS, DEATHS — retargeted from Quaternius' Universal
//      Animation Library (CC0; trimmed copy in assets/models/source/
//      ual_clips.glb, see tools/extract-ual.mjs) plus the old character pack's
//      Death (assets/models/soldier_ct.glb). Both deaths are also MIRRORED.
//
//      Retargeting: each mapped Marine limb is first swung (minimal rotation)
//      onto the source's T-pose direction; then, per frame, a Marine bone takes
//      the source bone's WORLD rotation times the constant correction
//      C = sourceRest^-1 * marineReference. The pelvis translation is scaled by
//      the ratio of hip heights.
//
//   2. WEAPON HOLDS — authored here by inverse kinematics, because no free pack
//      holds a rifle the way ours are built. Every gun in src/gfx/weapons shares
//      one convention (origin at the web of the shooting hand, bore down -Z)
//      and publishes where each hand goes (nodes.gripR / gripL: wrist position,
//      finger direction, back-of-hand direction). So a pose is just "where is
//      the gun": the right hand follows from the weapon seat, the left wrist is
//      solved onto the support grip, both elbows by two-bone IK.
//
//        Rifle_Aim     stock in the shoulder pocket, bladed stance, cheek weld
//        Rifle_Ready   low ready: muzzle down and in, for moving out of contact
//        Rifle_Sprint  across the chest, muzzle up-left
//        Rifle_Reload  cant, strip the mag, pouch, seat, back on the handguard
//        Pistol_Aim / Pistol_Ready / Pistol_Reload   two-handed equivalents
//
//      The holds are full-body clips (legs at idle) so they preview on their
//      own; the runtime uses only their upper-body tracks.
//
//   3. WEAPON SEATS — nodes AK / SMG / Sniper / Pistol on the right hand, in OUR
//      weapon convention (no axis fix needed at runtime): the hand frame comes
//      from the weapon's own gripR data, the origin sits at the Marine's web of
//      the thumb.
//
// Locomotion ground speeds (measured off the planted foot) and the hands'
// local finger/back basis go into the scene's extras for the runtime.
//
// The output is written by editing the Marine's own glTF JSON and binary
// chunk (new animations, new seat nodes, material tint), so its meshes,
// skin and embedded textures go out byte-for-byte. Node cannot decode the
// textures, which rules out a load-and-re-export.
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildWeaponModel } from '../src/gfx/weapons/catalogue.js';

// GLTFLoader reaches for `self.URL` to stage embedded images.
globalThis.self ??= globalThis;

const ROOT = new URL('../', import.meta.url);
const SOURCE = 'assets/models/source/marine.glb';
const UAL = 'assets/models/source/ual_clips.glb';
const PACK = 'assets/models/soldier_ct.glb';
const FPS = 30;

// bots.js scales the 1.965 m Marine to 1.83 m. Guns are parented at true size,
// so in the Marine's own units a gun is 1/GAME_SCALE larger.
const BODY_HEIGHT = 1.965;
const GAME_SCALE = 1.83 / BODY_HEIGHT;
const K = 1 / GAME_SCALE;

// Every Marine bone a clip writes. A clip must write all of them: the mixer
// leaves an unwritten bone wherever the last clip put it.
const ANIMATED = ['Hip', 'spine001', 'spine002', 'spine003', 'neck', 'head'];
for (const s of ['L', 'R']) {
  ANIMATED.push(`shoulder${s}`, `upper_arm${s}`, `forearm${s}`, `hand${s}`,
    `Finger_1${s}`, `Finger_2${s}`, `Thumb${s}`, `Thumb_1${s}`, `Thumb_2${s}`,
    `thigh${s}`, `shin${s}`, `foot${s}`, `toe${s}`);
}

// --------------------------------------------------------------------------
// Sources

const UAL_MAP = {
  'DEF-hips': 'Hip', 'DEF-spine001': 'spine001', 'DEF-spine002': 'spine002',
  'DEF-spine003': 'spine003', 'DEF-neck': 'neck', 'DEF-head': 'head',
};
const UAL_ALIGN = [];
for (const s of ['L', 'R']) {
  Object.assign(UAL_MAP, {
    [`DEF-shoulder${s}`]: `shoulder${s}`, [`DEF-upper_arm${s}`]: `upper_arm${s}`,
    [`DEF-forearm${s}`]: `forearm${s}`, [`DEF-hand${s}`]: `hand${s}`,
    [`DEF-f_middle01${s}`]: `Finger_1${s}`, [`DEF-f_middle02${s}`]: `Finger_2${s}`,
    [`DEF-thumb01${s}`]: `Thumb${s}`, [`DEF-thumb02${s}`]: `Thumb_1${s}`, [`DEF-thumb03${s}`]: `Thumb_2${s}`,
    [`DEF-thigh${s}`]: `thigh${s}`, [`DEF-shin${s}`]: `shin${s}`,
    [`DEF-foot${s}`]: `foot${s}`, [`DEF-toe${s}`]: `toe${s}`,
  });
  UAL_ALIGN.push(
    [`DEF-shoulder${s}`, `DEF-upper_arm${s}`, `shoulder${s}`, `upper_arm${s}`],
    [`DEF-upper_arm${s}`, `DEF-forearm${s}`, `upper_arm${s}`, `forearm${s}`],
    [`DEF-forearm${s}`, `DEF-hand${s}`, `forearm${s}`, `hand${s}`],
    [`DEF-hand${s}`, `DEF-f_middle01${s}`, `hand${s}`, `Finger_1${s}`],
    [`DEF-f_middle01${s}`, `DEF-f_middle02${s}`, `Finger_1${s}`, `Finger_2${s}`],
    [`DEF-thumb01${s}`, `DEF-thumb02${s}`, `Thumb${s}`, `Thumb_1${s}`],
    [`DEF-thumb02${s}`, `DEF-thumb03${s}`, `Thumb_1${s}`, `Thumb_2${s}`],
    [`DEF-thigh${s}`, `DEF-shin${s}`, `thigh${s}`, `shin${s}`],
    [`DEF-shin${s}`, `DEF-foot${s}`, `shin${s}`, `foot${s}`],
    [`DEF-foot${s}`, `DEF-toe${s}`, `foot${s}`, `toe${s}`],
  );
}

const PACK_MAP = {
  Body_1: 'Hip', Abdomen: 'spine001', Torso: 'spine003', Neck: 'neck', Head: 'head',
};
const PACK_ALIGN = [];
for (const s of ['L', 'R']) {
  Object.assign(PACK_MAP, {
    [`Shoulder${s}`]: `shoulder${s}`, [`UpperArm${s}`]: `upper_arm${s}`,
    [`LowerArm${s}`]: `forearm${s}`, [`Middle1${s}`]: `hand${s}`,
    [`Middle2${s}`]: `Finger_1${s}`, [`Middle3${s}`]: `Finger_2${s}`,
    [`Thumb1${s}`]: `Thumb_1${s}`, [`Thumb2${s}`]: `Thumb_2${s}`,
    [`UpperLeg${s}`]: `thigh${s}`, [`LowerLeg${s}`]: `shin${s}`, [`Foot${s}`]: `foot${s}`,
  });
  PACK_ALIGN.push(
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

// [output name, source, source clip, mirrored]
const RETARGET = [
  ['Idle', 'ual', 'Idle_Loop'],
  ['Walk', 'ual', 'Walk_Loop'],
  ['Jog', 'ual', 'Jog_Fwd_Loop'],
  ['Sprint', 'ual', 'Sprint_Loop'],
  ['CrouchIdle', 'ual', 'Crouch_Idle_Loop'],
  ['CrouchWalk', 'ual', 'Crouch_Fwd_Loop'],
  ['JumpLoop', 'ual', 'Jump_Loop'],
  ['HitChest', 'ual', 'Hit_Chest'],
  ['HitHead', 'ual', 'Hit_Head'],
  ['Death_A', 'ual', 'Death01'],
  ['Death_A_M', 'ual', 'Death01', true],
  ['Death_B', 'pack', 'Death'],
  ['Death_B_M', 'pack', 'Death', true],
];
const LOCOMOTION = ['Walk', 'Jog', 'Sprint', 'CrouchWalk'];

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
// Math helpers

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const AX = { X: V(1, 0, 0), Y: V(0, 1, 0), Z: V(0, 0, 1) };
const qAxis = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(
  typeof axis === 'string' ? AX[axis] : axis.clone().normalize(), deg * Math.PI / 180);
/** Product of axis rotations, applied right to left: qChain(['Y',50],['X',-30]) = Ry*Rx. */
const qChain = (...steps) => steps.reduce((q, [a, d]) => q.multiply(qAxis(a, d)), new THREE.Quaternion());
const worldPos = (o) => o.getWorldPosition(new THREE.Vector3());
const worldQuat = (o) => o.getWorldQuaternion(new THREE.Quaternion());
const reflectX = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
const mirrorName = (n) => (n.endsWith('L') ? n.slice(0, -1) + 'R' : n.endsWith('R') ? n.slice(0, -1) + 'L' : n);

/** Rotation taking +X to `f` and +Y to `b` (orthogonalised against f). */
function basisQuat(f, b) {
  const fx = f.clone().normalize();
  const by = b.clone().sub(fx.clone().multiplyScalar(b.dot(fx))).normalize();
  const bz = new THREE.Vector3().crossVectors(fx, by);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fx, by, bz));
}

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

function nodesByName(scene) {
  const map = new Map();
  scene.traverse((o) => { if (!map.has(o.name)) map.set(o.name, o); });
  return map;
}

// --------------------------------------------------------------------------
// The Marine

const marine = await loadGltf(SOURCE);
const mBones = new Map();
marine.scene.traverse((o) => { if (o.isBone) mBones.set(o.name, o); });
for (const name of ANIMATED) if (!mBones.has(name)) throw new Error('marine bone missing: ' + name);
const B = (name) => mBones.get(name);
const order = [];
marine.scene.traverse((o) => { if (o.isBone) order.push(o); });
marine.scene.updateMatrixWorld(true);

const mRestLocal = new Map();
for (const [name, b] of mBones) mRestLocal.set(name, { p: b.position.clone(), q: b.quaternion.clone() });
const mHipRestWorld = worldPos(B('Hip'));

function refresh() { marine.scene.updateMatrixWorld(true); }
function resetMarine() {
  for (const bone of order) {
    const rest = mRestLocal.get(bone.name);
    bone.position.copy(rest.p);
    bone.quaternion.copy(rest.q);
  }
  refresh();
}
/** Set a bone's world rotation, keeping its local position. */
function setWorldQuat(bone, q) {
  bone.parent.updateMatrixWorld(true);
  bone.quaternion.copy(worldQuat(bone.parent).invert().multiply(q));
  bone.updateMatrixWorld(true);
}
/** Rotate a bone (and everything it carries) about a world axis through its pivot. */
function rotateWorld(bone, axis, deg) {
  setWorldQuat(bone, qAxis(axis, deg).multiply(worldQuat(bone)));
}

// --------------------------------------------------------------------------
// Sources and the retarget

async function prepareSource(path, map, align, hip, thigh) {
  const gltf = await loadGltf(path);
  const nodes = nodesByName(gltf.scene);
  for (const [s, m] of Object.entries(map)) {
    if (!nodes.has(s)) throw new Error(`${path}: bone missing: ${s}`);
    if (!mBones.has(m)) throw new Error('marine bone missing: ' + m);
  }
  gltf.scene.updateMatrixWorld(true);
  // Reference pose: swing Marine limbs onto the source's T-pose directions.
  resetMarine();
  for (const [sb, st, mb, mt] of align) {
    const dirS = worldPos(nodes.get(st)).sub(worldPos(nodes.get(sb))).normalize();
    const bone = B(mb);
    const dirM = worldPos(B(mt)).sub(worldPos(bone)).normalize();
    setWorldQuat(bone, new THREE.Quaternion().setFromUnitVectors(dirM, dirS).multiply(worldQuat(bone)));
  }
  refresh();
  const correction = new Map();
  const mirrorFix = new Map();
  for (const [s, m] of Object.entries(map)) {
    const rest = worldQuat(nodes.get(s));
    correction.set(m, rest.clone().invert().multiply(worldQuat(B(m))));
    // Mirrored playback uses reflect(world of the opposite bone). For a rig
    // whose two sides are exact mirror images this fix is the identity;
    // carrying it keeps the mirrored rest pose exact even when bone rolls differ.
    mirrorFix.set(s, reflectX(worldQuat(nodes.get(mirrorName(s)))).invert().multiply(rest));
  }
  const byMarine = new Map(Object.entries(map).map(([s, m]) => [m, s]));
  const hipNode = nodes.get(hip);
  const hipScale = worldPos(B('thighL')).y / worldPos(nodes.get(thigh)).y;
  resetMarine();
  return { gltf, nodes, map, correction, mirrorFix, byMarine, hipNode, hipRest: worldPos(hipNode), hipScale };
}

const sources = {
  ual: await prepareSource(UAL, UAL_MAP, UAL_ALIGN, 'DEF-hips', 'DEF-thighL'),
  pack: await prepareSource(PACK, PACK_MAP, PACK_ALIGN, 'Body_1', 'UpperLegL'),
};

function findClip(src, name) {
  const clip = src.gltf.animations.find((c) => c.name.split('|').pop() === name);
  if (!clip) throw new Error('source clip missing: ' + name);
  return clip;
}

/** World rotations of the source's mapped bones at one instant (+ pelvis offset). */
function sampleSource(src, mixer, t, mirror) {
  mixer.setTime(t);
  src.gltf.scene.updateMatrixWorld(true);
  const world = new Map();
  for (const s of Object.keys(src.map)) {
    if (mirror) world.set(s, reflectX(worldQuat(src.nodes.get(mirrorName(s)))).multiply(src.mirrorFix.get(s)));
    else world.set(s, worldQuat(src.nodes.get(s)));
  }
  const delta = worldPos(src.hipNode).sub(src.hipRest).multiplyScalar(src.hipScale);
  if (mirror) delta.x = -delta.x;
  return { world, delta };
}

const _m = new THREE.Matrix4();
/** Pose the Marine from a source sample; unmapped bones hold their rest. */
function poseMarine(src, sample) {
  for (const bone of order) {
    const rest = mRestLocal.get(bone.name);
    bone.position.copy(rest.p);
    bone.quaternion.copy(rest.q);
    const parentWorld = bone.parent.matrixWorld;
    if (bone.name === 'Hip') {
      const want = mHipRestWorld.clone().add(sample.delta);
      bone.position.copy(want.applyMatrix4(_m.copy(parentWorld).invert()));
    }
    const s = src.byMarine.get(bone.name);
    if (s) {
      const wq = sample.world.get(s).clone().multiply(src.correction.get(bone.name));
      const parentQ = new THREE.Quaternion().setFromRotationMatrix(parentWorld);
      bone.quaternion.copy(parentQ.invert().multiply(wq));
    }
    bone.updateMatrix();
    bone.matrixWorld.multiplyMatrices(parentWorld, bone.matrix);
  }
}

// Skinned meshes of the Marine, and its floor: the lowest skinned point at rest.
const SKINNED = [];
marine.scene.traverse((o) => { if (o.isSkinnedMesh) SKINNED.push(o); });
const _vtx = new THREE.Vector3();
function lowestSkinnedY() {
  let min = Infinity;
  for (const mesh of SKINNED) {
    const count = mesh.geometry.attributes.position.count;
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, _vtx);
      _vtx.applyMatrix4(mesh.matrixWorld);
      if (_vtx.y < min) min = _vtx.y;
    }
  }
  return min;
}
let FLOOR_Y = null;
/** Lift the pelvis so no part of the posed body is below the rest floor. */
function groundFit() {
  if (FLOOR_Y === null) {
    const keep = snapshot();
    resetMarine();
    FLOOR_Y = lowestSkinnedY();
    applySnapshot(keep);
  }
  const dip = FLOOR_Y - lowestSkinnedY();
  if (!(dip > 1e-4)) return;
  const hip = B('Hip');
  const target = worldPos(hip).add(new THREE.Vector3(0, dip, 0));
  hip.parent.updateMatrixWorld(true);
  hip.position.copy(hip.parent.worldToLocal(target));
  refresh();
}

function snapshot() {
  const q = new Map();
  for (const name of ANIMATED) q.set(name, B(name).quaternion.clone());
  return { q, hip: B('Hip').position.clone() };
}
function applySnapshot(snap) {
  resetMarine();
  for (const [name, q] of snap.q) B(name).quaternion.copy(q);
  B('Hip').position.copy(snap.hip);
  refresh();
}

/** Pack frames into a clip record, keeping quaternion hemispheres continuous. */
function makeClip(name, times, frames) {
  const rot = new Map();
  for (const bone of ANIMATED) {
    const arr = new Float32Array(frames.length * 4);
    for (let f = 0; f < frames.length; f++) {
      const q = frames[f].q.get(bone).clone();
      if (f > 0) {
        const o = (f - 1) * 4;
        if (arr[o] * q.x + arr[o + 1] * q.y + arr[o + 2] * q.z + arr[o + 3] * q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      }
      arr.set([q.x, q.y, q.z, q.w], f * 4);
    }
    rot.set(bone, arr);
  }
  const hipPos = new Float32Array(frames.length * 3);
  frames.forEach((fr, f) => hipPos.set(fr.hip.toArray(), f * 3));
  return { name, times: Float32Array.from(times), rot, hipPos };
}

const clips = [];
const speeds = {};
for (const [name, srcKey, clipName, mirror] of RETARGET) {
  const src = sources[srcKey];
  const clip = findClip(src, clipName);
  const mixer = new THREE.AnimationMixer(src.gltf.scene);
  // Play once and clamp: a looping action wraps setTime(duration) back to the
  // first frame, which stood every corpse back up on the last key of a death.
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const count = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const times = [];
  const frames = [];
  const feet = [];
  for (let f = 0; f < count; f++) {
    const t = Math.min(clip.duration, f / FPS);
    times.push(t);
    poseMarine(src, sampleSource(src, mixer, t, !!mirror));
    // Deaths keep the body above the floor: retargeted onto the Marine (whose
    // backpack the source rigs lack) Death01 ended 0.26 m into the ground.
    if (name.startsWith('Death')) groundFit();
    frames.push(snapshot());
    feet.push([worldPos(B('footL')), worldPos(B('footR'))]);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(src.gltf.scene);
  clips.push(makeClip(name, times, frames));

  if (LOCOMOTION.includes(name)) {
    // Ground speed: a foot on the ground (within 6 cm of its lowest point in
    // the cycle) slides backward at the speed the body travels. Counting every
    // backward frame of the lower foot, flight and swing included, read the
    // jog at 3.4 m/s against its real 5.5, and the soldiers' feet skated.
    const lowest = [0, 1].map((k) => Math.min(...feet.map((pair) => pair[k].y)));
    const planted = 0.06 / GAME_SCALE;
    // Per foot: the retarget leaves one foot's contact less clean than the
    // other's (the Sprint's right foot rolls onto its toe early and reads 30%
    // slow), so the faster, cleaner stance is the body's speed.
    const perFoot = [0, 1].map((k) => {
      let dist = 0;
      let dur = 0;
      for (let f = 1; f < count; f++) {
        if (feet[f][k].y > lowest[k] + planted || feet[f - 1][k].y > lowest[k] + planted) continue;
        const dz = feet[f][k].z - feet[f - 1][k].z;
        if (dz >= 0) continue;
        dist -= dz;
        dur += times[f] - times[f - 1];
      }
      return dur > 0 ? dist / dur : 0;
    });
    speeds[name] = +(Math.max(...perFoot) * GAME_SCALE).toFixed(3); // in-game m/s
  }
}

// --------------------------------------------------------------------------
// Weapon holds

const GUN = {
  rifle: buildWeaponModel('m4a1').nodes,
  smg: buildWeaponModel('mp5').nodes,
  sniper: buildWeaponModel('awp').nodes,
  pistol: buildWeaponModel('glock').nodes,
};
const gripBasis = (g) => basisQuat(V(...g.finger), V(...g.back));

// Authoring base: the UAL idle's first frame, pelvis square at rest.
resetMarine();
{
  const src = sources.ual;
  const mixer = new THREE.AnimationMixer(src.gltf.scene);
  mixer.clipAction(findClip(src, 'Idle_Loop')).play();
  poseMarine(src, sampleSource(src, mixer, 0, false));
  mixer.stopAllAction();
}
B('Hip').position.copy(mRestLocal.get('Hip').p);
B('Hip').quaternion.copy(mRestLocal.get('Hip').q);
refresh();
const BASE = snapshot();
const baseChest = worldQuat(B('spine003'));

// Hand-local frames: +X along the fingers, +Y out of the back of the hand.
function handFrame(side) {
  const hand = B(`hand${side}`);
  const toLocal = (p) => hand.worldToLocal(p.clone());
  const f = toLocal(worldPos(B(`Finger_1${side}`))).normalize();
  const t = toLocal(worldPos(B(`Thumb_1${side}`))).normalize();
  const b = side === 'R' ? new THREE.Vector3().crossVectors(f, t) : new THREE.Vector3().crossVectors(t, f);
  const basis = basisQuat(f, b);
  // The web of the thumb, a little into the palm: where a grip's origin sits.
  const web = toLocal(worldPos(B(`Thumb_1${side}`)).lerp(worldPos(B(`Finger_1${side}`)), 0.5))
    .addScaledVector(b.normalize(), -0.012);
  return { basis, web, f, b };
}
const HAND = { R: handFrame('R'), L: handFrame('L') };

/** The right hand's seat for a gun family: gun pose in hand-local space. */
function seatFor(grip) {
  return { q: HAND.R.basis.clone().multiply(gripBasis(grip).invert()), p: HAND.R.web.clone() };
}
const SEAT_DEF = {
  AK: seatFor(GUN.rifle.gripR),
  SMG: seatFor(GUN.smg.gripR),
  Sniper: seatFor(GUN.sniper.gripR),
  Pistol: seatFor(GUN.pistol.gripR),
};

function solveTwoBone(upper, lower, end, target, poleDir) {
  refresh();
  const a = worldPos(upper);
  const l1 = a.distanceTo(worldPos(lower));
  const l2 = worldPos(lower).distanceTo(worldPos(end));
  const d = target.clone().sub(a);
  const dist = THREE.MathUtils.clamp(d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-4);
  const dir = d.normalize();
  const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const pole = poleDir.clone().sub(dir.clone().multiplyScalar(poleDir.dot(dir))).normalize();
  const elbow = a.clone().addScaledVector(dir, x).addScaledVector(pole, h);
  const swing = (bone, tip, want) => {
    const from = worldPos(tip).sub(worldPos(bone)).normalize();
    const to = want.clone().sub(worldPos(bone)).normalize();
    setWorldQuat(bone, new THREE.Quaternion().setFromUnitVectors(from, to).multiply(worldQuat(bone)));
  };
  swing(upper, lower, elbow);
  swing(lower, end, a.clone().addScaledVector(dir, dist));
}

/** Curl a hand's fingers toward the palm (degrees per joint). */
function curl(side, deg1, deg2, thumb = 0) {
  const hq = worldQuat(B(`hand${side}`));
  const f = HAND[side].f.clone().applyQuaternion(hq);
  const b = HAND[side].b.clone().applyQuaternion(hq);
  const axis = new THREE.Vector3().crossVectors(f, b.negate()).normalize();
  rotateWorld(B(`Finger_1${side}`), axis, deg1);
  rotateWorld(B(`Finger_2${side}`), axis, deg2);
  if (thumb) rotateWorld(B(`Thumb_1${side}`), axis, thumb);
}

const chestDelta = () => worldQuat(B('spine003')).multiply(baseChest.clone().invert());
/** Right-shoulder pocket the stock sits in, following the chest. */
const pocket = () => worldPos(B('upper_armR')).add(V(0.065, -0.07, 0.12).applyQuaternion(chestDelta()));
const BUTT = V(0, 0.04, 0.26).multiplyScalar(K); // stock butt in gun space (average long gun)
const buttedGun = (q, at) => ({ q, p: at.clone().sub(BUTT.clone().applyQuaternion(q)) });

/** Put both hands on a gun posed at {q, p} (Marine space, our weapon convention). */
function holdGun(gun, family, opts = {}) {
  const seat = SEAT_DEF[family === 'pistol' ? 'Pistol' : 'AK'];
  const grip = family === 'pistol' ? GUN.pistol : GUN.rifle;
  const chest = chestDelta();
  // Right hand: the seat fixes the hand from the gun.
  const handRQ = gun.q.clone().multiply(seat.q.clone().invert());
  const handRP = gun.p.clone().sub(seat.p.clone().applyQuaternion(handRQ));
  solveTwoBone(B('upper_armR'), B('forearmR'), B('handR'), handRP, opts.poleR.clone().applyQuaternion(chest));
  setWorldQuat(B('handR'), handRQ);
  curl('R', 62, 55, 18);
  // Left hand: on the support grip, or at an explicit {p, q} target.
  const left = opts.left || {
    p: gun.p.clone().add(V(...grip.gripL.pos).multiplyScalar(K).applyQuaternion(gun.q)),
    q: gun.q.clone().multiply(gripBasis(grip.gripL)).multiply(HAND.L.basis.clone().invert()),
  };
  solveTwoBone(B('upper_armL'), B('forearmL'), B('handL'), left.p, opts.poleL.clone().applyQuaternion(chest));
  setWorldQuat(B('handL'), left.q);
  curl('L', opts.curlL ?? 48, 40, 10);
}

function torso(steps) {
  for (const [bone, axis, deg] of steps) rotateWorld(B(bone), axis, deg);
}

// Stances, applied on the base pose.
// The Marine's arms are short for real-size rifles, so the support shoulder is
// brought forward (blade + protraction) until an AK's handguard — the longest
// reach in the rack — is inside it with the elbow still bent.
const BLADED = [
  ['spine001', 'Y', -10], ['spine002', 'Y', -10], ['spine003', 'Y', -10],
  ['spine002', 'X', 5], ['spine003', 'X', 3], ['shoulderL', 'Y', -16],
  ['neck', 'Y', 16], ['head', 'Y', 13], ['head', 'Z', 7], ['head', 'X', 7],
];
const EASY = [
  ['spine001', 'Y', -8], ['spine002', 'Y', -8], ['spine003', 'Y', -7],
  ['spine002', 'X', 3], ['shoulderL', 'Y', -12], ['neck', 'Y', 12], ['head', 'Y', 10],
];
const SQUARE = [['spine002', 'X', 4], ['spine003', 'X', 2], ['head', 'X', 4]];
const RIFLE_POLES = { poleR: V(-0.75, -0.65, -0.1), poleL: V(0.35, -1, -0.15) };
const PISTOL_POLES = { poleR: V(-0.55, -1, -0.15), poleL: V(0.55, -1, -0.15) };

const ease = (t) => t * t * (3 - 2 * t);

/** A static hold: two identical keys one second apart. */
function staticHold(name, build) {
  applySnapshot(BASE);
  build();
  refresh();
  const snap = snapshot();
  clips.push(makeClip(name, [0, 1], [snap, snap]));
}

const rifleAim = () => buttedGun(qChain(['Y', 180]), pocket());
const rifleReady = () => buttedGun(qChain(['Y', 14], ['X', 28], ['Y', 180]), pocket().add(V(0.02, -0.06, -0.07)));
const pistolAim = () => ({ q: qChain(['Y', 180]), p: V(-0.045, 1.5, 0.4) });
const pistolReady = () => ({ q: qChain(['X', 38], ['Y', 180]), p: V(-0.06, 1.27, 0.27) });

staticHold('Rifle_Aim', () => { torso(BLADED); holdGun(rifleAim(), 'rifle', RIFLE_POLES); });
staticHold('Rifle_Ready', () => { torso(EASY); holdGun(rifleReady(), 'rifle', RIFLE_POLES); });
staticHold('Rifle_Sprint', () => {
  torso([['spine003', 'Y', 6], ['head', 'Y', -4]]);
  holdGun({ q: qChain(['Y', 52], ['X', -38], ['Z', -18], ['Y', 180]), p: V(-0.15, 1.16, 0.2) }, 'rifle',
    { poleR: V(-0.6, -0.8, -0.7), poleL: V(0.8, -0.7, 0) });
});
staticHold('Pistol_Aim', () => { torso(SQUARE); holdGun(pistolAim(), 'pistol', PISTOL_POLES); });
staticHold('Pistol_Ready', () => { torso(SQUARE); holdGun(pistolReady(), 'pistol', PISTOL_POLES); });

/**
 * A reload: the gun eases between its hold and a canted "work" position while
 * the support hand runs a path of gun-space (or body-space) targets. One
 * second long; the runtime stretches it to the weapon's reload time.
 */
function reloadClip(name, family, stance, holdPose, workPose, path, poles) {
  const grip = family === 'pistol' ? GUN.pistol : GUN.rifle;
  const times = [];
  const frames = [];
  const grab = basisQuat(V(0.2, 0.55, -0.8), V(-0.9, 0.3, 0));
  for (let f = 0; f <= FPS; f++) {
    const u = f / FPS;
    let i = 0;
    while (i < path.length - 2 && u > path[i + 1].u) i++;
    const k0 = path[i];
    const k1 = path[i + 1];
    const w = ease(THREE.MathUtils.clamp((u - k0.u) / (k1.u - k0.u), 0, 1));
    applySnapshot(BASE);
    torso(stance);
    const hold = holdPose();
    const work = workPose(hold);
    const gunW = k0.gun + (k1.gun - k0.gun) * w;
    const gun = { q: hold.q.clone().slerp(work.q, gunW), p: hold.p.clone().lerp(work.p, gunW) };
    const target = (key) => {
      if (key.at === 'grip') {
        return {
          p: gun.p.clone().add(V(...grip.gripL.pos).multiplyScalar(K).applyQuaternion(gun.q)),
          q: gun.q.clone().multiply(gripBasis(grip.gripL)).multiply(HAND.L.basis.clone().invert()),
        };
      }
      const p = key.body
        ? key.body.clone()
        : gun.p.clone().add(key.at.clone().multiplyScalar(K).applyQuaternion(gun.q));
      return { p, q: gun.q.clone().multiply(grab).multiply(HAND.L.basis.clone().invert()) };
    };
    const a = target(k0);
    const b = target(k1);
    holdGun(gun, family, { ...poles, curlL: 60, left: { p: a.p.lerp(b.p, w), q: a.q.slerp(b.q, w) } });
    refresh();
    times.push(u);
    frames.push(snapshot());
  }
  clips.push(makeClip(name, times, frames));
}

const MAG = V(-0.05, -0.16, 0.0);
const MAG_OUT = V(-0.05, -0.36, 0.03);
reloadClip('Rifle_Reload', 'rifle', EASY, rifleAim,
  (hold) => ({ q: qChain(['Y', 18], ['X', 16], ['Z', 32]).multiply(hold.q), p: hold.p.clone().add(V(0.05, -0.1, -0.05)) }),
  [
    { u: 0, gun: 0, at: 'grip' },
    { u: 0.12, gun: 1, at: 'grip' },
    { u: 0.26, gun: 1, at: MAG },
    { u: 0.4, gun: 1, at: MAG_OUT },
    { u: 0.52, gun: 1, body: V(0.16, 1.06, 0.15) },
    { u: 0.66, gun: 1, at: MAG_OUT },
    { u: 0.78, gun: 1, at: MAG },
    { u: 0.9, gun: 0.5, at: 'grip' },
    { u: 1, gun: 0, at: 'grip' },
  ], RIFLE_POLES);
reloadClip('Pistol_Reload', 'pistol', SQUARE, pistolReady,
  (hold) => ({ q: qChain(['X', -30], ['Z', 25]).multiply(hold.q), p: hold.p.clone().add(V(0.02, 0.08, -0.04)) }),
  [
    { u: 0, gun: 0, at: 'grip' },
    { u: 0.15, gun: 1, at: 'grip' },
    { u: 0.3, gun: 1, at: V(-0.04, -0.13, 0.07) },
    { u: 0.45, gun: 1, body: V(0.15, 1.08, 0.14) },
    { u: 0.62, gun: 1, at: V(-0.04, -0.3, 0.07) },
    { u: 0.76, gun: 1, at: V(-0.04, -0.13, 0.07) },
    { u: 0.9, gun: 0.4, at: 'grip' },
    { u: 1, gun: 0, at: 'grip' },
  ], PISTOL_POLES);

// --------------------------------------------------------------------------
// 4. Write the GLBs by editing the source glTF.

resetMarine();
const box = new THREE.Box3().setFromObject(marine.scene);
if (Math.abs(box.max.y - BODY_HEIGHT) > 0.01) {
  throw new Error(`body height ${box.max.y.toFixed(4)} != BODY_HEIGHT ${BODY_HEIGHT}; update it here and in bots.js`);
}

const META = {
  // in-game m/s each locomotion clip covers at timeScale 1
  speeds,
  // hand-local finger (+X) / back-of-hand (+Y) frames, for runtime hand IK
  handBasis: { L: HAND.L.basis.toArray(), R: HAND.R.basis.toArray() },
};

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
  for (const [name, seat] of Object.entries(SEAT_DEF)) {
    json.nodes.push({ name, translation: seat.p.toArray(), rotation: seat.q.toArray() });
    hand.children.push(json.nodes.length - 1);
  }

  for (const material of json.materials) {
    const edit = variant.materials[material.name];
    if (!edit) continue;
    const pbr = material.pbrMetallicRoughness = material.pbrMetallicRoughness || {};
    if (edit.factor) pbr.baseColorFactor = edit.factor;
    if (edit.texture !== undefined) pbr.baseColorTexture = { ...(pbr.baseColorTexture || {}), index: edit.texture };
  }
  const scene = json.scenes[json.scene || 0];
  scene.extras = { ...(scene.extras || {}), tinywarfare: META };
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

for (const variant of VARIANTS) {
  const out = buildVariant(variant);
  await writeFile(new URL(variant.file, ROOT), out);
  console.log(`${variant.file}: ${(out.length / 1024).toFixed(0)} KB, ${clips.length} clips`);
}
console.log('clips:', clips.map((c) => c.name).join(' '));
console.log('locomotion speeds (m/s):', JSON.stringify(speeds));
console.log(`hip scale ual ${sources.ual.hipScale.toFixed(3)}, pack ${sources.pack.hipScale.toFixed(3)}`);
