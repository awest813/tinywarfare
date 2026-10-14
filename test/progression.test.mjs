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
