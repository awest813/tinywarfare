import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Combat, { ASSIST_WINDOW } from '../src/combat/combat.js';
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

test('a semi-auto clicked shortly after its cooldown does not get an early follow-up shot', async () => {
  const { default: Weapons } = await import('../src/weapons/weapons.js');
  const { EventBus } = await import('../src/shared/events.js');
  const THREE = await import('three');
  const events = new EventBus();
  const shots = [];
  const player = {
    alive: true, moveSpeed2D: 0, onGround: true, crouching: false,
    eyePos: () => new THREE.Vector3(0, 1.62, 0), addViewPunch() {},
  };
  const camera = { fov: 74, getWorldDirection(out) { return out.set(0, 0, -1); }, updateProjectionMatrix() {} };
  const input = { locked: true, firing: false };
  const weapons = new Weapons({ events, config: { PLAYER: { FOV: 74, RUN_SPEED: 5.2 } }, player, camera, state: { phase: 'live', buyOpen: false }, input });
  events.on('weapon:fire', () => shots.push(weapons._now));
  weapons.slots[2] = 'deagle';
  weapons.ammo.deagle = { mag: 7, reserve: 35 };
  weapons.currentId = 'deagle';
  weapons._state = 'idle';
  const interval = 60 / WEAPONS.deagle.rpm;
  const click = () => { weapons._onMouseDown({ button: 0 }); weapons.update(1 / 144); };
  click();
  // wait past the cooldown by most of an interval, then click twice quickly
  for (let t = 0; t < interval * 1.8; t += 1 / 144) weapons.update(1 / 144);
  click();
  for (let t = 0; t < interval * 1.2; t += 1 / 144) click();
  assert.ok(shots.length >= 3, `shots fired: ${shots.length}`);
  const gap = shots[2] - shots[1];
  assert.ok(gap >= interval - 1 / 144, `follow-up came ${gap.toFixed(3)} s after, interval ${interval.toFixed(3)}`);
});

test('recoil moves the aim and bullets follow the crosshair (no hidden offset)', async () => {
  const { default: Weapons } = await import('../src/weapons/weapons.js');
  const { EventBus } = await import('../src/shared/events.js');
  const THREE = await import('three');
  const events = new EventBus();
  const shots = [];
  const kicks = [];
  const player = {
    alive: true, moveSpeed2D: 0, onGround: true, crouching: false,
    eyePos: () => new THREE.Vector3(0, 1.62, 0), addViewPunch() {},
    applyRecoil(p, y) { kicks.push([p, y]); },
  };
  const camera = { fov: 74, getWorldDirection(out) { return out.set(0, 0, -1); }, updateProjectionMatrix() {} };
  const weapons = new Weapons({ events, config: { PLAYER: { FOV: 74, RUN_SPEED: 5.2 } }, player, camera, state: { phase: 'live', buyOpen: false }, input: { locked: true } });
  events.on('weapon:fire', (e) => shots.push(e.dir.clone()));
  weapons.currentId = 'ak47';
  weapons.ammo.ak47 = { mag: 30, reserve: 90 };
  weapons._bloom = 0;
  for (let i = 0; i < 6; i++) weapons._fireShot(WEAPONS.ak47, player, false);
  assert.equal(kicks.length, 6, 'every shot kicks the aim');
  assert.ok(kicks.every(([p]) => p > 0), 'the kick climbs');
  assert.equal(weapons._driftP, 0, 'no hidden drift accumulates');
  // With the camera held still, every bullet stays inside the base spread cone
  // around the crosshair: none of the climb is a hidden offset.
  const cone = WEAPONS.ak47.spreadBase + WEAPONS.ak47.bloomMax;
  for (const d of shots) assert.ok(Math.acos(-d.z) <= cone * 1.42 + 1e-9, `shot ${Math.acos(-d.z).toFixed(4)} off the crosshair`);

  // Aimed down sights the same shot kicks less.
  kicks.length = 0;
  weapons._recoilIndexF = 0;
  weapons._fireShot(WEAPONS.ak47, player, false);
  const hip = kicks[0][0];
  kicks.length = 0;
  weapons._recoilIndexF = 0;
  weapons.adsT = 1;
  weapons._fireShot(WEAPONS.ak47, player, false);
  assert.ok(kicks[0][0] < hip * 0.85, 'ADS cuts the kick');
});

