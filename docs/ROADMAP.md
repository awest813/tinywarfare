# Tiny Warfare roadmap

Goal: turn the Tiny Strike fork (a round-based, Counter-Strike-style bomb
defusal FPS) into a **mini modern-military arcade shooter**: fast respawn
modes, create-a-class loadouts, ADS/sprint/slide movement, scorestreaks, and
XP unlocks, while keeping it a no-build, runs-in-a-tab web game.

The existing bomb mode is not thrown away: it becomes **Search & Destroy**,
the one round-based mode in the playlist.

## Where things stand (audit, 2026-10-13)

The codebase is large (about 56k lines), well tested (296 tests, all
passing), and boots cleanly in a headless browser with no console errors.

### Fixed in the audit pass

- **Server:** a malformed URL (`/%E0%A4%A`) crashed the Node server. The
  static handler also served the whole repo root, including `.git/`,
  `server.mjs`, and `.tiny-strike/leaderboard.json` with player data. Static
  serving is now an allowlist (`index.html`, `src/`, `assets/`,
  `node_modules/three/`, `tools/`, `qa/`) that rejects every dot-segment.
- **Input:** holding Shift (walk) turned `1`–`9` into `!@#…`. That blocked
  weapon switching while walking and could leave a digit stuck down. Digits are
  now matched by key position. Releasing Cmd on macOS now drops held keys,
  because macOS never sends their keyup.
- **Rounds:** dying no longer keeps your armor into the next round. A replayed
  `roundEnd` snapshot can no longer pay round money twice on clients.
- **Weapons:** the fire rate no longer rounds every shot gap up to a whole
  frame. An MP5 at 30 fps fired about 600 rpm instead of 750.
- **Loader:** a stray resource error or a rejected background fetch during boot
  could leave the loading overlay on screen forever. The first rendered frame
  now clears it.
- **Branding:** visible strings, package metadata, README and SECURITY now say
  Tiny Warfare. Storage keys and `TINY_STRIKE_*` env/globals are unchanged, so
  saved settings, careers, and tests keep working.

### Deferred audit findings

| Finding | Where | Why deferred |
|---|---|---|
| Frame time capped at 50 ms: below 20 fps everything runs in slow motion, including a host's round clock, and the FPS counter reports the capped value | `src/main.js:244` | Needs fixed-step sub-stepping; do it with the Phase 2 movement work |
| Jump peak depends on frame rate (about 23% lower at the cap) | `src/player/player.js:501` | Same as above |
| Keyboard still drives gameplay after Esc releases the pointer | `src/core/input.js:483` | Touch play uses a virtual lock; needs care |
| Shots follow the camera, so view punch and shake move bullets | `src/weapons/weapons.js:635` | Deliberate CS-style aim punch; revisit when ADS lands |
| Wall penetration can skip a player standing between two thin walls | `src/combat/combat.js:474` | Rare |
| No per-IP rate limiting on the Node server (the Worker has it) | `server.mjs` | Matters only for self-hosting |
| About 325 MB of trailer MP4s in git history | repo root | Needs `git filter-repo` and a force push; owner's call |
| Deploy config still points at the upstream author's domain and Worker | `wrangler.jsonc`, `worker/index.mjs:30`, `server.mjs` origins | Pick a host first |
| Upstream's open visual defects: floating Dustyard crate, grey backdrop boxes, tiling concrete stains, low-quality dressing LOD | see `HANDOFF.md` | Content pass |

Not a bug: a ray that touches the head sphere counts as a headshot even if it
also crosses the body capsule first. The body capsule rises into the head on
purpose (`combat.js:694`). "Fixing" this would turn most level headshots into
body hits.

## Architecture moves that unlock everything

Three couplings block every MW-style feature. Do these first:

1. **Game-mode strategy.** `src/game/rounds.js` is one hard-coded phase
   machine: `menu → freeze → live → planted → roundEnd → gameEnd`. Bomb,
   economy, and win checks are mixed together inside it. Extract a mode
   interface (`onStart`, `onKill`, `onDeath`, `update`, `checkWin`,
   `snapshot`, `applySnapshot`, `hud`) and move the existing logic into
   `modes/search-destroy.js`.
2. **Per-actor respawn.** Death is currently final for the round. Add a
   respawn timer with spawn scoring (far from enemies, near teammates, out of
   enemy sight lines) for both the player and bots. The per-bot
   `_respawnBot` (`src/ai/bots.js:1724`) can be reused. In respawn modes,
   `player/spectator.js` gives way to a death screen with a killcam.
3. **Bot objective dispatch.** `bots._think` has a generic
   perceive/engage/investigate core (`bots.js:2505-2625`), then branches into
   bomb-only `_thinkT` and `_thinkCT` (about 160 bomb references). Add a
   `_thinkObjective` that each mode provides: hunt/roam for TDM, capture and
   hold for Domination, collect tags for Kill Confirmed.
   `ai/tactics.js` is already mode-agnostic.

Two smaller ones ride along:

- **Network snapshot:** move the bomb fields under a mode-specific payload
  (`multiplayer.js:2086-2105`). In respawn modes, joining spawns you instead
  of spectating until the next round.
- **Result validation:** `leaderboard-core.mjs:337-361` assumes scores of 0–8
  and `roundsPlayed == ct + t`. Generalise it per mode before TDM results
  can be ranked.

## Phases

