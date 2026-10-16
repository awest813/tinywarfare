# Performance and graphics options plan

Status: phase 0 (the Chromebook preset) is built; the rest is proposed.
Written October 2026 from a read of the renderer, materials, sky, world,
bots, HUD and loader, plus headless measurements of every map. File and line
references are to the tree at the time of writing.

## Goals

| Device class | Example hardware | Preset | Target |
|---|---|---|---|
| Budget Chromebook | MediaTek Kompanio 520 (Mali-G52 MC2), Intel Celeron N4500 / N100, 4 GB RAM, 1366x768 or 1080p | Chromebook | 30 fps steady in a 5v5 bot match, no hitch over 100 ms after the first 10 s |
| Older laptop | Intel UHD 620, 8 GB | Low | 50-60 fps at 1080p |
| Phone / tablet | Adreno 6xx, Apple A13+ | Low | 45-60 fps landscape |
| Modern laptop / desktop | Iris Xe, Apple M1, any discrete GPU | High | 60 fps at 1080p-1440p |

And, on every device:
- Menu visible in under 10 s on a Chromebook over a normal connection, with a
  progress bar that moves.
- Switching map in under 2 s.
- No visible stutter the first time a weapon fires, a grenade explodes or a
  new player model appears.

## What the frame costs today

Two read-only inventories (GPU and CPU) and headless runs of all five maps
found the following. "No setting" means nothing a player can change controls
it.

### GPU

1. **Material shading** is the largest per-pixel cost. The shared material
   shader (`src/gfx/materials/shader.js`) layers parallax occlusion (up to 22
   height steps, loop cap 48) on 14 surfaces, de-tiling (+4 fetches),
   triplanar on the ground and every weapon (9 base fetches), plus detail,
   macro, macro-relief, weathering and cloth layers: about 40 texture fetches
   per pixel near the camera, before lighting. Low only halves the texture
   size. *No setting.*
2. **Point lights.** Every lit pixel loops over 9-18 point lights: 7 are
   always present (5 pooled effect lights at `src/effects/effects.js:593`,
   two bomb lights), the rest are map lamps (Neon Foundry has 11). Measured:
   13-22 lights in the scene per map. *No setting.*
3. **Shadow map.** 3072x3072 (76 MB with depth) on High, redrawn every frame
   on desktops, fitted to the whole arena so every caster (186-350 per map)
   is drawn into it each frame, then sampled with a 16-17 tap PCF kernel in
   every lit pixel. Low uses 2048. Only phones redraw it every other frame.
4. **Resolution.** Pixel ratio up to 1.5 on desktop; the only way below 1.0
   was none. Auto-graphics can cap at 1.0 mid-match.
5. **HDR post chain (High).** Full-resolution half-float target with 4x MSAA,
   6-level bloom pyramid, composite, and SSAO: a second full geometry pass
   plus three half-resolution passes. All or nothing via the preset.
6. **Geometry.** About 1.3-1.8 M triangles drawn in up to three passes
   (shadow, SSAO depth, colour). The world is merged into whole-map batches,
   so frustum culling never rejects anything; there is no LOD or instancing.
   Each bot's held rifle is about 40k triangles.
7. **Sky.** The visible sky is re-baked from the full atmosphere and clouds
   into a 2048x1024 texture every 0.4 s on High: a periodic spike on a weak
   GPU.
