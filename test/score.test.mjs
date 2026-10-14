import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import MatchScore, { SCORE, longshotRange } from '../src/game/score.js';
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
  assert.equal(score.total, SCORE.KILL + SCORE.HEADSHOT + SCORE.FIRST_BLOOD, 'the match\'s first kill is first blood');
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

test('one kill\'s awards share a group; first blood is the match\'s first kill, not yours', () => {
  const events = new EventBus();
  const score = new MatchScore({ events, player: { team: 'ct' }, state: { mode: 'tdm' } });
  const awards = [];
  events.on('score:award', (a) => awards.push(a));
  events.emit('kill', kill({ killerIsLocal: false, killerName: 'Havoc', killerTeam: 't', victimName: 'Falcon', victimTeam: 'ct' }));
  events.emit('kill', kill({ headshot: true, victimName: 'Wolf' }));
  assert.deepEqual(awards.map((a) => a.label), ['KILL', 'HEADSHOT'], 'a bot drew first blood');
  assert.equal(new Set(awards.map((a) => a.group)).size, 1, 'one kill, one group');
  score.update(10);
  events.emit('kill', kill({ victimName: 'Cobra' }));
  assert.notEqual(awards.at(-1).group, awards[0].group);
});

test('assists, payback, avenger and longshot bonuses', () => {
  const events = new EventBus();
  const score = new MatchScore({ events, player: { team: 'ct' }, state: { mode: 'tdm' } });
  const labels = [];
  events.on('score:award', (a) => labels.push(a.label));
  events.emit('kill', kill({ victimName: 'Opener' })); // first blood out of the way
  labels.length = 0;

  // A teammate finishes an enemy the player wounded.
  events.emit('kill', kill({ killerIsLocal: false, killerName: 'Falcon', assistIsLocal: true, victimName: 'Viper' }));
  assert.deepEqual(labels, ['ASSIST']);
  // ...but not in free-for-all, and never for a team kill.
  score.game.state.mode = 'ffa';
  events.emit('kill', kill({ killerIsLocal: false, killerName: 'Falcon', assistIsLocal: true, victimName: 'Dune' }));
  score.game.state.mode = 'tdm';
  events.emit('kill', kill({ killerIsLocal: false, killerName: 'Falcon', killerTeam: 'ct', victimTeam: 'ct', assistIsLocal: true }));
  assert.deepEqual(labels, ['ASSIST']);

  // Payback: the enemy who last killed the player.
  labels.length = 0;
  events.emit('kill', kill({ killerIsLocal: false, killerName: 'Havoc', killerTeam: 't', victimIsLocal: true, victimName: 'You', victimTeam: 'ct' }));
  events.emit('player:death', {});
  score.update(10);
  events.emit('kill', kill({ victimName: 'Havoc' }));
  assert.deepEqual(labels, ['KILL', 'PAYBACK']);
  score.update(10);
  events.emit('kill', kill({ victimName: 'Havoc' }));
  assert.equal(labels.filter((l) => l === 'PAYBACK').length, 1, 'payback is once per death');

  // Avenger: the enemy who just killed a teammate, inside the window only.
  labels.length = 0;
  events.emit('kill', kill({ killerIsLocal: false, killerName: 'Ghost', killerTeam: 't', victimName: 'Blitz', victimTeam: 'ct' }));
  score.update(SCORE.AVENGE_WINDOW - 1);
  events.emit('kill', kill({ victimName: 'Ghost' }));
  assert.ok(labels.includes('AVENGER'));
  labels.length = 0;
  events.emit('kill', kill({ killerIsLocal: false, killerName: 'Sarge', killerTeam: 't', victimName: 'Blitz', victimTeam: 'ct' }));
  score.update(SCORE.AVENGE_WINDOW + 1);
  events.emit('kill', kill({ victimName: 'Sarge' }));
  assert.ok(!labels.includes('AVENGER'), 'too late to avenge');

  // Longshot: past the weapon's range, never for explosives or the knife.
  labels.length = 0;
  score.update(10);
  events.emit('kill', kill({ weaponId: 'm4a1', distance: longshotRange('m4a1') + 1, victimName: 'A' }));
  score.update(10);
  events.emit('kill', kill({ weaponId: 'm4a1', distance: longshotRange('m4a1') - 1, victimName: 'B' }));
  score.update(10);
  events.emit('kill', kill({ weaponId: 'hegrenade', distance: 80, victimName: 'C' }));
  assert.equal(labels.filter((l) => l === 'LONGSHOT').length, 1);
  assert.ok(longshotRange('shotgun') < longshotRange('m4a1') && longshotRange('m4a1') < longshotRange('awp'));
  assert.equal(longshotRange('knife'), Infinity);
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