test('a gun bought in the freeze is raised and ready to fire (no stuck equip)', () => {
  const events = new EventBus();
  const player = {
    alive: true, team: 'ct', moveSpeed2D: 0, onGround: true, crouching: false,
    eyePos: () => new THREE.Vector3(0, 1.62, 0), addViewPunch() {},
  };
  const camera = { fov: 74, getWorldDirection(out) { return out.set(0, 0, -1); }, updateProjectionMatrix() {} };
  const state = { mode: 'sd', phase: 'freeze', canBuy: true, money: 8000, buyOpen: false };
  const weapons = new Weapons({ events, config: CONFIG, player, camera, state, input: { locked: true } });
  assert.ok(weapons.buy('m4a1'), 'the buy goes through');
  assert.equal(weapons.currentId, 'm4a1');
  assert.ok(Number.isFinite(weapons._stateDur), `raise time ${weapons._stateDur}`);
  for (let i = 0; i < 60; i++) weapons.update(1 / 60);
  assert.equal(weapons._state, 'idle', 'the raise finishes');
  state.phase = 'live';
  state.canBuy = false;
  let shots = 0;
  events.on('weapon:fire', () => shots++);
  weapons._onMouseDown({ button: 0 });
  weapons.update(1 / 60);
  assert.ok(shots >= 1, 'the bought gun fires');
});

test('kill events carry the killer\'s distance and credit the player\'s assist', () => {
  const player = shooter();
  const mate = { team: 'ct', alive: true, name: 'Falcon', pos: new THREE.Vector3(5, 0, 0) };
  const events = new EventBus();
  const mortal = (overrides) => makeBot({
    ...overrides,
    takeDamage(amount, info) {
      this.health -= amount;
      if (this.health <= 0 && this.alive) {
        this.alive = false;
        events.emit('bot:death', { bot: this, killer: info.from, weapon: info.weapon, headshot: !!info.headshot });
      }
    },
  });
  const viper = mortal({ name: 'Viper', pos: new THREE.Vector3(0, 0, -30) });
  const havoc = mortal({ name: 'Havoc', pos: new THREE.Vector3(0, 0, -8) });
  const game = { events, config: CONFIG, player, bots: { all: [viper, havoc] }, multiplayer: null, state: { mode: 'tdm' } };
  const combat = new Combat(game);
  const kills = [];
  events.on('kill', (e) => kills.push(e));

  // The player wounds Viper; a teammate finishes it: the player assisted.
  combat._applyDamage(viper, false, 40, player, 'm4a1', false, 'body', true);
  combat.update(3);
  combat._applyDamage(viper, false, 100, mate, 'ak47', false, 'body', false);
  assert.equal(kills[0].killerName, 'Falcon');
  assert.equal(kills[0].assistIsLocal, true);
  assert.equal(kills[0].distance, Math.round(Math.hypot(5, 30) * 10) / 10, 'killer-to-victim distance');

  // The player's own kill is not also an assist, and carries its distance.
  combat._applyDamage(havoc, false, 40, player, 'm4a1', false, 'body', true);
  combat._applyDamage(havoc, false, 100, player, 'm4a1', false, 'body', true);
  assert.equal(kills[1].killerIsLocal, true);
  assert.equal(kills[1].assistIsLocal, false);
  assert.equal(kills[1].distance, 8);

  // A wound older than the window earns nothing.
  const late = mortal({ name: 'Wolf', pos: new THREE.Vector3(0, 0, -10) });
  game.bots.all.push(late);
  combat._applyDamage(late, false, 40, player, 'm4a1', false, 'body', true);
  combat.update(ASSIST_WINDOW + 1);
  combat._applyDamage(late, false, 100, mate, 'ak47', false, 'body', false);
  assert.equal(kills[2].assistIsLocal, false);
});
