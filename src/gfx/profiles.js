// ============================================================================
// TINY WARFARE — src/gfx/profiles.js
//
// Graphics presets. Each one is a plain table of the knobs the renderer,
// materials, sky, world and effects read at load; `tier` is the older
// 'high' | 'low' switch the remaining modules still branch on.
//
// Chromebook is the low-power preset: below Low it renders under native
// resolution, drops the canvas MSAA, uses a small 4-tap-filtered shadow map
// refreshed every other frame, keeps the sky static between rare re-blits,
// turns off the effects' and maps' point lights (each one is a loop in every
// lit pixel) and skips the parallax, de-tiling and sheen layers in the
// material shader. Map layout, props and cover are identical on every preset:
// they are gameplay.
//
// Auto picks: a phone or tablet gets Low; a Chromebook, or any device whose
// GPU is a known low-power part or a software renderer, gets Chromebook; a
// desktop with an older Intel HD/UHD part gets Low; everything else High. A
// device that cannot hold the frame rate is stepped down at runtime by
// auto-graphics, which remembers the floor for the next visit.
// ============================================================================

export const GRAPHICS_PRESETS = Object.freeze(['high', 'low', 'chromebook']);

export const GRAPHICS_PROFILES = Object.freeze({
  high: Object.freeze({
    id: 'high',
    tier: 'high',
    post: true,
    msaa: true,
    maxPixelRatio: 1.5,
    renderScale: 1,
    shadowMapSize: 3072,
    shadowFilter: 'soft',
    shadowInterval: 1,
    skyEquirect: 2048,
    skyRefresh: 0.4,
    liteShading: false,
    fxLights: true,
    mapLights: true,
    precipitation: 1,
  }),
  low: Object.freeze({
    id: 'low',
    tier: 'low',
    post: false,
    msaa: true,
    maxPixelRatio: 1.5,
    renderScale: 1,
    shadowMapSize: 2048,
    shadowFilter: 'soft',
    shadowInterval: 1,
    skyEquirect: 512,
    skyRefresh: 0.8,
    liteShading: false,
    fxLights: true,
    mapLights: true,
    precipitation: 0.5,
  }),
  chromebook: Object.freeze({
    id: 'chromebook',
    tier: 'low',
    post: false,
    msaa: false,
    maxPixelRatio: 1,
    renderScale: 0.8,
    shadowMapSize: 1024,
    shadowFilter: 'bilinear',
    shadowInterval: 2,
    skyEquirect: 512,
    skyRefresh: 3,
    liteShading: true,
    fxLights: false,
    mapLights: false,
    precipitation: 0.3,
  }),
});

/** Labels for the settings menu, in display order. */
export const GRAPHICS_LABELS = Object.freeze({
  auto: 'AUTO',
  high: 'HIGH',
  low: 'LOW',
  chromebook: 'CHROMEBOOK / LOW-POWER',
});

const WEAK_GPU = /mali|powervr|adreno \(tm\) [1-5]\d\d|adreno [1-5]\d\d|swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
const OLD_INTEL = /intel.*\b(u?hd) graphics\b/i;
const STRONG_INTEGRATED = /iris|\bxe\b|arc|radeon|geforce|nvidia|apple|adreno \(tm\) [6-9]\d\d|adreno [6-9]\d\d/i;

/** True on ChromeOS (client hints first; the frozen UA string still says CrOS). */
export function isChromeOS(nav = globalThis.navigator) {
  const platform = String(nav?.userAgentData?.platform || '');
  if (/chrome ?os|chromium ?os/i.test(platform)) return true;
  return /\bCrOS\b/.test(String(nav?.userAgent || ''));
}

/**
 * The GPU's own name, or '' where the browser hides it. Probed on a throwaway
 * context so the real renderer's options (antialias) can still depend on it.
 */
export function probeGpuName(doc = globalThis.document) {
  let gl = null;
  try {
    const canvas = doc?.createElement?.('canvas');
    gl = canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(name || '');
  } catch {
    return '';
  } finally {
    try { gl?.getExtension?.('WEBGL_lose_context')?.loseContext(); } catch { /* best effort */ }
  }
}

/** The preset Auto starts from on this device, before any runtime step-down. */
export function autoGraphicsPreset({ touch = false, chromeOS = false, gpu = '' } = {}) {
  const name = String(gpu || '');
  if (WEAK_GPU.test(name)) return 'chromebook';
  if (chromeOS) return STRONG_INTEGRATED.test(name) ? 'high' : 'chromebook';
  if (touch) return 'low';
  if (OLD_INTEL.test(name) && !STRONG_INTEGRATED.test(name)) return 'low';
  return 'high';
}

const ORDER = ['high', 'low', 'chromebook'];

/** The lighter of two presets (Auto never starts above its remembered floor). */
export function lighterPreset(a, b) {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/** The next preset down from this one, or null at the bottom. */
export function nextLighterPreset(id) {
  const i = ORDER.indexOf(id);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

export function graphicsProfile(id) {
  return GRAPHICS_PROFILES[id] || GRAPHICS_PROFILES.high;
}
