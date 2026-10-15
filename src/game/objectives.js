// ============================================================================
// TINY WARFARE — src/game/objectives.js
//
// Objectives layered on the respawn engine (tdm.js):
//
//   Kill Confirmed — every death drops the victim's dog tag. The enemy side
//     scores by collecting it (confirm); the victim's side can deny it.
//     Tags expire after TAG_LIFETIME seconds.
//
//   Domination — three flags (U.S. side, mid, Russian side). Standing inside a flag's
//     radius drives its control toward your side; a flag is captured at full
//     control and neutralised when control crosses zero. Each held flag scores
//     one point for its owner every SCORE_TICK seconds. Kills do not score.
//
// Each objective exposes the same small surface: onDeath, update, botGoal,
// radarMarkers, hud, stop. Scores land in game.state.scores; the local
// player's personal awards go out as 'objective:score' for MatchScore, and a
// remote player's as 'objective:award' (relayed to their client).
//
// Online, only the authority runs update(); replicas get networkSnapshot()
// through applyNetworkSnapshot() and call replicaUpdate() for visuals.
// ============================================================================

import * as THREE from 'three';

export const KC = Object.freeze({
  TAG_LIFETIME: 30,   // s before an uncollected tag vanishes
  PICKUP_RADIUS: 1.5, // m (horizontal)
  BOT_SEEK_RANGE: 45, // m: bots detour for enemy tags (confirms) this close
  BOT_DENY_RANGE: 20, // m: ...and for their own side's tags (denies) this close
  BOT_DENY_BIAS: 1.6, // a deny must be this much nearer than a confirm to win
  CONFIRM_POINTS: 100,
  DENY_POINTS: 50,
});

export const DOM = Object.freeze({
  RADIUS: 4.5,        // m capture radius
  CAPTURE_TIME: 6,    // s for one capper to take a neutral flag
  SCORE_TICK: 5,      // s between flag scoring ticks
  CAPTURE_POINTS: 200,
  DEFEND_POINTS: 50,
});

// m of height an actor may be off a flag or hardpoint and still count: enough
// for a ramp inside the radius, not enough to reach a bridge from below it.
const OBJECTIVE_STOREY = 2.4;

const TEAM_COLOR = Object.freeze({ ct: 0x5f9fe0, t: 0xe0603c, neutral: 0xd8dccd });
const SIDE_COLOR = Object.freeze({ ours: 0x5f9fe0, theirs: 0xe0603c, neutral: 0xd8dccd });

/**
 * Objective colours are relative to the viewer, like the radar: your side
 * is blue and the enemy red, whichever faction you play.
 */
