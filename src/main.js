import * as THREE from 'three';
import { EventBus } from './shared/events.js';
import { CONFIG } from './shared/config.js';
import Input from './core/input.js';
import GameSettings, { setKeyboardLayoutMap } from './core/settings.js';
import TouchControls, { shouldEnableTouchControls } from './core/touch-controls.js';
import World from './world/map.js';
import { MaterialSystem } from './gfx/materials/index.js';
import { PostChain } from './gfx/post/index.js';
import { createAutoGraphics } from './gfx/auto-graphics.js';
import { graphicsProfile, isChromeOS, probeGpuName } from './gfx/profiles.js';
import { prewarmShaders } from './gfx/prewarm.js';
import { installBilinearShadows } from './gfx/shadow-bilinear.js';
import Player from './player/player.js';
import Killcam from './player/killcam.js';
import PlayerProfile from './player/profile.js';
import Weapons from './weapons/weapons.js';
import ViewModel from './weapons/viewmodel.js';
import Combat from './combat/combat.js';
import Bots from './ai/bots.js';
import Rounds from './game/rounds.js';
import MatchScore from './game/score.js';
import Scorestreaks from './game/streaks.js';
import Loadouts from './game/loadouts.js';
import Progression from './game/progression.js';
import Announcer from './audio/announcer.js';
import HUD from './ui/hud.js';
import AudioSys from './audio/audio.js';
import Effects from './effects/effects.js';
import Multiplayer from './network/multiplayer.js';
import LeaderboardClient from './leaderboard/client.js';
import { DEFAULT_MAP_ID, normalizeMapId } from './maps/catalog.js';

const loadingScreen = globalThis.TINY_STRIKE_LOADING;
loadingScreen?.setStage?.('Initializing renderer', 18);

const app = document.getElementById('app');
const savedMapId = (() => {
  try { return localStorage.getItem('tiny-strike-map'); } catch { return null; }
})();
const queryMapId = new URLSearchParams(location.search).get('map');
const TOUCH_DEVICE = shouldEnableTouchControls();

// ?trailer — cinematic recording mode (tools/trailer.js): acts as debug mode
// and needs one extra body per side for the scripted kill choreography.
const TRAILER = new URLSearchParams(location.search).has('trailer');
if (TRAILER) CONFIG.MATCH.BOTS_PER_TEAM = 6;

// When the HDR post chain runs it renders into its own multisampled target
// and only composites to the canvas, so a multisampled canvas would be pure
// waste (~150 MB at 1080p x1.5 plus a resolve per frame). Decide up front.
const EARLY_SEARCH = new URLSearchParams(location.search);
// Device preferences are read before the renderer exists: the graphics tier
// decides its antialiasing. Trailer capture ignores this browser's settings.
const settings = new GameSettings(null, TRAILER ? null : undefined);
// The preset (src/gfx/profiles.js). Auto needs to know the device: a
// Chromebook or a low-power GPU starts on the Chromebook preset.
// The GPU name needs a throwaway context, so it is only asked for when Auto
// actually needs it (on load, or when the menu shows Auto's choice).
let gpuName = null;
const GFX_DEVICE = Object.freeze({
  touch: TOUCH_DEVICE,
  chromeOS: isChromeOS(),
  get gpu() { return gpuName ?? (gpuName = probeGpuName()); },
});
const GFX_PRESET = settings.graphicsPreset(GFX_DEVICE);
const GFX = graphicsProfile(GFX_PRESET);
const GFX_QUALITY = GFX.tier;
const WANT_POST = EARLY_SEARCH.get('post') !== 'off' && GFX.post;
const renderer = new THREE.WebGLRenderer({
  antialias: !WANT_POST && GFX.msaa,
  powerPreference: 'high-performance',
});

function layoutViewportSize() {
  const root = document.documentElement;
  const width = Math.max(1, Math.round(root.clientWidth || window.innerWidth));
  const height = Math.max(1, Math.round(root.clientHeight || window.innerHeight));
  return { width, height };
}

