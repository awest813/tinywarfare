# Deploying Tiny Warfare

The game is a static client (`index.html`, `src/`, `assets/`, three.js) plus
one service that hosts multiplayer rooms (`/ws`) and the leaderboard API
(`/api/leaderboard`). There are two interchangeable service implementations
that share their protocol code (`src/shared/rooms-core.mjs`,
`src/shared/leaderboard-core.mjs`):

| Option | What runs | Good for |
| --- | --- | --- |
| **Node server** (`server.mjs`) | client + rooms + leaderboard in one process | a VPS, Fly.io, Render, Railway, a home box |
| **Cloudflare Worker** (`worker/`) | rooms + leaderboard in Durable Objects; client on any static host | global edge, no server to patch |

Which one to use is an owner decision (see `docs/ROADMAP.md`). Both support
every game mode.

## Game modes online

A room carries a `gameMode` (`sd`, `tdm`, `kc`, `dom`, `hp`, `ffa`) chosen by
its host in the menu before the match starts:

- `hello` (create) and `set_game_mode` set it; `lobby`, `welcome`,
  `match_start`, `match_resume` and `/api/rooms` report it.
- Matches stay host-authoritative. In respawn modes the authority picks
  respawn points and sends `respawn {targetId, pos, yaw}`; the service marks
  that player alive and relays it. Late joiners are not parked until a next
  round: they enter dead and are deployed within a few seconds.
- Non-host scorestreak calls that deal damage (airstrike) go to the
  authority as `streak` messages.
- Ranked results carry `gameMode`. Respawn-mode results are validated as one
  match that reached its score limit or ran out the 10-minute clock; FFA
  players are scored on their own kills against the best rival.

Older clients that send no `gameMode` get Search & Destroy, so the service
can be upgraded ahead of the client.

## Node server

```sh
npm ci --omit=dev
PORT=8020 TINY_STRIKE_DATA_DIR=/var/lib/tiny-warfare node server.mjs
```

Or with the bundled `Dockerfile`:

```sh
docker build -t tiny-warfare .
docker run -d --name tiny-warfare -p 8020:8020 -v tiny-warfare-data:/data \
  -e TINY_STRIKE_ALLOWED_ORIGINS=https://your.domain tiny-warfare
```

Put it behind a TLS proxy (Caddy, nginx, the platform's edge) that forwards
WebSocket upgrades on `/ws`. The client connects to the same origin it was
served from, so no client configuration is needed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8020` | listen port |
| `TINY_STRIKE_ALLOWED_ORIGINS` | `https://awest813.github.io` | extra exact origins allowed to open rooms / call the API; same-origin always works |
| `TINY_STRIKE_DATA_DIR` | `./.tiny-strike` | leaderboard JSON directory (mount a volume) |
| `TINY_STRIKE_LEADERBOARD_PATH` | — | explicit leaderboard file instead |
| `TINY_STRIKE_SEASON` | `season-1` | leaderboard season id |
| `TINY_STRIKE_RECONNECT_GRACE_MS` | `120000` | how long a dropped seat is held (at most 120000) |
| `TINY_STRIKE_MAX_SOCKETS_PER_IP` | `32` | concurrent sockets per address |
| `TINY_STRIKE_MAX_ROOMS` | `500` | room cap |
| `TINY_STRIKE_MAX_SESSIONS_PER_MINUTE` | `20` | new leaderboard sessions per address per minute |

Behind a proxy that hides client addresses, the per-IP limits apply to the
proxy; raise them or terminate TLS on the box.

Run **one** Node server process. Rooms live in its memory and the leaderboard
is one JSON file it rewrites; two processes behind a load balancer would split
rooms and overwrite each other's results. To scale out, use the Cloudflare
Worker, whose rooms and leaderboard live in Durable Objects.

The origin allowlist stops other websites' pages from using your server from a
visitor's browser. It is not an abuse control: scripts that send no `Origin`
header are let through, as native clients may be. Abuse is bounded by the
per-address socket, session and match-result limits (12 results a minute),
the room cap, a per-connection message budget, and message size and depth
limits.

The `TINY_STRIKE_*` variable names, the `.tiny-strike` data directory and the
`dist/tinystrike` default build folder keep the upstream project's names on
purpose, so existing deployments keep working.

## Cloudflare Worker

`wrangler.jsonc` deploys the service as `tiny-warfare-service` and allows
`https://awest813.github.io` (this fork's GitHub Pages origin) in addition to
the Worker's own origin. Change `ALLOWED_ORIGINS` to wherever the client is
hosted, then follow `docs/cloudflare-deployment.md`:

```sh
npm run build:worker
npm run deploy:worker
npm run build:pages -- --service-url https://WORKER_HOST
```

The last step writes `dist/tinystrike/` with a `runtime-config.js` pointing
the client at the Worker for rooms and the leaderboard; publish that folder to
the static host (for GitHub Pages, the workflow in [GitHub Pages](#github-pages)
does this for you).

## Checking a deployment

```sh
curl https://HOST/api/rooms                # {"rooms":[...]} with gameMode per room
curl https://HOST/api/leaderboard/rules    # scoring rules
```

Then open two browsers, create a room with Team Deathmatch selected, join it
from the other, and start: both should show TDM, kills should score, and a
killed player should respawn after about three seconds.

## GitHub Pages

`.github/workflows/pages.yml` runs the tests, builds the static site and
publishes it on every push to `main` (or from **Actions → Deploy to GitHub
Pages → Run workflow**). Enable it once under **Settings → Pages → Build and
deployment → Source: GitHub Actions**. The site is served from
`https://OWNER.github.io/REPO/`; every path in the build is relative, so the
subpath needs no configuration.

- **Without a service** (the default): the workflow builds with `--offline`.
  The site is solo play against bots. Online play, leaderboards and the
  server-saved career are hidden, no requests leave the site, and rank XP and
  unlocks are kept in the browser.
- **With a service**: deploy the Cloudflare Worker (or a Node server with TLS),
  add the Pages origin to its `ALLOWED_ORIGINS`, and set the repository
  variable `TINY_WARFARE_SERVICE_URL` (**Settings → Secrets and variables →
  Actions → Variables**) to its origin, e.g. `https://tiny-warfare-service.example.workers.dev`.
  The next deployment points the client at it.

The same builds by hand:

```sh
npm run build:pages -- --offline                     # solo-only
npm run build:pages -- --service-url https://HOST    # with a game service
```

GitHub Pages caches files for up to ten minutes, so for a few minutes after a
deployment a returning visitor can load a mix of old and new files; a reload
fixes it.