Each phase ships a playable build and keeps `npm test` green.

### Phase 1: Team Deathmatch (the first MW-feeling build)
- Mode interface plus Search & Destroy extraction (behaviour unchanged).
- TDM: score limit of 50 kills or 10 minutes, respawn after 3 s, spawn
  protection, spawn scoring.
- In TDM the buy menu is replaced by a fixed starter class. Money, the economy
  and kill rewards are bypassed, not deleted.
- Bot hunt/roam objective; bots respawn on the same timer.
- Mode picker on the main menu next to the map cards; online rooms carry the
  mode.
- HUD: kill-score bar instead of the round counter, "+100" score popups, and a
  respawn countdown.

### Phase 2: Movement and gunfeel
- **Sprint** becomes the default on Shift (hold or toggle in settings). Walk
  moves to a rebindable key. Add a sprint-to-fire delay per weapon class and
  no firing while sprinting.
- **ADS on every weapon:** `adsFov`, ADS time, a spread multiplier, a move
  speed penalty, and an ADS viewmodel pose in `weapons/viewmodel.js`. The
  AWP keeps its scope levels. Right-click hold or toggle.
- **Slide** from sprint plus crouch, with a short cooldown. Optional mantle onto
  waist-high crates, which the maps already have plenty of.
- Fixed-timestep simulation, which fixes the slow-motion and jump-height
  findings above.
- Feel: visible recoil that tracks the drift, an 80 ms input buffer for
  semi-auto and ADS clicks, ramped jump and crouch inaccuracy, and a landing
  penalty.
- Hitmarker variants (body, head, kill) with audio, including hits on remote
  players.

### Phase 3: Create-a-class
- Class slots: primary, secondary, lethal, tactical, and three perks. Five
  default classes plus editable custom classes stored in `player/profile.js`.
  A class picker appears on the death screen and applies on the next spawn.
- New lethals and tacticals in `weapons/data.js` and `combat.js`: frag (from HE),
  semtex (sticks), flash and smoke (existing), stun (slows), and a claymore
  later.
- Perks (first set): faster sprint recovery, quieter footsteps (the footstep
  system already exists), resistance to explosives, hidden from UAV, and faster
  reloads. Hook points: `player.js` speed, `combat.js` damage, audio cues,
  and radar visibility.
- Weapon roster: keep the seven procedural guns. Add a shotgun and an LMG using
  the parts kit in `gfx/weapons/parts.js` and `build.js`.

### Phase 4: Scorestreaks
- Streaks are earned by score, not kills, so objective play counts. The player
  picks three.
- **UAV** (sweeps the existing `hud.js` radar), **Counter-UAV** (jams the
  enemy radar), **Precision Airstrike** (map-marker targeting; reuses the bomb
  blast radial damage plus `effects.js` explosions and a synthesized jet flyby
  in `audio.js`), and later a **Care Package**.
- Bots use streaks through a simple trigger.
- Network: streak activations are host-authoritative events.

### Phase 5: Progression and attachments
- Per-match XP from kills, assists, objectives, and streaks, with
  end-of-match XP breakdown. This hooks into the existing
  `xpForLevel`/`levelFromXp` and career system.
- Rank unlocks for weapons, perks, and streaks; weapon levels unlock
  attachments.
- Attachments as stat modifiers plus mesh parts: red dot, holo,
  suppressor (hides you from radar when firing), extended magazine, foregrip,
  and laser.
- Challenges and calling cards can reuse the achievement catalog and daily
  contract.

### Phase 6: More modes
- **Domination:** three flags. Each map's A, B, and mid points become the
  flags, and bots get capture and hold goals.
- **Kill Confirmed:** dog-tag pickups.
- **Free-for-all**, then **Hardpoint**.
- **Search & Destroy** (the existing bomb mode) keeps its economy, or swaps to
  classes. That is a design choice for later.

### Phase 7: Presentation
- Factions: replace CT/T with two modern factions (names, colours, HUD copy,
  and announcer lines; synthesized radio barks fit the WebAudio approach).
  Character GLBs are CC0 and can be re-tinted.
- HUD restyle toward a modern-military look, killcam (a short ring buffer of
  actor poses replayed from the killer's view), play-of-the-game and podium,
  and a match-end scoreboard with K/D/score.
- Map pass: the upstream note "space is generated, not authored" still
  holds. Add landmarks, hero props, and asymmetry, and fix the known visual
  defects. Smaller TDM-friendly variants with three lanes help respawn flow.

### Ongoing tech debt
- Split `src/ui/hud.js` (4.6k lines, about 1.3k of them CSS-in-JS).
- Slim the repo (trailer history) and set this fork's own deploy target,
  allowed origins, and service names.
- Cap `pixelRatio` around 1.5 on high-DPI screens. Rebuild a real low-quality
  dressing LOD.
- Rate-limit room creation and leaderboard sessions on the Node server.

## Decisions needed from the owner

1. **Walk key:** OK to make Shift sprint by default (MW convention) and
   move walk to another key?
2. **Economy:** keep money and the buy menu in Search & Destroy only, or use
   classes everywhere?
3. **Faction names and setting**, for the art and HUD copy.
4. **Hosting:** where this fork deploys (GitHub Pages plus Cloudflare Worker
   like upstream, or elsewhere). This blocks online play outside localhost.
5. **History rewrite** to drop the trailer MP4s. It needs a force push to
   `main`.
