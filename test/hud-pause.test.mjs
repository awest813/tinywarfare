import assert from 'node:assert/strict';
import test from 'node:test';

import HUD from '../src/ui/hud.js';
import { GAME_MODES, MODE_GOALS, SD_BRIEF } from '../src/game/tdm.js';

function fakeElement() {
  const classes = new Set();
  const children = {};
  return {
    textContent: '',
    innerHTML: '',
    hidden: true,
    style: {},
    classes,
    classList: {
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
    },
    querySelector(sel) { return (children[sel] ||= fakeElement()); },
    setAttribute() {},
  };
}

function makeHud({ online = false, locked = false } = {}) {
  const hud = Object.create(HUD.prototype);
  hud.game = {
    multiplayer: online ? { active: true } : null,
    input: { touchMode: false },
    settings: null,
    state: { mode: 'tdm' },
  };
  hud._locked = locked;
  hud._buyOpen = false;
  hud._el = { pause: fakeElement() };
  return hud;
}

test('a solo match pauses while the pointer is released; an online one keeps running', () => {
  const solo = makeHud();
  solo._updatePause('live');
  assert.equal(solo.game.paused, true);
  assert.equal(solo._el.pause.style.display, 'flex');
  assert.equal(solo._el.pause.querySelector('.pause-main').textContent, 'PAUSED');
  assert.equal(solo._el.pause.querySelector('.pause-sub').textContent, 'CLICK TO RESUME');

  solo._locked = true;
  solo._updatePause('live');
  assert.equal(solo.game.paused, false, 'resumes once the pointer is locked again');
  assert.equal(solo._el.pause.style.display, 'none');

  solo._locked = false;
  solo._updatePause('menu');
  assert.equal(solo.game.paused, false, 'never paused outside a match');

  const online = makeHud({ online: true });
  online._updatePause('live');
  assert.equal(online.game.paused, false);
  assert.equal(online._el.pause.querySelector('.pause-main').textContent, 'CLICK TO RESUME');
  assert.equal(online._el.pause.querySelector('.pause-sub').textContent, 'THE MATCH IS STILL RUNNING');
});

test('the buy menu does not count as a pause', () => {
  const hud = makeHud();
  hud._buyOpen = true;
  hud._updatePause('freeze');
  assert.equal(hud.game.paused, false);
});

test('how to play lists the current key bindings and every mode', () => {
  const hud = makeHud();
  hud.game.settings = { getLabel: (id) => (id === 'reload' ? 'F' : ({ moveForward: 'W', moveLeft: 'A', moveBackward: 'S', moveRight: 'D' })[id] || '?') };
  const html = hud._howToHtml();
  assert.match(html, /<kbd>F<\/kbd><span>Reload/);
  assert.match(html, /<kbd>WASD<\/kbd>/);
  for (const mode of Object.values(GAME_MODES)) {
    assert.ok(html.includes(mode.label.replace('&', '&amp;')), mode.id);
    assert.ok(MODE_GOALS[mode.id], 'every mode has a goal line: ' + mode.id);
  }
  hud.game.input.touchMode = true;
  assert.match(hud._howToHtml(), /\$ BUY/);
});

test('both Search & Destroy sides have a round-one brief', () => {
  assert.ok(SD_BRIEF.ct && SD_BRIEF.t);
});
