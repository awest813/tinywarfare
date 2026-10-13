import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import MatchScore, { SCORE } from '../src/game/score.js';
import Player from '../src/player/player.js';
import { CONFIG } from '../src/shared/config.js';
import { EventBus } from '../src/shared/events.js';

const kill = (extra = {}) => ({ killerIsLocal: true, victimIsLocal: false, killerTeam: 'ct', victimTeam: 't', ...extra });

test('local kills award score, headshot and multi-kill bonuses, and streaks', () => {
  const events = new EventBus();
  const score = new MatchScore({ events });
  const awards = [];
  events.on('score:award', (a) => awards.push(a.label));

  events.emit('kill', kill({ headshot: true }));
  assert.equal(score.total, SCORE.KILL + SCORE.HEADSHOT);
  score.update(1);
  events.emit('kill', kill());
  assert.ok(awards.includes('DOUBLE KILL'));
  score.update(SCORE.MULTI_WINDOW + 1);
  events.emit('kill', kill());
  assert.ok(!awards.includes('TRIPLE KILL'), 'the chain broke after the window');
  assert.equal(score.streak, 3);

  // Bots' kills, team kills, and the player's own death never score.
  const before = score.total;
  events.emit('kill', kill({ killerIsLocal: false }));
  events.emit('kill', kill({ victimTeam: 'ct' }));
  assert.equal(score.total, before);

  events.emit('player:death', {});
  assert.equal(score.streak, 0);
  for (let i = 0; i < 5; i++) { score.update(10); events.emit('kill', kill()); }
  assert.ok(awards.includes('5 KILL STREAK'));

  events.emit('ui:restart');
  assert.equal(score.total, 0);
});

test('spawn protection blocks damage until it expires or the player fires', () => {
  const events = new EventBus();
  const game = {
    config: CONFIG,
    events,
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250),
    state: { phase: 'live' },
    input: { consumeLook: () => ({ dx: 0, dy: 0 }), isDown: () => false },
    bots: { all: [] },
    multiplayer: { active: false, remotePlayers: [] },
  };
  const player = new Player(game);
  game.player = player;
  player.protect(1.5);
  player.takeDamage(50, {});
  assert.equal(player.health, 100);
  events.emit('weapon:fire', {});
  player.takeDamage(50, {});
  assert.equal(player.health, 50);

  player.protect(1.5);
  player.update(1.6);
  player.takeDamage(10, {});
  assert.equal(player.health, 40);
});