8. **Canvas MSAA on Low** (the context's own 4x) and a full-screen sky dome
   drawn with depth test off before the world.
9. **Shader programs.** 69-147 programs per session (measured), all compiled
   on first use; nothing is pre-warmed.

### CPU

1. **Map dressing** builds 930-1,200 props synchronously on every map load:
   0.9-2.0 s on this container's 2.1 GHz Xeon, likely 2-4 s on a Chromebook.
2. **Texture bakes**: about 37 procedural texture sets, each its own shader
   program compiled synchronously, inside the boot task.
3. **Shader compiles** on the first frame, at PLAY and at first use of each
   effect (`renderer.compile`/`compileAsync` are never called).
4. **Weapon builds**: 9 procedural guns built one per animation frame after
   boot, 40-300 ms each: a string of long tasks in the menu.
5. **Bot perception** casts rays against every one of the map's 212-321 box
   meshes with no spatial index (33-80 µs per ray), O(n²) over the roster;
   about 500 rays/s at 10 Hz thinking.
6. **Three scene submissions per frame on High** (shadow, SSAO depth, colour),
   each re-walking 290-450 static objects' matrices. The SSAO pass also hides
   the effects' lights, which changes the light hash twice a frame and makes
   three re-validate every lit material's program each frame.
7. **Bot animation**: 9 mixers plus spine/aim passes and hand IK with a
   whole-rig matrix update per bot per frame; no distance or off-screen LOD.
8. **Sub-stepping** re-runs every system (HUD, audio, sky, viewmodel), not
   just physics, up to 3 times a frame below 20 fps, which deepens a slowdown.
9. **HUD per-frame work**: a crosshair ray and capsule test every frame,
   unguarded style writes for teammate tags, an `innerHTML` rebuild every
   frame while the use-hint shows, a 20 Hz radar canvas redraw.
10. **Boot is one long task** with no yields: the loading bar sits at 38%
    for the whole world build, and nothing (bakes, dressing, shaders) is
    cached across reloads.

Smaller items: every gunshot builds 10-20 Web Audio nodes; the grenade GLBs
are fetched twice; sightlines are built mid-round on the first scan
(10-38 ms); the menu rendered the full scene every frame behind an opaque
overlay (fixed in phase 0).

### Measured (headless, software rendering)

Resource counts per map on High (1280x720, pixel ratio 1):

| Map | Meshes | Skinned | Shadow casters | Lights | Programs | Textures |
|---|---|---|---|---|---|---|
| Dustyard | 827 | 48 | 350 | 14 | 69 | 111 |
| Frostline | 667 | 48 | 186 | 13 | 105 | 122 |
| Neon Foundry | 783 | 48 | 257 | 22 | 139 | 126 |
| Harbor | 752 | 48 | 216 | 14 | 140 | 121 |
| Citadel | 716 | 48 | 242 | 13 | 147 | 128 |

Programs and textures accumulate across maps in one session (the counts
above are cumulative in visiting order).

PRESET_COST_TABLE

## Graphics presets

Every preset keeps the map layout, props and cover identical: they are
gameplay (`src/world/dressing.js:4226`).

| Knob | High | Low | Chromebook (new) |
|---|---|---|---|
| Render scale | 1.0, pixel ratio up to 1.5 | 1.0, up to 1.5 | 0.8, pixel ratio 1 |
| HDR post, bloom, SSAO | on | off | off |
| Antialiasing | MSAA in the post chain | canvas MSAA | none |
| Shadow map | 3072, soft PCF, every frame | 2048, soft PCF, every frame | 1024, hard (1 tap), every other frame |
| Texture sets | 1024 | 512 | 512 |
| Material layers | all | all | no parallax, de-tiling, macro relief, sheen, anisotropy |
| Anisotropic filtering | 8x | 8x | 4x |
| Effect point lights (muzzle, explosions, bomb) | on | on | off (flash sprites stay) |
| Map lamps | on | on | off (fixtures still glow) |
| Sky re-bake | 2048, every 0.4 s | 512, every 0.8 s | 512, every 3 s |
| Rain and snow | 100% | 50% | 30% |

**Auto** chooses at load:
- a Chromebook, unless its GPU is an Iris Xe class part, and any device whose
  GPU is a known low-power part (Mali, PowerVR, older Adreno) or a software
  renderer: **Chromebook**;
- a phone or tablet, or a desktop with an older Intel HD/UHD GPU: **Low**;
- everything else: **High**.

ChromeOS is read from `navigator.userAgentData.platform`, falling back to
`CrOS` in the user agent. The GPU name comes from `WEBGL_debug_renderer_info`
on a throwaway context, before the real renderer is created.

During a match on Auto, a device under 40 fps for 6 s drops SSAO, then caps
the pixel ratio at 1, then remembers the next lighter preset for its next
visit (High, then Low, then Chromebook). Picking a preset by hand clears that
memory.

### A Medium preset (phase 4)

The gap between High and Low is large: Low loses bloom and SSAO and keeps
the expensive material layers. Medium would be the post chain without SSAO,
FXAA instead of MSAA, a 2048 shadow map, 1024 textures and parallax limited
to 8 steps. It needs the per-layer switches from phase 2 first.

## Settings

Today: one **Graphics** select (Auto / High / Low / Chromebook / Low-power).
It shows what Auto picked ("AUTO · USING CHROMEBOOK / LOW-POWER") and, when
the choice changes, "APPLIES AFTER RELOAD" with a RELOAD NOW button on the
main menu.

Proposed **Advanced graphics** panel (phase 3), each control overriding the
preset and marked "custom" once touched:

| Control | Values | Applies |
|---|---|---|
| Render scale | 50-100% in 5% steps, plus Auto (dynamic) | live |
| Frame rate cap | 30 / 60 / unlimited | live |
| Shadows | Off / Low (1024 hard) / Medium (2048) / High (3072 soft) | on reload |
| Lighting effects | muzzle and explosion lights on/off | on reload |
| Surface detail | Low (lite layers) / High | on reload |
| Texture quality | Low (512) / High (1024) | on reload |
| Post effects | bloom and SSAO on/off | on reload |
| Show FPS | on/off | live |

Live controls must never change the number of lights, shader defines or
shadow type during a match: those trigger shader recompiles (a hitch). The
reload-only ones say so beside the control.

## The work, in phases

Each phase ends with the headless measurement re-run (resource counts,
forced-sync frame cost per preset) and, from phase 1, a check on a real
Chromebook.

### Phase 0: Chromebook preset (done)

- `src/gfx/profiles.js`: the preset tables, ChromeOS and GPU detection, the
  Auto choice.
- Settings: Chromebook option, Auto's remembered floor (`graphicsAutoFloor`,
  migrating the older `graphicsAutoLow` flag), what-Auto-picked note and a
  reload button.
- Renderer: render scale below 1, MSAA per preset, hard shadows and the
  every-other-frame shadow cadence per preset.
