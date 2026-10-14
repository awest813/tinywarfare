import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Player from '../src/player/player.js';
import Weapons from '../src/weapons/weapons.js';
import GameSettings from '../src/core/settings.js';
import { CONFIG } from '../src/shared/config.js';
import { EventBus } from '../src/shared/events.js';

function makeGame() {
  const events = new EventBus();
  const held = new Set();
  const input = {
    firing: false,
    aiming: false,
    locked: true,
    isDown: (key) => held.has(key),
    consumeLook: () => ({ dx: 0, dy: 0 }),
    wasPressed: () => false,
  };
  const game = {
    config: CONFIG,
    events,
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250),
    state: { phase: 'live', buyOpen: false },
    input,
    bots: { all: [] },
    multiplayer: { active: false, remotePlayers: [] },
    world: {
      resolveMovement(pos, delta) {
        const next = pos.clone().add(delta);
        const onGround = next.y <= 0;
        if (onGround) next.y = 0;
        return { pos: next, onGround };
      },
    },
  };
  game.player = new Player(game);
  game.weapons = new Weapons(game);
  game.weapons.give('m4a1');
  game.weapons.currentId = 'm4a1';
  game.weapons._state = 'idle';
  return { game, held, input };
}

function run(game, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) {
    game.player.update(dt);
    game.weapons.update(dt);
  }
}

const speed = (player) => Math.hypot(player.velocity.x, player.velocity.z);

test('Shift sprints forward faster than running, and the trigger breaks it', () => {
  const { game, held, input } = makeGame();
  held.add('w');
  run(game, 1);
  const runSpeed = speed(game.player);
  assert.equal(game.player.sprinting, false);

  held.add('shift');
  run(game, 1);
  assert.equal(game.player.sprinting, true);
  assert.ok(speed(game.player) > runSpeed * 1.2, `sprint ${speed(game.player)} vs run ${runSpeed}`);

  // Strafing alone never sprints.
  held.delete('w');
  held.add('d');
  run(game, 0.1);
  assert.equal(game.player.sprinting, false);
  held.delete('d');
  held.add('w');
  run(game, 0.5);
  assert.equal(game.player.sprinting, true);

  // Holding fire drops the sprint, and the first shot waits for sprint-out.
  let shots = 0;
  game.events.on('weapon:fire', () => shots++);
  input.firing = true;
  run(game, 0.1);
  assert.equal(game.player.sprinting, false);
  assert.equal(shots, 0, 'no shot inside the sprint-out window');
  run(game, 0.3);
  assert.ok(shots > 0, 'fires once sprint-out ends');
});

test('crouching out of a sprint slides, then the slide bleeds off', () => {
  const { game, held } = makeGame();
  held.add('w');
  held.add('shift');
  run(game, 1);
  assert.equal(game.player.sprinting, true);

  held.add('control');
  run(game, 1 / 60);
  assert.equal(game.player.sliding, true);
  assert.ok(speed(game.player) >= 8, 'slide launches above sprint speed');
  assert.equal(game.player.crouching, true);

  run(game, 1.2);
  assert.equal(game.player.sliding, false);
  assert.ok(speed(game.player) < 3, 'crouched after the slide');

  // Crouch from a standstill never slides.
  held.clear();
  run(game, 1.5);
  held.add('control');
  run(game, 0.1);
  assert.equal(game.player.sliding, false);
});

test('aiming down sights zooms, tightens spread, slows movement, and blocks sprint', () => {
  const { game, held, input } = makeGame();
  const weapons = game.weapons;
  const hipSpread = weapons.currentSpread();
  const hipMove = weapons.currentMoveMult();

  input.aiming = true;
  run(game, 0.5);
  assert.equal(weapons.adsFraction(), 1);
  assert.ok(game.camera.fov < CONFIG.PLAYER.FOV * 0.85);
  assert.ok(weapons.currentSpread() < hipSpread * 0.6);
  assert.ok(weapons.currentMoveMult() < hipMove * 0.75);
  assert.ok(weapons.adsSensitivityScale() < 0.85);

  held.add('w');
  held.add('shift');
  run(game, 0.3);
  assert.equal(game.player.sprinting, false, 'ADS vetoes sprint');

  input.aiming = false;
  run(game, 0.5);
  assert.equal(weapons.adsFraction(), 0);
  assert.equal(game.camera.fov, CONFIG.PLAYER.FOV);
  assert.equal(game.player.sprinting, true);

  // The AWP keeps its scope instead of ADS.
  weapons.give('awp');
  weapons.currentId = 'awp';
  input.aiming = true;
  run(game, 0.3);
  assert.equal(weapons.adsFraction(), 0);
});

test('a saved layout with Walk on Shift migrates to Sprint on Shift', () => {
  const stored = JSON.stringify({ bindings: { walk: 'shift', crouch: 'control' } });
  const storage = { getItem: () => stored, setItem() {} };
  const settings = new GameSettings(null, storage);
  assert.equal(settings.get('sprint'), 'shift');
  assert.equal(settings.get('walk'), 'x');
  assert.equal(settings.get('crouch'), 'c', 'and Crouch leaves Ctrl');
  assert.equal(settings.resolveInputKey('shift'), 'shift');
  assert.equal(settings.resolveInputKey('x'), 'c');
});

function ledgeWorld(height) {
  // A box spanning z in [-3, -1] (straight ahead at yaw 0), `height` tall.
  const inBox = (x, z) => Math.abs(x) < 2 && z <= -1 && z >= -3;
  return {
    raycast(origin, dir, max) {
      if (Math.abs(dir.y + 1) < 1e-6) { // straight down
        if (!inBox(origin.x, origin.z) || origin.y < height) return null;
        const d = origin.y - height;
        return d <= max ? { point: new THREE.Vector3(origin.x, height, origin.z), distance: d } : null;
      }
      if (origin.y > height || dir.z >= 0) return null; // above the box or facing away
      const d = (origin.z - -1) / -dir.z;
      return d >= 0 && d <= max && Math.abs(origin.x + dir.x * d) < 2
        ? { point: new THREE.Vector3(origin.x + dir.x * d, origin.y, -1), distance: d }
        : null;
    },
    resolveMovement(pos, delta) {
      const next = pos.clone().add(delta);
      const floor = inBox(next.x, next.z) ? height : 0;
      if (inBox(next.x, next.z) && pos.y < height - 0.3 && !inBox(pos.x, pos.z)) {
        next.z = pos.z; // hit the face from the side: blocked horizontally
      }
      const ground = inBox(next.x, next.z) ? floor : 0;
      const onGround = next.y <= ground;
      if (onGround) next.y = ground;
      return { pos: next, onGround };
    },
  };
}

test('jumping into a chest-high ledge mantles on top; a wall stays a jump', () => {
  for (const [height, expectOnTop] of [[1.2, true], [2.0, false]]) {
    const { game, held } = makeGame();
    game.world = ledgeWorld(height);
    game.player.position.set(0, 0, -0.5);
    run(game, 0.2);
    let mantled = false;
    game.events.on('player:mantle', () => { mantled = true; });
    held.add('w');
    game.events.emit('input:keydown', { key: ' ' });
    run(game, 0.55);
    held.delete('w'); // stop on the ledge rather than walking off its far side
    run(game, 0.6);
    assert.equal(mantled, expectOnTop, `height ${height}`);
    if (expectOnTop) {
      assert.ok(Math.abs(game.player.position.y - height) < 0.05, `stands on the ${height} m ledge`);
      assert.ok(game.player.position.z < -1, 'moved onto the ledge');
    } else {
      assert.ok(game.player.position.y < 0.05);
    }
  }
});