function visibleViewport(layout) {
  const visual = window.visualViewport;
  const scale = Number(visual?.scale ?? 1);
  if (!visual || !Number.isFinite(scale) || Math.abs(scale - 1) > 0.02) {
    return { ...layout, left: 0, top: 0 };
  }

  const width = Math.min(layout.width, Math.max(1, Math.round(visual.width || layout.width)));
  const height = Math.min(layout.height, Math.max(1, Math.round(visual.height || layout.height)));
  const left = Math.max(0, Math.min(layout.width - width, Math.round(visual.offsetLeft || 0)));
  const top = Math.max(0, Math.min(layout.height - height, Math.round(visual.offsetTop || 0)));
  return { width, height, left, top };
}

function syncViewportCss(layout) {
  const visible = visibleViewport(layout);
  const root = document.documentElement.style;
  root.setProperty('--layout-width', `${layout.width}px`);
  root.setProperty('--layout-height', `${layout.height}px`);
  root.setProperty('--app-width', `${visible.width}px`);
  root.setProperty('--app-height', `${visible.height}px`);
  root.setProperty('--app-left', `${visible.left}px`);
  root.setProperty('--app-top', `${visible.top}px`);
}

// Auto graphics can cap the pixel ratio mid-match on a slow device.
let pixelRatioCap = Infinity;

function targetPixelRatio(width, height) {
  return Math.min(pixelRatioCap, deviceTargetPixelRatio(width, height));
}

function deviceTargetPixelRatio(width, height) {
  const device = Math.max(1, Number(window.devicePixelRatio) || 1);
  // Desktop: 1.5 keeps Retina sharp while shading ~44% fewer pixels than 2x
  // (the frame was fill-bound at 2x on high-DPI laptops). Keep high-density
  // phone output crisp without asking large tablets to shade several million
  // pixels every frame. The preset can cap it lower and render below native
  // resolution (Chromebook: 0.8, upscaled by the browser; the HUD is HTML
  // and stays sharp).
  const deviceCap = !TOUCH_DEVICE ? 1.5 : width * height > 1_000_000 ? 1.25 : 1.5;
  return Math.min(device, deviceCap, GFX.maxPixelRatio) * GFX.renderScale;
}

const initialViewport = layoutViewportSize();
syncViewportCss(initialViewport);
renderer.setPixelRatio(targetPixelRatio(initialViewport.width, initialViewport.height));
renderer.setSize(initialViewport.width, initialViewport.height);
renderer.shadowMap.enabled = true;
// Chromebook: a 4-tap bilinear compare (src/gfx/shadow-bilinear.js) instead
// of a 16-17 tap PCF kernel.
const BILINEAR_SHADOWS = GFX.shadowFilter === 'bilinear' && installBilinearShadows(THREE);
renderer.shadowMap.type = BILINEAR_SHADOWS
  ? THREE.BasicShadowMap
  : TOUCH_DEVICE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
// Phones and the Chromebook preset re-rasterize the arena's shadow map every
// other frame, not every frame (the world is static; moving shadows lag by
// one frame).
const SHADOW_INTERVAL = Math.max(TOUCH_DEVICE ? 2 : 1, GFX.shadowInterval);
if (SHADOW_INTERVAL > 1) renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);
loadingScreen?.setStage?.('Building battleground', 38);
await loadingScreen?.waitForPaint?.();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  CONFIG.PLAYER.FOV,
  initialViewport.width / initialViewport.height,
  0.05,
  400
);
scene.add(camera);

const game = {
  config: CONFIG,
  events: new EventBus(),
  renderer,
  scene,
  camera,
  canvas: renderer.domElement,
  hudRoot: document.getElementById('hud'),
  debug: new URLSearchParams(location.search).has('test') || TRAILER,
  sessionMode: 'solo',
  selectedMapId: normalizeMapId(queryMapId || savedMapId || DEFAULT_MAP_ID),
  state: {
    phase: 'menu',
    round: 0,
    scores: { ct: 0, t: 0 },
    timer: 0,
    money: CONFIG.ECON.START_MONEY,
    bomb: { planted: false, site: null, pos: null, defusingBy: null, defuseProgress: 0, carrierId: null },
    canBuy: false,
    buyOpen: false,
  },
};

