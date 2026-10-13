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
// player's personal awards go out as 'objective:score' for MatchScore.
// ============================================================================

import * as THREE from 'three';

export const KC = Object.freeze({
  TAG_LIFETIME: 30,   // s before an uncollected tag vanishes
  PICKUP_RADIUS: 1.5, // m (horizontal)
  BOT_SEEK_RANGE: 45, // m: bots detour for tags this close
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

const TEAM_COLOR = Object.freeze({ ct: 0x5f9fe0, t: 0xe0603c, neutral: 0xd8dccd });

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Every living participant as { actor, team, pos, isPlayer }. */
function livingActors(game) {
  const out = [];
  const player = game.player;
  if (player && player.alive && player.position) {
    out.push({ actor: player, team: player.team || 'ct', pos: player.position, isPlayer: true });
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

export class KillConfirmed {
  constructor(game) {
    this.game = game;
    this.tags = [];
    this._time = 0;
    this._geo = null;
    this._mats = null;
  }

  onDeath(victimTeam, pos) {
    if (!pos) return;
    const tag = {
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
        horizontalDistance(a.pos, tag.pos) <= KC.PICKUP_RADIUS && Math.abs(a.pos.y - tag.pos.y) < 2.2);
      if (!collector) continue;
      const confirmed = collector.team !== tag.team;
      if (confirmed) s.scores[collector.team] = (s.scores[collector.team] || 0) + 1;
      this.game.events.emit('objective:tag', { confirmed, team: collector.team, byPlayer: collector.isPlayer });
      if (collector.isPlayer) {
        this.game.events.emit('objective:score', confirmed
          ? { points: KC.CONFIRM_POINTS, label: 'KILL CONFIRMED' }
          : { points: KC.DENY_POINTS, label: 'KILL DENIED' });
      }
      this._removeTag(i);
    }
  }

  /** Nearest tag worth a detour (either kind: confirm or deny). */
  botGoal(bot) {
    let best = null;
    let bestD = KC.BOT_SEEK_RANGE;
    for (const tag of this.tags) {
      const d = horizontalDistance(tag.pos, bot.pos);
      if (d < bestD) { bestD = d; best = tag.pos; }
    }
    return best;
  }

  radarMarkers() {
    return this.tags.map((tag) => ({ x: tag.pos.x, z: tag.pos.z, kind: 'tag', team: tag.team }));
  }

  hud() {
    return null;
  }

  stop() {
    for (let i = this.tags.length - 1; i >= 0; i--) this._removeTag(i);
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
        color, emissive: color, emissiveIntensity: 1.6, metalness: 0.6, roughness: 0.35,
      });
      this._mats = { ct: mat(TEAM_COLOR.ct), t: mat(TEAM_COLOR.t) };
    }
    const mesh = new THREE.Mesh(this._geo, this._mats[tag.team]);
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
 * A partway from the U.S. spawn toward mid, B on the mid defence anchor, C the
 * same distance out from the Russian spawn, each snapped to a nav node.
 * Falls back to the bomb sites when the map lacks that data.
 */
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
  if (mid && ct && t && nodes.length) {
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
      let playerInside = false;
      for (const a of actors) {
        if (horizontalDistance(a.pos, flag.pos) > DOM.RADIUS || Math.abs(a.pos.y - flag.pos.y) > 3) continue;
        if (a.team === 't') t++; else ct++;
        if (a.isPlayer) playerInside = true;
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
        if (flag.owner && playerInside && this.game.player && flag.owner === this.game.player.team) {
          this.game.events.emit('objective:score', { points: DOM.CAPTURE_POINTS, label: 'FLAG ' + flag.name + ' CAPTURED' });
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

    for (const flag of this.flags) {
      if (flag.group && flag.group.userData.cloth) {
        flag.group.userData.cloth.rotation.y = Math.sin(this._time * 2.1 + flag.pos.x) * 0.25;
      }
    }
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
    const color = TEAM_COLOR[flag.owner || 'neutral'];
    ud.clothMat.color.setHex(color);
    ud.clothMat.emissive.setHex(color);
    ud.ringMat.color.setHex(color);
  }
}

export function createObjective(mode, game) {
  if (mode === 'kc') return new KillConfirmed(game);
  if (mode === 'dom') return new Domination(game);
  return null;
}
