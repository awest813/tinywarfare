import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import Killcam, { KILLCAM } from '../src/player/killcam.js';
import { EventBus } from '../src/shared/events.js';

function rig({ online = false, killcamSetting = true } = {}) {
  const events = new EventBus();
  const pressed = new Set();
  const tracers = [];
  const alive = [];
  const player = {
    position: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0, alive: true, team: 'ct',
    crouching: false, velocity: new THREE.Vector3(), lastKiller: null,
  };
  // The killer stands 20 m north (−Z) of the player, facing south toward them.
  const killer = {
    name: 'Havoc', team: 't', pos: new THREE.Vector3(0, 0, -20), yaw: Math.PI, aimPitch: 0,
    alive: true, weaponId: 'awp', moveSpeed2D: 0, mesh: { visible: true },
  };
  const game = {
    events,
    state: { phase: 'live', mode: 'tdm' },
    player,
    bots: {
      all: [killer],
      createOperativeVisual(actor) {
        actor.mesh = { position: new THREE.Vector3(), rotation: { y: 0 }, visible: false, name: '' };
        return actor.mesh;
      },
      rebuildOperativeVisual() {},
      setOperativeAlive(actor, on) { actor.alive = on; alive.push([actor.name, on]); },
      updateOperativeVisual() {},
    },
    scene: { add() {} },
    world: { raycast: () => null },
    effects: { _onTracer: (p) => tracers.push(p) },
    input: { wasActionPressed: (id) => pressed.has(id) },
    settings: { killcam: killcamSetting },
    profile: { characterId: 'vanguard' },
    weapons: { currentId: 'm4a1' },
    multiplayer: { active: online, remotePlayers: [] },
  };
  const kc = new Killcam(game);
  const run = (seconds, step = 1 / 60) => { for (let t = 0; t < seconds - 1e-9; t += step) kc.update(step); };
  const die = () => {
    player.alive = false;
    player.lastKiller = killer;
    events.emit('player:death', { killer, weapon: 'awp', headshot: true });
  };
  return { game, kc, run, die, player, killer, tracers, pressed, alive };
}

test('the killcam replays the last moments over the killer\'s shoulder and lets the victim fall', () => {
  const { game, kc, run, die, killer, tracers, alive } = rig();
  run(1.5);
  // The killer strafes east while firing the killing shot.
  killer.pos.x = 2;
  run(0.5);
  game.events.emit('fx:tracer', { from: new THREE.Vector3(2, 1.5, -19.5), to: new THREE.Vector3(0, 1.4, 0), weaponId: 'awp' });
  die();
  assert.equal(kc.holdsRespawn(), true, 'a solo respawn waits for the replay');
  assert.equal(kc.active, false, 'the collapse lands first');
  run(KILLCAM.START_AFTER + 0.05);
  assert.equal(kc.active, true);
  assert.deepEqual(kc.info().weaponId, 'awp');
  assert.equal(kc.info().distance, 20);
  assert.equal(kc.info().headshot, true);
  assert.equal(killer.mesh.visible, false, 'the live killer is hidden behind its ghost');

  const camera = new THREE.PerspectiveCamera();
  assert.equal(kc.applyCamera(camera), true);
  // Facing +Z (yaw π): the camera sits behind the killer, i.e. further north.
  assert.ok(camera.position.z < killer.pos.z, 'behind the killer');
  assert.ok(camera.position.y > 1.6, 'at eye height and a little above');

  run(kc.remaining() + 0.1);
  assert.equal(kc.active, false, 'the replay ends');
  assert.equal(kc.holdsRespawn(), false);
  assert.equal(killer.mesh.visible, true, 'the live killer is back');
  assert.ok(tracers.length >= 1, 'the killing tracer flew again');
  assert.deepEqual(alive.at(-1), ['killcam-victim', false], 'the victim ghost fell');
});

test('the replay lasts under three seconds, with the kill in slow motion', () => {
  const { kc, run, die } = rig();
  run(2);
  die();
  run(KILLCAM.START_AFTER + 0.02);
  const total = kc.remaining();
  assert.ok(total > 2.3 && total < 3.0, `replay ${total.toFixed(2)} s`);
});

test('jump or a click skips; online and with the setting off there is no hold', () => {
  const a = rig();
  a.run(2);
  a.die();
  a.run(KILLCAM.START_AFTER + 0.1);
  a.pressed.add('jump');
  a.run(0.02);
  assert.equal(a.kc.active, false);
  assert.equal(a.kc.holdsRespawn(), false, 'a skipped killcam respawns at the usual time');

  const b = rig();
  b.run(2);
  b.die();
  b.run(KILLCAM.START_AFTER + 0.1);
  b.game.events.emit('input:mousedown', { button: 0 });
  assert.equal(b.kc.active, false);

  const online = rig({ online: true });
  online.run(2);
  online.die();
  assert.equal(online.kc.holdsRespawn(), false, 'the room decides when you respawn');

  const off = rig({ killcamSetting: false });
  off.run(2);
  off.die();
  assert.equal(off.kc.clip, null);
});

test('no killcam without a killer, for a suicide, or for a killer with no recorded past', () => {
  const { game, kc, run, player, killer } = rig();
  run(2);
  player.alive = false;
  player.lastKiller = null;
  game.events.emit('player:death', {});
  assert.equal(kc.clip, null);
  player.lastKiller = player;
  game.events.emit('player:death', {});
  assert.equal(kc.clip, null, 'suicide');
  const newcomer = { ...killer, name: 'Late', pos: new THREE.Vector3(5, 0, 5) };
  player.lastKiller = newcomer;
  game.events.emit('player:death', {});
  assert.equal(kc.clip, null, 'a body that just appeared has no past to replay');
});

test('a respawn or the end of the round cancels the replay', () => {
  const { game, kc, run, die, killer } = rig();
  run(2);
  die();
  run(KILLCAM.START_AFTER + 0.1);
  assert.equal(kc.active, true);
  game.events.emit('player:respawn', {});
  assert.equal(kc.active, false);
  assert.equal(killer.mesh.visible, true);
});
