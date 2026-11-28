// A slide clears player.sprinting on the same frame it starts, and the sprint
// blend used to ease the gun back to the hip in about a fifth of a second.
// The slide itself lasts most of a second, so the gun rose in the middle of
// the glide. It has to stay low until the slide is over, then come back up.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import ViewModel from '../src/weapons/viewmodel.js';

function makeView(player) {
  const vm = Object.create(ViewModel.prototype);
  vm.game = {
    camera: new THREE.PerspectiveCamera(74, 1.6, 0.1, 100),
    player,
    weapons: {
      currentId: 'ak47',
      adsFraction: () => 0,
      isScoped: () => false,
      sprintOutTime: () => 0.2,
    },
    input: player.input,
    state: { phase: 'playing' },
    world: null,
    config: { PLAYER: { FOV: 74, RUN_SPEED: 5.2 } },
  };
  vm.rig = new THREE.Group();
  vm.pivot = new THREE.Group();
  vm.rig.add(vm.pivot);
  const model = new THREE.Group();
  model.userData = {};
  vm._models = { ak47: model };
  vm._currentId = 'ak47';
  vm._t = 0;
  vm._kick = 0;
  vm._kickYawV = 0;
  vm._kickRollV = 0;
  vm._landK = 0;
  vm._airY = 0;
  vm._sprint = 0;
  vm._slide = 0;
  vm._bobPhase = 0;
  vm._bobAmp = 0;
  vm._equipT = 1;
  vm._equipDur = 0.28;
  vm._reload = { active: false, t: 0, dur: 2.5 };
  vm._slash = { active: false, t: 0, side: 1 };
  vm._wind = 0;
  vm._throw = { active: false, t: 0 };
  vm._hand = null;
  vm._cycleT = 1;
  vm._wallK = 0;
  vm._wallRay = new THREE.Ray();
  vm._wallHit = new THREE.Vector3();
  vm._wallFrame = 0;
  vm._payloadHidden = false;
  vm._bolt = { active: false, t: 0 };
  vm._haveLook = false;
  vm._lastYaw = 0;
  vm._lastPitch = 0;
  vm._yawVel = 0;
  vm._pitchVel = 0;
  vm._vDir = new THREE.Vector3();
  vm._muzzleOut = new THREE.Vector3();
  return vm;
}

function settle(vm, player, secs) {
  for (let t = 0; t < secs; t += 1 / 60) vm.update(1 / 60);
  return { y: vm.pivot.position.y, rx: vm.pivot.rotation.x };
}

test('the viewmodel stays low for the whole slide, then rises', () => {
  const player = {
    alive: true,
    yaw: 0,
    pitch: 0,
    onGround: true,
    velocity: { y: 0 },
    moveSpeed2D: 0,
    sprinting: true,
    sliding: false,
    input: { firing: false },
  };
  const vm = makeView(player);
  const sprint = settle(vm, player, 0.4);
  assert.ok(sprint.y < -0.17, `sprint carry sits low (${sprint.y})`);

  player.sprinting = false;
  player.sliding = true;
  const mid = settle(vm, player, 0.35);
  assert.ok(mid.y < -0.18, `halfway through the slide the gun is still low (${mid.y})`);
  assert.ok(mid.rx < -0.4, `and pitched down into the tuck (${mid.rx})`);

  player.sliding = false;
  const up = settle(vm, player, 0.45);
  assert.ok(up.y > -0.16, `once the slide is over the gun is back at the hip (${up.y})`);
  assert.ok(up.rx > -0.08, `and no longer tucked (${up.rx})`);
});

test('firing during a slide lets the gun come back up', () => {
  const player = {
    alive: true,
    yaw: 0,
    pitch: 0,
    onGround: true,
    velocity: { y: 0 },
    moveSpeed2D: 0,
    sprinting: false,
    sliding: true,
    input: { firing: false },
  };
  const vm = makeView(player);
  settle(vm, player, 0.4);
  const tucked = vm.pivot.position.y;
  player.input.firing = true;
  const aimed = settle(vm, player, 0.4);
  assert.ok(aimed.y > tucked + 0.04, `a shot during the slide raises the gun (${tucked} -> ${aimed.y})`);
});
