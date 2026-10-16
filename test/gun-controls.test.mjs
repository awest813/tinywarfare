// Gun controls and mechanics found in the arm/gun audit: armor penetration,
// toggle aim, spray patterns long enough for every magazine, R pressed
// during a raise, Q after a loadout swap, and the throw returning to the gun.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Input from '../src/core/input.js';
import GameSettings from '../src/core/settings.js';
import Player from '../src/player/player.js';
import Weapons from '../src/weapons/weapons.js';
import { WEAPONS, armorDamageScale } from '../src/weapons/data.js';
import { CONFIG } from '../src/shared/config.js';
import { EventBus } from '../src/shared/events.js';

test('armor lets a sniper body shot kill, leaves legs bare, and stops little at the head', () => {
  const body = (weapon) => armorDamageScale({ weapon, part: 'body' });
  assert.ok(WEAPONS.awp.damage * body('awp') >= 100, 'one AWP body shot still kills through armor');
  assert.ok(body('knife') >= 0.85, 'a knife is not stopped by a vest');
  assert.ok(body('ak47') > body('glock'), 'rifles punch through more than pistols');
  assert.equal(armorDamageScale({ weapon: 'ak47', part: 'legs' }), 1);
  assert.equal(armorDamageScale({ weapon: 'ak47', headshot: true }), 0.85);
  assert.equal(armorDamageScale({ weapon: 'hegrenade' }, 0.5), 0.5, 'no armorPen falls back');
});

test('every automatic primary has spray pattern for an extended magazine', () => {
  for (const def of Object.values(WEAPONS)) {
    if (def.slot !== 1 || !def.recoil || !def.recoil.pattern) continue;
    assert.ok(def.recoil.pattern.length >= Math.round(def.magSize * 1.5),
      `${def.id}: ${def.recoil.pattern.length} pattern shots for a ${def.magSize}-round mag`);
  }
});

function eventBus() {
  const listeners = new Map();
  return {
    on(name, fn) { (listeners.get(name) || listeners.set(name, []).get(name)).push(fn); },
    off() {},
    emit(name, payload) { for (const fn of listeners.get(name) || []) fn(payload); },
  };
}

class FakeTarget {
  addEventListener() {}
  removeEventListener() {}
}

function installInputGlobals(t) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new FakeTarget();
  globalThis.document = Object.assign(new FakeTarget(), { visibilityState: 'visible', pointerLockElement: null });
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
}

test('toggle aim: a right click aims in, the next aims out, and a switch drops it', (t) => {
  installInputGlobals(t);
  const game = { debug: false, canvas: {}, events: eventBus() };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);
  input.locked = true;
  const click = () => {
    input._onMouseDown({ button: 2, target: null, preventDefault() {} });
    input._onMouseUp({ button: 2 });
  };

  click();
  assert.equal(input.aiming, false, 'hold mode: aim ends with the release');

  game.settings.setAimToggle(true);
  click();
  assert.equal(input.aiming, true, 'toggle mode: aim stays in after the release');
  click();
  assert.equal(input.aiming, false, 'and the next click takes it out');
  click();
  input.clearAimLatch();
  assert.equal(input.aiming, false, 'a weapon switch, reload, sprint or death drops it');

  // Touch AIM is a latch of its own and keeps working in toggle mode.
  input.setVirtualButton(2, true);
  assert.equal(input.aiming, true);
  input.setVirtualButton(2, false);
  assert.equal(input.aiming, false);
});

function makeGame() {
  const events = new EventBus();
  const input = {
    firing: false, aiming: false, locked: true,
    isDown: () => false, consumeLook: () => ({ dx: 0, dy: 0 }), wasPressed: () => false,
  };
  const game = {
    config: CONFIG, events, input,
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250),
    state: { phase: 'live', buyOpen: false },
    bots: { all: [] },
    multiplayer: { active: false, remotePlayers: [] },
    world: { resolveMovement: (pos, delta) => ({ pos: pos.clone().add(delta), onGround: true }) },
  };
  game.player = new Player(game);
  game.weapons = new Weapons(game);
  return game;
}

