import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LeaderboardError,
  newLeaderboardData,
  rankedOutcome,
  submitMatchToData,
  validateLeaderboardResult,
} from '../src/shared/leaderboard-core.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');

function result(overrides = {}) {
  return {
    matchId: 'match-tdm-0001',
    mode: 'bots',
    gameMode: 'tdm',
    mapId: 'dustyard',
    winner: 'ct',
    teamWon: true,
    scores: { ct: 50, t: 31 },
    kills: 18,
    deaths: 9,
    headshots: 5,
    duration: 420,
    ...overrides,
  };
}

test('a finished TDM result validates as one match with no rounds or bomb objectives', () => {
  const match = validateLeaderboardResult(result(), NOW);
  assert.equal(match.gameMode, 'tdm');
  assert.equal(match.result, 'win');
  assert.equal(match.roundsPlayed, 1);
  assert.equal(match.roundsWon, 1);
  assert.equal(match.plants, 0);
  assert.equal(match.splits.bots.kills, 18);
  // Old clients that send no gameMode still mean Search & Destroy.
  const sd = validateLeaderboardResult({
    ...result({ gameMode: undefined, scores: { ct: 8, t: 3 } }),
    roundsPlayed: 11,
    kills: 12,
    deaths: 4,
  }, NOW);
  assert.equal(sd.gameMode, 'sd');
  assert.equal(sd.roundsPlayed, 11);
});

test('respawn results must be complete, plausible, and within the mode limits', () => {
  const rejects = (overrides, status) => assert.throws(
    () => validateLeaderboardResult(result(overrides), NOW),
    (error) => error instanceof LeaderboardError && (status ? error.status === status : true),
  );
  rejects({ gameMode: 'gungame' }, 400);
  rejects({ scores: { ct: 59, t: 3 } }, 400);                // well past the TDM limit
  assert.equal(validateLeaderboardResult(result({ scores: { ct: 53, t: 3 } }), NOW).result, 'win', 'a final multi-kill');
  rejects({ scores: { ct: 20, t: 10 }, duration: 300 }, 400);  // neither limit nor clock
  rejects({ kills: 150, duration: 420 }, 422);               // kill rate
  rejects({ deaths: 400 }, 400);                              // death rate
  rejects({ duration: 30 }, 422);
  // The clock ran out short of the limit: still a completed match.
  assert.equal(validateLeaderboardResult(result({ scores: { ct: 22, t: 18 }, duration: 605 }), NOW).result, 'win');
  // Domination ticks may overshoot the limit slightly.
  assert.equal(validateLeaderboardResult(result({ gameMode: 'dom', scores: { ct: 152, t: 90 } }), NOW).result, 'win');
  // A tied timeout is a draw.
  assert.equal(validateLeaderboardResult(result({ winner: 'draw', scores: { ct: 20, t: 20 }, duration: 600 }), NOW).result, 'draw');
});

test('free-for-all results come from own kills versus the best rival', () => {
  const win = validateLeaderboardResult(result({
    gameMode: 'ffa', winner: 'ct', teamWon: false, scores: { ct: 30, t: 22 }, kills: 30,
  }), NOW);
  assert.equal(win.result, 'win', 'scores decide, not team flags');
  const loss = validateLeaderboardResult(result({ gameMode: 'ffa', scores: { ct: 12, t: 30 }, kills: 12 }), NOW);
  assert.equal(loss.result, 'loss');
  assert.throws(() => validateLeaderboardResult(result({ gameMode: 'ffa', scores: { ct: 30, t: 3 }, kills: 10 }), NOW),
    /cannot exceed the reported kills/);
});

test('room outcomes are rebuilt per participant, FFA from the standings', () => {
  const team = rankedOutcome('kc', { scores: { ct: 30, t: 12 } }, { id: 'a', team: 't' });
  assert.deepEqual(team, { winner: 'ct', teamWon: false, scores: { ct: 30, t: 12 }, roundsPlayed: 1 });
  const sd = rankedOutcome('sd', { scores: { ct: 8, t: 6 }, matchWinner: 'ct' }, { id: 'a', team: 'ct' });
  assert.equal(sd.roundsPlayed, 14);
  const state = { scores: { ct: 30, t: 17 }, respawn: { ffa: [
    { id: 'host', kills: 30 }, { id: 'guest', kills: 17 }, { id: 'bot:Wolf', kills: 9 },
  ] } };
  assert.deepEqual(rankedOutcome('ffa', state, { id: 'guest', team: 't' }).scores, { ct: 17, t: 30 });
  assert.equal(rankedOutcome('ffa', state, { id: 'host', team: 'ct' }).winner, 'ct');
});

test('a respawn-mode result scores and is recorded with its game mode', () => {
  const data = newLeaderboardData();
  data.players.p1 = { id: 'p1', name: 'Tester' };
  const response = submitMatchToData(data, 'p1', result(), NOW);
  assert.equal(response.accepted, true);
  assert.equal(response.result.gameMode, 'tdm');
  assert.ok(response.result.points.overall > 0);
});
