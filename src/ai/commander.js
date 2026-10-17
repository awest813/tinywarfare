// ============================================================================
// TINY WARFARE — src/ai/commander.js
//
// Team commander for the objective modes, after the layered bot AI of
// Killzone 2 and 3: a commander per side turns the game mode into weighted
// jobs and hands each one to the best free bot, instead of every bot rolling
// dice on its own. Bots without a job hunt.
//
//   Kill Confirmed  one bot per enemy tag within reach; a side's own tag
//                   only by a bot already close to it, with an enemy near
//   Domination      two bots per flag the side does not hold, one defender
//                   per held flag (two while it is being taken)
//   Hardpoint       every bot but one holds the zone; the last one hunts
//
// A job stays with its bot until the job is done, the bot dies, or the bot
// spends too long in a fight. A bot that cannot reach its job reports back
// (reject) and is not sent there again for a while. Runs only where the bot
// AI runs (solo, or the online authority).
// ============================================================================

import { isRespawnMode } from '../game/tdm.js';

const REFRESH = 0.5;              // s between assignment passes
const KC_CONFIRM_RANGE = 55;      // m: a bot is sent to an enemy tag this close
const KC_DENY_RANGE = 12;         // m: ...and to its own side's tag only this close,
const KC_DENY_THREAT = 15;        // m: ...and only with an enemy this near the tag
const DOM_CAPTURE_SLOTS = 2;
const DOM_DEFEND_SLOTS = 1;
const DOM_SPREAD = 3;             // m: arrivals spread inside the 4.5 m flag
const ENGAGED_RELEASE = 4;        // s in a fight before a job goes to someone else
const CONFIRM_RELEASE = 10;       // ...for a confirm, which a bot fights its way to
const REJECT_TIME = 12;           // s a bot is not resent to a job it could not reach
const LOSING_MEMORY = 8;          // s a flag stays "under attack" after the last sign of it
const SETTLE_TIME = 10;           // s before a bot's job can be taken for an urgent one

function flatDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export default class TeamCommander {
  constructor(bots) {
    this.bots = bots;
    this.orders = new Map();       // bot -> order
    this._rejected = new Map();    // bot -> Map(task key -> until)
    this._objective = null;
    this._at = -Infinity;
    this._seq = 0;
    // A flag's "being taken" flickers through a firefight; remembering it
    // keeps a second defender from being sent and recalled every half second.
    this._losingUntil = new Map(); // team:flag -> time
  }

  /** The bot's current job, or null to hunt. */
  orderFor(bot) {
    this._refresh();
    return this.orders.get(bot) || null;
  }

  /** The bot could not reach its job: give it to someone else. */
  reject(bot) {
    const order = this.orders.get(bot);
    if (!order) return;
    this.orders.delete(bot);
    let list = this._rejected.get(bot);
    if (!list) { list = new Map(); this._rejected.set(bot, list); }
    list.set(order.key, this.bots.time + REJECT_TIME);
    this._at = -Infinity;
  }

  reset() {
    this.orders.clear();
    this._rejected.clear();
    this._losingUntil.clear();
    this._objective = null;
    this._at = -Infinity;
  }

  _refresh() {
    const now = this.bots.time;
    if (now >= this._at && now - this._at < REFRESH) return;
    this._at = now;
    const game = this.bots.game;
    const rounds = game.rounds;
    const objective = isRespawnMode(game.state && game.state.mode) && rounds && rounds.tdm
      ? rounds.tdm.objective : null;
    if (objective !== this._objective) {
      this.orders.clear();
      this._objective = objective || null;
    }
    if (!objective) return;

    for (const team of ['ct', 't']) {
      const squad = this.bots.all.filter((b) => b.alive && b.team === team && b.plan === 'hunt');
      if (!squad.length) continue;
      this._assign(squad, this._tasks(objective, team, squad.length));
    }
    for (const bot of this.orders.keys()) {
      if (!bot.alive || !this.bots.all.includes(bot)) this.orders.delete(bot);
    }
  }

  /** The side's jobs: { key, pos, slots, weight, range, radius, spread }. */
  _tasks(objective, team, squadSize) {
    const tasks = [];
    if (Array.isArray(objective.tags)) {
      for (const tag of objective.tags) {
        const own = tag.team === team;
        // Denying is worth a detour only when an enemy could confirm the
        // tag first; otherwise it lets the enemy's tags be confirmed and
        // the match never reaches its limit (55 denies to 38 confirms a match).
        if (own && !this._enemyNear(team, tag.pos, KC_DENY_THREAT)) continue;
        tasks.push({
          key: 'tag:' + tag.id,
          pos: tag.pos,
          slots: 1,
          weight: own ? 0.5 : 1,
          range: own ? KC_DENY_RANGE : KC_CONFIRM_RANGE,
          radius: 0,
          spread: 0, // picked up within 1.5 m: walk onto it, not a nearby waypoint
          confirm: !own,
        });
      }
    } else if (Array.isArray(objective.flags)) {
      const radius = objective.goalRadius || 0;
      for (const flag of objective.flags) {
        const held = flag.owner === team;
        const memo = team + ':' + flag.name;
        if (held && (flag.contested || Math.abs(flag.control) < 1)) {
          this._losingUntil.set(memo, this.bots.time + LOSING_MEMORY);
        }
        const losing = held && (this._losingUntil.get(memo) || -Infinity) > this.bots.time;
        tasks.push({
          key: (held ? 'defend:' : 'capture:') + flag.name,
          pos: flag.pos,
          slots: held ? (losing ? 2 : DOM_DEFEND_SLOTS) : DOM_CAPTURE_SLOTS,
          weight: held ? (losing ? 1.3 : 0.6) : 1,
          urgent: losing,
          range: Infinity,
          radius,
          spread: DOM_SPREAD,
        });
      }
    } else if (typeof objective.current === 'function') {
      const zone = objective.current();
      if (zone) {
        tasks.push({
          key: 'hp:' + objective.index,
          pos: zone,
          slots: Math.max(1, squadSize - 1),
          weight: 1,
          range: Infinity,
          radius: objective.goalRadius || 0,
          spread: Number.isFinite(objective.goalSpread) ? objective.goalSpread : 0,
        });
      }
    }
    return tasks;
  }

  /** Whether a living enemy of `team` (bot or human) is within `r` m of `pos`. */
  _enemyNear(team, pos, r) {
    const near = (actor, at) => actor && actor.alive !== false && at && actor.team && actor.team !== team &&
      flatDistance(at, pos) <= r && Math.abs(at.y - pos.y) < 3;
    for (const bot of this.bots.all) if (near(bot, bot.pos)) return true;
    const game = this.bots.game;
    const mp = game.multiplayer;
    const humans = mp && mp.active && typeof mp.humans === 'function' ? mp.humans() : [game.player];
    for (const human of humans) if (near(human, human && human.position)) return true;
    return false;
  }

  _assign(squad, tasks) {
    const now = this.bots.time;
    const byKey = new Map(tasks.map((task) => [task.key, task]));
    const used = new Map();
    const free = [];
    for (const bot of squad) {
      const order = this.orders.get(bot);
      const task = order && byKey.get(order.key);
      // A bot pinned in a fight for long hands its job on.
      if (order && bot.state === 'engage') {
        if (order.engagedSince == null) order.engagedSince = now;
      } else if (order) {
        order.engagedSince = null;
      }
      const release = order && order.confirm ? CONFIRM_RELEASE : ENGAGED_RELEASE;
      const stale = order && order.engagedSince != null && now - order.engagedSince > release;
      if (task && !stale && (used.get(task.key) || 0) < task.slots) {
        used.set(task.key, (used.get(task.key) || 0) + 1);
        order.pos = task.pos;
        order.radius = task.radius;
        order.spread = task.spread;
        order.weight = task.weight;
        continue;
      }
      if (order) this.orders.delete(bot);
      free.push(bot);
    }

    // Cheapest (distance / weight) pairs first; a busy bot is not given a job.
    const pairs = [];
    for (const task of tasks) {
      if ((used.get(task.key) || 0) >= task.slots) continue;
      for (const bot of free) {
        if (bot.state === 'engage') continue;
        const until = this._rejected.get(bot)?.get(task.key);
        if (until !== undefined && until > now) continue;
        const d = flatDistance(bot.pos, task.pos) + Math.abs(bot.pos.y - task.pos.y) * 3;
        if (d > task.range) continue;
        pairs.push({ task, bot, cost: d / task.weight });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    for (const { task, bot } of pairs) {
      if (this.orders.has(bot) || (used.get(task.key) || 0) >= task.slots) continue;
      used.set(task.key, (used.get(task.key) || 0) + 1);
      this._give(bot, task);
    }

    // An urgent job still short of bots (a held flag under attack) takes the
    // nearest bot off a lesser one. Only urgent jobs may: when any heavier
    // job could, Domination's spare capture slots poached every bot each
    // time its settle time ran out, and they paced at their spawns.
    const urgent = tasks.filter((task) => task.urgent && (used.get(task.key) || 0) < task.slots)
      .sort((a, b) => b.weight - a.weight);
    for (const task of urgent) {
      while ((used.get(task.key) || 0) < task.slots) {
        let pick = null;
        let pickD = Infinity;
        for (const bot of squad) {
          const order = this.orders.get(bot);
          if (!order || order.key === task.key || bot.state === 'engage') continue;
          if (now - order.since < SETTLE_TIME) continue;
          if (order.weight >= task.weight) continue;
          const until = this._rejected.get(bot)?.get(task.key);
          if (until !== undefined && until > now) continue;
          const d = flatDistance(bot.pos, task.pos);
          if (d <= task.range && d < pickD) { pickD = d; pick = bot; }
        }
        if (!pick) break;
        const old = this.orders.get(pick).key;
        used.set(old, (used.get(old) || 1) - 1);
        used.set(task.key, (used.get(task.key) || 0) + 1);
        this._give(pick, task);
      }
    }
  }

  _give(bot, task) {
    this.orders.set(bot, {
      id: ++this._seq,
      key: task.key,
      pos: task.pos,
      radius: task.radius,
      spread: task.spread,
      weight: task.weight,
      confirm: !!task.confirm,
      since: this.bots.time,
      engagedSince: null,
    });
  }
}
