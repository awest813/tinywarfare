// Every respawn candidate (spawn pads, nav nodes and the midpoints of nav
// edges) stands on a floor with room for a body, on every map once it is
// dressed. Midpoints of edges up a step used to hang 0.25 m in the air or sit
// half inside Harbor's quay, and two of them were inside crates; Dustyard's
// site A centre (where bots plant and the Hardpoint zone sits) was inside the
// default boxes.
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

const [{ default: World }, { dressMap }, { default: TeamDeathmatch }, { CONFIG }] = await Promise.all([
  import('../src/world/map.js'),
  import('../src/world/dressing.js'),
  import('../src/game/tdm.js'),
  import('../src/shared/config.js'),
]);

const R = CONFIG.PLAYER.RADIUS;
const H = CONFIG.PLAYER.HEIGHT_STAND;

function dressedWorld(mapId) {
  const world = new World({
    selectedMapId: mapId, scene: new THREE.Scene(), config: CONFIG,
    state: { phase: 'menu' }, debug: false, events: { on: () => () => {}, emit: () => {} },
  });
  if (world.solidBatch) world.solids.remove(world.solidBatch);
  world.solidBatch = null;
  dressMap(world, { quality: 'high' });
  world._batchSolids();
  world.solids.updateMatrixWorld(true);
  return world;
}

// Room for a body, allowing a floor tile up to a step's lip under the feet.
const fits = (world, p) => world._clearAt(p.x, p.y + 0.08, p.z, R, H);
const stands = (world, p) => p.y <= 0.002 || world._probeGround(p.x, p.y, p.z, R) || world._probeGround(p.x, p.y + 0.06, p.z, R);

for (const mapId of ['dustyard', 'frostline', 'neon_foundry', 'harbor', 'citadel']) {
  test(`${mapId}: every respawn candidate and bomb site centre has room to stand`, () => {
    const world = dressedWorld(mapId);
    const list = TeamDeathmatch.prototype._spawnCandidates.call({ game: { world, config: CONFIG } });
    assert.ok(list.length > 40, `${list.length} candidates`);
    const bad = list.filter((c) => !fits(world, c.pos) || !stands(world, c.pos))
      .map((c) => `(${c.pos.x.toFixed(2)}, ${c.pos.y.toFixed(2)}, ${c.pos.z.toFixed(2)})`);
    assert.deepEqual(bad, []);
    for (const site of world.bombSites || []) {
      assert.ok(fits(world, site.center), `site ${site.name} centre is inside a solid`);
    }
  });
}

test('a bot at the foot of a raised platform enters the nav graph on its own floor', () => {
  // Neon Foundry: beside a 0.9 m ledge every near node is up on it, and the
  // nearest one outright was what bots walked into, for good.
  const world = dressedWorld('neon_foundry');
  const node = world.reachableWaypoint(new THREE.Vector3(29, 0, -14.6));
  assert.ok(node.pos.y <= 0.6, `entered by a node ${node.pos.y} m up`);
});

test("Citadel has no dead-end slot between the terraces and the east keep wings", () => {
  const world = dressedWorld('citadel');
  for (const z of [19.5, -19.5]) {
    for (const x of [11, 14, 17]) {
      assert.equal(world._clearAt(x, 0.01, z, R, H), false, `a soldier fits at (${x}, ${z}) at ground level`);
    }
  }
});