const run = (game, seconds, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) game.weapons.update(dt);
};

test('R pressed during a raise reloads when the raise ends; an empty gun drawn reloads itself', () => {
  const game = makeGame();
  const w = game.weapons;
  w.give('m4a1');
  w.give('usp');
  w.equip('m4a1');
  run(game, 1);
  w.ammo.m4a1.mag = 10;
  w.equip('usp');
  run(game, 0.6);
  w.equip('m4a1');
  run(game, 0.05);
  w._onKey({ key: 'r' });
  assert.equal(w._state, 'equipping');
  run(game, 0.5);
  assert.equal(w._state, 'reloading', 'the buffered R ran');

  run(game, 4);
  w.ammo.usp.mag = 0;
  w.equip('usp');
  run(game, 0.5);
  assert.equal(w._state, 'reloading', 'drawn empty, it reloads');
});

test('Q returns to the class sidearm after a respawn swap, and a throw returns to the gun', () => {
  const game = makeGame();
  const w = game.weapons;
  w.give('glock');
  w.give('m4a1');
  w.equip('glock');
  run(game, 1);
  w.equip('m4a1');           // lastWeaponId = glock
  w.give('deagle');          // the class sidearm replaces the team pistol
  run(game, 1);
  assert.equal(w.lastWeaponId, 'deagle');
  w._onKey({ key: 'q' });
  assert.equal(w.currentId, 'deagle');

  run(game, 1);
  w.give('hegrenade');
  w._onKey({ key: '4' });
  run(game, 0.6);
  assert.equal(w.currentId, 'hegrenade');
  w._onMouseDown({ button: 0 });
  run(game, 0.1);
  w._onMouseUp({ button: 0 });
  run(game, 1.2);
  assert.equal(w.currentId, 'deagle', 'back to the gun it was thrown from');
});

test('weapon keys do nothing on a body', () => {
  const game = makeGame();
  const w = game.weapons;
  w.give('m4a1');
  w.give('usp');
  w.equip('m4a1');
  run(game, 1);
  game.player.alive = false;
  w._onKey({ key: '2' });
  assert.equal(w.currentId, 'm4a1');
});

test('each gun keeps its own cooldown: a pistol drawn after an AWP shot fires, the AWP bolt is not skipped', () => {
  const game = makeGame();
  const w = game.weapons;
  const shots = [];
  game.events.on('weapon:fire', (e) => shots.push(e.weaponId));
  w.give('awp');
  w.give('usp');
  w.equip('awp');
  run(game, 1);
  w._onMouseDown({ button: 0 });
  run(game, 1 / 60);
  w._onMouseUp({ button: 0 });
  assert.deepEqual(shots, ['awp']);

  w.equip('usp');
  run(game, 0.4);              // raise done; the AWP bolt (1.46 s) is not
  w._onMouseDown({ button: 0 });
  run(game, 1 / 60);
  w._onMouseUp({ button: 0 });
  assert.deepEqual(shots, ['awp', 'usp'], 'the pistol fires straight away');

  w.equip('awp');
  run(game, 0.5);              // back up 0.93 s after the shot: still cycling
  w._onMouseDown({ button: 0 });
  run(game, 1 / 60);
  w._onMouseUp({ button: 0 });
  assert.deepEqual(shots, ['awp', 'usp'], 'a quick switch does not skip the bolt');
});

test('a bone-dry gun clicks once, then goes to the other gun (or the knife)', () => {
  const game = makeGame();
  const w = game.weapons;
  w.give('m4a1');
  w.give('usp');
  w.equip('m4a1');
  run(game, 1);
  w.ammo.m4a1.mag = 0;
  w.ammo.m4a1.reserve = 0;
  w._onMouseDown({ button: 0 });
  run(game, 1 / 60);
  w._onMouseUp({ button: 0 });
  assert.equal(w.currentId, 'usp');

  run(game, 1);
  w.ammo.usp.mag = 0;
  w.ammo.usp.reserve = 0;
  w._onMouseDown({ button: 0 });
  run(game, 1 / 60);
  assert.equal(w.currentId, 'knife', 'both guns dry: the knife');
});
