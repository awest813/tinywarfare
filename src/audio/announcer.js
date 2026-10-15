// ============================================================================
// TINY WARFARE — src/audio/announcer.js
//
// Spoken radio callouts through the browser's speech synthesis: mode briefs,
// streak call-ins, flags, the hardpoint, and the match result. Off when the
// Settings toggle is off, the tab is hidden, or the browser has no speech
// synthesis. One line at a time; a newer line replaces a queued one.
// ============================================================================

import { isRespawnMode } from '../game/tdm.js';

const MODE_LINES = Object.freeze({
  tdm: 'Team deathmatch. Eliminate the enemy.',
  kc: 'Kill confirmed. Collect their tags.',
  dom: 'Domination. Secure the flags.',
  hp: 'Hardpoint. Take the zone.',
  ffa: 'Free for all. Trust no one.',
});

const STREAK_LINES = Object.freeze({
  uav: 'UAV online.',
  counteruav: 'Counter UAV online.',
  carepackage: 'Care package inbound.',
  airstrike: 'Airstrike inbound.',
});

const MIN_GAP_MS = 900;

export default class Announcer {
  constructor(game, synth = globalThis.speechSynthesis) {
    this.game = game;
    this.synth = synth && typeof synth.speak === 'function' ? synth : null;
    this._last = 0;
    this._voice = null;

    const ev = game.events;
    ev.on('round:phase', (d) => {
      const mode = game.state && game.state.mode;
      if (d && d.phase === 'freeze' && isRespawnMode(mode)) this.say(MODE_LINES[mode]);
    });
    ev.on('streak:ready', (d) => this.say(String(d && d.label ? d.label : 'Streak').toLowerCase() + ' ready.'));
    ev.on('streak:activate', (d) => this.say(STREAK_LINES[d && d.id]));
    ev.on('streak:enemy', (d) => this.say(d && d.jammed ? 'Enemy UAV jammed.' : 'Enemy UAV spotted.', true));
    ev.on('objective:flag', (d) => {
      const mine = (game.player && game.player.team) || 'ct';
      if (!d) return;
      if (d.owner === mine) this.say('We have taken flag ' + d.name + '.');
      else if (d.previous === mine) this.say('We have lost flag ' + d.name + '.', true);
      else if (d.owner) this.say('Enemy has taken flag ' + d.name + '.');
    });
    ev.on('objective:hardpoint', () => this.say('Hardpoint moving.'));
    // Leaving for the menu (or hiding the tab) ends any line mid-sentence.
    ev.on('ui:menu', () => this.stop());
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (globalThis.document.visibilityState === 'hidden') this.stop();
    });
    ev.on('game:end', (d) => {
      const mine = (game.player && game.player.team) || 'ct';
      if (!d) return;
      if (d.draw) this.say('Stalemate.', true);
      else if (d.ffa) this.say(d.ffa.place === 1 ? 'Victory.' : 'Match over.', true);
      else this.say(d.winner === mine ? 'Mission accomplished.' : 'Mission failed.', true);
    });
  }

  enabled() {
    const settings = this.game.settings;
    if (!this.synth || (settings && settings.announcer === false)) return false;
    return !(globalThis.document && globalThis.document.visibilityState === 'hidden');
  }

  stop() {
    try { this.synth?.cancel(); } catch { /* unsupported */ }
  }

  /**
   * Speak a line. An ordinary line never talks over one still playing;
   * `urgent` skips the minimum gap and cuts the current one.
   */
  say(text, urgent = false) {
    if (!text || !this.enabled()) return false;
    const now = Date.now();
    if (!urgent && (now - this._last < MIN_GAP_MS || this.synth.speaking)) return false;
    this._last = now;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (typeof Utterance !== 'function') return false;
    const line = new Utterance(String(text));
    line.rate = 1.08;
    line.pitch = 0.85;
    // Follows the master VOLUME setting (0.8 is the default level).
    const volume = Number(this.game.settings?.volume ?? 0.8);
    if (!(volume > 0)) return false;
    line.volume = Math.min(1, volume);
    const voice = this._pickVoice();
    if (voice) line.voice = voice;
    try {
      if (urgent) this.synth.cancel();
      this.synth.speak(line);
      return true;
    } catch {
      return false;
    }
  }

  _pickVoice() {
    if (this._voice) return this._voice;
    const voices = typeof this.synth.getVoices === 'function' ? this.synth.getVoices() : [];
    this._voice = voices.find((v) => /en[-_]US/i.test(v.lang) && /male|david|guy|alex/i.test(v.name)) ||
      voices.find((v) => /en[-_]US/i.test(v.lang)) ||
      voices.find((v) => /^en/i.test(v.lang)) || null;
    return this._voice;
  }
}
