# Tiny Warfare

A fast browser FPS that runs entirely in the browser — Three.js rendering,
procedural textures, synthesized WebAudio, bot AI, no build step.

Tiny Warfare is a fork of [Tiny Strike](https://github.com/guyz/tinystrike) by
Guy Zyskind. It is a fast modern-military arcade shooter: five respawn modes
plus round-based Search & Destroy, create-a-class, scorestreaks, three bot
difficulty tiers, ranks and unlocks. See [docs/ROADMAP.md](docs/ROADMAP.md)
for what's next.

Fight across five maps (Dustyard, Frostline, Neon Foundry, Harbor, Citadel)
in six modes. Play solo with bots, host a humans-only room, or mix humans and
bots online. Human, bot and overall leaderboards and a persistent career track
your progress. Phones and tablets get touch controls (play in landscape).

Soldier models are built from a low-poly Marine character, animated with clips
from the [Quaternius Universal Animation Library](https://quaternius.com/) (CC0)
and retargeted by `tools/build-operatives.mjs`; the first-person arms derive
from the Quaternius Toon Shooter Game Kit (CC0). See [ASSETS.md](ASSETS.md)
for full provenance and licensing.

## Run

Requires Node.js 20 or newer.

```sh
npm install
npm start
# then open http://localhost:8020
```

The Node server serves the game and hosts WebSocket rooms. A plain static
server also works for solo play (after `npm install`, since the page loads
three.js from `node_modules`), but online rooms require `npm start`.
For production hosting (Docker, Node, or the Cloudflare Worker), see
[docs/deployment.md](docs/deployment.md).

## Game modes

The two sides are **U.S. Forces** (defenders) and **Russian Forces** (attackers).
Every mode plays solo against bots or online; an online room plays the mode
its host has selected in the menu when the match starts. All modes are ranked.

- **Search & Destroy** (solo or online): the original round-based bomb mode
  with an economy and buy menu. First side to 8 rounds wins. Played on every
  map except Frostline.
- **Kill Confirmed**: every death drops a dog tag. Grab enemy
  tags to score and your own team's to deny them. First to 30.
- **Domination**: capture and hold flags A (near the U.S.
  side), B (mid), and C (near the Russian side). Every held flag scores a point every 5 seconds. First to 150.
- **Hardpoint**: hold the single zone, which moves every
  minute. A point every 1.5 seconds while your side holds it alone. First to 100.
- **Free-for-all**: no teams, first soldier to 30 kills.
- **Team Deathmatch**: first side to 50 kills.

In every respawn mode (all but Search & Destroy) you respawn after 3 seconds,
and a match that hasn't reached its limit ends after 10 minutes with the
higher score winning. Pick one of five editable **classes** in the menu's
CLASS row: a primary with an attachment (Extended Mag, Suppressor, Foregrip or
Laser), a secondary, a lethal, a tactical, and two perks (perk 1: Lightweight,
Quick Hands or Scavenger; perk 2: Ghost, Flak Jacket or Hardline). While dead,
press 1–5 to change class for the next spawn. Score earned since your last
death charges the two scorestreaks you pick: **UAV** (500), **Counter-UAV**
(600), **Care Package** (750), or **Precision Airstrike** (900).

Ways to play:

- **Solo + bots:** one human on the U.S. side, with bot teams.
- **Humans only:** create a room, share its six-character code, choose U.S. or
  Russian forces, and start after at least one human joins each team.
- **Humans + bots:** create or join a room; each side is filled to five players
  with bots. This mode may also be started by one human.

Bots come in three tiers, picked in the menu's BOTS row (online, the host's
pick applies to the room):

- **Recruit:** slow to react, loose aim, a narrow field of view, and fights one
  enemy at a time. No grenades. Its first shot at you always misses, and only
  one Recruit at a time can land hits on you; the rest shoot close.
- **Regular:** the standard bot. Turns on whoever shoots it, runs to cover to
  reload or when hurt, and frags an enemy who ducks out of sight. Up to three
  can land hits on you at once.
- **Veteran:** reacts and turns fast, leads moving targets, aims for the head
  more often, sees wider and farther, and always fights the most dangerous
  enemy in view. No limits.

The room server keeps the canonical roster and state fence while leasing bot
AI, hit resolution, round timers, and objective simulation to one active
client. Other clients send movement and actions to that authority and render
sequenced snapshots. If the authority stalls or disconnects, the server fences
its stale state and transfers the lease to another active player.

## Leaderboards

Rankings are split into Humans, Bots, and Overall season boards. The server
calculates points from completed matches, wins, rounds, eliminations,
headshots, bomb objectives, efficiency, and playtime. Human competition has
the highest value; repeated bot matches taper and have a daily point cap.

Leaderboard data persists atomically in `.tiny-strike/leaderboard.json` by
default. Set `TINY_STRIKE_LEADERBOARD_PATH` and `TINY_STRIKE_SEASON` when
deploying. See [docs/leaderboard-api.md](docs/leaderboard-api.md) for the API,
identity, scoring, and live-room protocol.

### Career progression and returning players

Every player has a permanent server-side career with lifetime XP, levels,
tiers, personal records, streaks, per-map and per-mode totals, and achievements.
The menu surfaces current rank, the next level, a daily bot contract, nearby
rivals, and a direct leaderboard link. Bot leaderboard points taper after
repeated daily matches for competitive fairness, while every completed bot
match still earns at least 30 career XP and the daily contract awards bonus XP.

The browser automatically resumes a career using an opaque private progress
key stored locally; the server stores only its SHA-256 digest. Offline or
temporarily failed solo results are queued with their owning career and retried
after the identity is validated. To move devices or survive cleared browser
storage, open **EDIT PROFILE → CAREER RECOVERY & BACKUP**, use **COPY PRIVATE
PROGRESS KEY**, keep it secret, and use **RESTORE CAREER** on the other
device. There is no
password/account recovery service: possession of that key is possession of the
career.

Solo results are plausibility-checked and idempotent, but the browser remains
the source of solo gameplay telemetry. The public bot board is therefore an
engagement leaderboard, not a cheat-proof competitive authority. Human-room
results are accepted only from the room service.

Append `?test` to the URL for the automated-test mode (auto-starts the match
and simulates pointer lock for synthetic input).

## Controls

Keyboard controls can be remapped from **Settings** on the main menu. Settings
also has look sensitivity (`0.25×–3.00×`), field of view (65–100), brightness
(`−0.50–+0.50 EV`), master volume, an announcer voice toggle and **Graphics**
(Auto, High or Low; applies on reload). On Auto, a desktop that can't hold
about 40 fps in a match drops ambient occlusion, then resolution, and starts on
Low next time. Preferences are saved on this device.

| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Aim |
| LMB | Fire / throw grenade |
| RMB (hold) | Aim down sights (AWP: cycle scope zoom) |
| Space | Jump (mantles low crates) |
| C | Crouch (while sprinting: slide) |
| Shift (hold, moving forward) | Sprint — no firing until you stop |
| X | Walk (silent) |
| R | Reload |
| B | Buy menu (during buy time) |
| E (hold) | Defuse the bomb |
| E (hold, Russian bomb carrier) | Plant at site A or B |
| 1–3 / wheel | Switch weapons |
| 4 | Grenades (press again to cycle lethal and tactical) |
| Q | Last weapon |
| Tab (hold) | Scoreboard |
| 5 / 6 / 7 | Scorestreak slot 1 / slot 2 / care-package bonus (respawn modes) |
| 1–5 (while dead) | Pick the class for your next spawn (respawn modes; touch: CLASS button) |
| Space (while dead, S&D) | Next spectator view |
| Esc | Release the pointer and pause; QUIT TO MAIN MENU from there |

## Arsenal

Pistols: G-18, USP-S (silenced), Night Hawk — SMG: MP-5 — Rifles: AK-47,
M4-A1 — Shotgun: M1014 — LMG: M249 SAW — Sniper: AWP — plus knife, HE grenade,
Semtex, flashbang, stun grenade, and smoke grenade. Higher ranks unlock the
shotgun, LMG, sniper, Night Hawk, Semtex, stun, Counter-UAV (rank 3), Care
Package (rank 6) and the later perks; weapon levels unlock attachments.

The shotgun, LMG, Semtex and stun come from classes in the respawn modes.
Search & Destroy uses a buy menu instead (pistols, MP-5, AK-47, M4-A1, AWP,
HE, flash and smoke, with Kevlar and a defuse kit in its Gear tab).

## Architecture

The gameplay modules (world, player, weapons, viewmodel, combat, bots, rounds,
HUD, audio, effects, input) communicate over a synchronous event bus and are
wired in [src/main.js](src/main.js). Respawn modes live in
`src/game/tdm.js` and `src/game/objectives.js`, with classes, scorestreaks and
ranks in `loadouts.js`, `streaks.js` and `progression.js`. Bots are
`src/ai/bots.js`, with difficulty tiers in `skill.js`, the team commander in
`commander.js` and map sightlines and cover in `sightlines.js`.
[src/network/multiplayer.js](src/network/multiplayer.js) adds room UI, remote
human entities, interpolation, client input forwarding, and host snapshots.
[server.mjs](server.mjs) (Node) and `worker/` (Cloudflare) own rooms, teams,
host selection, and WebSocket message routing. [SPEC.md](SPEC.md) is the
original Tiny Strike design and is partly superseded.

## Tests

```sh
npm test
```

`npm test` runs the Node test suite: game rules, bots, maps, leaderboard,
rooms, the Node server and the Cloudflare Worker, and the Pages build.

## License

Tiny Warfare's source code is open source under the [ISC License](LICENSE),
which retains the original Tiny Strike copyright notice. Rendering code under
`src/gfx/` is ported from mshumer/Claude-of-Duty under the MIT License (see
[src/gfx/LICENSE](src/gfx/LICENSE)). Third-party and original asset terms are
documented in [ASSETS.md](ASSETS.md).

Tiny Warfare is an independent project inspired by tactical and military
shooters. It is not affiliated with or endorsed by Valve Corporation or
Activision; Counter-Strike and Call of Duty / Modern Warfare are trademarks of
their respective owners.
