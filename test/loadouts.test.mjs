import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Loadouts, { DEFAULT_CLASSES, LOADOUT_STORAGE_KEY, PERK_TUNING, sanitizeClass } from '../src/game/loadouts.js';
import TeamDeathmatch from '../src/game/tdm.js';
import Player from '../src/player/player.js';
import Weapons from '../src/weapons/weapons.js';
import { CONFIG } from '../src/shared/config.js';
import { EventBus } from '../src/shared/events.js';

function memoryStorage(initial = null) {
  const data = new Map(initial ? [[LOADOUT_STORAGE_KEY, initial]] : []);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), data };
}

test('classes repair bad items and persist edits and the selection', () => {
  const fixed = sanitizeClass({ name: '<b>x</b> team!', primary: 'rpg', perk: 'wallhack' }, DEFAULT_CLASSES[0]);
  assert.equal(fixed.name, 'BXB TEAM', 'markup characters are stripped');
  assert.equal(fixed.primary, DEFAULT_CLASSES[0].primary);
  assert.equal(fixed.perk, DEFAULT_CLASSES[0].perk);

  const storage = memoryStorage();
  const loadouts = new Loadouts({ events: new EventBus(), state: {} }, storage);
  loadouts.edit(4, { primary: 'awp', perk: 'ghost', name: 'pick' });
  loadouts.select(4);
  const again = new Loadouts({ events: new EventBus(), state: {} }, storage);
  assert.equal(again.selected, 4);
  assert.equal(again.active().primary, 'awp');
  assert.equal(again.active().name, 'PICK');
  again.resetClass(4);
  assert.deepEqual(again.active(), { ...DEFAULT_CLASSES[4] });

  // Corrupt storage falls back to defaults.
  const broken = new Loadouts({ events: new EventBus(), state: {} }, memoryStorage('{nope'));
  assert.equal(broken.selected, 0);
});

test('keys 1-5 pick the next class only while dead in TDM', () => {
  const events = new EventBus();
  const game = { events, state: { mode: 'tdm' }, player: { alive: true } };
  const loadouts = new Loadouts(game, memoryStorage());
  events.emit('input:keydown', { key: '3' });
  assert.equal(loadouts.selected, 0, 'alive: digits switch weapons, not classes');
  game.player.alive = false;
  events.emit('input:keydown', { key: '3' });
  assert.equal(loadouts.selected, 2);
  game.state.mode = 'sd';
  events.emit('input:keydown', { key: '1' });
  assert.equal(loadouts.selected, 2);
});

function makeGame() {
  const events = new EventBus();
  const game = {
    config: CONFIG,
    events,
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250),
    state: { phase: 'live', mode: 'tdm', scores: { ct: 0, t: 0 }, buyOpen: false },
    input: { consumeLook: () => ({ dx: 0, dy: 0 }), isDown: () => false, firing: false, aiming: false },
    bots: { all: [], resetForRound() {}, prepareTdm() {} },
    multiplayer: { active: false, remotePlayers: [] },
    world: { spawns: { ct: [{ pos: new THREE.Vector3(), yaw: 0 }], t: [] }, waypoints: { nodes: [] } },
  };
  game.player = new Player(game);
  game.weapons = new Weapons(game);
  game.loadouts = new Loadouts(game, memoryStorage());
  return game;
}

test('a TDM spawn deals the selected class and its perk', () => {
  const game = makeGame();
  game.loadouts.select(2); // RECON SNIPER
  new TeamDeathmatch(game).startMatch();
  const w = game.weapons;
  assert.equal(w.slots[1], 'awp');
  assert.equal(w.slots[2], 'usp');
  assert.deepEqual([...w.slots[4]].sort(), ['hegrenade', 'smokegrenade']);
  assert.equal(game.player.perk2, 'ghost');
  assert.equal(game.player.perk, 'scavenger');
});

test('perks change reloads, swaps, and explosive damage', () => {
  const game = makeGame();
  const w = game.weapons;
  w.give('m4a1');
  w.currentId = 'm4a1';
  w._state = 'idle';
  w.ammo.m4a1.mag = 5;

  w._startReload();
  const plain = w._stateDur;
  w._state = 'idle';
  game.player.perk = 'quickhands';
  w._startReload();
  assert.ok(Math.abs(w._stateDur - plain * PERK_TUNING.QUICKHANDS_RELOAD) < 1e-9);

  game.player.perk = 'flakjacket';
  game.player.takeDamage(60, { weapon: 'hegrenade' });
  assert.equal(game.player.health, 100 - Math.round(60 * PERK_TUNING.FLAK_SCALE));
  game.player.takeDamage(10, { weapon: 'ak47' });
  assert.equal(game.player.health, 100 - Math.round(60 * PERK_TUNING.FLAK_SCALE) - 10);
});

test('attachments: extended mags reload to the larger size and grips cut recoil', () => {
  const game = makeGame();
  const w = game.weapons;
  game.player.attachment = 'extmag';
  w.give('m4a1');
  assert.equal(w.ammo.m4a1.mag, Math.round(30 * PERK_TUNING.EXTMAG_SCALE));
  w.currentId = 'm4a1';
  w._state = 'idle';
  w.ammo.m4a1.mag = 2;
  w._startReload();
  w.update(5);
  assert.equal(w.ammo.m4a1.mag, 45);

  const drift = (attachment) => {
    game.player.attachment = attachment;
    w._driftP = 0;
    w._recoilIndexF = 5;
    w._fireShot(w.current(), { ...game.player, eyePos: () => new THREE.Vector3(0, 1.6, 0), addViewPunch() {} }, false);
    return w._driftP;
  };
  assert.ok(Math.abs(drift('grip') - drift(null) * PERK_TUNING.GRIP_RECOIL) < 1e-9);

  // Stored classes without an attachment get the slot default.
  const fixed = sanitizeClass({ primary: 'ak47' }, DEFAULT_CLASSES[3]);
  assert.equal(fixed.attachment, 'extmag');
});
