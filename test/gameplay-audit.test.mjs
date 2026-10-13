import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Scorestreaks from '../src/game/streaks.js';
import { EventBus } from '../src/shared/events.js';

test('a care-package resupply refills the loadout actually equipped, not locked picks', () => {
  const events = new EventBus();
  let resupplied = null;
  const game = {
    events,
    state: { mode: 'tdm', phase: 'live' },
    weapons: { resupply: (loadout) => { resupplied = loadout; } },
    loadouts: { active: () => ({ lethal: 'semtex', tactical: 'stun' }) },
    rounds: { tdm: { equippedLoadout: { lethal: 'hegrenade', tactical: 'flashbang' } } },
  };
  const streaks = new Scorestreaks(game, null);
  streaks._resupply();
  assert.deepEqual(resupplied, { lethal: 'hegrenade', tactical: 'flashbang' });
});

test('an airstrike spares its caller but not enemies', async () => {
  const { default: Combat } = await import('../src/combat/combat.js');
  const hits = [];
  const actor = (name, team, pos) => ({
    name, team, alive: true, pos, position: pos, height: 1.8,
    takeDamage: (dmg) => hits.push(name),
  });
  const caller = actor('caller', 'ct', new THREE.Vector3(0, 0, 0));
  const enemy = actor('enemy', 't', new THREE.Vector3(1, 0, 0));
  const game = { events: new EventBus(), state: { mode: 'tdm' }, player: caller, bots: { all: [enemy] } };
  const combat = Object.create(Combat.prototype);
  combat.game = game;
  combat._v6 = new THREE.Vector3();
  combat._isPlayer = (a) => a === caller;
  combat._losClear = () => true;
  combat._radialDamage(new THREE.Vector3(0, 0.9, 0), 9, 400, caller, 'ct', 'airstrike', true, false);
  assert.deepEqual(hits, ['enemy']);
  hits.length = 0;
  combat._radialDamage(new THREE.Vector3(0, 0.9, 0), 9, 400, caller, 'ct', 'hegrenade', true, false);
  assert.deepEqual(hits, ['caller', 'enemy'], 'your own frag still hurts you');
});
