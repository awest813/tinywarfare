// World.raycast marches a 4 m grid of the static solids. The hit has to be the
// same box the old linear scan would have returned — including which solid
// wins when two faces sit on the same distance — and a short ray must not
// test every box on the map.
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
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return { width: 0, height: 0, getContext: () => context };
  },
};

const [{ default: World }, { MAP_CATALOG }] = await Promise.all([
  import('../src/world/map.js'),
  import('../src/maps/catalog.js'),
]);

function gameFor(mapId) {
  return {
    selectedMapId: mapId,
    scene: new THREE.Scene(),
    config: { PLAYER: { STEP_HEIGHT: 0.62 } },
    state: { phase: 'menu' },
    debug: false,
    events: { on: () => () => {}, emit: () => {} },
  };
}

/** The scan the grid replaced: every solid, earlier mesh wins a tie. */
function brute(world, origin, dir, maxDist) {
  const direction = dir.clone().normalize();
  const rc = new THREE.Raycaster(origin, direction, 0, maxDist);
  let best = null;
  let bestD = maxDist;
  for (const mesh of world.solids.children) {
    if (!mesh.isMesh) continue;
    const hits = [];
    mesh.raycast(rc, hits);
    for (const hit of hits) {
      if (best === null ? hit.distance <= bestD : hit.distance < bestD) {
        best = hit;
        bestD = hit.distance;
      }
    }
  }
  return best;
}

function assertSame(world, origin, dir, maxDist, label) {
  const slow = brute(world, origin, dir, maxDist);
  const fast = world.raycast(origin, dir, maxDist);
  if (!slow) {
    assert.equal(fast, null, `${label}: grid hit ${fast && fast.mesh && fast.mesh.name} where the scan missed`);
    return;
  }
  assert.ok(fast, `${label}: grid missed a hit at ${slow.distance.toFixed(3)} m`);
  assert.equal(fast.mesh, slow.object, `${label}: different solid`);
  assert.ok(Math.abs(fast.distance - slow.distance) < 1e-5, `${label}: distance ${fast.distance} vs ${slow.distance}`);
  assert.equal(fast.surface, slow.object.userData.surface || 'concrete');
}

const DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, -0.2, 1], [-1, 0.15, -1], [0.2, -1, 0.5],
];

for (const meta of MAP_CATALOG) {
  test(`${meta.name} raycasts match a full scan and skip distant boxes`, () => {
    const world = new World(gameFor(meta.id));
    const solids = world.solids.children.filter((o) => o.isMesh);
    assert.ok(solids.length > 40, `${meta.id} has solids to index`);

    const origins = [
      new THREE.Vector3(0, 1.6, 0),
      new THREE.Vector3(-20, 1.2, 10),
      new THREE.Vector3(24, 2.4, -16),
      new THREE.Vector3(0, 30, 0),
      new THREE.Vector3(-80, 1.6, 0),
    ];
    for (const origin of origins) {
      for (const [x, y, z] of DIRS) {
        const dir = new THREE.Vector3(x, y, z);
        assertSame(world, origin, dir, 80, `${meta.id} ${origin.x},${origin.z} -> ${x},${y},${z}`);
      }
    }

    // From inside a solid, looking out: the exit face is the hit.
    const buried = solids[Math.floor(solids.length / 3)];
    assertSame(world, buried.position, new THREE.Vector3(0.3, 0.2, 1), 30, `${meta.id} from inside a solid`);

    // A two-metre poke must not consider the whole map.
    world.raycast(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(1, 0, 0), 2);
    assert.ok(world._rayBoxTests < solids.length / 4,
      `${meta.id}: a 2 m ray tested ${world._rayBoxTests} of ${solids.length} boxes`);
    assert.ok(world._rayBoxTests > 0, `${meta.id}: the grid tested nothing`);
  });
}