// Procedural PBR surfaces (src/gfx/materials) bake on the GPU the first time a
// material is asked for, so this costs nothing until the world builds. Phones
// get half-resolution texture sets; the shading is identical either way.
// One graphics tier for the whole session: texture budget, IBL resolution, the
// baked-sky refresh rate and how much set dressing a map gets all read it.
game.gfxQuality = GFX_QUALITY;
game.gfxPreset = GFX_PRESET;
game.gfx = GFX;
game.gfxDevice = GFX_DEVICE;
game.materials = new MaterialSystem({
  renderer,
  quality: game.gfxQuality,
  lite: GFX.liteShading,
  anisotropy: Math.min(GFX.liteShading ? 4 : 8, renderer.capabilities.getMaxAnisotropy()),
});
// The map's surface textures are baked on the GPU, one program per surface.
// Start all of those compiling in parallel now (where the driver can) instead
// of one after another inside the map build; awaited just before it.
const surfacePrograms = game.materials.precompile().catch(() => false);

// HDR post chain (src/gfx/post): render to a half-float target so emissives,
// muzzle flashes, tracers and the sun disc keep their real radiance, then bloom
// and tone map on the way to the canvas. It also owns the screen-space ambient
// occlusion pass, whose result the material shader reads while the beauty pass
// is being drawn (src/gfx/post/ssao.js).
//
// Off on 'low'. Phones are the reason the tier exists, and the chain costs a
// full-resolution RGBA16F target plus a pyramid of reads — bandwidth, which is
// the one thing a mobile tile GPU has least of, and the AO block adds a second
// geometry submit on top. On 'low' nothing below changes: the renderer keeps its
// own ACES tone mapping, the sky dome keeps applying its copy of the same curve,
// the AO term's master amount stays at 0 so the material shader short-circuits
// it on a uniform branch, and the frame goes straight to the canvas with the
// context's own MSAA, exactly as it did before this chain existed.
//
// ?post=off  force the direct path
// ?post=msaa|fxaa|none  pin the antialiasing instead of probing for it
// ?ssao=off  keep the HDR chain but drop the AO passes (A/B the term)
const SEARCH = new URLSearchParams(location.search);
const POST_PARAM = SEARCH.get('post');
const POST_AA = ['msaa', 'fxaa', 'none'].includes(POST_PARAM) ? POST_PARAM : 'auto';
game.post =
  POST_PARAM !== 'off' && game.gfxQuality !== 'low' && PostChain.supported(renderer)
    ? new PostChain(game, { aa: POST_AA, ssao: SEARCH.get('ssao') !== 'off' })
    : null;

// Construction order per SPEC.md — later modules may hold references to earlier ones.
// Trailer capture is deterministic and must not inherit this browser's personal
// brightness, sensitivity or keyboard layout.
settings.game = game;
game.settings = settings;
// Show key labels in the player's own keyboard layout where the browser can say.
navigator.keyboard?.getLayoutMap?.()
  .then((map) => {
    setKeyboardLayoutMap(map);
    game.events.emit('settings:changed', { kind: 'layout', settings: settings.snapshot() });
  })
  .catch(() => {});
// Field of view is a device preference; every FOV reader uses CONFIG.
const applyFov = () => {
  CONFIG.PLAYER.FOV = game.settings.fov;
  const weapons = game.weapons;
  if (!weapons) { camera.fov = CONFIG.PLAYER.FOV; camera.updateProjectionMatrix(); }
  else if (!(weapons.scopeLevel > 0)) weapons._fovTarget = CONFIG.PLAYER.FOV; // eases there
};
applyFov();
game.events.on('settings:changed', applyFov);
game.profile = new PlayerProfile(game);
game.input = new Input(game);
// Never hold the boot on a driver that stops answering: the bake compiles
// whatever is not ready itself.
await Promise.race([surfacePrograms, new Promise((resolve) => setTimeout(resolve, 10000))]);
game.world = new World(game);
loadingScreen?.setStage?.('Deploying operatives', 72);
await loadingScreen?.waitForPaint?.();
game.effects = new Effects(game);
game.audio = new AudioSys(game);
game.player = new Player(game);
game.weapons = new Weapons(game);
game.viewmodel = new ViewModel(game);
game.combat = new Combat(game);
game.bots = new Bots(game);
game.rounds = new Rounds(game);
game.score = new MatchScore(game);
game.progression = new Progression(game);
game.streaks = new Scorestreaks(game);
game.loadouts = new Loadouts(game);
game.announcer = new Announcer(game);
game.leaderboard = new LeaderboardClient(game);
// A cached career from an earlier session restores unlocks before the menu draws.
game.progression.syncCareer(game.leaderboard.getProgression?.());
game.hud = new HUD(game);
game.touchControls = new TouchControls(game);
game.multiplayer = new Multiplayer(game);
game.killcam = new Killcam(game);
loadingScreen?.setStage?.('Calibrating combat systems', 92);

