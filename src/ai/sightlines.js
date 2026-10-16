// ============================================================================
// TINY WARFARE — src/ai/sightlines.js
//
// A small tactical picture of a map, worked out once from its waypoint graph
// and collision (after the per-waypoint line-of-fire tables in Killzone's AI
// and the hiding spots of the Counter-Strike bot):
//
//   buildSightlines  how far each waypoint can see in 8 directions at eye
//                    height, so a bot holding a spot watches the long lanes
//                    an enemy will come down rather than a wall
//   findCover        a waypoint close to a bot, reachable in a straight line,
//                    that the enemy cannot see: where to reload or recover
//                    before peeking again
// ============================================================================

import * as THREE from 'three';

export const SECTORS = 8;
const EYE = 1.5;          // m above a node's floor
const RANGE = 40;         // m: a lane longer than this counts as this long
const KNEE = 0.6;         // m: walk-line rays pass over steppable curbs

const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Yaw of sector `k` (same convention as the bots: forward is (-sin, -cos)). */
export function sectorYaw(k) {
  return (k / SECTORS) * Math.PI * 2;
}

/** Open distance per node and sector: Float32Array of nodes.length * SECTORS. */
export function buildSightlines(world) {
  const nodes = (world && world.waypoints && world.waypoints.nodes) || [];
  const open = new Float32Array(nodes.length * SECTORS);
  if (!world || typeof world.raycast !== 'function') return open.fill(RANGE);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].pos;
    _from.set(p.x, p.y + EYE, p.z);
    for (let k = 0; k < SECTORS; k++) {
      const yaw = sectorYaw(k);
      _dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = world.raycast(_from, _dir, RANGE);
      open[i * SECTORS + k] = hit ? Math.max(0, hit.distance) : RANGE;
    }
  }
  return open;
}

/**
 * A yaw to watch from node `index`: sectors weighted by how far they see,
 * so long lanes are watched most and walls almost never.
 */
export function laneYaw(open, index, random = Math.random) {
  let total = 0;
  for (let k = 0; k < SECTORS; k++) {
    const d = open[index * SECTORS + k];
    total += d * d;
  }
  if (!(total > 0)) return null;
  let pick = random() * total;
  for (let k = 0; k < SECTORS; k++) {
    const d = open[index * SECTORS + k];
    pick -= d * d;
    if (pick <= 0) return sectorYaw(k);
  }
  return sectorYaw(SECTORS - 1);
}

/** True when the straight line a->b is clear (b optionally lifted by `lift`). */
function clear(world, a, aLift, b, bLift, slack) {
  _from.set(a.x, a.y + aLift, a.z);
  _dir.set(b.x - a.x, (b.y + bLift) - (a.y + aLift), b.z - a.z);
  const dist = _dir.length();
  if (dist < 0.01) return true;
  _dir.multiplyScalar(1 / dist);
  const hit = world.raycast(_from, _dir, dist);
  return !hit || hit.distance >= dist - slack;
}

/**
 * The best waypoint within `maxDist` of `from` that the bot can walk to in a
 * straight line and that is hidden from `threat` (a position; its eye height
 * is assumed). Prefers close spots that do not walk toward the threat.
 * Returns a node position or null.
 */
export function findCover(world, from, threat, maxDist = 10) {
  const nodes = world && world.waypoints && world.waypoints.nodes;
  if (!nodes || !nodes.length || typeof world.raycast !== 'function' || !threat) return null;
  const toThreat = Math.hypot(threat.x - from.x, threat.z - from.z);
  let best = null;
  let bestScore = Infinity;
  for (const node of nodes) {
    const p = node.pos;
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    if (d < 1 || d > maxDist || Math.abs(p.y - from.y) > 1.2) continue;
    const away = Math.hypot(threat.x - p.x, threat.z - p.z);
    if (away < toThreat - 2) continue;              // not toward the enemy
    const score = d + Math.max(0, 6 - away);         // close, and not on top of them
    if (score >= bestScore) continue;
    if (!clear(world, from, KNEE, p, KNEE, 0.3)) continue;   // a straight walk
    if (clear(world, p, EYE, threat, EYE, 0.5)) continue;     // hidden from them
    best = p;
    bestScore = score;
  }
  return best;
}
