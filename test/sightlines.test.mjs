import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { SECTORS, buildSightlines, findCover, laneYaw, sectorYaw } from '../src/ai/sightlines.js';

/** A tiny world: waypoint nodes plus box walls that rays stop at. */
function boxWorld(points, boxes) {
  const ray = new THREE.Ray();
  const hitPoint = new THREE.Vector3();
  return {
    waypoints: { nodes: points.map(([x, z], id) => ({ id, pos: new THREE.Vector3(x, 0, z) })) },
    raycast(origin, dir, maxDist) {
      ray.set(origin, dir);
      let best = null;
      for (const box of boxes) {
        if (!ray.intersectBox(box, hitPoint)) continue;
        const distance = hitPoint.distanceTo(origin);
        if (distance <= maxDist && (!best || distance < best.distance)) best = { distance };
      }
      return best;
    },
  };
}

const wall = (x0, z0, x1, z1) => new THREE.Box3(new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 4, z1));

test('a node in a corridor sees far along it and not into the walls', () => {
  // Corridor running north-south (z), walls 1.5 m either side.
  const world = boxWorld([[0, 0]], [wall(-2, -100, -1.5, 100), wall(1.5, -100, 2, 100)]);
  const open = buildSightlines(world);
  assert.equal(open.length, SECTORS);
  // Sector 0 faces -z (north), 4 faces +z (south): down the corridor.
  assert.equal(open[0], 40);
  assert.equal(open[4], 40);
  assert.ok(open[2] < 2 && open[6] < 2, 'east and west are walls');
  // Watching from it, a bot almost always looks down the corridor.
  let lane = 0;
  for (let i = 0; i < 200; i++) {
    const yaw = laneYaw(open, 0, () => i / 200);
    if (Math.abs(Math.sin(yaw)) < 0.2) lane++;
  }
  assert.ok(lane > 190, `${lane} of 200 looks went down the lane`);
  assert.equal(sectorYaw(SECTORS), Math.PI * 2);
});

test('cover is a nearby node the enemy cannot see and the bot can walk to', () => {
  // Enemy to the north. A crate west of the bot hides the node behind it;
  // a node east is in the open; a node far south is beyond reach.
  const threat = new THREE.Vector3(0, 0, -20);
  const crate = wall(-5, -3.5, -3, -2.5);
  const world = boxWorld([[-4, -1], [5, 0], [0, 30]], [crate]);
  const spot = findCover(world, new THREE.Vector3(0, 0, 0), threat, 10);
  assert.ok(spot, 'found cover');
  assert.deepEqual([spot.x, spot.z], [-4, -1], 'the node behind the crate');
  // With nothing between the enemy and any node, there is no cover.
  const open = boxWorld([[-4, -1], [5, 0]], []);
  assert.equal(findCover(open, new THREE.Vector3(0, 0, 0), threat, 10), null);
});

test('cover never sends a bot toward the enemy or through a wall', () => {
  const threat = new THREE.Vector3(0, 0, -20);
  // Node at (0,-8) is hidden (box just north of it) but 8 m closer to the enemy.
  const forward = boxWorld([[0, -8]], [wall(-2, -11, 2, -10)]);
  assert.equal(findCover(forward, new THREE.Vector3(0, 0, 0), threat, 10), null);
  // Node behind a wall the bot cannot walk through.
  const blocked = boxWorld([[-4, 0]], [wall(-2.5, -6, -2, 6)]);
  assert.equal(findCover(blocked, new THREE.Vector3(0, 0, 0), threat, 10), null);
});
