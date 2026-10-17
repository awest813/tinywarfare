import test from 'node:test';
import assert from 'node:assert/strict';

import Progression, {
  LOCAL_PROGRESS_KEY, MATCH_XP, UNLOCK_RANK, WEAPON_LEVEL_XP, WEAPON_XP_PER_KILL,
  rankFromXp, xpForRank,
} from '../src/game/progression.js';
import { DEFAULT_CLASSES } from '../src/game/loadouts.js';
import { STREAK_IDS } from '../src/game/streaks.js';
import { EventBus } from '../src/shared/events.js';

function memoryStorage(initial = null) {
  const data = new Map(initial ? [[LOCAL_PROGRESS_KEY, initial]] : []);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
}

test('rank curve is monotonic and round-trips', () => {
  assert.equal(xpForRank(1), 0);
  for (let r = 2; r <= 30; r++) {
    assert.ok(xpForRank(r) > xpForRank(r - 1));
    assert.equal(rankFromXp(xpForRank(r)), r);
    assert.equal(rankFromXp(xpForRank(r) - 1), r - 1);
  }
});

test('a new player plays every default class with locked items swapped', () => {
  const p = new Progression(null, memoryStorage());
  assert.equal(p.rank(), 1);
  const sniper = p.resolveLoadout(DEFAULT_CLASSES[2]); // AWP + suppressor + scavenger
  assert.notEqual(sniper.primary, 'awp');
  assert.ok(p.isUnlocked(sniper.primary));
  assert.equal(sniper.attachment, 'none', 'attachments need weapon levels');
  assert.ok(p.isUnlocked(sniper.perk) && p.isUnlocked(sniper.perk2));
  assert.deepEqual(p.resolveStreaks(['carepackage', 'airstrike'], STREAK_IDS), ['airstrike', 'uav']);
});

test('matches pay score plus a result bonus, rank up, and level weapons', () => {
  const events = new EventBus();
  const storage = memoryStorage();
  const p = new Progression({ events }, storage);
  let shown = null;
  events.on('progress:local', (b) => { shown = b; });
  const kills = { m4a1: 5 };
  const result = p.awardMatch({ score: 2000, result: 'win', kills });
  assert.equal(result.earned, 2000 + MATCH_XP.WIN);
  assert.equal(shown, result);
  assert.equal(result.after, rankFromXp(2500));
  assert.ok(result.unlocks.includes('shotgun'), 'rank 2+ unlocks the shotgun');
  assert.equal(p.weaponLevel('m4a1'), 2);
  assert.deepEqual(result.weaponUps, [{ id: 'm4a1', level: 2, attachments: ['laser'] }]);
  assert.ok(p.attachmentUnlocked('m4a1', 'laser'));
  assert.equal(p.attachmentUnlocked('m4a1', 'suppressor'), false);
  assert.equal(5 * WEAPON_XP_PER_KILL >= WEAPON_LEVEL_XP[1], true);

  const again = new Progression(null, storage);
  assert.equal(again.xp, 2500, 'persisted');
  assert.equal(again.weaponLevel('m4a1'), 2);
  const corrupt = new Progression(null, memoryStorage('{oops'));
  assert.equal(corrupt.xp, 0);
});

test('game:end awards the match from the live score and local kills', () => {
  const events = new EventBus();
  const game = { events, player: { team: 'ct' }, score: { total: 900 } };
  const p = new Progression(game, memoryStorage());
  events.emit('ui:start');
  events.emit('kill', { killerIsLocal: true, weaponId: 'ak47', killerTeam: 'ct', victimTeam: 't' });
  events.emit('kill', { killerIsLocal: false, weaponId: 'ak47' });
  // Only primaries level up (attachments): no "KNIFE LEVEL 2 · LASER".
  for (const id of ['knife', 'hegrenade', 'airstrike', 'usp']) {
    for (let i = 0; i < 4; i++) events.emit('kill', { killerIsLocal: true, weaponId: id, killerTeam: 'ct', victimTeam: 't' });
  }
  let breakdown = null;
  events.on('progress:local', (b) => { breakdown = b; });
  events.emit('game:end', { winner: 't' });
  assert.equal(p.xp, 900 + MATCH_XP.LOSS);
  assert.equal(p.weaponXp.ak47, WEAPON_XP_PER_KILL);
  assert.deepEqual(Object.keys(p.weaponXp), ['ak47']);
  assert.deepEqual(breakdown.weaponUps, []);
  assert.ok(Object.values(UNLOCK_RANK).every((r) => r >= 2 && r <= 30));
});