function sideColor(game, owner) {
  if (owner !== 'ct' && owner !== 't') return SIDE_COLOR.neutral;
  const mine = (game.player && game.player.team) || 'ct';
  return owner === mine ? SIDE_COLOR.ours : SIDE_COLOR.theirs;
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Free a match's objective meshes (each match builds its own). */
function disposeGroup(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

/** Personal objective points for whoever earned them (local or remote human). */
function awardActor(game, entry, points, label) {
  if (entry.isPlayer) game.events.emit('objective:score', { points, label });
  else if (entry.remoteId) game.events.emit('objective:award', { targetId: entry.remoteId, points, label });
}

function vec3(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    ? new THREE.Vector3(v.x, v.y, v.z)
    : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Every living participant as { actor, team, pos, isPlayer }. */
function livingActors(game) {
  const out = [];
  const player = game.player;
  if (player && player.alive && player.position) {
    out.push({ actor: player, team: player.team || 'ct', pos: player.position, isPlayer: true });
  }
  const mp = game.multiplayer;
  if (mp && mp.active && Array.isArray(mp.remotePlayers)) {
    for (const r of mp.remotePlayers) {
      if (r && r.alive && r.position) out.push({ actor: r, team: r.team || 'ct', pos: r.position, isPlayer: false, remoteId: r.networkId });
    }
  }
  const bots = game.bots && game.bots.all;
  if (Array.isArray(bots)) {
    for (const b of bots) if (b && b.alive && b.pos) out.push({ actor: b, team: b.team, pos: b.pos, isPlayer: false });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Kill Confirmed
// ----------------------------------------------------------------------------

/**
 * A bot reacting to a fight does not deny by accident. Tags drop beside the
 * victim's teammates, and a soak found half of all bot denies were bots
 * strafing over a fallen teammate's tag mid-fight and a fifth were bots
 * running to the gunfire (only one in seven went for the tag), so four tags
 * in five were denied and matches ran out the clock. Bots still deny on
 * purpose or on patrol; humans deny on touch.
 */
const NO_ACCIDENTAL_DENY = new Set(['engage', 'investigate']);
function botMidFightOnOwnTag(entry, tag) {
  return !entry.isPlayer && !entry.remoteId && entry.team === tag.team &&
    !!entry.actor && NO_ACCIDENTAL_DENY.has(entry.actor.state);
}

export class KillConfirmed {
  constructor(game) {
    this.game = game;
    // Bots path onto a tag itself: a nearby waypoint can sit outside PICKUP_RADIUS.
    this.goalSpread = 0;
    this.tags = [];
    this._time = 0;
    this._nextId = 0;
    this._geo = null;
    this._mats = null;
  }

  onDeath(victimTeam, pos) {
    if (!pos) return;
    const tag = {
      id: ++this._nextId,
      team: victimTeam === 't' ? 't' : 'ct',
      pos: new THREE.Vector3(pos.x, pos.y || 0, pos.z),
      expires: this._time + KC.TAG_LIFETIME,
      mesh: null,
    };
    tag.mesh = this._buildTagMesh(tag);
    this.tags.push(tag);
  }

  update(dt) {
    this._time += dt;
    const actors = livingActors(this.game);
    const s = this.game.state;
    for (let i = this.tags.length - 1; i >= 0; i--) {
      const tag = this.tags[i];
      if (this._time >= tag.expires) {
        this._removeTag(i);
        continue;
      }
      if (tag.mesh) {
        tag.mesh.rotation.y += dt * 2.4;
        tag.mesh.position.y = tag.pos.y + 0.75 + Math.sin(this._time * 3 + i) * 0.08;
      }
      const collector = actors.find((a) =>
        horizontalDistance(a.pos, tag.pos) <= KC.PICKUP_RADIUS && Math.abs(a.pos.y - tag.pos.y) < 2.2 &&
        !botMidFightOnOwnTag(a, tag));
      if (!collector) continue;
      const confirmed = collector.team !== tag.team;
      if (confirmed) s.scores[collector.team] = (s.scores[collector.team] || 0) + 1;
      this.game.events.emit('objective:tag', { confirmed, team: collector.team, byPlayer: collector.isPlayer });
      if (confirmed) awardActor(this.game, collector, KC.CONFIRM_POINTS, 'KILL CONFIRMED');
      else awardActor(this.game, collector, KC.DENY_POINTS, 'KILL DENIED');
      this._removeTag(i);
    }
  }

  networkSnapshot() {
    return {
      tags: this.tags.slice(-40).map((tag) => ({
        id: tag.id,
        team: tag.team,
        ttl: round2(Math.max(0, tag.expires - this._time)),
        pos: { x: round2(tag.pos.x), y: round2(tag.pos.y), z: round2(tag.pos.z) },
      })),
    };
  }

  /** Replica: mirror the authority's live tags (ids keep meshes stable). */
  applyNetworkSnapshot(data) {
    if (!data || !Array.isArray(data.tags)) return;
    const wanted = new Map();
    for (const entry of data.tags) {
      const pos = entry && vec3(entry.pos);
      const ttl = Number.isFinite(entry.ttl) ? Math.max(0, Math.min(KC.TAG_LIFETIME, entry.ttl)) : KC.TAG_LIFETIME;
      if (pos && Number.isFinite(entry.id)) wanted.set(entry.id, { team: entry.team === 't' ? 't' : 'ct', pos, ttl });
    }
    for (let i = this.tags.length - 1; i >= 0; i--) {
      if (!wanted.has(this.tags[i].id)) this._removeTag(i);
    }
    // Keep each tag's expiry real, so a replica that becomes the authority
    // still clears them on time.
    for (const tag of this.tags) tag.expires = this._time + wanted.get(tag.id).ttl;
    const have = new Set(this.tags.map((tag) => tag.id));
    for (const [id, entry] of wanted) {
      if (have.has(id)) continue;
      this._nextId = Math.max(this._nextId, id);
      const tag = { id, team: entry.team, pos: entry.pos, expires: this._time + entry.ttl, mesh: null };
      tag.mesh = this._buildTagMesh(tag);
      this.tags.push(tag);
    }
  }

  replicaUpdate(dt) {
    this._time += dt;
    this.tags.forEach((tag, i) => {
      if (!tag.mesh) return;
      tag.mesh.rotation.y += dt * 2.4;
      tag.mesh.position.y = tag.pos.y + 0.75 + Math.sin(this._time * 3 + i) * 0.08;
    });
  }

  /**
   * Nearest tag worth a detour. Confirms come first: a tag drops beside the
   * victim's teammates while the killer is usually a lane away, so bots that
   * weighed both kinds alike denied four tags in five and the score crawled.
   */
  botGoal(bot) {
    let best = null;
    let bestScore = Infinity;
    for (const tag of this.tags) {
      const d = horizontalDistance(tag.pos, bot.pos);
      const own = !!bot.team && tag.team === bot.team;
      if (d > (own ? KC.BOT_DENY_RANGE : KC.BOT_SEEK_RANGE)) continue;
      const score = own ? d * KC.BOT_DENY_BIAS : d;
      if (score < bestScore) { bestScore = score; best = tag.pos; }
    }
    return best;
  }

  /** A bot that scores a kill goes for the tag it just made. */
  pullsKiller() {
    return true;
  }

  radarMarkers() {
    return this.tags.map((tag) => ({ x: tag.pos.x, z: tag.pos.z, kind: 'tag', team: tag.team }));
  }

  hud() {
    return null;
  }

  stop() {
    for (let i = this.tags.length - 1; i >= 0; i--) this._removeTag(i);
    if (this._geo) this._geo.dispose();
    for (const m of Object.values(this._mats || {})) m.dispose();
    this._geo = null;
    this._mats = null;
  }

  _removeTag(i) {
    const tag = this.tags[i];
    if (tag.mesh && tag.mesh.parent) tag.mesh.parent.remove(tag.mesh);
    this.tags.splice(i, 1);
  }

  _buildTagMesh(tag) {
    const scene = this.game.scene;
    if (!scene) return null;
    if (!this._geo) {
      this._geo = new THREE.BoxGeometry(0.2, 0.28, 0.035);
      const mat = (color) => new THREE.MeshStandardMaterial({
        // Enough glow to spot a tag across a lane without flaring in the bloom.
        color, emissive: color, emissiveIntensity: 0.6, metalness: 0.6, roughness: 0.35,
      });
      // Your side's tags (deny them) blue; enemy tags (confirm them) gold.
      this._mats = { ours: mat(TEAM_COLOR.ct), theirs: mat(0xf7d27a) };
    }
    const mine = (this.game.player && this.game.player.team) || 'ct';
    const mesh = new THREE.Mesh(this._geo, this._mats[tag.team === mine ? 'ours' : 'theirs']);
    mesh.position.set(tag.pos.x, tag.pos.y + 0.75, tag.pos.z);
    scene.add(mesh);
    return mesh;
  }
}

// ----------------------------------------------------------------------------
// Domination
// ----------------------------------------------------------------------------

const HOME_FLAG_T = 0.45; // home flags sit this far from a spawn toward mid

function centroid(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const c = new THREE.Vector3();
  let n = 0;
  for (const entry of list) {
    if (!entry || !entry.pos) continue;
    c.add(entry.pos);
    n++;
  }
  return n ? c.multiplyScalar(1 / n) : null;
}

function nearestNode(nodes, target) {
  let best = null;
  let bestD = Infinity;
  for (const node of nodes) {
    if (!node || !node.pos) continue;
    const d = node.pos.distanceToSquared(target);
    if (d < bestD) { bestD = d; best = node.pos; }
  }
  return best ? best.clone() : target.clone();
}

/**
 * Flag positions. The source maps are bomb-defusal layouts whose sites both
 * sit near the defenders' spawn, so flags are laid out symmetrically instead:
 * B halfway between the two spawns, A partway from the U.S. spawn toward it,
 * C the same distance out from the Russian spawn, each snapped to a nav node.
 * (The S&D "mid" defence anchor is not used for B when spawns are known: it
 * sits on the defenders' side, which put A and B 5-10 m apart.) Falls back
 * to the bomb sites when the map lacks that data.
 */
function pathLength(world, from, to) {
  const path = world.findPath(from, to);
  if (!Array.isArray(path) || !path.length) return Infinity;
  let length = from.distanceTo(path[0]);
  for (let i = 1; i < path.length; i++) length += path[i].distanceTo(path[i - 1]);
  return length;
}

/**
 * Flags balanced by walking distance on the nav graph: B is the node both
 * spawns reach equally soon along the main route, A and C sit the same walk
 * out from their own spawns. Straight-line midpoints favour whichever side
 * has the more direct lane (on Dustyard the Russians walked 45 m to B against
 * 29 m for the U.S.).
 */
function balancedFlags(world, nodes, ct, t) {
  const groundY = (ct.y + t.y) / 2;
  const rows = [];
  const byNode = new Map();
  for (const node of nodes) {
    if (!node || !node.pos) continue;
    const dc = pathLength(world, ct, node.pos);
    const dt = pathLength(world, t, node.pos);
    if (!Number.isFinite(dc) || !Number.isFinite(dt)) continue;
    const row = { pos: node.pos, dc, dt, lift: Math.abs(node.pos.y - groundY) };
    rows.push(row);
    byNode.set(node, row);
  }
  if (rows.length < 3) return null;
  // Edge midpoints too (an edge is a walkable straight run): a symmetric map
  // can have its centre between two nodes, as Neon Foundry's mid bridge does.
  const edges = world.waypoints && Array.isArray(world.waypoints.edges) ? world.waypoints.edges : [];
  for (const edge of edges) {
    const ra = byNode.get(nodes[edge[0]]);
    const rb = byNode.get(nodes[edge[1]]);
    if (!ra || !rb) continue;
    const pos = ra.pos.clone().add(rb.pos).multiplyScalar(0.5);
    const half = ra.pos.distanceTo(rb.pos) / 2;
    rows.push({
      pos,
      dc: Math.min(ra.dc, rb.dc) + half,
      dt: Math.min(ra.dt, rb.dt) + half,
      lift: Math.abs(pos.y - groundY),
    });
  }
  const route = Math.min(...rows.map((r) => r.dc + r.dt));
  // Off the main route and up on a ledge both cost: a flag belongs on the floor of a lane.
  const pick = (cost) => rows.reduce((best, r) => (cost(r) < cost(best) ? r : best));
  const b = pick((r) => Math.abs(r.dc - r.dt) + 0.35 * (r.dc + r.dt - route) + 2 * r.lift);
  const reach = HOME_FLAG_T * (b.dc + b.dt) / 2;
  const apart = (r) => (r.pos.distanceTo(b.pos) < 2 * DOM.RADIUS + 3 ? 1000 : 0);
  const a = pick((r) => Math.abs(r.dc - reach) + 0.35 * (r.dc + r.dt - route) + 2 * r.lift + apart(r));
  const c = pick((r) => Math.abs(r.dt - reach) + 0.35 * (r.dc + r.dt - route) + 2 * r.lift + apart(r));
  if (a === c) return null;
  return [
    { name: 'A', pos: a.pos.clone() },
    { name: 'B', pos: b.pos.clone() },
    { name: 'C', pos: c.pos.clone() },
  ];
}

export function dominationPoints(world) {
  const sites = world && Array.isArray(world.bombSites) ? world.bombSites : [];
  const areas = world && world.botTactics && Array.isArray(world.botTactics.defenseAreas)
    ? world.botTactics.defenseAreas
    : [];
  const midArea = areas.find((area) => area && area.sector === 'mid' && area.anchor);
  const siteA = sites[0] && sites[0].center;
  const siteB = sites[sites.length - 1] && sites[sites.length - 1].center;
  let mid = midArea ? midArea.anchor.clone() : null;
  if (!mid && siteA && siteB) mid = siteA.clone().add(siteB).multiplyScalar(0.5);

  const ct = centroid(world && world.spawns && world.spawns.ct);
  const t = centroid(world && world.spawns && world.spawns.t);
  const nodes = world && world.waypoints && Array.isArray(world.waypoints.nodes) ? world.waypoints.nodes : [];
  if (ct && t && nodes.length && world && typeof world.findPath === 'function') {
    const balanced = balancedFlags(world, nodes, ct, t);
    if (balanced) return balanced;
  }
  if (ct && t && nodes.length) {
    mid = nearestNode(nodes, ct.clone().add(t).multiplyScalar(0.5));
    return [
      { name: 'A', pos: nearestNode(nodes, ct.clone().lerp(mid, HOME_FLAG_T)) },
      { name: 'B', pos: nearestNode(nodes, mid) },
      { name: 'C', pos: nearestNode(nodes, t.clone().lerp(mid, HOME_FLAG_T)) },
    ];
  }

  const points = [];
  if (siteA) points.push({ name: 'A', pos: siteA.clone() });
  if (mid) points.push({ name: 'B', pos: mid.clone() });
  if (siteB && siteB !== siteA) points.push({ name: 'C', pos: siteB.clone() });
  return points;
}

export class Domination {
  constructor(game) {
    this.game = game;
    // Bots inside the flag they are taking stay until it is theirs.
    this.goalRadius = DOM.RADIUS;
    this._time = 0;
    this._tick = 0;
    this.flags = dominationPoints(game.world).map((p) => ({
      name: p.name,
      pos: p.pos,
      control: 0,       // -1 (Russia) .. +1 (U.S.)
      owner: null,
      contested: false,
      group: null,
    }));
    for (const flag of this.flags) flag.group = this._buildFlag(flag);
  }

  onDeath() {}

  update(dt) {
    this._time += dt;
    const actors = livingActors(this.game);
    const s = this.game.state;
    for (const flag of this.flags) {
      let ct = 0;
      let t = 0;
      const inside = [];
      for (const a of actors) {
        if (horizontalDistance(a.pos, flag.pos) > DOM.RADIUS || Math.abs(a.pos.y - flag.pos.y) > OBJECTIVE_STOREY) continue;
        if (a.team === 't') t++; else ct++;
        inside.push(a);
      }
      flag.contested = ct > 0 && t > 0;
      const before = flag.owner;
      if (!flag.contested && (ct > 0 || t > 0)) {
        const dir = ct > 0 ? 1 : -1;
        const cappers = Math.max(ct, t);
        // A second capper speeds it up; more add little.
        const rate = (1 / DOM.CAPTURE_TIME) * (1 + 0.5 * Math.min(cappers - 1, 2));
        flag.control = THREE.MathUtils.clamp(flag.control + dir * rate * dt, -1, 1);
        if (flag.owner && Math.sign(flag.control) !== (flag.owner === 'ct' ? 1 : -1)) flag.owner = null;
        if (flag.control >= 1) flag.owner = 'ct';
        else if (flag.control <= -1) flag.owner = 't';
      } else if (!flag.contested) {
        // Unattended flags drift back: owned ones recover, neutral half-caps drain.
        const target = flag.owner === 'ct' ? 1 : flag.owner === 't' ? -1 : 0;
        const gap = target - flag.control;
        flag.control += Math.sign(gap) * Math.min(Math.abs(gap), dt / DOM.CAPTURE_TIME * 0.5);
      }
      if (flag.owner !== before) {
        this.game.events.emit('objective:flag', { name: flag.name, owner: flag.owner, previous: before });
        if (flag.owner) {
          for (const a of inside) {
            if (a.team === flag.owner) awardActor(this.game, a, DOM.CAPTURE_POINTS, 'FLAG ' + flag.name + ' CAPTURED');
          }
        }
        this._paintFlag(flag);
      }
    }

    this._tick += dt;
    while (this._tick >= DOM.SCORE_TICK) {
      this._tick -= DOM.SCORE_TICK;
      for (const flag of this.flags) {
        if (flag.owner) s.scores[flag.owner] = (s.scores[flag.owner] || 0) + 1;
      }
    }

    this._animate();
  }

  _animate() {
    for (const flag of this.flags) {
      if (flag.group && flag.group.userData.cloth) {
        flag.group.userData.cloth.rotation.y = Math.sin(this._time * 2.1 + flag.pos.x) * 0.25;
      }
    }
  }

  networkSnapshot() {
    return {
      flags: this.flags.map((flag) => ({
        name: flag.name,
        control: round2(flag.control),
        owner: flag.owner,
        contested: flag.contested,
      })),
    };
  }

  /** Replica: flag positions come from the shared map; state from the authority. */
  applyNetworkSnapshot(data) {
    if (!data || !Array.isArray(data.flags)) return;
    for (const entry of data.flags) {
      const flag = entry && this.flags.find((f) => f.name === entry.name);
      if (!flag) continue;
      const owner = entry.owner === 'ct' || entry.owner === 't' ? entry.owner : null;
      flag.control = THREE.MathUtils.clamp(Number(entry.control) || 0, -1, 1);
      flag.contested = !!entry.contested;
      if (owner !== flag.owner) {
        const previous = flag.owner;
        flag.owner = owner;
        this.game.events.emit('objective:flag', { name: flag.name, owner, previous });
        this._paintFlag(flag);
      }
    }
  }

  replicaUpdate(dt) {
    this._time += dt;
    this._animate();
  }

  /** Nearest flag the bot's side does not hold; otherwise defend one. */
  botGoal(bot) {
    let best = null;
    let bestD = Infinity;
    for (const flag of this.flags) {
      if (flag.owner === bot.team) continue;
      const d = horizontalDistance(flag.pos, bot.pos);
      if (d < bestD) { bestD = d; best = flag.pos; }
    }
    if (best) return best;
    const held = this.flags.filter((flag) => flag.owner === bot.team);
    return held.length ? held[(bot.slot || 0) % held.length].pos : null;
  }

  /** Owned flags pull this team's respawns toward them. */
  spawnAnchors(team) {
    return this.flags.filter((flag) => flag.owner === team).map((flag) => flag.pos);
  }

  /** Points where a defender's kill counts as a defence. */
  isNearFlag(pos) {
    return this.flags.some((flag) => horizontalDistance(flag.pos, pos) <= DOM.RADIUS * 1.6);
  }

  radarMarkers() {
    return this.flags.map((flag) => ({ x: flag.pos.x, z: flag.pos.z, kind: 'flag', name: flag.name, owner: flag.owner, contested: flag.contested }));
  }

  hud() {
    return this.flags.map((flag) => ({
      name: flag.name,
      owner: flag.owner,
      control: flag.control,
      contested: flag.contested,
    }));
  }

  stop() {
    for (const flag of this.flags) {
      if (flag.group && flag.group.parent) flag.group.parent.remove(flag.group);
      disposeGroup(flag.group);
      flag.group = null;
    }
  }

  _buildFlag(flag) {
    const scene = this.game.scene;
    if (!scene) return null;
    const group = new THREE.Group();
    group.position.copy(flag.pos);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.05, 3.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.35 }),
    );
    pole.position.y = 1.6;
    const clothMat = new THREE.MeshStandardMaterial({
      color: TEAM_COLOR.neutral, emissive: TEAM_COLOR.neutral, emissiveIntensity: 0.25, side: THREE.DoubleSide, roughness: 0.8,
    });
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), clothMat);
    cloth.geometry.translate(0.55, 0, 0);
    cloth.position.y = 2.75;
    const ringMat = new THREE.MeshBasicMaterial({
      color: TEAM_COLOR.neutral, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(DOM.RADIUS - 0.18, DOM.RADIUS, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    group.add(pole, cloth, ring);
    group.userData = { cloth, clothMat, ringMat };
    scene.add(group);
    return group;
  }

  _paintFlag(flag) {
    const ud = flag.group && flag.group.userData;
    if (!ud || !ud.clothMat) return;
    const color = sideColor(this.game, flag.owner);
    ud.clothMat.color.setHex(color);
    ud.clothMat.emissive.setHex(color);
    ud.ringMat.color.setHex(color);
  }
}

// ----------------------------------------------------------------------------
// Hardpoint
// ----------------------------------------------------------------------------

export const HP = Object.freeze({
  // m. Was 5: in a 20-match soak no zone was ever contested, because
  // attackers dropped the holder from outside it before stepping in.
  RADIUS: 10,
  MIN_SPACING: 16,    // m between two zones of a rotation
  // s of sole hold per team point. Was 1: slower scoring gives the other side
  // time to push into the zone before a hold decides the match.
  SCORE_EVERY: 1.5,
  ROTATE: 60,         // s each zone stays live
  POINTS_EVERY: 5,    // s of solo holding per personal award
  HOLD_POINTS: 50,
});

/** Zone rotation: mid first, then the home flags and the bomb sites. */
export function hardpointZones(world) {
  const flags = dominationPoints(world);
  const zones = [];
  const add = (pos) => {
    if (pos && !zones.some((z) => z.distanceTo(pos) < HP.MIN_SPACING)) zones.push(pos.clone());
  };
  const mid = flags.find((f) => f.name === 'B');
  if (mid) add(mid.pos);
  for (const f of flags) add(f.pos);
  const sites = world && Array.isArray(world.bombSites) ? world.bombSites : [];
  for (const site of sites) if (site && site.center) add(site.center);
  return zones;
}

export class Hardpoint {
  constructor(game) {
    this.game = game;
    // Bots on the live hardpoint hold it instead of wandering off to hunt,
    // and most orders go to it: the zone is the whole game.
    this.goalRadius = HP.RADIUS;
    // Arrivals spread across the zone, not onto its centre.
    this.goalSpread = HP.RADIUS - 2.5;
    this.goalWeight = 0.9;
    // ...and do not chase noises or lost enemies far away from it.
    this.leash = HP.RADIUS + 15;
    this.zones = hardpointZones(game.world);
    this.index = 0;
    this.clock = 0;          // s into the current zone
    this.owner = null;
    this.contested = false;
    this._fraction = { ct: 0, t: 0 };
    this._personal = new Map(); // human -> seconds toward the next hold award
    this._group = this._buildZone();
    this._placeZone();
  }

  current() {
    return this.zones[this.index] || null;
  }

  /** Both sides respawn within reach of the live zone. */
  spawnFocus() {
    const zone = this.current();
    return zone ? [zone] : [];
  }

  onDeath() {}

  update(dt) {
    const zone = this.current();
    if (!zone) return;
    this.clock += dt;
    if (this.clock >= HP.ROTATE) {
      this.clock = 0;
      this.index = (this.index + 1) % this.zones.length;
      this.owner = null;
      this._placeZone();
      this.game.events.emit('objective:hardpoint', { moved: true, index: this.index });
      // Everyone drops their errand for the new zone now, not after it.
      const bots = this.game.bots;
      if (bots && typeof bots.retask === 'function' && Array.isArray(bots.all)) {
        for (const bot of bots.all) bots.retask(bot);
      }
    }

    let ct = 0;
    let t = 0;
    const inside = [];
    for (const a of livingActors(this.game)) {
      if (horizontalDistance(a.pos, zone) > HP.RADIUS || Math.abs(a.pos.y - zone.y) > OBJECTIVE_STOREY) continue;
      if (a.team === 't') t++; else ct++;
      inside.push(a);
    }
    this.contested = ct > 0 && t > 0;
    const holder = this.contested ? null : ct > 0 ? 'ct' : t > 0 ? 't' : null;
    if (holder !== this.owner) {
      this.owner = holder;
      this._paint();
    }
    if (!holder) return;

    const s = this.game.state;
    this._fraction[holder] += dt;
    while (this._fraction[holder] >= HP.SCORE_EVERY) {
      this._fraction[holder] -= HP.SCORE_EVERY;
      s.scores[holder] = (s.scores[holder] || 0) + 1;
    }
    // Personal hold time per human in the zone (bots earn nothing).
    for (const a of inside) {
      if (!a.isPlayer && !a.remoteId) continue;
      const key = a.isPlayer ? 'local' : a.remoteId;
      const held = (this._personal.get(key) || 0) + dt;
      if (held >= HP.POINTS_EVERY) {
        this._personal.set(key, held - HP.POINTS_EVERY);
        awardActor(this.game, a, HP.HOLD_POINTS, 'HARDPOINT SECURED');
      } else {
        this._personal.set(key, held);
      }
    }
    this._pulse();
  }

  _pulse() {
    if (this._group) {
      this._group.userData.beam.material.opacity = 0.16 + 0.06 * Math.sin(this.clock * 3);
    }
  }

  networkSnapshot() {
    return { index: this.index, clock: round2(this.clock), owner: this.owner, contested: this.contested };
  }

  applyNetworkSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    const index = Math.floor(Number(data.index));
    if (Number.isFinite(index) && index >= 0 && index < this.zones.length && index !== this.index) {
      this.index = index;
      this.owner = null;
      this._placeZone();
      this.game.events.emit('objective:hardpoint', { moved: true, index });
    }
    if (Number.isFinite(data.clock)) this.clock = THREE.MathUtils.clamp(data.clock, 0, HP.ROTATE);
    this.contested = !!data.contested;
    const owner = data.owner === 'ct' || data.owner === 't' ? data.owner : null;
    if (owner !== this.owner) {
      this.owner = owner;
      this._paint();
    }
  }

  replicaUpdate(dt) {
    this.clock = Math.min(HP.ROTATE, this.clock + dt);
    this._pulse();
  }

  botGoal() {
    return this.current();
  }

  radarMarkers() {
    const zone = this.current();
    return zone ? [{ x: zone.x, z: zone.z, kind: 'flag', name: 'HP', owner: this.owner, contested: this.contested }] : [];
  }

  hud() {
    return this.current()
      ? [{ name: 'HP', owner: this.owner, control: 1 - this.clock / HP.ROTATE, contested: this.contested }]
      : null;
  }

  stop() {
    if (this._group && this._group.parent) this._group.parent.remove(this._group);
    disposeGroup(this._group);
    this._group = null;
  }

  _buildZone() {
    const scene = this.game.scene;
    if (!scene) return null;
    const group = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({
      color: TEAM_COLOR.neutral, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(HP.RADIUS - 0.2, HP.RADIUS, 56), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    const beamMat = new THREE.MeshBasicMaterial({
      color: TEAM_COLOR.neutral, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 30, 12, 1, true), beamMat);
    beam.position.y = 15;
    group.add(ring, beam);
    group.userData = { ringMat, beam, beamMat };
    scene.add(group);
    return group;
  }

  _placeZone() {
    const zone = this.current();
    if (this._group && zone) this._group.position.copy(zone);
    this._paint();
  }

  _paint() {
    const ud = this._group && this._group.userData;
    if (!ud) return;
    const color = sideColor(this.game, this.owner);
    ud.ringMat.color.setHex(color);
    ud.beamMat.color.setHex(color);
  }
}

export function createObjective(mode, game) {
  if (mode === 'kc') return new KillConfirmed(game);
  if (mode === 'dom') return new Domination(game);
  if (mode === 'hp') return new Hardpoint(game);
  return null;
}
