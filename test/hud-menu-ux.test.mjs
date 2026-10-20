import assert from 'node:assert/strict';
import test from 'node:test';

import HUD from '../src/ui/hud.js';
import GameSettings from '../src/core/settings.js';
import { GAME_MODES } from '../src/game/tdm.js';
import { BOT_SKILLS } from '../src/ai/skill.js';
import { GRAPHICS_DETAILS, GRAPHICS_LABELS, GRAPHICS_SUMMARIES } from '../src/gfx/profiles.js';

function menuHtml() {
  const hud = Object.create(HUD.prototype);
  hud.game = { settings: new GameSettings(null, null) };
  return hud._html();
}

test('mode and bot cards keep the full rule line in the accessible name', () => {
  const html = menuHtml();
  for (const mode of Object.values(GAME_MODES)) {
    assert.match(html, new RegExp(
      'data-mode-id="' + mode.id + '" aria-pressed="false" aria-label="' +
      mode.label.replace('&', '&amp;') + '\\. ' + mode.detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'
    ));
    assert.match(html, new RegExp('<span>' + mode.detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</span>'));
  }
  for (const skill of Object.values(BOT_SKILLS)) {
    assert.match(html, new RegExp(
      'data-bot-skill="' + skill.id + '"[^>]*aria-label="' + skill.label + '\\. ' + skill.detail + '"'
    ));
  }
});

test('class editor shows weapon progress under the primary, not as its own cell', () => {
  const html = menuHtml();
  const editor = html.slice(html.indexOf('id="hud-class-editor"'), html.indexOf('id="hud-class-reset"'));
  assert.match(
    editor,
    /id="hud-class-primary"[\s\S]*id="hud-class-weapon-progress"[\s\S]*<\/small><\/label>\s*<label>ATTACHMENT/
  );
});

test('settings are grouped and every control is still there', () => {
  const html = menuHtml();
  for (const heading of ['LOOK', 'PICTURE', 'SOUND', 'MATCH']) {
    assert.match(html, new RegExp('<h3 id="hud-settings-[a-z]+">' + heading + '</h3>'));
  }
  for (const id of [
    'hud-look-sensitivity', 'hud-ads-sensitivity', 'hud-fov', 'hud-invert-y', 'hud-aim-toggle',
    'hud-brightness', 'hud-graphics', 'hud-show-fps', 'hud-volume', 'hud-announcer',
    'hud-killcam-setting', 'hud-crouch-toggle', 'hud-settings-reset',
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /id="hud-menu-settings"[^>]*hidden/);
  assert.match(html, /0 IS THE DESIGNED PICTURE/);
  assert.match(html, /id="hud-brightness-output"[^>]*>DEFAULT</);
  for (const [id, label] of Object.entries(GRAPHICS_LABELS)) {
    assert.match(html, new RegExp(
      'data-graphics="' + id + '" aria-pressed="' + (id === 'auto' ? 'true' : 'false') +
      '" class="' + (id === 'auto' ? 'selected' : '') + '" aria-label="' +
      label + '\\. ' + GRAPHICS_DETAILS[id].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'
    ));
    assert.match(html, new RegExp('<span>' + GRAPHICS_SUMMARIES[id] + '</span>'));
  }
});

test('graphics note names the running preset and a change that waits for reload', () => {
  const hud = Object.create(HUD.prototype);
  hud._graphicsChanged = false;
  hud.game = {
    gfxPreset: 'high',
    state: { phase: 'menu' },
    settings: {
      graphics: 'auto',
      graphicsPreset() { return 'low'; },
    },
  };
  const buttons = Object.keys(GRAPHICS_LABELS).map((id) => ({
    dataset: { graphics: id },
    classList: { _on: {}, toggle(name, on) { this._on[name] = on; } },
    setAttribute() {},
  }));
  const note = { textContent: '' };
  const detail = { textContent: '' };
  const reload = { hidden: true };
  hud._el = {
    graphics: { querySelectorAll: () => buttons },
    graphicsNote: note,
    graphicsDetail: detail,
    graphicsReload: reload,
  };
  hud._syncSettingsUi();
  assert.equal(note.textContent, 'AUTO · USING HIGH');
  assert.equal(detail.textContent, 'THIS DEVICE IS ON HIGH · ' + GRAPHICS_DETAILS.auto);
  assert.equal(reload.hidden, true);
  assert.equal(buttons.find((button) => button.dataset.graphics === 'auto').classList._on.selected, true);

  hud._graphicsChanged = true;
  hud.game.settings.graphics = 'chromebook';
  hud._syncSettingsUi();
  assert.equal(note.textContent, 'APPLIES AFTER RELOAD');
  assert.equal(detail.textContent, GRAPHICS_DETAILS.chromebook);
  assert.equal(reload.hidden, false);
  assert.equal(buttons.find((button) => button.dataset.graphics === 'chromebook').classList._on.selected, true);

  hud.game.settings.graphics = 'auto';
  hud._syncSettingsUi();
  assert.equal(detail.textContent, 'RELOAD STARTS ON LOW · ' + GRAPHICS_DETAILS.auto);

  hud.game.state.phase = 'live';
  hud._syncSettingsUi();
  assert.equal(reload.hidden, true, 'a live match does not offer a reload');
});

test('the fps readout names the graphics preset in use', () => {
  const hud = Object.create(HUD.prototype);
  hud._cache = {};
  hud._fpsTimer = 1;
  const fps = { style: {}, textContent: '' };
  hud._el = { fps };
  hud.game = { fps: 50, gfxPreset: 'chromebook', settings: { showFps: true } };
  hud._updateFps(0.5, true);
  assert.equal(fps.textContent, '50 FPS · 20 MS · LOW POWER');
  assert.equal(fps.style.display, 'block');
});

test('pause offers an explicit resume control and focuses it', () => {
  const html = menuHtml();
  assert.match(html, /id="hud-pause" role="dialog" aria-modal="true" aria-labelledby="hud-pause-title"/);
  assert.match(html, /id="hud-pause-resume"[^>]*>RESUME/);

  const focused = [];
  const hud = Object.create(HUD.prototype);
  hud.game = { debug: false, input: { touchMode: false }, settings: null, state: { mode: 'tdm' }, multiplayer: null };
  hud._locked = false;
  hud._buyOpen = false;
  const resume = {
    textContent: '',
    focus(opts) { focused.push(opts); },
  };
  const main = { textContent: '' };
  const sub = { textContent: '' };
  hud._el = {
    pause: {
      style: {},
      contains() { return false; },
      querySelector(sel) {
        if (sel === '.pause-main') return main;
        if (sel === '.pause-sub') return sub;
        return null;
      },
    },
    pauseResume: resume,
  };
  hud._updatePause('live');
  assert.equal(resume.textContent, 'RESUME');
  assert.deepEqual(focused, [{ preventScroll: true }]);
  assert.equal(main.textContent, 'PAUSED');
  assert.equal(sub.textContent, 'CLICK TO RESUME');

  focused.length = 0;
  hud._pauseShown = false;
  hud.game.multiplayer = { active: true };
  hud._updatePause('live');
  assert.equal(resume.textContent, 'RETURN TO MATCH');
  assert.equal(main.textContent, 'CLICK TO RESUME');
  assert.equal(sub.textContent, 'THE MATCH IS STILL RUNNING');

  focused.length = 0;
  hud._pauseShown = false;
  hud._el.pause.contains = () => true;
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: resume };
  try {
    hud._updatePause('live');
    assert.deepEqual(focused, [], 'an already-focused pause control keeps focus');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