test('unlocks are spread across the ladder, awards happen once, quitting keeps what was earned', async () => {
  const { default: Progression, UNLOCK_RANK: U, FINAL_UNLOCK_RANK } = await import('../src/game/progression.js');
  const { EventBus } = await import('../src/shared/events.js');
  assert.ok(FINAL_UNLOCK_RANK >= 20, 'something left to earn deep into the ladder');
  const ranks = Object.values(U);
  assert.ok(new Set(ranks).size === ranks.length, 'one unlock per rank step');

  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const events = new EventBus();
  const game = { events, state: { mode: 'tdm', phase: 'live' }, player: { team: 'ct' }, score: { total: 900 } };
  const prog = new Progression(game, storage);
  events.emit('ui:start');
  events.emit('kill', { killerIsLocal: true, weaponId: 'm4a1', killerTeam: 'ct', victimTeam: 't' });
  events.emit('game:end', { winner: 'ct' });
  const after = prog.xp;
  events.emit('game:end', { winner: 'ct' });
  assert.equal(prog.xp, after, 'a second game:end pays nothing');

  events.emit('ui:start');
  events.emit('kill', { killerIsLocal: true, weaponId: 'm4a1', killerTeam: 'ct', victimTeam: 't' });
  game.state.phase = 'menu';
  events.emit('ui:menu');
  assert.equal(prog.xp, after + 900, 'a quit match pays its score, no result bonus');
  assert.equal(prog.weaponXp.m4a1, 200);

  store.set('tiny-strike-progress-v1', '{"xp":1e400,"weaponXp":{"m4a1":1e400}}');
  const loaded = new Progression({ events: new EventBus() }, storage);
  assert.ok(Number.isFinite(loaded.xp) && Number.isFinite(loaded.weaponXp.m4a1 ?? 0));
});

test('a synced career restores unlocks on a new device, and never lowers them', () => {
  const events = new EventBus();
  const synced = [];
  events.on('progress:sync', (d) => synced.push(d));
  const storage = memoryStorage();
  const p = new Progression({ events }, storage);
  assert.equal(p.rank(), 1);

  events.emit('progress:updated', { progression: { xp: xpForRank(12) + 10 }, source: 'resume' });
  assert.equal(p.rank(), 12, 'the AWP is back without replaying');
  assert.ok(p.isUnlocked('awp'));
  assert.deepEqual(synced.map((d) => [d.before, d.after]), [[1, 12]]);
  assert.equal(JSON.parse(storage.getItem(LOCAL_PROGRESS_KEY)).xp, xpForRank(12) + 10, 'saved');

  assert.equal(p.syncCareer({ xp: 100 }), false, 'a lower career (another key) changes nothing');
  assert.equal(p.syncCareer({ xp: Infinity }), false);
  assert.equal(p.syncCareer(null), false);
  assert.equal(p.syncCareer({ xp: 'lots' }), false);
  assert.equal(p.rank(), 12);
  assert.equal(synced.length, 1);
});

test('a page that went into the back/forward cache still pays the rest and the result', () => {
  const events = new EventBus();
  const game = { events, player: { team: 'ct' }, score: { total: 400 } };
  const p = new Progression(game, memoryStorage());
  events.emit('ui:start');
  events.emit('kill', { killerIsLocal: true, weaponId: 'm4a1', killerTeam: 'ct', victimTeam: 't' });
  p._onAbandon(false);                       // pagehide: paid so far, match goes on
  assert.equal(p.xp, 400);
  assert.equal(p.weaponXp.m4a1, WEAPON_XP_PER_KILL);

  game.score.total = 1000;                   // back from the cache, played on
  events.emit('kill', { killerIsLocal: true, weaponId: 'm4a1', killerTeam: 'ct', victimTeam: 't' });
  events.emit('game:end', { winner: 'ct' });
  assert.equal(p.xp, 1000 + MATCH_XP.WIN, 'the rest of the score and the win, nothing twice');
  assert.equal(p.weaponXp.m4a1, 2 * WEAPON_XP_PER_KILL);

  events.emit('game:end', { winner: 'ct' });
  events.emit('ui:menu');
  p._onAbandon(false);
  assert.equal(p.xp, 1000 + MATCH_XP.WIN, 'a finished match pays nothing more');
});