// Compile every shader up front (see src/gfx/prewarm.js): at boot behind the
// loading screen, after a map change (the light count, and so every program,
// differs per map) and at match start for anything that streamed in since
// (soldier GLBs). Without it the first live frame and the first tracer and
// explosion each froze a low-end GPU mid-fight.
const prewarm = () => {
  // The post chain draws the scene off-screen first (a different program key).
  const targets = game.post?.sceneRt ? [game.post.sceneRt, null] : [null];
  // ...and the ambient-occlusion prepass draws it again with one override material.
  const ssao = game.post?.ssao;
  const passes = ssao?.depthRt && ssao.depthMaterial ? [{ target: ssao.depthRt, override: ssao.depthMaterial }] : [];
  try { prewarmShaders(renderer, scene, camera, targets, passes); } catch (error) { console.warn('[prewarm]', error); }
};
prewarm();
game.events.on('map:changed', () => setTimeout(prewarm, 0));
game.events.on('ui:start', prewarm);

/**
 * The one place a frame gets drawn. Anything that drives its own loop should
 * call this rather than `renderer.render`, or it silently drops the post chain
 * — and with it the sky, which writes raw radiance while the chain is active.
 */
game.renderFrame = () => {
  if (game.post) game.post.render(scene, camera);
  else renderer.render(scene, camera);
  loadingScreen?.finish?.();
};

window.__game = game;

if (TRAILER) {
  import('../tools/trailer.js')
    .then((m) => m.default(game))
    .catch((err) => console.warn('[trailer] failed to load:', err));
}

function resizeRenderer() {
  const { width, height } = layoutViewportSize();
  syncViewportCss({ width, height });
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(targetPixelRatio(width, height));
  renderer.setSize(width, height);
  // Reads the drawing buffer size back off the renderer, so it stays correct
  // when the pixel ratio changes without the CSS size changing.
  game.post?.setSize();
}

window.addEventListener('resize', resizeRenderer, { passive: true });

// Auto graphics (src/gfx/auto-graphics.js): step down on a slow device.
const autoGraphics = createAutoGraphics(game, settings, {
  disableSsao: () => !!game.post?.disableSsao?.(),
  capPixelRatio: () => {
    if (renderer.getPixelRatio() <= 1) return false;
    pixelRatioCap = 1;
    resizeRenderer();
    return true;
  },
  rememberFloor: (preset) => settings.setGraphicsAutoFloor(preset),
  notify: (text) => game.events.emit('hud:notice', { text }),
});
window.visualViewport?.addEventListener?.('resize', resizeRenderer, { passive: true });

const UPDATE_ORDER = [
  // The world drives the sky: its LUT/IBL bakes must land before anything is
  // drawn with them.
  // The killcam runs before the rounds: a solo respawn that was waiting for
  // its replay then lands in the same frame the replay ends, instead of the
  // spectator showing a teammate for one frame in between. (It records the
  // poses the previous frame left, one frame behind, which is invisible.)
  'world', 'killcam', 'rounds', 'score', 'streaks', 'touchControls', 'player', 'weapons', 'viewmodel', 'bots',
  // Spectator runs after replicated/AI actors so deaths, disconnects, and
  // poses affect the observer camera in the same rendered frame. It hands the
  // camera to the killcam while a replay plays.
  'combat', 'multiplayer', 'spectator', 'effects', 'hud', 'audio', 'input',
  // Not gameplay: releases the texture forge's scratch targets once the bake
  // burst after a map load has clearly finished.
  'materials',
];

// What still runs while a solo match is paused (game.paused, set by the HUD's
// pause overlay): the menus, input, sky bakes and audio. The match itself —
// rounds, actors, projectiles, effects — holds still.
const PAUSED_SYSTEMS = new Set(['world', 'touchControls', 'multiplayer', 'hud', 'audio', 'input', 'materials']);

