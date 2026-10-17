// Ranked results at the edges of a room's life: FFA kills between players who
// share a uniform, a respawn-mode late joiner, a full room with churn, and a
// stale client packet reviving a remote the host has just killed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { WebSocket } from 'ws';
import { LeaderboardStore } from '../src/server/leaderboard.mjs';
import { rooms, server, setLeaderboardStore, startServer } from '../server.mjs';
import Multiplayer from '../src/network/multiplayer.js';
import { CONFIG } from '../src/shared/config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Buffer every message so a reply that lands before we ask is not lost. */
function inbox(ws) {
  ws.inbox = [];
  ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw.toString())));
}

async function nextOf(ws, types, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const i = ws.inbox.findIndex((m) => types.includes(m.type));
    if (i >= 0) return ws.inbox.splice(i, 1)[0];
    await sleep(10);
  }
  return null;
}

test('ranked results survive FFA same-uniform kills, respawn late joins and a churned full room', async (t) => {
  const directory = mkdtempSync(pathJoin(tmpdir(), 'tiny-strike-ranked-edges-'));
  setLeaderboardStore(new LeaderboardStore({ filePath: pathJoin(directory, 'leaderboard.json') }));
  startServer(0);
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const wsUrl = origin.replace('http:', 'ws:') + '/ws';
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  const token = async (name) => {
    const res = await fetch(`${origin}/api/leaderboard/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerName: name }),
    });
    return (await res.json()).token;
  };
  const join = async (hello) => {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await once(ws, 'open');
    inbox(ws);
    ws.send(JSON.stringify({ type: 'hello', authorityProtocol: 1, ...hello }));
    ws.info = await nextOf(ws, ['welcome']);
    assert.ok(ws.info, 'welcomed');
    return ws;
  };
  const send = (ws, msg) => ws.send(JSON.stringify(msg));

  // ---- FFA: everyone keeps a ct/t uniform, and a same-uniform kill is a kill.
  {
    const alpha = await join({ action: 'create', room: 'FFAEDG', name: 'Alpha', mode: 'humans', leaderboardToken: await token('Alpha') });
    const bravo = await join({ action: 'join', room: 'FFAEDG', name: 'Bravo', leaderboardToken: await token('Bravo') });
    const charlie = await join({ action: 'join', room: 'FFAEDG', name: 'Charlie', leaderboardToken: await token('Charlie') });
    send(alpha, { type: 'set_game_mode', gameMode: 'ffa' });
    await sleep(40);
    send(alpha, { type: 'start_match' });
    const start = await nextOf(alpha, ['match_start']);
    const room = rooms.get('FFAEDG');
    room.startedAt -= 300_000;
    const teamOf = (ws) => room.players.get(ws.info.id).team;
    const sameUniform = [bravo, charlie].find((ws) => teamOf(ws) === teamOf(alpha));
    assert.ok(sameUniform, 'two of three FFA players share a uniform');
    for (let i = 0; i < 30; i++) {
      const victim = i < 20 ? sameUniform : [bravo, charlie].find((ws) => ws !== sameUniform);
      send(alpha, { type: 'event', authorityEpoch: start.authorityEpoch, event: 'kill', data: {
        killerId: alpha.info.id, victimId: victim.info.id, victimTeam: teamOf(victim), headshot: false,
      } });
    }
    await sleep(60);
    assert.equal(room.matchStats.get(alpha.info.id).kills, 30, 'same-uniform FFA kills count');
    send(alpha, { type: 'snapshot', authorityEpoch: start.authorityEpoch, snapshot: { state: {
      phase: 'gameEnd', round: 1, mode: 'ffa', scores: { ct: 30, t: 0 },
      respawn: { ffa: [{ id: alpha.info.id, kills: 30 }, { id: bravo.info.id, kills: 0 }, { id: charlie.info.id, kills: 0 }] },
    } } });
    const res = await nextOf(alpha, ['leaderboard_result', 'leaderboard_error'], 3000);
    assert.equal(res?.type, 'leaderboard_result', res?.message || 'ranked');
  }

  // ---- TDM: a late joiner plays from the moment they are spawned.
  {
    const host = await join({ action: 'create', room: 'TDMEDG', name: 'Host', mode: 'humans', leaderboardToken: await token('Host') });
    const guest = await join({ action: 'join', room: 'TDMEDG', name: 'Guest', leaderboardToken: await token('Guest') });
    send(host, { type: 'set_game_mode', gameMode: 'tdm' });
    await sleep(40);
    send(host, { type: 'start_match' });
    const start = await nextOf(host, ['match_start']);
    const room = rooms.get('TDMEDG');
    room.startedAt -= 300_000;
    send(host, { type: 'snapshot', authorityEpoch: start.authorityEpoch, snapshot: { state: { phase: 'live', round: 1, mode: 'tdm', scores: { ct: 10, t: 10 } } } });
    const late = await join({ action: 'join', room: 'TDMEDG', name: 'Late', leaderboardToken: await token('Late') });
    assert.ok(room.matchStats.get(late.info.id), 'the late joiner has match stats');
    assert.ok(room.matchPlayers.some((p) => p.id === late.info.id));
    send(host, { type: 'respawn', authorityEpoch: start.authorityEpoch, targetId: late.info.id });
    await sleep(30);
    const lateTeam = room.players.get(late.info.id).team;
    const enemy = [host, guest].find((ws) => room.players.get(ws.info.id).team !== lateTeam);
    send(host, { type: 'event', authorityEpoch: start.authorityEpoch, event: 'kill', data: {
      killerId: late.info.id, victimId: enemy.info.id, victimTeam: room.players.get(enemy.info.id).team,
    } });
    await sleep(30);
    assert.equal(room.matchStats.get(late.info.id).kills, 1);
    send(host, { type: 'snapshot', authorityEpoch: start.authorityEpoch, snapshot: { state: { phase: 'gameEnd', round: 1, mode: 'tdm', scores: { ct: 50, t: 20 }, matchWinner: 'ct' } } });
    const res = await nextOf(late, ['leaderboard_result', 'leaderboard_error'], 3000);
    assert.equal(res?.type, 'leaderboard_result', 'the late joiner is not left on "verifying"');
  }

  // ---- S&D: one CT leaves a full room and another joins: six CTs played.
  {
    const players = [await join({ action: 'create', room: 'SDEDGE', name: 'P0', mode: 'humans' })];
    for (let i = 1; i < 10; i++) {
      players.push(await join({ action: 'join', room: 'SDEDGE', name: `P${i}`, leaderboardToken: i === 1 ? await token('TRanked') : '' }));
    }
    const room = rooms.get('SDEDGE');
    const ranked = players[1];
    const rankedTeam = room.players.get(ranked.info.id).team;
    const other = rankedTeam === 'ct' ? 't' : 'ct';
    send(players[0], { type: 'start_match' });
    const start = await nextOf(players[0], ['match_start']);
    room.startedAt -= 900_000;
    const leaver = players.find((p, i) => i > 1 && room.players.get(p.info.id).team === other);
    send(leaver, { type: 'leave_room' });
    await sleep(50);
    const newbie = await join({ action: 'join', room: 'SDEDGE', name: 'Newbie' });
    if (room.players.get(newbie.info.id).team !== other) send(newbie, { type: 'set_team', team: other });
    await sleep(30);
    send(players[0], { type: 'snapshot', authorityEpoch: start.authorityEpoch, snapshot: { state: { phase: 'freeze', round: 2, scores: { ct: 1, t: 0 }, roundResult: { winner: 'ct', reason: 'elimination' } } } });
    await sleep(50);
    assert.equal(room.matchPlayers.filter((p) => p.team === other).length, 6, 'six opponents played');
    // Eight rounds the server watched being played (as startedAt fakes the length).
    for (let r = 1; r <= 8; r++) room.roundLiveSpans[r] = { first: 0, last: 60_000 };
    send(players[0], { type: 'snapshot', authorityEpoch: start.authorityEpoch, snapshot: { state: { phase: 'gameEnd', round: 8, scores: { ct: 8, t: 0 }, matchWinner: 'ct' } } });
    const res = await nextOf(ranked, ['leaderboard_result', 'leaderboard_error'], 3000);
    assert.equal(res?.type, 'leaderboard_result', res?.message || 'ranked');
  }

  // ---- S&D: a host that claims more rounds than were played is not ranked.
  {
    const host = await join({ action: 'create', room: 'SDFAKE', name: 'Forger', mode: 'mixed', leaderboardToken: await token('Forger') });
    send(host, { type: 'set_game_mode', gameMode: 'sd' });
    await sleep(40);
    send(host, { type: 'start_match' });
    const start = await nextOf(host, ['match_start']);
    const room = rooms.get('SDFAKE');
    room.startedAt -= 900_000;
    room.roundLiveSpans[1] = { first: 0, last: 60_000 };       // one real round
    send(host, { type: 'snapshot', authorityEpoch: start.authorityEpoch, snapshot: { state: { phase: 'gameEnd', round: 1, scores: { ct: 8, t: 0 }, matchWinner: 'ct' } } });
    const res = await nextOf(host, ['leaderboard_result', 'leaderboard_error'], 3000);
    assert.equal(res?.type, 'leaderboard_error', 'an 8-0 after one round is refused');
  }
});

test('a stale state packet does not stand a remote the host has killed back up', () => {
  const remote = {
    networkId: 'x', alive: true, health: 100, armor: 0, damageSeq: 0,
    targetPosition: { set() {} }, mesh: { visible: true, rotation: { set() {} } }, characterId: 'vanguard',
  };
  const mp = Object.create(Multiplayer.prototype);
  Object.assign(mp, {
    active: true, connected: true, isHost: true, syncing: false, _authoritySuspended: false,
    _remoteById: new Map([['x', remote]]),
    game: { config: CONFIG, bots: null, hud: null, events: { emit() {} } },
  });
  // The host's kill: health 0, dead, hit sequence 1.
  remote.health = 0;
  mp._setRemoteAlive(remote, false);
  remote.damageSeq = 1;
  // The victim's own packet from before it heard of that hit.
  mp._applyPlayerState('x', { alive: true, health: 100, damageSeq: 0, pos: { x: 1, y: 0, z: 1 } });
  assert.equal(remote.alive, false);
  assert.equal(remote.health, 0);
  // Once the client has acked the hit, its state is current again.
  mp._applyPlayerState('x', { alive: true, health: 100, damageSeq: 1, pos: { x: 1, y: 0, z: 1 } });
  assert.equal(remote.alive, true, 'a real respawn still comes through');
});
