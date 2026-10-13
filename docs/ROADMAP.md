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
- **Factions:** the setting is a modern U.S. vs Russia conflict. All
  player-facing team text comes from `src/shared/factions.js`: **U.S. FORCES**
  (`ct`, defenders) vs **RUSSIAN FORCES** (`t`, attackers). This covers HUD
  scores, the scoreboard, round and match banners, spectator text, and the
  lobby. The team ids `ct`/`t` stay in gameplay, network, storage, and
  leaderboard code.
- **Frame rate:** the simulation now sub-steps slow frames, in steps of at most
  50 ms and up to 150 ms of catch-up, instead of dropping time. Below 20 fps
  the round clock keeps real time. The FPS counter reports real frames. Jumps
  use exact constant-gravity integration, so the apex is the tuned 0.484 m at
  any frame rate (it had been about 0.447 m at 60 fps).
- **Server limits:** at most 32 sockets per IP and 500 rooms, set with
  `TINY_STRIKE_MAX_SOCKETS_PER_IP` and `TINY_STRIKE_MAX_ROOMS` (0 disables).
- **Dustyard:** the floating crate on the CT ramp now sits on a support crate,
  which restores the intended climb onto A.
- **UI:** the buy menu is a labelled dialog. The profile inputs show a visible
  keyboard focus ring.

### Deferred audit findings

| Finding | Where | Why deferred |
|---|---|---|
| Keyboard still drives gameplay after Esc releases the pointer | `src/core/input.js:483` | Touch play uses a virtual lock, and the buy menu runs unlocked; needs care |
| Shots follow the camera, so view punch and shake move bullets | `src/weapons/weapons.js:635` | Deliberate CS-style aim punch; revisit when ADS lands |
| Wall penetration can skip a player standing between two thin walls | `src/combat/combat.js:474` | Rare |
| No per-message rate limit on the Node server's sockets | `server.mjs` | Payloads are capped at 64 KB; low impact |
| About 325 MB of trailer MP4s in git history | repo root | Needs `git filter-repo` and a force push; owner's call |
| Deploy config still points at the upstream author's domain and Worker | `wrangler.jsonc`, `worker/index.mjs:30`, `server.mjs` origins | Pick a host first |
| Upstream's open visual defects: grey backdrop boxes, tiling concrete stains, low-quality dressing LOD | see `HANDOFF.md` | Content pass |

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
Shipped for solo play (`src/game/tdm.js`):
- Pick TDM in the menu's MODE row. The choice is saved in `tiny-strike-mode`.
- A 50-kill score limit and a 10-minute clock; a level score when time runs
  out is a stalemate.
- Respawn after 3 s for the player and bots. Spawn scoring uses every team
  spawn and nav node: at least 16 m from living enemies, out of their line of
  sight, near a teammate, and facing the nearest enemy.
- Fixed starter class: M4A1 or AK-47, team pistol, and a frag. No buying,
  money, or armor. The money panel is hidden.
- Bots use a hunt objective (`_thinkHunt`), mostly heading toward the nearest
  enemy, with rifle, SMG, and at most one sniper per side.
- HUD shows "TEAM DEATHMATCH · FIRST TO 50", a get-ready banner, a
  "RESPAWNING IN N" death screen, and draw handling on the end screen.
- TDM results are deliberately unranked. Server validation only understands
  round results.
- A simulated three-minute match plays through with no console errors: about 50
  kills, all spawns valid, and the match ends at the limit.

Still to do for Phase 1:
- Online TDM. The room protocol and `rooms-core` need a mode field, the
  network snapshot needs mode state, and late joiners should spawn instead of
  spectate. Online rooms are pinned to S&D for now.
- Ranked TDM: generalise `leaderboard-core.mjs` result validation per mode.
- Spawn protection, "+100" score popups, and a killcam or death recap.
- Extract S&D out of `rounds.js` behind the same mode interface. TDM
  currently plugs in as a delegate.

### Phase 2: Movement and gunfeel
Shipped:
- **Sprint** is on Shift: 6.7 m/s, forward only. Firing, aiming, scoping, or a
  grenade wind-up breaks it. A per-class sprint-out delay comes before the
  first shot (rifles 0.22 s, pistols 0.13 s, AWP 0.32 s), and a click made
  during sprint-out fires when the delay ends.
  - Walk moved to C. Saved layouts with Walk on Shift migrate to Sprint on
    Shift and Walk on C.
  - On touch, pushing the stick fully forward sprints.
