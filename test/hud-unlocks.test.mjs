// Unlock surfaces in the menu: the streak picker follows rank-ups, class cards
// say what an attachment lock needs, and the rank chip names the next unlock.
import test from 'node:test';
import assert from 'node:assert/strict';

import HUD from '../src/ui/hud.js';
import Progression from '../src/game/progression.js';
import Loadouts from '../src/game/loadouts.js';

function rig(t) {
  const previous = globalThis.document;
  const els = {};
  const el = (id) => (els[id] ||= {
    id, innerHTML: '', value: '', options: [], textContent: '',
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
    contains: () => false,
  });
  globalThis.document = { getElementById: el, activeElement: null };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const handlers = {};
  const events = { on: (n, f) => (handlers[n] ||= []).push(f), emit: (n, d) => (handlers[n] || []).forEach((f) => f(d)) };
  const game = { events, state: { phase: 'menu' } };
  game.progression = new Progression(game, storage);
  game.loadouts = new Loadouts(game, storage);
  game.streaks = { selected: ['uav', 'airstrike'], selectStreaks(list) { this.selected = list; } };
  const hud = Object.create(HUD.prototype);
  hud.game = game;
  hud._names = { m4a1: 'M4-A1', mp5: 'MP-5', awp: 'AWP', ak47: 'AK-47', usp: 'USP-S', deagle: 'Night Hawk', glock: 'G-18', shotgun: 'M1014' };
  hud._el = { classRow: el('row') };
  return { hud, game, el };
}

test('a scorestreak unlocked by a rank-up is pickable without a reload', (t) => {
  const { hud, game, el } = rig(t);
  hud._bindStreakPicker();
  assert.match(el('hud-streak-a').innerHTML, /value="counteruav" disabled/);
  game.progression.awardMatch({ score: 12000, result: 'win' });
  hud._renderStreakPicker();
  assert.doesNotMatch(el('hud-streak-a').innerHTML, /value="counteruav" disabled/);
});

test('class cards name what an attachment lock needs; the chip names the next unlock', (t) => {
  const { hud, game, el } = rig(t);
  game.progression.weaponXp = { m4a1: 400 };
  hud._renderClasses();
  const notes = [...el('row').innerHTML.matchAll(/mn-class-lock">([^<]*)/g)].map((m) => m[1]);
  assert.ok(notes.some((n) => /GRIP AT M4-A1 LV 3 \(4\/9 KILLS\)/.test(n)), notes.join(' | '));
  assert.ok(!notes.some((n) => /^🔒 1 PICK UNLOCKS WITH RANK$/.test(n) && /GRIP/.test(n)));
  assert.match(el('hud-rank-chip').textContent, /^UNLOCK RANK 1 · .* · NEXT: M1014 AT RANK 2$/);
  game.progression.xp = 1e8;
  hud._renderClasses();
  assert.match(el('hud-rank-chip').textContent, /ALL GEAR UNLOCKED$/);
});

test('the next unlock is named with its rank; the class detail describes only what deploys', (t) => {
  const { hud, game, el } = rig(t);
  assert.deepEqual(hud._nextUnlock(5), { id: 'deagle', rank: 6, name: 'NIGHT HAWK' });
  assert.equal(hud._nextUnlock(28), null);

  hud._el.classPerkDetail = el('detail');
  game.loadouts.edit(game.loadouts.selected, { perk2: 'hardline' });
  hud._renderClasses();
  assert.ok(!game.progression.isUnlocked('hardline'));
  assert.equal(el('hud-class-perk2').value, 'hardline', 'the select keeps the saved pick');
  const used = game.progression.resolveLoadout(game.loadouts.active());
  assert.notEqual(used.perk2, 'hardline');
  assert.ok(el('detail').textContent.length > 0);
  assert.doesNotMatch(el('detail').textContent, /cost 20% less/i, 'a locked perk is not described as active');
});
