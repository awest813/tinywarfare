# Performance and graphics options plan

Status: phase 0 (the Chromebook preset) is built, and most of phase 1;
the rest is proposed.
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

Frame cost per preset. Each frame is forced to finish (a 1-pixel read-back)
and timed, the match paused so every frame draws the same view. Software
rendering runs shaders on the CPU, so absolute times are meaningless, but
the ratios track pixel-shading cost, which is what limits a Chromebook GPU:

| Preset | Dustyard frame | Neon Foundry frame | Draw calls | Triangles | Lit lights | Drawing buffer | Map load |
|---|---|---|---|---|---|---|---|
| High | 9.4 s | 10.3 s | 466-498 | 2.4 M | 14-22 | 1280x720 | 232-320 s |
| Low | 7.5 s | 9.0 s | 234-256 | 1.2 M | 14-22 | 1280x720 | 196-305 s |
| Chromebook | 1.9 s (5x less) | 1.4 s (6x less) | 235-266 | 1.2-1.3 M | 5 | 1024x576 | 49-84 s |

High draws twice the geometry of Low (the SSAO depth pass). Chromebook's
gain over Low is about 1.6x from resolution and the rest from the shading:
no lamp or effect lights in the light loop, a 4-tap shadow filter instead
of 16, and the lite material layers. Its map loads are 4x faster: fewer and
cheaper shader programs (57-62 against 62-110) and smaller texture bakes.

## Graphics presets

Every preset keeps the map layout, props and cover identical: they are
gameplay (`src/world/dressing.js:4226`).

| Knob | High | Low | Chromebook (new) |
|---|---|---|---|
| Render scale | 1.0, pixel ratio up to 1.5 | 1.0, up to 1.5 | 0.8, pixel ratio 1 |
| HDR post, bloom, SSAO | on | off | off |
| Antialiasing | MSAA in the post chain | canvas MSAA | none |
| Shadow map | 3072, soft PCF (16 taps), every frame | 2048, soft PCF, every other frame | 1024, bilinear (4 taps), every other frame |
| Texture sets | 1024 | 512 | 512 |
| Material layers | all | all | no parallax, de-tiling, macro relief, sheen, anisotropy |
| Anisotropic filtering | 8x | 8x | 4x |
| Effect point lights (muzzle, explosions, bomb) | on | on | off (flash sprites stay) |
| Map lamps | on | on | off (fixtures still glow; their light returns as flat ambient fill) |
| Sky re-bake | 2048, every 0.4 s | 512, every 0.8 s | 512, every 3 s |
| Rain and snow | 100% | 50% | 30% |

**Auto** chooses at load, in this order:
1. a software renderer (SwiftShader, llvmpipe): **Chromebook**;
2. ChromeOS, laptop or tablet: **Chromebook**, unless the GPU is an Iris Xe,
   Radeon Vega, Arc or Adreno 630+ class part (then **High**, or **Low** in
   tablet mode). Stoney Ridge Radeon R2-R7 and Snapdragon 7c (Adreno 618)
   count as low-power;
3. a phone or tablet: **Low** (recent flagships use Mali GPUs, so phones are
   not judged by GPU name);
4. a laptop or desktop with a low-power GPU (Mali, PowerVR, Adreno below
   630, Stoney Ridge): **Chromebook**; with an older Intel HD/UHD: **Low**;
5. everything else: **High**.

ChromeOS is read from `navigator.userAgentData.platform`, falling back to
`CrOS` in the user agent. The GPU name comes from `WEBGL_debug_renderer_info`
on a throwaway context, created before the real renderer and only when the
Graphics setting is Auto.

During a match on Auto, a device under 40 fps for 6 s drops SSAO, then caps
the pixel ratio at 1, then remembers the next lighter preset for its next
visit (High, then Low, then Chromebook). Picking a preset by hand clears that
memory.

### Medium preset (built, first cut)