- **ADS on every non-sniper gun**: hold right mouse. ADS takes 0.22 s on
  rifles and SMGs and 0.15 s on pistols. At full ADS:
  - FOV narrows 20% (pistols 12%), and look sensitivity scales with the FOV.
  - Spread is ×0.55 and movement speed ×0.72.
  - The crosshair lines fade, leaving the centre dot.
  - The viewmodel pose is centred, with a per-gun trim measured from renders
    so each sight lands on the screen centre. Sway and bob are mostly
    suppressed.
  - Hip-fire tuning is unchanged. The AWP keeps its scope.
- **Slide**: crouch out of a grounded sprint launches an 8.4 m/s committed
  slide (0.8 s, low friction, no steering). It ends early below 2.6 m/s.
  Slide-jump keeps the speed. Cooldown is 0.9 s.
- The viewmodel carries the gun low and across the chest while sprinting.
  The crosshair hides while sprinting.
- Fixed-step simulation and exact jump integration (see the audit section).

Also shipped:
- **Visible recoil**: the camera shows 60% of the spray drift, so the view
  climbs with the spray. Bullets carry the other 40% as an offset, so the
  total deviation is unchanged. The cosmetic kick is lighter to match.
- **Input buffer**: semi-auto clicks during the fire cooldown, and AWP scope
  clicks during a raise, wait up to 80 ms (scope up to 320 ms) instead of
  being dropped.
- **Ramped inaccuracy**:
  - The jump penalty ramps in over 0.15 s.
  - Landing leaves a 0.3 s tail at half the jump penalty.
  - Crouch accuracy follows the crouch animation.
- **Mantle**: jump while moving into a ledge 0.6-1.45 m tall that has room on
  top. It gives an exact upward boost plus a forward carry, with collision
  still on.
- `sprinting` and `sliding` replicate to remote players (via `rooms-core`).
  A remote slide shows as a crouch.

### Phase 3: Create-a-class
Shipped for solo TDM (`src/game/loadouts.js`):
- Five editable classes: Assault, Close Quarters, Recon Sniper, Rifleman,
  Custom. Each has a primary (M4A1, AK-47, MP5, AWP), a secondary (USP, Glock,
  Deagle), a frag, a tactical (flash or smoke), and one perk.
  - Classes are saved in `tiny-strike-classes-v1`. Stored values are
    sanitised against the allowed lists.
- The menu shows a CLASS row when TDM is selected, with an inline editor:
  name, selects, perk description, and reset. While dead, keys 1-5 pick the
  next life's class, and the death screen shows it.
- Perks:
  - **Lightweight**: +8% movement and sprint speed.
  - **Quick Hands**: 35% faster reloads and 40% faster swaps.
  - **Ghost**: hidden from the enemy UAV hunt, and bots hear your footsteps at
    45% range.
  - **Flak Jacket**: 55% less damage from frags, airstrikes, and C4.
- Any faction can use any gun.

Also shipped:
- **Two perk slots** (one per tier). A stored single-perk class holding a
  tier-2 perk migrates it into slot two.
  - Tier 1: Lightweight, Quick Hands, and **Scavenger** (each kill refills a
    magazine of reserve on both guns).
  - Tier 2: Ghost, Flak Jacket, and **Hardline** (streaks cost 20% less).
- **New lethal and tactical**:
  - **Semtex** sticks to the first surface or enemy it touches. It detonates
    on a 2 s fuse from the throw, and is lethal to an enemy it is stuck to.
  - **Stun** slows a caught player's movement (×0.5) and look (×0.35) for
    up to 3.8 s. Stunned bots move and turn at ×0.4 with a delayed reaction.
- **New guns**, procedurally derived from the AR receiver: the **M1014**
  shotgun (8 pellets with steep falloff) and the **M249 SAW** LMG (100-round
  box, slow handling).
  - Both have first-person and third-person models, hand poses, and pinned
    draw-call budgets.
  - Pellets are one event that combat resolves per pellet, so they relay
    online as-is.
- **Bot loadouts in respawn modes**: rifles, SMG, shotgun, LMG, and at most one
  sniper per side. Bots also roll a perk (Lightweight or Flak Jacket). Bot
  shotguns fire pellets.
- Unlock gating by rank moved to Phase 5.

### Phase 4: Scorestreaks
Shipped for solo TDM (`src/game/score.js`, `src/game/streaks.js`):
- Match score: +100 per kill, +50 headshot, multi-kill bonuses, and +100
  every fifth kill without dying. "+100 KILL" popups appear under the
  crosshair.
