// ============================================================================
// TINY WARFARE — layered soldier animation.
//
// The operatives' GLBs (tools/build-operatives.mjs) carry three kinds of clip:
//
//   locomotion   Idle Walk Jog Sprint CrouchIdle CrouchWalk JumpLoop
//                (Quaternius UAL, CC0, retargeted onto the Marine)
//   weapon holds Rifle_* / Pistol_* Aim, Ready, Sprint, Reload (authored by IK
//                against the real guns' grip data)
//   reactions    HitChest HitHead, Death_A / _B and their mirrors
//   actions      Kneel (plant / defuse), Slash (knife), Lob (grenade release)
//                (UAL again; optional, older GLBs simply go without)
//
// A soldier plays one locomotion clip on the LEGS and one hold on the TORSO at
// the same time — the clips are split by bone at load — and then a few cheap
// procedural passes make it read like a shooter instead of a mannequin:
//
//   strafe     the pelvis turns toward the direction of travel (or away from it,
//              backpedalling with the walk cycle reversed) while the spine turns
//              the same amount back, so the gun stays on the aim line
//   stabilise  the torso cancels most of the clip's own pelvis sway, so a rifle
//              held on a crouching or running body still points where it should
//   aim pitch  split over two spine joints; the gun goes with the chest
//   recoil     a kick on the upper spine from fireAnim
//   flinch     an additive torso-only hit clip on damage
//   hand IK    the support hand is solved onto the held weapon's own gripL every
//              frame, so an AK's longer handguard gets the hand where it belongs
//
// Everything here is per-actor state; the clips themselves are shared per team
// asset (buildAnimationSet runs once per GLB).
// ============================================================================
import * as THREE from 'three';

export const LOCOMOTION_CLIPS = ['Idle', 'Walk', 'Jog', 'Sprint', 'CrouchIdle', 'CrouchWalk', 'JumpLoop'];
export const HOLD_CLIPS = [
  'Rifle_Aim', 'Rifle_Ready', 'Rifle_Sprint', 'Rifle_Reload',
  'Pistol_Aim', 'Pistol_Ready', 'Pistol_Reload',
];
export const DEATH_CLIPS = ['Death_A', 'Death_A_M', 'Death_B', 'Death_B_M'];
export const HIT_CLIPS = ['HitChest', 'HitHead'];
export const ACTION_CLIPS = ['Kneel', 'Slash', 'Lob'];

// The kneel is a 5 s clip that stands up at both ends; the working stretch in
// the middle ping-pongs for as long as the plant or defuse lasts.
const KNEEL_HOLD = [0.2, 0.7];
// Gestures play a window of their clip over the torso: [start, end] as
// fractions of the clip, and how long that window takes on screen.
const GESTURES = {
  slash: [{ clip: 'Slash', from: 0.15, to: 0.6, secs: 0.34 }],
  // Wind up on the slash's raised arm, then release with the mirrored lob.
  lob: [
    { clip: 'Slash', from: 0.2, to: 0.2, secs: 0.16 },
    { clip: 'Lob', from: 0, to: 0.6, secs: 0.36 },
  ],
};

const LOWER_BONES = new Set([
  'Hip', 'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR',
]);
const TORSO_BONES = new Set(['spine001', 'spine002', 'spine003', 'neck', 'head']);

// Ground speed (in-game m/s) each locomotion clip covers at timeScale 1.
// The GLB's measured values override these.
const DEFAULT_SPEEDS = { Walk: 1.1, Jog: 5.6, Sprint: 5.4, CrouchWalk: 0.66 };

const DEG = Math.PI / 180;
const MAX_TWIST = 70 * DEG;
const RECOIL_PITCH = { Rifle: 5 * DEG, Pistol: 9 * DEG };
export const IK_FAR_SQ = 28 * 28; // beyond this the support hand keeps the authored pose

const boneOf = (trackName) => trackName.slice(0, trackName.lastIndexOf('.'));

