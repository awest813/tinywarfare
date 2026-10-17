import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Scorestreaks, { STREAKS, STREAK_KEYS, AIRSTRIKE, ENEMY_UAV_KILLS } from '../src/game/streaks.js';
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
  events.emit('input:keydown', { key: STREAK_KEYS[0] }); // slot one is the UAV by default
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

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
}

test('players pick two streaks; the picks persist and order by cost', () => {
  const storage = memoryStorage();
  const { game } = makeGame();
  const streaks = new Scorestreaks(game, storage);
  assert.deepEqual(streaks.selected, ['uav', 'airstrike']);
  streaks.selectStreaks(['airstrike', 'counteruav', 'uav']);
  assert.deepEqual(streaks.selected, ['counteruav', 'airstrike']);
  assert.deepEqual(new Scorestreaks(makeGame().game, storage).selected, ['counteruav', 'airstrike']);
  assert.deepEqual(streaks.selectStreaks(['bogus', 'uav', 'uav']), ['uav', 'airstrike'], 'junk and duplicates repair');
});

test('Counter-UAV jams the enemy UAV while it is up', () => {
  const { game, events } = makeGame();
  const streaks = new Scorestreaks(game, memoryStorage());
  streaks.selectStreaks(['counteruav', 'airstrike']);
  events.emit('score:award', { points: STREAKS.counteruav.cost });
  assert.ok(streaks.activateSlot(0));
  for (let i = 0; i < ENEMY_UAV_KILLS; i++) events.emit('kill', { killerTeam: 't', victimTeam: 'ct' });
  assert.equal(streaks.enemyUavActive(), false, 'jammed');
  streaks.update(STREAKS.counteruav.duration + 0.1);
  assert.equal(streaks.enemyUavActive(), true, 'the enemy UAV outlasts the jam');
});

test('a care package drops at the aim point and pays out on pickup', () => {
  const { game, events } = makeGame();
  game.weapons = { slots: { 1: null, 2: null }, ammo: {}, resupply() { this.resupplied = true; } };
  const streaks = new Scorestreaks(game, memoryStorage());
  streaks.selectStreaks(['carepackage', 'airstrike']);
  events.emit('score:award', { points: STREAKS.carepackage.cost });
  let payout = null;
  events.on('streak:package', (p) => { payout = p; });
  assert.ok(streaks.activateSlot(0));
  assert.equal(streaks.radarMarkers().length, 1);
  game.player.position.set(0, 0, -10); // walk to the drop under the crosshair
  streaks.update(1);
  assert.equal(payout, null, 'still falling');
  streaks.update(2.1);
  assert.ok(payout, 'collected once it lands');
  assert.equal(streaks.radarMarkers().length, 0);
  if (payout.reward === 'resupply') assert.ok(game.weapons.resupplied);
  else {
    assert.equal(streaks.bonus, payout.reward);
    assert.equal(streaks.status().at(-1).bonus, true);
  }
});

test('a streak key on the pause screen spends nothing', () => {
  const { game, events } = makeGame();
  const streaks = new Scorestreaks(game);
  events.emit('score:award', { points: STREAKS.uav.cost });
  assert.ok(streaks.ready.has('uav'));
  game.paused = true;
  assert.equal(streaks.activate('uav'), false);
  assert.ok(streaks.ready.has('uav'), 'still ready after the paused key');
  game.paused = false;
  assert.equal(streaks.activate('uav'), true);
});
