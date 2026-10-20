// ============================================================================
// TINY WARFARE — src/ui/hud.js
// The entire 2D layer: status panels, ammo, money, timer/scores, killfeed,
// rotating radar, dynamic crosshair, hitmarkers, damage feedback, flash
// whiteout, AWP scope, buy menu, scoreboard, round messages, defuse bar,
// death overlay, main menu, pause overlay and game-end screen.
// CS 1.6-flavored styling: translucent dark panels, olive-green text,
// condensed bold system fonts. No external assets.
// ============================================================================

import * as THREE from 'three';
import { MAP_CATALOG, mapForMode, mapSupportsMode, normalizeMapId } from '../maps/catalog.js';
import { FACTIONS, FLAG_SVG, faction, scoreLine } from '../shared/factions.js';
import { GAME_MODES, SD_BRIEF, TDM, isRespawnMode, modeGoal, modeRules, normalizeModeId } from '../game/tdm.js';
import { STREAKS, STREAK_IDS } from '../game/streaks.js';
import { BOT_SKILLS, BOT_SKILL_STORAGE_KEY, normalizeBotSkill } from '../ai/skill.js';
import { ATTACHMENTS, ATTACHMENT_IDS, LETHALS, PRIMARIES, SECONDARIES, TACTICALS, PERKS, PERK1_IDS, PERK2_IDS } from '../game/loadouts.js';
import {
  ATTACHMENT_LEVEL, FINAL_UNLOCK_RANK, UNLOCK_RANK, WEAPON_LEVEL_XP, WEAPON_XP_PER_KILL, xpForRank,
} from '../game/progression.js';
import { hostile, hostileTeams, isFfa } from '../game/hostility.js';
import { resolveHumanPlayerName } from '../player/profile.js';
import { serviceOffline } from '../network/endpoints.js';
import { GRAPHICS_DETAILS, GRAPHICS_LABELS, GRAPHICS_SUMMARIES, RENDER_SCALE_LIMITS } from '../gfx/profiles.js';
import {
  KEY_BINDING_DEFINITIONS,
  SETTINGS_LIMITS,
  bindingDefinition,
  formatKeyLabel,
} from '../core/settings.js';

const clamp = THREE.MathUtils.clamp;

/** Smooth scrolling, unless the player asked for reduced motion. */
function scrollBehavior() {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth';
  } catch {
    return 'smooth';
  }
}

function humanCallsign(game, value, playerId, preferred = '') {
  const multiplayer = game?.multiplayer;
  if (multiplayer && typeof multiplayer._humanCallsign === 'function') {
    return multiplayer._humanCallsign(value, playerId);
  }
  let fallback = preferred;
  if (multiplayer && playerId != null) {
    if (multiplayer.localId != null && String(playerId) === String(multiplayer.localId)) {
      fallback ||= multiplayer.localName || game?.profile?.name;
    } else if (Array.isArray(multiplayer.remotePlayers)) {
      const remote = multiplayer.remotePlayers.find((entry) =>
        entry && String(entry.networkId || entry.id || '') === String(playerId)
      );
      fallback ||= remote?.name;
    }
  }
  return resolveHumanPlayerName(value, playerId, fallback);
}

// ---------------------------------------------------------------------------
// Static data (fallbacks — live names/prices are pulled from weapons/data.js
// via a dynamic import so the HUD still works against stubs).
// ---------------------------------------------------------------------------

const FALLBACK_NAMES = {
  knife: 'Knife',
  glock: 'G-18',
  usp: 'USP-S',
  deagle: 'Night Hawk',
  mp5: 'MP-5',
  ak47: 'AK-47',
  m4a1: 'M4-A1',
  awp: 'AWP',
  hegrenade: 'HE Grenade',
  flashbang: 'Flashbang',
  smokegrenade: 'Smoke',
  armor: 'Kevlar Vest',
  kit: 'Defuse Kit',
};

const FALLBACK_PRICES = {
  glock: 200, usp: 200, deagle: 700, mp5: 1500,
  ak47: 2700, m4a1: 3100, awp: 4750,
  hegrenade: 300, flashbang: 200, smokegrenade: 300,
};

// Gun stat readouts for the buy menu (overwritten by live data.js values).
const FALLBACK_STATS = {
  glock: { dmg: 26, rpm: 400 }, usp: { dmg: 34, rpm: 352 }, deagle: { dmg: 58, rpm: 160 },
  mp5: { dmg: 26, rpm: 750 }, ak47: { dmg: 36, rpm: 600 }, m4a1: { dmg: 33, rpm: 666 },
  awp: { dmg: 115, rpm: 41 },
};
const FALLBACK_MAXCARRY = { hegrenade: 1, flashbang: 2, smokegrenade: 1 };
const GRENADE_IDS = { hegrenade: 1, flashbang: 1, smokegrenade: 1, semtex: 1, stun: 1 };

const FALLBACK_BUY = [
  { category: 'Pistols', items: ['glock', 'usp', 'deagle'] },
  { category: 'SMG', items: ['mp5'] },
  { category: 'Rifles', items: ['ak47', 'm4a1', 'awp'] },
  { category: 'Gear', items: ['armor', 'kit'] },
  { category: 'Grenades', items: ['hegrenade', 'flashbang', 'smokegrenade'] },
];

const MATCH_PHASES = { freeze: 1, live: 1, planted: 1, roundEnd: 1 };
// The controls strip shows at the start of this many matches, for this long.
const TIPS_STORAGE_KEY = 'tiny-strike-tips-shown';
const TIPS_MATCHES = 3;
const TIPS_SECONDS = 12;

// Selection must paint before the synchronous world-rebuild notification can
// monopolize the main thread. Keeping this above the 100 ms interaction budget
// also coalesces quick passes across the five-card row into one map load.
export const MAP_SELECT_LOAD_DEBOUNCE_MS = 180;

const CAREER_RECORD_LABELS = Object.freeze({
  matchScore: 'BEST MATCH SCORE',
  kills: 'MOST KILLS',
  headshots: 'MOST HEADSHOTS',
  kd: 'BEST K/D',
  objectives: 'MOST OBJECTIVES',
  fastestWin: 'FASTEST WIN',
});

// Kept in the HUD so an older progression response can still offer a concrete
// next objective. Newer servers may provide `nextAchievements`; those always
// take precedence when present.
const CAREER_GOALS = Object.freeze([
  Object.freeze({ id: 'first_match', title: 'DEPLOYED', description: 'Complete your first match.', value: (p) => p.lifetime?.matches, target: 1 }),
  Object.freeze({ id: 'first_win', title: 'MISSION ACCOMPLISHED', description: 'Win your first match.', value: (p) => p.lifetime?.wins, target: 1 }),
  Object.freeze({ id: 'first_headshot', title: 'ON TARGET', description: 'Land your first headshot.', value: (p) => p.lifetime?.headshots, target: 1 }),
  Object.freeze({ id: 'eliminator_10', title: 'ELIMINATOR', description: 'Reach 10 lifetime eliminations.', value: (p) => p.lifetime?.kills, target: 10 }),
  Object.freeze({ id: 'veteran_10', title: 'VETERAN', description: 'Complete 10 matches.', value: (p) => p.lifetime?.matches, target: 10 }),
  Object.freeze({ id: 'headhunter_25', title: 'HEADHUNTER', description: 'Reach 25 lifetime headshots.', value: (p) => p.lifetime?.headshots, target: 25 }),
  Object.freeze({ id: 'win_streak_3', title: 'HOT STREAK', description: 'Win 3 matches in a row.', value: (p) => p.streaks?.winsCurrent, target: 3 }),
  Object.freeze({ id: 'objective_10', title: 'OBJECTIVE SPECIALIST', description: 'Complete 10 bomb objectives.', value: (p) => Number(p.lifetime?.plants || 0) + Number(p.lifetime?.defuses || 0), target: 10 }),
  Object.freeze({ id: 'eliminator_100', title: 'CENTURY', description: 'Reach 100 lifetime eliminations.', value: (p) => p.lifetime?.kills, target: 100 }),
  Object.freeze({ id: 'map_master', title: 'FIVE FRONTS', description: 'Win on every battleground.', value: (p) => Object.values(p.byMap || {}).filter((map) => Number(map?.wins) > 0).length, target: 5 }),
]);

const SVG_CROSS =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
  '<path fill="currentColor" d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>';
const SVG_SHIELD =
  '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 1l9 4v6c0 5.6-3.8 10.5-9 12-5.2-1.5-9-6.4-9-12V5z"/></svg>';
const SVG_SKULL =
  '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2a8 8 0 0 0-8 8c0 2.9 1.6 5.4 4 6.7V20h2v-2h1v2h2v-2h1v2h2v-3.3c2.4-1.3 4-3.8 4-6.7a8 8 0 0 0-8-8zM8.5 12a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zm7 0a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z"/></svg>';

// Compact, dependency-free silhouettes for every buy-menu choice. Keeping
// these inline makes the menu immediately useful while the 3D GLBs stream in,
// and lets CSS recolor owned/unaffordable items without maintaining PNG sets.
const BUY_ICON_SHAPES = {
  glock:
    '<path d="M18 10h52l10 6-4 8H56l-3 15H35l2-15H18z"/>' +
    '<path d="M57 25h14l-5 5H56z" opacity=".48"/>',
  usp:
    '<path d="M7 11h40v-3h31v5H47l14 6-4 7H42l-3 13H23l3-16H11z"/>' +
    '<rect x="79" y="9" width="27" height="8" rx="2"/>',
  deagle:
    '<path d="M10 9h62l14 8-5 10H57l-3 12H34l2-16H15z"/>' +
    '<path d="M25 8h38l7 5H23z" opacity=".5"/>',
  mp5:
    '<path d="M9 13h67l10 5-4 9H56l-3 12H40l1-13H12z"/>' +
    '<path d="M55 27h16l-5 13H54zM80 16h26v7H83z" opacity=".72"/>',
  ak47:
    '<path d="M5 15h21l8-6h38l12 7h31v7H80l-8 6H45l-7-6H7z"/>' +
    '<path d="M57 27h15c-1 8 3 11 9 13H65c-7-3-10-7-8-13zM25 13L12 6H3v7z" opacity=".72"/>',
  m4a1:
    '<path d="M5 16h20l10-7h42l8 5h30v8H82l-8 7H41l-8-7H5z"/>' +
    '<path d="M55 27h12l5 13H58zM26 14L12 7H4v8zM39 6h31v5H39z" opacity=".68"/>',
  awp:
    '<path d="M3 18h35l7-7h37l9 6h26v6H87l-8 6H47l-8-6H3z"/>' +
    '<path d="M48 8h34v6H48zM55 27h13l-4 13H51z" opacity=".7"/>' +
    '<circle cx="52" cy="10" r="5"/><circle cx="78" cy="10" r="5"/>',
  armor:
    '<path d="M38 5l13 6h18l13-6 12 14-9 7v14H35V26l-9-7z"/>' +
    '<path d="M51 11l-5 12 14 13 14-13-5-12z" opacity=".42"/>',
  kit:
    '<path d="M28 12h64a6 6 0 0 1 6 6v19H22V18a6 6 0 0 1 6-6z"/>' +
    '<path d="M47 12V7h26v5h-6V11H53v1zM56 18h8v6h7v7h-7v6h-8v-6h-7v-7h7z" opacity=".45"/>',
  hegrenade:
    '<path d="M44 13h32l6 8v14l-7 6H45l-7-6V21z"/>' +
    '<path d="M49 5h22v9H49zM69 6h15l7 7-5 4-7-6H69z" opacity=".72"/>',
  flashbang:
    '<path d="M43 9h34l5 8v20l-5 5H43l-5-5V17z"/>' +
    '<path d="M48 3h24v8H48zM77 6h12l7 7-5 4-8-6h-6z" opacity=".72"/>' +
    '<path d="M46 18h28v4H46zm0 8h28v4H46zm0 8h28v4H46z" opacity=".38"/>',
  smokegrenade:
    '<path d="M42 11h36l4 7v20l-5 4H43l-5-4V18z"/>' +
    '<path d="M48 4h24v9H48zM76 7h13l7 7-5 4-8-6h-7z" opacity=".72"/>' +
    '<path d="M47 20h26v14H47z" opacity=".32"/>',
};

function buyIcon(id) {
  const shape = BUY_ICON_SHAPES[id] || '<path d="M18 12h84v18H18z"/>';
  return '<span class="bi-icon" aria-hidden="true"><svg viewBox="0 0 120 44" ' +
    'focusable="false"><g fill="currentColor">' + shape + '</g></svg></span>';
}

export function compareScoreboardRows(a, b) {
  const aStats = a?.stats || {};
  const bStats = b?.stats || {};
  const byKills = (Number(bStats.k) || 0) - (Number(aStats.k) || 0);
  if (byKills) return byKills;
  const byDeaths = (Number(aStats.d) || 0) - (Number(bStats.d) || 0);
  if (byDeaths) return byDeaths;
  const byName = String(a?.name || '').localeCompare(String(b?.name || ''), 'en', {
    sensitivity: 'base',
  });
  if (byName) return byName;
  const byId = String(a?.sortId || '').localeCompare(String(b?.sortId || ''), 'en');
  return byId || (Number(a?.order) || 0) - (Number(b?.order) || 0);
}

// Radar tuning
const RADAR_SIZE = 140;          // CSS pixels
const RADAR_RANGE = 38;          // meters shown from center to edge
const RADAR_EDGE = RADAR_SIZE / 2 - 7;
const RADAR_SCALE = RADAR_EDGE / RADAR_RANGE;
const ENEMY_SPOT_DIST = 25;      // meters — enemy blip always shown inside this
const ENEMY_FIRE_MEMORY = 2;     // seconds an enemy shot keeps them on radar
const ENEMY_FIRE_MATCH = 3.5;    // meters — blip↔shot position association

// scratch object for radar blip clamping (no per-frame allocation)
const RT = { x: 0, y: 0, cl: false };
// fallback radar bounds until the world module is available
const FALLBACK_RB = { minX: -52, maxX: 52, minZ: -42, maxZ: 42 };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 0 is the authored picture; anything else is exposure compensation. */
function brightnessLabel(value) {
  const n = Number(value) || 0;
  if (!n) return 'DEFAULT';
  return (n > 0 ? '+' : '') + n.toFixed(2) + ' EV';
}

// The render-scale slider's leftmost notch, one step below 50%, is Auto.
function renderScaleSliderMin() {
  return Number((RENDER_SCALE_LIMITS.min - RENDER_SCALE_LIMITS.step).toFixed(2));
}

function renderScaleSliderValue(value) {
  const n = Number(value) || 0;
  return n > 0 ? n : renderScaleSliderMin();
}

function renderScaleLabel(value) {
  const n = Number(value) || 0;
  return n > 0 ? Math.round(n * 100) + '%' : 'AUTO';
}

// ============================================================================

/**
 * A validator message is fine to show when it reads as a sentence ("Duration
 * must be between 60 and 900 seconds"); one that names payload fields
 * ("roundsPlayed must equal scores.ct + scores.t") is not for players.
 */
function readableRejection(error) {
  const text = String(error || '').trim();
  if (!text || /\w\.\w|[a-z][A-Z]/.test(text)) return 'THE SERVER COULD NOT VERIFY THIS RESULT';
  return text.replace(/\.$/, '').toUpperCase();
}

export default class HUD {
  constructor(game) {
    this.game = game;

    this._root = null;
    this._built = false;
    this._el = {};

    // clocks / timers
    this._time = 0;
    this._radarTimer = 0;
    this._fpsTimer = 0;

    // interaction state
    this._locked = false;
    this._buyOpen = false;
    this._buyMoney = -1;
    this._lastBuyToggle = 0;
    this._pauseShown = false;
    this._settingsOpen = false;
    this._bindingCaptureAction = null;
    this._selectedMapId = normalizeMapId(game && game.selectedMapId);
    this._pendingMapSelectId = null;
    this._mapSelectTimer = null;
    this._leaderboardOpen = false;
    this._leaderboardCategory = 'overall';
    this._leaderboardRequest = 0;
    this._leaderboardReturnFocus = null;
    this._profileOpen = false;
    this._profileAppearance = 'vanguard';
    this._profileReturnFocus = null;
    this._careerLoaded = false;
    this._careerLoading = false;
    this._lastProgression = null;
    this._lastReward = null;
    this._progressToasts = [];
    this._endUnranked = false;
    this._scoreRows = new Map(); // award group -> its score popup line

    // combat feedback state
    this._dmg = 0;               // damage vignette energy
    this._dmgOpacity = -1;
    this._deathFxOpacity = -1;
    this._flash = null;          // { i, dur, t }
    this._flashOpacity = -1;
    this._hit = null;            // { t, dur }
    this._wedges = [];           // pooled damage-direction wedges
    this._enemyFire = [];        // recent enemy shot positions for radar

    // feed / stats
    this._feed = [];
    this._radio = [];
    this._stats = new Map();
    this._networkStatsById = new Map();
    this._sbDirty = true;
    this._sbVisible = false;
    this._deathKiller = '';
    this._spectatorTarget = null;
    this._endInfo = null;

    // scope
    this._scopeShown = false;
    this._scopeLevel = -1;
    this._scopeFov = 0;

    // radar bounds cache
    this._rb = null;
    this._radarCtx = null;
    this._radarDpr = 1;

    // cached DOM values — only touch the DOM when these change
    this._cache = {
      phase: null, hp: -1, hpLow: null, armor: -1, armorVis: null,
      money: -1, mag: null, reserve: null, magLow: null, wname: null,
      timerSec: -1, timerRed: null, bombIco: null,
      scoreCt: -1, scoreT: -1, round: -1,
      gap: -1, crossVis: null, dead: null, dying: null, spectatorKey: null,
      defuse: -1, defuseVis: null, hintVis: null, kitNote: null,
      reloading: false, fps: '', buyHint: '',
    };

    // message
    this._msgUntil = -1;

    // buy data (fallbacks now, real data async)
    this._names = { ...FALLBACK_NAMES, airstrike: 'AIRSTRIKE' };
    this._prices = {
      ...FALLBACK_PRICES,
      armor: game?.config?.ECON?.ARMOR_PRICE ?? 650,
      kit: game?.config?.ECON?.KIT_PRICE ?? 400,
    };
    this._buyCats = FALLBACK_BUY.map((c) => ({ category: c.category, items: c.items.slice() }));
    this._buyRows = [];
    this._wstats = {};
    for (const id in FALLBACK_STATS) this._wstats[id] = { ...FALLBACK_STATS[id] };
    this._maxCarry = { ...FALLBACK_MAXCARRY };
    this._loadWeaponData();

    if (game && game.hudRoot) this._build(game.hudRoot);
    this._bindEvents();
  }

  // Public — weapons module may peek at this.
  get buyOpen() { return this._buyOpen; }

  // --------------------------------------------------------------------------
  // Data loading
  // --------------------------------------------------------------------------

  _loadWeaponData() {
    import('../weapons/data.js').then((m) => {
      if (m && m.WEAPONS && typeof m.WEAPONS === 'object') {
        for (const id in m.WEAPONS) {
          const w = m.WEAPONS[id];
          if (!w) continue;
          if (w.name) this._names[id] = w.name;
          if (Number.isFinite(w.price)) this._prices[id] = w.price;
          if ((w.slot === 1 || w.slot === 2) &&
            Number.isFinite(w.damage) && Number.isFinite(w.rpm) && w.rpm > 0) {
            this._wstats[id] = { dmg: w.damage, rpm: w.rpm };
          }
          if (Number.isFinite(w.maxCarry)) this._maxCarry[id] = w.maxCarry;
        }
      }
      if (m && Array.isArray(m.BUY_MENU) && m.BUY_MENU.length) {
        const cats = m.BUY_MENU
          .filter((c) => c && c.category && Array.isArray(c.items) && c.items.length)
          .map((c) => ({ category: c.category, items: c.items.slice() }));
        if (cats.length) {
          const hasGear = cats.some((c) => c.items.indexOf('armor') !== -1 || c.items.indexOf('kit') !== -1);
          if (!hasGear) cats.push({ category: 'Gear', items: ['armor', 'kit'] });
          this._buyCats = cats;
        }
      }
      if (this._built && this._el.buyCats) this._buildBuyRows();
    }).catch(() => { /* fallback tables remain in use */ });
  }

  // --------------------------------------------------------------------------
  // DOM construction
  // --------------------------------------------------------------------------

  _build(root) {
    if (this._built) return;
    this._built = true;
    this._root = root;
    root.style.pointerEvents = 'none';
    // A build without a game service (a static site on its own) is solo
    // play: online rooms, leaderboards and the server-saved career are hidden.
    this._offline = serviceOffline();
    root.classList.toggle('svc-offline', this._offline);

    const style = document.createElement('style');
    style.id = 'hud-style';
    style.textContent = this._css();
    root.appendChild(style);

    root.insertAdjacentHTML('beforeend', this._html());

    const $ = (id) => root.querySelector('#' + id);
    this._el = {
      game: $('hud-game'),
      healthNum: $('hud-health-num'),
      healthBox: $('hud-health'),
      armorBox: $('hud-armor'),
      armorNum: $('hud-armor-num'),
      moneyBox: $('hud-money'),
      moneyNum: $('hud-money-num'),
      ammoBox: $('hud-ammo'),
      ammoMag: $('hud-ammo-mag'),
      ammoRes: $('hud-ammo-reserve'),
      weaponName: $('hud-weapon-name'),
      reload: $('hud-reload'),
      timerNum: $('hud-timer-num'),
      bombIco: $('hud-bomb-ico'),
      scoreCt: $('hud-score-ct'),
      scoreT: $('hud-score-t'),
      round: $('hud-round'),
      feed: $('hud-killfeed'),
      radio: $('hud-radio'),
      radar: $('hud-radar'),
      radarCanvas: $('hud-radar-canvas'),
      crosshair: $('hud-crosshair'),
      scorePop: $('hud-score-pop'),
      tags: $('hud-tags'),
      streaks: $('hud-streaks'),
      objective: $('hud-objective'),
      scoreCtLabel: $('hud-score-ct-label'),
      scoreTLabel: $('hud-score-t-label'),
      chL: $('hud-ch-l'), chR: $('hud-ch-r'), chT: $('hud-ch-t'), chB: $('hud-ch-b'),
      hitmarker: $('hud-hitmarker'),
      killcue: $('hud-killcue'),
      killcueMain: $('hud-killcue-main'),
      killcueName: $('hud-killcue-name'),
      vignette: $('hud-vignette'),
      deathFx: $('hud-deathfx'),
      wedges: $('hud-wedges'),
      flash: $('hud-flash'),
      scope: $('hud-scope'),
      scopeZoom: $('hud-scope-zoom'),
      msg: $('hud-msg'),
      msgMain: $('hud-msg-main'),
      msgSub: $('hud-msg-sub'),
      defuse: $('hud-defuse'),
      defuseLabel: $('hud-defuse-label'),
      defuseFill: $('hud-defuse-fill'),
      defuseNote: $('hud-defuse-note'),
      useHint: $('hud-usehint'),
      death: $('hud-death'),
      killcam: $('hud-killcam'),
      killcamKiller: $('hud-killcam-killer'),
      killcamDetail: $('hud-killcam-detail'),
      killcamSkip: $('hud-killcam-skip'),
      killcamFill: $('hud-killcam-fill'),
      deathMain: $('hud-death-main'),
      deathKiller: $('hud-death-killer'),
      deathHint: $('hud-death-hint'),
      deathClass: $('hud-death-class'),
      scoreboard: $('hud-scoreboard'),
      sbScore: $('hud-sb-score'),
      sbBody: $('hud-sb-body'),
      buy: $('hud-buy'),
      buyCats: $('hud-buy-cats'),
      buyFunds: $('hud-buy-funds'),
      buyTimer: $('hud-buy-timer'),
      buyClose: $('hud-buy-close'),
      buyFeedback: $('hud-buy-feedback'),
      buyFeedbackText: $('hud-buy-feedback-text'),
      menu: $('hud-menu'),
      start: $('hud-start'),
      startSub: $('hud-start-sub'),
      onlineOpen: $('hud-online-open'),
      settingsOpen: $('hud-settings-open'),
      settingsPanel: $('hud-menu-settings'),
      lookSensitivity: $('hud-look-sensitivity'),
      volume: $('hud-volume'),
      volumeOutput: $('hud-volume-output'),
      fov: $('hud-fov'),
      fovOutput: $('hud-fov-output'),
      lookSensitivityOutput: $('hud-look-sensitivity-output'),
      brightness: $('hud-brightness'),
      announcer: $('hud-announcer'),
      announcerOutput: $('hud-announcer-output'),
      showFps: $('hud-show-fps'),
      aimToggle: $('hud-aim-toggle'),
      aimToggleOutput: $('hud-aim-toggle-output'),
      crouchToggle: $('hud-crouch-toggle'),
      crouchToggleOutput: $('hud-crouch-toggle-output'),
      invertY: $('hud-invert-y'),
      invertYOutput: $('hud-invert-y-output'),
      adsSensitivity: $('hud-ads-sensitivity'),
      adsSensitivityOutput: $('hud-ads-sensitivity-output'),
      killcamSetting: $('hud-killcam-setting'),
      killcamSettingOutput: $('hud-killcam-setting-output'),
      showFpsOutput: $('hud-show-fps-output'),
      renderScale: $('hud-render-scale'),
      renderScaleOutput: $('hud-render-scale-output'),
      graphics: $('hud-graphics'),
      graphicsNote: $('hud-graphics-note'),
      graphicsDetail: $('hud-graphics-detail'),
      graphicsReload: $('hud-graphics-reload'),
      brightnessOutput: $('hud-brightness-output'),
      settingsReset: $('hud-settings-reset'),
      settingsStatus: $('hud-settings-status'),
      buyHintKey: $('hud-buy-hint-key'),
      mapPicker: $('hud-map-picker'),
      modePicker: $('hud-mode-picker'),
      botSkillRow: $('hud-bot-skill'),
      classPicker: $('hud-class-picker'),
      classRow: $('hud-class-row'),
      classEdit: $('hud-class-edit'),
      classEditor: $('hud-class-editor'),
      className: $('hud-class-name'),
      classReset: $('hud-class-reset'),
      classPerkDetail: $('hud-class-perk-detail'),
      career: $('hud-career'),
      careerToggle: $('hud-career-toggle'),
      careerBody: $('hud-career-body'),
      careerName: $('hud-career-name'),
      careerTier: $('hud-career-tier'),
      careerOverall: $('hud-career-overall'),
      careerBots: $('hud-career-bots'),
      careerScore: $('hud-career-score'),
      careerXpFill: $('hud-career-xp-fill'),
      careerXpLabel: $('hud-career-xp-label'),
      careerRival: $('hud-career-rival'),
      careerSync: $('hud-career-sync'),
      careerLeaderboard: $('hud-career-leaderboard'),
      careerPodium: $('hud-career-podium'),
      dailyTitle: $('hud-daily-title'),
      dailyDescription: $('hud-daily-description'),
      dailyProgress: $('hud-daily-progress'),
      dailyFill: $('hud-daily-fill'),
      dailyReward: $('hud-daily-reward'),
      botCta: $('hud-bot-cta'),
      leaderboardOpen: $('hud-leaderboard-open'),
      leaderboard: $('hud-leaderboard'),
      leaderboardClose: $('hud-leaderboard-close'),
      leaderboardRefresh: $('hud-leaderboard-refresh'),
      leaderboardBody: $('hud-leaderboard-body'),
      leaderboardStatus: $('hud-leaderboard-status'),
      leaderboardName: $('hud-leaderboard-name'),
      leaderboardCharacter: $('hud-leaderboard-character'),
      leaderboardAvatar: $('hud-leaderboard-avatar'),
      leaderboardSelf: $('hud-leaderboard-self'),
      careerDossier: $('hud-career-dossier'),
      careerRecords: $('hud-career-records'),
      careerAchievements: $('hud-career-achievements'),
      careerNextGoal: $('hud-career-next-goal'),
      profile: $('hud-profile'),
      profileClose: $('hud-profile-close'),
      profileCancel: $('hud-profile-cancel'),
      profileForm: $('hud-profile-form'),
      profileName: $('hud-profile-name'),
      profileCharacters: $('hud-profile-characters'),
      profileMenuLabel: $('hud-menu-profile-label'),
      progressCopy: $('hud-progress-copy'),
      progressRestore: $('hud-progress-restore'),
      progressKey: $('hud-progress-key'),
      progressStatus: $('hud-progress-status'),
      progressDetails: $('hud-progress-details'),
      progressNewWrap: $('hud-progress-new-wrap'),
      progressNew: $('hud-progress-new'),
      progressNewConfirm: $('hud-progress-new-confirm'),
      progressNewCancel: $('hud-progress-new-cancel'),
      progressNewCommit: $('hud-progress-new-commit'),
      pause: $('hud-pause'),
      tips: $('hud-tips'),
      end: $('hud-end'),
      endTitle: $('hud-end-title'),
      endSub: $('hud-end-sub'),
      endScore: $('hud-end-score'),
      endKd: $('hud-end-kd'),
      endRank: $('hud-end-rank'),
      endRewards: $('hud-end-rewards'),
      endRewardPoints: $('hud-end-reward-points'),
      endRewardRank: $('hud-end-reward-rank'),
      endRewardLevel: $('hud-end-reward-level'),
      endXpFill: $('hud-end-xp-fill'),
      endXpLabel: $('hud-end-xp-label'),
      endUnlocks: $('hud-end-unlocks'),
      endLeaderboard: $('hud-end-leaderboard'),
      restart: $('hud-restart'),
      endMenu: $('hud-end-menu'),
      pauseMenu: $('hud-pause-menu'),
      pauseResume: $('hud-pause-resume'),
      pauseSettings: $('hud-pause-settings'),
      pauseHowto: $('hud-pause-howto'),
      pausePanel: $('hud-pause-panel'),
      howto: $('hud-howto'),
      howtoBody: $('hud-howto-body'),
      howtoClose: $('hud-howto-close'),
      howtoOpen: $('hud-howto-open'),
      restartMain: $('hud-restart-main'),
      restartSub: $('hud-restart-sub'),
      progressToasts: $('hud-progression-toasts'),
      fps: $('hud-fps'),
    };
    this._el.bindingButtons = [...root.querySelectorAll('[data-binding-action]')];

    // wedge pool
    for (let i = 0; i < 4; i++) {
      const w = document.createElement('div');
      w.className = 'hud-wedge';
      this._el.wedges.appendChild(w);
      this._wedges.push({ el: w, yaw: 0, ttl: 0, visible: false });
    }

    // radar backing store
    const dpr = this._radarDpr = Math.min(window.devicePixelRatio || 1, 2);
    const rc = this._el.radarCanvas;
    if (rc) {
      rc.width = RADAR_SIZE * dpr;
      rc.height = RADAR_SIZE * dpr;
      this._radarCtx = rc.getContext('2d');
    }

    this._buildBuyRows();
    this._bindMenuControls();

    // interactive bits
    if (this._el.start) {
      this._el.start.addEventListener('click', () => this._startSoloMatch());
    }
    if (this._el.restart) {
      this._el.restart.addEventListener('click', () => this._handleEndPrimaryAction());
    }
    if (this._el.deathClass) {
      // Touch players have no number keys: tap to cycle the next class.
      this._el.deathClass.addEventListener('click', (event) => {
        event.stopPropagation();
        const loadouts = this.game.loadouts;
        if (!loadouts || this.game.player?.alive !== false) return;
        loadouts.select((loadouts.selected + 1) % loadouts.classes.length);
      });
    }
    if (this._el.endMenu) {
      this._el.endMenu.addEventListener('click', () => this._returnToMenu());
    }
    if (this._el.pauseMenu) {
      this._el.pauseMenu.addEventListener('click', (event) => {
        // The overlay itself resumes on click; this button must not.
        event.stopPropagation();
        // Quitting mid-match is a two-step action so a stray click cannot end it.
        const btn = this._el.pauseMenu;
        if (btn.dataset.armed !== '1') {
          btn.dataset.armed = '1';
          btn.textContent = 'CLICK AGAIN TO QUIT';
          clearTimeout(this._pauseMenuTimer);
          this._pauseMenuTimer = setTimeout(() => {
            btn.dataset.armed = '';
            btn.textContent = 'QUIT TO MAIN MENU';
          }, 3000);
          return;
        }
        clearTimeout(this._pauseMenuTimer);
        btn.dataset.armed = '';
        btn.textContent = 'QUIT TO MAIN MENU';
        this._returnToMenu();
      });
    }
    this._el.pauseResume?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.game.input && typeof this.game.input.requestLock === 'function') {
        this.game.input.requestLock();
      }
    });
    this._el.pauseSettings?.addEventListener('click', (event) => {
      event.stopPropagation();
      this._setPauseSettingsOpen(!this._pauseSettingsOpen);
    });
    this._el.pauseHowto?.addEventListener('click', (event) => {
      event.stopPropagation();
      this._setHowToOpen(true);
    });
    this._el.howtoOpen?.addEventListener('click', () => this._setHowToOpen(true));
    this._el.howtoClose?.addEventListener('click', (event) => {
      event.stopPropagation();
      this._setHowToOpen(false);
    });
    this._el.howto?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target === this._el.howto) this._setHowToOpen(false);
    });
    if (this._el.pause) {
      this._el.pause.addEventListener('click', (event) => {
        // Only a click on the backdrop resumes: the settings panel and the
        // buttons on the overlay must stay usable while paused.
        if (event.target?.closest?.('button, input, select, label, #hud-pause-panel')) return;
        if (this.game.input && typeof this.game.input.requestLock === 'function') {
          this.game.input.requestLock();
        }
      });
    }
    if (this._el.buyClose) {
      this._el.buyClose.addEventListener('click', () => this._setBuyOpen(false));
    }

    // initial visibility matches phase 'menu' until first update flips it
    if (this._el.game) this._el.game.style.display = 'none';
    if (this._el.menu) this._el.menu.style.display = 'flex';
    this._renderCareer(this.game?.leaderboard?.getProgression?.() || null);
    this._hydrateCareer();
  }

  _bindMenuControls() {
    if (this._el.mapPicker) {
      for (const button of this._el.mapPicker.querySelectorAll('[data-map-id]')) {
        button.addEventListener('click', () => { if (!this._cache.roomGuest) this._selectMap(button.dataset.mapId); });
      }
    }
    this._selectMap(this._selectedMapId, false);
    if (this._el.modePicker) {
      for (const button of this._el.modePicker.querySelectorAll('[data-mode-id]')) {
        button.addEventListener('click', () => { if (!this._cache.roomGuest) this._selectMode(button.dataset.modeId); });
      }
    }
    if (this._el.botSkillRow) {
      for (const button of this._el.botSkillRow.querySelectorAll('[data-bot-skill]')) {
        button.addEventListener('click', () => { if (!this._cache.roomGuest) this._selectBotSkill(button.dataset.botSkill); });
      }
    }
    let savedSkill = null;
    try { savedSkill = localStorage.getItem(BOT_SKILL_STORAGE_KEY); } catch { /* private mode */ }
    this._selectBotSkill(this.game?.botSkill || savedSkill, { notify: false });
    this._bindClassControls();
    let savedMode = null;
    try { savedMode = localStorage.getItem('tiny-strike-mode'); } catch { /* private mode */ }
    this._selectMode(this.game?.selectedMode || savedMode);

    const open = () => this._setLeaderboardOpen(true);
    if (this._el.leaderboardOpen) this._el.leaderboardOpen.addEventListener('click', open);
    if (this._el.careerLeaderboard) this._el.careerLeaderboard.addEventListener('click', open);
    if (this._el.endLeaderboard) this._el.endLeaderboard.addEventListener('click', open);
    if (this._el.leaderboardClose) {
      this._el.leaderboardClose.addEventListener('click', () => this._setLeaderboardOpen(false));
    }
    if (this._el.leaderboardRefresh) {
      this._el.leaderboardRefresh.addEventListener('click', () => {
        this._loadLeaderboard(this._leaderboardCategory);
      });
    }
    if (this._el.leaderboard) {
      this._el.leaderboard.addEventListener('click', (event) => {
        if (event.target === this._el.leaderboard) this._setLeaderboardOpen(false);
      });
      for (const tab of this._el.leaderboard.querySelectorAll('[data-leaderboard-category]')) {
        tab.addEventListener('click', () => this._loadLeaderboard(tab.dataset.leaderboardCategory));
      }
    }

    this._renderProfileChoices();
    this._syncProfileUi();
    for (const button of this._root.querySelectorAll('.hud-profile-open')) {
      button.addEventListener('click', () => this._setProfileOpen(true, button));
    }
    if (this._el.profileClose) {
      this._el.profileClose.addEventListener('click', () => this._setProfileOpen(false));
    }
    if (this._el.profileCancel) {
      this._el.profileCancel.addEventListener('click', () => this._setProfileOpen(false));
    }
    if (this._el.profile) {
      this._el.profile.addEventListener('click', (event) => {
        if (event.target === this._el.profile) this._setProfileOpen(false);
      });
    }
    if (this._el.profileForm) {
      this._el.profileForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this._saveProfile();
        this._setProfileOpen(false);
      });
    }
    if (this._el.progressCopy) {
      this._el.progressCopy.addEventListener('click', () => this._copyProgressKey());
    }
    if (this._el.progressRestore) {
      this._el.progressRestore.addEventListener('click', () => this._restoreProgressKey());
    }
    if (this._el.progressNew) {
      this._el.progressNew.addEventListener('click', () => this._setNewCareerConfirm(true));
    }
    if (this._el.progressNewCancel) {
      this._el.progressNewCancel.addEventListener('click', () => this._setNewCareerConfirm(false));
    }
    if (this._el.progressNewCommit) {
      this._el.progressNewCommit.addEventListener('click', () => this._startFreshCareer());
    }
    if (this._el.botCta) {
      this._el.botCta.addEventListener('click', () => this._startSoloMatch());
    }
    if (this._el.careerToggle) {
      this._el.careerToggle.addEventListener('click', () => {
        this._setCareerOpen(this._el.careerBody ? this._el.careerBody.hidden : false);
      });
    }
    if (this._el.onlineOpen) {
      this._el.onlineOpen.addEventListener('click', () => this._setOnlineOpen(!this._onlineOpen));
    }
    if (this._el.settingsOpen) {
      this._el.settingsOpen.addEventListener('click', () => this._setSettingsOpen(!this._settingsOpen));
    }
    this._bindSettingsControls();
    this._watchOnlinePanel();
  }

  _setCareerOpen(open) {
    this._careerOpen = !!open;
    if (this._el.careerBody) this._el.careerBody.hidden = !this._careerOpen;
    if (this._el.careerToggle) {
      this._el.careerToggle.setAttribute('aria-expanded', this._careerOpen ? 'true' : 'false');
    }
    if (this._el.career) this._el.career.classList.toggle('open', this._careerOpen);
  }

  _setOnlineOpen(open) {
    if (open && this._settingsOpen) this._setSettingsOpen(false);
    // The list only polls while open, so opening it fetches a fresh one.
    if (open && !this._onlineOpen) this.game?.multiplayer?.refreshRooms?.();
    this._onlineOpen = !!open;
    if (this._el.menu) this._el.menu.classList.toggle('mn-online-open', this._onlineOpen);
    if (this._el.onlineOpen) {
      this._el.onlineOpen.setAttribute('aria-expanded', this._onlineOpen ? 'true' : 'false');
      this._el.onlineOpen.classList.toggle('open', this._onlineOpen);
    }
    if (this._onlineOpen && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const panel = this._root && this._root.querySelector('#mp-panel');
        if (panel && typeof panel.scrollIntoView === 'function') {
          panel.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
        }
      });
    }
  }

  _setSettingsOpen(open) {
    const panelHadFocus = !open && !!this._el.settingsPanel?.contains?.(
      globalThis.document?.activeElement
    );
    if (open && this._onlineOpen) this._setOnlineOpen(false);
    this._settingsOpen = !!open;
    if (!this._settingsOpen) this._cancelBindingCapture('panel-closed');
    if (this._el.menu) this._el.menu.classList.toggle('mn-settings-open', this._settingsOpen);
    if (this._el.settingsPanel) this._el.settingsPanel.hidden = !this._settingsOpen;
    if (this._el.settingsOpen) {
      this._el.settingsOpen.setAttribute('aria-expanded', this._settingsOpen ? 'true' : 'false');
      this._el.settingsOpen.classList.toggle('open', this._settingsOpen);
    }
    if (this._settingsOpen && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        this._el.settingsPanel?.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() });
      });
    }
    if (panelHadFocus) this._el.settingsOpen?.focus?.();
  }

  _bindSettingsControls() {
    const settings = this.game?.settings;
    if (!settings) return;

    this._el.lookSensitivity?.addEventListener('input', (event) => {
      settings.setLookSensitivity(event.currentTarget.value);
      this._syncSettingsUi();
    });
    this._el.brightness?.addEventListener('input', (event) => {
      settings.setBrightnessEv(event.currentTarget.value);
      this._syncSettingsUi();
    });
    this._el.volume?.addEventListener('input', (event) => {
      settings.setVolume(event.currentTarget.value);
      this._syncSettingsUi();
    });
    this._el.fov?.addEventListener('input', (event) => {
      settings.setFov(event.currentTarget.value);
      this._syncSettingsUi();
    });
    this._el.announcer?.addEventListener('change', (event) => {
      settings.setAnnouncer(event.currentTarget.checked);
      this._syncSettingsUi();
    });
    if (this._el.graphics) {
      for (const button of this._el.graphics.querySelectorAll('[data-graphics]')) {
        button.addEventListener('click', () => {
          settings.setGraphics(button.dataset.graphics);
          this._graphicsChanged = true;
          this._syncSettingsUi();
        });
      }
    }
    this._el.renderScale?.addEventListener('input', (event) => {
      settings.setRenderScale(event.currentTarget.value);
      this._syncSettingsUi();
    });
    this._el.graphicsReload?.addEventListener('click', () => globalThis.location?.reload?.());
    this._el.killcamSetting?.addEventListener('change', (event) => {
      settings.setKillcam(event.currentTarget.checked);
      this._syncSettingsUi();
    });
    this._el.crouchToggle?.addEventListener('change', (event) => {
      settings.setCrouchToggle(event.currentTarget.checked);
      this._syncSettingsUi();
    });
    this._el.invertY?.addEventListener('change', (event) => {
      settings.setInvertY(event.currentTarget.checked);
      this._syncSettingsUi();
    });
    this._el.adsSensitivity?.addEventListener('input', (event) => {
      settings.setAdsSensitivity(event.currentTarget.value);
      this._syncSettingsUi();
    });
    this._el.aimToggle?.addEventListener('change', (event) => {
      settings.setAimToggle(event.currentTarget.checked);
      this.game.input?.clearAimLatch?.();
      this._syncSettingsUi();
    });
    this._el.showFps?.addEventListener('change', (event) => {
      settings.setShowFps(event.currentTarget.checked);
      this._syncSettingsUi();
    });
    this._el.settingsReset?.addEventListener('click', () => {
      // Two steps, like QUIT: one stray click must not wipe every binding.
      const btn = this._el.settingsReset;
      clearTimeout(this._settingsResetTimer);
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = 'CLICK AGAIN TO RESET';
        this._settingsResetTimer = setTimeout(() => {
          btn.dataset.armed = '';
          btn.textContent = 'RESET DEFAULTS';
        }, 3000);
        return;
      }
      btn.dataset.armed = '';
      btn.textContent = 'RESET DEFAULTS';
      this._cancelBindingCapture('reset');
      settings.reset();
      // A pinned preset back to AUTO is a graphics change like any other: the
      // note and RELOAD NOW have to say so.
      this._graphicsChanged = true;
      this._setSettingsStatus('DEFAULT SETTINGS RESTORED');
      this._syncSettingsUi();
    });
    for (const button of this._el.bindingButtons || []) {
      button.addEventListener('click', () => {
        this._startBindingCapture(button.dataset.bindingAction, button);
      });
    }
    this._syncSettingsUi();
  }

  _startBindingCapture(actionId, button) {
    const definition = bindingDefinition(actionId);
    const settings = this.game?.settings;
    const input = this.game?.input;
    if (!definition || !settings || typeof input?.captureNextKey !== 'function') return;

    this._cancelBindingCapture('superseded');
    this._bindingCaptureAction = definition.id;
    this._setSettingsStatus('PRESS A KEY FOR ' + definition.label.toUpperCase() + ' · ESC CANCELS');
    this._syncSettingsUi();

    const started = input.captureNextKey((key, meta = {}) => {
      if (this._bindingCaptureAction !== definition.id) return;
      this._bindingCaptureAction = null;
      if (!key || meta.cancelled) {
        this._setSettingsStatus('KEY CHANGE CANCELLED');
        this._syncSettingsUi();
        button?.focus?.();
        return;
      }

      const result = settings.rebind(definition.id, key);
      if (result.rejected) {
        this._setSettingsStatus('THAT KEY CANNOT BE ASSIGNED');
      } else if (result.swappedActionId) {
        const swapped = bindingDefinition(result.swappedActionId);
        this._setSettingsStatus(
          definition.label.toUpperCase() + ' AND ' +
          (swapped?.label || result.swappedActionId).toUpperCase() + ' SWAPPED'
        );
      } else {
        this._setSettingsStatus(
          definition.label.toUpperCase() + ' → ' + formatKeyLabel(result.key)
        );
      }
      this._syncSettingsUi();
      button?.focus?.();
    }, (message) => this._setSettingsStatus(message));

    if (!started) {
      this._bindingCaptureAction = null;
      this._setSettingsStatus('RETURN TO THE MENU BEFORE CHANGING KEYS');
      this._syncSettingsUi();
    }
  }

  _cancelBindingCapture(reason = 'cancelled') {
    if (!this._bindingCaptureAction) return false;
    this._bindingCaptureAction = null;
    this.game?.input?.cancelKeyCapture?.(reason);
    this._syncSettingsUi();
    return true;
  }

  _setSettingsStatus(message) {
    if (this._el.settingsStatus) this._el.settingsStatus.textContent = String(message || '');
  }

  /** Keys that pick classes 1-5 while dead (the weapon keys plus streak 1). */
  _classKeysLabel() {
    const labels = ['weapon1', 'weapon2', 'weapon3', 'weapon4', 'streak1'].map((id) => this._bindingLabel(id));
    return labels.join('') === '12345' ? '1–5' : labels.join('/');
  }

  _bindingLabel(actionId) {
    const settings = this.game?.settings;
    if (settings && typeof settings.getLabel === 'function') return settings.getLabel(actionId);
    const definition = bindingDefinition(actionId);
    return formatKeyLabel(definition?.defaultKey);
  }

  _syncSettingsUi() {
    const settings = this.game?.settings;
    if (!settings || !this._el) return;

    if (this._el.lookSensitivity) this._el.lookSensitivity.value = String(settings.lookSensitivity);
    if (this._el.lookSensitivityOutput) {
      this._el.lookSensitivityOutput.value =
        this._el.lookSensitivityOutput.textContent = Number(settings.lookSensitivity).toFixed(2) + '×';
    }
    if (this._el.brightness) this._el.brightness.value = String(settings.brightnessEv);
    if (this._el.announcer) this._el.announcer.checked = settings.announcer !== false;
    if (this._el.announcerOutput) this._el.announcerOutput.textContent = settings.announcer !== false ? 'ON' : 'OFF';
    if (this._el.showFps) this._el.showFps.checked = !!settings.showFps;
    if (this._el.aimToggle) this._el.aimToggle.checked = !!settings.aimToggle;
    if (this._el.aimToggleOutput) this._el.aimToggleOutput.textContent = settings.aimToggle ? 'ON' : 'OFF';
    if (this._el.crouchToggle) this._el.crouchToggle.checked = !!settings.crouchToggle;
    if (this._el.crouchToggleOutput) this._el.crouchToggleOutput.textContent = settings.crouchToggle ? 'ON' : 'OFF';
    if (this._el.invertY) this._el.invertY.checked = !!settings.invertY;
    if (this._el.invertYOutput) this._el.invertYOutput.textContent = settings.invertY ? 'ON' : 'OFF';
    if (this._el.adsSensitivity) this._el.adsSensitivity.value = String(settings.adsSensitivity ?? 1);
    if (this._el.adsSensitivityOutput) {
      this._el.adsSensitivityOutput.value =
        this._el.adsSensitivityOutput.textContent = Number(settings.adsSensitivity ?? 1).toFixed(2) + '×';
    }
    if (this._el.killcamSetting) this._el.killcamSetting.checked = settings.killcam !== false;
    if (this._el.killcamSettingOutput) this._el.killcamSettingOutput.textContent = settings.killcam !== false ? 'ON' : 'OFF';
    if (this._el.showFpsOutput) this._el.showFpsOutput.textContent = settings.showFps ? 'ON' : 'OFF';
    if (this._el.renderScale) this._el.renderScale.value = String(renderScaleSliderValue(settings.renderScale));
    if (this._el.renderScaleOutput) {
      this._el.renderScaleOutput.value = this._el.renderScaleOutput.textContent = renderScaleLabel(settings.renderScale);
    }
    if (this._el.graphics) {
      // The preset is chosen at load: name what is running, and say so once
      // the cards no longer match it.
      const picked = settings.graphics || 'auto';
      const current = this.game?.gfxPreset;
      const wanted = typeof settings.graphicsPreset === 'function'
        ? settings.graphicsPreset(this.game?.gfxDevice || {}) : current;
      const pending = !!(this._graphicsChanged && current && wanted !== current);
      const presetName = (id) => GRAPHICS_LABELS[id] || String(id || '').toUpperCase();
      for (const button of this._el.graphics.querySelectorAll('[data-graphics]')) {
        const on = button.dataset.graphics === picked;
        button.classList.toggle('selected', on);
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (this._el.graphicsNote) {
        this._el.graphicsNote.textContent = pending
          ? 'APPLIES AFTER RELOAD'
          : picked === 'auto' && current
            ? 'AUTO · USING ' + presetName(current)
            : presetName(picked) + ' · IN USE';
      }
      if (this._el.graphicsDetail) {
        const detail = GRAPHICS_DETAILS[picked] || '';
        const resolved = picked === 'auto' ? (pending ? (wanted || current) : current) : '';
        this._el.graphicsDetail.textContent = resolved
          ? (pending ? 'RELOAD STARTS ON ' : 'THIS DEVICE IS ON ') + presetName(resolved) + ' · ' + detail
          : detail;
      }
      // Reloading mid-match would end it: only offered from the main menu.
      if (this._el.graphicsReload) {
        this._el.graphicsReload.hidden = !pending || this.game?.state?.phase !== 'menu';
      }
    }
    if (this._el.volume) this._el.volume.value = String(settings.volume);
    if (this._el.volumeOutput) {
      const label = settings.volume > 0 ? Math.round(settings.volume * 100) + '%' : 'MUTED';
      this._el.volumeOutput.value = this._el.volumeOutput.textContent = label;
    }
    if (this._el.fov) this._el.fov.value = String(settings.fov);
    if (this._el.fovOutput) this._el.fovOutput.value = this._el.fovOutput.textContent = settings.fov + '°';
    if (this._el.brightnessOutput) {
      const label = brightnessLabel(settings.brightnessEv);
      this._el.brightnessOutput.value = this._el.brightnessOutput.textContent = label;
    }
    if (this._el.buyHintKey) this._el.buyHintKey.textContent = this._bindingLabel('buy');

    for (const button of this._el.bindingButtons || []) {
      const actionId = button.dataset.bindingAction;
      const definition = bindingDefinition(actionId);
      const capturing = actionId === this._bindingCaptureAction;
      const label = this._bindingLabel(actionId);
      const key = button.querySelector?.('kbd');
      if (key) key.textContent = capturing ? 'PRESS KEY' : label;
      button.classList?.toggle?.('capturing', capturing);
      button.toggleAttribute?.('aria-busy', capturing);
      button.setAttribute?.(
        'aria-label',
        capturing
          ? 'Press a key for ' + (definition?.label || actionId) + '; Escape cancels'
          : 'Change ' + (definition?.label || actionId) + ', currently ' + label
      );
    }
  }

  // The room lobby lives inside #mp-panel (built by the network module). If a
  // lobby becomes visible while the ONLINE section is collapsed — e.g. a
  // reconnect restores the room — expand the section so it is never hidden.
  _watchOnlinePanel() {
    if (!this._el.menu || typeof MutationObserver === 'undefined') return;
    const sync = () => {
      const lobby = this._el.menu.querySelector('#mp-lobby');
      if (lobby && lobby.style.display !== 'none' && !this._onlineOpen) this._setOnlineOpen(true);
    };
    this._mpObserver = new MutationObserver(sync);
    this._mpObserver.observe(this._el.menu, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
    });
  }

  _startSoloMatch() {
    const mp = this.game.multiplayer;
    if (mp && (mp._connecting || mp.connected)) return; // in (or joining) a room
    this.game.sessionMode = 'solo';
    // PLAY is allowed to pay the map-build cost, but it must never start the
    // round on the previously loaded arena if it beats the debounce.
    this._flushMapSelection();
    this.game.events.emit('ui:start', { mapId: this._selectedMapId });
    if (this.game.input && typeof this.game.input.requestLock === 'function') {
      this.game.input.requestLock();
    }
  }

  _profileSnapshot() {
    const profile = this.game && this.game.profile;
    if (profile) {
      const current = typeof profile.get === 'function' ? profile.get() : profile;
      return {
        callsign: String(current?.callsign || profile.callsign || 'Operative'),
        appearanceId: String(current?.appearanceId || profile.appearanceId || 'vanguard'),
      };
    }
    const leaderboard = this.game && this.game.leaderboard;
    return {
      callsign: leaderboard && typeof leaderboard.getPlayerName === 'function'
        ? String(leaderboard.getPlayerName() || 'Operative')
        : 'Operative',
      appearanceId: 'vanguard',
    };
  }

  _profilePresets() {
    const presets = this.game?.profile?.presets;
    if (Array.isArray(presets) && presets.length) return presets;
    return [
      { id: 'vanguard', label: 'Vanguard', description: 'Classic field uniform', swatch: '#71845a' },
      { id: 'ranger', label: 'Ranger', description: 'Urban tactical kit', swatch: '#526d78' },
      { id: 'breacher', label: 'Breacher', description: 'Heavy assault fatigues', swatch: '#9a7851' },
      { id: 'shadow', label: 'Shadow', description: 'Dark operations gear', swatch: '#3f4941' },
    ];
  }

  _renderProfileChoices() {
    if (!this._el.profileCharacters) return;
    const presets = this._profilePresets();
    this._el.profileCharacters.innerHTML = presets.map((preset) =>
      '<button class="profile-character" type="button" data-appearance-id="' + esc(preset.id) +
      '" aria-pressed="false"><span class="profile-portrait" aria-hidden="true"><i></i></span>' +
      '<span class="profile-character-copy"><strong>' + esc(preset.label || preset.id) + '</strong>' +
      '<small>' + esc(preset.description || 'Tactical operative') + '</small></span><b>SELECTED</b></button>'
    ).join('');
    for (const [index, button] of [...this._el.profileCharacters.querySelectorAll('[data-appearance-id]')].entries()) {
      const swatch = String(presets[index]?.swatch || '#71845a');
      button.style.setProperty('--profile-swatch', swatch);
      button.addEventListener('click', () => {
        this._profileAppearance = button.dataset.appearanceId || 'vanguard';
        this._syncProfileSelection();
      });
    }
  }

  _syncProfileSelection() {
    if (!this._el.profileCharacters) return;
    for (const button of this._el.profileCharacters.querySelectorAll('[data-appearance-id]')) {
      const selected = button.dataset.appearanceId === this._profileAppearance;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  _syncProfileUi() {
    const current = this._profileSnapshot();
    this._profileAppearance = current.appearanceId;
    const preset = this._profilePresets().find((item) => item.id === current.appearanceId);
    const appearanceLabel = String(preset?.label || current.appearanceId || 'Vanguard').toUpperCase();
    if (this._el.profileName) this._el.profileName.value = current.callsign;
    if (this._el.leaderboardName) this._el.leaderboardName.textContent = current.callsign;
    if (this._el.leaderboardCharacter) this._el.leaderboardCharacter.textContent = appearanceLabel;
    if (this._el.profileMenuLabel) {
      this._el.profileMenuLabel.textContent = current.callsign.toUpperCase() + ' · ' + appearanceLabel;
    }
    const swatch = String(preset?.swatch || '#71845a');
    if (this._el.leaderboardAvatar) this._el.leaderboardAvatar.style.setProperty('--profile-swatch', swatch);
    this._syncProfileSelection();
    this._syncProgressRecoveryUi();
  }

  _syncProgressRecoveryUi() {
    const recovery = this.game?.leaderboard?.getIdentityStatus?.() === 'recovery-required';
    if (this._el.progressNewWrap) this._el.progressNewWrap.classList.toggle('recovery', recovery);
    if (this._el.progressNew) {
      this._el.progressNew.textContent = recovery ? 'START NEW CAREER INSTEAD' : 'START NEW CAREER';
    }
    if (recovery && this._profileOpen && this._el.progressDetails) this._el.progressDetails.open = true;
  }

  _saveProfile() {
    const callsign = String(this._el.profileName?.value || '').trim();
    const profile = this.game && this.game.profile;
    if (profile && typeof profile.update === 'function') {
      profile.update({ callsign, appearanceId: this._profileAppearance });
    } else {
      const leaderboard = this.game && this.game.leaderboard;
      if (leaderboard && typeof leaderboard.setPlayerName === 'function') {
        leaderboard.setPlayerName(callsign);
      }
    }
    this._syncProfileUi();
  }

  async _hydrateCareer(force = false) {
    const client = this.game?.leaderboard;
    if (this._offline || !client || this._careerLoading || (this._careerLoaded && !force)) return;
    this._careerLoading = true;
    if (this._el.careerSync) this._el.careerSync.textContent = 'SYNCING PROGRESS…';
    try {
      const progression = typeof client.loadCareer === 'function'
        ? await client.loadCareer()
        : client.getProgression?.();
      this._careerLoaded = true;
      this._renderCareer(progression);
      const board = await client.list('overall', 5).catch(() => null);
      if (board) this._renderCareerPodium(board.entries || []);
    } catch (error) {
      const recovery = client.getIdentityStatus?.() === 'recovery-required';
      if (this._el.careerSync) {
        this._el.careerSync.textContent = recovery
          ? 'PROGRESS KEY NEEDS RECOVERY — OPEN PROFILE'
          : 'OFFLINE · CACHED PROGRESS SHOWN';
      }
      this._renderCareer(client.getProgression?.() || null);
    } finally {
      this._careerLoading = false;
    }
  }

  _careerStanding(progression) {
    const standing = progression?.standing || {};
    return {
      id: String(standing.id || this.game?.leaderboard?.playerId || ''),
      name: String(standing.name || this._profileSnapshot().callsign || 'Operative'),
      score: Math.max(0, Number(standing.score ?? standing.scores?.overall) || 0),
      ranks: standing.ranks || {},
      scores: standing.scores || {},
      stats: standing.stats || {},
    };
  }

  _rankLabel(value) {
    const rank = Number(value);
    return Number.isFinite(rank) && rank > 0 ? '#' + Math.round(rank) : 'UNRANKED';
  }

  _renderCareer(progression) {
    const client = this.game?.leaderboard;
    const cached = progression || client?.getProgression?.() || null;
    if (cached) this._lastProgression = cached;
    const data = cached || this._lastProgression || {};
    const standing = this._careerStanding(data);
    const tierName = String(data.tier?.name || 'Rookie').toUpperCase();
    const level = Math.max(1, Number(data.level) || 1);
    const xpInto = Math.max(0, Number(data.xpIntoLevel) || 0);
    const xpNeed = Math.max(1, Number(data.xpForNextLevel) || 500);
    const xpPct = Math.max(0, Math.min(100, xpInto / xpNeed * 100));
    const profile = this._profileSnapshot();

    if (this._el.careerName) this._el.careerName.textContent = standing.name || profile.callsign;
    if (this._el.careerTier) this._el.careerTier.textContent = tierName + ' · CAREER LEVEL ' + level;
    if (this._el.careerOverall) this._el.careerOverall.textContent = this._rankLabel(standing.ranks.overall);
    if (this._el.careerBots) this._el.careerBots.textContent = this._rankLabel(standing.ranks.bots);
    if (this._el.careerScore) this._el.careerScore.textContent = standing.score.toLocaleString();
    if (this._el.careerXpFill) this._el.careerXpFill.style.width = xpPct.toFixed(1) + '%';
    if (this._el.careerXpLabel) {
      this._el.careerXpLabel.textContent = xpInto.toLocaleString() + ' / ' + xpNeed.toLocaleString() + ' XP TO LEVEL ' + (level + 1);
    }
    if (this._el.careerSync) {
      const status = client?.getIdentityStatus?.();
      const achievementStatus = Math.max(0, Number(data.achievementCount) || 0) + '/' +
        Math.max(0, Number(data.achievementTotal) || 12) + ' ACHIEVEMENTS';
      this._el.careerSync.textContent = client?.persistenceStatus === 'memory-only'
        ? 'THIS BROWSER BLOCKS AUTO-SAVE · COPY A PROGRESS KEY'
        : status === 'recovery-required'
        ? 'PROGRESS KEY NEEDS RECOVERY — OPEN PROFILE'
        : cached ? 'CAREER SAVED · ' + achievementStatus : 'CREATING YOUR SAVED CAREER…';
    }

    const contract = data.dailyContract || {};
    const targets = contract.targets || { matches: 3, wins: 2, kills: 20 };
    const progress = contract.progress || { matches: 0, wins: 0, kills: 0 };
    const goalTotal = Math.max(1, Number(targets.matches || 0) + Number(targets.wins || 0) + Number(targets.kills || 0));
    const doneTotal = Math.min(Number(progress.matches || 0), Number(targets.matches || 0)) +
      Math.min(Number(progress.wins || 0), Number(targets.wins || 0)) +
      Math.min(Number(progress.kills || 0), Number(targets.kills || 0));
    const dailyPct = contract.completed ? 100 : Math.max(0, Math.min(100, doneTotal / goalTotal * 100));
    if (this._el.dailyTitle) this._el.dailyTitle.textContent = contract.title || 'DAILY BOT OPS';
    if (this._el.dailyDescription) {
      this._el.dailyDescription.textContent = contract.completed
        ? 'CONTRACT COMPLETE · RETURN TOMORROW FOR A NEW MISSION'
        : (contract.description || 'Win against bots and sharpen your combat record.');
    }
    if (this._el.dailyProgress) {
      this._el.dailyProgress.textContent =
        Math.min(Number(progress.matches || 0), Number(targets.matches || 0)) + '/' + (targets.matches || 0) + ' MATCHES  ·  ' +
        Math.min(Number(progress.wins || 0), Number(targets.wins || 0)) + '/' + (targets.wins || 0) + ' WINS  ·  ' +
        Math.min(Number(progress.kills || 0), Number(targets.kills || 0)) + '/' + (targets.kills || 0) + ' KILLS';
    }
    if (this._el.dailyFill) this._el.dailyFill.style.width = dailyPct.toFixed(1) + '%';
    if (this._el.dailyReward) this._el.dailyReward.textContent = '+' + Math.max(0, Number(contract.rewardXp) || 250) + ' BONUS XP';
    if (this._el.botCta) {
      this._el.botCta.querySelector('.btn-main').textContent = contract.completed ? 'KEEP TRAINING' : 'PLAY DAILY BOT OPS';
      this._el.botCta.querySelector('.btn-sub').textContent = contract.completed ? 'BUILD RECORDS · EARN RANK XP' : 'NO WAITING · START NOW';
    }
    this._renderLeaderboardSelf(data);
    this._renderCareerDossier(data);
    this._syncProgressRecoveryUi();
  }

  _renderCareerPodium(entries) {
    if (!this._el.careerPodium) return;
    const top = entries.slice(0, 3);
    if (!top.length) {
      this._el.careerPodium.innerHTML = '<span>THE BOARD IS OPEN</span><strong>BE THE FIRST TO SET THE PACE</strong>';
      return;
    }
    this._el.careerPodium.innerHTML = top.map((entry) =>
      '<span><b>#' + Math.max(1, Number(entry.rank) || 1) + '</b>' + esc(entry.playerName) +
      '<em>' + Math.max(0, Number(entry.score) || 0).toLocaleString() + '</em></span>'
    ).join('');
    const progress = this._lastProgression || this.game?.leaderboard?.getProgression?.();
    const standing = this._careerStanding(progress || {});
    const rival = standing.ranks.overall > 1
      ? entries.find((entry) => entry.rank === standing.ranks.overall - 1)
      : null;
    if (this._el.careerRival) {
      this._el.careerRival.textContent = rival
        ? Math.max(0, rival.score - standing.score + 1).toLocaleString() + ' POINTS TO PASS ' + String(rival.playerName || 'THE NEXT OPERATIVE').toUpperCase()
        : standing.ranks.overall === 1
          ? 'YOU SET THE PACE · DEFEND #1'
          : standing.ranks.overall
            ? this._rankLabel(standing.ranks.overall) + ' OVERALL · ANOTHER WIN MOVES YOU CLOSER'
            : 'FINISH A MATCH TO ENTER THE RANKS';
    }
  }

  _renderLeaderboardSelf(progression) {
    if (!this._el.leaderboardSelf) return;
    const data = progression || this._lastProgression || {};
    const standing = this._careerStanding(data);
    const tier = String(data.tier?.name || 'Rookie').toUpperCase();
    this._el.leaderboardSelf.innerHTML =
      '<span><small>YOUR OVERALL RANK</small><strong>' + this._rankLabel(standing.ranks.overall) + '</strong></span>' +
      '<span><small>SEASON SCORE</small><strong>' + standing.score.toLocaleString() + '</strong></span>' +
      '<span><small>CAREER LEVEL</small><strong>' + Math.max(1, Number(data.level) || 1) + ' · ' + esc(tier) + '</strong></span>' +
      '<span><small>ACHIEVEMENTS</small><strong>' + Math.max(0, Number(data.achievementCount) || 0) + '/' + Math.max(0, Number(data.achievementTotal) || 12) + '</strong></span>';
  }

  _formatCareerRecord(id, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    if (id === 'kd') return number.toFixed(2);
    if (id === 'fastestWin') {
      const seconds = Math.max(0, Math.round(number));
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }
    return Math.round(number).toLocaleString();
  }

  _careerNextGoal(progression = {}) {
    const supplied = Array.isArray(progression.nextAchievements) ? progression.nextAchievements[0] : null;
    if (supplied) {
      const current = Number(supplied.current ?? supplied.progress?.current ?? supplied.progress);
      const target = Number(supplied.target ?? supplied.progress?.target);
      return {
        title: String(supplied.title || supplied.name || 'NEXT ACHIEVEMENT').toUpperCase(),
        description: String(supplied.description || 'Keep playing to unlock it.'),
        current: Number.isFinite(current) ? Math.max(0, current) : null,
        target: Number.isFinite(target) && target > 0 ? target : null,
      };
    }

    const unlocked = new Set((Array.isArray(progression.achievements) ? progression.achievements : [])
      .map((achievement) => String(achievement?.id || '')));
    let best = null;
    for (const goal of CAREER_GOALS) {
      if (unlocked.has(goal.id)) continue;
      const current = Math.max(0, Number(goal.value(progression)) || 0);
      const ratio = Math.min(1, current / goal.target);
      if (!best || ratio > best.ratio) best = { ...goal, current, ratio };
    }
    if (best) return best;

    if (!unlocked.has('flawless_match')) {
      return { title: 'UNTOUCHABLE', description: 'Win with at least 5 kills and no deaths.', current: null, target: null };
    }
    const level = Math.max(1, Number(progression.level) || 1);
    const xpInto = Math.max(0, Number(progression.xpIntoLevel) || 0);
    const xpNeed = Math.max(1, Number(progression.xpForNextLevel) || 500);
    return {
      title: 'LEVEL ' + (level + 1),
      description: Math.max(0, xpNeed - xpInto).toLocaleString() + ' XP REMAINING',
      current: xpInto,
      target: xpNeed,
    };
  }

  _renderCareerDossier(progression) {
    const data = progression || this._lastProgression || {};
    if (this._el.careerRecords) {
      const records = data.records && typeof data.records === 'object' ? data.records : {};
      this._el.careerRecords.innerHTML = Object.entries(CAREER_RECORD_LABELS).map(([id, label]) => {
        const record = records[id];
        const map = record?.mapId ? String(record.mapId).replace(/_/g, ' ').toUpperCase() : '';
        return '<span><small>' + esc(label) + '</small><strong>' + esc(this._formatCareerRecord(id, record?.value)) + '</strong>' +
          (map ? '<em>' + esc(map) + '</em>' : '<em>SET YOUR RECORD</em>') + '</span>';
      }).join('');
    }

    const achievements = Array.isArray(data.achievements) ? data.achievements : [];
    if (this._el.careerAchievements) {
      this._el.careerAchievements.innerHTML = achievements.length
        ? achievements.map((achievement) =>
          '<span><b aria-hidden="true">✦</b><span><strong>' + esc(achievement?.title || 'ACHIEVEMENT') + '</strong>' +
          '<small>' + esc(achievement?.description || 'Career badge earned.') + '</small></span></span>'
        ).join('')
        : '<p>NO BADGES YET · COMPLETE THE NEXT GOAL TO EARN YOUR FIRST</p>';
    }

    const goal = this._careerNextGoal(data);
    if (this._el.careerNextGoal) {
      const progress = Number.isFinite(goal.current) && Number.isFinite(goal.target)
        ? ' · ' + Math.min(goal.current, goal.target).toLocaleString() + '/' + goal.target.toLocaleString()
        : '';
      this._el.careerNextGoal.textContent = 'NEXT: ' + goal.title + progress + ' — ' + goal.description;
    }
  }

  async _copyProgressKey() {
    const key = this.game?.leaderboard?.getProgressCode?.() || '';
    if (!key) {
      if (this._el.progressStatus) this._el.progressStatus.textContent = 'PROGRESS IS STILL SYNCING. TRY AGAIN IN A MOMENT.';
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      if (this._el.progressStatus) this._el.progressStatus.textContent = 'PRIVATE PROGRESS KEY COPIED · STORE IT SAFELY';
    } catch {
      if (this._el.progressStatus) this._el.progressStatus.textContent = 'COPY WAS BLOCKED BY THE BROWSER. USE HTTPS AND TRY AGAIN.';
    }
  }

  async _restoreProgressKey() {
    const client = this.game?.leaderboard;
    const key = String(this._el.progressKey?.value || '').trim();
    if (!client?.restoreProgressCode) return;
    if (this._el.progressStatus) this._el.progressStatus.textContent = 'VERIFYING PRIVATE PROGRESS KEY…';
    try {
      const progression = await client.restoreProgressCode(key);
      if (this._el.progressKey) this._el.progressKey.value = '';
      this._careerLoaded = true;
      this._renderCareer(progression);
      if (this._el.progressStatus) this._el.progressStatus.textContent = 'CAREER RESTORED ON THIS DEVICE';
    } catch (error) {
      if (this._el.progressStatus) this._el.progressStatus.textContent = String(error?.message || 'COULD NOT RESTORE THAT KEY').toUpperCase();
    }
  }

  _setNewCareerConfirm(open) {
    const visible = !!open;
    const panel = this._el.progressNewConfirm;
    if (panel) {
      panel.hidden = !visible;
      panel.style.display = visible ? 'grid' : 'none';
      if (typeof panel.setAttribute === 'function') panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }
    if (this._el.progressNew) this._el.progressNew.setAttribute?.('aria-expanded', visible ? 'true' : 'false');
    if (visible) this._el.progressNewCommit?.focus?.();
  }

  async _startFreshCareer() {
    const client = this.game?.leaderboard;
    if (!client || typeof client.startFreshProgress !== 'function') return;
    if (this._el.progressNewCommit?.disabled) return;
    if (this._el.progressNewCommit) this._el.progressNewCommit.disabled = true;
    if (this._el.progressStatus) this._el.progressStatus.textContent = 'CREATING A NEW PERMANENT CAREER…';
    try {
      await client.startFreshProgress();
      let progression = client.getProgression?.() || null;
      if (!progression && typeof client.loadCareer === 'function') progression = await client.loadCareer();
      this._careerLoaded = true;
      this._lastProgression = progression || null;
      this._lastReward = null;
      this._renderCareer(progression);
      this._setNewCareerConfirm(false);
      this._syncProgressRecoveryUi();
      if (this._el.progressStatus) this._el.progressStatus.textContent = 'NEW CAREER READY · THIS DEVICE WILL RESUME IT AUTOMATICALLY';
    } catch (error) {
      if (this._el.progressStatus) {
        this._el.progressStatus.textContent = String(error?.message || 'COULD NOT START A NEW CAREER').toUpperCase();
      }
    } finally {
      if (this._el.progressNewCommit) this._el.progressNewCommit.disabled = false;
    }
  }

  _setProfileOpen(open, returnFocus = null) {
    this._profileOpen = !!open;
    if (!this._el.profile) return;
    if (open) {
      this._profileReturnFocus = returnFocus || document.activeElement;
      this._syncProfileUi();
    }
    this._el.profile.style.display = open ? 'flex' : 'none';
    this._el.profile.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      // Now, not a frame later (a slow menu frame left focus behind the
      // panel). On touch the close button, not the callsign: focusing the
      // field would pop the on-screen keyboard over the operatives.
      const target = this.game?.input?.touchMode ? this._el.profileClose : this._el.profileName;
      (target || this._el.profileName)?.focus?.();
    } else if (this._profileReturnFocus && typeof this._profileReturnFocus.focus === 'function') {
      this._profileReturnFocus.focus();
      this._profileReturnFocus = null;
    }
  }

  _selectMap(value, notify = true) {
    const mode = normalizeModeId(this.game?.selectedMode);
    // A map out of the mode's rotation (Frostline in S&D) is not selectable.
    const id = mapForMode(value, mode);
    this._selectedMapId = id;
    if (this.game) this.game.selectedMapId = id;
    try { localStorage.setItem('tiny-strike-map', id); } catch { /* private mode */ }
    if (this._el.mapPicker) {
      for (const button of this._el.mapPicker.querySelectorAll('[data-map-id]')) {
        const selected = button.dataset.mapId === id;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        if (selected && typeof button.scrollIntoView === 'function' &&
          typeof requestAnimationFrame === 'function') {
          // The map row scrolls horizontally on small screens — keep the
          // active card visible without yanking the page vertically. Deferred
          // a frame because the initial call happens while the menu is still
          // display:none (no layout, scrollIntoView would be a no-op).
          requestAnimationFrame(() => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        }
      }
    }
    this._updateStartSub();
    if (notify) this._queueMapSelection(id);
    else this._cancelMapSelection();
  }

  _selectMode(value, options = {}) {
    const id = normalizeModeId(value);
    const changed = this.game && this.game.selectedMode !== id;
    if (this.game) this.game.selectedMode = id;
    // A room's mode mirrored from the host is not this player's preference,
    // and neither is a pick a room guest is not allowed to make.
    const mp = this.game?.multiplayer;
    const roomGuest = !!(mp && mp.connected && !mp.active && !mp.isHost);
    if (options.persist !== false && !roomGuest) {
      try { localStorage.setItem('tiny-strike-mode', id); } catch { /* private mode */ }
    }
    if (this._el.modePicker) {
      for (const button of this._el.modePicker.querySelectorAll('[data-mode-id]')) {
        const selected = button.dataset.modeId === id;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      }
    }
    if (this._el.classPicker) this._el.classPicker.hidden = !isRespawnMode(id);
    this._refreshMapAvailability(id);
    // Picking a mode the current map is not in moves to a map that runs it.
    if (!mapSupportsMode(this._selectedMapId, id) && !roomGuest) {
      this._selectMap(mapForMode(this._selectedMapId, id), options.notify !== false);
    }
    this._updateStartSub();
    if (changed && options.notify !== false) this.game?.events?.emit?.('ui:mode-select', { mode: id });
  }

  /**
   * In someone else's room the map, mode and bot pickers mirror the host's
   * choice: shown as locked (and HOST PICKS) instead of accepting a click,
   * snapping back and printing an error.
   */
  _syncRoomGuestPickers() {
    const mp = this.game?.multiplayer;
    const guest = !!(mp && mp.connected && !mp.active && !mp.isHost);
    if (guest === this._cache.roomGuest) return;
    this._cache.roomGuest = guest;
    this._el.menu?.classList.toggle('mn-room-guest', guest);
    for (const root of [this._el.mapPicker, this._el.modePicker, this._el.botSkillRow]) {
      if (!root) continue;
      for (const button of root.querySelectorAll('[data-map-id],[data-mode-id],[data-bot-skill]')) {
        if (guest) button.setAttribute('aria-disabled', 'true');
        else button.removeAttribute('aria-disabled');
      }
    }
  }

  /** Pick the bot difficulty tier (src/ai/skill.js) for the next match. */
  _selectBotSkill(value, options = {}) {
    const id = normalizeBotSkill(value);
    const changed = this.game && this.game.botSkill !== id;
    const mp = this.game?.multiplayer;
    const roomGuest = !!(mp && mp.connected && !mp.active && !mp.isHost);
    // A room's tier mirrored from the host is not this player's preference.
    if (this.game && options.persist !== false) this.game.botSkill = id;
    if (options.persist !== false && !roomGuest) {
      try { localStorage.setItem(BOT_SKILL_STORAGE_KEY, id); } catch { /* private mode */ }
    }
    if (this._el.botSkillRow) {
      for (const button of this._el.botSkillRow.querySelectorAll('[data-bot-skill]')) {
        const selected = button.dataset.botSkill === id;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      }
    }
    this._updateStartSub();
    if (changed && options.notify !== false) this.game?.events?.emit?.('ui:bot-skill-select', { skill: id });
  }

  /** Grey out the maps a mode does not run on. */
  _refreshMapAvailability(mode) {
    if (!this._el.mapPicker) return;
    const label = GAME_MODES[normalizeModeId(mode)]?.label || '';
    for (const button of this._el.mapPicker.querySelectorAll('[data-map-id]')) {
      const ok = mapSupportsMode(button.dataset.mapId, mode);
      button.disabled = !ok;
      button.classList.toggle('unavailable', !ok);
      if (ok) {
        button.removeAttribute('title');
        delete button.dataset.unavailable;
      } else {
        button.setAttribute('title', 'Not in the ' + label + ' rotation');
        // Disabled buttons rarely show a tooltip: say why on the card.
        button.dataset.unavailable = 'NOT IN ' + (GAME_MODES[normalizeModeId(mode)]?.short || label);
      }
    }
  }

  _bindClassControls() {
    const loadouts = this.game?.loadouts;
    const el = this._el;
    if (!loadouts || !el.classRow) return;
    const fill = (select, ids, label) => {
      if (!select) return;
      select.innerHTML = ids.map((id) => '<option value="' + id + '">' + esc(label(id)) + '</option>').join('');
      select._labelOf = label;
      select.addEventListener('change', () => {
        loadouts.edit(loadouts.selected, { [select.dataset.slot]: select.value });
        this._renderClasses();
      });
    };
    const weaponName = (id) => String(this._names[id] || id).toUpperCase();
    fill(document.getElementById('hud-class-primary'), PRIMARIES, weaponName);
    fill(document.getElementById('hud-class-attachment'), ATTACHMENT_IDS, (id) => ATTACHMENTS[id].label);
    fill(document.getElementById('hud-class-secondary'), SECONDARIES, weaponName);
    fill(document.getElementById('hud-class-lethal'), LETHALS, weaponName);
    fill(document.getElementById('hud-class-tactical'), TACTICALS, weaponName);
    fill(document.getElementById('hud-class-perk'), PERK1_IDS, (id) => PERKS[id].label);
    fill(document.getElementById('hud-class-perk2'), PERK2_IDS, (id) => PERKS[id].label);
    el.className?.addEventListener('change', () => {
      loadouts.edit(loadouts.selected, { name: el.className.value });
      this._renderClasses();
    });
    el.classEdit?.addEventListener('click', () => {
      const open = el.classEditor.hidden;
      el.classEditor.hidden = !open;
      el.classEdit.setAttribute('aria-expanded', open ? 'true' : 'false');
      el.classEdit.textContent = open ? 'DONE' : 'EDIT';
    });
    el.classReset?.addEventListener('click', () => {
      loadouts.resetClass(loadouts.selected);
      this._renderClasses();
    });
    el.classRow.addEventListener('click', (e) => {
      const button = e.target.closest('[data-class-index]');
      if (!button) return;
      loadouts.select(Number(button.dataset.classIndex));
      this._renderClasses();
    });
    this.game.events.on('loadout:select', () => this._renderClasses());
    // Unlocks restored from the synced career (a new device, a recovered key).
    this.game.events.on('progress:sync', () => {
      this._renderClasses();
      this._renderStreakPicker?.();
    });
    this.game.events.on('progress:local', (d) => {
      this._localProgress = d || null;
      this._renderClasses();
      // A streak unlocked by this rank-up becomes pickable now, not on reload.
      this._renderStreakPicker?.();
      // Rank-ups and unlocks join the end screen whichever way it renders.
      const endRewards = this._el.endRewards;
      if (this.game.state?.phase === 'gameEnd' && endRewards) {
        if (this._endUnranked) this._renderUnrankedEndState({ reason: this._unrankedReason });
        else if (!endRewards.classList.contains('unranked')) this._renderEndRewards();
      }
    });
    this.game.events.on('ui:start', () => { this._localProgress = null; });
    this.game.events.on('ui:restart', () => { this._localProgress = null; });
    this._renderClasses();
    this._bindStreakPicker();
  }

  _bindStreakPicker() {
    const streaks = this.game?.streaks;
    const a = document.getElementById('hud-streak-a');
    const b = document.getElementById('hud-streak-b');
    if (!streaks || !a || !b) return;
    const render = () => {
      const progression = this.game?.progression;
      const options = STREAK_IDS.map((id) => {
        const locked = progression && !progression.isUnlocked(id);
        const text = STREAKS[id].label + ' · ' + STREAKS[id].cost + (locked ? ' · RANK ' + progression.unlockRank(id) : '');
        // Locked streaks can't be picked (an old pick stays visible until changed).
        const disabled = locked && !streaks.selected.includes(id) ? ' disabled' : '';
        return '<option value="' + id + '"' + disabled + '>' + esc(text) + '</option>';
      }).join('');
      a.innerHTML = options;
      b.innerHTML = options;
      [a.value, b.value] = streaks.selected;
      const detail = document.getElementById('hud-streak-detail');
      if (detail) {
        // A saved pick that is still locked is swapped in the match: say so.
        const effective = progression && typeof progression.resolveStreaks === 'function'
          ? progression.resolveStreaks(streaks.selected, STREAK_IDS) : streaks.selected;
        detail.textContent = streaks.selected.map((id, i) => {
          const used = effective[i];
          return used && used !== id
            ? STREAKS[id].label + ' AT RANK ' + progression.unlockRank(id) + ' — ' + STREAKS[used].label + ' FOR NOW'
            : STREAKS[id].detail;
        }).join('  ·  ');
      }
    };
    this._renderStreakPicker = render;
    const onChange = (changed) => {
      const next = [a.value, b.value];
      // Both slots on one streak: the other slot keeps its previous pick.
      if (next[0] === next[1]) next[changed === a ? 1 : 0] = streaks.selected.find((id) => id !== changed.value);
      streaks.selectStreaks(next); // stored cheapest first
      render();
    };
    a.addEventListener('change', () => onChange(a));
    b.addEventListener('change', () => onChange(b));
    render();
  }

  _renderClasses() {
    const loadouts = this.game?.loadouts;
    const el = this._el;
    if (!loadouts || !el.classRow) return;
    const weaponName = (id) => String(this._names[id] || id).toUpperCase();
    const progressionForCards = this.game?.progression;
    // A locked primary is the pick that matters: name it, its rank, and what
    // is used meanwhile. Other locked picks are counted.
    const lockNote = (c, shown, pending) => {
      if (shown.primary !== c.primary) {
        const rank = progressionForCards?.unlockRank?.(c.primary);
        const others = pending - 1;
        return '🔒 ' + weaponName(c.primary) + (rank ? ' AT RANK ' + rank : '') +
          ' — ' + weaponName(shown.primary) + ' FOR NOW' + (others > 0 ? ' · +' + others + ' LOCKED' : '');
      }
      // An attachment comes from kills with the gun, not from rank.
      const attachmentLocked = (shown.attachment || 'none') !== (c.attachment || 'none');
      const rankLocked = pending - (attachmentLocked ? 1 : 0);
      const parts = [];
      if (attachmentLocked) {
        const need = ATTACHMENT_LEVEL[c.attachment] || 1;
        const kills = Math.floor((progressionForCards?.weaponXp?.[c.primary] || 0) / WEAPON_XP_PER_KILL);
        const goal = Math.ceil((WEAPON_LEVEL_XP[need - 1] || 0) / WEAPON_XP_PER_KILL);
        parts.push((ATTACHMENTS[c.attachment]?.short || c.attachment).toUpperCase() + ' AT ' +
          weaponName(c.primary) + ' LV ' + need + ' (' + kills + '/' + goal + ' KILLS)');
      }
      if (rankLocked > 0) parts.push(rankLocked + (rankLocked === 1 ? ' PICK UNLOCKS' : ' PICKS UNLOCK') + ' WITH RANK');
      return '🔒 ' + parts.join(' · ');
    };
    // Rebuilding the row would drop keyboard focus to the page: remember
    // which card had it and give it back.
    const focusedIndex = el.classRow.contains(document.activeElement)
      ? document.activeElement?.dataset?.classIndex
      : undefined;
    el.classRow.innerHTML = loadouts.classes.map((c, i) => {
      // Cards show what you actually deploy with at your rank; picks that
      // are still locked are counted, not shouted.
      const shown = progressionForCards && typeof progressionForCards.resolveLoadout === 'function'
        ? progressionForCards.resolveLoadout(c)
        : c;
      const pending = ['primary', 'attachment', 'secondary', 'lethal', 'tactical', 'perk', 'perk2']
        .filter((slot) => (shown[slot] || 'none') !== (c[slot] || 'none')).length;
      return '<button type="button" class="mn-class' + (i === loadouts.selected ? ' selected' : '') +
        '" data-class-index="' + i + '" aria-pressed="' + (i === loadouts.selected) + '">' +
        '<small>' + (i + 1) + '</small><strong>' + esc(c.name) + '</strong>' +
        '<span>' + esc(weaponName(shown.primary)) + (shown.attachment && shown.attachment !== 'none' ? ' + ' + esc(ATTACHMENTS[shown.attachment].short) : '') +
        ' · ' + esc(weaponName(shown.secondary)) + '</span>' +
        '<em>' + esc([PERKS[shown.perk]?.label, PERKS[shown.perk2]?.label].filter(Boolean).join(' + ')) + '</em>' +
        (pending ? '<small class="mn-class-lock">' + esc(lockNote(c, shown, pending)) + '</small>' : '') +
        '</button>';
    }).join('');
    if (focusedIndex !== undefined) el.classRow.querySelector('[data-class-index="' + focusedIndex + '"]')?.focus?.({ preventScroll: true });
    const active = loadouts.active();
    if (el.className && document.activeElement !== el.className) el.className.value = active.name;
    const progression = this.game?.progression;
    for (const slot of ['primary', 'attachment', 'secondary', 'lethal', 'tactical', 'perk', 'perk2']) {
      const select = document.getElementById('hud-class-' + slot);
      if (!select) continue;
      // Locked options stay visible with what unlocks them.
      for (const option of select.options) {
        const base = select._labelOf ? select._labelOf(option.value) : option.value;
        let lock = '';
        if (progression && slot === 'attachment') {
          if (!progression.attachmentUnlocked(active.primary, option.value)) {
            lock = ' · ' + weaponName(active.primary) + ' LV ' + (ATTACHMENT_LEVEL[option.value] || 1);
          }
        } else if (progression && !progression.isUnlocked(option.value)) {
          lock = ' · RANK ' + progression.unlockRank(option.value);
        }
        option.textContent = base + lock;
        option.disabled = !!lock && option.value !== active[slot];
      }
      select.value = active[slot];
    }
    const chip = document.getElementById('hud-rank-chip');
    if (chip && progression) {
      const r = progression.summary();
      // The next unlock is the reason to keep going: name it.
      const nextUnlock = this._nextUnlock(r.rank);
      chip.textContent = 'UNLOCK RANK ' + r.rank + ' · ' + r.title + ' · ' + r.xp.toLocaleString('en-US') +
        (r.next > r.floor ? ' / ' + r.next.toLocaleString('en-US') + ' XP' : ' XP') +
        (nextUnlock ? ' · NEXT: ' + nextUnlock.name + ' AT RANK ' + nextUnlock.rank : ' · ALL GEAR UNLOCKED');
    }
    const weaponProgress = document.getElementById('hud-class-weapon-progress');
    if (weaponProgress && progression) {
      // Attachments come from kills with the gun: show the gun's level and
      // how many kills the next attachment needs.
      const level = progression.weaponLevel(active.primary);
      const kills = Math.floor((progression.weaponXp?.[active.primary] || 0) / WEAPON_XP_PER_KILL);
      const next = Object.entries(ATTACHMENT_LEVEL).find(([, lv]) => lv === level + 1);
      const goal = next ? Math.ceil((WEAPON_LEVEL_XP[level] || 0) / WEAPON_XP_PER_KILL) : 0;
      weaponProgress.textContent = weaponName(active.primary) + ' LV ' + level +
        (next ? ' · ' + kills + '/' + goal + ' KILLS → ' + (ATTACHMENTS[next[0]]?.label || next[0]).toUpperCase()
          : ' · EVERY ATTACHMENT UNLOCKED');
    }
    if (el.classPerkDetail) {
      // What the class deploys with: a pick still locked keeps its select
      // (labelled with what unlocks it) but must not have its effect described.
      const used = typeof progression?.resolveLoadout === 'function' ? progression.resolveLoadout(active) : active;
      const att = ATTACHMENTS[used.attachment];
      el.classPerkDetail.textContent = [att && att.detail, PERKS[used.perk]?.detail, PERKS[used.perk2]?.detail]
        .filter(Boolean).join('  ·  ');
    }
  }

  /** The lowest-rank item still locked above `rank`, named, or null. */
  _nextUnlock(rank) {
    let next = null;
    for (const [id, at] of Object.entries(UNLOCK_RANK)) {
      if (at > rank && (!next || at < next.rank)) next = { id, rank: at };
    }
    if (next) next.name = String(this._names[next.id] || PERKS[next.id]?.label || STREAKS[next.id]?.label || next.id).toUpperCase();
    return next;
  }

  _updateStartSub() {
    if (!this._el.startSub) return;
    const entry = MAP_CATALOG.find((map) => map.id === this._selectedMapId);
    const mode = GAME_MODES[normalizeModeId(this.game?.selectedMode)];
    const skill = BOT_SKILLS[normalizeBotSkill(this.game?.botSkill)];
    this._el.startSub.textContent = mode.short + (entry ? ' · ON ' + String(entry.name).toUpperCase() : '') +
      ' · ' + skill.label + ' BOTS';
  }

  _queueMapSelection(id) {
    this._pendingMapSelectId = id;
    if (this._mapSelectTimer !== null) clearTimeout(this._mapSelectTimer);
    this._mapSelectTimer = setTimeout(
      () => this._flushMapSelection(),
      MAP_SELECT_LOAD_DEBOUNCE_MS,
    );
  }

  _cancelMapSelection() {
    if (this._mapSelectTimer !== null) clearTimeout(this._mapSelectTimer);
    this._mapSelectTimer = null;
    this._pendingMapSelectId = null;
  }

  _flushMapSelection() {
    if (this._mapSelectTimer !== null) clearTimeout(this._mapSelectTimer);
    this._mapSelectTimer = null;
    const id = this._pendingMapSelectId;
    this._pendingMapSelectId = null;
    if (!id || !this.game?.events) return false;
    this.game.events.emit('ui:map-select', { mapId: id });
    return true;
  }

  _setLeaderboardOpen(open) {
    this._leaderboardOpen = !!open;
    if (!this._el.leaderboard) return;
    if (open) this._leaderboardReturnFocus = document.activeElement;
    this._el.leaderboard.style.display = open ? 'flex' : 'none';
    this._el.leaderboard.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      this._syncProfileUi();
      this._loadLeaderboard(this._leaderboardCategory);
      // Now, like the other dialogs: a frame later left keyboard focus on the
      // opener behind the panel.
      this._el.leaderboardClose?.focus?.();
    } else if (this._leaderboardReturnFocus && typeof this._leaderboardReturnFocus.focus === 'function') {
      this._leaderboardReturnFocus.focus();
      this._leaderboardReturnFocus = null;
    }
  }

  async _loadLeaderboard(category) {
    const client = this.game && this.game.leaderboard;
    this._leaderboardCategory = ['humans', 'bots', 'overall'].includes(category) ? category : 'overall';
    if (this._el.leaderboard) {
      for (const tab of this._el.leaderboard.querySelectorAll('[data-leaderboard-category]')) {
        const active = tab.dataset.leaderboardCategory === this._leaderboardCategory;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
    const request = ++this._leaderboardRequest;
    this._setLeaderboardState('loading', 'CONTACTING MATCH SERVERS…');
    if (!client || typeof client.list !== 'function') {
      this._setLeaderboardState('error', 'LEADERBOARD SERVICE IS NOT READY');
      return;
    }
    try {
      const result = await client.list(this._leaderboardCategory, 50);
      if (request !== this._leaderboardRequest) return;
      this._renderLeaderboard(result.entries || []);
      if (this._leaderboardCategory === 'overall') this._renderCareerPodium(result.entries || []);
      this._renderScoringRules(result.scoring);
      const updated = result.updatedAt ? new Date(result.updatedAt) : null;
      const suffix = updated && !Number.isNaN(updated.getTime())
        ? ' · UPDATED ' + updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      this._setLeaderboardStatus('TOP 50 OPERATIVES' + suffix);
    } catch (error) {
      if (request !== this._leaderboardRequest) return;
      console.warn('[leaderboard] load failed:', error);
      this._setLeaderboardState('error', 'LEADERBOARD UNAVAILABLE — TRY AGAIN SOON');
    }
  }

  _setLeaderboardState(state, message) {
    if (this._el.leaderboardBody) {
      this._el.leaderboardBody.innerHTML =
        '<div class="lb-state ' + esc(state) + '"><span class="lb-state-mark"></span>' +
        '<strong>' + esc(message) + '</strong>' +
        (state === 'error' ? '<small>PRESS REFRESH TO TRY AGAIN</small>' : '') + '</div>';
    }
    this._setLeaderboardStatus(state === 'loading' ? 'SYNCING GLOBAL RANKINGS' : 'SERVICE STATUS');
  }

  _setLeaderboardStatus(text) {
    if (this._el.leaderboardStatus) this._el.leaderboardStatus.textContent = text;
  }

  _renderLeaderboard(entries) {
    if (!this._el.leaderboardBody) return;
    if (!entries.length) {
      this._el.leaderboardBody.innerHTML =
        '<div class="lb-state empty"><span class="lb-state-mark">◇</span>' +
        '<strong>THE BOARD IS WIDE OPEN</strong><small>COMPLETE A MATCH TO CLAIM FIRST PLACE</small></div>';
      return;
    }
    const progression = this.game?.leaderboard?.getProgression?.() || this._lastProgression || {};
    const standing = this._careerStanding(progression);
    const selfId = standing.id;
    const visible = entries.slice();
    if (selfId && !visible.some((entry) => String(entry.playerId) === selfId) && standing.ranks[this._leaderboardCategory]) {
      const stats = standing.stats[this._leaderboardCategory] ||
        (this._leaderboardCategory === 'overall' ? progression.lifetime : null) || {};
      visible.push({
        playerId: selfId,
        playerName: standing.name,
        rank: standing.ranks[this._leaderboardCategory],
        score: standing.scores[this._leaderboardCategory] || (this._leaderboardCategory === 'overall' ? standing.score : 0),
        wins: Math.max(0, Number(stats.wins) || 0),
        matches: Math.max(0, Number(stats.matches) || 0),
        kills: Math.max(0, Number(stats.kills) || 0),
        deaths: Math.max(0, Number(stats.deaths) || 0),
        winRate: Number(stats.matches) > 0 ? Number(stats.wins || 0) / Number(stats.matches) * 100 : 0,
        level: progression.level || 1, tier: progression.tier || null,
        pinnedSelf: true,
      });
    }
    let rows = '';
    for (const entry of visible) {
      const kills = Number(entry.kills) || 0;
      const deaths = Number(entry.deaths) || 0;
      const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
      const winRate = Number(entry.winRate) > 0
        ? Math.round(entry.winRate)
        : (entry.matches > 0 ? Math.round(entry.wins / entry.matches * 100) : 0);
      const medal = entry.rank === 1 ? '◆' : entry.rank === 2 ? '◇' : entry.rank === 3 ? '△' : '';
      const isSelf = !!(selfId && String(entry.playerId) === selfId);
      rows += '<div class="lb-row rank-' + entry.rank + (isSelf ? ' self' : '') + (entry.pinnedSelf ? ' pinned-self' : '') + '">' +
        '<span class="lb-rank">' + (medal ? '<b>' + medal + '</b>' : '') + '#' + entry.rank + '</span>' +
        '<span class="lb-player">' + esc(entry.playerName) + (isSelf ? '<b class="lb-you">YOU</b>' : '') +
        (entry.level ? '<small class="lb-career">LVL ' + Math.max(1, Number(entry.level) || 1) + ' · ' + esc(entry.tier?.name || 'ROOKIE') + '</small>' : '') + '</span>' +
        '<span class="lb-score">' + Number(entry.score).toLocaleString() + '</span>' +
        '<span>' + entry.wins + '</span><span>' + winRate + '%</span><span>' + kd + '</span>' +
        '</div>';
    }
    this._el.leaderboardBody.innerHTML =
      '<div class="lb-row lb-head"><span>RANK</span><span>OPERATIVE</span><span>SCORE</span>' +
      '<span>WINS</span><span>WIN%</span><span>K/D</span></div>' + rows;
  }

  _renderScoringRules(rules) {
    const el = this._el.leaderboard && this._el.leaderboard.querySelector('#hud-leaderboard-rules');
    if (!el) return;
    if (!rules || typeof rules !== 'object') {
      el.textContent = 'Wins matter most. Kills, headshots, objectives, and completed rounds add score.';
      return;
    }
    const parts = [];
    if (rules.summary) parts.push(String(rules.summary));
    if (Number.isFinite(Number(rules.humanWeight))) {
      parts.push('Human matches earn ' + Number(rules.humanWeight).toFixed(1).replace(/\.0$/, '') + '× value');
    }
    if (Number.isFinite(Number(rules.botDailyFullValueMatches))) {
      parts.push('first ' + Math.round(Number(rules.botDailyFullValueMatches)) + ' bot matches daily score at full value');
    }
    if (Number.isFinite(Number(rules.botDailyReducedRate))) {
      parts.push('later bot matches score ' + Math.round(Number(rules.botDailyReducedRate) * 100) + '%');
    }
    el.textContent = parts.filter(Boolean).join(' · ') ||
      'Wins matter most. Kills, headshots, objectives, and completed rounds add score.';
  }

  _setEndRank(text, state = '') {
    if (!this._el.endRank) return;
    this._el.endRank.textContent = text || '';
    this._el.endRank.className = state;
  }

  _onLeaderboardSubmitted(data) {
    const response = data.response || {};
    const result = response.result || {};
    const rewards = response.rewards || {};
    const progression = response.progression || this.game?.leaderboard?.getProgression?.() || null;
    const entry = response.standing || response.entry || response.player || response;
    const points = Number(result.points?.overall ?? rewards.xpEarned);
    const totalScore = Number(rewards.scoreAfter ?? entry.score ?? response.score);
    const rank = Number(rewards.rankAfter ?? entry.overallRank ?? entry.rank ?? response.rank);
    let text = 'MATCH RECORDED';
    if (Number.isFinite(points)) text += ' · +' + Math.round(points).toLocaleString() + ' MATCH POINTS';
    if (Number.isFinite(totalScore)) text += ' · ' + Math.round(totalScore).toLocaleString() + ' TOTAL';
    if (Number.isFinite(rank) && rank > 0) text += ' · #' + Math.round(rank) + ' OVERALL';
    this._setEndRank(text, 'success');
    this._endUnranked = false;
    this._lastReward = { response, rewards, result, progression };
    this._renderEndRewards(response);
    this._renderCareer(progression);
  }

  // --------------------------------------------------------------------------
  // Event wiring
  // --------------------------------------------------------------------------

  _bindEvents() {
    const ev = this.game && this.game.events;
    if (!ev) return;

    ev.on('kill', (d) => this._onKill(d || {}));
    ev.on('hud:radio', (d) => this._addRadio(d || {}));
    ev.on('score:award', (d) => this._onScoreAward(d || {}));
    ev.on('streak:ready', (d) => this._showMsg(String(d?.label || '') + ' READY',
      this.game.input?.touchMode ? 'TAP STREAK' : 'PRESS ' + this._bindingLabel('streak' + ((d?.slot ?? 0) + 1)), 2));
    ev.on('streak:activate', (d) => {
      const copy = {
        uav: ['UAV ONLINE', 'ENEMIES MARKED ON RADAR'],
        counteruav: ['COUNTER-UAV ONLINE', 'ENEMY RECON JAMMED'],
        carepackage: ['CARE PACKAGE INBOUND', 'WATCH THE SKY'],
        airstrike: ['AIRSTRIKE INBOUND', 'TAKE COVER'],
      }[d?.id] || [String(d?.label || ''), ''];
      this._showMsg(copy[0], copy[1], 1.8);
    });
    ev.on('streak:enemy', (d) => this._showMsg(d?.jammed ? 'ENEMY UAV JAMMED' : 'ENEMY UAV OVERHEAD',
      d?.jammed ? 'COUNTER-UAV HOLDING' : 'KEEP MOVING', 2.2));
    ev.on('streak:package-landed', () => this._showMsg('', 'CARE PACKAGE ON THE GROUND', 1.4));
    ev.on('streak:package', (d) => this._showMsg(String(d?.label || 'SUPPLIES'),
      d?.reward === 'resupply' ? 'AMMO AND GRENADES REFILLED' : 'CARE PACKAGE BONUS · ' + (this.game.input?.touchMode ? 'TAP STREAK' : 'PRESS ' + this._bindingLabel('streak3')), 2));
    ev.on('objective:hardpoint', () => this._showMsg('HARDPOINT MOVED', 'NEW ZONE ON THE RADAR', 1.6));
    ev.on('objective:flag', (d) => {
      const mine = (this.game.player && this.game.player.team) || 'ct';
      if (d?.owner === mine) this._showMsg('FLAG ' + d.name + ' SECURED', '', 1.4);
      else if (d?.owner && d.previous === mine) this._showMsg('FLAG ' + d.name + ' LOST', '', 1.4);
      else if (d?.owner) this._showMsg('ENEMY TOOK FLAG ' + d.name, '', 1.4);
      else if (d?.previous === mine) this._showMsg('FLAG ' + d.name + ' NEUTRALIZED', 'RETAKE IT', 1.4);
    });
    ev.on('hud:hitmarker', (d) => this._onHitmarker(d || {}));
    ev.on('player:damage', (d) => this._onPlayerDamage(d || {}));
    ev.on('player:death', (d) => this._onPlayerDeath(d || {}));
    ev.on('spectator:target', (d) => {
      this._spectatorTarget = d && d.target ? d.target : null;
      this._cache.spectatorKey = null;
    });
    ev.on('hud:flash', (d) => this._onFlash(d || {}));
    ev.on('hud:stun', (d) => {
      const dur = Math.max(0.3, Number(d && d.duration) || 2);
      this._stun = { dur, t: 0 };
      this._showMsg('STUNNED', '', Math.min(1.2, dur));
    });
    // Semtex stuck to you: the one warning that matters.
    ev.on('grenade:stuck', (d) => {
      if (d && d.victim && d.victim === this.game.player) this._showMsg('STUCK!', 'SEMTEX — NOWHERE TO RUN', 1.6);
    });
    ev.on('weapon:scope', (d) => { if (d) { this._scopeFov = d.fov || 0; } });
    ev.on('weapon:reload:start', () => this._setReloading(true));
    ev.on('weapon:reload:end', () => this._setReloading(false));
    ev.on('weapon:equip', () => this._setReloading(false));
    ev.on('round:start', () => this._onRoundStart());
    ev.on('player:respawn', () => this._onRoundStart());
    ev.on('round:phase', (d) => this._onRoundPhase(d || {}));
    ev.on('round:end', (d) => this._onRoundEnd(d || {}));
    ev.on('game:end', (d) => { this._endInfo = d || null; this._lastReward = null; });
    ev.on('leaderboard:submitting', () => this._setEndRank('CALCULATING YOUR RANK…'));
    ev.on('leaderboard:submitted', (d) => this._onLeaderboardSubmitted(d || {}));
    ev.on('leaderboard:unranked', (d) => {
      this._endUnranked = true;
      this._unrankedReason = d?.reason || null;
      this._renderUnrankedEndState(d || {});
    });
    ev.on('leaderboard:server-recorded', () => {
      this._setEndRank('MATCH SERVER IS VERIFYING YOUR REWARDS…', 'pending');
    });
    ev.on('leaderboard:submit-error', (d) => {
      this._setEndRank(d?.permanent
        ? 'MATCH COULD NOT BE RANKED · ' + readableRejection(d.error)
        : 'SCORE SAVED — IT WILL SYNC WHEN THE LEADERBOARD IS ONLINE', d?.permanent ? 'error' : 'queued');
      // A rejected result never syncs: settle the rewards panel (device XP
      // only) instead of leaving it on SYNCING / VERIFYING for good.
      if (d?.permanent) {
        this._endUnranked = true;
        this._unrankedReason = 'rejected';
        this._renderUnrankedEndState({ reason: 'rejected' });
      } else {
        // Offline: the result is queued, so say so rather than spin.
        this._el.endRewards?.classList.remove('pending');
        if (this._el.endRewardPoints) this._el.endRewardPoints.textContent = 'QUEUED';
        if (this._el.endXpLabel) this._el.endXpLabel.textContent = 'REWARDS WILL SYNC LATER';
      }
    });
    ev.on('leaderboard:identity-lost', () => {
      if (this._el.careerSync) this._el.careerSync.textContent = 'PROGRESS KEY NEEDS RECOVERY — OPEN PROFILE';
    });
    ev.on('leaderboard:persistence-warning', () => {
      if (this._el.careerSync) this._el.careerSync.textContent = 'THIS BROWSER BLOCKS AUTO-SAVE · COPY A PROGRESS KEY';
    });
    ev.on('leaderboard:sync-state', (d) => {
      if (!this._el.careerSync || d?.state === 'ready') return;
      if (d?.state === 'syncing') this._el.careerSync.textContent = 'RECONNECTING SAVED CAREER…';
      else if (d?.state === 'error') this._el.careerSync.textContent = 'OFFLINE · CACHED PROGRESS SHOWN';
    });
    ev.on('progress:updated', (d) => this._renderCareer(d?.progression || null));
    ev.on('leaderboard:career', (d) => this._renderCareer(d?.progression || null));
    ev.on('progress:achievement', (d) => this._showProgressToast('achievement', d || {}));
    ev.on('progress:record', (d) => this._showProgressToast('record', d || {}));
    ev.on('progress:level-up', (d) => this._showProgressToast('level', d || {}));
    ev.on('econ:kill', (d) => this._moneyPop(d && d.reward));
    ev.on('hud:notice', (d) => this._showMsg(d && d.text ? d.text : 'NETWORK UPDATE', '', 2.5));
    ev.on('ui:toggle-buy', () => this._toggleBuy());
    ev.on('input:lock', () => {
      this._locked = true;
      if (this._buyOpen) this._setBuyOpen(false, false); // clicked back into the game
    });
    ev.on('input:unlock', () => { this._locked = false; });
    ev.on('input:lock-error', () => {
      const sub = this._pauseShown && this._el.pause?.querySelector('.pause-sub');
      if (sub) sub.textContent = 'CLICK AGAIN TO RESUME';
    });
    ev.on('bot:fire', (d) => this._onBotFire(d || {}));
    ev.on('bot:death', () => { this._sbDirty = true; });
    ev.on('ui:map-select', () => { this._rb = null; });
    ev.on('map:changed', (d) => {
      this._rb = null;
      if (d && d.mapId) this._selectMap(d.mapId, false);
    });
    ev.on('profile:changed', () => {
      this._sbDirty = true;
      this._syncProfileUi();
    });
    ev.on('settings:changed', () => this._syncSettingsUi());
    ev.on('ui:start', () => this._setSettingsOpen(false));

    // Backup key handling while the buy menu is open (pointer unlocked, the
    // input module may or may not route keys then). Debounced against the
    // 'ui:toggle-buy' the weapons module emits for the same keydown.
    this._onKeydownDom = (e) => {
      if (this._howtoOpen && (e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        this._setHowToOpen(false);
        return;
      }
      if (this._profileOpen && (e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        this._setProfileOpen(false);
        return;
      }
      if (this._leaderboardOpen && (e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        this._setLeaderboardOpen(false);
        return;
      }
      // After the dialogs, which sit above the settings panel.
      if (this._settingsOpen && (e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        this._setSettingsOpen(false);
        return;
      }
      // Settings opened from the pause overlay close the same way.
      if (this._pauseSettingsOpen && (e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        this._setPauseSettingsOpen(false);
        this._el.pauseSettings?.focus?.({ preventScroll: true });
        return;
      }
      // PLAY ONLINE collapses like the other panels close, but not from inside
      // a room, where the panel is the lobby.
      if (this._onlineOpen && (e.key || '').toLowerCase() === 'escape' &&
          (this.game?.state?.phase || 'menu') === 'menu' && !this.game?.multiplayer?.connected) {
        e.preventDefault();
        this._setOnlineOpen(false);
        this._el.onlineOpen?.focus?.();
        return;
      }
      if ((this._howtoOpen || this._profileOpen || this._leaderboardOpen) && e.key === 'Tab') {
        const modal = this._howtoOpen ? this._el.howto : this._profileOpen ? this._el.profile : this._el.leaderboard;
        const focusable = modal ? [...modal.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )] : [];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        // Focus that is not in the dialog at all (still on the opener, or on a
        // control that went away) is brought in rather than walking the page.
        const outside = !modal.contains(document.activeElement);
        if (first && last && (outside || (e.shiftKey ? document.activeElement === first : document.activeElement === last))) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
      }
      if (!this._buyOpen) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'escape') {
        e.preventDefault();
        // The remappable Buy action is routed by Input/Weapons; Escape is the
        // only raw DOM fallback that remains intentionally fixed.
        ev.emit('ui:toggle-buy');
      }
    };
    window.addEventListener('keydown', this._onKeydownDom);
  }

  // --------------------------------------------------------------------------
  // Per-frame update
  // --------------------------------------------------------------------------

  update(dt) {
    if (!this._built) {
      const r = (this.game && this.game.hudRoot) || document.getElementById('hud');
      if (!r) return;
      this._build(r);
    }
    this._time += dt;

    const g = this.game;
    const st = (g && g.state) || {};
    const phase = st.phase || 'menu';

    if (phase !== this._cache.phase) this._onPhaseChange(phase);
    const inGame = phase !== 'menu' && phase !== 'gameEnd';
    if (phase === 'menu') this._syncRoomGuestPickers();
    if (inGame && this._leaderboardOpen) this._setLeaderboardOpen(false);
    if (inGame && this._profileOpen) this._setProfileOpen(false);

    if (inGame) {
      this._updateStats(st);
      this._updateAmmo();
      this._updateTop(st, phase);
      this._updateCrosshair(phase);
      this._updateTarget();
      this._updateTags();
      this._updateStreaks();
      this._updateFeed();
      this._updateDefuse(st, phase);
      this._updateScope();
      this._updateDeath(phase);
      this._updateKillcam();
      this._updateScoreboard(phase);
      this._updateBuy(st);

      // ~20 Hz; the graphics preset can slow it (src/gfx/profiles.js).
      const radarStep = this.game.gfx?.radarInterval || 0.05;
      this._radarTimer += dt;
      if (this._radarTimer >= radarStep) {
        this._radarTimer %= radarStep;
        this._drawRadar(st);
      }
    }

    this._updateOverlays(dt);
    this._updateMsg();
    this._updateTips(inGame);
    if (this._buyAutoPending) {
      if (phase !== 'freeze') this._buyAutoPending = false;
      else if (this._canOpenBuy() && !this._buyOpen) {
        this._buyAutoPending = false;
        this._buyAutoOpened = true;
        this._setBuyOpen(true);
      }
    }
    this._updatePause(phase);
    this._updateFps(dt, !!(g && (g.debug || g.perfOverlay || g.settings?.showFps)));
  }

  // --------------------------------------------------------------------------
  // Phase transitions
  // --------------------------------------------------------------------------

  _onPhaseChange(phase) {
    const prevPhase = this._cache.phase;
    this._cache.phase = phase;
    // The settings copy depends on the phase (RELOAD NOW only from the menu).
    this._syncSettingsUi();
    const el = this._el;
    const inGame = phase !== 'menu' && phase !== 'gameEnd';
    // A replay cut short by the match ending (or a quit) must not leave the
    // HUD in killcam mode: it hides the end-screen progression toasts.
    if (!inGame && this._killcamShown) {
      this._killcamShown = false;
      this._root?.classList.remove('killcam-on');
    }

    if (el.game) el.game.style.display = inGame ? 'block' : 'none';
    if (el.menu) el.menu.style.display = phase === 'menu' ? 'flex' : 'none';

    if (phase === 'gameEnd') {
      // Release the pointer so the RESTART button is actually clickable.
      if (!this.game.debug && document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
      }
      this._fillEndScreen();
      if (el.end) el.end.style.display = 'flex';
      // Keyboard players land on PLAY AGAIN, after a beat so a Space still
      // held from the last fight does not press it.
      clearTimeout(this._endFocusTimer);
      this._endFocusTimer = setTimeout(() => {
        const active = globalThis.document?.activeElement;
        if (this.game.state?.phase === 'gameEnd' && (!active || active === globalThis.document.body)) {
          el.restart?.focus?.({ preventScroll: true });
        }
      }, 1500);
    } else if (el.end) {
      el.end.style.display = 'none';
    }

    if (!inGame && this._buyOpen) this._setBuyOpen(false, false);
    if (phase === 'menu') {
      // Quitting leaves focus on a button that just hid; land keyboard and
      // pad players on PLAY instead of the top of the page.
      const doc = globalThis.document;
      const active = doc?.activeElement;
      if (doc && prevPhase && prevPhase !== 'menu' &&
          (!active || active === doc.body || !active.offsetParent)) {
        el.start?.focus?.({ preventScroll: true });
      }
      this._deathKiller = '';
      this._cache.dead = null;
      this._cache.dying = null;
      clearTimeout(this._buyPromptTimer);
      this._buyAutoPending = false;
    }
  }

  _onRoundStart() {
    this._sbDirty = true;
    this._dmg = 0;
    this._deathKiller = '';
    this._spectatorTarget = null;
    this._cache.dead = null;
    this._cache.dying = null;
    this._cache.spectatorKey = null;
    this._endUnranked = false;
    this._enemyFire.length = 0;
    for (const w of this._wedges) {
      // The update loop only hides a wedge as its ttl runs out, so one still
      // showing at the reset would stay on screen.
      w.ttl = 0;
      if (w.visible) { w.visible = false; w.el.style.opacity = '0'; }
    }
    if (this._el.death) this._el.death.style.display = 'none';
    if (this._el.deathFx) this._el.deathFx.style.opacity = '0';
    this._deathFxOpacity = 0;
    // A full flash outlasts the 3 s respawn: start the new life with clear eyes.
    this._flash = null;
    this._flashOpacity = 0;
    if (this._el.flash) this._el.flash.style.opacity = '0';
  }

  _onRoundPhase(d) {
    const cfg = (this.game && this.game.config) || {};
    switch (d.phase) {
      case 'freeze': {
        const mode = this.game.state && this.game.state.mode;
        if (isRespawnMode(mode) || Number(this.game.state?.round) === 1) this._maybeShowTips();
        if (isRespawnMode(mode)) {
          this._showMsg(GAME_MODES[mode].label, modeRules(mode).brief, TDM.READY_TIME - 0.5);
          break;
        }
        const dur = Math.max(1.5, (cfg.MATCH && cfg.MATCH.FREEZE_TIME || 6) - 0.5);
        const buyPrompt = this.game.input?.touchMode
          ? 'TAP $ BUY FOR EQUIPMENT'
          : 'PRESS ' + this._bindingLabel('buy') + ' TO BUY EQUIPMENT';
        // The first round says what the side is for; the buy prompt follows.
        const brief = Number(this.game.state?.round) === 1 && SD_BRIEF[this.game.player?.team];
        if (brief) {
          const briefDur = Math.min(3, dur / 2);
          this._showMsg(GAME_MODES.sd.label, brief, briefDur);
          clearTimeout(this._buyPromptTimer);
          this._buyPromptTimer = setTimeout(() => {
            // Real time, so it can land in a pause or after a quit into a
            // respawn mode's own freeze.
            if (this.game.state?.phase !== 'freeze' || this.game.paused ||
                isRespawnMode(this.game.state?.mode)) return;
            this._showMsg('BUY PHASE', buyPrompt, dur - briefDur);
            // A first-timer who misses the prompt fights rifles with the
            // starting pistol, so the first match of a visit opens the menu.
            if (!this._buyAutoOpened && !this.game.debug) this._buyAutoPending = true;
          }, briefDur * 1000);
          break;
        }
        this._showMsg('BUY PHASE', buyPrompt, dur);
        break;
      }
      case 'live':
        this._showMsg('GO GO GO!', '', 1.3);
        break;
      case 'planted': {
        const fuse = (cfg.MATCH && cfg.MATCH.BOMB_TIME) || 40;
        const site = d.site ? ('SITE ' + String(d.site).toUpperCase() + ' — ') : '';
        this._showMsg('THE BOMB HAS BEEN PLANTED', site + fuse + ' SECONDS TO DETONATION', 3.2);
        break;
      }
      default:
        break;
    }
  }

  _onRoundEnd(d) {
    this._sbDirty = true;
    const st = (this.game && this.game.state) || {};
    const winRounds = (this.game && this.game.config && this.game.config.MATCH &&
      this.game.config.MATCH.WIN_ROUNDS) || 8;
    const main = faction(d.winner).name + ' WIN';
    const reasons = {
      elimination: 'ENEMY TEAM ELIMINATED',
      time: 'TIME RAN OUT',
      bomb: 'THE BOMB HAS DETONATED',
      defuse: 'THE BOMB HAS BEEN DEFUSED',
    };
    let sub = reasons[d.reason] || '';
    const sc = st.scores || {};
    // Scores already include this round: past the limit it is the match, not match point.
    if ((sc.ct === winRounds - 1 || sc.t === winRounds - 1) && Math.max(sc.ct | 0, sc.t | 0) < winRounds) {
      sub += (sub ? '  ·  ' : '') + 'MATCH POINT';
    }
    this._showMsg(main, sub, 3.6);
  }

  // --------------------------------------------------------------------------
  // Combat feedback handlers
  // --------------------------------------------------------------------------

  _onKill(d) {
    const event = { ...d };
    if (event.killerId) {
      event.killerName = humanCallsign(this.game, event.killerName, event.killerId);
    }
    if (event.victimId) {
      event.victimName = humanCallsign(this.game, event.victimName, event.victimId);
    }
    const killer = event.killerName || '?';
    const victim = event.victimName || '?';
    this._stat(killer).k += 1;
    this._stat(victim).d += 1;
    if (event.killerId && this._networkStatsById.has(String(event.killerId))) {
      this._networkStatsById.get(String(event.killerId)).k += 1;
    }
    if (event.victimId && this._networkStatsById.has(String(event.victimId))) {
      this._networkStatsById.get(String(event.victimId)).d += 1;
    }
    this._sbDirty = true;
    this._addFeed(event);
    const mp = this.game.multiplayer;
    if (event.killerName === 'You' || (mp && mp.active &&
      (event.killerId === mp.localId || event.killerName === mp.localName))) {
      this._showKillCue(event);
    }
  }

  _showKillCue(d) {
    const el = this._el.killcue;
    if (!el) return;
    const hs = !!d.headshot;
    el.classList.toggle('hs', hs);
    if (this._el.killcueMain) this._el.killcueMain.textContent = hs ? 'HEADSHOT KILL' : 'ENEMY DOWN';
    if (this._el.killcueName) {
      this._el.killcueName.textContent = '✕  ' + (d.victimName || '');
    }
    // Retrigger the pop animation from the start.
    el.classList.remove('show');
    void el.offsetWidth; // force reflow so the animation replays
    el.classList.add('show');
  }

  _showProgressToast(kind, data) {
    const stack = this._el.progressToasts;
    if (!stack) return;
    const source = kind === 'achievement' ? data.achievement : kind === 'record' ? data.record : data.rewards;
    const tierAfter = data.rewards?.tierAfter;
    const title = kind === 'level'
      ? ((tierAfter?.name ? String(tierAfter.name).toUpperCase() + ' · ' : '') + 'LEVEL ' + (data.rewards?.levelAfter || this._lastProgression?.level || 'UP'))
      : String(source?.title || source?.name || source?.label || (kind === 'record' ? 'PERSONAL RECORD' : 'ACHIEVEMENT UNLOCKED')).toUpperCase();
    const eyebrow = data.provisional
      ? 'MATCH MILESTONE'
      : kind === 'record' ? 'NEW PERSONAL RECORD' : kind === 'level' ? 'CAREER ADVANCEMENT' : 'ACHIEVEMENT UNLOCKED';
    const description = String(source?.description ||
      (kind === 'record' && Number.isFinite(Number(source?.value))
        ? (source.value + (source.previous != null ? ' · PREVIOUS ' + source.previous : ''))
        : data.provisional ? 'Finish the match to lock it in.' : 'Added to your permanent career.'));
    const toast = document.createElement('div');
    toast.className = 'progress-toast ' + esc(kind) + (data.provisional ? ' provisional' : ' confirmed');
    const mark = document.createElement('span');
    mark.className = 'progress-toast-mark';
    mark.textContent = kind === 'record' ? '◆' : kind === 'level' ? '▲' : '✦';
    const copy = document.createElement('span');
    copy.className = 'progress-toast-copy';
    const small = document.createElement('small');
    small.textContent = eyebrow;
    const strong = document.createElement('strong');
    strong.textContent = title;
    const detail = document.createElement('em');
    detail.textContent = description;
    copy.append(small, strong, detail);
    toast.append(mark, copy);
    stack.appendChild(toast);
    this._progressToasts.push(toast);
    while (this._progressToasts.length > 2) {
      this._progressToasts.shift()?.remove();
    }
    const lifetime = data.provisional ? 2800 : 4300;
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 280);
      this._progressToasts = this._progressToasts.filter((item) => item !== toast);
    }, lifetime);
  }

  _onHitmarker(d) {
    const el = this._el.hitmarker;
    if (!el) return;
    const dur = d.kill ? 0.42 : 0.26;
    const scale = d.headshot ? 1.55 : (d.kill ? 1.25 : 1.0);
    el.classList.toggle('kill', !!d.kill);
    el.style.transform = 'rotate(45deg) scale(' + scale + ')';
    el.style.opacity = '1';
    this._hit = { t: dur, dur };
  }

  _onPlayerDamage(d) {
    const amount = Number.isFinite(d.amount) ? d.amount : 15;
    this._dmg = Math.min(0.8, this._dmg + 0.16 + amount / 90);
    if (typeof d.dirYaw === 'number') {
      // grab the most-expired wedge from the pool
      let slot = this._wedges[0];
      for (const w of this._wedges) if (w.ttl < slot.ttl) slot = w;
      slot.yaw = d.dirYaw;
      slot.ttl = 1.0;
    }
  }

  _onPlayerDeath(d) {
    const k = d && d.killer;
    this._deathKiller = k && k.name
      ? (k.networkId || k.isRemotePlayer
          ? humanCallsign(this.game, k.name, k.networkId || k.id)
          : k.name)
      : (typeof k === 'string' ? k : '');
    this._deathRecap = this._buildDeathRecap(d || {});
    // Hold a strong impact vignette for the opening beat of the collapse.
    this._dmg = Math.max(this._dmg, 0.8);
    this._sbDirty = true;
  }

  /** "AK-47 · 23 M · HEADSHOT · 64 HP LEFT" for the respawn-mode death screen. */
  _buildDeathRecap(d) {
    const parts = [];
    const weaponId = typeof d.weapon === 'string' ? d.weapon : d.weapon && d.weapon.id;
    if (weaponId) parts.push(String(this._names[weaponId] || weaponId).toUpperCase());
    const k = d.killer;
    const from = k && (k.pos || k.position);
    const me = this.game.player && this.game.player.position;
    if (from && me && k !== this.game.player) {
      parts.push(Math.round(Math.hypot(from.x - me.x, from.z - me.z)) + ' M');
    }
    if (d.headshot) parts.push('HEADSHOT');
    if (k && k !== this.game.player && Number.isFinite(k.health) && k.health > 0) {
      parts.push(Math.ceil(k.health) + ' HP LEFT');
    }
    return parts.join(' · ');
  }

  _onFlash(d) {
    const i = clamp(Number.isFinite(d.intensity) ? d.intensity : 1, 0, 1);
    const dur = Math.max(0.15, Number.isFinite(d.duration) ? d.duration : 2.5);
    // keep the stronger of overlapping flashes
    if (!this._flash || i * (dur) > this._flash.i * (this._flash.dur - this._flash.t)) {
      this._flash = { i, dur, t: 0 };
    }
  }

  _onBotFire(d) {
    const bot = d.bot;
    // Only enemy fire reveals a bot on the radar (works for either side).
    const me = this.game.player;
    if (!bot || !bot.pos || !me || !hostile(this.game, bot, me)) return;
    const list = this._enemyFire;
    list.push({ x: bot.pos.x, z: bot.pos.z, t: this._time });
    if (list.length > 16) list.shift();
  }

  _setReloading(on) {
    if (on === this._cache.reloading) return;
    this._cache.reloading = on;
    if (this._el.reload) this._el.reload.style.display = on ? 'block' : 'none';
  }

  // --------------------------------------------------------------------------
  // Status panels
  // --------------------------------------------------------------------------

  _updateStats(st) {
    const c = this._cache;
    const p = this.game.player;
    const observed = p && p.alive === false && this.game.spectator
      ? this.game.spectator.target
      : null;
    const statusActor = observed && observed.alive !== false ? observed : p;

    const hp = Math.max(0, Math.round((statusActor && Number.isFinite(statusActor.health))
      ? statusActor.health
      : 100));
    if (hp !== c.hp) {
      c.hp = hp;
      if (this._el.healthNum) this._el.healthNum.textContent = String(hp);
    }
    const low = hp > 0 && hp <= 25;
    if (low !== c.hpLow) {
      c.hpLow = low;
      if (this._el.healthBox) this._el.healthBox.classList.toggle('low', low);
    }

    const ar = Math.max(0, Math.round((statusActor && Number.isFinite(statusActor.armor))
      ? statusActor.armor
      : 0));
    if (ar !== c.armor) {
      c.armor = ar;
      if (this._el.armorNum) this._el.armorNum.textContent = String(ar);
    }
    const arVis = ar > 0;
    if (arVis !== c.armorVis) {
      c.armorVis = arVis;
      if (this._el.armorBox) this._el.armorBox.style.display = arVis ? 'flex' : 'none';
    }

    const money = Math.max(0, Math.round(Number.isFinite(st.money) ? st.money : 0));
    if (money !== c.money) {
      c.money = money;
      if (this._el.moneyNum) this._el.moneyNum.textContent = money.toLocaleString('en-US');
      if (this._el.moneyBox) {
        this._el.moneyBox.classList.remove('pulse');
        void this._el.moneyBox.offsetWidth; // restart animation (rare — on change only)
        this._el.moneyBox.classList.add('pulse');
      }
    }
  }

  _updateAmmo() {
    const c = this._cache;
    const p = this.game.player;
    const observed = p && p.alive === false && this.game.spectator
      ? this.game.spectator.target
      : null;
    const spectating = !!(observed && observed.alive !== false);
    const w = this.game.weapons;
    const def = !spectating && w && typeof w.current === 'function' ? w.current() : null;
    const ammo = !spectating && w && typeof w.currentAmmo === 'function' ? w.currentAmmo() : null;

    const observedWeaponId = spectating && observed.weaponId ? String(observed.weaponId) : '';
    const name = spectating
      ? (this._names[observedWeaponId] || observedWeaponId.toUpperCase())
      : ((def && def.name) ? def.name : '');
    if (name !== c.wname) {
      c.wname = name;
      if (this._el.weaponName) this._el.weaponName.textContent = name;
    }

    const mag = spectating
      ? (Number.isFinite(observed.mag) ? observed.mag : null)
      : ((ammo && Number.isFinite(ammo.mag)) ? ammo.mag : null);
    const res = spectating ? null : ((ammo && Number.isFinite(ammo.reserve)) ? ammo.reserve : null);
    const magDisplay = mag === null ? (spectating ? '' : '—') : String(mag);
    const resDisplay = res === null ? '' : '/ ' + res;
    if (magDisplay !== c.mag) {
      c.mag = magDisplay;
      if (this._el.ammoMag) this._el.ammoMag.textContent = magDisplay;
    }
    if (resDisplay !== c.reserve) {
      c.reserve = resDisplay;
      if (this._el.ammoRes) this._el.ammoRes.textContent = resDisplay;
    }
    // A grenade 'magazine' is the one in hand, so it would always read low.
    const magLow = !spectating && mag !== null && def && !def.grenade && Number.isFinite(def.magSize) &&
      mag <= Math.max(1, Math.ceil((w && typeof w.magSizeOf === 'function' ? w.magSizeOf(def) : def.magSize) * 0.25));
    if (magLow !== c.magLow) {
      c.magLow = magLow;
      if (this._el.ammoMag) this._el.ammoMag.classList.toggle('low', !!magLow);
    }
    if (spectating && c.reloading) this._setReloading(false);
  }

  _updateTop(st, phase) {
    const c = this._cache;
    const t = Math.max(0, Number.isFinite(st.timer) ? st.timer : 0);
    const sec = Math.floor(t);
    if (sec !== c.timerSec) {
      c.timerSec = sec;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (this._el.timerNum) this._el.timerNum.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }
    const red = t < 10 && (phase === 'live' || phase === 'planted');
    if (red !== c.timerRed) {
      c.timerRed = red;
      if (this._el.timerNum) this._el.timerNum.classList.toggle('red', red);
    }
    const bombIco = phase === 'planted' || !!(st.bomb && st.bomb.planted);
    if (bombIco !== c.bombIco) {
      c.bombIco = bombIco;
      if (this._el.bombIco) this._el.bombIco.style.display = bombIco ? 'inline-block' : 'none';
    }

    const sc = st.scores || {};
    const ct = sc.ct | 0;
    const tt = sc.t | 0;
    if (ct !== c.scoreCt) {
      c.scoreCt = ct;
      if (this._el.scoreCt) this._el.scoreCt.textContent = String(ct);
      if (this._el.sbScore) this._el.sbScore.textContent = this._sbScoreText(ct, tt);
    }
    if (tt !== c.scoreT) {
      c.scoreT = tt;
      if (this._el.scoreT) this._el.scoreT.textContent = String(tt);
      if (this._el.sbScore) this._el.sbScore.textContent = this._sbScoreText(ct, tt);
    }

    const round = st.round | 0;
    const respawnMode = isRespawnMode(st.mode);
    const roundKey = respawnMode ? st.mode : round;
    if (roundKey !== c.round) {
      c.round = roundKey;
      const winRounds = (this.game.config && this.game.config.MATCH &&
        this.game.config.MATCH.WIN_ROUNDS) || 8;
      if (this._el.round) {
        this._el.round.textContent = respawnMode
          ? GAME_MODES[st.mode].label + '  ·  FIRST TO ' + modeRules(st.mode).scoreLimit
          : 'ROUND ' + round + '  ·  FIRST TO ' + winRounds;
      }
    }
    const showMoney = !respawnMode;
    this._updateObjectiveChips(st);
    const ffa = st.mode === 'ffa';
    if (ffa !== c.ffaLabels) {
      c.ffaLabels = ffa;
      if (this._el.scoreCtLabel) this._el.scoreCtLabel.textContent = ffa ? 'YOU' : FACTIONS.ct.short;
      if (this._el.scoreTLabel) this._el.scoreTLabel.textContent = ffa ? 'LEAD' : FACTIONS.t.short;
      for (const id of ['hud-flag-ct', 'hud-flag-t']) {
        const flag = document.getElementById(id);
        if (flag) flag.hidden = ffa;
      }
    }
    if (showMoney !== c.showMoney) {
      c.showMoney = showMoney;
      if (this._el.moneyBox) this._el.moneyBox.style.display = showMoney ? '' : 'none';
    }
  }

  // --------------------------------------------------------------------------
  // Crosshair + hitmarker
  // --------------------------------------------------------------------------

  /** Domination flag chips under the score: owner colour and capture bar. */
  _updateObjectiveChips(st) {
    const root = this._el.objective;
    if (!root) return;
    const objective = isRespawnMode(st.mode) ? this.game.rounds?.tdm?.objective : null;
    // hud() builds a fresh array of rows: capture progress reads fine at 10 Hz.
    const now = performance.now();
    if (objective && this._cache.objectiveKey !== undefined && now - (this._cache.objectiveAt || 0) < 100) return;
    this._cache.objectiveAt = now;
    const flags = objective && typeof objective.hud === 'function' ? objective.hud() : null;
    const key = flags
      ? flags.map((f) => f.name + (f.owner || '-') + (f.contested ? '!' : '') + Math.round(f.control * 20)).join('|')
      : '';
    if (key === this._cache.objectiveKey) return;
    this._cache.objectiveKey = key;
    root.hidden = !flags;
    if (!flags) { root.innerHTML = ''; return; }
    root.innerHTML = flags.map((f) => {
      // Hardpoint's bar is the time left on the zone, in the holder's colour.
      // Colours are relative: blue is your side, red the enemy's.
      const mine = this.game.player?.team || 'ct';
      const side = (team) => (!team ? '' : team === mine ? 'ours' : 'theirs');
      const color = { ours: '#5f9fe0', theirs: '#e0603c', '': '#d8dccd' };
      const toward = f.name === 'HP'
        ? color[side(f.owner)]
        : color[side(f.control >= 0 ? 'ct' : 't')];
      return '<span class="obj-flag ' + side(f.owner) + (f.contested ? ' contested' : '') + '" ' +
        'style="--cap:' + Math.round(Math.abs(f.control) * 100) + '%;--capc:' + toward + '">' + esc(f.name) + '<i></i></span>';
    }).join('');
  }

  /**
   * Crosshair turns red over a visible enemy (team or FFA rules), the classic
   * identification cue since both factions wear earth tones.
   */
  _updateTarget() {
    // 20 times a second is plenty for a colour change, and the wall check is
    // a full world raycast.
    if (this._time - (this._targetAt ?? -1) < 0.05) return;
    this._targetAt = this._time;
    const g = this.game;
    const p = g.player;
    const combat = g.combat;
    const cam = g.camera;
    let enemy = false;
    if (p && p.alive !== false && combat && typeof combat._testCharacters === 'function' && cam) {
      this._tOrigin = this._tOrigin || new THREE.Vector3();
      this._tDir = this._tDir || new THREE.Vector3();
      cam.getWorldPosition(this._tOrigin);
      cam.getWorldDirection(this._tDir);
      const t = combat._testCharacters(this._tOrigin, this._tDir, 90, p);
      const target = t >= 0 ? combat._hitChar : null;
      if (target && target !== p && hostile(g, target, p)) {
        const wall = g.world && typeof g.world.raycast === 'function' ? g.world.raycast(this._tOrigin, this._tDir, t) : null;
        enemy = !wall;
      }
    }
    if (enemy !== this._cache.crossEnemy) {
      this._cache.crossEnemy = enemy;
      if (this._el.crosshair) this._el.crosshair.classList.toggle('enemy', enemy);
    }
  }

  /** Blue name tags over visible teammates (none in free-for-all). */
  _updateTags() {
    const root = this._el.tags;
    if (!root) return;
    const g = this.game;
    const p = g.player;
    const cam = g.camera;
    const st = g.state || {};
    const live = MATCH_PHASES[st.phase] === 1 && p && p.alive !== false && cam && !isFfa(g);
    // Reused every frame: no per-frame arrays.
    const mates = this._tagMates || (this._tagMates = []);
    mates.length = 0;
    if (live) {
      const consider = (a) => {
        const pos = a && (a.pos || a.position);
        if (!a || a.alive === false || !pos || a.team !== p.team) return;
        if (pos.distanceToSquared(p.position) > 3600) return;
        mates.push(a);
      };
      for (const a of (g.bots && g.bots.all) || []) consider(a);
      if (g.multiplayer && g.multiplayer.active) for (const a of g.multiplayer.remotePlayers || []) consider(a);
    }
    while (root.children.length < mates.length) {
      const tag = document.createElement('span');
      tag.className = 'hud-tag';
      root.appendChild(tag);
    }
    this._tagV = this._tagV || new THREE.Vector3();
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Pass 1: project every tag and note its distance.
    const order = this._tagOrder || (this._tagOrder = []);
    order.length = 0;
    for (let i = 0; i < root.children.length; i++) {
      const tag = root.children[i];
      const a = mates[i];
      const pos = a && (a.pos || a.position);
      if (pos) this._tagV.set(pos.x, pos.y + (a.height || 1.83) + 0.35, pos.z).project(cam);
      if (!pos || this._tagV.z > 1 || Math.abs(this._tagV.x) > 1.05 || Math.abs(this._tagV.y) > 1.05) {
        if (tag._shown !== false) { tag._shown = false; tag.style.display = 'none'; }
        continue;
      }
      const name = a.isRemotePlayer ? humanCallsign(g, a.name, a.networkId) : String(a.name || '');
      if (tag.textContent !== name) tag.textContent = name;
      if (tag._shown !== true) { tag._shown = true; tag.style.display = 'block'; }
      tag._px = Math.round((this._tagV.x + 1) * 0.5 * w);
      tag._py = Math.round((1 - this._tagV.y) * 0.5 * h);
      tag._d = pos.distanceToSquared(p.position);
      tag._w = name.length * 7.5 + 12; // ~10px heavy caps with tracking
      order.push(tag);
    }
    // Pass 2: nearest first keeps its spot; a farther tag that would sit on
    // top of one already placed steps up a row (tags stacked into one
    // unreadable smear when teammates bunched up in a doorway).
    order.sort((m, n) => m._d - n._d);
    const ROW = 17;
    for (let i = 0; i < order.length; i++) {
      const tag = order[i];
      const x = tag._px;
      let y = tag._py;
      for (let pass = 0; pass < 4; pass++) {
        let hit = false;
        for (let j = 0; j < i; j++) {
          const o = order[j];
          if (Math.abs(o._x - x) < (o._w + tag._w) / 2 && Math.abs(o._y - y) < ROW) { hit = true; break; }
        }
        if (!hit) break;
        y -= ROW;
      }
      // Style writes only when the tag actually moved a pixel.
      if (tag._x !== x || tag._y !== y) {
        tag._x = x;
        tag._y = y;
        tag.style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-100%)';
      }
    }
  }

  /** Streak rail above the ammo box: progress toward each streak, ready glow. */
  _updateStreaks() {
    const root = this._el.streaks;
    const streaks = this.game.streaks;
    if (!root) return;
    const on = !!(streaks && typeof streaks.enabled === 'function' && streaks.enabled() &&
      this.game.player && this.game.player.alive !== false);
    if (on !== this._cache.streaksOn) {
      this._cache.streaksOn = on;
      root.hidden = !on;
    }
    if (!on) return;
    // status() sorts and builds rows, and the key is a fresh string: check at
    // 10 Hz, not every frame (progress moves on kills; timers tick per second).
    const now = performance.now();
    if (this._cache.streaksKey !== undefined && now - (this._cache.streaksAt || 0) < 100) return;
    this._cache.streaksAt = now;
    const rows = streaks.status();
    const uav = streaks.uavActive() ? Math.ceil(streaks.uavTime) : 0;
    const cuav = streaks.counterUavActive() ? Math.ceil(streaks.counterTime) : 0;
    const key = rows.map((r) => `${r.id}:${r.slot}:${r.ready ? 'R' : Math.floor(r.progress * 40)}`).join('|') + ':' + uav + ':' + cuav;
    if (key === this._cache.streaksKey) return;
    this._cache.streaksKey = key;
    root.innerHTML = rows.map((r) => {
      const binding = this._bindingLabel('streak' + (r.slot + 1));
      const timer = r.id === 'uav' ? uav : r.id === 'counteruav' ? cuav : 0;
      const live = timer ? ' · ' + timer + 'S' : '';
      return '<div class="sk-row' + (r.ready ? ' ready' : '') + (r.bonus ? ' bonus' : '') + '">' +
        '<kbd>' + esc(binding) + '</kbd><span>' + esc(r.label) + live + '</span>' +
        '<i style="--sk:' + (r.progress * 100).toFixed(1) + '%"></i></div>';
    }).join('');
  }

  /** "+100 KILL" style popups under the crosshair; newest on top, max four. */
  /**
   * Score popups. Awards from one kill share a group and land on one line:
   * the running total and the base label, with the bonuses (HEADSHOT, DOUBLE
   * KILL, PAYBACK...) as a strip beneath it.
   */
  _onScoreAward(d) {
    const root = this._el.scorePop;
    if (!root || !(d.points > 0)) return;
    const label = String(d.label || '');
    const group = d.group != null ? String(d.group) : null;
    if (!this._scoreRows) this._scoreRows = new Map();
    let row = group ? this._scoreRows.get(group) : null;
    if (row && !row.isConnected) row = null;
    if (row) {
      row._points += d.points | 0;
      row.querySelector('b').textContent = '+' + row._points;
      let tags = row.querySelector('.sp-tags');
      if (!tags) {
        tags = document.createElement('small');
        tags.className = 'sp-tags';
        row.appendChild(tags);
      }
      const tag = document.createElement('i');
      tag.textContent = label;
      tags.appendChild(tag);
      row.classList.add('sp-rich');
    } else {
      row = document.createElement('div');
      row.className = 'sp-row' + (label === 'KILL' ? '' : ' sp-bonus');
      row._points = d.points | 0;
      row.innerHTML = '<b>+' + row._points + '</b><span>' + esc(label) + '</span>';
      root.prepend(row);
      while (root.children.length > 3) root.lastElementChild.remove();
      if (group) this._scoreRows.set(group, row);
    }
    // A bonus landing on a line restarts its clock (and its pop).
    clearTimeout(row._timer);
    row.style.animation = 'none';
    void row.offsetWidth;
    row.style.animation = '';
    row._timer = setTimeout(() => {
      row.remove();
      if (group && this._scoreRows.get(group) === row) this._scoreRows.delete(group);
    }, 1600);
  }

  _updateCrosshair(phase) {
    const c = this._cache;
    const w = this.game.weapons;
    const p = this.game.player;
    const scoped = !!(w && typeof w.isScoped === 'function' && w.isScoped());

    const vis = !scoped && !this._buyOpen &&
      (p ? p.alive !== false : true) &&
      phase !== 'menu' && phase !== 'gameEnd';
    if (vis !== c.crossVis) {
      c.crossVis = vis;
      if (this._el.crosshair) this._el.crosshair.style.display = vis ? 'block' : 'none';
    }
    if (!vis) return;

    // Aimed down sights the gun's own sight is the reticle: fade the lines,
    // keep the centre dot. Sprinting hides the crosshair (no hip fire).
    const ads = !!(w && typeof w.adsFraction === 'function' && w.adsFraction() > 0.55);
    const sprint = !!(p && p.sprinting);
    const mode = ads ? 'ads' : sprint ? 'sprint' : '';
    if (mode !== c.crossMode) {
      c.crossMode = mode;
      if (this._el.crosshair) {
        this._el.crosshair.classList.toggle('ads', ads);
        this._el.crosshair.classList.toggle('sprint', sprint && !ads);
      }
    }

    const spread = (w && typeof w.currentSpread === 'function') ? w.currentSpread() : 0.012;
    // The arms sit at the real edge of the cone (each axis is clamped to
    // ±spread): pixels per radian at the live FOV and screen height. A fixed
    // 900 px/rad drew it 1.25-2x too wide, more so at a wide FOV.
    const cam = this.game.camera;
    const halfFov = ((cam && cam.fov) || 74) * Math.PI / 360;
    const screenH = (typeof innerHeight === 'number' && innerHeight > 0) ? innerHeight : 768;
    const pxPerRad = (screenH / 2) / Math.tan(halfFov);
    let gap = 2.5 + clamp(spread, 0, 0.085) * pxPerRad;
    gap = Math.round(gap * 2) / 2;
    if (gap !== c.gap) {
      c.gap = gap;
      const len = 8;
      if (this._el.chL) this._el.chL.style.transform = 'translate(' + (-gap - len) + 'px,0)';
      if (this._el.chR) this._el.chR.style.transform = 'translate(' + gap + 'px,0)';
      if (this._el.chT) this._el.chT.style.transform = 'translate(0,' + (-gap - len) + 'px)';
      if (this._el.chB) this._el.chB.style.transform = 'translate(0,' + gap + 'px)';
    }
  }

  // --------------------------------------------------------------------------
  // Scope overlay
  // --------------------------------------------------------------------------

  _updateScope() {
    const w = this.game.weapons;
    const scoped = !!(w && typeof w.isScoped === 'function' && w.isScoped());
    if (scoped !== this._scopeShown) {
      this._scopeShown = scoped;
      if (this._el.scope) this._el.scope.style.display = scoped ? 'block' : 'none';
    }
    if (!scoped) { this._scopeLevel = -1; return; }
    const level = (w && Number.isFinite(w.scopeLevel)) ? w.scopeLevel : 1;
    if (level !== this._scopeLevel) {
      this._scopeLevel = level;
      let text = 'ZOOM ' + level;
      const baseFov = (this.game.config && this.game.config.PLAYER && this.game.config.PLAYER.FOV) || 74;
      const fov = this._scopeFov;
      if (fov > 0 && fov < baseFov) {
        const mag = Math.tan(baseFov * Math.PI / 360) / Math.tan(fov * Math.PI / 360);
        text = mag.toFixed(1) + '×';
      }
      if (this._el.scopeZoom) this._el.scopeZoom.textContent = text;
    }
  }

  // --------------------------------------------------------------------------
  // Killfeed
  // --------------------------------------------------------------------------

  _addFeed(d) {
    if (!this._el.feed) return;
    const row = document.createElement('div');
    row.className = 'kf-entry';
    // Online your name is a callsign; the ids say whether a row is yours.
    const mp = this.game.multiplayer;
    const localId = mp && mp.active ? mp.localId : null;
    if (d.victimName === 'You' || (localId && d.victimId === localId)) row.classList.add('kf-death');
    else if (d.killerName === 'You' || (localId && d.killerId === localId)) row.classList.add('kf-mine');

    const wname = this._names[d.weaponId] || d.weaponId || '?';
    // FFA has no sides: names stay neutral instead of implying teams.
    const ffa = isFfa(this.game);
    const kTeam = ffa ? 'ffa' : d.killerTeam === 't' ? 't' : 'ct';
    const vTeam = ffa ? 'ffa' : d.victimTeam === 't' ? 't' : 'ct';
    row.innerHTML =
      '<span class="kf-name kf-' + kTeam + '">' + esc(d.killerName || '?') + '</span>' +
      '<span class="kf-weap">' + esc(wname) + '</span>' +
      (d.headshot ? '<span class="kf-hs">HS</span>' : '') +
      '<span class="kf-name kf-' + vTeam + '">' + esc(d.victimName || '?') + '</span>';

    this._el.feed.appendChild(row);
    this._feed.push({ el: row, t: this._time, fading: false });
    while (this._feed.length > 5) {
      const old = this._feed.shift();
      if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }

  /** A line of bot radio chatter, shown for the local player's side only. */
  _addRadio(d) {
    const box = this._el.radio;
    if (!box || !d.text || isFfa(this.game)) return;
    const mine = (this.game.player && this.game.player.team) || 'ct';
    if (d.team !== mine) return;
    const row = document.createElement('div');
    row.className = 'rd-entry';
    row.innerHTML = '<span class="rd-name kf-' + (d.team === 't' ? 't' : 'ct') + '">' + esc(d.name || '?') +
      '</span><span class="rd-text">' + esc(d.text) + '</span>';
    box.appendChild(row);
    this._radio.push({ el: row, t: this._time, fading: false });
    while (this._radio.length > 3) {
      const old = this._radio.shift();
      if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }

  _updateFeed() {
    for (let i = this._radio.length - 1; i >= 0; i--) {
      const e = this._radio[i];
      const age = this._time - e.t;
      if (age > 4.2) {
        if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
        this._radio.splice(i, 1);
      } else if (age > 3.6 && !e.fading) {
        e.fading = true;
        e.el.classList.add('kf-fade');
      }
    }
    const feed = this._feed;
    for (let i = feed.length - 1; i >= 0; i--) {
      const e = feed[i];
      const age = this._time - e.t;
      if (age > 5.2) {
        if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
        feed.splice(i, 1);
      } else if (age > 4.5 && !e.fading) {
        e.fading = true;
        e.el.classList.add('kf-fade');
      }
    }
  }

  _clearFeed() {
    for (const e of this._feed) if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
    this._feed.length = 0;
    for (const e of this._radio) if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
    this._radio.length = 0;
  }

  // --------------------------------------------------------------------------
  // Radar
  // --------------------------------------------------------------------------

  _radarBounds() {
    if (this._rb) return this._rb;
    const w = this.game.world;
    if (w && Array.isArray(w.colliders) && w.colliders.length) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const b of w.colliders) {
        if (!b || !b.min || !b.max) continue;
        if (b.max.x - b.min.x > 300 || b.max.z - b.min.z > 300) continue; // skip mega-boxes
        if (b.min.x < minX) minX = b.min.x;
        if (b.max.x > maxX) maxX = b.max.x;
        if (b.min.z < minZ) minZ = b.min.z;
        if (b.max.z > maxZ) maxZ = b.max.z;
      }
      if (minX < maxX && minZ < maxZ) {
        this._rb = {
          minX: clamp(minX, -140, 140), maxX: clamp(maxX, -140, 140),
          minZ: clamp(minZ, -140, 140), maxZ: clamp(maxZ, -140, 140),
        };
        return this._rb;
      }
    }
    return FALLBACK_RB; // not cached — retry once real colliders exist
  }

  _clampBlip(x, y) {
    const r = Math.hypot(x, y);
    if (r > RADAR_EDGE) {
      const k = RADAR_EDGE / r;
      RT.x = x * k; RT.y = y * k; RT.cl = true;
    } else {
      RT.x = x; RT.y = y; RT.cl = false;
    }
    return RT;
  }

  _drawRadar(st) {
    const c = this._radarCtx;
    if (!c) return;
    const g = this.game;
    const dpr = this._radarDpr;
    const S = RADAR_SIZE, half = S / 2;

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);

    // background + grid
    c.fillStyle = 'rgba(7,10,4,0.62)';
    c.fillRect(0, 0, S, S);
    c.strokeStyle = 'rgba(154,178,107,0.08)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 20; i < S; i += 20) {
      c.moveTo(i, 0); c.lineTo(i, S);
      c.moveTo(0, i); c.lineTo(S, i);
    }
    c.stroke();

    const p = g.player;
    const px = (p && p.position) ? p.position.x : 0;
    const pz = (p && p.position) ? p.position.z : 0;
    const yaw = (p && Number.isFinite(p.yaw)) ? p.yaw : 0;

    c.save();
    c.translate(half, half);
    c.rotate(yaw); // rotate the world so the player's facing is up

    // world bounds
    const b = this._radarBounds();
    c.strokeStyle = 'rgba(154,178,107,0.35)';
    c.lineWidth = 1.2;
    c.strokeRect((b.minX - px) * RADAR_SCALE, (b.minZ - pz) * RADAR_SCALE,
      (b.maxX - b.minX) * RADAR_SCALE, (b.maxZ - b.minZ) * RADAR_SCALE);

    // active smoke clouds (combat exposes .smokes)
    const smokes = g.combat && g.combat.smokes;
    if (Array.isArray(smokes)) {
      c.fillStyle = 'rgba(170,170,170,0.22)';
      for (const s of smokes) {
        if (!s || !s.pos) continue;
        c.beginPath();
        c.arc((s.pos.x - px) * RADAR_SCALE, (s.pos.z - pz) * RADAR_SCALE,
          Math.max(2, (s.radius || 3) * RADAR_SCALE), 0, Math.PI * 2);
        c.fill();
      }
    }

    // bomb sites (label + zone outline)
    const world = g.world;
    if (world && Array.isArray(world.bombSites) && !isRespawnMode(st.mode)) {
      for (const site of world.bombSites) {
        if (!site || !site.center) continue;
        const sx = (site.center.x - px) * RADAR_SCALE;
        const sy = (site.center.z - pz) * RADAR_SCALE;
        if (site.box && site.box.min && site.box.max) {
          c.strokeStyle = 'rgba(200,214,185,0.22)';
          c.lineWidth = 1;
          c.strokeRect((site.box.min.x - px) * RADAR_SCALE, (site.box.min.z - pz) * RADAR_SCALE,
            (site.box.max.x - site.box.min.x) * RADAR_SCALE,
            (site.box.max.z - site.box.min.z) * RADAR_SCALE);
        }
        const bl = this._clampBlip(sx, sy);
        c.save();
        c.translate(bl.x, bl.y);
        c.rotate(-yaw);
        c.font = '700 11px "Arial Narrow", Arial, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = bl.cl ? 'rgba(200,214,185,0.35)' : 'rgba(200,214,185,0.85)';
        c.fillText(site.name || '?', 0, 0);
        c.restore();
      }
    }

    // planted bomb
    const bomb = st.bomb;
    if (bomb && bomb.planted && bomb.pos) {
      const bl = this._clampBlip((bomb.pos.x - px) * RADAR_SCALE, (bomb.pos.z - pz) * RADAR_SCALE);
      const pulse = 0.55 + 0.45 * Math.sin(this._time * 7);
      c.fillStyle = 'rgba(232,64,42,' + (bl.cl ? pulse * 0.5 : pulse).toFixed(3) + ')';
      c.fillRect(bl.x - 3, bl.y - 3, 6, 6);
    }

    // objective markers: Domination flags (owner colour, letter) and KC tags
    const objective = isRespawnMode(st.mode) ? g.rounds?.tdm?.objective : null;
    const objectiveMarkers = objective && typeof objective.radarMarkers === 'function' ? objective.radarMarkers() : [];
    const streakMarkers = g.streaks && typeof g.streaks.radarMarkers === 'function' ? g.streaks.radarMarkers() : [];
    const markers = objectiveMarkers.concat(streakMarkers);
    if (markers.length) {
      for (const m of markers) {
        const bl = this._clampBlip((m.x - px) * RADAR_SCALE, (m.z - pz) * RADAR_SCALE);
        if (m.kind === 'flag') {
          // Relative to you, like every other radar blip.
          const mine = (p && p.team) || 'ct';
          const color = !m.owner ? '216,220,205' : m.owner === mine ? '95,159,224' : '224,96,60';
          c.save();
          c.translate(bl.x, bl.y);
          c.rotate(-yaw);
          c.fillStyle = 'rgba(' + color + ',' + (m.contested ? (0.5 + 0.5 * Math.sin(this._time * 10)).toFixed(2) : '0.9') + ')';
          c.fillRect(-6, -6, 12, 12);
          c.font = '900 9px "Arial Narrow", Arial, sans-serif';
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillStyle = '#0b0f08';
          c.fillText(m.name || '', 0, 0.5);
          c.restore();
        } else if (m.kind === 'package') {
          c.fillStyle = m.landed ? 'rgba(247,210,122,0.95)' : 'rgba(247,210,122,' + (0.4 + 0.4 * Math.sin(this._time * 8)).toFixed(2) + ')';
          c.fillRect(bl.x - 3.5, bl.y - 3.5, 7, 7);
          c.strokeStyle = '#0b0f08';
          c.lineWidth = 1;
          c.strokeRect(bl.x - 3.5, bl.y - 3.5, 7, 7);
        } else if (m.kind === 'tag') {
          c.fillStyle = m.team === ((p && p.team) || 'ct') ? 'rgba(95,159,224,0.9)' : 'rgba(247,210,122,0.95)';
          c.beginPath();
          c.moveTo(bl.x, bl.y - 3.5);
          c.lineTo(bl.x + 3, bl.y);
          c.lineTo(bl.x, bl.y + 3.5);
          c.lineTo(bl.x - 3, bl.y);
          c.closePath();
          c.fill();
        }
      }
    }

    // prune stale enemy-fire memory
    const fires = this._enemyFire;
    while (fires.length && this._time - fires[0].t > ENEMY_FIRE_MEMORY) fires.shift();

    // blips (a friendly UAV reveals every enemy)
    const uavUp = !!(g.streaks && typeof g.streaks.uavActive === 'function' && g.streaks.uavActive());
    const bots = g.bots;
    const blips = (bots && typeof bots.getRadarBlips === 'function') ? bots.getRadarBlips() : null;
    if (Array.isArray(blips)) {
      for (const bp of blips) {
        if (!bp || bp.alive === false) continue;
        const dx = bp.x - px;
        const dz = bp.z - pz;
        // FFA bots keep a uniform team but everyone is an enemy.
        const friendly = !hostileTeams(g, bp.team, (p && p.team) || 'ct');
        if (!friendly) {
          // enemies: only when spotted — within 25 m OR fired within last 2 s
          const near = (dx * dx + dz * dz) <= ENEMY_SPOT_DIST * ENEMY_SPOT_DIST;
          let heard = false;
          if (!near) {
            for (let i = 0; i < fires.length; i++) {
              const f = fires[i];
              const fx = bp.x - f.x, fz = bp.z - f.z;
              if (fx * fx + fz * fz <= ENEMY_FIRE_MATCH * ENEMY_FIRE_MATCH) { heard = true; break; }
            }
          }
          if (!near && !heard && !uavUp) continue;
        }
        const bl = this._clampBlip(dx * RADAR_SCALE, dz * RADAR_SCALE);
        const alpha = bl.cl ? 0.45 : 1;
        c.beginPath();
        c.arc(bl.x, bl.y, bl.cl ? 2.4 : 3, 0, Math.PI * 2);
        c.fillStyle = friendly
          ? 'rgba(127,179,230,' + alpha + ')'
          : 'rgba(226,96,79,' + alpha + ')';
        c.fill();
        if (bp.isBombCarrier) {
          c.beginPath();
          c.arc(bl.x, bl.y, 5, 0, Math.PI * 2);
          c.strokeStyle = 'rgba(240,161,60,' + alpha + ')';
          c.lineWidth = 1.4;
          c.stroke();
        }
      }
    }

    // Remote human teammates/enemies use the same visibility rules as bots.
    const remotes = g.multiplayer && g.multiplayer.remotePlayers;
    if (Array.isArray(remotes)) {
      for (const rp of remotes) {
        if (!rp || !rp.alive || !rp.position) continue;
        const dx = rp.position.x - px;
        const dz = rp.position.z - pz;
        const friendly = !hostileTeams(g, rp.team, (p && p.team) || 'ct');
        // A UAV shows enemy humans too: it only ever showed the bots.
        if (!friendly && !uavUp && dx * dx + dz * dz > ENEMY_SPOT_DIST * ENEMY_SPOT_DIST) continue;
        const bl = this._clampBlip(dx * RADAR_SCALE, dz * RADAR_SCALE);
        c.beginPath();
        c.arc(bl.x, bl.y, bl.cl ? 2.5 : 3.2, 0, Math.PI * 2);
        c.fillStyle = friendly ? 'rgba(127,179,230,.95)' : 'rgba(226,96,79,.95)';
        c.fill();
        if (st.bomb && st.bomb.carrierId === rp.networkId) {
          c.beginPath(); c.arc(bl.x, bl.y, 5.2, 0, Math.PI * 2);
          c.strokeStyle = 'rgba(240,161,60,.95)'; c.lineWidth = 1.4; c.stroke();
        }
      }
    }

    // north marker (world -Z)
    c.save();
    c.translate(0, -(half - 9));
    c.rotate(-yaw);
    c.font = '700 8px Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(154,178,107,0.55)';
    c.fillText('N', 0, 0);
    c.restore();

    c.restore();

    // player: view cone + arrow (screen space — always facing up)
    c.save();
    c.translate(half, half);
    c.fillStyle = 'rgba(210,228,190,0.07)';
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(-17, -27); c.lineTo(17, -27);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(0, -5.5); c.lineTo(4.4, 4.4); c.lineTo(0, 2); c.lineTo(-4.4, 4.4);
    c.closePath();
    c.fillStyle = '#eef4e2';
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 0.8;
    c.stroke();
    c.restore();
  }

  // --------------------------------------------------------------------------
  // Overlays — vignette, wedges, flash, hitmarker
  // --------------------------------------------------------------------------

  _updateOverlays(dt) {
    // spawn protection: a quiet cue while fresh-spawn immunity lasts
    const protectEl = this._protectEl || (this._protectEl = document.getElementById('hud-protect'));
    const prot = Number(this.game.player?.spawnProtection) || 0;
    const protOp = prot > 0 && this.game.player?.alive !== false ? Math.min(1, prot * 2).toFixed(2) : '0';
    if (protectEl && protectEl.style.opacity !== protOp) protectEl.style.opacity = protOp;
    // stun vignette: fades over the stun with a slow pulse
    const stunEl = this._stunEl || (this._stunEl = document.getElementById('hud-stun'));
    // Frozen with the match while it is paused: a flashbang or stun used to
    // wear off on the pause screen, the bots frozen meanwhile.
    const live = this.game.paused ? 0 : dt;
    if (this._stun) {
      this._stun.t += live;
      const left = 1 - this._stun.t / this._stun.dur;
      if (left <= 0 || this.game.player?.alive === false) this._stun = null;
      if (stunEl) stunEl.style.opacity = this._stun ? (Math.min(1, left * 1.6) * (0.75 + 0.25 * Math.sin(this._time * 9))).toFixed(3) : '0';
    }

    // damage vignette (+ persistent low-HP pulse)
    this._dmg = Math.max(0, this._dmg - dt * (1.1 + this._dmg));
    let base = 0;
    const p = this.game.player;
    if (p && p.alive !== false && Number.isFinite(p.health) && p.health > 0 && p.health <= 25 &&
      this._cache.phase !== 'menu') {
      base = 0.13 + 0.05 * Math.sin(this._time * 3.4);
    }
    const op = Math.min(0.85, base + this._dmg);
    if (Math.abs(op - this._dmgOpacity) > 0.008) {
      this._dmgOpacity = op;
      if (this._el.vignette) this._el.vignette.style.opacity = op.toFixed(3);
    }

    // Briefly drain the scene into a dark red wash while the first-person
    // collapse plays. It clears before spectator ownership changes, making
    // the camera cut feel deliberate instead of instantaneous.
    let deathOp = 0;
    const phase = this._cache.phase;
    if (p && p.alive === false && p.spectatorReady === false && MATCH_PHASES[phase] === 1) {
      const duration = Math.max(0.001, Number(p.deathTransitionDuration) || 1.55);
      const progress = clamp((Number(p.deathElapsed) || 0) / duration, 0, 1);
      deathOp = 0.7 * Math.pow(1 - progress, 0.58);
    }
    if (Math.abs(deathOp - this._deathFxOpacity) > 0.008 ||
      (deathOp === 0 && this._deathFxOpacity !== 0)) {
      this._deathFxOpacity = deathOp;
      if (this._el.deathFx) this._el.deathFx.style.opacity = deathOp.toFixed(3);
    }

    // directional damage wedges
    const pyaw = (p && Number.isFinite(p.yaw)) ? p.yaw : 0;
    for (const w of this._wedges) {
      if (w.ttl > 0) {
        w.ttl -= dt;
        if (w.ttl <= 0) {
          w.ttl = 0;
          if (w.visible) { w.visible = false; w.el.style.opacity = '0'; }
        } else {
          const rot = pyaw - w.yaw; // attacker bearing → screen rotation
          w.el.style.transform = 'rotate(' + rot.toFixed(3) + 'rad) translateY(-128px)';
          w.el.style.opacity = Math.min(1, w.ttl * 1.7).toFixed(3);
          w.visible = true;
        }
      }
    }

    // flash whiteout
    if (this._flash) {
      const f = this._flash;
      f.t += live;
      const rem = f.dur - f.t;
      let op2 = 0;
      if (rem > 0) {
        const fadeSpan = f.dur * 0.45;
        op2 = rem >= fadeSpan ? f.i : f.i * Math.pow(rem / fadeSpan, 1.35);
      } else {
        this._flash = null;
      }
      if (Math.abs(op2 - this._flashOpacity) > 0.006) {
        this._flashOpacity = op2;
        if (this._el.flash) this._el.flash.style.opacity = op2.toFixed(3);
      }
    } else if (this._flashOpacity !== 0) {
      this._flashOpacity = 0;
      if (this._el.flash) this._el.flash.style.opacity = '0';
    }

    // hitmarker fade
    if (this._hit) {
      this._hit.t -= dt;
      if (this._hit.t <= 0) {
        this._hit = null;
        if (this._el.hitmarker) this._el.hitmarker.style.opacity = '0';
      } else if (this._el.hitmarker) {
        this._el.hitmarker.style.opacity = (this._hit.t / this._hit.dur).toFixed(3);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Defuse bar + use hint
  // --------------------------------------------------------------------------

  _updateDefuse(st, phase) {
    const c = this._cache;
    const bomb = st.bomb || {};
    const prog = Number.isFinite(bomb.defuseProgress) ? bomb.defuseProgress : 0;
    const plantProg = Number.isFinite(bomb.plantProgress) ? bomb.plantProgress : 0;
    const p = this.game.player;
    const cfg = (this.game.config && this.game.config.MATCH) || {};

    // Online the bomb state reaches every client: the bar is only for the
    // soldier doing it. The host stores its own defuse as 'player' and a
    // remote one by name; the carrier is the planter.
    const mp = this.game.multiplayer;
    const online = !!mp?.active;
    const myPlant = !online || (!!p?.networkId && bomb.carrierId === p.networkId);
    const myDefuse = !online || (mp.isHost ? bomb.defusingBy === 'player' : bomb.defusingBy === mp.localName);
    const planting = plantProg > 0 && phase === 'live' && myPlant;
    const show = (prog > 0 && phase === 'planted' && myDefuse) || planting;
    if (show !== c.defuseVis) {
      c.defuseVis = show;
      if (this._el.defuse) this._el.defuse.style.display = show ? 'block' : 'none';
      if (this._el.moneyBox && this.game.input?.touchMode) {
        this._el.moneyBox.style.visibility = show ? 'hidden' : '';
      }
      c.defuse = -1;
      c.barPlanting = undefined;
    }
    if (show) {
      const hasKit = !!(p && p.hasKit);
      const need = planting
        ? (bomb.plantTime || cfg.PLANT_TIME || 3.2)
        : (bomb.defuseTime || (hasKit ? (cfg.DEFUSE_TIME_KIT || 5) : (cfg.DEFUSE_TIME || 10)));
      const frac = clamp((planting ? plantProg : prog) / need, 0, 1);
      // Written on change only: a textContent write replaces the text node
      // (and restyles) even when the string is the same.
      if (planting !== c.barPlanting) {
        c.barPlanting = planting;
        if (this._el.defuseLabel) this._el.defuseLabel.textContent = planting ? 'PLANTING…' : 'DEFUSING…';
        if (planting && this._el.defuseNote) {
          c.kitNote = null;
          this._el.defuseNote.textContent = 'ARMING THE BOMB — HOLD STEADY';
          this._el.defuseNote.classList.remove('kit');
        }
      }
      if (Math.abs(frac - c.defuse) > 0.004) {
        c.defuse = frac;
        if (this._el.defuseFill) this._el.defuseFill.style.transform = 'scaleX(' + frac.toFixed(4) + ')';
      }
      if (!planting && hasKit !== c.kitNote) {
        c.kitNote = hasKit;
        if (this._el.defuseNote) {
          this._el.defuseNote.textContent = hasKit ? 'DEFUSE KIT ATTACHED' : 'NO KIT — HOLD STEADY';
          this._el.defuseNote.classList.toggle('kit', hasKit);
        }
      }
    }

    // proximity hint
    let hint = false;
    let hintAction = 'DEFUSE THE BOMB';
    if (!show && phase === 'planted' && p && p.team === 'ct' && p.alive !== false && bomb.pos && p.position) {
      const dx = p.position.x - bomb.pos.x;
      const dz = p.position.z - bomb.pos.z;
      hint = (dx * dx + dz * dz) < 2.4 * 2.4;
    } else if (!show && phase === 'live' && p && p.team === 't' && p.alive !== false &&
      p.networkId && bomb.carrierId === p.networkId && p.position) {
      const sites = this.game.world && this.game.world.bombSites;
      if (Array.isArray(sites)) {
        for (const site of sites) {
          if (site.box && site.center && site.box.containsPoint(
            { x: p.position.x, y: site.center.y, z: p.position.z }
          )) { hint = true; hintAction = 'PLANT THE BOMB'; break; }
        }
      }
    }
    if (hint !== c.hintVis) {
      c.hintVis = hint;
      if (this._el.useHint) this._el.useHint.style.display = hint ? 'block' : 'none';
    }
    if (hint && this._el.useHint) {
      const markup = 'HOLD <kbd>' + esc(this._bindingLabel('use')) + '</kbd> TO ' + hintAction;
      if (markup !== c.hintHtml) {
        c.hintHtml = markup;
        this._el.useHint.innerHTML = markup;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Killcam
  // --------------------------------------------------------------------------

  /** The replay's letterbox and strip; the rest of the HUD steps aside. */
  _updateKillcam() {
    const kc = this.game.killcam;
    const active = !!(kc && kc.active);
    if (active !== !!this._killcamShown) {
      this._killcamShown = active;
      this._root?.classList.toggle('killcam-on', active);
      this._killcamKey = '';
    }
    if (!active) return;
    const info = kc.info();
    const killer = info && info.killer;
    const key = killer ? String(killer.name || '') + ':' + info.weaponId + ':' + info.distance : '';
    if (key !== this._killcamKey) {
      this._killcamKey = key;
      const name = killer
        ? (killer.isRemotePlayer ? humanCallsign(this.game, killer.name, killer.networkId) : String(killer.name || 'ENEMY'))
        : 'ENEMY';
      if (this._el.killcamKiller) {
        this._el.killcamKiller.textContent = name.toUpperCase();
        this._el.killcamKiller.className = 'kc-killer ' + (isFfa(this.game) ? 'ffa' : killer && killer.team === 'ct' ? 'ct' : 't');
      }
      const bits = [];
      if (info.weaponId) bits.push(String(this._names[info.weaponId] || info.weaponId).toUpperCase());
      if (Number.isFinite(info.distance)) bits.push(info.distance + ' M');
      if (info.headshot) bits.push('HEADSHOT');
      if (this._el.killcamDetail) this._el.killcamDetail.textContent = bits.join(' · ');
      if (this._el.killcamSkip) {
        this._el.killcamSkip.textContent = this.game.input?.touchMode
          ? 'TAP NEXT TO SKIP'
          : this._bindingLabel('jump') + ' OR CLICK TO SKIP';
      }
    }
    // Progress in whole percent, so the style is written ~100 times a replay.
    const pct = Math.round(kc.progress() * 100);
    if (pct !== this._killcamPct && this._el.killcamFill) {
      this._killcamPct = pct;
      this._el.killcamFill.style.width = pct + '%';
    }
  }

  // --------------------------------------------------------------------------
  // Death overlay
  // --------------------------------------------------------------------------

  _updateDeath(phase) {
    const c = this._cache;
    const p = this.game.player;
    const dead = !!(p && p.alive === false) && MATCH_PHASES[phase] === 1;
    const dying = dead && p && p.spectatorReady === false;
    const mp = this.game.multiplayer;
    const waiting = !!(dead && mp && mp.active && mp.waitingForNextRound);
    const joinRound = waiting && Number.isFinite(Number(mp.joinRound)) ? Math.floor(Number(mp.joinRound)) : null;
    const target = !dying && dead && p && p.spectatorTarget
      ? p.spectatorTarget
      : (!dying && dead ? this._spectatorTarget : null);
    const targetPlayerId = target?.kind === 'human'
      ? String(target.id || '').replace(/^human:/, '')
      : '';
    const targetName = target
      ? (target.kind === 'human'
          ? humanCallsign(this.game, target.name, targetPlayerId)
          : String(target.name || 'TEAMMATE'))
      : '';
    const respawnIn = dead && this.game.state && isRespawnMode(this.game.state.mode)
      ? this.game.rounds?.tdm?.playerRespawnIn?.()
      : null;
    const respawning = Number.isFinite(respawnIn);
    const targetKey = `${waiting ? `waiting:${joinRound || '?'}` : ''}:${target ? String(target.id || target.name || '') : ''}` +
      (respawning ? `:respawn:${Math.ceil(respawnIn)}:${this.game.loadouts?.selected ?? ''}` : '');
    if (dead !== c.dead || dying !== c.dying || targetKey !== c.spectatorKey) {
      c.dead = dead;
      c.dying = dying;
      c.spectatorKey = targetKey;
      if (this._el.death) this._el.death.style.display = dead ? 'flex' : 'none';
      if (this._el.death) this._el.death.classList.toggle('transitioning', dying);
      if (dead && respawning) {
        const killcam = target && target.kind === 'killcam';
        if (this._el.deathMain) {
          this._el.deathMain.textContent = (killcam ? 'KILLCAM · ' : '') + 'RESPAWNING IN ' + Math.max(1, Math.ceil(respawnIn));
        }
        const touch = !!this.game.input?.touchMode;
        const next = this.game.loadouts?.active?.();
        if (this._el.deathKiller) {
          const recap = this._deathRecap ? ' · ' + this._deathRecap : '';
          this._el.deathKiller.textContent = this._deathKiller
            ? 'ELIMINATED BY ' + this._deathKiller.toUpperCase() + recap
            : 'ELIMINATED';
        }
        // The class switch is what the player can act on: its own line, so
        // a long recap never cuts it off.
        if (this._el.deathHint) {
          const hint = next && !touch ? 'NEXT CLASS: ' + next.name + '  ·  CHANGE WITH ' + this._classKeysLabel() : '';
          this._el.deathHint.hidden = !hint;
          if (this._el.deathHint.textContent !== hint) this._el.deathHint.textContent = hint;
        }
        if (this._el.deathClass) {
          this._el.deathClass.hidden = !(touch && next);
          const label = next ? 'CLASS: ' + next.name + '  ▸' : '';
          if (this._el.deathClass.textContent !== label) this._el.deathClass.textContent = label;
        }
      } else if (dead) {
        if (this._el.deathClass) this._el.deathClass.hidden = true;
        if (this._el.deathHint) this._el.deathHint.hidden = true; // no classes to pick here
        if (this._el.deathMain) {
          this._el.deathMain.textContent = waiting
            ? `SPAWNING ROUND ${joinRound || 'NEXT'}`
            : target
            ? 'SPECTATING ' + targetName.toUpperCase()
            : 'YOU ARE DEAD';
        }
        if (this._el.deathKiller) {
          if (target) {
            const team = faction(target.team).member;
            const kind = target.kind === 'bot' ? 'BOT' : 'PLAYER';
            const next = this.game.input?.touchMode
              ? 'NEXT — SWITCH PLAYER'
              : this._bindingLabel('jump') + ' — NEXT PLAYER';
            this._el.deathKiller.textContent = waiting
              ? 'MID-ROUND JOIN · SPECTATING ' + targetName.toUpperCase() + ' · ' + next
              : team + ' · ' + kind + ' · ' + next;
          } else {
            this._el.deathKiller.textContent = waiting
              ? 'MID-ROUND JOIN · WAITING FOR DEPLOYMENT'
              : this._deathKiller
              ? 'ELIMINATED BY ' + this._deathKiller.toUpperCase()
              : (dying ? 'ELIMINATED' : 'NO LIVING TEAMMATES');
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Scoreboard
  // --------------------------------------------------------------------------

  _updateScoreboard(phase) {
    const input = this.game.input;
    const show = !!(input && typeof input.isDown === 'function' && input.isDown('tab')) &&
      phase !== 'menu' && phase !== 'gameEnd' && !this._buyOpen;
    if (show !== this._sbVisible) {
      this._sbVisible = show;
      if (this._el.scoreboard) this._el.scoreboard.style.display = show ? 'flex' : 'none';
      // Rebuilt every time it opens: a bot's respawn sends no event, so a
      // reopened board said RESPAWNING for bots long since back.
      if (show) this._rebuildScoreboard();
    } else if (show && this._sbDirty) {
      this._rebuildScoreboard();
    }
  }

  _stat(name) {
    let s = this._stats.get(name);
    if (!s) { s = { k: 0, d: 0 }; this._stats.set(name, s); }
    return s;
  }

  applyNetworkPlayerStats(roster) {
    for (const entry of Array.isArray(roster) ? roster : []) {
      if (!entry?.id || !entry.stats || typeof entry.stats !== 'object') continue;
      this._networkStatsById.set(String(entry.id), {
        k: Math.max(0, Math.floor(Number(entry.stats.kills) || 0)),
        d: Math.max(0, Math.floor(Number(entry.stats.deaths) || 0)),
      });
    }
    this._sbDirty = true;
  }

  /** Scoreboard header: team score, or in FFA your kills vs the leader's. */
  _sbScoreText(ct, tt) {
    return isFfa(this.game) ? 'YOU ' + ct + '  ·  LEADER ' + Math.max(ct, tt) : scoreLine(ct, tt, '  :  ');
  }

  _rebuildScoreboard() {
    this._sbDirty = false;
    // The header too: only a score change rewrote it, so a 0:0 FFA after a
    // 0:0 team match kept "US 0 : 0 RU".
    const sc = this.game.state?.scores || {};
    if (this._el.sbScore) this._el.sbScore.textContent = this._sbScoreText(sc.ct | 0, sc.t | 0);
    if (!this._el.sbBody) return;
    const p = this.game.player;
    const mp = this.game.multiplayer;
    const localName = mp && mp.active
      ? humanCallsign(
          this.game,
          mp.localName,
          mp.localId || p?.networkId || 'local',
          this.game?.profile?.name,
        )
      : String(this.game?.profile?.name || p?.name || 'Operative');
    const rows = [{
      name: localName,
      team: (p && p.team) || 'ct',
      alive: p ? p.alive !== false : true,
      local: true,
      sortId: String(mp?.localId || 'local'),
    }];
    if (mp && mp.active) {
      for (const rp of mp.remotePlayers) {
        rows.push({
          name: humanCallsign(this.game, rp.name, rp.networkId || rp.id),
          team: rp.team,
          alive: rp.alive,
          local: false,
          sortId: String(rp.networkId || rp.id || ''),
        });
      }
    }
    const bots = this.game.bots && this.game.bots.all;
    if (Array.isArray(bots)) {
      for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (b && b.name) {
          rows.push({
            name: b.name,
            team: b.team || 't',
            alive: !!b.alive,
            local: false,
            sortId: String(b.networkId || b.id || `bot-${i}`),
          });
        }
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Solo combat events retain the protocol-safe "You" token; the row
      // still presents the customized callsign while reading those stats.
      row.stats = (mp && mp.active && this._networkStatsById.get(row.sortId)) ||
        this._stat(row.local && !(mp && mp.active) ? 'You' : row.name);
      row.order = i;
    }
    let html = '';
    // FFA has no sides: one table ranked by kills. Respawn modes say a
    // fallen soldier is RESPAWNING, not DEAD.
    const ffa = isFfa(this.game);
    const respawning = isRespawnMode(this.game.state?.mode);
    const groups = ffa ? [['ffa', 'FREE-FOR-ALL · FIRST TO ' + modeRules('ffa').scoreLimit]] : ['ct', 't'].map((team) => [team, faction(team).name]);
    for (const [team, label] of groups) {
      html += '<div class="sb-team sb-' + team + '"><div class="sb-team-h">' + label + '</div>' +
      '<table><thead><tr>' + (ffa ? '<th>#</th>' : '') + '<th class="sb-n">OPERATIVE</th><th>K</th><th>D</th><th class="sb-s">STATUS</th></tr></thead><tbody>';
      const teamRows = ffa
        ? [...rows].sort((a, b) => b.stats.k - a.stats.k || a.stats.d - b.stats.d || compareScoreboardRows(a, b))
        : rows.filter((row) => row.team === team).sort(compareScoreboardRows);
      for (const [place, r] of teamRows.entries()) {
        const s = r.stats;
        const status = r.alive
          ? '<span class="sb-alive">ALIVE</span>'
          : respawning
            ? '<span class="sb-kia">RESPAWNING</span>'
            : '<span class="sb-kia">' + SVG_SKULL + ' DEAD</span>';
        const rowClass = [r.alive ? '' : 'sb-dead', r.local ? 'sb-you' : ''].filter(Boolean).join(' ');
        const current = r.local ? ' aria-current="true"' : '';
        const ownTag = r.local ? '<span class="sb-self-tag">YOU</span>' : '';
        html += '<tr class="' + rowClass + '"' + current + '>' + (ffa ? '<td>' + (place + 1) + '</td>' : '') +
          '<td class="sb-n"><span class="sb-name-wrap"><span class="sb-callsign">' + esc(r.name) +
          '</span>' + ownTag + '</span></td><td>' + s.k + '</td><td>' + s.d + '</td>' +
          '<td class="sb-s">' + status + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    this._el.sbBody.innerHTML = html;
  }

  // --------------------------------------------------------------------------
  // Buy menu
  // --------------------------------------------------------------------------

  _buildBuyRows() {
    const wrap = this._el.buyCats;
    if (!wrap) return;
    wrap.innerHTML = '';
    this._buyRows.length = 0;
    for (const cat of this._buyCats) {
      const cd = document.createElement('div');
      cd.className = 'buy-cat';
      const h = document.createElement('div');
      h.className = 'buy-cat-h';
      h.textContent = String(cat.category).toUpperCase();
      cd.appendChild(h);
      for (const id of cat.items) {
        const price = this._prices[id];
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'buy-item';
        const s = this._wstats[id];
        let bars = '';
        if (s && s.rpm > 0) {
          const d = Math.round(clamp(s.dmg / 120, 0.04, 1) * 100);
          const r = Math.round(clamp(s.rpm / 900, 0.04, 1) * 100);
          bars =
            '<div class="bi-bars">' +
            '<div class="bi-bar"><em>DMG</em><span class="bi-track"><i style="width:' + d + '%"></i></span></div>' +
            '<div class="bi-bar"><em>RPM</em><span class="bi-track"><i style="width:' + r + '%"></i></span></div>' +
            '</div>';
        }
        row.innerHTML =
          buyIcon(id) + '<div class="bi-info"><div class="bi-top">' +
          '<span class="bi-name">' + esc(this._names[id] || id) + '</span>' +
          '<span class="bi-price">' + (Number.isFinite(price) ? '$' + price.toLocaleString('en-US') : '—') + '</span>' +
          '<span class="bi-owned">✓ OWNED</span></div>' + bars + '</div>';
        row.addEventListener('click', () => this._tryBuy(id));
        cd.appendChild(row);
        this._buyRows.push({
          id,
          price: Number.isFinite(price) ? price : 0,
          priceText: Number.isFinite(price) ? '$' + price.toLocaleString('en-US') : '—',
          locked: null,
          el: row,
          afford: null,
          owned: null,
          grenade: !!GRENADE_IDS[id],
        });
      }
      wrap.appendChild(cd);
    }
    this._buyMoney = -1;
  }

  _tryBuy(id) {
    const w = this.game.weapons;
    if (!w || typeof w.buy !== 'function') return false;
    const bought = w.buy(id);
    this._buyMoney = -1; // force affordability refresh
    // Paint funds/ownership in the same task as the tap. Waiting for the next
    // animation frame felt like a dead button on iPhone, especially because
    // the equipped weapon is hidden behind this full-screen panel.
    this._refreshBuy();

    const label = String(this._names[id] || id).toUpperCase();
    if (bought) {
      const current = typeof w.current === 'function' ? w.current() : null;
      const equipped = w.currentId === id || current?.id === id;
      this._setBuyFeedback('✓ ' + label + ' PURCHASED' + (equipped ? ' · EQUIPPED' : ''), true);
      const row = this._buyRows.find((entry) => entry.id === id);
      if (row?.el) {
        row.el.classList.remove('purchased');
        void row.el.offsetWidth; // restart the confirmation pulse on repeat grenade buys
        row.el.classList.add('purchased');
      }
    } else {
      const progression = this.game.progression;
      const locked = typeof progression?.isUnlocked === 'function' && !progression.isUnlocked(id);
      this._setBuyFeedback(locked ? label + ' UNLOCKS AT RANK ' + progression.unlockRank(id) : 'PURCHASE UNAVAILABLE', false);
    }
    return bought;
  }

  _setBuyFeedback(text, success) {
    if (this._el.buyFeedbackText) this._el.buyFeedbackText.textContent = text;
    if (this._el.buyFeedback) {
      this._el.buyFeedback.classList.toggle('feedback-success', !!success);
      this._el.buyFeedback.classList.toggle('feedback-error', !success);
    }
  }

  _clearBuyFeedback() {
    if (this._el.buyFeedbackText) this._el.buyFeedbackText.textContent = 'SELECT AN ITEM TO PURCHASE';
    if (this._el.buyFeedback) {
      this._el.buyFeedback.classList.remove('feedback-success', 'feedback-error');
    }
  }

  _canOpenBuy() {
    const st = (this.game && this.game.state) || {};
    if (!st.canBuy) return false;
    if (st.phase !== 'freeze' && st.phase !== 'live') return false;
    const p = this.game.player;
    if (p && p.alive === false) return false;
    return true;
  }

  _toggleBuy() {
    const now = performance.now();
    if (now - this._lastBuyToggle < 140) return; // key handled twice (event + DOM)
    this._lastBuyToggle = now;
    if (!this._buyOpen && !this._canOpenBuy()) {
      const st = (this.game && this.game.state) || {};
      if (isRespawnMode(st.mode)) this._showMsg('', 'NO BUYING · YOUR CLASS IS YOUR LOADOUT', 1.1);
      else if (MATCH_PHASES[st.phase]) this._showMsg('', 'BUY PERIOD OVER', 1.1);
      return;
    }
    this._setBuyOpen(!this._buyOpen);
  }

  _setBuyOpen(open, relock = true) {
    if (open === this._buyOpen) return;
    this._buyOpen = open;
    if (this.game && this.game.state) this.game.state.buyOpen = open;
    if (this._el.buy) this._el.buy.style.display = open ? 'flex' : 'none';
    if (open) {
      // Opened by hand before the round-1 auto-open fired: closing it must
      // not have the pending auto-open reopen it on the next frame.
      this._buyAutoPending = false;
      this._buyAutoOpened = true;
      // release the pointer so rows can be clicked
      if (!this.game.debug && document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
      }
      this._buyMoney = -1;
      this._cache.buyHint = '';
      this._clearBuyFeedback();
      this._refreshBuy();
    } else if (relock) {
      const st = (this.game && this.game.state) || {};
      if (MATCH_PHASES[st.phase] && !this._locked &&
        this.game.input && typeof this.game.input.requestLock === 'function') {
        this.game.input.requestLock();
      }
    }
  }

  _updateBuy(st) {
    if (!this._buyOpen) return;
    if (!st.canBuy || (this.game.player && this.game.player.alive === false)) {
      // Not a click or key press, so the browser refuses a real pointer lock
      // here; the pause overlay asks for the click instead. Touch play's
      // lock is virtual and can be taken back directly.
      this._setBuyOpen(false, !!this.game.input?.touchMode);
      return;
    }
    const money = Math.round(Number.isFinite(st.money) ? st.money : 0);
    if (money !== this._buyMoney) this._refreshBuy();

    // header hint — updates only when the whole-second value flips
    const sec = Math.max(0, Math.ceil(Number.isFinite(st.timer) ? st.timer : 0));
    const hint = st.phase === 'freeze'
      ? 'ROUND LIVE IN ' + sec + 'S'
      : 'BUY WINDOW OPEN';
    if (hint !== this._cache.buyHint) {
      this._cache.buyHint = hint;
      if (this._el.buyTimer) this._el.buyTimer.textContent = hint;
    }
  }

  _refreshBuy() {
    const st = (this.game && this.game.state) || {};
    const money = Math.round(Number.isFinite(st.money) ? st.money : 0);
    this._buyMoney = money;
    if (this._el.buyFunds) this._el.buyFunds.textContent = '$ ' + money;
    const w = this.game.weapons;
    const p = this.game.player;
    const maxArmor = (this.game.config && this.game.config.PLAYER &&
      this.game.config.PLAYER.MAX_ARMOR) || 100;
    const progression = typeof this.game.progression?.isUnlocked === 'function' ? this.game.progression : null;
    for (const r of this._buyRows) {
      let owned = false;
      if (r.id === 'armor') owned = !!(p && p.armor >= maxArmor);
      else if (r.id === 'kit') owned = !!(p && p.hasKit);
      else if (r.grenade) {
        const arr = w && w.slots && Array.isArray(w.slots[4]) ? w.slots[4] : null;
        let n = 0;
        if (arr) for (let i = 0; i < arr.length; i++) if (arr[i] === r.id) n++;
        owned = n >= (this._maxCarry[r.id] || 1);
      } else if (w && typeof w.owns === 'function') {
        owned = w.owns(r.id);
      }
      if (owned !== r.owned) {
        r.owned = owned;
        r.el.classList.toggle('owned', owned);
      }
      // A rank-locked item says what unlocks it in place of its price.
      const locked = !owned && !!progression && !progression.isUnlocked(r.id);
      if (locked !== r.locked) {
        r.locked = locked;
        r.el.classList.toggle('locked', locked);
        const priceEl = r.el.querySelector?.('.bi-price');
        if (priceEl) priceEl.textContent = locked ? '🔒 RANK ' + progression.unlockRank(r.id) : r.priceText;
      }
      const afford = owned || (!locked && r.price <= money);
      if (afford !== r.afford) {
        r.afford = afford;
        r.el.classList.toggle('na', !afford);
      }
      r.el.disabled = owned || !afford;
    }
  }

  // --------------------------------------------------------------------------
  // Pause overlay
  // --------------------------------------------------------------------------

  _updatePause(phase) {
    const show = !this._locked && !this.game.debug && MATCH_PHASES[phase] === 1 && !this._buyOpen;
    // Solo matches stop while the overlay is up; an online match cannot.
    const online = !!this.game.multiplayer?.active;
    this.game.paused = show && !online;
    if (show !== this._pauseShown || (show && online !== this._pauseOnline)) {
      this._pauseShown = show;
      this._pauseOnline = online;
      if (this._el.pause) {
        if (show) {
          const resume = this.game.input?.touchMode ? 'TAP TO RESUME' : 'CLICK TO RESUME';
          const main = this._el.pause.querySelector('.pause-main');
          const sub = this._el.pause.querySelector('.pause-sub');
          if (main) main.textContent = online ? resume : 'PAUSED';
          if (sub) sub.textContent = online ? 'THE MATCH IS STILL RUNNING' : resume;
          if (this._el.pauseResume) this._el.pauseResume.textContent = online ? 'RETURN TO MATCH' : 'RESUME';
        } else {
          this._setPauseSettingsOpen(false);
          this._setHowToOpen(false);
        }
        this._el.pause.style.display = show ? 'flex' : 'none';
        // Keyboard and a controller land on RESUME. A click on the backdrop
        // still resumes, and an open settings panel keeps its own focus.
        if (show && this._el.pauseResume) {
          const active = globalThis.document?.activeElement;
          if (!active || !this._el.pause.contains?.(active)) {
            this._el.pauseResume.focus?.({ preventScroll: true });
          }
        }
      }
    }
  }

  /**
   * A strip of the main controls at the start of a player's first few
   * matches, on desktop (touch controls carry their own labels).
   */
  _maybeShowTips() {
    if (!this._el.tips || this.game.input?.touchMode || this.game.debug) return;
    let shown = 0;
    try { shown = Number(localStorage.getItem(TIPS_STORAGE_KEY)) || 0; } catch { /* private mode */ }
    if (shown >= TIPS_MATCHES) return;
    try { localStorage.setItem(TIPS_STORAGE_KEY, String(shown + 1)); } catch { /* private mode */ }
    const key = (id) => esc(this._bindingLabel(id));
    const tip = (keys, what) => '<span><kbd>' + keys + '</kbd>' + what + '</span>';
    const sd = this.game.state?.mode === 'sd';
    this._el.tips.innerHTML = [
      tip(key('moveForward') + key('moveLeft') + key('moveBackward') + key('moveRight'), 'MOVE'),
      tip(key('sprint'), 'SPRINT'),
      tip(key('crouch'), 'CROUCH'),
      tip(key('reload'), 'RELOAD'),
      tip(key('weapon4'), 'GRENADE'),
      sd ? tip(key('buy'), 'BUY') : tip(key('streak1'), 'STREAK'),
      tip('ESC', 'PAUSE · HOW TO PLAY'),
    ].join('');
    this._tipsUntil = this._time + TIPS_SECONDS;
  }

  _updateTips(inGame) {
    const show = inGame && this._time < (this._tipsUntil || 0);
    if (show !== !!this._tipsShown) {
      this._tipsShown = show;
      this._el.tips?.classList.toggle('show', show);
    }
  }

  /**
   * Settings from the pause overlay: the menu's settings panel is moved into
   * the overlay while open and put back on close, so there is one set of
   * controls to keep in sync.
   */
  _setPauseSettingsOpen(open) {
    const panel = this._el.settingsPanel;
    const host = this._el.pausePanel;
    if (!panel || !host) return;
    open = !!open;
    if (open === !!this._pauseSettingsOpen) return;
    if (open) {
      this._setSettingsOpen(false);
      this._settingsHome = { parent: panel.parentNode, next: panel.nextSibling };
      host.appendChild(panel);
      panel.hidden = false;
      host.hidden = false;
    } else {
      this._cancelBindingCapture('panel-closed');
      panel.hidden = true;
      host.hidden = true;
      const home = this._settingsHome;
      if (home?.parent) home.parent.insertBefore(panel, home.next || null);
      this._settingsHome = null;
    }
    this._pauseSettingsOpen = open;
    this._el.pause?.classList.toggle('with-panel', open);
    if (this._el.pauseSettings) {
      this._el.pauseSettings.setAttribute('aria-expanded', open ? 'true' : 'false');
      this._el.pauseSettings.textContent = open ? 'CLOSE SETTINGS' : 'SETTINGS';
    }
  }

  // --------------------------------------------------------------------------
  // How to play
  // --------------------------------------------------------------------------

  _setHowToOpen(open) {
    open = !!open;
    if (!this._el.howto || open === !!this._howtoOpen) return;
    this._howtoOpen = open;
    if (open) {
      this._howtoReturnFocus = globalThis.document?.activeElement || null;
      if (this._el.howtoBody) this._el.howtoBody.innerHTML = this._howToHtml();
    }
    this._el.howto.hidden = !open;
    if (open) this._el.howtoClose?.focus?.();
    else this._howtoReturnFocus?.focus?.();
  }

  _howToHtml() {
    const touch = !!this.game.input?.touchMode;
    const key = (id) => esc(this._bindingLabel(id));
    const row = (keys, what) => '<li><kbd>' + keys + '</kbd><span>' + esc(what) + '</span></li>';
    const controls = touch ? [
      row('MOVE', 'Left stick'),
      row('DRAG', 'Look around with the right side of the screen'),
      row('FIRE', 'Shoot (hold)'),
      row('AIM', 'Aim down sights'),
      row('JUMP · CROUCH', 'Jump · crouch, slide while sprinting'),
      row('NEXT', 'Skip the killcam · next player while spectating'),
      row('PRIMARY · SIDEARM', 'Switch weapons'),
      row('USE', 'Plant / defuse · use objectives'),
      row('$ BUY', 'Buy menu (Search & Destroy)'),
      row('STREAK', 'Call in a scorestreak'),
      row('❚❚', 'Pause · settings'),
    ] : [
      row(key('moveForward') + key('moveLeft') + key('moveBackward') + key('moveRight'), 'Move'),
      row('MOUSE', this.game.settings?.aimToggle
        ? 'Look · left click shoots · right click aims in / out'
        : 'Look · left click shoots · hold right click to aim'),
      row(key('sprint'), 'Sprint'),
      row(key('walk'), 'Walk quietly'),
      row(key('crouch'), 'Crouch · slide while sprinting'),
      row(key('jump'), 'Jump · skip the killcam · next player while spectating'),
      row(key('reload'), 'Reload'),
      row(key('weapon1') + ' ' + key('weapon2') + ' ' + key('weapon3'), 'Primary · sidearm · knife'),
      row(key('weapon4'), 'Grenade'),
      row(key('lastWeapon'), 'Last weapon'),
      row(key('use'), 'Plant / defuse · use objectives'),
      row(key('buy'), 'Buy menu (Search & Destroy)'),
      row(key('streak1') + ' ' + key('streak2') + ' ' + key('streak3'), 'Call in scorestreaks'),
      row(key('scoreboard'), 'Scoreboard (hold)'),
      row('ESC', 'Pause · settings'),
    ];
    const goals = Object.values(GAME_MODES).map((mode) =>
      '<li><strong>' + esc(mode.label) + '</strong><span>' + esc(modeGoal(mode.id)) + '</span></li>'
    ).join('');
    return '<h3>CONTROLS</h3><ul class="howto-keys">' + controls.join('') + '</ul>' +
      '<p class="howto-note">' + (touch
        ? 'Look sensitivity and more are in Settings.'
        : 'Every key can be changed in Settings.') + '</p>' +
      '<h3>MODES</h3><ul class="howto-modes">' + goals + '</ul>';
  }

  // --------------------------------------------------------------------------
  // Center messages
  // --------------------------------------------------------------------------

  _showMsg(main, sub, dur) {
    if (!this._el.msg) return;
    if (this._el.msgMain) {
      this._el.msgMain.textContent = main;
      this._el.msgMain.style.display = main ? 'block' : 'none';
    }
    if (this._el.msgSub) {
      this._el.msgSub.textContent = sub;
      this._el.msgSub.style.display = sub ? 'block' : 'none';
    }
    this._el.msg.classList.add('show');
    this._msgUntil = this._time + (dur || 2.5);
  }

  _updateMsg() {
    if (this._msgUntil >= 0 && this._time > this._msgUntil) {
      this._msgUntil = -1;
      if (this._el.msg) this._el.msg.classList.remove('show');
    }
  }

  // --------------------------------------------------------------------------
  // Money popup
  // --------------------------------------------------------------------------

  _moneyPop(reward) {
    // Respawn modes hide the wallet; a pop in a hidden box never animates, so
    // its animationend never fires and it would never be removed.
    if (!this._el.moneyBox || !Number.isFinite(reward) || this._el.moneyBox.style.display === 'none') return;
    const s = document.createElement('span');
    s.className = 'money-pop';
    s.textContent = '+$' + reward;
    s.addEventListener('animationend', () => {
      if (s.parentNode) s.parentNode.removeChild(s);
    });
    this._el.moneyBox.appendChild(s);
  }

  // --------------------------------------------------------------------------
  // Game end screen
  // --------------------------------------------------------------------------

  _configureEndPrimaryAction() {
    const online = !!this.game?.multiplayer?.active;
    // Online this leaves the room (the room cannot restart from one browser),
    // so it says so rather than promising a lobby.
    if (this._el.restartMain) this._el.restartMain.textContent = online ? 'LEAVE ROOM' : 'PLAY AGAIN';
    if (this._el.restartSub) this._el.restartSub.textContent = online ? 'BACK TO MAIN MENU' : 'SAME MAP · VS BOTS';
  }

  /** Back to the main menu: solo resets in place, online leaves the room. */
  _returnToMenu() {
    const multiplayer = this.game?.multiplayer;
    if (multiplayer?.active) {
      if (typeof multiplayer.leaveRoomAndReturn === 'function') multiplayer.leaveRoomAndReturn();
      return;
    }
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    this._stats.clear();
    this._networkStatsById.clear();
    this._sbDirty = true;
    this._clearFeed();
    this._endInfo = null;
    this._endUnranked = false;
    this._setEndRank('');
    this.game?.rounds?.returnToMenu?.();
    this._updateStartSub();
  }

  _handleEndPrimaryAction() {
    const multiplayer = this.game?.multiplayer;
    if (multiplayer?.active) {
      if (typeof multiplayer.leaveRoomAndReturn === 'function') multiplayer.leaveRoomAndReturn();
      return;
    }
    this._stats.clear();
    this._networkStatsById.clear();
    this._sbDirty = true;
    this._clearFeed();
    this._endInfo = null;
    this._endUnranked = false;
    this._setEndRank('');
    this.game?.events?.emit?.('ui:restart');
    if (this.game?.input && typeof this.game.input.requestLock === 'function') {
      this.game.input.requestLock();
    }
  }

  _renderUnrankedEndState(d = {}) {
    // Device-only results: a build without a game service.
    const modeOnly = d.reason === 'mode' || d.reason === 'offline';
    // A server-rejected result keeps its rejection line in the rank slot.
    const rejected = d.reason === 'rejected';
    if (!rejected) {
      this._setEndRank(modeOnly
        ? 'THIS MATCH EARNS RANK XP ON THIS DEVICE ONLY'
        : 'UNRANKED GUEST · NO LEADERBOARD CREDIT', 'unranked');
    }
    if (this._el.endRewards) {
      this._el.endRewards.classList.remove('pending');
      this._el.endRewards.classList.add('unranked');
    }
    // Device progress was earned whatever kept the match off the leaderboard
    // (a guest seat, a rejected result, an offline build): show it.
    const local = this._localProgress || null;
    this._setEndRewardLabels(!!local);
    if (local) {
      // Respawn modes still pay device-local rank XP.
      const names = (ids) => ids.map((id) => String(this._names[id] || PERKS[id]?.label || STREAKS[id]?.label || id).toUpperCase());
      if (this._el.endRewardPoints) this._el.endRewardPoints.textContent = '+' + local.earned.toLocaleString('en-US') + ' XP';
      if (this._el.endRewardRank) this._el.endRewardRank.textContent = 'RANK ' + local.after;
      if (this._el.endRewardLevel) {
        this._el.endRewardLevel.textContent = local.after > local.before
          ? 'RANK UP · ' + local.summary.title : local.summary.title;
      }
      if (this._el.endXpFill) this._el.endXpFill.style.width = Math.round(local.summary.fraction * 100) + '%';
      if (this._el.endXpLabel) {
        this._el.endXpLabel.textContent = 'SCORE ' + local.score.toLocaleString('en-US') + ' + ' +
          local.result.toUpperCase() + ' ' + local.bonus + ' · ' + local.summary.xp.toLocaleString('en-US') +
          (local.summary.next > local.summary.floor ? ' / ' + local.summary.next.toLocaleString('en-US') : '') + ' XP';
      }
      if (this._el.endUnlocks) {
        const items = names(local.unlocks).map((n) => '<span>UNLOCKED ' + esc(n) + '</span>');
        for (const up of local.weaponUps) {
          items.push('<span>' + esc(names([up.id])[0]) + ' LEVEL ' + up.level +
            (up.attachments.length ? ' · ' + esc(up.attachments.map((a) => ATTACHMENTS[a]?.label || a).join(', ')) : '') + '</span>');
        }
        // Nothing new this match: say what the next one is and how far off.
        const next = local.after >= FINAL_UNLOCK_RANK ? null : this._nextUnlock(local.after);
        const toGo = next ? Math.max(0, xpForRank(next.rank) - local.summary.xp) : 0;
        this._el.endUnlocks.innerHTML = items.length ? items.join('')
          : '<span class="steady">' + (next
            ? 'NEXT: ' + esc(next.name) + ' AT RANK ' + next.rank + ' · ' + toGo.toLocaleString('en-US') + ' XP TO GO'
            : 'ALL GEAR UNLOCKED') + '</span>';
      }
      return;
    }
    if (this._el.endRewardPoints) this._el.endRewardPoints.textContent = 'NO CREDIT';
    if (this._el.endRewardRank) this._el.endRewardRank.textContent = modeOnly ? 'LOCAL' : rejected ? 'UNRANKED' : 'GUEST';
    if (this._el.endRewardLevel) this._el.endRewardLevel.textContent = 'CAREER UNCHANGED';
    if (this._el.endXpFill) this._el.endXpFill.style.width = '0%';
    if (this._el.endXpLabel) this._el.endXpLabel.textContent = 'THIS MATCH DOES NOT CHANGE YOUR SAVED CAREER';
    if (this._el.endUnlocks) {
      this._el.endUnlocks.innerHTML = modeOnly
        ? '<span class="steady">RANK XP IS SAVED ON THIS DEVICE</span>'
        : rejected
          ? '<span class="steady">NO LEADERBOARD CREDIT FOR THIS MATCH</span>'
          : '<span class="steady">REJOIN WITH YOUR RANKED IDENTITY TO EARN PROGRESS</span>';
    }
  }

  /** Device-only results relabel the reward grid; server rewards restore it. */
  _setEndRewardLabels(local) {
    for (const label of this._el.endRewards?.querySelectorAll?.('small[data-local]') || []) {
      label.dataset.server ||= label.textContent;
      label.textContent = local ? label.dataset.local : label.dataset.server;
    }
  }

  _renderEndRewards(response = null) {
    this._setEndRewardLabels(false);
    const payload = response || this._lastReward?.response || {};
    const rewards = payload.rewards || {};
    const result = payload.result || {};
    const progression = payload.progression || this.game?.leaderboard?.getProgression?.() || this._lastProgression || {};
    const hasResult = !!(payload.rewards || payload.progression || payload.result);
    if (this._el.endRewards) {
      this._el.endRewards.classList.remove('unranked');
      this._el.endRewards.classList.toggle('pending', !hasResult);
    }
    if (this._el.endRewardPoints) {
      const points = Number(result.points?.overall);
      this._el.endRewardPoints.textContent = hasResult && Number.isFinite(points)
        ? '+' + Math.round(points).toLocaleString() : 'SYNCING';
    }
    if (this._el.endRewardRank) {
      const before = Number(rewards.rankBefore);
      const after = Number(rewards.rankAfter ?? progression?.standing?.overallRank);
      if (Number.isFinite(after) && after > 0) {
        this._el.endRewardRank.textContent = Number.isFinite(before) && before > 0 && before !== after
          ? '#' + Math.round(before) + ' → #' + Math.round(after)
          : '#' + Math.round(after);
      } else this._el.endRewardRank.textContent = 'UNRANKED';
    }
    if (this._el.endRewardLevel) {
      const before = Number(rewards.levelBefore);
      const after = Number(rewards.levelAfter ?? progression.level) || 1;
      const tier = String((rewards.tierAfter || progression.tier)?.name || 'Rookie').toUpperCase();
      this._el.endRewardLevel.textContent = Number.isFinite(before) && after > before
        ? 'LEVEL ' + before + ' → ' + after + ' · ' + tier
        : 'LEVEL ' + after + ' · ' + tier;
    }
    const xpInto = Math.max(0, Number(progression.xpIntoLevel) || 0);
    const xpNeed = Math.max(1, Number(progression.xpForNextLevel) || 500);
    if (this._el.endXpFill) this._el.endXpFill.style.width = Math.min(100, xpInto / xpNeed * 100).toFixed(1) + '%';
    if (this._el.endXpLabel) {
      const earned = Math.max(0, Number(rewards.xpEarned) || 0);
      this._el.endXpLabel.textContent = hasResult
        ? '+' + earned.toLocaleString() + ' XP · ' + xpInto.toLocaleString() + '/' + xpNeed.toLocaleString() + ' TO NEXT LEVEL'
        : 'VERIFYING MATCH REWARDS…';
    }
    if (this._el.endUnlocks) {
      const records = Array.isArray(rewards.newRecords) ? rewards.newRecords : [];
      const achievements = Array.isArray(rewards.newAchievements) ? rewards.newAchievements : [];
      const chips = [
        ...this._localRewardChips(),
        ...achievements.map((item) => ({ type: 'achievement', text: '✦ ' + (item.title || 'ACHIEVEMENT') })),
        ...records.map((item) => ({ type: 'record', text: '◆ ' + (item.label || 'PERSONAL RECORD') })),
      ];
      this._el.endUnlocks.innerHTML = chips.length
        ? chips.map((item) => '<span class="' + item.type + '">' + esc(item.text) + '</span>').join('')
        : '<span class="steady">' + (hasResult ? 'CAREER PROGRESS SAVED' : 'REWARDS WILL APPEAR HERE') + '</span>';
    }
  }

  /** Device-local rank results (unlock rank, weapon levels) for the end screen. */
  _localRewardChips() {
    const local = this._localProgress;
    if (!local) return [];
    const name = (id) => String(this._names[id] || PERKS[id]?.label || STREAKS[id]?.label || id).toUpperCase();
    const chips = [];
    if (local.after > local.before) {
      chips.push({ type: 'achievement', text: '▲ UNLOCK RANK ' + local.after + ' · ' + String(local.summary?.title || '').toUpperCase() });
    } else if (local.earned > 0) {
      chips.push({ type: 'record', text: '+' + Number(local.earned).toLocaleString('en-US') + ' UNLOCK XP' });
    }
    for (const id of local.unlocks || []) chips.push({ type: 'achievement', text: 'UNLOCKED ' + name(id) });
    for (const up of local.weaponUps || []) {
      chips.push({
        type: 'record',
        text: name(up.id) + ' LEVEL ' + up.level +
          (up.attachments && up.attachments.length ? ' · ' + up.attachments.map((a) => ATTACHMENTS[a]?.label || a).join(', ') : ''),
      });
    }
    return chips;
  }

  /** This seat's K/D: keyed by 'You' solo, by network id or callsign online. */
  _localEndStats() {
    const multiplayer = this.game?.multiplayer;
    if (!multiplayer?.active) return this._stat('You');
    return this._networkStatsById.get(String(multiplayer.localId || '')) ||
      this._stat(humanCallsign(this.game, multiplayer.localName, multiplayer.localId));
  }

  _fillEndScreen() {
    const st = (this.game && this.game.state) || {};
    const info = this._endInfo || {};
    const scores = info.scores || st.scores || { ct: 0, t: 0 };
    if (info.ffa) {
      const place = info.ffa.place | 0;
      const won = place === 1;
      // A shared first place is a draw (the XP pays it as one, and so does the
      // server): calling it VICTORY over "DRAW 300" contradicted itself.
      const tied = won && !!info.draw;
      const ord = (n) => n + (['TH', 'ST', 'ND', 'RD'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || 'TH');
      if (this._el.endTitle) {
        this._el.endTitle.textContent = tied ? 'DRAW' : won ? 'VICTORY' : place <= 3 ? 'TOP THREE' : 'DEFEATED';
        this._el.endTitle.classList.toggle('lost', place > 3);
      }
      if (this._el.endSub) {
        this._el.endSub.textContent = tied ? 'YOU SHARED 1ST OF ' + info.ffa.total : 'YOU PLACED ' + ord(place) + ' OF ' + info.ffa.total;
      }
      if (this._el.endScore) {
        this._el.endScore.textContent = 'YOU ' + ((info.scores && info.scores.ct) | 0) + '  ·  ' +
          String(tied ? 'TIED' : won ? 'NEXT BEST' : 'WINNER ' + String(info.ffa.leader || '').toUpperCase()) + ' ' +
          (won ? ((info.scores && info.scores.t) | 0) : (info.ffa.leaderKills | 0));
      }
      if (this._el.endKd) {
        const s = this._localEndStats();
        this._el.endKd.textContent = 'YOUR RECORD — ' + s.k + (s.k === 1 ? ' KILL' : ' KILLS') + '  /  ' + s.d + (s.d === 1 ? ' DEATH' : ' DEATHS');
      }
      this._configureEndPrimaryAction();
      this._renderEndRewards(null);
      if (this._endUnranked) this._renderUnrankedEndState({ reason: this._unrankedReason });
      this._renderPodium();
      return;
    }
    const draw = !!info.draw;
    let winner = info.winner;
    if (!winner) winner = (scores.ct >= scores.t) ? 'ct' : 't';
    const playerTeam = this.game?.player?.team === 't' ? 't' : 'ct';
    const won = !draw && winner === playerTeam;
    if (this._el.endTitle) {
      this._el.endTitle.textContent = draw ? 'STALEMATE' : won ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED';
      this._el.endTitle.classList.toggle('lost', !won && !draw);
    }
    if (this._el.endSub) {
      this._el.endSub.textContent = draw
        ? 'NEITHER SIDE BROKE THROUGH'
        : faction(winner).name + ' WIN THE MATCH';
    }
    if (this._el.endScore) {
      this._el.endScore.textContent = scoreLine(scores.ct, scores.t, '  :  ');
    }
    if (this._el.endKd) {
      const s = this._localEndStats();
      this._el.endKd.textContent = 'YOUR RECORD — ' + s.k + (s.k === 1 ? ' KILL' : ' KILLS') + '  /  ' + s.d + (s.d === 1 ? ' DEATH' : ' DEATHS');
    }
    this._configureEndPrimaryAction();
    this._renderEndRewards(null);
    if (this._endUnranked) this._renderUnrankedEndState({ reason: this._unrankedReason });
    this._renderPodium();
  }

  /** Top three by kills (K/D shown), coloured by side outside free-for-all. */
  _renderPodium() {
    const root = document.getElementById('hud-end-podium');
    if (!root) return;
    const teams = new Map();
    const p = this.game.player;
    if (p) teams.set('You', p.team);
    for (const b of (this.game.bots && this.game.bots.all) || []) teams.set(b.name, b.team);
    // Online, humans are keyed by callsign (the local seat too).
    const mp = this.game.multiplayer;
    if (mp && mp.active) {
      if (p && mp.localId) teams.set(humanCallsign(this.game, mp.localName, mp.localId), p.team);
      for (const r of mp.remotePlayers || []) teams.set(humanCallsign(this.game, r.name, r.networkId), r.team);
    }
    const ffa = isFfa(this.game);
    // In free-for-all the order is the match's own standings (which named the
    // WINNER line): breaking a kill tie by deaths here put a different
    // soldier in 1ST than the winner shown above it.
    const standings = ffa && typeof this.game.rounds?.tdm?.ffaStandings === 'function'
      ? this.game.rounds.tdm.ffaStandings() : null;
    const rankOf = new Map();
    if (standings) {
      standings.forEach((row, i) => {
        const key = row.isLocal && mp && mp.active && mp.localId ? humanCallsign(this.game, mp.localName, mp.localId)
          : row.id && mp && mp.active && !String(row.id).startsWith('bot:') ? humanCallsign(this.game, row.name, row.id)
            : row.name;
        if (!rankOf.has(key)) rankOf.set(key, i);
      });
    }
    const rank = (name) => (rankOf.has(name) ? rankOf.get(name) : Infinity);
    const rows = [...this._stats.entries()]
      .filter(([name]) => teams.has(name))
      .sort((a, b) => (standings ? rank(a[0]) - rank(b[0]) : 0) || b[1].k - a[1].k || a[1].d - b[1].d)
      .slice(0, 3);
    root.innerHTML = rows.map(([name, s], i) =>
      '<div class="pod' + (ffa ? '' : ' ' + (teams.get(name) || '')) + '"><b>' + ['1ST', '2ND', '3RD'][i] + '</b>' +
      '<strong>' + esc(String(name).toUpperCase()) + '</strong><small>' + s.k + ' K · ' + s.d + ' D</small></div>').join('');
  }

  // --------------------------------------------------------------------------
  // Debug FPS
  // --------------------------------------------------------------------------

  _updateFps(dt, show) {
    if (!show) {
      if (this._cache.fps !== '') {
        this._cache.fps = '';
        if (this._el.fps) this._el.fps.style.display = 'none';
      }
      return;
    }
    this._fpsTimer += dt;
    if (this._fpsTimer < 0.5 && this._cache.fps) return;
    this._fpsTimer = 0;
    const raw = Number(this.game.fps) || 0;
    let text = raw >= 1
      ? Math.round(raw) + ' FPS · ' + Math.round(1000 / raw) + ' MS'
      : raw > 0 ? '<1 FPS' : '— FPS';
    const r = this.game.perfOverlay && this.game.renderer;
    if (!r && this.game.gfxPreset) {
      text += ' · ' + (GRAPHICS_LABELS[this.game.gfxPreset] || String(this.game.gfxPreset).toUpperCase());
    }
    if (r) {
      text += ' · ' + String(this.game.gfxPreset || '').toUpperCase() +
        ' · ' + r.info.render.calls + ' CALLS · ' + Math.round(r.info.render.triangles / 1000) + 'K TRIS · ' +
        (r.info.programs?.length ?? 0) + ' PROGRAMS · ×' + r.getPixelRatio().toFixed(2);
    }
    if (text !== this._cache.fps) {
      this._cache.fps = text;
      if (this._el.fps) {
        this._el.fps.style.display = 'block';
        this._el.fps.textContent = text;
      }
    }
  }

  // ==========================================================================
  // Markup
  // ==========================================================================

  _html() {
    const settings = this.game?.settings;
    const bindingKey = (definition) =>
      settings?.get?.(definition.id) ?? definition.defaultKey;
    const bindingLabel = (actionId) => {
      const definition = bindingDefinition(actionId);
      return formatKeyLabel(definition ? bindingKey(definition) : null);
    };
    const bindings = KEY_BINDING_DEFINITIONS.map((definition) =>
      '<button class="mn-binding" type="button" data-binding-action="' + esc(definition.id) + '">' +
      '<span>' + esc(definition.label) + '</span><kbd>' +
      esc(formatKeyLabel(bindingKey(definition))) + '</kbd></button>'
    ).join('');
    const lookSensitivity = Number(settings?.lookSensitivity ?? SETTINGS_LIMITS.lookSensitivity.default);
    const brightnessEv = Number(settings?.brightnessEv ?? SETTINGS_LIMITS.brightnessEv.default);
    const volume = Number(settings?.volume ?? SETTINGS_LIMITS.volume.default);
    const fov = Number(settings?.fov ?? SETTINGS_LIMITS.fov.default);
    const useKey = bindingLabel('use');
    const buyKey = bindingLabel('buy');
    const maps = MAP_CATALOG.map((map) =>
      '<button class="mn-map" type="button" data-map-id="' + esc(map.id) + '" aria-pressed="false" ' +
      'style="--map-a:' + esc(map.colors[0]) + ';--map-b:' + esc(map.colors[1]) + ';--map-c:' + esc(map.colors[2]) + '">' +
      '<span class="mn-map-art" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="mn-map-copy"><strong>' + esc(map.name) + '</strong>' +
      '<span>' + esc(map.tempo) + '</span></span><b aria-hidden="true">✓</b></button>'
    ).join('');

    return (
      // ------------------------------------------------ in-game layer
      '<div id="hud-game">' +

      // scope overlay (under everything else in the game layer)
      '<div id="hud-scope">' +
      '<div class="scope-h"></div><div class="scope-v"></div>' +
      '<div class="scope-hole"></div><div class="scope-ring"></div><div class="scope-ring2"></div>' +
      '<div id="hud-scope-zoom"></div>' +
      '</div>' +

      // full-screen feedback
      '<div id="hud-vignette"></div>' +
      '<div id="hud-deathfx"></div>' +
      // killcam replay: letterbox and a strip naming who got you
      '<div id="hud-killcam" aria-live="polite">' +
      '<div class="kc-bar kc-top"></div>' +
      '<div class="kc-bar kc-bottom"><div class="kc-progress"><span id="hud-killcam-fill"></span></div>' +
      '<div class="kc-row"><span class="kc-label">KILLCAM</span>' +
      '<span class="kc-killer" id="hud-killcam-killer"></span>' +
      '<span class="kc-detail" id="hud-killcam-detail"></span>' +
      '<span class="kc-skip" id="hud-killcam-skip"></span></div></div></div>' +
      '<div id="hud-wedges"></div>' +
      '<div id="hud-death"><div class="death-inner"><div class="death-main" id="hud-death-main">YOU ARE DEAD</div>' +
      '<div class="death-sub" id="hud-death-killer">SPECTATING</div>' +
      '<div class="death-hint" id="hud-death-hint" hidden></div>' +
      '<button id="hud-death-class" class="death-class" type="button" hidden>CHANGE CLASS</button></div></div>' +

      // crosshair + hitmarker
      '<div id="hud-score-pop" aria-live="polite"></div>' +
      '<div id="hud-tags" aria-hidden="true"></div>' +
      '<div id="hud-crosshair">' +
      '<div class="ch ch-h" id="hud-ch-l"></div><div class="ch ch-h" id="hud-ch-r"></div>' +
      '<div class="ch ch-v" id="hud-ch-t"></div><div class="ch ch-v" id="hud-ch-b"></div>' +
      '<div class="ch ch-dot"></div>' +
      '</div>' +
      '<div id="hud-hitmarker">' +
      '<div class="hm hm-l"></div><div class="hm hm-r"></div>' +
      '<div class="hm hm-t"></div><div class="hm hm-b"></div>' +
      '</div>' +

      // centered kill confirmation banner (player kills only)
      '<div id="hud-killcue">' +
      '<div class="kc-main" id="hud-killcue-main">ENEMY DOWN</div>' +
      '<div class="kc-name" id="hud-killcue-name"></div>' +
      '</div>' +

      // bottom-left: health / armor
      '<div id="hud-status">' +
      '<div class="hud-panel stat-box" id="hud-health">' +
      '<span class="stat-ico">' + SVG_CROSS + '</span>' +
      '<span class="hud-num stat-num" id="hud-health-num">100</span>' +
      '</div>' +
      '<div class="hud-panel stat-box" id="hud-armor" style="display:none">' +
      '<span class="stat-ico">' + SVG_SHIELD + '</span>' +
      '<span class="hud-num stat-num" id="hud-armor-num">0</span>' +
      '</div>' +
      '</div>' +

      // bottom-center-left: money
      '<div class="hud-panel" id="hud-money">' +
      '<span class="money-sign">$</span><span class="hud-num" id="hud-money-num">800</span>' +
      '</div>' +

      // bottom-right: ammo
      '<div class="hud-panel" id="hud-ammo">' +
      '<div id="hud-reload">RELOADING</div>' +
      '<div class="ammo-row"><span class="hud-num" id="hud-ammo-mag">—</span>' +
      '<span class="hud-num" id="hud-ammo-reserve"></span></div>' +
      '<div id="hud-weapon-name"></div>' +
      '</div>' +
      '<div id="hud-streaks" aria-label="Scorestreaks" hidden></div>' +

      // top-center: timer / scores / round
      '<div class="hud-panel" id="hud-top">' +
      '<div id="hud-timer"><span id="hud-bomb-ico">BOMB</span>' +
      '<span class="hud-num" id="hud-timer-num">0:00</span></div>' +
      '<div id="hud-scores"><i class="sc-flag" id="hud-flag-ct">' + FLAG_SVG.ct + '</i><span class="sc-ct" id="hud-score-ct-label">' + FACTIONS.ct.short + '</span> <span class="hud-num" id="hud-score-ct">0</span>' +
      '<span class="sc-colon">:</span><span class="hud-num" id="hud-score-t">0</span> <span class="sc-t" id="hud-score-t-label">' + FACTIONS.t.short + '</span><i class="sc-flag" id="hud-flag-t">' + FLAG_SVG.t + '</i></div>' +
      '<div id="hud-round">ROUND 1 · FIRST TO 8</div>' +
      '<div id="hud-objective" hidden></div>' +
      '</div>' +

      // top-right: killfeed
      '<div id="hud-killfeed"></div>' +
      // under the radar: your side's bot radio chatter
      '<div id="hud-radio" aria-live="off"></div>' +

      // top-left: radar
      '<div class="hud-panel" id="hud-radar">' +
      '<canvas id="hud-radar-canvas" width="140" height="140"></canvas>' +
      '</div>' +

      // center: messages / defuse / hint
      '<div id="hud-msg"><div id="hud-msg-main"></div><div id="hud-msg-sub"></div></div>' +
      '<div id="hud-tips" aria-hidden="true"></div>' +
      '<div class="hud-panel" id="hud-defuse">' +
      '<div class="df-label" id="hud-defuse-label">DEFUSING…</div>' +
      '<div class="df-track"><div id="hud-defuse-fill"></div></div>' +
      '<div id="hud-defuse-note">NO KIT — HOLD STEADY</div>' +
      '</div>' +
      '<div id="hud-usehint">HOLD <kbd>' + esc(useKey) + '</kbd> TO DEFUSE THE BOMB</div>' +

      // scoreboard
      '<div id="hud-scoreboard"><div class="hud-panel sb-panel">' +
      '<i class="hud-corner tr"></i><i class="hud-corner bl"></i>' +
      '<div class="sb-titlebar"><span class="sb-title">TINY WARFARE — SCOREBOARD</span></div>' +
      '<div class="sb-sub" id="hud-sb-score">' + scoreLine(0, 0) + '</div>' +
      '<div id="hud-sb-body"></div>' +
      '</div></div>' +

      // buy menu
      '<div id="hud-buy" role="dialog" aria-modal="false" aria-labelledby="hud-buy-title"><div class="hud-panel buy-panel">' +
      '<i class="hud-corner tr"></i><i class="hud-corner bl"></i>' +
      '<div class="buy-head"><div class="buy-head-l"><span class="buy-title" id="hud-buy-title">BUY EQUIPMENT</span>' +
      '<span class="buy-hint" id="hud-buy-timer"></span></div>' +
      '<div class="buy-head-actions"><span class="buy-funds" id="hud-buy-funds">$ 800</span>' +
      '<button id="hud-buy-close" class="buy-close" type="button" aria-label="Close buy menu">×</button></div></div>' +
      '<div id="hud-buy-cats"></div>' +
      '<div class="buy-foot" id="hud-buy-feedback">' +
      '<span class="buy-desktop-hint"><kbd id="hud-buy-hint-key">' + esc(buyKey) + '</kbd> / <kbd>ESC</kbd> — CLOSE &nbsp;·&nbsp; </span>' +
      '<span id="hud-buy-feedback-text" role="status" aria-live="polite" aria-atomic="true">SELECT AN ITEM TO PURCHASE</span></div>' +
      '</div></div>' +

      // flash whiteout — over everything in the game layer
      '<div id="hud-stun" aria-hidden="true"></div>' +
      '<div id="hud-protect" aria-hidden="true">SPAWN PROTECTION</div>' +
      '<div id="hud-flash"></div>' +
      '</div>' + // /hud-game

      // Career milestones must survive the transition that hides /hud-game.
      '<div id="hud-progression-toasts" role="status" aria-live="polite" aria-atomic="false"></div>' +

      // ------------------------------------------------ pause overlay
      '<div id="hud-pause" role="dialog" aria-modal="true" aria-labelledby="hud-pause-title"><div class="pause-inner">' +
      '<div class="pause-main" id="hud-pause-title">PAUSED</div>' +
      '<button id="hud-pause-resume" class="pause-resume" type="button">RESUME</button>' +
      '<div class="pause-actions">' +
      '<button id="hud-pause-settings" class="pause-menu" type="button" aria-expanded="false" aria-controls="hud-pause-panel">SETTINGS</button>' +
      '<button id="hud-pause-howto" class="pause-menu" type="button">HOW TO PLAY</button>' +
      '<button id="hud-pause-menu" class="pause-menu" type="button">QUIT TO MAIN MENU</button>' +
      '</div>' +
      '<div class="pause-sub">CLICK TO RESUME</div>' +
      '<div id="hud-pause-panel" hidden></div>' +
      '</div></div>' +

      // ------------------------------------------------ how to play
      '<div id="hud-howto" role="dialog" aria-modal="true" aria-labelledby="hud-howto-title" hidden>' +
      '<div class="howto-card"><div class="howto-head"><strong id="hud-howto-title">HOW TO PLAY</strong>' +
      '<button id="hud-howto-close" type="button" aria-label="Close how to play">CLOSE</button></div>' +
      '<div class="howto-body" id="hud-howto-body"></div></div></div>' +

      // ------------------------------------------------ main menu
      // One primary action (PLAY), quiet secondary choices, everything else
      // behind a single click: career details, online rooms and key bindings
      // all collapse so the first screen stays calm.
      '<div id="hud-menu">' +
      '<div class="mn-scan"></div>' +
      '<div class="mn-top">' +
      '<div class="mn-op">MODERN CONFLICT · U.S. VS RUSSIA</div>' +
      '<div class="mn-title" data-title="TINY WARFARE">TINY WARFARE</div>' +
      '</div>' +
      '<section class="mn-career" id="hud-career" aria-label="Your career progress">' +
      '<button class="mn-id" id="hud-career-toggle" type="button" aria-expanded="false" aria-controls="hud-career-body">' +
      '<span class="mn-id-name"><strong id="hud-career-name">OPERATIVE</strong>' +
      '<span id="hud-career-tier">ROOKIE · CAREER LEVEL 1</span></span>' +
      '<span class="mn-xp"><span class="mn-xp-track"><span id="hud-career-xp-fill"></span></span>' +
      '<small id="hud-career-xp-label">0 / 500 XP TO LEVEL 2</small></span>' +
      '<span class="mn-id-stats"><span><small>OVERALL</small><b id="hud-career-overall">UNRANKED</b></span>' +
      '<span><small>VS BOTS</small><b id="hud-career-bots">UNRANKED</b></span>' +
      '<span><small>SEASON</small><b id="hud-career-score">0</b></span></span>' +
      '<b class="mn-chev" aria-hidden="true">+</b></button>' +
      '<div class="mn-career-body" id="hud-career-body" hidden>' +
      '<div class="mn-career-board"><header><span>GLOBAL TOP 3</span><small id="hud-career-rival">FINISH A MATCH TO ENTER THE RANKS</small></header>' +
      '<div class="mn-podium" id="hud-career-podium"><span>CONTACTING MATCH SERVERS…</span></div></div>' +
      '<div class="mn-daily"><header><span id="hud-daily-title">DAILY BOT OPS</span><b id="hud-daily-reward">+250 BONUS XP</b></header>' +
      '<p id="hud-daily-description">Win against bots and sharpen your combat record.</p>' +
      '<strong id="hud-daily-progress">0/3 MATCHES · 0/2 WINS · 0/20 KILLS</strong>' +
      '<div class="mn-daily-track"><span id="hud-daily-fill"></span></div></div>' +
      '<span class="mn-career-sync" id="hud-career-sync">SYNCING SAVED CAREER…</span>' +
      '</div></section>' +
      '<section class="mn-map-picker" id="hud-map-picker" aria-label="Choose a battleground">' +
      '<div class="mn-section-head">BATTLEGROUND</div>' +
      '<div class="mn-map-grid">' + maps + '</div>' +
      '</section>' +
      '<section class="mn-mode-picker" id="hud-mode-picker" aria-label="Choose a game mode">' +
      '<div class="mn-section-head">MODE</div>' +
      '<div class="mn-mode-row">' + Object.values(GAME_MODES).map((mode) =>
        '<button type="button" class="mn-mode" data-mode-id="' + mode.id + '" aria-pressed="false" aria-label="' +
        esc(mode.label + '. ' + mode.detail) + '">' +
        '<strong>' + esc(mode.label) + '</strong><span>' + esc(mode.detail) + '</span></button>').join('') +
      '</div>' +
      '<div class="mn-section-head mn-sub-head">BOTS</div>' +
      '<div class="mn-mode-row mn-skill-row" id="hud-bot-skill">' + Object.values(BOT_SKILLS).map((skill) =>
        '<button type="button" class="mn-mode" data-bot-skill="' + skill.id + '" aria-pressed="false" aria-label="' +
        esc(skill.label + '. ' + skill.detail) + '">' +
        '<strong>' + esc(skill.label) + '</strong><span>' + esc(skill.detail) + '</span></button>').join('') +
      '</div></section>' +
      '<section class="mn-class-picker" id="hud-class-picker" aria-label="Choose a class" hidden>' +
      '<div class="mn-section-head">CLASS<span class="mn-rank" id="hud-rank-chip"></span>' +
      '<button type="button" id="hud-class-edit" aria-expanded="false">EDIT</button></div>' +
      '<div class="mn-class-row" id="hud-class-row"></div>' +
      '<div class="mn-streak-row"><span>SCORESTREAKS</span>' +
      '<select id="hud-streak-a" aria-label="Scorestreak 1"></select>' +
      '<select id="hud-streak-b" aria-label="Scorestreak 2"></select>' +
      '<small id="hud-streak-detail"></small></div>' +
      '<div class="mn-class-editor" id="hud-class-editor" hidden>' +
      '<label>NAME<input id="hud-class-name" maxlength="16" autocomplete="off" spellcheck="false"></label>' +
      '<label>PRIMARY<select id="hud-class-primary" data-slot="primary"></select>' +
      '<small id="hud-class-weapon-progress" class="mn-weapon-progress"></small></label>' +
      '<label>ATTACHMENT<select id="hud-class-attachment" data-slot="attachment"></select></label>' +
      '<label>SECONDARY<select id="hud-class-secondary" data-slot="secondary"></select></label>' +
      '<label>LETHAL<select id="hud-class-lethal" data-slot="lethal"></select></label>' +
      '<label>TACTICAL<select id="hud-class-tactical" data-slot="tactical"></select></label>' +
      '<label>PERK 1<select id="hud-class-perk" data-slot="perk"></select></label>' +
      '<label>PERK 2<select id="hud-class-perk2" data-slot="perk2"></select></label>' +
      '<p id="hud-class-perk-detail"></p>' +
      '<button type="button" id="hud-class-reset">RESET CLASS</button>' +
      '</div></section>' +
      '<div class="mn-actions">' +
      '<button id="hud-start" type="button"><span class="btn-main">PLAY VS BOTS</span>' +
      '<span class="btn-sub" id="hud-start-sub">INSTANT SOLO MATCH</span></button>' +
      '</div>' +
      '<div class="mn-quick" role="group" aria-label="More options">' +
      '<button id="hud-online-open" type="button" aria-expanded="false" aria-controls="mp-panel">PLAY ONLINE<b class="mn-chev" aria-hidden="true">+</b></button>' +
      '<button id="hud-leaderboard-open" type="button">LEADERBOARDS</button>' +
      '<button id="hud-howto-open" type="button">HOW TO PLAY</button>' +
      '<button id="hud-profile-menu-open" class="hud-profile-open" type="button">PROFILE' +
      '<span class="mn-sr" id="hud-menu-profile-label">OPERATIVE · VANGUARD</span></button>' +
      '<button id="hud-settings-open" type="button" aria-expanded="false" aria-controls="hud-menu-settings">SETTINGS<b class="mn-chev" aria-hidden="true">+</b></button>' +
      '</div>' +
      '<section class="mn-settings" id="hud-menu-settings" role="region" aria-labelledby="hud-settings-open" hidden>' +
      '<div class="mn-settings-title"><strong>GAME SETTINGS</strong><span>CHANGES SAVE ON THIS DEVICE</span></div>' +
      '<div class="mn-settings-groups">' +
      '<section class="mn-settings-group" aria-labelledby="hud-settings-look">' +
      '<h3 id="hud-settings-look">LOOK</h3>' +
      '<div class="mn-settings-tuning">' +
      '<label class="mn-setting" for="hud-look-sensitivity"><span><strong>LOOK SENSITIVITY</strong>' +
      '<output id="hud-look-sensitivity-output" for="hud-look-sensitivity">' +
      lookSensitivity.toFixed(2) + '×</output></span>' +
      '<input id="hud-look-sensitivity" type="range" min="' + SETTINGS_LIMITS.lookSensitivity.min +
      '" max="' + SETTINGS_LIMITS.lookSensitivity.max + '" step="' + SETTINGS_LIMITS.lookSensitivity.step +
      '" value="' + lookSensitivity + '"></label>' +
      '<label class="mn-setting" for="hud-ads-sensitivity"><span><strong>AIM SENSITIVITY</strong>' +
      '<output id="hud-ads-sensitivity-output" for="hud-ads-sensitivity">' +
      Number(settings?.adsSensitivity ?? 1).toFixed(2) + '×</output></span>' +
      '<input id="hud-ads-sensitivity" type="range" min="' + SETTINGS_LIMITS.adsSensitivity.min +
      '" max="' + SETTINGS_LIMITS.adsSensitivity.max + '" step="' + SETTINGS_LIMITS.adsSensitivity.step +
      '" value="' + Number(settings?.adsSensitivity ?? 1) + '"></label>' +
      '<label class="mn-setting" for="hud-fov"><span><strong>FIELD OF VIEW</strong>' +
      '<output id="hud-fov-output" for="hud-fov">' + fov + '°</output></span>' +
      '<input id="hud-fov" type="range" min="' + SETTINGS_LIMITS.fov.min +
      '" max="' + SETTINGS_LIMITS.fov.max + '" step="' + SETTINGS_LIMITS.fov.step +
      '" value="' + fov + '"></label>' +
      '<label class="mn-setting mn-setting-toggle" for="hud-invert-y"><span><strong>INVERT LOOK</strong>' +
      '<output id="hud-invert-y-output" for="hud-invert-y">' + (settings?.invertY ? 'ON' : 'OFF') + '</output></span>' +
      '<small class="mn-setting-note">PUSH UP TO LOOK DOWN · MOUSE, TOUCH AND CONTROLLER</small>' +
      '<input id="hud-invert-y" type="checkbox"' + (settings?.invertY ? ' checked' : '') + '></label>' +
      '<label class="mn-setting mn-setting-toggle mn-setting-mouse-only" for="hud-aim-toggle"><span><strong>TOGGLE AIM</strong>' +
      '<output id="hud-aim-toggle-output" for="hud-aim-toggle">' + (settings?.aimToggle ? 'ON' : 'OFF') + '</output></span>' +
      '<small class="mn-setting-note">RIGHT CLICK AIMS IN AND OUT · SPRINT CANCELS</small>' +
      '<input id="hud-aim-toggle" type="checkbox"' + (settings?.aimToggle ? ' checked' : '') + '></label>' +
      '</div></section>' +
      '<section class="mn-settings-group" aria-labelledby="hud-settings-picture">' +
      '<h3 id="hud-settings-picture">PICTURE</h3>' +
      '<div class="mn-settings-tuning">' +
      '<label class="mn-setting" for="hud-brightness"><span><strong>BRIGHTNESS</strong>' +
      '<output id="hud-brightness-output" for="hud-brightness">' + brightnessLabel(brightnessEv) + '</output></span>' +
      '<small class="mn-setting-note">0 IS THE DESIGNED PICTURE</small>' +
      '<input id="hud-brightness" type="range" min="' + SETTINGS_LIMITS.brightnessEv.min +
      '" max="' + SETTINGS_LIMITS.brightnessEv.max + '" step="' + SETTINGS_LIMITS.brightnessEv.step +
      '" value="' + brightnessEv + '"></label>' +
      '<label class="mn-setting mn-setting-toggle" for="hud-show-fps"><span><strong>SHOW FPS</strong>' +
      '<output id="hud-show-fps-output" for="hud-show-fps">' + (settings?.showFps ? 'ON' : 'OFF') + '</output></span>' +
      '<small class="mn-setting-note">FRAME RATE IN THE CORNER</small>' +
      '<input id="hud-show-fps" type="checkbox"' + (settings?.showFps ? ' checked' : '') + '></label>' +
      '<div class="mn-setting mn-setting-wide"><span><strong id="hud-graphics-label">GRAPHICS</strong>' +
      '<output id="hud-graphics-note">AUTO ADJUSTS TO YOUR DEVICE</output></span>' +
      '<div class="mn-graphics-row" id="hud-graphics" role="radiogroup" aria-labelledby="hud-graphics-label">' +
      Object.entries(GRAPHICS_LABELS).map(([id, label]) => {
        const on = (settings?.graphics || 'auto') === id;
        return '<button type="button" data-graphics="' + id + '" aria-pressed="' + (on ? 'true' : 'false') +
          '" class="' + (on ? 'selected' : '') + '" aria-label="' + esc(label + '. ' + GRAPHICS_DETAILS[id]) + '">' +
          '<strong>' + esc(label) + '</strong><span>' + esc(GRAPHICS_SUMMARIES[id]) + '</span></button>';
      }).join('') +
      '</div>' +
      '<small class="mn-setting-note" id="hud-graphics-detail">' + esc(GRAPHICS_DETAILS[settings?.graphics || 'auto']) + '</small>' +
      '<button id="hud-graphics-reload" class="mn-graphics-reload" type="button" hidden>RELOAD NOW</button></div>' +
      '<label class="mn-setting" for="hud-render-scale"><span><strong>RENDER SCALE</strong>' +
      '<output id="hud-render-scale-output" for="hud-render-scale">' + renderScaleLabel(settings?.renderScale) + '</output></span>' +
      '<small class="mn-setting-note">LOWER RUNS FASTER · APPLIES NOW · FAR LEFT LETS THE PRESET DECIDE</small>' +
      '<input id="hud-render-scale" type="range" min="' + renderScaleSliderMin() +
      '" max="' + RENDER_SCALE_LIMITS.max + '" step="' + RENDER_SCALE_LIMITS.step +
      '" value="' + renderScaleSliderValue(settings?.renderScale) + '"></label>' +
      '</div></section>' +
      '<section class="mn-settings-group" aria-labelledby="hud-settings-sound">' +
      '<h3 id="hud-settings-sound">SOUND</h3>' +
      '<div class="mn-settings-tuning">' +
      '<label class="mn-setting" for="hud-volume"><span><strong>VOLUME</strong>' +
      '<output id="hud-volume-output" for="hud-volume">' + Math.round(volume * 100) + '%</output></span>' +
      '<input id="hud-volume" type="range" min="' + SETTINGS_LIMITS.volume.min +
      '" max="' + SETTINGS_LIMITS.volume.max + '" step="' + SETTINGS_LIMITS.volume.step +
      '" value="' + volume + '"></label>' +
      '<label class="mn-setting mn-setting-toggle" for="hud-announcer"><span><strong>ANNOUNCER VOICE</strong>' +
      '<output id="hud-announcer-output" for="hud-announcer">' + (settings?.announcer === false ? 'OFF' : 'ON') + '</output></span>' +
      '<small class="mn-setting-note">SPOKEN MATCH CALLOUTS</small>' +
      '<input id="hud-announcer" type="checkbox"' + (settings?.announcer === false ? '' : ' checked') + '></label>' +
      '</div></section>' +
      '<section class="mn-settings-group" aria-labelledby="hud-settings-match">' +
      '<h3 id="hud-settings-match">MATCH</h3>' +
      '<div class="mn-settings-tuning">' +
      '<label class="mn-setting mn-setting-toggle" for="hud-killcam-setting"><span><strong>KILLCAM</strong>' +
      '<output id="hud-killcam-setting-output" for="hud-killcam-setting">' + (settings?.killcam === false ? 'OFF' : 'ON') + '</output></span>' +
      '<small class="mn-setting-note">REPLAY HOW YOU DIED · <span class="mn-note-desk">JUMP OR CLICK SKIPS</span><span class="mn-note-touch">NEXT SKIPS</span></small>' +
      '<input id="hud-killcam-setting" type="checkbox"' + (settings?.killcam === false ? '' : ' checked') + '></label>' +
      '<label class="mn-setting mn-setting-toggle mn-setting-mouse-only" for="hud-crouch-toggle"><span><strong>TOGGLE CROUCH</strong>' +
      '<output id="hud-crouch-toggle-output" for="hud-crouch-toggle">' + (settings?.crouchToggle ? 'ON' : 'OFF') + '</output></span>' +
      '<small class="mn-setting-note">CROUCH KEY OR CONTROLLER B PRESSES IN AND OUT · SPRINT CANCELS</small>' +
      '<input id="hud-crouch-toggle" type="checkbox"' + (settings?.crouchToggle ? ' checked' : '') + '></label>' +
      '</div></section></div>' +
      '<section class="mn-bindings-section" aria-labelledby="hud-bindings-title">' +
      '<div class="mn-bindings-head"><strong id="hud-bindings-title">KEY BINDINGS</strong>' +
      '<span>SELECT AN ACTION, THEN PRESS A KEY</span></div>' +
      '<div class="mn-bindings">' + bindings + '</div>' +
      '</section>' +
      '<div class="mn-settings-foot"><span class="mn-settings-mouse">MOUSE — AIM · LMB — FIRE · RMB — AIM DOWN SIGHTS / SCOPE · WHEEL — CYCLE<br>' +
      'CONTROLLER — RT FIRE · LT AIM · A JUMP · B CROUCH · X RELOAD (HOLD: USE) · Y / RB WEAPONS · LB GRENADE · ' +
      'R3 KNIFE · L3 SPRINT · D-PAD STREAKS / BUY · VIEW SCORES · START PAUSE</span>' +
      '<button id="hud-settings-reset" type="button">RESET DEFAULTS</button>' +
      '<span id="hud-settings-status" role="status" aria-live="polite" aria-atomic="true"></span></div>' +
      '</section>' +
      '</div>' +

      // ------------------------------------------------ leaderboard overlay
      '<div id="hud-leaderboard" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="hud-lb-title">' +
      '<div class="lb-panel">' +
      '<div class="lb-accent"></div>' +
      '<header class="lb-top"><div><small>TINY WARFARE NETWORK</small><h2 id="hud-lb-title">LEADERBOARDS</h2></div>' +
      '<button id="hud-leaderboard-close" type="button" aria-label="Close leaderboard">×</button></header>' +
      '<div class="lb-toolbar"><div class="lb-identity"><span class="lb-avatar" id="hud-leaderboard-avatar" aria-hidden="true"><i></i></span>' +
      '<span class="lb-identity-copy"><small>YOUR OPERATIVE</small><strong id="hud-leaderboard-name">Operative</strong>' +
      '<span id="hud-leaderboard-character">VANGUARD</span></span>' +
      '<button class="lb-profile-edit hud-profile-open" type="button">EDIT PROFILE</button></div>' +
      '<div class="lb-tabs" role="tablist" aria-label="Leaderboard category">' +
      '<button type="button" data-leaderboard-category="humans" role="tab" aria-selected="false">HUMANS</button>' +
      '<button type="button" data-leaderboard-category="bots" role="tab" aria-selected="false">BOTS</button>' +
      '<button type="button" data-leaderboard-category="overall" class="active" role="tab" aria-selected="true">OVERALL</button>' +
      '</div><button id="hud-leaderboard-refresh" type="button">↻ REFRESH</button></div>' +
      '<div class="lb-self-card" id="hud-leaderboard-self"><span><small>YOUR OVERALL RANK</small><strong>UNRANKED</strong></span>' +
      '<span><small>SEASON SCORE</small><strong>0</strong></span><span><small>CAREER LEVEL</small><strong>1 · ROOKIE</strong></span>' +
      '<span><small>ACHIEVEMENTS</small><strong>0/12</strong></span></div>' +
      '<div class="lb-meta"><span id="hud-leaderboard-status">TOP 50 OPERATIVES</span></div>' +
      '<div id="hud-leaderboard-body"><div class="lb-state loading"><span class="lb-state-mark"></span>' +
      '<strong>CONTACTING MATCH SERVERS…</strong></div></div>' +
      '<details class="lb-dossier" id="hud-career-dossier"><summary><span><strong>CAREER RECORDS &amp; ACHIEVEMENTS</strong>' +
      '<small id="hud-career-next-goal">NEXT: COMPLETE A MATCH TO SET YOUR FIRST RECORD</small></span><b aria-hidden="true">+</b></summary>' +
      '<div class="lb-dossier-body"><section><header>PERSONAL BESTS</header><div class="lb-record-grid" id="hud-career-records"></div></section>' +
      '<section><header>EARNED BADGES</header><div class="lb-badge-grid" id="hud-career-achievements"></div></section></div></details>' +
      '<details class="lb-scoring"><summary><strong>SCORING DETAILS</strong>' +
      '<span>SEE HOW RANKING POINTS ARE EARNED</span><b aria-hidden="true">+</b></summary>' +
      '<div id="hud-leaderboard-rules">Wins matter most. Kills, headshots, objectives, and completed rounds add score.</div>' +
      '</details>' +
      '<footer class="lb-foot"><span>COMPLETE MATCHES TO SCORE</span><span class="lb-desktop-hint">ESC — CLOSE</span></footer>' +
      '</div></div>' +

      // ------------------------------------------------ profile editor
      '<div id="hud-profile" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="hud-profile-title">' +
      '<div class="profile-panel"><div class="profile-accent"></div>' +
      '<header class="profile-top"><div><small>OPERATIVE IDENTITY</small><h2 id="hud-profile-title">CUSTOMIZE PROFILE</h2></div>' +
      '<button id="hud-profile-close" type="button" aria-label="Close profile editor">×</button></header>' +
      '<form id="hud-profile-form"><label class="profile-name"><span>CALLSIGN</span>' +
      '<input id="hud-profile-name" maxlength="20" autocomplete="nickname" spellcheck="false" value="Operative" ' +
      'aria-describedby="hud-profile-name-help"><small id="hud-profile-name-help">Shown in matches and global rankings</small></label>' +
      '<fieldset><legend>CHOOSE YOUR OPERATIVE</legend><div id="hud-profile-characters" class="profile-characters"></div></fieldset>' +
      '<div class="profile-note"><strong>APPEARANCE</strong><span>Your appearance is applied to your arms and player model.</span></div>' +
      '<details class="profile-progress" id="hud-progress-details"><summary><strong>CAREER RECOVERY &amp; BACKUP</strong><span>BACK UP, RESTORE, OR DELIBERATELY START OVER</span><b>+</b></summary>' +
      '<div class="profile-progress-body"><p>Your private progress key reconnects this callsign, XP, records, achievements, and ranks. Keep it secret.</p>' +
      '<div class="profile-progress-actions"><button id="hud-progress-copy" type="button">COPY PRIVATE PROGRESS KEY</button>' +
      '<input id="hud-progress-key" type="password" autocomplete="off" spellcheck="false" placeholder="PASTE PRIVATE PROGRESS KEY">' +
      '<button id="hud-progress-restore" type="button">RESTORE CAREER</button></div>' +
      '<div class="profile-new-career" id="hud-progress-new-wrap"><span><strong>START OVER</strong><small>Permanently disconnect this browser from its current career.</small></span>' +
      '<button id="hud-progress-new" type="button" aria-expanded="false" aria-controls="hud-progress-new-confirm">START NEW CAREER</button></div>' +
      '<div class="profile-new-confirm" id="hud-progress-new-confirm" hidden aria-hidden="true"><span><strong>THIS CANNOT BE UNDONE WITHOUT YOUR OLD KEY</strong>' +
      '<small>Your current XP, records, badges, and ranks will no longer be connected to this browser.</small></span>' +
      '<button id="hud-progress-new-cancel" type="button">KEEP CURRENT CAREER</button>' +
      '<button id="hud-progress-new-commit" type="button">YES, START NEW CAREER</button></div>' +
      '<span id="hud-progress-status" role="status" aria-live="polite">THIS DEVICE RESUMES AUTOMATICALLY</span></div></details>' +
      '<footer class="profile-actions"><button id="hud-profile-cancel" type="button">CANCEL</button>' +
      '<button class="profile-save" type="submit">SAVE PROFILE</button></footer>' +
      '</form></div></div>' +

      // ------------------------------------------------ game end
      '<div id="hud-end">' +
      '<div class="mn-scan"></div>' +
      '<div class="end-inner">' +
      '<div id="hud-end-title">MISSION ACCOMPLISHED</div>' +
      '<div id="hud-end-sub"></div>' +
      '<div id="hud-end-score" class="hud-num">' + scoreLine(0, 0) + '</div>' +
      '<div id="hud-end-kd"></div>' +
      '<div id="hud-end-podium" aria-label="Top players"></div>' +
      '<div id="hud-end-rank"></div>' +
      '<section id="hud-end-rewards" class="end-rewards pending"><div class="end-reward-grid">' +
      '<span><small data-local="UNLOCK XP">MATCH POINTS</small><strong id="hud-end-reward-points">SYNCING</strong></span>' +
      '<span><small data-local="UNLOCK RANK">OVERALL RANK</small><strong id="hud-end-reward-rank">—</strong></span>' +
      '<span><small data-local="TITLE">CAREER</small><strong id="hud-end-reward-level">LEVEL 1 · ROOKIE</strong></span></div>' +
      '<div class="end-xp"><div><span id="hud-end-xp-fill"></span></div><small id="hud-end-xp-label">VERIFYING MATCH REWARDS…</small></div>' +
      '<div id="hud-end-unlocks" class="end-unlocks"><span class="steady">REWARDS WILL APPEAR HERE</span></div></section>' +
      '<div class="end-actions"><button id="hud-restart"><span class="btn-main" id="hud-restart-main">PLAY AGAIN</span>' +
      '<span class="btn-sub" id="hud-restart-sub">SAME MAP · VS BOTS</span></button>' +
      '<button id="hud-end-leaderboard"><span class="btn-main">VIEW LEADERBOARD</span>' +
      '<span class="btn-sub">YOUR RANK · GLOBAL RIVALS</span></button></div>' +
      '<button id="hud-end-menu" class="end-menu-link" type="button">MAIN MENU</button>' +
      '</div></div>' +

      // ------------------------------------------------ debug fps
      '<div id="hud-fps" style="display:none"></div>'
    );
  }

  // ==========================================================================
  // Styles
  // ==========================================================================

  _css() {
    return `
#hud {
  position: fixed; inset: 0; overflow: hidden; z-index: 10;
  pointer-events: none; user-select: none; -webkit-user-select: none;
  font-family: "Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, system-ui, sans-serif;
  font-stretch: condensed;
  color: #9ab26b;
  -webkit-font-smoothing: antialiased;
  --olive: #9ab26b;
  --olive-bright: #d6e5b8;
  --olive-dim: #8a9a6a; /* ~6:1 on the dark panels (was 3.9:1) */
  --panel-border: rgba(154, 178, 107, 0.34);
  --ct: #7fa8d6;
  --t: #d98a4a;
  --red: #e2503e;
  --money: #9fe07a;
}
:where(#hud) * { box-sizing: border-box; margin: 0; padding: 0; }
#hud kbd {
  display: inline-block; min-width: 30px; text-align: center;
  padding: 2px 8px; border: 1px solid rgba(154,178,107,.45);
  background: linear-gradient(180deg, rgba(24, 29, 15, 0.95), rgba(8, 11, 5, 0.95));
  color: var(--olive-bright);
  font: inherit; font-size: 12px; font-weight: 700; letter-spacing: .08em;
  box-shadow: 0 2px 0 rgba(0,0,0,.6), inset 0 1px 0 rgba(200,220,170,.12);
  clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
}
.hud-panel {
  position: relative;
  background:
    linear-gradient(180deg, rgba(24, 29, 15, 0.66) 0%, rgba(11, 14, 7, 0.78) 55%, rgba(5, 7, 3, 0.86) 100%);
  border: 1px solid var(--panel-border);
  box-shadow:
    inset 0 1px 0 rgba(202, 222, 168, 0.10),
    inset 0 0 0 1px rgba(154, 178, 107, 0.05),
    inset 0 0 24px rgba(0, 0, 0, 0.42);
  clip-path: polygon(
    var(--notch, 9px) 0, 100% 0,
    100% calc(100% - var(--notch, 9px)), calc(100% - var(--notch, 9px)) 100%,
    0 100%, 0 var(--notch, 9px));
}
.hud-corner {
  position: absolute; width: 15px; height: 15px; pointer-events: none; opacity: .8;
}
.hud-corner.tr { top: 5px; right: 5px; border-top: 2px solid var(--olive); border-right: 2px solid var(--olive); }
.hud-corner.bl { bottom: 5px; left: 5px; border-bottom: 2px solid var(--olive); border-left: 2px solid var(--olive); }
.hud-num {
  font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: .02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}
#hud-game { position: absolute; inset: 0; z-index: 1; pointer-events: none; }

/* ---------- bottom-left: health / armor ---------- */
#hud-status { position: absolute; left: 18px; bottom: 18px; display: flex; gap: 10px; }
.stat-box { display: flex; align-items: center; gap: 10px; padding: 8px 18px 9px 14px; }
.stat-ico { display: flex; color: var(--olive); filter: drop-shadow(0 1px 1px rgba(0,0,0,.8)); }
.stat-num { font-size: 33px; line-height: 1; color: var(--olive-bright); min-width: 52px; }
#hud-health.low { border-color: rgba(226, 80, 62, 0.75); animation: hud-low-pulse 1.05s ease-in-out infinite; }
#hud-health.low .stat-num, #hud-health.low .stat-ico { color: #e8604e; }
@keyframes hud-low-pulse {
  0%, 100% { box-shadow: inset 0 1px 0 rgba(202,222,168,.10), inset 0 0 24px rgba(0,0,0,.42); }
  50% { box-shadow: inset 0 0 0 1px rgba(226,70,50,.5), inset 0 0 26px rgba(150,20,10,.55); }
}

/* ---------- bottom-center-left: money ---------- */
#hud-money {
  position: absolute; left: 33%; bottom: 18px; padding: 9px 18px 10px;
  font-size: 25px; font-weight: 700; color: var(--money); display: flex; gap: 7px; align-items: baseline;
}
#hud-money .money-sign { font-size: 16px; opacity: .75; font-weight: 800; }
#hud-money.pulse { animation: hud-money-pulse .4s ease-out; }
@keyframes hud-money-pulse {
  0% { box-shadow: inset 0 0 0 1px rgba(159,224,122,.55), inset 0 0 22px rgba(90,160,60,.35); }
  100% { box-shadow: inset 0 1px 0 rgba(202,222,168,.10), inset 0 0 24px rgba(0,0,0,.42); }
}
.money-pop {
  position: absolute; right: 6px; top: -16px; font-size: 15px; font-weight: 800;
  color: var(--money); text-shadow: 0 1px 2px #000; pointer-events: none; letter-spacing: .04em;
  animation: hud-money-rise 1.1s ease-out forwards;
}
@keyframes hud-money-rise {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-34px); }
}

/* ---------- bottom-right: ammo ---------- */
#hud-ammo { position: absolute; right: 18px; bottom: 18px; padding: 7px 18px 10px; text-align: right; min-width: 158px; }
.ammo-row { display: flex; align-items: baseline; justify-content: flex-end; gap: 7px; }
#hud-ammo-mag { font-size: 40px; line-height: 1; color: var(--olive-bright); }
#hud-ammo-mag.low { color: #e8604e; }
#hud-ammo-reserve { font-size: 19px; color: var(--olive-dim); }
#hud-streaks { position:absolute; right:18px; bottom:104px; display:flex; flex-direction:column; gap:4px; min-width:158px; }
#hud-streaks[hidden] { display:none; }
.sk-row { position:relative; display:flex; align-items:center; gap:7px; padding:4px 8px 6px; overflow:hidden;
  background:rgba(7,10,4,.62); border:1px solid rgba(154,178,107,.18); font-size:10px; font-weight:900;
  letter-spacing:.14em; color:var(--olive-dim); }
.sk-row kbd { font:inherit; padding:0 4px; border:1px solid rgba(154,178,107,.35); color:var(--olive); }
.sk-row i { position:absolute; left:0; bottom:0; height:2px; width:var(--sk); background:var(--olive); }
.sk-row.ready { color:#f3f7ec; border-color:#f7d27a; box-shadow:0 0 12px rgba(247,210,122,.25); }
.sk-row.ready kbd { color:#101510; background:#f7d27a; border-color:#f7d27a; }
.sk-row.ready i { background:#f7d27a; }
#hud-weapon-name {
  font-size: 11px; letter-spacing: .3em; color: var(--olive); text-transform: uppercase;
  margin-top: 3px; text-shadow: 0 1px 2px #000;
}
#hud-reload {
  display: none; font-size: 11px; font-weight: 700; letter-spacing: .3em; color: #e0b23c;
  animation: hud-blink .55s step-end infinite alternate; margin-bottom: 2px;
}
@keyframes hud-blink { from { opacity: 1; } to { opacity: .25; } }

/* ---------- top-center: timer / scores ---------- */
#hud-top {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  text-align: center; padding: 7px 30px 8px; min-width: 190px;
}
#hud-top::before {
  content: ''; position: absolute; left: 22%; right: 22%; top: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--olive), transparent); opacity: .55;
}
#hud-timer { display: flex; align-items: center; justify-content: center; gap: 8px; }
#hud-timer-num { font-size: 28px; line-height: 1.1; color: var(--olive-bright); }
#hud-timer-num.red { color: #e8604e; }
#hud-bomb-ico {
  display: none; font-size: 11px; font-weight: 800; letter-spacing: .05em;
  color: #fff; background: rgba(200, 40, 24, 0.85); border: 1px solid rgba(255, 120, 100, 0.7);
  padding: 1px 6px;
  clip-path: polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px);
  animation: hud-bomb-pulse .8s ease-in-out infinite;
}
@keyframes hud-bomb-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(226, 60, 40, 0.9); }
  50% { opacity: .55; box-shadow: 0 0 2px rgba(226, 60, 40, 0.3); }
}
#hud-scores { font-size: 15px; margin-top: 2px; display: flex; justify-content: center; gap: 7px; align-items: baseline; }
#hud-scores .hud-num { font-size: 17px; color: var(--olive-bright); }
.sc-ct { color: var(--ct); font-weight: 800; letter-spacing: .08em; }
.sc-flag { display:inline-flex; vertical-align:-1px; margin:0 5px; opacity:.9; }
.sc-flag[hidden] { display:none; }
.sc-flag svg { display:block; border:1px solid rgba(0,0,0,.4); }
#hud-end-podium { display:flex; justify-content:center; gap:10px; margin:6px 0 2px; }
.pod { min-width:120px; padding:5px 10px; text-align:center; background:rgba(8,13,8,.6); border:1px solid rgba(154,178,107,.25); }
.pod b { display:block; font-size:9px; letter-spacing:.2em; color:#f7d27a; }
.pod strong { display:block; font-size:13px; letter-spacing:.06em; color:#eef5e5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pod small { font-size:9.5px; letter-spacing:.12em; color:var(--olive); }
.pod.ct { border-color:rgba(95,159,224,.6); } .pod.t { border-color:rgba(224,96,60,.6); }
.sc-t { color: var(--t); font-weight: 800; letter-spacing: .08em; }
.sc-colon { color: var(--olive-dim); }
#hud-round { font-size: 10.5px; letter-spacing: .26em; color: var(--olive-dim); margin-top: 3px; }
#hud-objective { display:flex; justify-content:center; gap:6px; margin-top:5px; }
#hud-objective[hidden] { display:none; }
.obj-flag { position:relative; width:26px; height:22px; display:grid; place-items:center; overflow:hidden;
  font-size:12px; font-weight:900; color:#eef5e5; background:rgba(216,220,205,.12); border:1px solid rgba(216,220,205,.4); }
.obj-flag i { position:absolute; left:0; bottom:0; height:3px; width:var(--cap); background:var(--capc); }
.obj-flag.ours { background:rgba(95,159,224,.35); border-color:#5f9fe0; }
.obj-flag.theirs { background:rgba(224,96,60,.35); border-color:#e0603c; }
.obj-flag.contested { animation:obj-pulse .6s ease-in-out infinite alternate; }
@keyframes obj-pulse { to { border-color:#f7d27a; box-shadow:0 0 8px rgba(247,210,122,.5); } }
@media (prefers-reduced-motion: reduce) { .obj-flag.contested { animation:none; border-color:#f7d27a; } }

/* ---------- top-right: killfeed ---------- */
#hud-killfeed {
  position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column;
  gap: 6px; align-items: flex-end; max-width: 60vw; z-index: 3;
}
.kf-entry {
  display: flex; gap: 11px; align-items: center; padding: 7px 16px 7px 14px;
  background: linear-gradient(180deg, rgba(13, 17, 8, 0.72), rgba(5, 7, 3, 0.8));
  border: 1px solid rgba(154, 178, 107, 0.2);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.07);
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  font-size: 22px; font-weight: 800; letter-spacing: .03em;
  transition: opacity .6s; white-space: nowrap;
  animation: kf-in .26s cubic-bezier(.18, .8, .3, 1);
}
@keyframes kf-in {
  from { opacity: 0; transform: translateX(28px); }
  to { opacity: 1; transform: translateX(0); }
}
.kf-entry.kf-fade { opacity: 0; }
.kf-entry.kf-mine {
  border-color: rgba(154, 178, 107, 0.8); background: linear-gradient(180deg, rgba(33, 42, 17, 0.82), rgba(18, 24, 9, 0.86));
  box-shadow: inset 0 0 14px rgba(154, 178, 107, 0.18), inset 0 1px 0 rgba(202, 222, 168, 0.1);
}
.kf-entry.kf-death {
  border-color: rgba(226, 80, 62, 0.8);
  background: linear-gradient(180deg, rgba(52, 13, 9, 0.82), rgba(30, 7, 5, 0.86));
}
/* Below the top bar, under the modal screens (pause 40, menus 50, how-to 70). */
#hud-progression-toasts {
  position:absolute; z-index:38; top:96px; left:50%; transform:translateX(-50%); width:min(360px,calc(100vw - 36px));
  display:flex; flex-direction:column; gap:8px; pointer-events:none;
}
.progress-toast {
  min-height:70px; display:flex; align-items:center; gap:12px; padding:11px 14px;
  color:#eef5e3; background:linear-gradient(110deg,rgba(19,29,12,.97),rgba(5,9,6,.92));
  border:1px solid rgba(179,210,118,.6); border-left:4px solid #a7cf6e;
  box-shadow:0 12px 35px rgba(0,0,0,.52),inset 0 1px rgba(255,255,255,.07);
  clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);
  animation:progress-toast-in .32s cubic-bezier(.2,.8,.2,1) both;
}
.progress-toast.record { border-left-color:#e1b95d; }
.progress-toast.level { border-left-color:#7eb6e7; }
.progress-toast.provisional { opacity:.92; border-style:dashed; }
.progress-toast.leaving { animation:progress-toast-out .25s ease both; }
.progress-toast-mark { flex:0 0 42px; width:42px; height:42px; display:grid; place-items:center; font-size:22px; color:#e6cf7b; border:1px solid rgba(214,229,184,.3); background:rgba(154,178,107,.09); transform:rotate(0); }
.progress-toast-copy { min-width:0; display:flex; flex-direction:column; }
.progress-toast-copy small { font-size:10.5px; font-weight:900; letter-spacing:.2em; color:#92aa6e; }
.progress-toast-copy strong { margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:18px; line-height:1.05; letter-spacing:.08em; }
.progress-toast-copy em { margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-style:normal; color:#b4c3a2; }
@keyframes progress-toast-in { from { opacity:0; transform:translateX(-24px) scale(.97); } to { opacity:1; transform:none; } }
@keyframes progress-toast-out { to { opacity:0; transform:translateX(-18px); } }
.kf-name { text-shadow: 0 1px 3px #000; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; }
.kf-mine .kf-name { text-shadow: 0 0 8px rgba(190, 220, 150, 0.5), 0 1px 3px #000; }
.kf-ct { color: var(--ct); }
.kf-t { color: var(--t); }
.kf-ffa { color: #e8eedc; }
.kf-weap {
  color: var(--olive-bright); font-size: 12px; font-weight: 700; letter-spacing: .18em;
  text-transform: uppercase; padding: 3px 9px;
  background: rgba(154, 178, 107, 0.12); border: 1px solid rgba(154, 178, 107, 0.35);
  clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
}
.kf-hs {
  font-size: 12px; font-weight: 800; color: #fff; letter-spacing: .14em; padding: 3px 7px;
  background: linear-gradient(180deg, rgba(226, 56, 34, 0.95), rgba(168, 30, 16, 0.95));
  border: 1px solid rgba(255, 120, 100, 0.55);
  clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
  text-shadow: 0 1px 1px rgba(0,0,0,.6);
}

/* ---------- centered kill confirmation banner ---------- */
#hud-killcue {
  position: absolute; left: 50%; top: 40%; z-index: 6;
  transform: translate(-50%, -50%); text-align: center;
  opacity: 0; pointer-events: none;
}
#hud-killcue.show { animation: killcue-pop 1.6s cubic-bezier(.16, .84, .3, 1) forwards; }
.kc-main {
  font-size: 44px; font-weight: 900; letter-spacing: .14em; color: #eef5df;
  text-shadow: 0 0 22px rgba(154, 178, 107, 0.75), 0 3px 8px rgba(0, 0, 0, 0.85);
  -webkit-text-stroke: 1px rgba(0, 0, 0, 0.35);
}
.kc-name {
  margin-top: 6px; font-size: 22px; font-weight: 700; letter-spacing: .18em;
  color: #e0a05c; text-shadow: 0 2px 6px #000;
}
#hud-killcue.hs .kc-main {
  color: #ffd54a;
  text-shadow: 0 0 26px rgba(255, 96, 40, 0.9), 0 3px 8px rgba(0, 0, 0, 0.85);
}
@keyframes killcue-pop {
  0%   { opacity: 0; transform: translate(-50%, -50%) scale(1.55); }
  12%  { opacity: 1; transform: translate(-50%, -50%) scale(0.95); }
  24%  { transform: translate(-50%, -50%) scale(1.03); }
  34%  { transform: translate(-50%, -50%) scale(1); }
  72%  { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
}

/* ---------- top-left: radar ---------- */
#hud-radar { position: absolute; top: 16px; left: 16px; width: 148px; height: 148px; padding: 3px; }
/* ---------- under the radar: bot radio ---------- */
#hud-radio { position: absolute; top: 176px; left: 16px; display: flex; flex-direction: column; gap: 4px;
  align-items: flex-start; max-width: 34vw; z-index: 3; pointer-events: none; }
.rd-entry { display: flex; gap: 8px; align-items: baseline; padding: 4px 10px; white-space: nowrap;
  background: rgba(5, 7, 3, 0.62); border-left: 2px solid rgba(154, 178, 107, 0.55);
  font-size: 14px; font-weight: 800; letter-spacing: .04em; transition: opacity .6s;
  animation: kf-in .22s cubic-bezier(.18, .8, .3, 1); }
.rd-entry.kf-fade { opacity: 0; }
.rd-name { text-shadow: 0 1px 3px #000; }
.rd-text { color: #e8eedc; text-shadow: 0 1px 3px #000; }
#hud-radar-canvas { display: block; width: 140px; height: 140px; border-radius: 2px; }

/* ---------- crosshair ---------- */
#hud-crosshair { position: absolute; left: 50%; top: 50%; width: 0; height: 0; z-index: 4; }
.ch { position: absolute; background: #4de54d; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5); }
.ch-h { width: 8px; height: 2px; left: 0; top: -1px; }
.ch-v { width: 2px; height: 8px; top: 0; left: -1px; }
.ch-dot { width: 2px; height: 2px; left: -1px; top: -1px; }
#hud-crosshair .ch { transition: opacity .12s, background-color .08s; }
#hud-crosshair.enemy .ch { background: #ff4a3a !important; box-shadow: 0 0 3px rgba(255,74,58,.7); }
/* Not colour alone: over an enemy the lines also thicken and a ring appears. */
#hud-crosshair.enemy .ch-h { height: 3px; top: -1.5px; }
#hud-crosshair.enemy .ch-v { width: 3px; left: -1.5px; }
#hud-crosshair::after {
  content: ''; position: absolute; left: -7px; top: -7px; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid #ff4a3a; box-shadow: 0 0 0 1px rgba(0,0,0,.45); opacity: 0; transform: scale(.6);
  transition: opacity .08s, transform .08s;
}
#hud-crosshair.enemy::after { opacity: .9; transform: none; }
#hud-tags { position:absolute; inset:0; pointer-events:none; z-index:3; overflow:hidden; }
.hud-tag { position:absolute; left:0; top:0; display:none; padding:1px 5px; font-size:10px; font-weight:900; letter-spacing:.08em;
  color:#bfe0ff; background:rgba(20,40,70,.45); border-bottom:2px solid #5f9fe0; white-space:nowrap; text-shadow:0 1px 2px #000; }
#hud-score-pop { position:absolute; left:50%; top:calc(50% + 44px); transform:translateX(-50%); z-index:4;
  display:flex; flex-direction:column; align-items:center; gap:2px; pointer-events:none; }
.sp-row { display:flex; flex-wrap:wrap; justify-content:center; align-items:baseline; column-gap:7px; row-gap:1px;
  font-weight:900; letter-spacing:.12em; white-space:nowrap;
  color:#f3f7ec; text-shadow:0 1px 3px rgba(0,0,0,.85); animation:sp-pop 1.6s ease-out forwards; }
.sp-row b { font-size:17px; color:#f7d27a; }
.sp-row span { font-size:11px; }
.sp-row.sp-bonus b { font-size:14px; color:#9fe0a0; }
.sp-row.sp-rich b { font-size:20px; }
.sp-tags { flex-basis:100%; display:flex; justify-content:center; flex-wrap:wrap; gap:3px 8px; }
.sp-tags i { font-style:normal; font-size:10px; letter-spacing:.14em; color:#9fe0a0; }
.sp-tags i + i::before { content:'·'; margin-right:8px; color:rgba(159,224,160,.55); }
@keyframes sp-pop { 0% { opacity:0; transform:translateY(6px) scale(.9); } 10% { opacity:1; transform:none; }
  75% { opacity:1; } 100% { opacity:0; transform:translateY(-8px); } }
@media (prefers-reduced-motion: reduce) { .sp-row { animation:none; } }
#hud-crosshair.ads .ch:not(.ch-dot), #hud-crosshair.sprint .ch { opacity: 0; }

/* ---------- hitmarker ---------- */
#hud-hitmarker {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0; z-index: 5;
  opacity: 0; transform: rotate(45deg);
}
.hm {
  position: absolute; background: #fff; border-radius: 1px;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.9);
}
.hm-l { left: -19px; top: -1.5px; width: 13px; height: 3px; }
.hm-r { left: 6px; top: -1.5px; width: 13px; height: 3px; }
.hm-t { top: -19px; left: -1.5px; width: 3px; height: 13px; }
.hm-b { top: 6px; left: -1.5px; width: 3px; height: 13px; }
#hud-hitmarker.kill .hm {
  background: #ff4436;
  box-shadow: 0 0 8px rgba(255, 68, 54, 0.95), 0 0 3px rgba(0, 0, 0, 0.9);
}

/* ---------- damage / flash ---------- */
#hud-vignette {
  position: absolute; inset: 0; opacity: 0; z-index: 2;
  background: radial-gradient(ellipse at center, rgba(255, 0, 0, 0) 40%, rgba(190, 22, 10, 0.65) 100%);
}
#hud-deathfx {
  position: absolute; inset: 0; opacity: 0; z-index: 2; pointer-events: none;
  background:
    radial-gradient(ellipse at 50% 44%, rgba(14, 6, 4, 0) 22%, rgba(48, 8, 4, .42) 70%, rgba(2, 2, 1, .88) 100%),
    linear-gradient(180deg, rgba(34, 5, 2, .13), rgba(1, 2, 1, .42));
}
#hud-wedges { position: absolute; left: 50%; top: 50%; z-index: 2; }
.hud-wedge {
  position: absolute; left: 0; top: 0; width: 112px; height: 34px;
  margin-left: -56px; margin-top: -17px; opacity: 0;
  clip-path: polygon(50% 0, 86% 100%, 14% 100%);
  background: linear-gradient(to bottom, rgba(255, 62, 40, 0.95), rgba(255, 62, 40, 0));
}
#hud-flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 30; }
#hud-protect { position: absolute; left: 50%; top: calc(50% + 44px); transform: translateX(-50%); opacity: 0;
  font-size: 10px; font-weight: 900; letter-spacing: .28em; color: #bfe0ff; text-shadow: 0 0 10px rgba(110,170,255,.7), 0 1px 2px #000;
  pointer-events: none; z-index: 8; }
/* Stun grenade: a cold, pulsing concussion vignette (movement is slowed). */
#hud-stun { position: absolute; inset: 0; opacity: 0; z-index: 29; pointer-events: none;
  background: radial-gradient(ellipse at center, rgba(150,190,255,0) 38%, rgba(120,160,230,.32) 72%, rgba(70,95,150,.62) 100%); }

/* ---------- scope ---------- */
#hud-scope { position: absolute; inset: 0; display: none; z-index: 1; }
/* The corner panels stay readable through the scope's black and the red
   damage and death washes (z 1-2). */
#hud-status, #hud-money, #hud-ammo, #hud-streaks, #hud-top, #hud-radar { z-index: 3; }
.scope-hole {
  position: absolute; left: 50%; top: 50%; width: 94vmin; height: 94vmin;
  transform: translate(-50%, -50%); border-radius: 50%;
  box-shadow: 0 0 0 200vmax rgba(2, 3, 2, 0.985), inset 0 0 130px rgba(0, 0, 0, 0.9);
}
.scope-ring {
  position: absolute; left: 50%; top: 50%; width: calc(94vmin - 10px); height: calc(94vmin - 10px);
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 3px solid rgba(8, 10, 8, 0.95);
  box-shadow: inset 0 0 0 1px rgba(190, 210, 170, 0.14);
}
.scope-ring2 {
  position: absolute; left: 50%; top: 50%; width: calc(94vmin - 42px); height: calc(94vmin - 42px);
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 1px solid rgba(190, 210, 170, 0.10);
}
.scope-h { position: absolute; left: 0; right: 0; top: 50%; height: 1.6px; margin-top: -0.8px; background: rgba(0, 0, 0, 0.92); }
.scope-v { position: absolute; top: 0; bottom: 0; left: 50%; width: 1.6px; margin-left: -0.8px; background: rgba(0, 0, 0, 0.92); }
#hud-scope-zoom {
  position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%);
  font-size: 13px; letter-spacing: .35em; color: rgba(190, 210, 170, 0.65); text-shadow: 0 1px 2px #000;
}

/* ---------- center messages ---------- */
#hud-msg {
  /* Never above the score panel: on a 375 px-tall phone 20% is 75 px, and
     "GO GO GO!" sat on Domination's A/B/C chips (the panel ends near 110). */
  position: absolute; left: 0; right: 0; top: max(20%, 122px); text-align: center;
  opacity: 0; transform: translateY(6px);
  transition: opacity .32s, transform .32s; z-index: 6; pointer-events: none;
}
#hud-msg.show { opacity: 1; transform: translateY(0); }
#hud-tips {
  position: absolute; left: 50%; bottom: 24%; transform: translateX(-50%);
  display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 16px; width: max-content; max-width: 92vw;
  padding: 9px 16px; background: rgba(5, 7, 4, 0.72); border: 1px solid rgba(154, 178, 107, 0.3);
  font-size: 12px; font-weight: 700; letter-spacing: .14em; color: #dfe8cf;
  opacity: 0; transition: opacity .4s; z-index: 6; pointer-events: none;
}
#hud-tips.show { opacity: 1; }
#hud-tips span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
#hud-tips kbd {
  padding: 1px 5px; font: inherit; font-size: 11px; color: #eef5df;
  background: rgba(154, 178, 107, 0.18); border: 1px solid rgba(154, 178, 107, 0.45); border-radius: 3px;
}
#hud-msg-main {
  font-size: 36px; font-weight: 900; letter-spacing: .24em; text-transform: uppercase;
  color: #eef5df;
  text-shadow: 0 0 26px rgba(154, 178, 107, 0.5), 0 2px 2px #000;
  -webkit-text-stroke: 1px rgba(0, 0, 0, 0.25);
}
#hud-msg-sub {
  font-size: 13px; font-weight: 700; letter-spacing: .36em; text-transform: uppercase;
  color: var(--olive); margin-top: 8px; text-shadow: 0 1px 2px #000;
}

/* ---------- defuse ---------- */
#hud-defuse {
  position: absolute; left: 50%; bottom: 21%; transform: translateX(-50%);
  width: 320px; padding: 10px 16px 12px; display: none; text-align: center; z-index: 6;
}
.df-label {
  font-size: 13px; font-weight: 800; letter-spacing: .36em; text-transform: uppercase;
  color: var(--olive-bright); margin-bottom: 8px;
}
.df-track {
  height: 13px; border: 1px solid var(--panel-border); background: rgba(0, 0, 0, 0.58);
  box-shadow: inset 0 1px 3px rgba(0,0,0,.7);
}
#hud-defuse-fill {
  height: 100%; width: 100%; transform: scaleX(0); transform-origin: left center;
  background: repeating-linear-gradient(-45deg, #7ba04c 0 9px, #a9c87c 9px 18px);
  box-shadow: inset 0 1px 0 rgba(230, 244, 205, 0.4);
  animation: df-stripes .48s linear infinite;
}
@keyframes df-stripes {
  from { background-position: 0 0; }
  to { background-position: 25.46px 0; }
}
#hud-defuse-note {
  font-size: 9.5px; font-weight: 700; letter-spacing: .24em; color: var(--olive-dim); margin-top: 7px;
}
#hud-defuse-note.kit { color: var(--money); }
#hud-usehint {
  position: absolute; left: 50%; bottom: 21%; transform: translateX(-50%);
  display: none; font-size: 13px; font-weight: 700; letter-spacing: .22em; color: var(--olive-bright);
  text-shadow: 0 1px 3px #000; z-index: 6;
}

/* ---------- killcam ---------- */
#hud-killcam { position: absolute; inset: 0; display: none; z-index: 8; pointer-events: none; }
#hud.killcam-on #hud-killcam { display: block; }
.kc-bar { position: absolute; left: 0; right: 0; height: 9vh; background: #000; }
.kc-top { top: 0; animation: kc-in-top .35s cubic-bezier(.2,.75,.25,1) both; }
.kc-bottom { bottom: 0; animation: kc-in-bottom .35s cubic-bezier(.2,.75,.25,1) both; }
@keyframes kc-in-top { from { transform: translateY(-100%); } to { transform: none; } }
@keyframes kc-in-bottom { from { transform: translateY(100%); } to { transform: none; } }
.kc-progress { position: absolute; left: 0; right: 0; top: 0; height: 3px; background: rgba(255,255,255,.1); }
.kc-progress span { display: block; height: 100%; width: 0; background: #d4562c; }
.kc-row {
  display: flex; align-items: center; gap: 14px; height: 100%; padding: 0 max(18px, 3vw);
  font-weight: 800; letter-spacing: .16em; white-space: nowrap; overflow: hidden;
}
.kc-label { font-size: 12px; color: #0a0806; background: #d4562c; padding: 4px 9px; letter-spacing: .22em; }
/* The killer's name is the point of the bar: it keeps its width (to 45%) and
   the detail gives way first. On a 667 px phone "Viper" was cut to "VIP…". */
.kc-killer { flex: 0 0 auto; max-width: 45%; font-size: 18px; font-weight: 900; letter-spacing: .12em; overflow: hidden; text-overflow: ellipsis; }
.kc-killer.ffa { color: #e8eedc; }
.kc-killer.ct { color: var(--ct); }
.kc-killer.t { color: var(--t); }
.kc-detail { flex: 1 1 auto; min-width: 0; font-size: 12px; color: #c7cfbb; overflow: hidden; text-overflow: ellipsis; }
.kc-skip { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; margin-left: auto; font-size: 11px; color: rgba(214,229,184,.75); }
@media (max-width: 760px) { .kc-row { gap: 9px; letter-spacing: .1em; } .kc-killer { font-size: 16px; } }
/* The replay is the whole screen: the live HUD steps aside. */
#hud.killcam-on #hud-radar, #hud.killcam-on #hud-top, #hud.killcam-on #hud-killfeed,
#hud.killcam-on #hud-health, #hud.killcam-on #hud-armor, #hud.killcam-on #hud-ammo,
#hud.killcam-on #hud-money, #hud.killcam-on #hud-streaks, #hud.killcam-on #hud-crosshair,
#hud.killcam-on #hud-tags, #hud.killcam-on #hud-usehint, #hud.killcam-on #hud-death,
#hud.killcam-on #hud-deathfx, #hud.killcam-on #hud-vignette, #hud.killcam-on #hud-wedges,
#hud.killcam-on #hud-hitmarker, #hud.killcam-on #hud-weapon-name, #hud.killcam-on #hud-objective,
#hud.killcam-on #hud-scope, #hud.killcam-on #hud-radio, #hud.killcam-on #hud-msg,
#hud.killcam-on #hud-killcue, #hud.killcam-on #hud-score-pop, #hud.killcam-on #hud-tips,
#hud.killcam-on #hud-defuse, #hud.killcam-on #hud-protect, #hud.killcam-on #hud-flash,
#hud.killcam-on #hud-progression-toasts { display: none !important; }
/* Touch: the NEXT button sits over the strip's right end. */
html.touch-device .kc-row { padding-right: 104px; }
@media (prefers-reduced-motion: reduce) { .kc-top, .kc-bottom { animation: none; } }

/* ---------- death ---------- */
#hud-death {
  position: absolute; left: 50%; bottom: clamp(26px, 6vh, 66px); display: none;
  transform: translateX(-50%); align-items: center; justify-content: center;
  width: min(620px, calc(100vw - 30px)); z-index: 7; pointer-events: none;
}
.death-class {
  margin-top: 9px; padding: 8px 16px; min-height: 36px; pointer-events: auto;
  background: rgba(20, 26, 12, .9); border: 1px solid rgba(154, 178, 107, .55);
  color: var(--olive-bright); font: inherit; font-size: 12px; font-weight: 800; letter-spacing: .16em;
}
.death-class[hidden] { display: none; }
.death-inner {
  width: 100%; padding: 12px 20px 11px; text-align: center;
  background: linear-gradient(180deg, rgba(14, 17, 10, .90), rgba(5, 7, 4, .94));
  border: 1px solid rgba(212, 86, 44, .62); border-left-width: 4px;
  box-shadow: inset 0 1px rgba(255, 255, 255, .06), 0 9px 30px rgba(0, 0, 0, .42);
  clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
}
#hud-death.transitioning .death-inner {
  animation: death-card-in .48s cubic-bezier(.2, .75, .25, 1) both;
}
@keyframes death-card-in {
  from { opacity: 0; transform: translateY(12px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.death-main {
  font-size: 17px; font-weight: 900; letter-spacing: .2em; text-transform: uppercase;
  color: #eef5df; text-shadow: 0 2px 5px #000;
}
.death-hint {
  margin-top: 5px; font-size: 10.5px; font-weight: 800; letter-spacing: .16em; color: var(--olive-bright);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.death-hint[hidden] { display: none; }
.death-sub {
  font-size: 10px; font-weight: 700; letter-spacing: .18em; color: #b9aa9b;
  margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---------- scoreboard ---------- */
#hud-scoreboard {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  z-index: 10; padding: clamp(24px, 4vw, 56px); background: rgba(2, 4, 1, 0.52);
}
.sb-panel {
  --notch: 14px; width: min(1050px, 100%); max-height: 100%; padding: 0 0 28px;
  overflow: auto; backdrop-filter: blur(8px);
  border-color: rgba(154, 178, 107, 0.46);
  box-shadow: inset 0 0 34px rgba(0, 0, 0, .5), 0 14px 55px rgba(0, 0, 0, .48);
}
.sb-titlebar {
  padding: 19px 32px 17px; text-align: center;
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.17), rgba(154, 178, 107, 0.03));
  border-bottom: 1px solid var(--panel-border);
}
.sb-title {
  display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 22px; font-weight: 900; letter-spacing: .25em; color: var(--olive-bright);
  text-shadow: 0 1px 2px #000;
}
.sb-sub {
  text-align: center; font-size: 25px; font-weight: 900; letter-spacing: .18em;
  color: var(--olive-bright); margin: 18px 0 5px; font-variant-numeric: tabular-nums;
}
.sb-team { margin: 16px 32px 0; border: 1px solid rgba(154, 178, 107, 0.2); background: rgba(0, 0, 0, 0.3); }
.sb-team-h {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 16px; font-weight: 900; letter-spacing: .24em; padding: 10px 18px 9px;
  text-shadow: 0 1px 2px rgba(0,0,0,.7);
}
.sb-ct .sb-team-h {
  color: #e6f0fb;
  background: linear-gradient(90deg, rgba(62, 96, 136, 0.92), rgba(62, 96, 136, 0.10));
  box-shadow: inset 0 0 0 1px rgba(127, 168, 214, 0.22), inset 3px 0 0 var(--ct);
}
.sb-t .sb-team-h {
  color: #fbeddc;
  background: linear-gradient(90deg, rgba(148, 82, 30, 0.92), rgba(148, 82, 30, 0.10));
  box-shadow: inset 0 0 0 1px rgba(217, 138, 74, 0.22), inset 3px 0 0 var(--t);
}
.sb-team table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.sb-team th {
  font-size: 12px; letter-spacing: .2em; color: var(--olive-dim); font-weight: 900;
  text-align: center; padding: 9px 14px 7px; border-bottom: 1px solid rgba(154, 178, 107, 0.14);
}
.sb-team th.sb-n, .sb-team td.sb-n { text-align: left; width: 54%; padding-left: 22px; }
.sb-team th.sb-s, .sb-team td.sb-s { text-align: right; width: 24%; padding-right: 22px; }
.sb-team td.sb-n {
  max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sb-name-wrap { display: flex; align-items: center; gap: 9px; min-width: 0; }
.sb-callsign { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-self-tag {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  padding: 3px 7px 2px; border: 1px solid rgba(225, 249, 181, .8);
  background: #b9dc7e; color: #11180b; font-size: 9px; font-weight: 950;
  line-height: 1; letter-spacing: .16em; text-shadow: none;
  box-shadow: 0 0 12px rgba(185, 220, 126, .2);
}
.sb-team td {
  font-size: 19px; font-weight: 750; color: var(--olive-bright); padding: 7px 14px;
  text-align: center; font-variant-numeric: tabular-nums;
}
.sb-team tbody tr:nth-child(odd) td { background: rgba(255, 255, 255, 0.028); }
.sb-team td.sb-s { font-size: 13px; font-weight: 900; letter-spacing: .14em; white-space: nowrap; }
.sb-team td.sb-s .sb-alive { color: #a9d38a; }
.sb-team td.sb-s .sb-kia { color: #b2604e; display: inline-flex; align-items: center; gap: 5px; }
.sb-team td.sb-s .sb-kia svg { opacity: .9; }
.sb-team tr.sb-dead:not(.sb-you) td { opacity: .42; }
.sb-team tbody tr.sb-you td {
  opacity: 1; color: #f3ffdc; font-weight: 900;
  background: linear-gradient(90deg, rgba(154, 191, 91, .38), rgba(91, 119, 48, .22));
  box-shadow: inset 0 1px 0 rgba(213, 242, 159, .45), inset 0 -1px 0 rgba(154, 191, 91, .38);
  text-shadow: 0 1px 2px #000, 0 0 10px rgba(187, 224, 119, .16);
}
.sb-team tbody tr.sb-you td:first-child {
  box-shadow: inset 5px 0 0 #c8eb89, inset 0 1px 0 rgba(213, 242, 159, .45), inset 0 -1px 0 rgba(154, 191, 91, .38);
}
.sb-team tbody tr.sb-you.sb-dead td { opacity: .82; }

/* ---------- buy menu ---------- */
#hud-buy {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  z-index: 12; padding: clamp(18px, 3vw, 44px); background: rgba(2, 4, 1, 0.58);
}
.buy-panel {
  --notch: 14px; pointer-events: auto; cursor: default;
  display: flex; flex-direction: column; width: min(1180px, 100%); max-height: 100%;
  padding: 0 0 18px; overflow: hidden; backdrop-filter: blur(8px);
  border-color: rgba(154, 178, 107, 0.5);
  box-shadow: inset 0 0 34px rgba(0, 0, 0, .52), 0 14px 60px rgba(0, 0, 0, .56);
}
.buy-head {
  flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center;
  gap: 20px; padding: 17px 26px 15px; margin-bottom: 16px;
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.17), rgba(154, 178, 107, 0.03));
  border-bottom: 1px solid var(--panel-border);
}
.buy-head-l { min-width: 0; display: flex; align-items: baseline; gap: 20px; }
.buy-head-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; }
.buy-title {
  flex: 0 0 auto; font-size: 19px; font-weight: 800; letter-spacing: .3em; color: var(--olive-bright);
  text-shadow: 0 1px 2px #000;
}
.buy-hint {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11.5px; font-weight: 700; letter-spacing: .22em; color: var(--olive-dim);
}
.buy-funds {
  flex: 0 0 auto; font-size: 26px; font-weight: 800; letter-spacing: .05em; color: var(--money);
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px #000;
}
.buy-close {
  display: none; width: 48px; height: 48px; padding: 0; border: 1px solid rgba(154,178,107,.48);
  background: rgba(0,0,0,.34); color: var(--olive-bright); font: 800 25px/1 Arial,sans-serif;
  cursor: pointer; touch-action: manipulation;
}
.buy-close:hover,.buy-close:focus-visible { background: rgba(154,178,107,.22); border-color: var(--olive); outline: none; }
#hud-buy-cats {
  min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
  align-items: start; gap: 13px; padding: 0 20px 2px;
  scrollbar-width: thin; scrollbar-color: rgba(154,178,107,.55) rgba(0,0,0,.28);
}
.buy-cat {
  min-width: 0; background: rgba(0, 0, 0, 0.32); border: 1px solid rgba(154, 178, 107, 0.2);
  padding: 0 8px 9px;
}
.buy-cat-h {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 800; letter-spacing: .28em; color: var(--olive);
  text-align: center; padding: 9px 5px 8px; margin: 0 -8px 8px;
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.13), rgba(154, 178, 107, 0.0));
  border-bottom: 1px solid rgba(154, 178, 107, 0.2);
  text-shadow: 0 1px 2px #000;
}
.buy-item {
  appearance:none; display: flex; align-items: center; gap: 10px; width:100%; min-width: 0; min-height: 66px;
  padding: 9px 10px; margin: 6px 0;
  font-family:inherit; color:inherit; text-align:left;
  background: rgba(154, 178, 107, 0.05); border: 1px solid rgba(154, 178, 107, 0.17);
  clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
  cursor: pointer; transition: background .09s, border-color .09s, box-shadow .09s;
}
.buy-item:focus-visible { outline:2px solid var(--olive-bright); outline-offset:1px; }
.buy-item:hover {
  background: rgba(154, 178, 107, 0.17); border-color: rgba(154, 178, 107, 0.6);
  box-shadow: inset 0 0 12px rgba(154, 178, 107, 0.14);
}
.buy-item:active { background: rgba(154, 178, 107, 0.32); }
.buy-item.purchased { animation: buy-purchased .72s ease-out; }
@keyframes buy-purchased {
  0% { border-color: #efffba; box-shadow: inset 0 0 24px rgba(211,239,155,.62), 0 0 18px rgba(176,218,104,.66); }
  100% { border-color: rgba(154,178,107,.42); box-shadow: none; }
}
.bi-icon {
  flex: 0 0 66px; width: 66px; height: 38px; display: grid; place-items: center;
  color: #b7c991; opacity: .92; filter: drop-shadow(0 2px 1px rgba(0,0,0,.75));
  border-right: 1px solid rgba(154,178,107,.16); padding-right: 9px;
}
.bi-icon svg { display: block; width: 100%; height: 100%; }
.bi-info { min-width: 0; flex: 1; }
/* Five columns at 1366 px leave ~110 px beside the icon: the price wraps under
   the name rather than cutting "AK-47" to "AK…". */
.bi-top { min-width: 0; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 1px 7px; }
.buy-item .bi-name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 15.5px; font-weight: 700; color: var(--olive-bright); letter-spacing: .025em;
}
.buy-item .bi-price { flex: 0 0 auto; font-size: 14px; font-weight: 700; color: var(--money); font-variant-numeric: tabular-nums; }
.buy-item .bi-owned { display: none; font-size: 10px; font-weight: 800; letter-spacing: .12em; color: var(--olive); white-space: nowrap; }
.buy-item.owned {
  cursor: default; pointer-events: none;
  background: rgba(154, 178, 107, 0.11); border-color: rgba(154, 178, 107, 0.42);
}
.buy-item.owned .bi-price { display: none; }
.buy-item.owned .bi-owned { display: inline; }
.buy-item.owned .bi-icon { color: var(--money); }
.buy-item.na {
  opacity: .45; cursor: default; pointer-events: none;
  background: rgba(0, 0, 0, 0.22); border-color: rgba(154, 178, 107, 0.08);
}
.buy-item.na .bi-price { color: #dd6450; }
.buy-item.locked .bi-price { color: var(--olive-dim); font-size: 11px; letter-spacing: .1em; }
.bi-bars { margin-top: 7px; display: grid; gap: 4px; }
.bi-bar { display: flex; align-items: center; gap: 6px; }
.bi-bar em {
  font-style: normal; font-size: 10px; font-weight: 800; letter-spacing: .16em;
  color: var(--olive-dim); width: 26px;
}
.bi-track { flex: 1; height: 3px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
.bi-track i { display: block; height: 100%; background: linear-gradient(90deg, #6d8a45, #c9dfa0); }
.buy-foot {
  flex: 0 0 auto; min-height: 34px; margin: 16px 20px 0; padding: 9px 12px 0; border-top: 1px solid var(--panel-border);
  font-size: 11px; font-weight: 700; letter-spacing: .2em; color: var(--olive-dim); text-align: center;
  transition: color .12s, background .12s, border-color .12s, box-shadow .12s;
}
.buy-foot kbd { font-size: 10px; min-width: 20px; padding: 1px 5px; }
.buy-foot.feedback-success {
  color: #e5f7bf; background: rgba(111,145,58,.2); border-color: rgba(190,224,128,.68);
  box-shadow: inset 0 0 14px rgba(165,211,94,.12); text-shadow: 0 1px 2px #000;
}
.buy-foot.feedback-error { color: #ffb09c; background: rgba(141,52,35,.18); border-color: rgba(221,100,80,.58); }

/* 768-px laptops: two full teams fit without scrolling the last rows. */
@media (max-height: 820px) {
  #hud-scoreboard { padding-block: 14px; }
  .sb-panel { padding-bottom: 16px; }
  .sb-titlebar { padding-block: 12px 10px; }
  .sb-sub { margin: 10px 0 2px; font-size: 21px; }
  .sb-team { margin-top: 10px; }
  .sb-team td { font-size: 17px; padding-block: 5px; }
}
/* Keep the two data-heavy overlays comfortably inside common laptop and
   narrow-window viewports. Their inner content scrolls before edges clip. */
@media (max-width: 1100px) {
  #hud-buy-cats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .bi-icon { flex-basis: 72px; width: 72px; }
}
@media (max-width: 760px) {
  #hud-scoreboard, #hud-buy { padding: 14px; }
  .sb-panel { padding-bottom: 16px; }
  .sb-titlebar { padding-inline: 18px; }
  .sb-title { font-size: 15px; letter-spacing: .22em; }
  .sb-team { margin-inline: 14px; }
  .sb-team-h { letter-spacing: .2em; }
  .sb-team th.sb-n, .sb-team td.sb-n { width: 48%; padding-left: 12px; }
  .sb-team th.sb-s, .sb-team td.sb-s { width: 30%; padding-right: 12px; }
  #hud-buy-cats { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-inline: 14px; }
  .buy-head { padding: 13px 18px 12px; margin-bottom: 12px; }
  .buy-head-l { display: block; }
  .buy-title { font-size: 16px; }
  .buy-hint { display: block; margin-top: 3px; font-size: 10px; }
  .buy-funds { font-size: 22px; }
  .buy-foot { margin-inline: 14px; font-size: 10px; letter-spacing: .14em; }
}
/* Laptops and Chromebooks (768-800 px tall): the score panel is the same
   one-glance read in less of the view, as on phones and tablets. */
@media (max-height: 820px) and (min-width: 900px) {
  html:not(.touch-device) #hud-top { padding: 4px 24px 5px; }
  html:not(.touch-device) #hud-timer-num { font-size: 24px; }
  html:not(.touch-device) #hud-round { margin-top: 1px; }
}
/* A narrow desktop window (phones get the rotate prompt instead): the radar
   sat on the score panel and the bottom boxes on each other. */
@media (max-width: 520px) {
  html:not(.touch-device) #hud-radar { transform: scale(.62); transform-origin: top left; }
  html:not(.touch-device) #hud-radio { top: 112px; }
  html:not(.touch-device) #hud-top { left: auto; right: 8px; transform: none; }
  html:not(.touch-device) #hud-money { left: 18px; bottom: 80px; }
}
@media (max-width: 480px) {
  #hud-buy-cats { grid-template-columns: 1fr; }
  .buy-title { letter-spacing: .2em; }
  .buy-hint { display: none; }
  .sb-title { letter-spacing: .15em; }
  .sb-team td { font-size: 14px; padding-inline: 6px; }
  .sb-team td.sb-s { font-size: 10px; letter-spacing: .08em; }
}

/* ---------- pause ---------- */
#hud-pause {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(3, 4, 2, 0.6); z-index: 40; pointer-events: auto; cursor: pointer;
  overflow: auto; padding: 16px;
}
.pause-inner { text-align: center; margin: auto; }
#hud-pause.with-panel { background: rgba(3, 4, 2, 0.9); }
.pause-resume {
  display: block; margin: 18px auto 0; min-width: min(280px, 100%); min-height: 44px; padding: 12px 28px 11px;
  font: inherit; font-size: 15px; font-weight: 900; letter-spacing: .28em; text-indent: .28em;
  color: var(--olive-bright); cursor: pointer;
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.28), rgba(154, 178, 107, 0.1));
  border: 1px solid var(--olive);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
}
.pause-resume:hover, .pause-resume:focus-visible {
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.42), rgba(154, 178, 107, 0.18));
}
.pause-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 14px; }
.pause-actions .pause-menu { margin-top: 0; }
#hud-pause-panel { margin: 14px auto 0; width: min(920px, 94vw); text-align: left; cursor: default; }
#hud-pause.with-panel .pause-inner { width: min(960px, 96vw); }
#hud-pause-panel[hidden] { display: none; }
#hud-pause-panel .mn-settings { width: 100%; margin: 0; }
#hud-howto {
  position: absolute; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(3, 4, 2, 0.78); pointer-events: auto; cursor: default;
}
#hud-howto[hidden] { display: none; }
.howto-card {
  width: min(640px, 100%); max-height: 100%; overflow: auto; padding: 18px 20px 20px;
  background: rgba(10, 14, 8, 0.97); border: 1px solid rgba(154, 178, 107, 0.4);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55); color: #dfe8cf;
}
.howto-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.howto-head strong { font-size: 17px; letter-spacing: .26em; color: var(--olive-bright); }
.howto-head button {
  padding: 8px 14px; background: transparent; border: 1px solid rgba(154, 178, 107, 0.45);
  color: var(--olive-bright); font: inherit; font-size: 11px; font-weight: 700; letter-spacing: .2em; cursor: pointer;
}
.howto-body h3 { margin: 16px 0 8px; font-size: 12px; letter-spacing: .24em; color: var(--olive-dim); }
.howto-body ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
.howto-keys { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.howto-keys li { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.howto-keys kbd {
  flex: 0 0 auto; min-width: 64px; padding: 3px 6px; text-align: center; font: inherit; font-size: 11px;
  font-weight: 700; letter-spacing: .08em; color: #eef5df; background: rgba(154, 178, 107, 0.16);
  border: 1px solid rgba(154, 178, 107, 0.4); border-radius: 3px;
}
.howto-modes li { display: grid; gap: 2px; padding: 7px 0; border-top: 1px solid rgba(154, 178, 107, 0.15); font-size: 13px; line-height: 1.4; }
.howto-modes strong { font-size: 12px; letter-spacing: .18em; color: var(--olive-bright); }
.howto-note { margin: 10px 0 0; font-size: 12px; color: var(--olive-dim); }
.pause-main {
  font-size: 30px; font-weight: 800; letter-spacing: .3em; color: var(--olive-bright);
  text-shadow: 0 0 20px rgba(154, 178, 107, 0.4), 0 2px 2px #000;
  animation: hud-blink 1s step-end infinite alternate;
}
.pause-sub { font-size: 11px; letter-spacing: .3em; color: var(--olive-dim); margin-top: 14px; }
.pause-menu, .end-menu-link {
  margin-top: 26px; padding: 9px 18px; background: rgba(8, 11, 6, 0.7);
  border: 1px solid rgba(154, 178, 107, 0.35); color: var(--olive-dim);
  font: inherit; font-size: 11px; font-weight: 700; letter-spacing: .24em; cursor: pointer;
}
.end-menu-link { margin-top: 4px; }
.pause-menu:hover, .end-menu-link:hover, .pause-menu:focus-visible, .end-menu-link:focus-visible {
  color: var(--olive-bright); border-color: var(--olive-bright); outline: none;
}
.pause-menu[data-armed="1"] { color: #f0a070; border-color: #f0a070; }

/* ---------- menu / end screens ---------- */
#hud-menu, #hud-end {
  position: absolute; inset: 0; display: none; flex-direction: column;
  align-items: center; justify-content: center; gap: 20px; z-index: 50;
  background:
    radial-gradient(ellipse at 50% 28%, rgba(46, 58, 26, 0.9) 0%, rgba(16, 21, 10, 0.97) 48%, #04070a 100%),
    #05080a;
  pointer-events: auto; cursor: default;
}
#hud-menu {
  justify-content: flex-start; overflow: auto; gap: clamp(12px, 2vh, 22px);
  padding: clamp(14px, 2vh, 24px) max(18px, env(safe-area-inset-right)) 20px;
  scrollbar-width: thin; scrollbar-color: rgba(154,178,107,.45) rgba(0,0,0,.2);
}
/* Flexible spacers: the short default column sits centered, yet the menu
   still scrolls normally once a section is expanded. */
#hud-menu::before, #hud-menu::after { content: ''; flex: 1 1 0; min-height: 0; }
#hud-menu::after { flex-grow: 1.35; }
#hud-menu button:focus-visible { outline: 2px solid var(--olive-bright); outline-offset: 2px; }
.mn-scan {
  position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background:
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.55) 100%);
}
.mn-top { flex: 0 0 auto; text-align: center; position: relative; }
.mn-op { font-size: 11px; font-weight: 800; letter-spacing: .62em; color: var(--olive); text-indent: .62em; }
.mn-title {
  position: relative;
  font-size: clamp(38px, 6vw, 64px); font-weight: 900; line-height: .98; letter-spacing: .08em;
  color: var(--olive-bright);
  text-shadow: 0 0 38px rgba(154, 178, 107, 0.4), 0 3px 0 rgba(0, 0, 0, 0.9);
}
.mn-title::after {
  content: attr(data-title); position: absolute; inset: 0; pointer-events: none;
  text-shadow: none;
  background: linear-gradient(100deg, transparent 38%, rgba(255, 255, 250, 0.75) 50%, transparent 62%);
  background-size: 260% 100%; background-position: 130% 0;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: mn-sweep 5s ease-in-out infinite;
}
@keyframes mn-sweep {
  0% { background-position: 130% 0; }
  42% { background-position: -130% 0; }
  100% { background-position: -130% 0; }
}
/* ---------- career strip (collapsed by default) ---------- */
.mn-career { position:relative; flex:0 0 auto; width:min(880px,94vw); }
.mn-id {
  width:100%; min-height:46px; display:flex; align-items:center; gap:16px; padding:8px 14px;
  pointer-events:auto; cursor:pointer; font-family:inherit; font-stretch:condensed; text-align:left;
  color:var(--olive); background:rgba(8,12,6,.5); border:1px solid rgba(154,178,107,.24);
  clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);
  transition:border-color .12s, background .12s;
}
.mn-id:hover { border-color:rgba(177,205,124,.5); background:rgba(15,21,10,.6); }
.mn-id-name { min-width:0; flex:0 0 auto; display:flex; flex-direction:column; gap:2px; }
.mn-id-name strong { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:15px; line-height:1; letter-spacing:.07em; color:#eff4e6; }
.mn-id-name span { font-size:10px; font-weight:900; letter-spacing:.14em; color:#d7b86b; white-space:nowrap; }
.mn-xp { flex:1 1 auto; min-width:90px; }
.mn-xp-track,.mn-daily-track,.end-xp > div { display:block; height:5px; overflow:hidden; background:rgba(0,0,0,.45); border:1px solid rgba(154,178,107,.2); }
.mn-xp-track span,.mn-daily-track span,.end-xp > div span { display:block; width:0; height:100%; background:linear-gradient(90deg,#6b9144,#b7d77e); box-shadow:0 0 12px rgba(173,216,105,.42); transition:width .45s ease; }
.mn-xp small { display:block; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:800; letter-spacing:.08em; color:#83965f; }
.mn-id-stats { flex:0 0 auto; display:flex; gap:16px; }
.mn-id-stats > span { min-width:0; }
.mn-id-stats small,.lb-self-card small,.end-reward-grid small { display:block; font-size:10px; font-weight:900; letter-spacing:.13em; color:var(--olive-dim); }
.mn-id-stats b { display:block; margin-top:2px; font-size:13px; letter-spacing:.05em; color:var(--olive-bright); white-space:nowrap; }
.mn-chev { flex:0 0 auto; display:inline-grid; place-items:center; width:18px; height:18px; font-size:15px; font-weight:400; line-height:1; color:var(--olive); transition:transform .15s; }
[aria-expanded="true"] > .mn-chev { transform:rotate(45deg); }
.mn-career-body {
  margin-top:6px; padding:12px 14px 10px; display:grid; grid-template-columns:1.05fr .95fr; gap:6px 24px;
  background:rgba(6,10,5,.6); border:1px solid rgba(154,178,107,.2);
  clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);
}
.mn-career-body[hidden] { display:none; }
.mn-career-board,.mn-daily { min-width:0; }
.mn-career-board header,.mn-daily header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.mn-career-board header > span,.mn-daily header > span { font-size:10.5px; font-weight:900; letter-spacing:.2em; color:#e5ecd9; }
.mn-career-board header small { max-width:70%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:900; letter-spacing:.06em; color:#9ab26b; }
.mn-podium { min-height:52px; margin:6px 0 2px; display:flex; flex-direction:column; justify-content:center; gap:2px; }
.mn-podium > span { min-width:0; display:grid; grid-template-columns:29px minmax(0,1fr) auto; align-items:center; gap:6px; padding:3px 6px; font-size:11px; font-weight:800; color:#cbd7ba; background:rgba(255,255,255,.025); }
.mn-podium > span > b { color:#d7b86b; }
.mn-podium > span > em { font-style:normal; font-variant-numeric:tabular-nums; color:#91a875; }
.mn-daily header b { flex:0 0 auto; font-size:10px; letter-spacing:.1em; color:#d7b86b; }
.mn-daily p { margin-top:6px; font-size:11px; line-height:1.35; color:#aebd9b; }
.mn-daily > strong { display:block; margin-top:5px; font-size:10px; letter-spacing:.07em; color:#e1e9d5; }
.mn-daily-track { margin:6px 0 2px; }
.mn-daily-track span { background:linear-gradient(90deg,#b37638,#e2bd66); }
.mn-career-sync { grid-column:1 / -1; margin-top:4px; font-size:10px; font-weight:800; letter-spacing:.08em; color:#6f8155; }
/* ---------- map picker ---------- */
.mn-map-picker { position:relative; flex:0 0 auto; width:min(880px,94vw); }
.mn-section-head { padding:0 2px 6px; font-size:10px; font-weight:900; letter-spacing:.32em; color:var(--olive-dim); }
.mn-map-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; }
.mn-map {
  appearance: none; min-width: 0; padding: 0; position: relative; overflow: hidden; text-align: left;
  font-family: inherit; color: #fff; cursor: pointer; background: var(--map-c);
  border: 1px solid rgba(255,255,255,.1); transition: transform .12s,border-color .12s,box-shadow .12s,filter .12s;
  clip-path: polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);
  filter: saturate(.72) brightness(.86);
}
.mn-map:hover { transform: translateY(-2px); border-color: var(--map-a); filter: none; box-shadow: 0 8px 20px rgba(0,0,0,.38); }
.mn-map:focus-visible { outline: 2px solid var(--olive-bright); outline-offset: 2px; }
.mn-map.unavailable, .mn-map.unavailable:hover { opacity:.5; filter:grayscale(1); transform:none; box-shadow:none; cursor:not-allowed; }
.mn-map.unavailable[data-unavailable]::after {
  content:attr(data-unavailable); position:absolute; z-index:3; left:0; right:0; top:38%; transform:translateY(-50%);
  padding:4px; font-size:11px; font-weight:900; letter-spacing:.16em; text-align:center; color:#fff; background:rgba(0,0,0,.72);
}
.mn-map.selected { border-color: var(--map-a); filter: none; box-shadow: inset 0 0 0 1px var(--map-a),0 0 20px color-mix(in srgb,var(--map-a) 25%,transparent); }
.mn-map-art {
  display: block; height: 46px; position: relative; overflow: hidden;
  background: radial-gradient(circle at 75% 24%,var(--map-a),transparent 28%),linear-gradient(145deg,var(--map-b),var(--map-c) 70%);
}
.mn-map-art::after { content:''; position:absolute; inset:0; background:linear-gradient(0deg,rgba(0,0,0,.58),transparent 60%),repeating-linear-gradient(115deg,transparent 0 16px,rgba(255,255,255,.035) 17px 18px); }
.mn-map-art i { position:absolute; bottom:-6px; z-index:1; width:44%; height:54%; background:var(--map-c); opacity:.88; transform:skewX(-10deg); box-shadow:0 -1px rgba(255,255,255,.15); }
.mn-map-art i:nth-child(1) { left:-5%; height:38%; }
.mn-map-art i:nth-child(2) { left:30%; height:62%; background:var(--map-b); }
.mn-map-art i:nth-child(3) { right:-8%; height:46%; }
.mn-map-copy { display:flex; flex-wrap:wrap; min-width:0; align-items:baseline; justify-content:space-between; gap:0 6px; padding:6px 8px 7px; }
/* The name wins the space: at 844 px "Frostline" was cut to "Frost…" so its tag could fit.
   A tag that no longer fits beside it wraps under it instead of truncating. */
.mn-map-copy strong { flex:0 0 auto; max-width:100%; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; font-weight:900; letter-spacing:.06em; color:#f0f4e9; }
.mn-map-copy span { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:900; letter-spacing:.1em; text-transform:uppercase; color:var(--map-a); }
.mn-map > b { display:none; position:absolute; right:4px; top:4px; width:15px; height:15px; text-align:center; line-height:15px; background:var(--map-a); color:#101510; font-size:10px; }
.mn-map.selected > b { display:block; }
.mn-mode-picker { position:relative; flex:0 0 auto; width:min(880px,94vw); }
.mn-class-picker { position:relative; flex:0 0 auto; width:min(880px,94vw); }
.mn-class-picker[hidden], .mn-class-editor[hidden] { display:none; }
.mn-rank { flex:1; text-align:center; font-size:10px; letter-spacing:.18em; color:#f7d27a; }
.mn-streak-row { display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap; }
.mn-streak-row span { font-size:10px; font-weight:900; letter-spacing:.22em; color:var(--olive-dim); }
.mn-streak-row select { height:28px; padding:0 6px; font:inherit; font-size:11px; font-weight:900; letter-spacing:.06em;
  color:#eef5e5; background:#080d08; border:1px solid rgba(154,178,107,.38); }
.mn-streak-row select:focus-visible { outline:2px solid var(--olive-bright); outline-offset:1px; }
.mn-streak-row small { flex:1 1 200px; font-size:10px; letter-spacing:.06em; color:var(--olive); }
.sk-row.bonus { border-style:dashed; }
.mn-class-picker .mn-section-head { display:flex; align-items:center; justify-content:space-between; }
#hud-class-edit, #hud-class-reset { appearance:none; font:inherit; font-size:10px; font-weight:900; letter-spacing:.2em; padding:3px 9px;
  color:var(--olive-bright); background:transparent; border:1px solid rgba(154,178,107,.35); cursor:pointer; }
#hud-class-edit:focus-visible, #hud-class-reset:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }
.mn-class-row { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; }
.mn-class { appearance:none; position:relative; display:flex; flex-direction:column; gap:2px; min-width:0; padding:7px 9px 8px;
  font-family:inherit; text-align:left; cursor:pointer; color:#dfe8d2; background:rgba(8,13,8,.72);
  border:1px solid rgba(154,178,107,.22); clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px); }
.mn-class small { position:absolute; right:7px; top:5px; font-size:10px; font-weight:900; color:var(--olive-dim); }
.mn-class strong { font-size:11.5px; font-weight:900; letter-spacing:.08em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right:12px; }
.mn-class span, .mn-class em { font-size:10px; font-weight:900; letter-spacing:.08em; font-style:normal; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--olive-dim); }
.mn-class em { color:var(--olive); }
.mn-class .mn-class-lock { position:static; font-size:10px; letter-spacing:.08em; line-height:1.3; white-space:normal; color:var(--olive-dim); }
.mn-class:hover { border-color:var(--olive); }
.mn-class:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }
.mn-class.selected { border-color:var(--olive-bright); background:rgba(154,178,107,.16); box-shadow:inset 0 0 0 1px var(--olive); }
.mn-class-editor { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; align-items:start; margin-top:8px; padding:9px;
  background:rgba(8,13,8,.72); border:1px solid rgba(154,178,107,.22); }
.mn-class-editor label { display:flex; flex-direction:column; gap:4px; font-size:10px; font-weight:900; letter-spacing:.18em; color:var(--olive-dim); }
.mn-class-editor input, .mn-class-editor select { min-width:0; height:30px; padding:0 6px; font:inherit; font-size:12px; font-weight:900;
  letter-spacing:.06em; color:#eef5e5; background:#080d08; border:1px solid rgba(154,178,107,.38); }
.mn-class-editor input:focus-visible, .mn-class-editor select:focus-visible { outline:2px solid var(--olive-bright); outline-offset:1px; }
#hud-class-perk-detail { grid-column:1 / span 3; margin:0; align-self:center; font-size:10px; letter-spacing:.08em; line-height:1.4; color:var(--olive); }
#hud-class-reset { justify-self:end; align-self:center; }
.mn-mode-row { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px 8px; }
.mn-mode {
  appearance:none; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:3px;
  min-width:0; min-height:52px; padding:8px 12px 9px; font-family:inherit; text-align:left; cursor:pointer; color:#dfe8d2;
  background:rgba(8,13,8,.72); border:1px solid rgba(154,178,107,.22);
  clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);
  transition:border-color .12s,background .12s;
}
.mn-mode strong { max-width:100%; font-size:12.5px; font-weight:900; letter-spacing:.1em; line-height:1.15; }
.mn-mode span {
  max-width:100%; font-size:10px; font-weight:800; letter-spacing:.08em; line-height:1.3; color:var(--olive-dim);
}
.mn-mode:hover { border-color:var(--olive); }
.mn-mode:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }
.mn-mode.selected {
  border-color:var(--olive-bright); background:rgba(154,178,107,.16);
  box-shadow:inset 3px 0 0 var(--olive-bright), inset 0 0 0 1px var(--olive);
}
.mn-mode.selected span { color:var(--olive-bright); }
.mn-sub-head { margin-top:8px; }
.mn-skill-row { grid-template-columns:repeat(3,minmax(0,1fr)); }
/* Below this the three-up cards crush "SEARCH & DESTROY" and the rule line. */
@media (max-width: 760px) {
  .mn-mode-row { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .mn-skill-row { grid-template-columns:repeat(3,minmax(0,1fr)); }
}
/* ---------- primary action + quiet secondary row ---------- */
.mn-actions,.end-actions { position:relative; display:flex; align-items:stretch; justify-content:center; gap:10px; }
#hud-start, #hud-restart, #hud-end-leaderboard {
  pointer-events: auto; cursor: pointer; position: relative;
  font-family: inherit; font-stretch: condensed;
  color: var(--olive-bright);
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.2), rgba(154, 178, 107, 0.07));
  border: 1px solid var(--olive); padding: 11px 34px 10px; min-width: 244px;
  text-shadow: 0 1px 2px #000;
  clip-path: polygon(11px 0, 100% 0, 100% calc(100% - 11px), calc(100% - 11px) 100%, 0 100%, 0 11px);
  box-shadow: inset 0 1px 0 rgba(214, 229, 184, 0.25), inset 0 0 0 1px rgba(154, 178, 107, 0.12);
  transition: background .12s, box-shadow .12s, transform .06s;
}
#hud-menu #hud-start { min-width: 320px; padding: 13px 44px 12px; }
#hud-start .btn-main, #hud-restart .btn-main, #hud-end-leaderboard .btn-main {
  display: block; font-size: 16px; font-weight: 900; letter-spacing: .27em; text-indent: .27em;
}
#hud-menu #hud-start .btn-main { font-size: 18px; }
#hud-start .btn-sub, #hud-restart .btn-sub, #hud-end-leaderboard .btn-sub {
  display: block; margin-top: 4px; font-size: 10px; font-weight: 700;
  letter-spacing: .44em; text-indent: .44em; color: var(--olive);
}
#hud-start:hover, #hud-restart:hover, #hud-end-leaderboard:hover {
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.36), rgba(154, 178, 107, 0.14));
  box-shadow:
    inset 0 1px 0 rgba(214, 229, 184, 0.35), inset 0 0 22px rgba(154, 178, 107, 0.28),
    inset 0 0 0 1px rgba(154, 178, 107, 0.25);
}
#hud-start:active, #hud-restart:active, #hud-end-leaderboard:active {
  transform: translateY(1px);
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.42), rgba(154, 178, 107, 0.2));
}
.mn-quick { position:relative; display:flex; flex-wrap:wrap; align-items:stretch; justify-content:center; gap:8px; }
/* Short screens (phones in landscape): PLAY stays in reach while the
   picker rows scroll underneath it. */
@media (max-height: 560px) {
  #hud-menu .mn-actions {
    position:sticky; bottom:0; z-index:4; padding:8px 0 4px; width:100%;
    background:#060904; box-shadow:0 -10px 14px rgba(5,8,4,.85);
  }
  #hud-menu #hud-start { padding:7px 28px 6px; }
  #hud-menu #hud-start .btn-main { font-size:15px; }
}
.mn-quick > button {
  pointer-events:auto; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:7px;
  min-height:34px; padding:7px 18px; font-family:inherit; font-stretch:condensed;
  font-size:10.5px; font-weight:900; letter-spacing:.18em; color:var(--olive);
  background:rgba(8,12,6,.35); border:1px solid rgba(154,178,107,.26);
  clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px);
  transition:color .12s,border-color .12s,background .12s;
}
.mn-quick > button:hover,.mn-quick > button.open {
  color:var(--olive-bright); border-color:rgba(177,205,124,.55); background:rgba(154,178,107,.13);
}
.mn-quick .mn-chev { width:auto; height:auto; font-size:13px; color:inherit; }
.mn-sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
/* ---------- collapsed sections ---------- */
#hud-menu:not(.mn-online-open) #mp-panel { display:none; }
.mn-weapon-progress { display:block; margin-top:2px; font-size:10px; font-weight:800; letter-spacing:.06em; line-height:1.35; color:var(--olive); }
#hud-menu.mn-room-guest [aria-disabled="true"] { pointer-events:none; opacity:.55; }
#hud-menu.mn-room-guest #hud-map-picker::before { content:'HOST PICKS'; display:block; margin-bottom:4px; font-size:10px;
  font-weight:900; letter-spacing:.22em; color:var(--olive); }
.mn-settings {
  position:relative; flex:0 0 auto; width:min(920px,92vw); display:grid; gap:12px; padding:14px 16px;
  background: linear-gradient(180deg, rgba(10, 13, 6, 0.55), rgba(4, 6, 2, 0.65));
  border: 1px solid rgba(154, 178, 107, 0.22);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.07);
}
.mn-settings[hidden] { display:none!important; }
.mn-settings-title,.mn-bindings-head,.mn-setting > span,.mn-settings-foot {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
}
.mn-settings-title { padding-bottom:8px; border-bottom:1px solid rgba(154,178,107,.18); }
.mn-settings-title strong,.mn-bindings-head strong {
  font-size:11px; font-weight:900; letter-spacing:.2em; color:#e3edd2;
}
.mn-settings-title span,.mn-bindings-head span {
  font-size:10px; font-weight:800; letter-spacing:.14em; color:var(--olive-dim);
}
.mn-settings-groups { display:grid; gap:14px; }
.mn-settings-group { min-width:0; display:grid; gap:8px; align-content:start; }
.mn-settings-group h3 { font-size:10px; font-weight:900; letter-spacing:.28em; color:var(--olive-dim); }
.mn-settings-tuning { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.mn-setting-wide { grid-column:1 / -1; }
.mn-setting {
  min-width:0; display:grid; gap:8px; padding:10px 12px;
  background:rgba(0,0,0,.22); border:1px solid rgba(154,178,107,.16);
}
.mn-setting strong { font-size:10px; letter-spacing:.14em; color:var(--olive); }
.mn-setting output { font-size:10px; font-weight:900; letter-spacing:.08em; color:var(--olive-bright); }
.mn-setting-note { font-size:10px; font-weight:800; letter-spacing:.12em; color:var(--olive-dim); }
.mn-setting input[type="range"] {
  width:100%; height:20px; cursor:pointer; accent-color:#a9c87b; background:transparent;
}
.mn-setting input[type="range"]:focus-visible { outline:2px solid var(--olive-bright); outline-offset:3px; }
.mn-setting select {
  pointer-events:auto; height:26px; padding:0 6px; cursor:pointer; font:inherit; font-size:10px; font-weight:900;
  letter-spacing:.1em; color:#eef5e5; background:#080d08; border:1px solid rgba(154,178,107,.38);
}
.mn-setting select:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }
.mn-setting input[type="checkbox"] { width:18px; height:18px; cursor:pointer; accent-color:#a9c87b; }
.mn-bindings-section { display:grid; gap:7px; }
.mn-bindings { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }
.mn-binding {
  pointer-events:auto; min-width:0; min-height:38px; display:flex; align-items:center; justify-content:space-between; gap:7px;
  padding:5px 6px 5px 9px; cursor:pointer; font-family:inherit; color:var(--olive);
  background:rgba(7,11,5,.64); border:1px solid rgba(154,178,107,.2);
}
.mn-binding:hover,.mn-binding.capturing { color:#f0f6e6; border-color:rgba(190,222,134,.62); background:rgba(114,143,68,.2); }
.mn-binding:focus-visible,#hud-settings-reset:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }
.mn-binding span {
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:10px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; text-align:left;
}
.mn-binding kbd { flex:0 0 auto; min-width:43px; padding:2px 5px!important; font-size:10px!important; }
.mn-binding.capturing kbd { min-width:70px; color:#fff; }
.mn-settings-foot { flex-wrap:wrap; min-height:30px; padding-top:2px; }
/* Touch wording lives beside the desktop wording; touch-controls.js swaps them. */
.mn-note-touch { display:none; }
.mn-settings-mouse {
  flex:1 1 330px; font-size:10px; font-weight:800; letter-spacing:.1em; color:var(--olive-dim);
}
#hud-settings-reset[data-armed="1"] { color:#f0a070!important; border-color:#f0a070!important; }
#hud-settings-reset {
  pointer-events:auto; min-height:30px; padding:5px 10px; cursor:pointer; font-family:inherit;
  font-size:10px; font-weight:900; letter-spacing:.12em; color:var(--olive);
  border:1px solid rgba(154,178,107,.25); background:rgba(0,0,0,.25);
}
#hud-settings-reset:hover { color:var(--olive-bright); border-color:rgba(190,222,134,.55); }
#hud-settings-status {
  flex:1 0 100%; min-height:11px; font-size:10px; font-weight:900; letter-spacing:.1em; color:#c9dca8;
}
html.touch-device .mn-quick > button { min-height:48px; }
html.touch-device .mn-id { min-height:52px; }

/* ---------- global leaderboard ---------- */
#hud-leaderboard {
  position:absolute; inset:0; z-index:80; display:none; align-items:center; justify-content:center;
  padding:clamp(24px,4vw,64px); pointer-events:auto; cursor:default;
  background:radial-gradient(circle at 50% 12%,rgba(76,101,43,.28),rgba(2,4,3,.92) 58%);
  backdrop-filter:blur(12px);
}
.lb-panel {
  position:relative; width:min(1180px,100%); height:min(760px,100%); min-height:min(560px,100%);
  display:flex; flex-direction:column; overflow:hidden; color:var(--olive-bright);
  background:linear-gradient(145deg,rgba(21,28,15,.98),rgba(4,7,5,.985));
  border:1px solid rgba(178,207,124,.44); box-shadow:0 25px 100px rgba(0,0,0,.66),inset 0 1px rgba(255,255,255,.08);
  clip-path:polygon(15px 0,100% 0,100% calc(100% - 15px),calc(100% - 15px) 100%,0 100%,0 15px);
}
.lb-accent { flex:0 0 auto; height:3px; background:linear-gradient(90deg,#657c43,#d6e5b8 44%,#d98a4a); box-shadow:0 0 18px rgba(192,220,139,.5); }
.lb-top { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; padding:22px 30px 18px; border-bottom:1px solid rgba(154,178,107,.17); }
.lb-top small { display:block; margin-bottom:4px; font-size:10px; font-weight:900; letter-spacing:.38em; color:var(--olive-dim); }
.lb-top h2 { font-size:38px; line-height:1; font-weight:900; letter-spacing:.18em; color:#edf4df; }
#hud-leaderboard-close { width:46px; height:46px; cursor:pointer; font-family:inherit; font-size:34px; font-weight:300; line-height:1; color:var(--olive); border:1px solid rgba(154,178,107,.26); background:rgba(0,0,0,.2); }
#hud-leaderboard-close:hover { color:#fff; border-color:var(--olive); background:rgba(154,178,107,.13); }
.lb-toolbar { flex:0 0 auto; display:grid; grid-template-columns:minmax(320px,1fr) auto auto; gap:18px; align-items:center; padding:16px 30px; background:rgba(0,0,0,.2); }
.lb-identity { min-width:0; min-height:50px; display:flex; align-items:center; gap:12px; }
.lb-avatar { --profile-swatch:#71845a; position:relative; flex:0 0 46px; height:46px; overflow:hidden; border:1px solid color-mix(in srgb,var(--profile-swatch) 65%,#9ab26b); background:linear-gradient(145deg,color-mix(in srgb,var(--profile-swatch) 45%,#172011),rgba(18,25,15,.88)); }
.lb-avatar::before { content:''; position:absolute; left:50%; top:8px; width:13px; height:13px; border-radius:50%; transform:translateX(-50%); background:#b9c7a2; }
.lb-avatar i { position:absolute; left:9px; right:9px; bottom:-8px; height:27px; border-radius:15px 15px 0 0; background:var(--profile-swatch); box-shadow:inset 0 7px rgba(255,255,255,.08); }
.lb-identity-copy { min-width:0; display:flex; flex-direction:column; line-height:1.05; }
.lb-identity-copy small { margin-bottom:4px; font-size:10px; font-weight:900; letter-spacing:.25em; color:var(--olive-dim); }
#hud-leaderboard-name { min-width:0; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:20px; font-weight:900; letter-spacing:.08em; color:#f0f5e7; }
#hud-leaderboard-character { margin-top:4px; font-size:10px; font-weight:900; letter-spacing:.2em; color:var(--olive); }
.lb-profile-edit { flex:0 0 auto; margin-left:5px; height:38px; padding:0 13px; cursor:pointer; font-family:inherit; font-size:11px; font-weight:900; letter-spacing:.12em; color:var(--olive-bright); border:1px solid rgba(154,178,107,.35); background:rgba(154,178,107,.08); }
.lb-profile-edit:hover { border-color:var(--olive); background:rgba(154,178,107,.18); }
.lb-tabs { display:flex; height:48px; border:1px solid rgba(154,178,107,.3); }
.lb-tabs button,#hud-leaderboard-refresh { cursor:pointer; font-family:inherit; font-size:14px; font-weight:900; letter-spacing:.13em; color:var(--olive-dim); background:rgba(6,10,6,.8); border:0; }
.lb-tabs button { min-width:104px; padding:0 17px; border-right:1px solid rgba(154,178,107,.18); }
.lb-tabs button:last-child { border-right:0; }
.lb-tabs button:hover { color:var(--olive-bright); background:rgba(154,178,107,.1); }
.lb-tabs button.active { color:#eef5df; background:linear-gradient(180deg,rgba(120,151,72,.72),rgba(67,88,39,.8)); box-shadow:inset 0 0 0 1px rgba(210,233,174,.19); }
#hud-leaderboard-refresh { height:48px; padding:0 18px; border:1px solid rgba(154,178,107,.28); }
#hud-leaderboard-refresh:hover { color:var(--olive-bright); border-color:var(--olive); }
.lb-meta { flex:0 0 auto; display:flex; gap:24px; padding:12px 30px; font-size:13px; font-weight:900; letter-spacing:.14em; color:#9aab7d; border-top:1px solid rgba(255,255,255,.025); border-bottom:1px solid rgba(154,178,107,.13); }
.lb-self-card { flex:0 0 auto; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; margin:0 30px 12px; border:1px solid rgba(189,220,132,.45); background:rgba(111,145,63,.09); box-shadow:inset 4px 0 #a8cd6f; }
.lb-self-card > span { min-width:0; padding:10px 14px; border-left:1px solid rgba(154,178,107,.13); }
.lb-self-card > span:first-child { border-left:0; }
.lb-self-card strong { display:block; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:19px; letter-spacing:.05em; color:#eff6e4; }
#hud-leaderboard-body { flex:1 1 auto; min-height:0; overflow:auto; padding:0 28px 12px; scrollbar-width:thin; scrollbar-color:rgba(154,178,107,.4) rgba(0,0,0,.22); }
.lb-row { display:grid; grid-template-columns:90px minmax(190px,1fr) 145px 100px 100px 100px; align-items:center; min-width:820px; min-height:56px; padding:0 16px; border-bottom:1px solid rgba(154,178,107,.09); font-size:18px; font-weight:800; color:#cbd8b8; font-variant-numeric:tabular-nums; }
.lb-row:nth-child(odd):not(.lb-head) { background:rgba(255,255,255,.018); }
.lb-row:not(.lb-head):hover { background:rgba(154,178,107,.08); }
.lb-row.self { position:relative; background:linear-gradient(90deg,rgba(130,173,76,.23),rgba(130,173,76,.07))!important; box-shadow:inset 4px 0 #b9df7c,inset 0 0 0 1px rgba(185,223,124,.25); color:#eef7df; }
.lb-row.pinned-self { margin-top:8px; border-top:1px solid rgba(185,223,124,.45); }
.lb-you { display:inline-block; margin-left:9px; padding:2px 5px; vertical-align:2px; font-size:10px; letter-spacing:.12em; color:#14200e; background:#b9df7c; }
.lb-career { display:block; margin-top:2px; font-size:10px; letter-spacing:.1em; color:#819765; }
.lb-head { position:sticky; top:0; z-index:2; min-height:44px; background:#0b1009; color:var(--olive-dim); font-size:12px; letter-spacing:.16em; }
.lb-player { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:16px; color:#edf3e3; font-size:20px; letter-spacing:.04em; }
.lb-score { color:var(--money); font-size:20px; }
.lb-rank { color:var(--olive-dim); }
.lb-rank b { display:inline-block; width:23px; color:var(--olive); text-shadow:0 0 8px currentColor; }
.lb-row.rank-1 { background:linear-gradient(90deg,rgba(214,190,87,.13),transparent 65%); }
.lb-row.rank-1 .lb-rank,.lb-row.rank-1 .lb-player { color:#f2d77b; }
.lb-row.rank-2 .lb-rank { color:#c7d6d9; }
.lb-row.rank-3 .lb-rank { color:#d98a4a; }
.lb-state { min-height:330px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; text-align:center; }
.lb-state-mark { width:30px; height:30px; border:2px solid rgba(154,178,107,.2); border-top-color:var(--olive); border-radius:50%; }
.lb-state.loading .lb-state-mark { animation:lb-spin .85s linear infinite; }
.lb-state.error .lb-state-mark { border:0; border-radius:0; transform:rotate(45deg); background:#9a3d31; box-shadow:0 0 18px rgba(210,70,50,.35); }
.lb-state.empty .lb-state-mark { width:auto; height:auto; border:0; border-radius:0; color:var(--olive); font-size:28px; }
.lb-state strong { font-size:15px; letter-spacing:.2em; color:var(--olive); max-width:620px; }
.lb-state.error strong { color:#d77b69; }
.lb-state small { font-size:11px; letter-spacing:.17em; color:var(--olive-dim); }
@keyframes lb-spin { to { transform:rotate(360deg); } }
.lb-dossier { flex:0 0 auto; border-top:1px solid rgba(191,218,137,.24); background:linear-gradient(90deg,rgba(117,151,69,.1),rgba(0,0,0,.08)); }
.lb-dossier > summary { min-height:50px; display:flex; align-items:center; gap:14px; padding:7px 30px; cursor:pointer; list-style:none; }
.lb-dossier > summary::-webkit-details-marker { display:none; }
.lb-dossier > summary > span { min-width:0; display:flex; flex-direction:column; gap:3px; }
.lb-dossier > summary strong { font-size:14px; letter-spacing:.16em; color:#e4edda; }
.lb-dossier > summary small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:900; letter-spacing:.08em; color:#d7b86b; }
.lb-dossier > summary b { margin-left:auto; font-size:22px; font-weight:400; color:var(--olive); transition:transform .15s; }
.lb-dossier[open] > summary b { transform:rotate(45deg); }
.lb-dossier > summary:hover { background:rgba(154,178,107,.07); }
.lb-dossier[open] { max-height:min(310px,44vh); overflow:auto; scrollbar-width:thin; scrollbar-color:rgba(154,178,107,.4) rgba(0,0,0,.22); }
.lb-dossier-body { display:grid; grid-template-columns:1.05fr .95fr; gap:18px; padding:0 30px 16px; }
.lb-dossier-body section { min-width:0; }
.lb-dossier-body header { margin-bottom:7px; font-size:10px; font-weight:900; letter-spacing:.18em; color:var(--olive-dim); }
.lb-record-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }
.lb-record-grid > span { min-width:0; padding:8px 9px; border:1px solid rgba(154,178,107,.16); background:rgba(0,0,0,.2); }
.lb-record-grid small,.lb-record-grid strong,.lb-record-grid em { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lb-record-grid small { font-size:10px; font-weight:900; letter-spacing:.08em; color:#879b69; }
.lb-record-grid strong { margin-top:3px; font-size:18px; letter-spacing:.04em; color:#edf4df; }
.lb-record-grid em { margin-top:2px; font-size:10px; font-style:normal; letter-spacing:.07em; color:#73835f; }
.lb-badge-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
.lb-badge-grid > span { min-width:0; display:grid; grid-template-columns:28px minmax(0,1fr); align-items:center; gap:8px; min-height:54px; padding:7px 9px; border:1px solid rgba(208,226,171,.19); background:rgba(107,139,64,.09); }
.lb-badge-grid > span > b { display:grid; place-items:center; width:27px; height:27px; color:#e2c46e; border:1px solid rgba(226,196,110,.38); }
.lb-badge-grid strong,.lb-badge-grid small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lb-badge-grid strong { font-size:11px; letter-spacing:.08em; color:#e4ecd9; }
.lb-badge-grid small { margin-top:3px; font-size:10px; color:#91a17e; }
.lb-badge-grid p { grid-column:1 / -1; margin:0; padding:17px; text-align:center; font-size:10px; font-weight:900; letter-spacing:.1em; color:#83966a; border:1px dashed rgba(154,178,107,.2); }
.lb-scoring { flex:0 0 auto; border-top:1px solid rgba(154,178,107,.15); background:rgba(154,178,107,.045); }
.lb-scoring summary { min-height:46px; display:flex; align-items:center; gap:14px; padding:0 30px; cursor:pointer; list-style:none; color:var(--olive); }
.lb-scoring summary::-webkit-details-marker { display:none; }
.lb-scoring summary strong { font-size:14px; letter-spacing:.16em; color:var(--money); }
.lb-scoring summary span { font-size:12px; font-weight:800; letter-spacing:.13em; color:var(--olive-dim); }
.lb-scoring summary b { margin-left:auto; font-size:22px; font-weight:400; transition:transform .15s; }
.lb-scoring[open] summary b { transform:rotate(45deg); }
.lb-scoring summary:hover { color:var(--olive-bright); background:rgba(154,178,107,.06); }
#hud-leaderboard-rules { padding:2px 30px 15px; max-width:1000px; font-size:15px; font-weight:650; line-height:1.55; letter-spacing:.025em; color:#bdcbaa; }
.lb-foot { flex:0 0 auto; display:flex; justify-content:space-between; padding:11px 30px 13px; border-top:1px solid rgba(154,178,107,.13); font-size:12px; font-weight:900; letter-spacing:.15em; color:#8fa073; }

/* ---------- profile editor ---------- */
#hud-profile {
  position:absolute; inset:0; z-index:90; display:none; align-items:center; justify-content:center;
  padding:clamp(24px,5vw,72px); pointer-events:auto; cursor:default;
  background:radial-gradient(circle at 50% 18%,rgba(83,105,55,.28),rgba(2,4,3,.94) 62%);
  backdrop-filter:blur(14px);
}
.profile-panel {
  position:relative; width:min(860px,100%); max-height:100%; overflow:auto; color:var(--olive-bright);
  background:linear-gradient(145deg,rgba(22,29,16,.99),rgba(4,7,5,.99));
  border:1px solid rgba(178,207,124,.48); box-shadow:0 28px 100px rgba(0,0,0,.72),inset 0 1px rgba(255,255,255,.08);
  clip-path:polygon(15px 0,100% 0,100% calc(100% - 15px),calc(100% - 15px) 100%,0 100%,0 15px);
}
.profile-accent { height:4px; background:linear-gradient(90deg,#657c43,#d6e5b8 47%,#d98a4a); }
.profile-top { display:flex; align-items:center; justify-content:space-between; padding:24px 30px 20px; border-bottom:1px solid rgba(154,178,107,.18); }
.profile-top small { display:block; margin-bottom:5px; font-size:10px; font-weight:900; letter-spacing:.34em; color:var(--olive-dim); }
.profile-top h2 { font-size:30px; line-height:1; font-weight:900; letter-spacing:.17em; color:#eef5e4; }
#hud-profile-close { width:46px; height:46px; cursor:pointer; font-family:inherit; font-size:34px; font-weight:300; line-height:1; color:var(--olive); border:1px solid rgba(154,178,107,.3); background:rgba(0,0,0,.22); }
#hud-profile-close:hover { color:#fff; border-color:var(--olive); background:rgba(154,178,107,.13); }
#hud-profile-form { padding:22px 30px 28px; }
.profile-name { display:block; }
.profile-name > span, #hud-profile-form legend { display:block; margin-bottom:8px; font-size:12px; font-weight:900; letter-spacing:.22em; color:var(--olive); }
#hud-profile-name { width:100%; height:52px; padding:0 16px; font-family:inherit; font-size:18px; font-weight:900; letter-spacing:.08em; color:#f3f7ec; background:#080d08; border:1px solid rgba(154,178,107,.38); outline:none; }
#hud-profile-name:focus-visible { outline:2px solid var(--olive, #9ab26b); outline-offset:2px; }
#hud-profile-name:focus { border-color:var(--olive-bright); box-shadow:0 0 0 3px rgba(154,178,107,.14); }
.profile-name > small { display:block; margin-top:7px; font-size:12px; letter-spacing:.04em; color:#93a27e; }
#hud-profile-form fieldset { min-width:0; margin:24px 0 0; padding:0; border:0; }
.profile-characters { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
.profile-character { position:relative; min-width:0; min-height:174px; padding:13px 12px 12px; overflow:hidden; cursor:pointer; text-align:left; font-family:inherit; color:#d7e1c7; background:linear-gradient(160deg,color-mix(in srgb,var(--profile-swatch) 22%,#10160d),#070a06 78%); border:1px solid rgba(154,178,107,.24); transition:transform .12s,border-color .12s,box-shadow .12s; }
.profile-character:hover { transform:translateY(-2px); border-color:var(--profile-swatch); box-shadow:0 10px 25px rgba(0,0,0,.32); }
.profile-character:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }
.profile-character.selected { border-color:var(--profile-swatch); box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--profile-swatch) 60%,transparent),0 0 22px color-mix(in srgb,var(--profile-swatch) 24%,transparent); }
.profile-portrait { position:relative; display:block; width:74px; height:82px; margin:0 auto 10px; overflow:hidden; background:radial-gradient(circle at 50% 35%,color-mix(in srgb,var(--profile-swatch) 60%,#dae5cc),transparent 36%); }
.profile-portrait::before { content:''; position:absolute; z-index:2; left:50%; top:9px; width:25px; height:29px; border-radius:48% 48% 43% 43%; transform:translateX(-50%); background:#b8a184; box-shadow:inset 0 8px var(--profile-swatch); }
.profile-portrait i { position:absolute; left:9px; right:9px; bottom:-8px; height:53px; border-radius:24px 24px 4px 4px; background:var(--profile-swatch); box-shadow:inset 0 12px rgba(255,255,255,.07); }
.profile-portrait::after { content:''; position:absolute; z-index:3; left:22px; right:22px; bottom:4px; height:31px; border:5px solid rgba(20,27,18,.55); border-top-width:9px; }
.profile-character-copy { display:block; min-width:0; }
.profile-character-copy strong,.profile-character-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.profile-character-copy strong { font-size:16px; font-weight:900; letter-spacing:.1em; color:#eef4e4; }
.profile-character-copy small { margin-top:5px; font-size:11px; font-weight:650; letter-spacing:.035em; color:#9dab88; }
.profile-character > b { display:none; position:absolute; right:8px; top:8px; padding:4px 6px; font-size:10px; letter-spacing:.14em; color:#0a0e08; background:var(--profile-swatch); }
.profile-character.selected > b { display:block; }
/* In a card under ~200 px (a phone, a short window) "SELECTED" covered the
   portrait's head: it shrinks to a tick, still read out as SELECTED. */
.profile-character { container-type:inline-size; }
@container (max-width: 200px) {
  .profile-character > b { right:6px; top:6px; width:22px; height:18px; padding:0; overflow:hidden; white-space:nowrap; color:transparent; }
  .profile-character > b::before { content:'✓'; display:block; text-align:center; line-height:18px; font-size:12px; font-weight:900; letter-spacing:0; color:#0a0e08; }
}
.profile-note { display:flex; align-items:center; gap:14px; margin-top:22px; padding:13px 15px; background:rgba(154,178,107,.06); border-left:3px solid var(--olive); }
.profile-note strong { flex:0 0 auto; font-size:11px; letter-spacing:.16em; color:var(--money); }
.profile-note span { font-size:13px; color:#b9c6a7; }
.profile-progress { margin-top:12px; border:1px solid rgba(154,178,107,.24); background:rgba(0,0,0,.18); }
.profile-progress summary { min-height:48px; display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:12px; padding:10px 14px; cursor:pointer; list-style:none; }
.profile-progress summary::-webkit-details-marker { display:none; }
.profile-progress summary strong { font-size:11px; letter-spacing:.14em; color:#e8f0dc; }
.profile-progress summary span { font-size:10px; letter-spacing:.08em; color:#879b69; }
.profile-progress summary b { font-size:19px; color:var(--olive); transition:transform .15s; }
.profile-progress[open] summary b { transform:rotate(45deg); }
.profile-progress-body { padding:0 14px 13px; }
.profile-progress-body p { font-size:11px; line-height:1.4; color:#aeba9d; }
.profile-progress-actions { display:grid; grid-template-columns:auto minmax(180px,1fr) auto; gap:8px; margin-top:9px; }
.profile-progress-actions button,.profile-progress-actions input { min-height:44px; font-family:inherit; border:1px solid rgba(154,178,107,.38); }
.profile-progress-actions button { padding:0 13px; cursor:pointer; font-size:10px; font-weight:900; letter-spacing:.09em; color:#dce9c9; background:rgba(97,127,56,.27); }
.profile-progress-actions input { min-width:0; padding:0 12px; font-size:13px; color:#eef5e5; background:rgba(0,0,0,.34); outline:none; }
.profile-progress-actions input:focus-visible { outline:2px solid var(--olive, #9ab26b); outline-offset:1px; }
.profile-progress-actions input:focus { border-color:var(--olive-bright); }
.profile-new-career { display:flex; align-items:center; gap:12px; margin-top:12px; padding-top:11px; border-top:1px solid rgba(154,178,107,.13); }
.profile-new-career > span { min-width:0; flex:1; }
.profile-new-career strong,.profile-new-career small { display:block; }
.profile-new-career strong { font-size:10px; letter-spacing:.14em; color:#c4cfb4; }
.profile-new-career small { margin-top:3px; font-size:10px; color:#829070; }
.profile-new-career button { flex:0 0 auto; min-height:40px; padding:0 13px; cursor:pointer; font-family:inherit; font-size:10px; font-weight:900; letter-spacing:.09em; color:#d7a391; border:1px solid rgba(204,105,78,.42); background:rgba(109,39,28,.18); }
.profile-new-career.recovery { margin-inline:-7px; padding:11px 7px 0; border-top-color:#d98a4a; background:linear-gradient(90deg,rgba(217,138,74,.1),transparent); }
.profile-new-career.recovery strong,.profile-new-career.recovery button { color:#f0bb86; }
.profile-new-confirm { display:none; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:8px; margin-top:9px; padding:10px; border:1px solid rgba(214,109,80,.48); background:rgba(65,19,13,.42); }
.profile-new-confirm[hidden] { display:none!important; }
.profile-new-confirm > span { min-width:0; }
.profile-new-confirm strong,.profile-new-confirm small { display:block; }
.profile-new-confirm strong { font-size:10px; letter-spacing:.08em; color:#f0b09d; }
.profile-new-confirm small { margin-top:3px; font-size:10px; line-height:1.3; color:#b69a90; }
.profile-new-confirm button { min-height:38px; padding:0 10px; cursor:pointer; font-family:inherit; font-size:10px; font-weight:900; letter-spacing:.06em; color:#d5dfc8; border:1px solid rgba(154,178,107,.3); background:rgba(0,0,0,.28); }
#hud-progress-new-commit { color:#ffe4d8; border-color:#cc6c51; background:rgba(132,51,32,.52); }
#hud-progress-new-commit:disabled { cursor:wait; opacity:.55; }
#hud-progress-status { display:block; min-height:14px; margin-top:8px; font-size:10px; font-weight:900; letter-spacing:.09em; color:#8fa573; }
.profile-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:22px; padding-top:20px; border-top:1px solid rgba(154,178,107,.16); }
/* Pinned to the panel's foot: at 1366x768 SAVE PROFILE sat half under the
   bottom edge until the panel was scrolled. The side shadows cover the form's
   padding so nothing shows through at the edges. */
.profile-actions { position:sticky; bottom:0; z-index:2; padding-bottom:14px; background:#090d07; box-shadow:-30px 0 #090d07,30px 0 #090d07; }
.profile-actions button { min-width:154px; height:46px; cursor:pointer; font-family:inherit; font-size:13px; font-weight:900; letter-spacing:.15em; color:var(--olive); border:1px solid rgba(154,178,107,.35); background:rgba(0,0,0,.22); }
.profile-actions .profile-save { color:#eff5e4; border-color:var(--olive); background:linear-gradient(180deg,rgba(116,148,71,.7),rgba(59,79,36,.78)); }
.profile-actions button:hover { color:#fff; border-color:var(--olive-bright); filter:brightness(1.12); }
#hud-profile button:focus-visible,#hud-leaderboard button:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }

/* Short windows: the end card scrolls instead of clipping its buttons. */
#hud-end { overflow-y: auto; justify-content: flex-start; }
#hud-end .end-inner { margin: auto 0; flex-shrink: 0; }
.end-inner {
  position: relative; text-align: center; display: flex; flex-direction: column; align-items: center;
  gap: 18px; padding: 40px 70px 36px;
  background: linear-gradient(180deg, rgba(14, 18, 8, 0.6), rgba(4, 6, 2, 0.75));
  border: 1px solid rgba(154, 178, 107, 0.25);
  clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.08), inset 0 0 40px rgba(0, 0, 0, 0.4);
}
#hud-end-title {
  font-size: clamp(38px, 6vw, 62px); font-weight: 900; letter-spacing: .16em;
  color: var(--olive-bright); text-shadow: 0 0 32px rgba(154, 178, 107, 0.45), 0 2px 0 #000;
}
#hud-end-title.lost { color: #d4562c; text-shadow: 0 0 32px rgba(210, 60, 26, 0.45), 0 2px 0 #000; }
#hud-end-sub { font-size: 13px; font-weight: 700; letter-spacing: .42em; color: var(--olive); }
#hud-end-score { font-size: 34px; color: var(--olive-bright); white-space: pre; letter-spacing: .06em; }
#hud-end-kd { font-size: 12px; font-weight: 700; letter-spacing: .28em; color: var(--olive-dim); margin-bottom: 6px; }
#hud-end-rank { min-height:15px; font-size:10px; font-weight:900; letter-spacing:.22em; color:var(--olive); }
#hud-end-rank.success { color:var(--money); text-shadow:0 0 12px rgba(159,224,122,.3); }
#hud-end-rank.queued { color:#d9b66a; }
#hud-end-rank.pending { color:#d7b86b; animation:hud-blink 1s step-end infinite alternate; }
#hud-end-rank.unranked { color:#e0aa79; }
.end-rewards { width:min(690px,78vw); padding:12px 14px; text-align:left; border:1px solid rgba(170,201,113,.38); background:linear-gradient(115deg,rgba(117,151,69,.12),rgba(0,0,0,.2)); }
.end-rewards.pending { opacity:.76; }
.end-rewards.unranked { border-color:rgba(217,138,74,.48); background:linear-gradient(115deg,rgba(142,79,43,.16),rgba(0,0,0,.2)); }
.end-reward-grid { display:grid; grid-template-columns:.75fr .75fr 1.5fr; gap:1px; }
.end-reward-grid > span { min-width:0; padding:6px 9px; border-left:1px solid rgba(154,178,107,.16); }
.end-reward-grid > span:first-child { border-left:0; }
.end-reward-grid strong { display:block; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:17px; letter-spacing:.05em; color:#eef5e2; }
.end-xp { padding:7px 9px 0; }
.end-xp > div { height:7px; }
.end-xp small { display:block; margin-top:4px; font-size:10px; font-weight:900; letter-spacing:.09em; color:#9daf80; }
.end-unlocks { display:flex; flex-wrap:wrap; gap:5px; min-height:25px; padding:8px 9px 0; }
.end-unlocks span { padding:4px 7px; font-size:10px; font-weight:900; letter-spacing:.08em; color:#dce9c9; border:1px solid rgba(154,178,107,.24); background:rgba(0,0,0,.2); }
.end-unlocks .achievement { color:#d9ebbb; border-color:rgba(174,214,105,.55); }
.end-unlocks .record { color:#f0d17e; border-color:rgba(226,185,93,.55); }

@media (max-width: 900px) {
  .mn-map-grid {
    grid-template-columns:none; grid-auto-flow:column; grid-auto-columns:minmax(136px,1fr);
    overflow-x:auto; padding-bottom:4px; scroll-snap-type:x proximity;
    scrollbar-width:thin; scrollbar-color:rgba(154,178,107,.35) transparent;
  }
  .mn-map { scroll-snap-align:start; }
  .mn-bindings { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .lb-toolbar { grid-template-columns:1fr auto; }
  .lb-identity { grid-column:1 / -1; }
  .lb-tabs { grid-row:2; grid-column:1; }
  .lb-tabs button { flex:1; }
  #hud-leaderboard-refresh { grid-row:2; grid-column:2; }
  .lb-meta span:last-child { display:none; }
  .lb-self-card { margin-inline:18px; }
  .profile-characters { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@media (max-width: 620px) {
  #hud-menu { padding-inline:12px; }
  .mn-title { font-size:40px; }
  .mn-op { letter-spacing:.28em; text-indent:.28em; }
  .mn-career,.mn-map-picker,.mn-mode-picker,.mn-class-picker { width:100%; }
  .mn-class-row,.mn-class-editor { grid-template-columns:repeat(2,minmax(0,1fr)); }
  #hud-class-perk-detail { grid-column:1 / -1; }
  .mn-id { flex-wrap:wrap; gap:6px 12px; padding:9px 12px; }
  .mn-id-name { flex:1 1 auto; }
  .mn-id > .mn-chev { order:2; }
  .mn-id-stats { order:3; flex-basis:100%; gap:12px; justify-content:space-between; }
  .mn-xp { order:4; flex-basis:100%; }
  .mn-career-body { grid-template-columns:1fr; gap:12px; }
  .mn-actions,.end-actions { width:94vw; flex-direction:column; }
  #hud-start,#hud-restart,#hud-end-leaderboard { width:100%; min-width:0; }
  .mn-quick { width:94vw; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
  .mn-quick > button { width:100%; }
  .mn-settings { width:100%; }
  .mn-settings-tuning,.mn-bindings { grid-template-columns:repeat(2,minmax(0,1fr)); }
  #hud-leaderboard { padding:8px; }
  .lb-panel { min-height:100%; clip-path:none; }
  .lb-top { padding:14px 15px 10px; }
  .lb-top h2 { font-size:21px; letter-spacing:.15em; }
  .lb-toolbar { padding:10px 14px; gap:9px; }
  .lb-identity { flex-wrap:wrap; }
  .lb-profile-edit { margin-left:auto; }
  .lb-tabs button { min-width:0; padding-inline:7px; }
  #hud-leaderboard-refresh { padding-inline:10px; }
  .lb-meta,.lb-foot { padding-inline:15px; }
  .lb-self-card { grid-template-columns:repeat(2,minmax(0,1fr)); margin:0 12px 8px; }
  #hud-leaderboard-body { padding-inline:12px; }
  .lb-dossier > summary,.lb-scoring summary,#hud-leaderboard-rules { padding-inline:15px; }
  .lb-dossier-body { grid-template-columns:1fr; padding-inline:15px; }
  .lb-record-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .lb-scoring summary span { display:none; }
  #hud-profile { padding:8px; }
  .profile-panel { clip-path:none; }
  .profile-top { padding:18px 16px 15px; }
  .profile-top h2 { font-size:21px; letter-spacing:.12em; }
  #hud-profile-form { padding:18px 16px 20px; }
  .profile-characters { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .profile-character { min-height:158px; }
  .profile-note { align-items:flex-start; flex-direction:column; gap:5px; }
  .profile-progress summary { grid-template-columns:1fr auto; }
  .profile-progress summary span { display:none; }
  .profile-progress-actions { grid-template-columns:1fr; }
  .profile-new-career { align-items:flex-start; flex-direction:column; }
  .profile-new-confirm { grid-template-columns:1fr; }
  .profile-actions button { min-width:0; flex:1; }
  .end-inner { width:94vw; padding:28px 18px 24px; }
  .end-rewards { width:100%; }
}
@media (max-width: 520px) {
  .mn-settings-tuning { grid-template-columns:1fr; }
  .mn-setting-wide { grid-column:auto; }
}
@media (max-height: 680px) and (min-width: 621px) {
  #hud-menu { padding-top:10px; gap:8px; }
  .mn-title { font-size:38px; }
  .mn-op { font-size:10px; }
  .mn-id { min-height:40px; padding:6px 12px; }
  .mn-id-name strong { font-size:14px; }
  .mn-career-body { padding:9px 12px 8px; }
  .mn-career-sync,.mn-daily p { display:none; }
  .mn-podium { min-height:45px; margin:4px 0; }
  .mn-podium > span { padding-block:1px; font-size:10px; }
  .mn-daily > strong { margin-top:7px; }
  .mn-map-art { height:38px; }
  .mn-map-copy { padding-block:5px; }
  .mn-settings { padding-block:9px; gap:8px; }
  .mn-binding { min-height:34px; }
  #hud #mp-panel { padding-block:8px; margin-top:0; }
  .lb-panel { min-height:100%; }
  .lb-state { min-height:220px; }
  .lb-dossier[open] { max-height:46%; }
  #hud-profile { padding:12px 24px; }
  .profile-top { padding-block:15px 12px; }
  #hud-profile-form { padding-block:14px 18px; }
  #hud-profile-name { height:44px; }
  #hud-profile-form fieldset { margin-top:14px; }
  .profile-character { min-height:137px; padding-block:8px; }
  .profile-portrait { width:58px; height:60px; margin-bottom:6px; }
  .profile-portrait::before { top:5px; }
  .profile-portrait i { height:40px; }
  .profile-note { margin-top:13px; padding-block:9px; }
  .profile-actions { margin-top:13px; padding-top:12px; }
}

/* The touch layout intentionally compresses spacing in very short landscape
   viewports, but status labels still need to remain readable at arm's length. */
/* Phone landscape: the result, podium and the two buttons in one screen. */
@media (max-height: 500px) {
  .end-inner { gap: 8px; padding: 14px 26px 16px; }
  #hud-end-title { font-size: 30px; }
  #hud-end-score { font-size: 24px; }
  #hud-end-kd { margin-bottom: 0; }
  #hud-end-podium { margin: 0; }
  .end-rewards { padding: 6px 10px; }
}
/* A 360 px phone: the buttons and MAIN MENU were below the fold. Prefixed
   with #hud-end to outrank the touch layout's own sizes. */
@media (max-height: 400px) {
  #hud-end .end-inner { gap: 4px; padding: 6px 22px 8px; }
  #hud-end #hud-end-title { font-size: 24px; line-height: 1.05; }
  #hud-end #hud-end-score { font-size: 19px; }
  #hud-end .pod { padding: 1px 8px; }
  #hud-end .end-rewards { padding: 4px 10px; }
  #hud-end .end-actions .btn-sub { display: none; }
  #hud-end .end-actions button { min-height: 36px; padding-block: 4px; }
  #hud-end .end-menu-link { margin-top: 0; padding-block: 2px; }
}
@media (orientation:landscape) and (max-height:500px) {
  html.touch-device .mn-op,
  html.touch-device .mn-id-name span,
  html.touch-device .mn-id-stats small,
  html.touch-device .mn-xp small,
  html.touch-device .mn-podium > span,
  html.touch-device .mn-daily > strong,
  html.touch-device .lb-self-card small,
  html.touch-device .lb-you,
  html.touch-device .lb-career,
  html.touch-device .profile-character > b,
  html.touch-device .sb-self-tag,
  html.touch-device .end-reward-grid small,
  html.touch-device .end-unlocks span,
  html.touch-device #hud-end-rank,
  html.touch-device .progress-toast-copy small,
  html.touch-device .progress-toast-copy em,
  html.touch-device #hud-round,
  html.touch-device .kf-weap,
  html.touch-device .kf-hs { font-size:10px!important; }
  html.touch-device .lb-dossier > summary { min-height:44px; padding:5px 12px; }
  html.touch-device .lb-dossier > summary strong { font-size:12px; }
  html.touch-device .lb-dossier > summary small { font-size:10px; }
  html.touch-device .lb-dossier[open] { max-height:48%; }
  html.touch-device .lb-dossier-body { grid-template-columns:1fr 1fr; gap:8px; padding:0 12px 10px; }
  html.touch-device .lb-record-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; }
  html.touch-device .lb-badge-grid { grid-template-columns:1fr; gap:4px; }
  html.touch-device .profile-new-confirm { grid-template-columns:minmax(0,1fr) auto auto; }
  /* At 375 px tall the table got ~35 px between the stats card and the
     dossiers: one clipped row. The panel scrolls instead, and the table keeps
     room for four rows (it still scrolls on its own past that). */
  .lb-panel { overflow-y:auto; }
  .lb-panel > * { flex-shrink:0; }
  #hud-leaderboard-body { min-height:230px; }
}

/* ---------- multiplayer panel harmonization (styles only) ---------- */
/* Triple-id selector so the width tracks the menu column even though the
   network module appends its own stylesheet after this one. */
#hud #mp-panel {
  position: relative; width: min(880px, 94vw); margin-top: 4px; padding: 14px 20px 12px;
  background: linear-gradient(180deg, rgba(14, 18, 8, 0.6), rgba(4, 6, 2, 0.75));
  border: 1px solid rgba(154, 178, 107, 0.28);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.07);
}
#hud #mp-panel .mp-title {
  font-family: inherit; font-size: 12px; font-weight: 800; letter-spacing: .32em;
  color: var(--olive-bright);
}
#hud #mp-panel input, #hud #mp-panel select, #hud #mp-panel button {
  font-family: inherit; font-stretch: condensed; font-size: 12px; font-weight: 700;
  letter-spacing: .12em; color: var(--olive-bright);
  background: rgba(8, 11, 5, 0.9); border: 1px solid rgba(154, 178, 107, 0.35);
  padding: 8px 10px;
}
#hud #mp-panel button {
  clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
  transition: background .1s;
}
#hud #mp-panel button:hover { background: rgba(154, 178, 107, 0.22); }
#hud #mp-panel #mp-start { background: rgba(82, 107, 46, 0.9) !important; color: #eef5df !important; }
#hud #mp-status { font-family: inherit; font-size: 11px; letter-spacing: .16em; color: var(--olive); }
#hud #mp-status.error { color: #e26755; }
#hud #mp-roster { font-family: inherit; letter-spacing: .06em; }
#hud #mp-roster .mp-player { border: 1px solid rgba(154, 178, 107, 0.14); }
#hud #mp-roster .mp-player.ct span:last-child { color: var(--ct); }
#hud #mp-roster .mp-player.t span:last-child { color: var(--t); }

@media (prefers-reduced-motion: reduce) {
  .mn-title::after,.progress-toast,.progress-toast.leaving,#hud-end-rank.pending,
  .lb-state.loading .lb-state-mark { animation:none!important; }
  .mn-xp-track span,.mn-daily-track span,.end-xp > div span { transition:none!important; }
}

/* Reduced motion: no pulsing, blinking, sliding or popping. Animations that
   fade an element out (kill cue, money pop) keep their timing but lose the
   movement and scale. */
@media (prefers-reduced-motion: reduce) {
  #hud-health.low, #hud-money.pulse, #hud-reload, #hud-bomb-ico, .kf-entry, .rd-entry,
  #hud-defuse-fill, #hud.killcam-on .kc-bar, #hud-death.transitioning .death-inner,
  .buy-item.purchased, .pause-main, #hud-end-rank.pending, .lb-state.loading .lb-state-mark,
  .mn-title::after { animation: none !important; }
  #hud-killcue.show { animation-name: killcue-fade !important; }
  .money-pop { animation-name: money-fade !important; }
}
@keyframes killcue-fade {
  0% { opacity: 0; transform: translate(-50%, -50%); } 10%, 72% { opacity: 1; transform: translate(-50%, -50%); }
  100% { opacity: 0; transform: translate(-50%, -50%); }
}
@keyframes money-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }
/* Touch: the STREAK button already shows when a streak is ready, and the
   rail would sit under the USE and CROUCH buttons. */
html.touch-device #hud-streaks { display: none; }

/* Focus rings sit inside the button: the cut-corner clip-paths on most of
   the menu clip an outer outline away entirely. */
#hud button:focus-visible, #hud select:focus-visible, #hud summary:focus-visible,
#hud input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--olive-bright) !important; outline-offset: -4px !important;
}

.mn-graphics-row { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:6px; }
@media (max-width: 520px) {
  .mn-graphics-row { grid-template-columns:repeat(3,minmax(0,1fr)); }
}
.mn-graphics-row button {
  appearance:none; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:2px;
  min-width:0; min-height:44px; padding:7px 8px 8px; font:inherit; text-align:left; cursor:pointer; color:#dfe8d2;
  background:rgba(8,13,8,.72); border:1px solid rgba(154,178,107,.22);
}
.mn-graphics-row strong { max-width:100%; font-size:11px; font-weight:900; letter-spacing:.08em; line-height:1.15; }
.mn-graphics-row span {
  max-width:100%; font-size:9px; font-weight:800; letter-spacing:.06em; line-height:1.25; color:var(--olive-dim);
}
.mn-graphics-row button:hover { border-color:var(--olive); }
.mn-graphics-row button.selected {
  border-color:var(--olive-bright); background:rgba(154,178,107,.16);
  box-shadow:inset 3px 0 0 var(--olive-bright), inset 0 0 0 1px var(--olive);
}
.mn-graphics-row button.selected span { color:var(--olive-bright); }
.mn-graphics-reload {
  justify-self: start; padding: 5px 10px; cursor: pointer; font: inherit; font-size: 10px; font-weight: 900;
  letter-spacing: .14em; color: #0a0e08; background: var(--olive-bright); border: 0;
}
.mn-graphics-reload[hidden] { display: none; }

/* Solo-only build: nothing that needs the game service. */
#hud.svc-offline #hud-online-open, #hud.svc-offline #hud-leaderboard-open,
#hud.svc-offline #hud-end-leaderboard, #hud.svc-offline #hud-career,
#hud.svc-offline #hud-progress-details { display: none !important; }

/* ---------- debug fps ---------- */
#hud.killcam-on #hud-fps { bottom: calc(9vh + 6px); }
#hud-fps {
  position: absolute; left: 8px; bottom: 6px; font-size: 11px; font-weight: 700; letter-spacing: .1em;
  color: rgba(214, 229, 184, 0.85); text-shadow: 0 1px 2px #000; z-index: 2; pointer-events: none;
}
`;
  }
}
