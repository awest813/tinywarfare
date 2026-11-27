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

/** Two panels and the colliders that match them, for a shot along +Z. */
function panels(specs) {
  const group = new THREE.Group();
  const colliders = [];
  for (const spec of specs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(spec.w, spec.h, spec.d));
    mesh.position.set(spec.x, spec.y, spec.z);
    mesh.userData.surface = 'wood';
    group.add(mesh);
  }
  group.updateMatrixWorld(true);
  for (const mesh of group.children) colliders.push(new THREE.Box3().setFromObject(mesh));
  const rc = new THREE.Raycaster();
  return {
    colliders,
    raycast(origin, dir, maxDist) {
      const direction = dir.clone().normalize();
      rc.set(origin, direction);
      rc.near = 0;
      rc.far = maxDist;
      const hits = [];
      rc.intersectObjects(group.children, false, hits);
      const hit = hits[0];
      if (!hit) return null;
      return {
        point: hit.point.clone(),
        normal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld),
        distance: hit.distance,
        mesh: hit.object,
        surface: 'wood',
      };
    },
  };
}

function shootPanels(world, bot) {
  const events = new EventBus();
  let damage = 0;
  bot.takeDamage = (amount) => { damage += amount; };
  const game = {
    events, config: CONFIG, world,
    player: { team: 'ct', alive: false },
    bots: { all: [bot] },
    multiplayer: null,
    state: { phase: 'live' },
  };
  new Combat(game);
  events.emit('weapon:fire', {
    weaponId: 'ak47',
    origin: new THREE.Vector3(0, 1.2, -3),
    dir: new THREE.Vector3(0, 0, 1),
    byPlayer: true,
  });
  return damage;
}

test('a rifle hits a player standing in the gap between two thin walls', () => {
  // 4 cm, then 20 cm of air, then 4 cm. The old probe started 40 cm past the
  // first face and called the far side of the second wall the exit, so the
  // body in the gap was never tested.
  const world = panels([
    { x: 0, y: 1.2, z: 0.02, w: 2, h: 2.4, d: 0.04 },
    { x: 0, y: 1.2, z: 0.26, w: 2, h: 2.4, d: 0.04 },
  ]);
  const bot = {
    alive: true, team: 't', pos: new THREE.Vector3(0, 0, 0.14),
    radius: 0.08, height: 1.83, crouching: false,
  };
  assert.ok(shootPanels(world, bot) > 0, 'the gap is open air, and the body is in it');
});

test('a rifle still penetrates one thin wall and still stops in a thick one', () => {
  const thin = panels([{ x: 0, y: 1.2, z: 0.04, w: 2, h: 2.4, d: 0.08 }]);
  const behind = {
    alive: true, team: 't', pos: new THREE.Vector3(0, 0, 1),
    radius: 0.35, height: 1.83, crouching: false,
  };
  assert.ok(shootPanels(thin, behind) > 0, '8 cm of wood');
  const thick = panels([{ x: 0, y: 1.2, z: 0.3, w: 2, h: 2.4, d: 0.6 }]);
  assert.equal(shootPanels(thick, { ...behind, pos: new THREE.Vector3(0, 0, 2) }), 0, '60 cm of concrete');
});
