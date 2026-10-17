// Penetration stops at a wall a thin slab is laid against: Dustyard's open
// door leaves sit flat on the 0.6 m mid wall, and the round used to "exit" the
// leaf straight into the concrete and cross it (raycasts from inside a solid
// hit nothing), so rifles killed through the wall at mid.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const gradient = { addColorStop() {} };
const context = new Proxy({}, {
  get(target, key) {
    if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
    if (!(key in target)) target[key] = () => {};
    return target[key];
  },
  set(target, key, value) { target[key] = value; return true; },
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };

const [{ default: World }, { default: Combat }, { EventBus }, { CONFIG }] = await Promise.all([
  import('../src/world/map.js'),
  import('../src/combat/combat.js'),
  import('../src/shared/events.js'),
  import('../src/shared/config.js'),
]);

const world = new World({
  selectedMapId: 'dustyard', scene: new THREE.Scene(), config: { PLAYER: { STEP_HEIGHT: 0.62 } },
  state: { phase: 'menu' }, debug: false, events: { on: () => () => {}, emit: () => {} },
});

function shoot(weaponId, x) {
  const events = new EventBus();
  let damage = 0;
  const bot = {
    alive: true, team: 't', pos: new THREE.Vector3(x, 0, -24), radius: 0.35, height: 1.83, crouching: false,
    takeDamage(amount) { damage += amount; },
  };
  const game = { events, config: CONFIG, world, player: { team: 'ct', alive: false }, bots: { all: [bot] }, multiplayer: null, state: { phase: 'live' } };
  new Combat(game);
  events.emit('weapon:fire', { weaponId, origin: new THREE.Vector3(x, 1.2, -32), dir: new THREE.Vector3(0, 0, 1), byPlayer: true });
  return damage;
}

test('a rifle round does not cross the mid wall where a door leaf lies against it', () => {
  for (const id of ['ak47', 'm4a1', 'lmg', 'awp', 'deagle']) {
    assert.equal(shoot(id, -2.3), 0, `${id} through door leaf + 0.6 m wall`);
  }
  assert.equal(shoot('ak47', -4.5), 0, 'and the bare wall still stops it');
});
