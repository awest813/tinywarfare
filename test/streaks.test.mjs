import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Scorestreaks, { STREAKS, AIRSTRIKE, ENEMY_UAV_KILLS } from '../src/game/streaks.js';
import { EventBus } from '../src/shared/events.js';

function makeGame() {
  const events = new EventBus();
  const blasts = [];
  const camera = new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250);
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 0, -10); // looking down at the ground ahead
  camera.updateMatrixWorld(true);
  const game = {
    events,
    camera,
    state: { mode: 'tdm', phase: 'live' },
    player: { team: 'ct', alive: true, position: new THREE.Vector3(0, 0, 0), eyeHeight: 1.6, yaw: 0 },
    world: { raycast: () => null },
    combat: { _radialDamage: (center, radius, dmg, attacker, team, weapon) => blasts.push({ center, radius, dmg, attacker, team, weapon }) },
  };
  return { game, events, blasts };
}

test('score since the last death earns streaks once per life', () => {
  const { game, events } = makeGame();
  const streaks = new Scorestreaks(game);
  const ready = [];
  events.on('streak:ready', (r) => ready.push(r.id));

  events.emit('score:award', { points: 400 });
  assert.deepEqual(ready, []);
  events.emit('score:award', { points: 100 });
  assert.deepEqual(ready, ['uav']);
  events.emit('player:death', {});
  assert.equal(streaks.points, 0);
  assert.ok(streaks.ready.has('uav'), 'an unused streak survives death');
  events.emit('score:award', { points: STREAKS.airstrike.cost });
  assert.deepEqual(ready, ['uav', 'uav', 'airstrike']);

  // Search & Destroy never charges streaks.
  game.state.mode = 'sd';
  events.emit('score:award', { points: 5000 });
  assert.equal(ready.length, 3);
});

test('the UAV key reveals enemies for its duration', () => {
  const { game, events } = makeGame();
  const streaks = new Scorestreaks(game);
  events.emit('score:award', { points: STREAKS.uav.cost });
  events.emit('input:keydown', { key: STREAKS.uav.key });
  assert.equal(streaks.uavActive(), true);
  assert.equal(streaks.ready.has('uav'), false);
  streaks.update(STREAKS.uav.duration + 0.1);
  assert.equal(streaks.uavActive(), false);
});

test('an airstrike walks three bombs from the crosshair point after a delay', () => {
  const { game, events, blasts } = makeGame();
  const streaks = new Scorestreaks(game);
  events.emit('score:award', { points: STREAKS.airstrike.cost });
  assert.equal(streaks.activate('airstrike'), true);
  streaks.update(AIRSTRIKE.DELAY - 0.05);
  assert.equal(blasts.length, 0);
  streaks.update(AIRSTRIKE.INTERVAL * AIRSTRIKE.BOMBS + 0.1);
  assert.equal(blasts.length, AIRSTRIKE.BOMBS);
  assert.ok(Math.abs(blasts[0].center.z + 10) < 0.5, 'first bomb lands where the crosshair meets the floor');
  assert.ok(blasts[2].center.z < blasts[0].center.z - 10, 'the run walks away from the caller');
  assert.equal(blasts[0].attacker, game.player);
  assert.equal(blasts[0].weapon, 'airstrike');
});

test('the bot side calls an enemy UAV every few team kills', () => {
  const { game, events } = makeGame();
  const streaks = new Scorestreaks(game);
  for (let i = 0; i < ENEMY_UAV_KILLS - 1; i++) events.emit('kill', { killerTeam: 't', victimTeam: 'ct' });
  assert.equal(streaks.enemyUavActive(), false);
  events.emit('kill', { killerTeam: 'ct', victimTeam: 't', killerIsLocal: true });
  events.emit('kill', { killerTeam: 't', victimTeam: 'ct' });
  assert.equal(streaks.enemyUavActive(), true);
});
