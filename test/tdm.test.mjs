import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import TeamDeathmatch, { TDM, pickSafeSpawn, normalizeModeId, tdmLoadout } from '../src/game/tdm.js';
import { EventBus } from '../src/shared/events.js';

const v = (x, z) => new THREE.Vector3(x, 0, z);

test('mode ids normalize to Search & Destroy by default', () => {
  assert.equal(normalizeModeId('tdm'), 'tdm');
  assert.equal(normalizeModeId('sd'), 'sd');
  assert.equal(normalizeModeId('ffa'), 'ffa');
  assert.equal(normalizeModeId('gungame'), 'sd');
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

test('the lazy spawn search picks exactly what scoring every candidate would', () => {
  // A seeded generator so both searches draw the same per-candidate jitter.
  const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const exhaustive = (candidates, enemies, friends, raycast, random) => {
    let best = null; let bestScore = -Infinity;
    for (const c of candidates) {
      let near = Infinity; let seen = 0; let friend = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(e.x - c.pos.x, e.z - c.pos.z);
        near = Math.min(near, d);
        if (d < 60) {
          const eye = new THREE.Vector3(c.pos.x, c.pos.y + 1.6, c.pos.z);
          const to = new THREE.Vector3(e.x - eye.x, e.y + 1.6 - eye.y, e.z - eye.z);
          const dist = to.length();
          if (dist > 1e-3 && !raycast(eye, to.multiplyScalar(1 / dist), dist)) seen++;
        }
      }
      for (const f of friends) friend = Math.min(friend, Math.hypot(f.x - c.pos.x, f.z - c.pos.z));
      let score = Math.min(near, 45);
      if (near < TDM.SAFE_DISTANCE) score -= 100;
      score -= seen * 40;
      if (friend < 22) score += 8;
      score += random() * 6;
      if (score > bestScore) { bestScore = score; best = c.pos; }
    }
    return best;
  };
  // Walls: a ray is blocked when it crosses x = 0 between |z| < 20.
  const raycast = (o, d, dist) => {
    if (Math.abs(d.x) < 1e-6) return null;
    const t = -o.x / d.x;
    if (t <= 0 || t >= dist) return null;
    return Math.abs(o.z + d.z * t) < 20 ? { distance: t } : null;
  };
  const rand = seeded(7);
  let raysLazy = 0;
  for (let trial = 0; trial < 40; trial++) {
    const point = () => v(Math.round(rand() * 120 - 60), Math.round(rand() * 120 - 60));
    const candidates = Array.from({ length: 40 }, () => ({ pos: point(), yaw: 0 }));
    const enemies = Array.from({ length: 9 }, point);
    const friends = trial % 2 ? Array.from({ length: 3 }, point) : [];
    const seed = 1000 + trial;
    const want = exhaustive(candidates, enemies, friends, raycast, seeded(seed));
    const got = pickSafeSpawn(candidates, enemies, friends, {
      random: seeded(seed), raycast: (...a) => { raysLazy++; return raycast(...a); },
    });
    assert.ok(got.pos.equals(want), `trial ${trial}: lazy ${got.pos.toArray()} vs exhaustive ${want.toArray()}`);
  }
  assert.ok(raysLazy < 40 * 40 * 9 * 0.5, `the lazy search skips most sight lines (${raysLazy})`);
});

test('objective anchors pull respawns toward the fight without breaking the safety floor', () => {
  const noRandom = { random: () => 0 };
  const zone = v(0, 0);
  const enemies = [v(0, 2)];                       // the enemy holds the zone
  const near = { pos: v(24, 0), yaw: 0 };          // 22 m from that enemy, by the zone
  const far = { pos: v(60, 40), yaw: 0 };          // as far from everyone as the map allows
  const tooClose = { pos: v(6, 0), yaw: 0 };       // on the zone, inside SAFE_DISTANCE
  const candidates = [far, near, tooClose];
  assert.ok(pickSafeSpawn(candidates, enemies, [], noRandom).pos.equals(far.pos), 'without anchors: farthest');
  const pick = pickSafeSpawn(candidates, enemies, [], { ...noRandom, anchors: [zone] });
  assert.ok(pick.pos.equals(near.pos), `with the zone as anchor: ${pick.pos.toArray()}`);
});

test('a player killed during the countdown still respawns once the match is live', () => {
  const { game } = makeGame();
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  // Dies in the get-ready window: the live-phase death handler ignores it.
  game.player.alive = false;
  game.events.emit('player:death', {});
  assert.equal(tdm.playerRespawnIn(), null);
  tdm.goLive();
  tdm.update(0.01);
  assert.equal(tdm.playerRespawnIn() > 0, true, 'the missed respawn is scheduled');
  tdm.update(TDM.RESPAWN_DELAY + 0.1);
  assert.equal(game.player.alive, true);
});
