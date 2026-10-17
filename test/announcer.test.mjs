import test from 'node:test';
import assert from 'node:assert/strict';

import Announcer from '../src/audio/announcer.js';
import { EventBus } from '../src/shared/events.js';

function fakeSynth() {
  return { spoken: [], speak(u) { this.spoken.push(u.text); }, cancel() {}, getVoices: () => [] };
}

test('the announcer voices streaks, flags, and results, and respects the toggle', (t) => {
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  t.after(() => { delete globalThis.SpeechSynthesisUtterance; });
  const events = new EventBus();
  const synth = fakeSynth();
  const game = { events, state: { mode: 'dom' }, player: { team: 'ct' }, settings: { announcer: true } };
  const announcer = new Announcer(game, synth);

  events.emit('round:phase', { phase: 'freeze' });
  assert.match(synth.spoken.at(-1), /Domination/);
  events.emit('objective:flag', { name: 'B', owner: 't', previous: 'ct' });
  assert.equal(synth.spoken.at(-1), 'We have lost flag B.');
  synth.speaking = true;
  announcer._last = 0;
  assert.equal(announcer.say('UAV ready.'), false, 'an ordinary line never talks over another');
  assert.equal(announcer.say('Enemy UAV spotted.', true), true, 'urgent lines cut in');
  synth.speaking = false;
  events.emit('game:end', { winner: 'ct' });
  assert.equal(synth.spoken.at(-1), 'Mission accomplished.');

  game.state = { mode: 'sd', round: 1 };
  announcer._last = 0;
  events.emit('round:phase', { phase: 'freeze' });
  assert.equal(synth.spoken.at(-1), 'Search and destroy. Defend the sites.');
  game.state.round = 2;
  announcer._last = 0;
  events.emit('round:phase', { phase: 'freeze' });
  assert.equal(synth.spoken.at(-1), 'Search and destroy. Defend the sites.', 'only round one is briefed');
  announcer._last = 0;
  events.emit('streak:ready', { label: 'UAV' });
  assert.equal(synth.spoken.at(-1), 'U.A.V. ready.');

  game.settings.announcer = false;
  assert.equal(announcer.say('Hello', true), false);
  assert.equal(new Announcer(game, null).say('x', true), false, 'no speech synthesis: silent');
});

test('a waiting line is said after the current one, unless an urgent line supersedes it', (t) => {
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  t.after(() => { delete globalThis.SpeechSynthesisUtterance; });
  const synth = fakeSynth();
  const game = { events: new EventBus(), state: { mode: 'dom' }, player: { team: 'ct' }, settings: { announcer: true } };
  const announcer = new Announcer(game, synth);
  synth.speaking = true;
  announcer._last = 0;
  announcer.say('We have taken flag B.');
  assert.ok(announcer._pending, 'queued, not dropped');
  announcer.say('We have lost flag B.', true);
  assert.equal(announcer._pending, null, 'the urgent line supersedes it');
  synth.speaking = false;
  announcer._drain();
  assert.deepEqual(synth.spoken, ['We have lost flag B.']);
});
