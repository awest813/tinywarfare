import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { KillConfirmed, KC, Domination, Hardpoint } from '../src/game/objectives.js';
import TeamDeathmatch, { TDM } from '../src/game/tdm.js';
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

/** A game whose multiplayer seat is the authority (host) or a replica. */
function makeGame(mode, { authority = true, remotes = [] } = {}) {
  const events = new EventBus();
  const sent = [];
  const game = {
    events,
    scene: new THREE.Scene(),
    state: { mode, phase: 'live', scores: { ct: 0, t: 0 }, timer: 600 },
    world: world(),
    player: { team: 'ct', alive: true, position: v(0, -40), networkId: 'me', resetForRound() {}, protect() {} },
    bots: { all: [], resetForRound() {}, prepareTdm() {} },
    multiplayer: {
      active: true,
      localId: 'me',
      remotePlayers: remotes,
      isAuthority: () => authority,
      sendRespawn: (targetId, spawn) => sent.push({ targetId, spawn }),
      _setRemoteAlive: (remote, alive) => { remote.alive = alive; },
    },
  };
  return { game, sent };
}

function remote(id, team, pos) {
  const position = pos.clone();
  return { networkId: id, name: id, team, alive: true, position, pos: position, targetPosition: position.clone() };
}

test('KC tags, DOM flags and the hardpoint survive a snapshot round trip', () => {
  const host = makeGame('kc').game;
  const replica = makeGame('kc', { authority: false }).game;
  const kcHost = new KillConfirmed(host);
  const kcReplica = new KillConfirmed(replica);
  kcHost.onDeath('t', v(5, 5));
  kcHost.onDeath('ct', v(-5, 5));
  kcReplica.applyNetworkSnapshot(JSON.parse(JSON.stringify(kcHost.networkSnapshot())));
  assert.deepEqual(kcReplica.tags.map((t) => t.team), ['t', 'ct']);
  assert.equal(replica.scene.children.length, 2, 'replica builds tag meshes');
  kcHost._removeTag(0);
  kcReplica.applyNetworkSnapshot(kcHost.networkSnapshot());
  assert.deepEqual(kcReplica.tags.map((t) => t.team), ['ct'], 'collected tags disappear');
  kcReplica.replicaUpdate(0.1);

  const domHost = new Domination(host);
  const domReplica = new Domination(replica);
  domHost.flags[1].owner = 'ct';
  domHost.flags[1].control = 1;
  domHost.flags[2].control = -0.4;
  const flags = [];
  replica.events.on('objective:flag', (e) => flags.push(e.name + e.owner));
  domReplica.applyNetworkSnapshot(domHost.networkSnapshot());
  assert.deepEqual(domReplica.hud().map((f) => [f.name, f.owner, f.control]),
    [['A', null, 0], ['B', 'ct', 1], ['C', null, -0.4]]);
  assert.deepEqual(flags, ['Bct'], 'ownership changes are announced on replicas');

  const hpHost = new Hardpoint(host);
  const hpReplica = new Hardpoint(replica);
  hpHost.index = 2;
  hpHost.clock = 12.5;
  hpHost.owner = 't';
  hpReplica.applyNetworkSnapshot(hpHost.networkSnapshot());
  assert.equal(hpReplica.index, 2);
  assert.equal(hpReplica.owner, 't');
  assert.equal(hpReplica.clock, 12.5);
});

test('the authority scores remote deaths and respawns remote players through the room', () => {
  const guest = remote('guest', 't', v(0, 30));
  const { game, sent } = makeGame('tdm', { remotes: [guest] });
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.goLive();

  guest.alive = false;
  game.events.emit('remote:death', { player: guest, killer: game.player });
  assert.equal(game.state.scores.ct, 1, 'a remote death scores for the other side');
  tdm.update(TDM.RESPAWN_DELAY - 0.1);
  assert.equal(sent.length, 0);
  tdm.update(0.2);
  assert.equal(guest.alive, true);
  assert.equal(guest.spawnProtection, TDM.SPAWN_PROTECTION);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetId, 'guest');
  assert.ok(sent[0].spawn && sent[0].spawn.pos, 'the room hears where the player spawned');

  // A seat that arrives dead (late join) is deployed without a death event.
  const late = remote('late', 'ct', v(0, -30));
  late.alive = false;
  game.multiplayer.remotePlayers.push(late);
  tdm.update(0.05);
  tdm.update(TDM.RESPAWN_DELAY);
  assert.equal(late.alive, true);
  assert.equal(sent.at(-1).targetId, 'late');

  // The host's own respawn is announced too, so the room marks it alive.
  game.player.alive = false;
  game.events.emit('player:death', { killer: guest });
  tdm.update(TDM.RESPAWN_DELAY + 0.1);
  assert.equal(sent.at(-1).targetId, 'me');
});