- Score since the last death charges the streaks. Each one is earned once per
  life, and an unused streak survives death.
  - **UAV**, 500 points, key 5: every enemy shows on the radar for 30 s.
  - **Precision Airstrike**, 900 points, key 6: three bombs, 2.2 s after the
    call-in, walk out from the crosshair point along your facing. Each bomb
    lands on the first surface below it. Damage is 400 over a 9 m radius
    (lethal within about 5 m). Walls block it, it spares teammates, and kills
    are credited to you as AIRSTRIKE.
  - The bot side calls an enemy UAV every 10 team kills. While it is up,
    their hunt locks onto the nearest target.
  - HUD: a streak rail above the ammo box with progress and a ready glow, plus
    READY / ONLINE / INBOUND banners.
  - Audio: a synthesized jet flyby and radio chirps.
- S&D and online rooms have no streaks.

Also shipped:
- **Pick two of four** streaks in the menu's CLASS section. The picks are
  saved in `tiny-strike-streaks-v1` and ordered by cost. Slot keys are 5 and
  6; key 7 is the bonus slot.
- **Counter-UAV** (600): for 25 s it jams the enemy UAV ("ENEMY UAV JAMMED")
  and drops the enemy bots' chance of hunting the nearest target from 70% to
  35%.
- **Care Package** (750):
  - A crate drops where you aim (within 40 m) and takes 3 s to fall. It shows
    on the radar.
  - Walk over it for a random UAV, Counter-UAV, or airstrike in the bonus
    slot, or a full ammo and grenade resupply.
  - It is recovered after 60 s on the ground.
- **Touch**: a STREAK button appears whenever a streak is ready and fires the
  first ready one.
- Host-authoritative streaks for online play are covered by the server work.

### Phase 5: Progression and attachments
Shipped: **attachments**, one per class on the primary. The class editor picks
it. These are stat changes only; the procedural gun models do not mount the
parts yet.
- **Extended Mag**: +50% magazine, and reloads fill to it.
- **Suppressor**: bots hear your primary at 35% range.
- **Foregrip**: 20% less recoil drift.
- **Laser**: 25% tighter hip fire.

Also shipped (`src/game/progression.js`):
- **Local rank** (device-local, every solo mode). Match XP is the match score
  plus a result bonus (win 500, draw 300, loss 150). There are 30 ranks with
  titles from Private to General, saved in `tiny-strike-progress-v1`.
- **Rank unlocks**:

  | Rank | Unlocks |
  |---|---|
  | 2 | Shotgun, Quick Hands |
  | 3 | Deagle, Counter-UAV |
  | 4 | Semtex, Flak Jacket |
  | 5 | AWP, Scavenger |
  | 6 | Stun, Care Package |
  | 7 | LMG |
  | 8 | Hardline |

  Everything else is available from rank 1. Locked items never block play:
  at spawn, a class or streak pick holding something locked is swapped for an
  unlocked alternative.
- **Weapon levels**: 100 XP per kill with a gun. Levels 2-5 unlock its Laser,
  Foregrip, Extended Mag, and Suppressor.
- **Menu**:
  - Locked options show "RANK N" or "GUN LV N".
  - Class cards flag classes that hold locked items.
  - The CLASS header shows rank, title, and XP.
- **End screen** for respawn modes: XP earned, the score and result-bonus
  breakdown, a promotion, new unlocks, and weapon level-ups.
- **Attachment meshes** on first-person procedural guns:
  - Suppressor can on the muzzle; the tracer and flash origin move to its tip.
  - Laser box with a lit emitter.
  - Vertical foregrip.
  - Longer extended magazine.
  - In low-light renders only the suppressor reads clearly. The laser and grip
    are small and need a lighting or size check by eye.
- New grenades reuse the authored frag and flashbang models (`GLB_SOURCE`).

Still to do:
- Ranked respawn modes on the server (covered by the server work below).
- Attachments on third-person guns.
- Challenges and calling cards.

### Phase 6: More modes
Shipped for solo (`src/game/objectives.js`, driven by the respawn engine in
`tdm.js`). Each mode is a rules entry plus an optional objective object with
`onDeath`, `update`, `botGoal`, `radarMarkers`, `hud`, and `stop`.

**Kill Confirmed** (first to 30):
- Each death drops a spinning tag in team colour that lasts 30 s.
- Enemies confirm it for +1 team score and 100 personal points. Teammates deny
  it for 50 points.
- Bots detour for tags within 45 m.
- Tags show as diamonds on the radar.