Medium is the post chain and bloom without SSAO (no second geometry pass),
a 2048 soft shadow map, pixel ratio capped at 1.25, a 1024 sky re-baked
every second, 75% precipitation and 85% effects density. Auto now picks
Medium wherever it used to pick High; High is only used when chosen. Low's
pixel-ratio cap went from 1.5 to 1.25. Limiting parallax to 8 steps still
needs the per-layer switches from phase 2.

### Render scale (built)

Settings > Picture > Render scale: Auto (the far-left notch: the preset's
own scale) or 50-100% in 5% steps, applied live (only the drawing buffer is
resized). On Auto, auto-graphics adds a third step after the pixel-ratio
cap: render scale 75%, before it remembers the next lighter preset.

### Per-pixel budget pass (built)

A CPU audit (8 bots, live match, rendering stubbed out) put every system
together at about 0.6 ms a frame, the bots' animation and thinking the
largest at about 0.2 ms each, so the frame is GPU-bound and this pass
targets per-pixel cost:

- **Dead lights removed.** Map lamps authored at intensity 0 (six on Neon
  Foundry) are hidden on every preset; they lit nothing but were a loop
  iteration in every lit pixel. The two C4 lights exist only in Search &
  Destroy (set at match start, before the shader pre-warm).
- **Effect light slots.** Medium and Low share one light among explosions
  and flashbangs (3 effect lights instead of 5); the brighter flash wins.
- **Parallax budget.** Medium caps the march at 12 height steps and runs it
  to 70% of each surface's fade distance; Low 8 steps and 50%. Uniforms
  only, no new programs.
- **Shadows** are redrawn every other frame on Medium and Low (they were
  already on phones and Chromebook).
- **Medium antialiasing** is FXAA, skipping the resolve of a 4x
  multisampled half-float target.
- **Frame rate cap** (Settings > Picture): none, 30, 60 or 120. Auto
  graphics does not count a capped frame rate as a slow device.

## Settings

Today: a **Graphics** row (Auto / High / Medium / Low / Low power), which
shows what Auto picked ("AUTO · USING LOW POWER") and, when the choice
changes, "APPLIES AFTER RELOAD" with a RELOAD NOW button on the main menu;
a live **Render scale** slider (Auto, 50-100%); and a live **Frame rate
cap** (none / 30 / 60 / 120).

Proposed **Advanced graphics** panel (phase 3), each control overriding the
preset and marked "custom" once touched:

| Control | Values | Applies |
|---|---|---|
| Shadows | Off / Low (1024 bilinear) / Medium (2048) / High (3072 soft) | on reload |
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
- Renderer: render scale below 1, MSAA per preset, a 4-tap bilinear shadow
  filter (`src/gfx/shadow-bilinear.js`) and the every-other-frame shadow
  cadence per preset.
- Materials: lite shading switch; sky and precipitation sizes per preset;
  effect and map lights hidden for the session on Chromebook, with the
  lamps' light returned as flat ambient fill so night maps stay readable.
- Auto-graphics steps down one preset per visit, down to Chromebook.
- The scene renders 4 times a second behind the opaque menu and end screens.

### Phase 1: quick wins (all presets, low risk)

Done:
1. The SSAO pass hides the effects' drawables but not their lights,
   removing the per-frame program re-validation of every lit material on
   High; rain and snow are kept out of the depth pass too.
2. Only gameplay is sub-stepped; the sky, effects, HUD, audio and material
   housekeeping run once per frame.
3. World meshes stop recomposing their matrices once the map is built.
4. HUD: the crosshair's enemy raycast runs at 20 Hz; teammate tags reuse
   their array and only write styles when they move; the use-hint markup is
   cached; the radar redraws at 10 Hz on the Chromebook preset.
5. Grenade models shared by two weapons are fetched and parsed once.
6. Bot sightlines are built at map load and round start.
7. A Show FPS setting (frame rate and frame time in the corner).
8. Stale sky comments corrected.
9. A `?perf` URL flag: the readout adds the preset, the frame's draw calls
   and triangles summed over every pass, shader programs and pixel ratio.

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
