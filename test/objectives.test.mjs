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
  assert.ok(sym[1].pos.equals(v(0, 0)), 'B sits halfway between the spawns, not on the defenders\' anchor');
  assert.ok(sym[2].pos.equals(v(0, 20)), 'C sits between the Russian spawn and mid');

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

test('Hardpoint: one zone scores for a sole holder, freezes when contested, and rotates', async () => {
  const { Hardpoint, HP, hardpointZones } = await import('../src/game/objectives.js');
  const zones = hardpointZones(world());
  assert.ok(zones.length >= 3, 'mid, home flags and sites');
  assert.ok(zones[0].equals(v(0, 10)), 'mid goes first');

  const game = makeGame('hp');
  const hp = new Hardpoint(game);
  let moved = 0;
  game.events.on('objective:hardpoint', () => moved++);
  game.player.position.copy(hp.current());
  hp.update(3.5);
  assert.equal(hp.owner, 'ct');
  assert.equal(game.state.scores.ct, 3, 'one point per second held');

  game.bots.all[0].pos.copy(hp.current());
  hp.update(2);
  assert.equal(hp.contested, true);
  assert.equal(game.state.scores.ct, 3, 'contested time scores nothing');

  hp.update(HP.ROTATE);
  assert.equal(moved, 1);
  assert.equal(hp.index, 1);
  assert.equal(hp.hud()[0].name, 'HP');
  hp.stop();
  assert.equal(game.scene.children.length, 0);
});

test('Domination respawns lean toward flags the team holds', () => {
  const game = makeGame('dom');
  game.bots.resetForRound = () => {};
  game.bots.prepareTdm = () => {};
  game.player.resetForRound = () => {};
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.objective.flags[0].owner = 'ct';
  assert.deepEqual(tdm.objective.spawnAnchors('ct').map((p) => p.toArray()), [tdm.objective.flags[0].pos.toArray()]);
  assert.deepEqual(tdm.objective.spawnAnchors('t'), []);
});

test('Free-for-all scores per killer, ignores teams for spawns, and ranks the player', () => {
  const game = makeGame('ffa');
  const ally = { team: 'ct', alive: true, pos: v(5, -38), slot: 2, name: 'Ally' };
  game.bots.all.push(ally);
  game.bots.resetForRound = () => {};
  game.bots.prepareTdm = () => {};
  game.player.resetForRound = () => {};
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.goLive();

  // A U.S. bot killing the U.S. player scores in FFA.
  game.player.alive = false;
  game.events.emit('player:death', { killer: ally });
  assert.equal(game.state.scores.t, 1, 'leader is the ally bot');
  game.player.alive = true;
  for (let i = 0; i < 2; i++) game.events.emit('bot:death', { bot: ally, killer: game.player });
  assert.equal(game.state.scores.ct, 2);
  assert.equal(tdm.ffaStandings()[0].actor, game.player);

  let ended = null;
  game.events.on('game:end', (r) => { ended = r; });
  for (const b of tdm.ffaStandings()) void b;
  tdm.ffaKills.set(ally, MODE_RULES.ffa.scoreLimit);
  game.state.scores.t = MODE_RULES.ffa.scoreLimit;
  tdm.update(0.01);
  assert.equal(ended.ffa.place, 2);
  assert.equal(ended.ffa.leader, 'Ally');
  assert.notEqual(ended.winner, game.player.team);
});

test('Kill Confirmed bots go for confirms first and the killer is sent to its tag', () => {
  const game = { scene: null, player: { team: 'ct' }, state: { scores: { ct: 0, t: 0 } }, events: { emit() {} } };
  const kc = new KillConfirmed(game);
  kc.onDeath('ct', v(6, 0));  // own tag, 6 m away
  kc.onDeath('t', v(9, 0));   // enemy tag, 9 m away
  assert.ok(kc.botGoal({ team: 'ct', pos: v(0, 0) }).equals(v(9, 0)), 'a slightly further confirm beats a deny');
  kc.onDeath('ct', v(2, 0));
  assert.ok(kc.botGoal({ team: 'ct', pos: v(0, 0) }).equals(v(2, 0)), 'a deny at the bot\'s feet still wins');
  const far = new KillConfirmed(game);
  far.onDeath('ct', v(KC.BOT_DENY_RANGE + 5, 0));
  assert.equal(far.botGoal({ team: 'ct', pos: v(0, 0) }), null, 'bots do not cross the map to deny');
  assert.ok(far.botGoal({ team: 't', pos: v(0, 0) }), '...but will to confirm');

  // The respawn engine hands a bot killer to the bots for a fresh goal; the
  // player (a string tag in death payloads) is never retasked.
  const retasked = [];
  const engine = Object.assign(Object.create(TeamDeathmatch.prototype), {
    objective: kc, game: { bots: { retask: (b) => retasked.push(b) } },
  });
  const killer = { name: 'Havoc' };
  engine._retaskKiller(killer);
  engine._retaskKiller('player');
  engine._retaskKiller(null);
  assert.deepEqual(retasked, [killer]);
});