function filterClip(clip, keep, name = clip.name) {
  return new THREE.AnimationClip(name, clip.duration, clip.tracks.filter((t) => keep(boneOf(t.name))));
}

function gripBasis(grip) {
  const f = new THREE.Vector3().fromArray(grip.finger).normalize();
  const b = new THREE.Vector3().fromArray(grip.back);
  b.addScaledVector(f, -b.dot(f)).normalize();
  const z = new THREE.Vector3().crossVectors(f, b);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f, b, z));
}

/**
 * Split a team asset's clips into the layers, once. Returns null when the GLB
 * predates the layered set (the caller keeps its whole-clip fallback).
 */
export function buildAnimationSet(clips, userData = {}) {
  const byName = new Map();
  for (const clip of clips || []) byName.set(clip.name.split('|').pop(), clip);
  const required = [...LOCOMOTION_CLIPS, ...HOLD_CLIPS, 'Death_A'];
  if (!required.every((name) => byName.has(name))) return null;

  const set = { lower: {}, upper: {}, death: {}, hit: {}, speeds: { ...DEFAULT_SPEEDS }, phases: {}, handBasisL: null };
  for (const name of LOCOMOTION_CLIPS) set.lower[name] = filterClip(byName.get(name), (b) => LOWER_BONES.has(b));
  for (const name of HOLD_CLIPS) set.upper[name] = filterClip(byName.get(name), (b) => !LOWER_BONES.has(b));
  for (const name of DEATH_CLIPS) if (byName.has(name)) set.death[name] = byName.get(name);
  for (const name of HIT_CLIPS) {
    if (!byName.has(name)) continue;
    const torso = filterClip(byName.get(name), (b) => TORSO_BONES.has(b), `${name}_add`);
    set.hit[name] = THREE.AnimationUtils.makeClipAdditive(torso, 0);
  }
  if (byName.has('Kneel')) {
    const clip = byName.get('Kneel');
    const fps = 30;
    const hold = THREE.AnimationUtils.subclip(clip, 'KneelHold',
      Math.round(KNEEL_HOLD[0] * clip.duration * fps), Math.round(KNEEL_HOLD[1] * clip.duration * fps), fps);
    set.lower.Kneel = filterClip(hold, (b) => LOWER_BONES.has(b), 'Kneel');
    set.upper.Kneel_Work = filterClip(hold, (b) => !LOWER_BONES.has(b), 'Kneel_Work');
  }
  for (const name of ['Slash', 'Lob']) {
    if (byName.has(name)) set.upper[name] = filterClip(byName.get(name), (b) => !LOWER_BONES.has(b));
  }
  const meta = userData && userData.tinywarfare;
  if (meta && meta.speeds) Object.assign(set.speeds, meta.speeds);
  if (meta && meta.phases) Object.assign(set.phases, meta.phases);
  if (meta && meta.handBasis && Array.isArray(meta.handBasis.L)) {
    set.handBasisL = new THREE.Quaternion().fromArray(meta.handBasis.L);
  }
  return set;
}

// scratch
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _qe = new THREE.Quaternion();
const _qT = new THREE.Quaternion();
const _qHalf = new THREE.Quaternion();
const _qId = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);

/** Rotate `bone` by `r` expressed in model space, given its parent's model rotation. */
function rotateInModel(bone, parentModel, r) {
  _qa.copy(parentModel).invert().multiply(r).multiply(parentModel);
  bone.quaternion.premultiply(_qa);
}