**Domination** (first to 150):
- Flags are symmetric because these bomb maps put both sites near the U.S.
  spawn. A is 45% of the way from the U.S. spawn to mid, B is the mid defence
  anchor, and C is 45% of the way from the Russian spawn to mid, each snapped
  to a nav node. The first layout, which used the bomb sites, ran 58-7 on
  Harbor in simulation. The symmetric layout ran 55-44 over the same
  three minutes, with each side holding its home flag and mid changing
  hands. Each flag has a pole, a cloth, and a ground ring in
  the owner's colour.
- Capture:
  - A 4.5 m radius and 6 s solo. Extra cappers speed it up.
  - Contested flags freeze.
  - An enemy flag must be neutralised past zero first.
  - Unattended flags recover toward their owner.
- Scoring: +1 per held flag every 5 s. Kills do not score. A capture is worth
  200 personal points.
- Bots take flags their side does not hold, otherwise defend one.
- HUD: A/B/C chips under the score with a capture bar and a contested pulse.
  The radar shows the flags, and bomb-site letters are hidden.
- Banners: SECURED, LOST, and NEUTRALIZED.

Both modes use classes, streaks, and spawn protection.

Also shipped:
- **Hardpoint** (first to 150):
  - One zone (5 m radius) that rotates every 60 s: mid first, then the home
    flags and the bomb sites.
  - A side holding it alone scores 1 per second. Contested time scores
    nothing. Holding it alone is worth 50 personal points every 5 s.
  - It shows as a ring and light beam in the holder's colour, an "HP" chip
    whose bar is the time left on the zone, a radar marker, and a "HARDPOINT
    MOVED" banner.
  - Bots converge on it.
- **Free-for-all** (first to 30 kills):
  - Hostility goes through `src/game/hostility.js`. In FFA everyone is an
    enemy; uniforms are unchanged. This covers bot perception, hunting and
    hearing, and combat friendly fire (bullets, melee, explosives, semtex).
  - Kills score for their killer. The HUD reads "YOU n : LEAD n".
  - Spawns treat everyone as hostile.
  - The end screen shows your placement ("YOU PLACED 2ND OF 10") and the
    winner.
- **Domination spawns** lean toward flags the team holds. Objectives can
  provide `spawnAnchors(team)`.
- Online support for every respawn mode is covered by the server work.

### Phase 7: Presentation
Shipped:
- **Uniforms**: U.S. coyote and multicam tans vs Russian EMR greens, across
  all four character presets.
- **Identification**, needed because both sides now wear earth tones:
  - The crosshair turns red over a visible enemy. It casts against character
    hitboxes and stops at walls.
  - Blue name tags appear over teammates within 60 m. FFA has none.
- **Insignia**: inline U.S. and Russian flags beside the HUD score labels.
  They are hidden in FFA.
- **Announcer**: radio callouts through browser speech synthesis for mode
  briefs, streak ready and inbound, enemy UAV, flags taken or lost, hardpoint
  moves, and the match result.
  - It speaks one line at a time with a minimum gap between lines.
  - A Settings toggle (ANNOUNCER VOICE) controls it, saved with the settings.
  - It is silent where the browser has no speech synthesis.
- **Killcam** (respawn modes): after the death collapse, the camera rides
  your killer's live view until you respawn, labelled "KILLCAM ·
  RESPAWNING IN N". A real replay would need a pose ring buffer for every
  actor, and is still to do.
- **End-screen podium**: the top three by kills with K/D, coloured by side.
- **Death recap**: the killer's weapon, distance, headshot, and remaining HP.

Still to do:
- Killcam replay (pose ring buffer).
- Map authoring pass: landmarks, hero props, asymmetry, the upstream
  backdrop and stain defects, and three-lane TDM variants.

### Ongoing tech debt
- Done:
  - Desktop `pixelRatio` is capped at 1.5, which shades about 44% fewer
    pixels than 2x on Retina screens.
  - Leaderboard session creation on the Node server is throttled per IP:
    `TINY_STRIKE_MAX_SESSIONS_PER_MINUTE`, default 20, 0 disables it.
- Split `src/ui/hud.js` (about 5k lines, roughly 1.4k of them CSS-in-JS).
- Slim the repo (trailer history), which needs an owner decision.
- Rebuild a real low-quality dressing LOD.

## Decisions needed from the owner

1. **Walk key:** OK to make Shift sprint by default (MW convention) and
   move walk to another key?
2. **Economy:** keep money and the buy menu in Search & Destroy only, or use
   classes everywhere?
3. **Hosting:** where this fork deploys (GitHub Pages plus Cloudflare Worker
   like upstream, or elsewhere). This blocks online play outside localhost.
4. **History rewrite** to drop the trailer MP4s. It needs a force push to
   `main`.
