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

Headshots: the head sphere now sits a quarter-radius below the top of the
capsule (centre ~1.69 m, the operative's helmet), and a ray scores a headshot
only if it reaches the head no later than the body (2 cm grace). Level shots
from ~1.58 m up to the helmet top stay headshots; a shot through the neck, or
one climbing up through the chest from below, is a body hit
(`combat.js` `_rayCharacter`, covered by `test/combat-hitboxes.test.mjs`).

### Mode soak (2026-10-15)

Twenty full matches of every respawn mode and 5 Search & Destroy matches (62
rounds), rotating the five maps, driven by a headless harness: bots plus a
scripted player with a 0.35 s reaction and aim error. Each match logged
scores, kills, spawn deaths, stuck bots, out-of-bounds actors, page errors and
per-mode objective timing. No match logged an error, NaN or out-of-bounds
actor; two bots stuck in 140+ matches, both in S&D.

| Mode | Found | Fix | After |
|---|---|---|---|
| TDM | Healthy: every match to 50 in 250-300 s, margins 5-15 | none | |
| Kill Confirmed | 6 of 20 matches reached 30; about 75% of pickups were denies. Diagnostic: half the bot denies were bots strafing over a fallen teammate's tag mid-fight, a fifth bots running to the gunfire; one in seven went for the tag | Bots in `engage` or `investigate` do not collect their own side's tags (they still deny on purpose or on patrol, humans on touch) | 12 of 20 reached 30; Harbor and Dustyard 4/4 with more confirms than denies |
| Domination | Healthy on four maps; Dustyard 0-4 for the U.S. (four samples) | none (sample too small to retune the layout) | |
| Hardpoint | Zone empty 57% of the match; 2 of 5 timed out. Bots spent 72% of the time 20 m+ from the zone: holds capped at 1.6 s, one order in four went hunting, investigations dragged bots away, and respawns maximised distance from the enemies sitting on the zone | Bots in the zone hold it (`goalRadius`); 90% of orders go to it (`goalWeight`); a rotation retasks every bot; a 20 m `leash` stops chasing noises away from it; respawns are pulled toward it (`spawnFocus`, `SPAWN_ANCHOR`) | Empty 42%; 0 of 20 timed out; matches 504 s to 400 s; spawn deaths 1.3% of kills |
| FFA | 10.6% of kills within 3 s of a respawn, many inside the 1.5 s protection: bots spawned in sight and fired at once, which ends protection | Bots hold fire while protected | 7.7%. Edge-midpoint spawn candidates (also added) did not move it measurably |
| S&D | 1 bot defuse in 23 plants. At most detonations every bot on both sides was already dead and only the player was left; on Frostline the defenders never got within 31 m of the bomb (attackers 8-2 twice) | Frostline leaves the S&D rotation (`excludedModes` in `src/maps/catalog.js`, enforced in the menu, at match start and by both room servers); it stays in every respawn mode | |

Also from the soak: a free-for-all respawn raycast every candidate against every
enemy, 10-30 ms per spawn (a frame hitch). It now raycasts best-first and stops
once nothing can win: 1.6-8.5 ms, same choice (tested against the exhaustive
search). Hardpoint zones were never contested in 20 matches: attackers killed
the holder from outside the 5 m radius, so zones grew to 8 m (bots spread
across them). Kill Confirmed tags on Neon Foundry's mid bridge expire
uncollected: the bridge is a killing ground, and the map stays in the mode as
it is. The Domination spawn change was first tried with the same hard
pull as Hardpoint; it spawned both teams around mid and flag B never changed
hands, so Domination keeps its gentle lean.

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
Shipped solo and online (`src/game/tdm.js`):
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
- TDM results are ranked (see "Online modes and the server" below).
- A simulated three-minute match plays through with no console errors: about 50
  kills, all spawns valid, and the match ends at the limit.

Still to do for Phase 1:
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
- **Recoil moves the aim** (Modern Warfare style): each shot's pattern kick
  goes into the player's pitch/yaw, eased in over ~40 ms, and bullets fly
  where the crosshair is. Pulling down compensates exactly, nothing springs
  back on release, and ADS trims the kick by 20%. (It used to show 60% of the
  drift on the camera and keep 40% as a hidden bullet offset.)
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
Shipped for every respawn mode, solo and online (`src/game/score.js`, `src/game/streaks.js`):
- Match score: +100 per kill, plus bonuses on the same kill: +50 headshot,
  +50 per chained kill inside 3 s (DOUBLE KILL, TRIPLE KILL...), +100 FIRST
  BLOOD (the match's first kill by anyone), +50 PAYBACK (the enemy who last
  killed you), +50 AVENGER (the enemy who killed a teammate in the last 5 s),
  +50 LONGSHOT (past the weapon's range: 20 m shotgun, 30-35 m pistols and
  SMG, 45 m rifles and LMG, 60 m AWP; never explosives or the knife), and +100
  every fifth kill without dying. Wounding an enemy a teammate finishes within
  10 s pays +50 ASSIST (not in free-for-all). Combat stamps who wounded whom
  and puts `distance` and `assistIds` on each kill event; the relay re-aims
  `assistIsLocal` per seat like `killerIsLocal`.
- One kill is one popup under the crosshair: the running total with the base
  label, and its bonuses as a strip beneath ("+250 KILL / HEADSHOT · DOUBLE
  KILL"). The first version gave every bonus its own row, so a single
  headshot double kill pushed the previous kill off the four-row stack.
- Mid-match career toasts are only provisional personal records. The streak
  toasts said "DOUBLE KILL" for two kills minutes apart while the popup used
  it for two kills in 3 s, and "FIRST BLOOD" for your first kill whoever drew
  first blood.
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
- S&D has no streaks.

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
- Online: UAV, Counter-UAV and care packages run on the caller's client;
  an airstrike called by a guest is flown and resolved by the room authority
  so its damage and kill credit are authoritative.

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
- **Weapon levels**: 100 XP per kill with a primary. Levels 2-5 unlock its
  Laser, Foregrip, Extended Mag, and Suppressor. Pistol, knife, grenade and
  airstrike kills earn no weapon XP, since only primaries take attachments
  (they used to, which could end a match on "KNIFE LEVEL 2 · LASER").
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
Shipped solo and online (`src/game/objectives.js`, driven by the respawn engine in
`tdm.js`). Each mode is a rules entry plus an optional objective object with
`onDeath`, `update`, `botGoal`, `radarMarkers`, `hud`, and `stop`.

**Kill Confirmed** (first to 30):
- Each death drops a spinning tag in team colour that lasts 30 s.
- Enemies confirm it for +1 team score and 100 personal points. Teammates deny
  it for 50 points.
- Bots detour for enemy tags within 45 m and their own within 20 m, and walk
  onto the tag itself (pickup is 1.5 m). A deny must be 1.6x nearer than a
  confirm to win, and a bot that scores a kill goes for the tag it made. Before
  this, bots stopped at a waypoint up to 3 m short and weighed both kinds alike,
  so most tags expired or were denied: a ten-minute playthrough on Frostline
  ended 14-27 with neither side near 30.
- Tags show as diamonds on the radar.

**Domination** (first to 150):
- Flags are symmetric because these bomb maps put both sites near the U.S.
  spawn. B is the nav point (node or edge midpoint) both spawns reach equally
  soon along the main route; A and C sit the same walk out from their own
  spawns (45% of the way to B), on the floor of a lane. The first layout, which
  used the bomb sites, ran 58-7 on Harbor in simulation. The second used the
  S&D mid defence anchor for B, but that anchor sits on the defenders' side,
  so A and B landed 5-10 m apart on Dustyard, Harbor and Frostline. A test now
  holds every map to flags more than 14 m apart with B near the centre. Each
  flag has a pole, a cloth, and a ground ring in the owner's colour.
- Flags and hardpoints count anyone within 2.4 m of their height, so a flag on
  Neon Foundry's mid bridge does not count players on the floor below.
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
  - One zone (8 m radius) that rotates every 60 s: mid first, then the home
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
- Online: objectives run on the room authority and replicate (see below).

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

### Online modes and the server
Shipped (`server.mjs`, `worker/room-do.mjs`, `src/shared/rooms-core.mjs`,
`src/network/multiplayer.js`):
- **Rooms carry a game mode** (`sd`, `tdm`, `kc`, `dom`, `hp`, `ffa`). The
  host's menu pick travels with `hello` and `set_game_mode` (host only,
  before start) and is mirrored into every client's picker. Lobby, welcome,
  match start/resume and `/api/rooms` report it; the room list shows it.
  Clients that send no mode get S&D.
- **Authority respawns**: the room host's engine scores remote deaths,
  picks spawn points that account for remote players, and sends
  `respawn {targetId, pos, yaw}`. The service validates the authority epoch,
  marks the player alive and relays it. The host announces its own respawns
  the same way. Fresh remote spawns get 1.5 s of protection.
- **Late joiners** in respawn modes are not parked until a next round: they
  enter dead and are deployed within a few seconds.
- **Replication**: the snapshot carries the mode and its state (Kill
  Confirmed tags, Domination flags, the hardpoint index, clock and owner, FFA
  standings). Replicas run the respawn countdown and objective visuals; FFA
  scores are per viewer (own kills vs the best rival).
- **Kill credit** events are re-aimed at each seat, so score popups, streak
  points and stats count for the right player; personal objective points
  reach remote players as `objective:award`.
- **Ranked respawn modes**: results carry `gameMode`. A respawn result must
  reach the score limit or run out the clock, with kill and death rates
  checked against the duration. The servers rebuild each participant's
  outcome (`rankedOutcome`), FFA from the final standings. Scoring reuses
  the S&D weights with one "round" for a win (confirmed by the owner).
- **Deploy config** for this fork: Worker `tiny-warfare-service`, allowed
  origin `https://awest813.github.io`, a `Dockerfile` for the Node server,
  and `docs/deployment.md`.
- Verified with two headless browsers against the Node server in TDM, KC,
  DOM and FFA: mode sync, kills, respawns, guest airstrikes, late join and
  match end. The container's software renderer was too slow to hold the
  authority lease with three pages, so authority migrated mid-match and the
  match carried on.

Still to do:
- After an authority migration the new host's engine starts its FFA tally
  and respawn queue fresh from replicated state; seeding FFA kills from the
  last standings would keep the leaderboard exact.
- Perks and attachments of remote players are not known to the host, so
  Flak Jacket and similar perks only protect the host.
- The Cloudflare Worker path is covered by unit tests but has not been run
  against a live deployment from this fork.

### Ongoing tech debt
- Done:
  - Desktop `pixelRatio` is capped at 1.5, which shades about 44% fewer
    pixels than 2x on Retina screens.
  - Leaderboard session creation on the Node server is throttled per IP:
    `TINY_STRIKE_MAX_SESSIONS_PER_MINUTE`, default 20, 0 disables it.
  - The repo is slimmed: the trailer MP4s (about 310 MB across history) were
    removed from every commit and `*.mp4` is ignored. Trailers belong in
    release assets.
- Split `src/ui/hud.js` (about 5k lines, roughly 1.4k of them CSS-in-JS).
- Rebuild a real low-quality dressing LOD.

## Decisions needed from the owner

1. **Walk key:** OK to make Shift sprint by default (MW convention) and
   move walk to another key?
2. **Economy:** keep money and the buy menu in Search & Destroy only, or use
   classes everywhere?
3. **Hosting:** where this fork deploys. Both paths are ready
   (`docs/deployment.md`): GitHub Pages plus the Cloudflare Worker (configured
   for `awest813.github.io`), or the Node server/Docker image anywhere.

Settled:
- **Ranked value of respawn modes:** keep the S&D weights, with a win
  counting as one round.
- **History rewrite:** done. The trailer MP4s were removed from all history
  and `main` was force-pushed.
