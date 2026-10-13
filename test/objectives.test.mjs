import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { KillConfirmed, Domination, DOM, KC, dominationPoints } from '../src/game/objectives.js';
import TeamDeathmatch, { MODE_RULES, isRespawnMode } from '../src/game/tdm.js';
import { EventBus } from '../src/shared/events.js';

const v = (x, z) => new THREE.Vector3(x, 0, z);

function world() {
  return {
    bombSites: [{ name: 'A', center: v(30, 0) }, { name: 'B', center: v(-30, 0) }],
    botTactics: { defenseAreas: [{ sector: 'mid', anchor: v(0, 10) }] },
    spawns: { ct: [{ pos: v(0, -40), yaw: 0 }], t: [{ pos: v(0, 40), yaw: Math.PI }] },
    waypoints: { nodes: [] },
  };
}

function makeGame(mode) {
  const events = new EventBus();
  return {
    events,
    scene: new THREE.Scene(),
    state: { mode, phase: 'live', scores: { ct: 0, t: 0 }, timer: 0 },
    world: world(),
    player: { team: 'ct', alive: true, position: v(0, -40) },
    bots: { all: [
      { team: 't', alive: true, pos: v(0, 40), slot: 0 },
      { team: 'ct', alive: true, pos: v(0, -38), slot: 1 },
    ] },
  };
}

test('mode table: KC and DOM are respawn modes whose kills do not score directly', () => {
  assert.ok(isRespawnMode('kc') && isRespawnMode('dom') && isRespawnMode('tdm'));
  assert.equal(isRespawnMode('sd'), false);
  assert.equal(MODE_RULES.kc.killScore, 0);
  assert.equal(MODE_RULES.dom.killScore, 0);
});

test('Kill Confirmed: enemies confirm, teammates deny, tags expire', () => {
  const game = makeGame('kc');
  const kc = new KillConfirmed(game);
  const personal = [];
  game.events.on('objective:score', (e) => personal.push(e.label));

  kc.onDeath('t', v(5, 5));          // a Russian falls
  assert.equal(game.scene.children.length, 1, 'a tag mesh appears');
  game.player.position.copy(v(5.5, 5));
  kc.update(0.1);
  assert.equal(game.state.scores.ct, 1, 'the U.S. confirms it');
  assert.deepEqual(personal, ['KILL CONFIRMED']);
  assert.equal(game.scene.children.length, 0);

  kc.onDeath('ct', v(-5, -5));       // a U.S. soldier falls
  game.player.position.copy(v(-5, -5.5));
  kc.update(0.1);
  assert.equal(game.state.scores.ct, 1, 'denying scores nothing');
  assert.equal(game.state.scores.t, 0);
  assert.deepEqual(personal, ['KILL CONFIRMED', 'KILL DENIED']);

  kc.onDeath('t', v(50, 50));
  game.player.position.copy(v(0, 0));
  kc.update(KC.TAG_LIFETIME + 1);
  assert.equal(kc.tags.length, 0, 'uncollected tags expire');

  kc.onDeath('t', v(20, 0));
  assert.ok(kc.botGoal({ pos: v(10, 0) }).equals(v(20, 0)), 'bots detour for a near tag');
  assert.equal(kc.botGoal({ pos: v(-50, 0) }), null);
});

test('Domination: flags from the map, capture, contest, neutralise, and tick scoring', () => {
  const pts = dominationPoints(world());
  assert.deepEqual(pts.map((p) => p.name), ['A', 'B', 'C']);
  assert.ok(pts[1].pos.equals(v(0, 10)), 'B is the mid defence anchor');
  assert.ok(pts[0].pos.equals(v(30, 0)), 'no nav data: A falls back to site A');

  // With spawns and nav nodes the layout is symmetric between the spawns.
  const navWorld = world();
  navWorld.waypoints.nodes = [-30, -20, -10, 0, 10, 20, 30].map((z) => ({ pos: v(0, z) }));
  const sym = dominationPoints(navWorld);
  assert.ok(sym[0].pos.equals(v(0, -20)), 'A sits between the U.S. spawn and mid');
  assert.ok(sym[1].pos.equals(v(0, 10)));
  assert.ok(sym[2].pos.equals(v(0, 30)), 'C sits between the Russian spawn and mid');

  const game = makeGame('dom');
  const dom = new Domination(game);
  const A = dom.flags[0];
  let captured = null;
  game.events.on('objective:flag', (e) => { captured = e; });

  game.player.position.copy(A.pos);
  for (let t = 0; t < DOM.CAPTURE_TIME * 0.5; t += 0.1) dom.update(0.1);
  assert.equal(A.owner, null, 'half way is not a capture');
  for (let t = 0; t < DOM.CAPTURE_TIME; t += 0.1) dom.update(0.1);
  assert.equal(A.owner, 'ct');
  assert.equal(captured.name, 'A');

  // An enemy on the point contests it: control freezes.
  game.bots.all[0].pos.copy(A.pos);
  const held = A.control;
  dom.update(1);
  assert.equal(A.contested, true);
  assert.equal(A.control, held);

  // Alone, the enemy neutralises then takes it.
  game.player.position.copy(v(0, -40));
  for (let t = 0; t < DOM.CAPTURE_TIME * 1.1; t += 0.1) dom.update(0.1);
  assert.equal(A.owner, null, 'neutralised past zero');
  for (let t = 0; t < DOM.CAPTURE_TIME * 1.1; t += 0.1) dom.update(0.1);
  assert.equal(A.owner, 't');

  // Held flags score one point per tick for their owner.
  game.bots.all[0].pos.copy(v(0, 40));
  const before = game.state.scores.t;
  dom.update(DOM.SCORE_TICK);
  assert.equal(game.state.scores.t, before + 1);

  // Bots go for flags their side does not hold.
  assert.ok(dom.botGoal({ team: 'ct', pos: v(25, 0), slot: 0 }).equals(A.pos));
  dom.stop();
  assert.equal(game.scene.children.length, 0);
});

test('the respawn engine drives KC scoring through dropped tags', () => {
  const game = makeGame('kc');
  game.bots.resetForRound = () => {};
  game.bots.prepareTdm = () => {};
  game.player.resetForRound = () => {};
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.goLive();
  const bot = game.bots.all[0];
  bot.alive = false;
  game.events.emit('bot:death', { bot });
  assert.equal(game.state.scores.ct, 0, 'a KC kill alone scores nothing');
  assert.equal(tdm.objective.tags.length, 1);
  game.player.position.copy(bot.pos);
  tdm.update(0.05);
  assert.equal(game.state.scores.ct, 1);
});