const clock = new THREE.Clock();
let shadowFrame = 0;
// The menu and end screens cover the scene, so it is drawn a few times a
// second there instead of every frame: the systems still update, the GPU
// (and a laptop's battery) gets a rest.
const COVERED_PHASES = new Set(['menu', 'gameEnd']);
const COVERED_FRAME_SECONDS = 0.25;
let coveredAge = Infinity;
// ?perf: the FPS readout adds the frame's draw calls, triangles and shader
// programs (summed over every pass, so the counters reset per frame).
game.perfOverlay = EARLY_SEARCH.has('perf');
if (game.perfOverlay) renderer.info.autoReset = false;
let frames = 0;
let fpsTime = 0;
game.fps = 60;

// Simulation runs in steps of at most MAX_STEP so physics and collision stay
// stable, but slow frames are sub-stepped instead of dropped: below 20 fps
// the round clock (which a multiplayer host shares with everyone) keeps real
// time. MAX_FRAME bounds catch-up after a stall or a backgrounded tab.
const MAX_STEP = 0.05;
const MAX_FRAME = 0.15;

// One system throwing must not stop the game: three requests the next frame
// only after this callback returns, so an uncaught error froze the screen for
// good with no message. Each failure is logged (at most every 5 s per system)
// and the loop carries on.
const failedAt = new Map();
function reportFailure(key, error) {
  const now = performance.now();
  if (now - (failedAt.get(key) || -Infinity) < 5000) return;
  failedAt.set(key, now);
  console.error(`[${key}] update failed:`, error);
}

// The sky, HUD, audio and material housekeeping are presentation: they run
// once per frame with the frame's whole time, so a slow frame does not pay
// for them two or three times over (which is what deepens a slowdown on a
// weak machine). Effects stay sub-stepped: their particles integrate drag and
// gravity explicitly, which is not stable at a 0.15 s step.
const FRAME_SYSTEMS = new Set(['world', 'hud', 'audio', 'materials']);

function runSystem(key, dt) {
  const sys = game[key];
  if (!sys || typeof sys.update !== 'function') return;
  if (game.paused && !PAUSED_SYSTEMS.has(key)) return;
  try {
    sys.update(dt);
  } catch (error) {
    reportFailure(key, error);
  }
}

renderer.setAnimationLoop(() => {
  const rawDt = clock.getDelta();

  frames++;
  fpsTime += rawDt;
  if (fpsTime >= 1) {
    game.fps = frames / fpsTime;
    frames = 0;
    fpsTime = 0;
  }

  const frameDt = Math.min(rawDt, MAX_FRAME);
  let remaining = frameDt;
  do {
    const dt = Math.min(remaining, MAX_STEP);
    remaining -= dt;
    for (const key of UPDATE_ORDER) {
      if (!FRAME_SYSTEMS.has(key)) runSystem(key, dt);
    }
  } while (remaining > 1e-6);
  for (const key of UPDATE_ORDER) {
    if (FRAME_SYSTEMS.has(key)) runSystem(key, frameDt);
  }

  if (SHADOW_INTERVAL > 1) {
    shadowFrame = (shadowFrame + 1) % SHADOW_INTERVAL;
    if (shadowFrame === 0) renderer.shadowMap.needsUpdate = true;
  }
  const covered = !game.debug && COVERED_PHASES.has(game.state?.phase);
  coveredAge = covered ? coveredAge + rawDt : Infinity;
  if (!covered || coveredAge >= COVERED_FRAME_SECONDS) {
    if (covered) coveredAge = 0;
    if (game.perfOverlay) renderer.info.reset();
    try {
      game.renderFrame();
    } catch (error) {
      reportFailure('render', error);
    }
  }
  autoGraphics.update();
});

// Closing or reloading the tab mid-match (a stray Ctrl+W, a mouse side
// button) asks first.
const MATCH_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd']);
let reloadingForGraphics = false;
window.addEventListener('beforeunload', (event) => {
  if (reloadingForGraphics || game.debug || !MATCH_PHASES.has(game.state?.phase)) return;
  event.preventDefault();
  event.returnValue = '';
});

// A lost graphics context (GPU reset, driver update, a backgrounded mobile
// tab) came back with GPU-baked textures, sky tables and lighting empty: a
// black world until reload. Say so, and reload once the context returns.
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  game.events.emit('hud:notice', { text: 'GRAPHICS RESET — RELOADING…' });
}, false);
renderer.domElement.addEventListener('webglcontextrestored', () => {
  reloadingForGraphics = true;
  location.reload();
}, false);
