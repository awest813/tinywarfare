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
// Auto picks: a software renderer gets Chromebook; a phone or tablet Low; a
// Chromebook (unless its GPU is an Iris Xe / Radeon Vega class part) or a
// laptop with a known low-power GPU, Chromebook; a desktop with an older
// Intel HD/UHD part Low; everything else High. A device that cannot hold
// the frame rate is stepped down at runtime by auto-graphics, which
// remembers the floor for the next visit.
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
    radarInterval: 0.05,
    weaponShadows: true,
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
    radarInterval: 0.05,
    weaponShadows: true,
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
    // the radar's canvas redraw is a measurable share of a slow CPU's frame
    radarInterval: 0.1,
    // A held gun's shadow is a few texels in a 1024 map, but ~25k triangles
    // per soldier through the shadow pass a second time.
    weaponShadows: false,
  }),
});

/** Labels for the settings menu, in display order. */
export const GRAPHICS_LABELS = Object.freeze({
  auto: 'AUTO',
  high: 'HIGH',
  low: 'LOW',
  chromebook: 'CHROMEBOOK / LOW-POWER',
});

// Low-power parts on a laptop or desktop: ARM Mali and PowerVR, Adreno below
// the 630 class (the Snapdragon 7c's 618 included), and AMD's Stoney Ridge
// Radeon R2-R7. Checked before the strong list. Phones are judged on touch
// alone: recent flagships ship Mali GPUs that handle Low well.
const WEAK_GPU = new RegExp([
  'mali', 'powervr', 'adreno (?:\\(tm\\) )?(?:[1-5]\\d\\d|6[0-2]\\d)\\b', 'stoney', 'radeon r[2-7]\\b',
].join('|'), 'i');
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
const OLD_INTEL = /intel.*\b(u?hd) graphics\b/i;
const STRONG_INTEGRATED = /iris|\bxe\b|\barc\b|radeon|geforce|nvidia|apple|adreno (?:\(tm\) )?(?:6[3-9]\d|[7-9]\d\d)\b/i;

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
  if (SOFTWARE_GPU.test(name)) return 'chromebook';
  // ChromeOS before touch: a Chromebook tablet (Lenovo Duet and kin) is
  // a Chromebook first.
  if (chromeOS) {
    if (WEAK_GPU.test(name) || !STRONG_INTEGRATED.test(name)) return 'chromebook';
    return touch ? 'low' : 'high';
  }
  if (touch) return 'low';
  if (WEAK_GPU.test(name)) return 'chromebook';
  if (OLD_INTEL.test(name) && !STRONG_INTEGRATED.test(name)) return 'low';
  return 'high';
}

const ORDER = GRAPHICS_PRESETS;

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
