import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Combat from '../src/combat/combat.js';
import Weapons from '../src/weapons/weapons.js';
import Player from '../src/player/player.js';
import Scorestreaks, { STREAKS } from '../src/game/streaks.js';
import { WEAPONS } from '../src/weapons/data.js';
import { DEFAULT_CLASSES, PERK_TUNING, sanitizeClass } from '../src/game/loadouts.js';
import { CONFIG } from '../src/shared/config.js';
import { EventBus } from '../src/shared/events.js';

function makeBot(overrides = {}) {
  const bot = {
    alive: true,
    team: 't',
    pos: new THREE.Vector3(0, 0, -6),
    radius: 0.35,
    height: 1.83,
    health: 100,
    crouching: false,
    takeDamage(amount, info) {
      this.health -= amount;
      this.lastHit = info;
      if (this.health <= 0) this.alive = false;
    },
    ...overrides,
  };
  return bot;
}

function shooter() {
  return { team: 'ct', alive: true, name: 'You', networkId: null, position: new THREE.Vector3(), isPlayer: true };
}

function combatGame(bots, extra = {}) {
  const events = new EventBus();
  const game = {
    events,
    config: CONFIG,
    player: null,
    bots: { all: bots },
    multiplayer: null,
    ...extra,
  };
  return { game, events, combat: new Combat(game) };
}

test('every shotgun pellet is resolved as its own hit', () => {
  const bot = makeBot();
  const { combat } = combatGame([bot], { player: shooter() });
  const straight = new THREE.Vector3(0, -0.12, -1).normalize(); // chest at 6 m
  combat._onWeaponFire({
    weaponId: 'shotgun',
    origin: new THREE.Vector3(0, 1.62, 0),
    dir: straight,
    pellets: Array.from({ length: WEAPONS.shotgun.pellets - 1 }, () => straight.clone()),
  });
  const perPellet = WEAPONS.shotgun.damage;
  assert.ok(bot.health <= 100 - perPellet * 4, `8 pellets at 6 m should be lethal-ish, health ${bot.health}`);
  assert.equal(bot.alive, false);
});

test('pellet arrays are bounded by the weapon and ignore junk', () => {
  const bot = makeBot({ health: 10000 });
  const { combat } = combatGame([bot], { player: shooter() });
  const dir = new THREE.Vector3(0, -0.12, -1).normalize();
  combat._onWeaponFire({
    weaponId: 'ak47', // not a shotgun: extra pellets must not fire
    origin: new THREE.Vector3(0, 1.62, 0),
    dir,
    pellets: Array.from({ length: 30 }, () => dir.clone()),
  });
  assert.ok(bot.health > 10000 - WEAPONS.ak47.damage * 4 - 1, 'only the one rifle bullet lands');
  combat._onWeaponFire({
    weaponId: 'shotgun',
    origin: new THREE.Vector3(0, 1.62, 0),
    dir,
    pellets: [null, { x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
  });
});

test('a semtex sticks to the first enemy it touches and is lethal to its host', () => {
  const victim = makeBot({ pos: new THREE.Vector3(0, 0, -3) });
  const thrower = { team: 'ct', alive: true, position: new THREE.Vector3(), velocity: new THREE.Vector3() };
  const { combat, events } = combatGame([victim]);
  let stuck = null;
  events.on('grenade:stuck', (e) => { stuck = e.victim; });
  events.emit('grenade:throw', {
    type: 'semtex',
    origin: new THREE.Vector3(0, 1.2, -1.2),
    dir: new THREE.Vector3(0, 0, -1),
    strength: 8,
    thrower,
  });
  for (let i = 0; i < 30 && !stuck; i++) combat._updateProjectiles(1 / 60);
  assert.equal(stuck, victim);
  victim.pos.set(5, 0, -3); // the host runs; the charge rides along
  for (let i = 0; i < 180; i++) combat._updateProjectiles(1 / 60);
  assert.equal(victim.alive, false);
  assert.equal(victim.lastHit.weapon, 'semtex');
});

test('a stun burst slows the player and sends bots into a stun', () => {
  const events = new EventBus();
  const game = {
    config: CONFIG,
    events,
    camera: new THREE.PerspectiveCamera(),
    state: { phase: 'live' },
    input: { consumeLook: () => ({ dx: 0, dy: 0 }), isDown: () => false },
    bots: { all: [], applyStun(pos, range) { this.stunned = { pos, range }; } },
    multiplayer: { active: false, remotePlayers: [] },
  };
  const player = new Player(game);
  game.player = player;
  player.position.set(0, 0, 0);
  const combat = new Combat(game);
  combat._detonateStun({ pos: new THREE.Vector3(0, 0.5, -3) });
  assert.ok(player.stunned > 2, 'close stun lasts a few seconds');
  assert.ok(game.bots.stunned, 'bots receive the burst');
  player.update(5);
  assert.equal(player.stunned, 0);
});

test('Scavenger refills reserve on kills; Hardline discounts streaks; old classes migrate', () => {
  const events = new EventBus();
  const player = { alive: true, perk: 'scavenger', perk2: 'hardline', team: 'ct' };
  const game = { events, config: CONFIG, player, state: { mode: 'tdm', phase: 'live' }, camera: { fov: 74, updateProjectionMatrix() {} } };
  const weapons = new Weapons(game);
  weapons.give('m4a1');
  weapons.ammo.m4a1.reserve = 0;
  events.emit('kill', { killerIsLocal: true });
  assert.equal(weapons.ammo.m4a1.reserve, WEAPONS.m4a1.magSize);

  const streaks = new Scorestreaks(game);
  assert.equal(streaks.costOf('uav'), Math.round(STREAKS.uav.cost * PERK_TUNING.HARDLINE_COST));
  events.emit('score:award', { points: streaks.costOf('uav') });
  assert.ok(streaks.ready.has('uav'));

  // A saved single-perk class holding a tier-2 perk moves it to slot two.
  const migrated = sanitizeClass({ primary: 'awp', perk: 'ghost' }, DEFAULT_CLASSES[0]);
  assert.equal(migrated.perk2, 'ghost');
  assert.equal(migrated.perk, DEFAULT_CLASSES[0].perk);
});
