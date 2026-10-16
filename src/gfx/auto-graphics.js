// ============================================================================
// TINY WARFARE — src/gfx/auto-graphics.js
//
// Auto graphics: a device on High that cannot hold ~40 fps during a match
// steps down, one step per stretch of slow seconds: first the ambient-
// occlusion passes, then a 1.0 pixel ratio. If it is still slow after that,
// the next visit starts on Low (the tier whose texture budget and set dressing
// are chosen at load). Only while the Graphics setting is Auto.
// ============================================================================

export const AUTO_GRAPHICS_MIN_FPS = 40;
export const AUTO_GRAPHICS_SLOW_SECONDS = 6;

/**
 * hooks: disableSsao() -> bool (true if it had AO to drop), capPixelRatio(),
 * rememberLow(), notify(text). Call update() every frame; it acts on the
 * once-a-second fps reading.
 */
export function createAutoGraphics(game, settings, hooks) {
  return {
    step: 0,
    slow: 0,
    lastFps: -1,
    update() {
      if (settings.graphics !== 'auto' || game.gfxQuality !== 'high' || this.step >= 3) return;
      const phase = game.state && game.state.phase;
      if (phase !== 'live' && phase !== 'planted') { this.slow = 0; return; }
      if (game.fps === this.lastFps) return;
      this.lastFps = game.fps;
      this.slow = game.fps < AUTO_GRAPHICS_MIN_FPS ? this.slow + 1 : 0;
      if (this.slow < AUTO_GRAPHICS_SLOW_SECONDS) return;
      this.slow = 0;
      this.step++;
      if (this.step === 1 && hooks.disableSsao()) {
        hooks.notify('GRAPHICS LOWERED FOR A SMOOTHER GAME');
      } else if (this.step <= 2) {
        this.step = 2;
        hooks.capPixelRatio();
        hooks.notify('GRAPHICS LOWERED FOR A SMOOTHER GAME');
      } else {
        hooks.rememberLow();
        hooks.notify('NEXT TIME THE GAME STARTS ON LOW GRAPHICS');
      }
    },
  };
}