export class OperativeAnimator {
  /**
   * @param {THREE.Object3D} rig     the cloned operative (mixer root)
   * @param {THREE.AnimationMixer} mixer
   * @param {object} set             from buildAnimationSet
   */
  constructor(rig, mixer, set) {
    this.rig = rig;
    this.mixer = mixer;
    this.set = set;
    const bone = (name) => rig.getObjectByName(name) || null;
    this.bones = {
      hip: bone('Hip'), s1: bone('spine001'), s2: bone('spine002'), s3: bone('spine003'),
      upperL: bone('upper_armL'), foreL: bone('forearmL'), handL: bone('handL'),
    };
    this.procedural = Object.values(this.bones).every(Boolean);
    /**
     * The clip pose of every bone the procedural passes rotate, captured before
     * they run and put back before the next mixer update. three's mixer only
     * writes a bone whose sampled value CHANGED since its last write, so on a
     * static hold it would never overwrite our edits and they would compound
     * frame over frame.
     */
    this.touched = this.procedural ? Object.values(this.bones) : [];
    this.clipPose = this.touched.map(() => new THREE.Quaternion());
    this.poseDirty = false;
    // The pelvis's parent chain is static (Root and the armature node), so its
    // model-space rotation is a constant.
    this.parentModel = new THREE.Quaternion();
    this.hipRestModel = new THREE.Quaternion();
    if (this.procedural) {
      const chain = [];
      for (let n = this.bones.hip.parent; n && n !== rig; n = n.parent) chain.unshift(n);
      for (const n of chain) this.parentModel.multiply(n.quaternion);
      this.hipRestModel.copy(this.parentModel).multiply(this.bones.hip.quaternion);
    }

    this.actions = {};
    const make = (clip, opts = {}) => {
      const action = mixer.clipAction(clip);
      if (opts.once) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = !!opts.clamp;
      }
      if (opts.additive) action.blendMode = THREE.AdditiveAnimationBlendMode;
      this.actions[clip.name] = action;
      return action;
    };
    for (const clip of Object.values(set.lower)) make(clip);
    for (const clip of Object.values(set.upper)) make(clip, clip.name.endsWith('_Reload') ? { once: true, clamp: true } : {});
    for (const name of ['Kneel', 'Kneel_Work']) this.actions[name]?.setLoop(THREE.LoopPingPong, Infinity);
    for (const clip of Object.values(set.death)) make(clip, { once: true, clamp: true });
    this.hitActions = {};
    for (const [name, clip] of Object.entries(set.hit)) this.hitActions[name] = make(clip, { once: true, additive: true });
    this.deathAction = null;
    this.reset();
  }

  _restoreClipPose() {
    if (!this.poseDirty) return;
    for (let i = 0; i < this.touched.length; i++) this.touched[i].quaternion.copy(this.clipPose[i]);
    this.poseDirty = false;
  }

  /** Back to a standing, aimed pose with no history (spawn / respawn). */
  reset() {
    this._restoreClipPose();
    this.mixer.stopAllAction();
    this.lowerName = null;
    this.upperName = null;
    this.deathAction = null;
    this.twist = 0;
    this.backpedal = false;
    this.velX = 0;
    this.velZ = 0;
    this.lastX = NaN;
    this.lastZ = NaN;
    this.airTime = 0;
    this.sprintBlend = 0;
    this.moving = false;
    this.sprintHeld = false;
    this.reloading = false;
    this.gesture = null;
    this.ikWeight = 1;
    this.heldWeapon = undefined;
    this._play('lower', 'Idle', 0);
    this._play('upper', 'Rifle_Aim', 0);
    this.mixer.update(0);
  }

  _play(layer, name, fade) {
    const key = layer === 'lower' ? 'lowerName' : 'upperName';
    if (this[key] === name) return this.actions[name];
    const next = this.actions[name];
    if (!next) return null;
    const prev = this.actions[this[key]];
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.reset().fadeIn(fade).play();
    // Walk -> jog -> sprint: start the new cycle on the same foot, or the
    // crossfade averages a left stride with a right one and the legs scissor.
    const ph = this.set.phases;
    if (layer === 'lower' && prev && ph && this[key] in ph && name in ph) {
      const prevDur = prev.getClip().duration;
      const at = ((prev.time / prevDur - ph[this[key]] + ph[name]) % 1 + 1) % 1;
      next.time = at * next.getClip().duration;
    }
    if (prev && prev !== next) prev.fadeOut(fade);
    this[key] = name;
    return next;
  }

  /** Torso-only additive hit reaction. */
  flinch(headshot) {
    const action = this.hitActions[headshot ? 'HitHead' : 'HitChest'] || this.hitActions.HitChest;
    if (!action || this.deathAction) return;
    action.reset().setEffectiveWeight(1).play();
  }

  /**
   * Start a death; returns the clip name played. A longer `fade` keeps a
   * crouched soldier from popping upright before the fall.
   */
  die(seed = Math.random(), fade = 0.08) {
    // Death_B (and its mirror) ends on the backpack with the legs in the air
    // on this rig; it is kept only if nothing else is there.
    const all = Object.keys(this.set.death);
    const names = all.filter((n) => !/^Death_B/.test(n)).length ? all.filter((n) => !/^Death_B/.test(n)) : all;
    if (!names.length) return null;
    this._restoreClipPose();
    const name = names[Math.min(names.length - 1, Math.floor(seed * names.length))];
    for (const key of ['lowerName', 'upperName']) {
      const action = this.actions[this[key]];
      if (action) action.fadeOut(0.1);
      this[key] = null;
    }
    for (const action of Object.values(this.hitActions)) action.stop();
    this.gesture = null;
    const death = this.actions[name];
    death.enabled = true;
    death.reset().fadeIn(fade).play();
    this.deathAction = death;
    return name;
  }

  /** Lay a corpse straight down in its final pose (assets arriving mid-round). */
  snapDead(seed) {
    this.mixer.stopAllAction();
    this.lowerName = null;
    this.upperName = null;
    const name = this.die(seed);
    if (!name) return;
    this.deathAction.fadeIn(0);
    this.deathAction.time = this.deathAction.getClip().duration;
    this.mixer.update(0);
  }

  get deathDone() {
    const a = this.deathAction;
    return !a || a.time >= a.getClip().duration - 1e-3;
  }

  /**
   * One frame of a living soldier.
   *
   * @param {object} actor   bot or remote: pos, yaw, aimPitch, crouching,
   *                         onGround, sprinting, aimBlend, burstLeft, fireAnim,
   *                         reloadTimer, hitFlinch, hitHeadshot, kneeling,
   *                         gesture ('slash' | 'lob', consumed like hitFlinch)
   * @param {number} dt
   * @param {object} ctx     { family: 'Rifle'|'Pistol', runSpeed, weapon (held
   *                           weapon Object3D or null), ik (bool) }
   */
  update(actor, dt, ctx) {
    const step = Math.max(0, dt);
    if (actor.hitFlinch) {
      this.flinch(!!actor.hitHeadshot);
      actor.hitFlinch = 0;
    }
    if (actor.gesture) {
      const steps = GESTURES[actor.gesture];
      if (steps && steps.every((g) => this.actions[g.clip])) this.gesture = { steps, step: -1, t: 0 };
      actor.gesture = null;
    }
    const kneeling = !!actor.kneeling && !!this.actions.Kneel;

    // ---- where are we going, relative to where we look ----------------------
    const px = actor.pos ? actor.pos.x : 0;
    const pz = actor.pos ? actor.pos.z : 0;
    if (step > 0 && Number.isFinite(this.lastX)) {
      const k = 1 - Math.exp(-12 * step);
      this.velX += ((px - this.lastX) / step - this.velX) * k;
      this.velZ += ((pz - this.lastZ) / step - this.velZ) * k;
    }
    this.lastX = px;
    this.lastZ = pz;
    const speed = Math.max(0, Number(actor.moveSpeed) || 0);
    const yaw = actor.yaw || 0;
    const fwd = this.velX * -Math.sin(yaw) + this.velZ * -Math.cos(yaw);
    const lat = this.velX * Math.cos(yaw) + this.velZ * -Math.sin(yaw);
    // Hysteresis: a soldier easing to a stop (or nudging off one) used to
    // flick Idle/Walk/Idle on the threshold frame after frame.
    const v2 = fwd * fwd + lat * lat;
    this.moving = this.moving
      ? speed > 0.2 && v2 > 0.015
      : speed > 0.35 && v2 > 0.04;
    const moving = this.moving;
    let moveAngle = moving ? Math.atan2(lat, fwd) : 0; // + = to the right
    if (moving) {
      const abs = Math.abs(moveAngle);
      if (!this.backpedal && abs > 115 * DEG) this.backpedal = true;
      else if (this.backpedal && abs < 95 * DEG) this.backpedal = false;
    } else {
      this.backpedal = false;
    }
    if (this.backpedal) moveAngle -= Math.sign(moveAngle) * Math.PI;

    // ---- legs --------------------------------------------------------------
    this.airTime = actor.onGround === false ? this.airTime + step : 0;
    // Inferred only well above a run: bots move at 4.6 m/s and every one of
    // them out of a fight played the sprint (and its carry pose) at that pace.
    const inferred = this.sprintHeld
      ? speed > 5.0 && (actor.aimBlend ?? 1) < 0.35 && !(actor.burstLeft > 0)
      : (speed > 5.5 && (actor.aimBlend ?? 1) < 0.2 && !(actor.burstLeft > 0));
    this.sprintHeld = inferred;
    const sprinting = !actor.crouching && (actor.sprinting === true || inferred || speed > 6);
    let lower;
    if (this.airTime > 0.18) lower = 'JumpLoop';
    else if (kneeling) lower = 'Kneel';
    else if (actor.crouching) lower = moving ? 'CrouchWalk' : 'CrouchIdle';
    else if (!moving) lower = 'Idle';
    else if (sprinting && !this.backpedal) lower = 'Sprint';
    else if (speed > (this.lowerName === 'Jog' ? 2.6 : 3.0)) lower = 'Jog';
    else lower = 'Walk';
    const legs = this._play('lower', lower, lower === 'JumpLoop' ? 0.12 : 0.2);
    if (legs) {
      const natural = this.set.speeds[lower];
      // A wide range keeps the feet planted: a jog clip driven at 7 m/s
      // needs ~2x, and anything clamped below the real speed skates.
      let scale = natural && lower !== 'Kneel' ? THREE.MathUtils.clamp(speed / natural, 0.5, 2.6) : 1;
      if (this.backpedal) scale = -scale;
      legs.setEffectiveTimeScale(scale);
    }

    // ---- torso ---------------------------------------------------------------
    const family = ctx.family === 'Pistol' ? 'Pistol' : 'Rifle';
    const reloadLeft = Number(actor.reloadTimer) || 0;
    let restart = false;
    if (reloadLeft > 0.05 && !this.reloading) {
      this.reloading = true;
      this.reloadDuration = Math.max(0.4, reloadLeft);
      restart = true;
    } else if (reloadLeft <= 0.05) {
      this.reloading = false;
    }
    const firing = actor.burstLeft > 0 || (actor.fireAnim || 0) > 0.05;
    let upper;
    const gesture = this._gestureStep(step);
    if (gesture) upper = gesture.clip;
    else if (kneeling && this.actions.Kneel_Work) upper = 'Kneel_Work';
    else if (this.reloading) upper = `${family}_Reload`;
    else if (sprinting && !firing) upper = family === 'Rifle' ? 'Rifle_Sprint' : 'Pistol_Ready';
    else if (firing || (actor.aimBlend ?? 1) > 0.3 || (actor.crouching && !moving)) upper = `${family}_Aim`;
    else upper = `${family}_Ready`;
    const wasUpper = this.upperName;
    const torso = this._play('upper', upper, gesture ? 0.06 : this.reloading ? 0.12 : 0.16);
    if (torso && gesture) {
      // Drive the window by hand: seek, then hold still (timeScale 0) so the
      // mixer's own clock does not run past it.
      const dur = torso.getClip().duration;
      const k = gesture.secs > 0 ? Math.min(1, this.gesture.t / gesture.secs) : 1;
      torso.time = (gesture.from + (gesture.to - gesture.from) * k) * dur;
      torso.setEffectiveTimeScale(0);
    } else if (torso && this.reloading) {
      // _play already restarted a newly chosen reload (with its crossfade);
      // only a back-to-back reload of the same clip needs rewinding here.
      if (restart && wasUpper === upper) torso.reset().play();
      torso.setEffectiveTimeScale(torso.getClip().duration / this.reloadDuration);
    }
    // Eased so the torso does not snap between sprint and aim posture.
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * (1 - Math.exp(-10 * step));
    const ikTarget = this.reloading || gesture || kneeling ? 0 : 1;
    // A new gun in the hand: the support hand comes off and eases onto the
    // new handguard with the torso's crossfade instead of snapping there.
    if (ctx.weapon !== this.heldWeapon) {
      if (this.heldWeapon !== undefined) this.ikWeight = 0;
      this.heldWeapon = ctx.weapon;
    }
    this.ikWeight += (ikTarget - this.ikWeight) * Math.min(1, step * 14);

    this._restoreClipPose();
    this.mixer.update(step);
    if (!this.procedural) return;
    for (let i = 0; i < this.touched.length; i++) this.clipPose[i].copy(this.touched[i].quaternion);
    this.poseDirty = true;

    // ---- procedural passes ---------------------------------------------------
    const twistTarget = moving ? THREE.MathUtils.clamp(-moveAngle, -MAX_TWIST, MAX_TWIST) : 0;
    this.twist += (twistTarget - this.twist) * (1 - Math.exp(-9 * step));
    const { hip, s1, s2, s3 } = this.bones;

    // Pelvis: clip rotation in model space, then the strafe twist.
    const hc = _qb.copy(this.parentModel).multiply(hip.quaternion); // clip pelvis (model)
    _qT.setFromAxisAngle(_Y, this.twist);
    rotateInModel(hip, this.parentModel, _qT);
    const hm = _qc.copy(_qT).multiply(hc); // twisted pelvis (model)

    // Torso correction: cancel most of the clip's pelvis motion and all of the twist.
    // A kneeling soldier keeps the clip's lean over the work.
    const cancel = kneeling ? 0 : 0.85 - 0.5 * this.sprintBlend;
    const delta = _qd.copy(this.hipRestModel).multiply(_qa.copy(hc).invert());
    const corr = _qe.copy(_qId).slerp(delta, cancel).multiply(_qT.invert());
    const third = _qd.copy(_qId).slerp(corr, 1 / 3);
    const model = _qb.copy(hm);
    rotateInModel(s1, model, third);
    model.multiply(s1.quaternion);
    rotateInModel(s2, model, third);
    const s2Parent = _qc.copy(model);
    model.multiply(s2.quaternion);
    rotateInModel(s3, model, third);

    // Aim pitch and recoil: about the model's lateral axis, half at each joint.
    const pitch = kneeling ? 0 : THREE.MathUtils.clamp(Number(actor.aimPitch) || 0, -1.2, 1.2) * (1 - 0.7 * this.sprintBlend);
    const kick = (actor.fireAnim || 0) * RECOIL_PITCH[family];
    rotateInModel(s2, s2Parent, _qHalf.setFromAxisAngle(_X, -pitch * 0.5));
    s2Parent.multiply(s2.quaternion);
    _qT.setFromAxisAngle(_X, -pitch * 0.5 - kick);
    rotateInModel(s3, s2Parent, _qT);

    if (ctx.ik && this.ikWeight > 0.01 && ctx.weapon && this.set.handBasisL) this._supportHand(ctx);
  }

  /** Advance the running gesture; returns its current step, or null when done. */
  _gestureStep(step) {
    const g = this.gesture;
    if (!g) return null;
    if (g.step < 0) { g.step = 0; g.t = 0; } else g.t += step;
    while (g.step < g.steps.length && g.t >= g.steps[g.step].secs) {
      g.t -= g.steps[g.step].secs;
      g.step++;
      // A step that reuses the clip already on the torso still has to seek.
      if (g.step < g.steps.length && g.steps[g.step].clip === this.upperName) this.upperName = null;
    }
    if (g.step >= g.steps.length) { this.gesture = null; return null; }
    return g.steps[g.step];
  }

  /** Solve the left arm onto the held weapon's support grip (world space). */
  _supportHand(ctx) {
    const weapon = ctx.weapon;
    const model = weapon.userData && weapon.userData.model;
    const grip = model && model.nodes && model.nodes.gripL;
    if (!grip) return;
    if (!weapon.userData.gripBasisL) weapon.userData.gripBasisL = gripBasis(grip);
    ctx.root.updateMatrixWorld(true);
    const { upperL, foreL, handL } = this.bones;
    const k = IK;

    // Everything read before anything is written: the getters below re-derive
    // world matrices from the current locals.
    k.target.fromArray(grip.pos).applyMatrix4(weapon.matrixWorld);
    weapon.getWorldQuaternion(k.wantHand)
      .multiply(weapon.userData.gripBasisL)
      .multiply(k.tmp.copy(this.set.handBasisL).invert());
    upperL.getWorldPosition(k.a);
    foreL.getWorldPosition(k.b);
    handL.getWorldPosition(k.c);
    upperL.parent.getWorldQuaternion(k.parentQ);
    upperL.getWorldQuaternion(k.upperQ);
    foreL.getWorldQuaternion(k.foreQ);

    const l1 = k.a.distanceTo(k.b);
    const l2 = k.b.distanceTo(k.c);
    k.dir.subVectors(k.target, k.a);
    const dist = THREE.MathUtils.clamp(k.dir.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-4);
    k.dir.normalize();
    // Keep the elbow in the plane the authored pose put it in.
    k.pole.subVectors(k.b, k.a);
    k.pole.addScaledVector(k.dir, -k.pole.dot(k.dir));
    if (k.pole.lengthSq() < 1e-10) return;
    k.pole.normalize();
    const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
    k.elbow.copy(k.a).addScaledVector(k.dir, x).addScaledVector(k.pole, h);

    // Upper arm: swing (b - a) onto (elbow - a); the forearm rides along.
    k.u.subVectors(k.b, k.a).normalize();
    k.v.subVectors(k.elbow, k.a).normalize();
    k.swing.setFromUnitVectors(k.u, k.v);
    k.upperQ.premultiply(k.swing);
    k.foreQ.premultiply(k.swing);
    // Forearm: swing the carried hand offset onto (target - elbow).
    k.u.subVectors(k.c, k.b).applyQuaternion(k.swing).normalize();
    k.v.subVectors(k.target, k.elbow).normalize();
    k.foreQ.premultiply(k.tmp.setFromUnitVectors(k.u, k.v));

    const w = this.ikWeight;
    upperL.quaternion.slerp(k.tmp.copy(k.parentQ).invert().multiply(k.upperQ), w);
    foreL.quaternion.slerp(k.tmp.copy(k.upperQ).invert().multiply(k.foreQ), w);
    handL.quaternion.slerp(k.tmp.copy(k.foreQ).invert().multiply(k.wantHand), w);
  }
}

const IK = {
  target: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
  dir: new THREE.Vector3(), pole: new THREE.Vector3(), elbow: new THREE.Vector3(),
  u: new THREE.Vector3(), v: new THREE.Vector3(),
  wantHand: new THREE.Quaternion(), parentQ: new THREE.Quaternion(), upperQ: new THREE.Quaternion(),
  foreQ: new THREE.Quaternion(), swing: new THREE.Quaternion(), tmp: new THREE.Quaternion(),
};