test('replicas never score locally and show their own FFA standing', () => {
  const { game } = makeGame('ffa', { authority: false });
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.goLive();
  game.player.alive = false;
  game.events.emit('player:death', { killer: { team: 't' } });
  assert.equal(game.state.scores.t, 0, 'scoring belongs to the authority');
  assert.ok(tdm.playerRespawnIn() > 0, 'the countdown still runs');
  tdm.respawnLocal({ pos: v(1, 1), yaw: 0 });
  assert.equal(tdm.playerRespawnIn(), null);

  tdm.applyNetworkSnapshot({ ffa: [
    { id: 'host', name: 'Hosty', kills: 7 },
    { id: 'me', name: 'Guesty', kills: 4 },
    { id: 'bot:Wolf', name: 'Wolf', kills: 2 },
  ] });
  assert.deepEqual(game.state.scores, { ct: 4, t: 7 }, 'own kills vs the best rival');
  const end = tdm.endReplica();
  assert.equal(end.ffa.place, 2);
  assert.equal(end.ffa.leader, 'Hosty');
});

test('the authority snapshot lists humans in FFA standings by network id', () => {
  const guest = remote('guest', 't', v(0, 30));
  const { game } = makeGame('ffa', { remotes: [guest] });
  game.bots.all.push({ name: 'Wolf', team: 't', alive: true, pos: v(10, 10) });
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.goLive();
  guest.alive = false;
  game.events.emit('remote:death', { player: guest, killer: game.player });
  game.events.emit('bot:death', { bot: game.bots.all[0], killer: guest });
  const rows = tdm.networkSnapshot().ffa;
  assert.deepEqual(rows.map((r) => [r.id, r.kills]), [['me', 1], ['guest', 1], ['bot:Wolf', 0]]);
});

test('a replica promoted to authority keeps FFA kills and revives bots that died before', () => {
  const { game } = makeGame('ffa', { authority: false });
  const wolf = { name: 'Wolf', team: 't', alive: true, pos: v(10, 10) };
  game.bots.all.push(wolf);
  game.bots.respawnTdmBot = (bot) => { bot.alive = true; };
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  tdm.goLive();
  tdm.applyNetworkSnapshot({ ffa: [{ id: 'bot:Wolf', name: 'Wolf', kills: 25 }, { id: 'me', name: 'Me', kills: 20 }] });
  wolf.alive = false; // died while this seat was a replica: no local death event scheduled it

  game.multiplayer.isAuthority = () => true;
  tdm.update(0.05);
  game.events.emit('bot:death', { bot: { name: 'Other', team: 'ct', pos: v(0, 0) }, killer: game.player });
  assert.equal(game.state.scores.ct, 21, 'my tally continues from the standings');
  assert.equal(game.state.scores.t, 25);
  tdm.update(TDM.RESPAWN_DELAY + 0.1);
  assert.equal(wolf.alive, true, 'the dead bot is respawned by its new authority');
});

test('Kill Confirmed tags copied by a replica keep their remaining lifetime', () => {
  const host = makeGame('kc').game;
  const replica = makeGame('kc', { authority: false }).game;
  const a = new KillConfirmed(host);
  const b = new KillConfirmed(replica);
  a.onDeath('t', v(1, 1));
  a.update(KC.TAG_LIFETIME - 10);
  b.applyNetworkSnapshot(a.networkSnapshot());
  b.update(11); // promoted: the tag had ~10 s left
  assert.equal(b.tags.length, 0);
});

test('an FFA tie for first is a draw, and FFA bots start spread out with protection', () => {
  const { game } = makeGame('ffa', { authority: true });
  const spawned = [];
  game.bots.all.push({ name: 'Wolf', team: 't', alive: true, pos: v(0, 40) }, { name: 'Bear', team: 't', alive: true, pos: v(1, 40) });
  game.bots.respawnTdmBot = (bot, spawn, protection) => { spawned.push([bot.name, protection]); };
  game.multiplayer.active = false;
  const tdm = new TeamDeathmatch(game);
  tdm.startMatch();
  assert.deepEqual(spawned, [['Wolf', TDM.SPAWN_PROTECTION], ['Bear', TDM.SPAWN_PROTECTION]]);
  tdm.ffaKills.set(game.player, 12);
  tdm.ffaKills.set(game.bots.all[0], 12);
  const end = tdm.endPayload();
  assert.equal(end.draw, true);
  assert.equal(end.winner, null);
});
