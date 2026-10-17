// Rank unlocks hold in the Search & Destroy buy menu, not just in classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Player from '../src/player/player.js';
import Weapons from '../src/weapons/weapons.js';
import Progression, { xpForRank } from '../src/game/progression.js';
import { CONFIG } from '../src/shared/config.js';
import { EventBus } from '../src/shared/events.js';

function makeGame() {
  const events = new EventBus();
  const game = {
    config: CONFIG, events,
    input: { firing: false, aiming: false, locked: true, isDown: () => false, consumeLook: () => ({ dx: 0, dy: 0 }), wasPressed: () => false },
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250),
    state: { phase: 'freeze', canBuy: true, money: 16000, buyOpen: true },
    bots: { all: [] },
    multiplayer: { active: false, remotePlayers: [] },
    world: { resolveMovement: (pos, delta) => ({ pos: pos.clone().add(delta), onGround: true }) },
  };
  const mem = new Map();
  game.progression = new Progression(null, { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) });
  game.player = new Player(game);
  game.weapons = new Weapons(game);
  return game;
}

test('a rank-locked weapon cannot be bought; it can once the rank is reached', () => {
  const game = makeGame();
  const w = game.weapons;
  assert.equal(w.buy('awp'), false, 'AWP is rank 12');
  assert.equal(w.buy('deagle'), false, 'Night Hawk is rank 6');
  assert.equal(game.state.money, 16000, 'nothing charged');
  assert.equal(w.buy('ak47'), true, 'unlocked guns still sell');
  assert.equal(w.buy('armor'), true, 'gear is never locked');

  game.progression.xp = xpForRank(12);
  assert.equal(w.buy('awp'), true);
  assert.ok(w.owns('awp'));
});

test('a match started from the menu deals a fresh loadout, not the last match\'s guns', () => {
  const game = makeGame();
  const w = game.weapons;
  w.resetForRound({ died: false });          // first match, round 1
  game.progression.xp = xpForRank(12);
  w.buy('awp');
  w.resetForRound({ died: false });          // a survivor keeps the AWP into round 2
  assert.equal(w.slots[1], 'awp');

  game.events.emit('ui:menu');
  game.events.emit('ui:start');              // PLAY from the menu
  w.resetForRound({ died: false });          // the new match's round 1
  assert.equal(w.slots[1], null, 'no AWP carried into a new match');
  assert.deepEqual(w.slots[4], []);
});
