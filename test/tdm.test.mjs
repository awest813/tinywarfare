import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import TeamDeathmatch, { TDM, pickSafeSpawn, normalizeModeId, tdmLoadout } from '../src/game/tdm.js';
import { EventBus } from '../src/shared/events.js';

const v = (x, z) => new THREE.Vector3(x, 0, z);

test('mode ids normalize to Search & Destroy by default', () => {
  assert.equal(normalizeModeId('tdm'), 'tdm');
  assert.equal(normalizeModeId('sd'), 'sd');
  assert.equal(normalizeModeId('ffa'), 'sd');
  assert.equal(normalizeModeId(undefined), 'sd');
  assert.equal(normalizeModeId('__proto__'), 'sd');
});

test('spawns stay away from enemies, out of sight, and near friends', () => {
  const candidates = [{ pos: v(0, 0) }, { pos: v(30, 0) }, { pos: v(-30, 0) }];
  const noRandom = { random: () => 0 };

  // The enemy sits on the first candidate: never spawn on top of them.
  let pick = pickSafeSpawn(candidates, [v(1, 0)], [], noRandom);
  assert.notEqual(pick.pos.x, 0);

  // Both far candidates are equally distant; the one beside a friend wins.
  pick = pickSafeSpawn(candidates, [v(0, 40)], [v(-28, 2)], noRandom);
  assert.equal(pick.pos.x, -30);

  // A candidate an enemy can see loses to one it cannot.
  const seesOnlyEast = (origin) => origin.x < 0; // blocked (hit) unless east
  pick = pickSafeSpawn(
    [{ pos: v(40, 0) }, { pos: v(-40, 0) }],
    [v(0, 20)],
    [],
    { random: () => 0, raycast: (origin) => (seesOnlyEast(origin) ? { hit: true } : null) },
  );
  assert.equal(pick.pos.x, -40);

  // Spawns face the nearest enemy (yaw 0 looks down -Z).
  pick = pickSafeSpawn([{ pos: v(0, 30) }], [v(0, 0)], [], noRandom);
  assert.ok(Math.abs(pick.yaw) < 1e-9);
  assert.equal(pickSafeSpawn([], [], []), null);
});

function makeGame() {
  const events = new EventBus();
  const bots = [
    { name: 'A', team: 'ct', alive: true, pos: v(0, -30) },
    { name: 'B', team: 't', alive: true, pos: v(0, 30) },
  ];
  const respawned = [];
  const equipped = [];
  const game = {
    events,
    state: { phase: 'menu', mode: 'tdm', scores: { ct: 0, t: 0 }, round: 0, timer: 0 },
    world: {
      spawns: { ct: [{ pos: v(0, -30), yaw: 0 }], t: [{ pos: v(0, 30), yaw: Math.PI }] },
      waypoints: { nodes: [{ pos: v(20, 0) }, { pos: v(-20, 0) }] },
    },
    bots: {
      all: bots,
      resetForRound() {},
      prepareTdm() {},
      respawnTdmBot(bot, spawn) { bot.alive = true; bot.pos.copy(spawn.pos); respawned.push(bot.name); },
    },
    player: {
      team: 'ct', alive: true, armor: 50, position: v(0, -30),
      resetForRound(spawn) { this.alive = true; if (spawn) this.position.copy(spawn.pos); },
    },
    weapons: {
      resetForRound() { equipped.length = 0; },
      give(id) { equipped.push(id); return true; },
      equip(id) { equipped.push(`equip:${id}`); return true; },
    },
  };
  return { game, bots, respawned, equipped };
}

test('a TDM match scores kills, respawns everyone, and ends at the score limit', () => {
  const { game, bots, respawned, equipped } = makeGame();
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  assert.equal(game.state.phase, 'freeze');
  assert.equal(game.player.armor, 0);
  assert.deepEqual(equipped, ['usp', 'hegrenade', 'm4a1', 'equip:m4a1']);
  assert.equal(tdmLoadout('t').primary, 'ak47');

  // Deaths during the get-ready window do not score.
  bots[1].alive = false;
  game.events.emit('bot:death', { bot: bots[1] });
  assert.equal(game.state.scores.ct, 0);
  bots[1].alive = true;

  tdm.goLive();
  assert.equal(game.state.timer, TDM.TIME_LIMIT);

  bots[1].alive = false;
  game.events.emit('bot:death', { bot: bots[1] });
  assert.equal(game.state.scores.ct, 1, 'killing a Russian bot scores for the U.S.');

  game.player.alive = false;
  game.events.emit('player:death', {});
  assert.equal(game.state.scores.t, 1);
  assert.equal(tdm.playerRespawnIn(), TDM.RESPAWN_DELAY);

  let respawnEvents = 0;
  game.events.on('player:respawn', () => respawnEvents++);
  tdm.update(TDM.RESPAWN_DELAY - 0.1);
  assert.equal(game.player.alive, false);
  assert.equal(bots[1].alive, false);
  tdm.update(0.2);
  assert.equal(game.player.alive, true);
  assert.equal(respawnEvents, 1);
  assert.equal(tdm.playerRespawnIn(), null);
  assert.deepEqual(respawned, ['B']);

  let ended = null;
  game.events.on('game:end', (result) => { ended = result; });
  game.state.scores.ct = TDM.SCORE_LIMIT;
  tdm.update(0.01);
  assert.equal(game.state.phase, 'gameEnd');
  assert.equal(ended.winner, 'ct');
  assert.equal(ended.mode, 'tdm');
  assert.equal(ended.draw, false);
});

test('a TDM match that times out level is a draw', () => {
  const { game } = makeGame();
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.goLive();
  game.state.scores.ct = 7;
  game.state.scores.t = 7;
  let ended = null;
  game.events.on('game:end', (result) => { ended = result; });
  tdm.update(TDM.TIME_LIMIT + 1);
  assert.equal(ended.winner, null);
  assert.equal(ended.draw, true);
});

test('TDM ignores deaths when Search & Destroy is the active mode', () => {
  const { game, bots } = makeGame();
  const tdm = new TeamDeathmatch(game);
  game.state.mode = 'sd';
  game.state.phase = 'live';
  game.events.emit('bot:death', { bot: bots[1] });
  game.events.emit('player:death', {});
  assert.deepEqual(game.state.scores, { ct: 0, t: 0 });
  assert.equal(tdm.playerRespawnIn(), null);
});