- Materials: lite shading switch; sky and precipitation sizes per preset;
  effect and map lights hidden for the session on Chromebook.
- Auto-graphics steps down one preset per visit, down to Chromebook.
- The scene renders 4 times a second behind the opaque menu and end screens.

### Phase 1: quick wins (all presets, low risk)

1. Stop the SSAO pass hiding the effects' lights (hide the effect meshes
   instead): removes the per-frame program re-validation of every lit
   material on High (`src/gfx/post/ssao.js:553`).
2. Sub-step physics and movement only; run HUD, audio, sky, effects and the
   viewmodel once per frame (`src/main.js` loop).
3. `matrixAutoUpdate = false` on static world meshes after the map is built.
4. HUD: guard the teammate tag style writes, cache the use-hint markup, drop
   the per-frame crosshair ray to 20 Hz, stop allocating arrays per frame in
   `_updateTags` and the radar.
5. Fetch each grenade GLB once (semtex and stun alias them).
6. Build bot sightlines at map load instead of on the first scan.
7. A `?perf` overlay: fps, frame time, draw calls, triangles, programs,
   preset, pixel ratio; and a Show FPS setting.
8. Fix the stale comments (sky texture sizes, viewScene).

### Phase 2: load time and first-use hitches

1. **Shader pre-warm**: after a map is built, `renderer.compileAsync(scene,
   camera)` with every effect, bot, held gun and grenade present but
   invisible, behind the loading bar. Removes the hitches at PLAY and at the
   first explosion. Uses `KHR_parallel_shader_compile` where available.
2. **Yielding boot**: split the boot into stages that yield to the browser
   (`await` a frame between sky, materials, map, dressing, models), so the
   progress bar moves and the tab stays responsive.
3. **Weapon builds** in `requestIdleCallback` slices, and only the equipped
   loadout before the first match; the rest on demand.
4. **Per-layer material switches** (parallax steps, de-tiling, triplanar,
   detail) so presets and the advanced panel can mix them, and Low can drop
   parallax to 8 steps.
5. **Cache across visits**: store baked texture sets (RGBA8 + mips) in
   IndexedDB keyed by surface, size and generator version, so a second visit
   skips the bakes. Budget: about 80 MB on Low, 300 MB on High; evict by LRU,
   and skip when storage is constrained.
6. Dressing cost: profile `dressMap`, cache its output per map and preset
   (it is deterministic), or move the geometry build to a worker.

### Phase 3: CPU scaling

1. **Raycast index**: a uniform grid (or BVH) over the world's boxes for
   `World.raycast`, bot sight checks and bullets. Expect 5-20x fewer
   box tests per ray.
2. **Perception budget**: cap sight rays per frame across all bots, round
   robin; skip candidates outside engagement range before the ray.
3. **Animation LOD**: update the mixers of off-screen bots at 10 Hz and of
   bots beyond 30 m at 20 Hz; skip IK beyond 15 m on Low and Chromebook.
4. **Audio**: a per-preset voice cap and pooled noise buffers; Chromebook
   drops the echo and air layers on distant shots.
5. **Advanced graphics panel** (see Settings), with live render scale and a
   frame-rate cap.
6. **Dynamic resolution** for Auto: hold a target frame time by moving render
   scale between 0.7 and 1.0, a step every few seconds, never mid-firefight.

### Phase 4: GPU scaling

1. **Culling**: split the whole-map batches into spatial chunks (about 20 m
   cells) so frustum culling works; fit the shadow camera to the view instead
   of the whole arena on Low and Chromebook.
2. **LOD for held guns**: a few-hundred-triangle proxy for third-person
   rifles beyond 15 m (each is about 40k triangles today).
3. **Medium preset** (see above).
4. **Light budget**: on High, merge the 5 effect lights into 2; on all
   presets, cull map lamps by distance into a fixed budget so the light count
   stays constant (constant count, varying positions: no recompiles).
5. **Shadow casters**: skip small dressing props in the shadow pass on Low
   and Chromebook.

### Phase 5: keep it fast

1. Check the measurement harness into `tools/` (`npm run perf`): boot time,
   map load, resource counts and forced-sync frame cost per preset and map,
   written as JSON.
2. A CI budget check on draw calls, triangles, programs and texture count per
   preset, failing on a regression over 10%.
3. A real-device matrix before each release: one Mali Chromebook, one Intel
   N-series Chromebook, an Intel UHD Windows laptop, a mid-range Android
   phone, an iPad, and a desktop GPU.

## Risks

- **Detection**: a GPU name can be hidden (Firefox, privacy settings). Auto
  then falls back to ChromeOS and touch detection, and auto-graphics catches
  the rest within one visit.
- **Looks**: the Chromebook preset is visibly simpler (hard shadow edges,
  flatter surfaces, dark lamp interiors on Neon Foundry). It must stay
  readable: enemies, cover and objectives are unchanged.
- **Recompiles**: anything changed live must not change light count, shader
  defines or shadow type; those stay reload-only.
- **Measurement**: software rendering in CI measures pixel-shading cost, not
  a real GPU's bandwidth or driver behaviour. Real Chromebooks remain the
  final check.
