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
  events.emit('objective:flag', { name: 'B', owner: 't' });
  assert.equal(synth.spoken.at(-1), 'We have lost flag B.');
  events.emit('game:end', { winner: 'ct' });
  assert.equal(synth.spoken.at(-1), 'Mission accomplished.');

  game.settings.announcer = false;
  assert.equal(announcer.say('Hello', true), false);
  assert.equal(new Announcer(game, null).say('x', true), false, 'no speech synthesis: silent');
});
