// ============================================================================
// TINY WARFARE — src/gfx/auto-graphics.js
//
// Auto graphics: a device that cannot hold ~40 fps during a match steps down,
// one step per stretch of slow seconds: first the ambient-occlusion passes,
// then a 1.0 pixel ratio, then a lower render scale (unless the player set
// one). If it is still slow after that, the next visit starts on the next
// lighter preset (High -> Medium -> Low -> Chromebook), since the
// texture budget, shading and set dressing are chosen at load. Only while the
// Graphics setting is Auto.
// ============================================================================

import { GRAPHICS_LABELS, nextLighterPreset } from './profiles.js';

export const AUTO_GRAPHICS_MIN_FPS = 40;
export const AUTO_GRAPHICS_SLOW_SECONDS = 6;

/**
 * hooks: disableSsao() -> bool (true if it had AO to drop), capPixelRatio()
 * -> false when it had nothing left to lower, lowerRenderScale() -> the same
 * (optional), rememberFloor(preset),
 * notify(text). Call update() every frame; it acts on the once-a-second fps
 * reading. `game.gfxPreset` is the preset this visit started on.
 */
export function createAutoGraphics(game, settings, hooks) {
  return {
    step: 0,
    slow: 0,
    lastFps: -1,
    done: false,
    update() {
      if (settings.graphics !== 'auto' || this.done) return;
      const floor = nextLighterPreset(game.gfxPreset || game.gfxQuality || 'high');
      if (!floor) return;
      const phase = game.state && game.state.phase;
      if (phase !== 'live' && phase !== 'planted') { this.slow = 0; return; }
      if (game.fps === this.lastFps) return;
      this.lastFps = game.fps;
      // A frame-rate cap below the threshold is a choice, not a slow device.
      const cap = settings.fpsCap > 0 ? settings.fpsCap * 0.85 : Infinity;
      this.slow = game.fps < Math.min(AUTO_GRAPHICS_MIN_FPS, cap) ? this.slow + 1 : 0;
      if (this.slow < AUTO_GRAPHICS_SLOW_SECONDS) return;
      this.slow = 0;
      this.step++;
      if (this.step === 1 && hooks.disableSsao()) {
        hooks.notify('GRAPHICS LOWERED FOR A SMOOTHER GAME');
        return;
      }
      if (this.step <= 2) {
        this.step = 2;
        if (hooks.capPixelRatio() !== false) {
          hooks.notify('GRAPHICS LOWERED FOR A SMOOTHER GAME');
          return;
        }
        this.step = 3;
      }
      if (this.step === 3 && hooks.lowerRenderScale && hooks.lowerRenderScale() !== false) {
        hooks.notify('RESOLUTION LOWERED FOR A SMOOTHER GAME');
        return;
      }
      this.done = true;
      hooks.rememberFloor(floor);
      hooks.notify('NEXT TIME THE GAME STARTS ON ' + GRAPHICS_LABELS[floor] + ' GRAPHICS');
    },
  };
}
