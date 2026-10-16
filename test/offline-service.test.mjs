import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceOffline } from '../src/network/endpoints.js';
import { LeaderboardClient } from '../src/leaderboard/client.js';
import { EventBus } from '../src/shared/events.js';

test('serviceOffline reads the deployment config', () => {
  assert.equal(serviceOffline({ offline: true }), true);
  assert.equal(serviceOffline({ leaderboard: 'https://x.example.test/api/leaderboard' }), false);
  assert.equal(serviceOffline(undefined), false);
});

test('an offline leaderboard client never touches the network and reports matches as device-only', async () => {
  let calls = 0;
  const events = new EventBus();
  const unranked = [];
  events.on('leaderboard:unranked', (d) => unranked.push(d));
  const game = { events, state: { mode: 'sd' } };
  const client = new LeaderboardClient(game, {
    offline: true,
    fetchImpl: () => { calls++; return Promise.reject(new Error('no network')); },
    storage: null,
  });
  await assert.rejects(() => client.list('overall'));
  await assert.rejects(() => client.ensureSession({ refresh: true }));
  await client._onGameEnd({ winner: 'ct' });
  assert.equal(calls, 0);
  assert.deepEqual(unranked, [{ matchId: null, reason: 'offline' }]);
});
