import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import Bots from '../src/ai/bots.js';
import { BOT_SKILLS, BOT_SKILL_IDS, botSkill, normalizeBotSkill } from '../src/ai/skill.js';
import { CONFIG } from '../src/shared/config.js';

function makeBrain(skill = 'regular', extra = {}) {
  const events = [];
  const brain = Object.create(Bots.prototype);
  brain.game = {
    config: CONFIG,
    state: { phase: 'live', mode: 'tdm' },
    world: null,
    botSkill: skill,
    // Far away and behind: never the target unless a test moves it.
    player: { team: 'ct', alive: true, position: new THREE.Vector3(0, 0, 500) },
    events: { emit: (type, payload) => events.push([type, payload]) },
    ...extra,
  };
  brain._cfg = CONFIG.BOT;
  brain._match = CONFIG.MATCH;
  brain.all = [];
  brain.time = 10;
  brain.bombCarrier = null;
  brain._bombPlanted = false;
  brain._bombPos = new THREE.Vector3();
  return { brain, events };
}

function makeBot(overrides = {}) {
  return {
    name: 'Bot',
    team: 'ct',
    alive: true,
    pos: new THREE.Vector3(),
    yaw: 0,                       // facing -z
    radius: CONFIG.BOT.RADIUS,
    height: CONFIG.BOT.HEIGHT,
    crouching: false,
    onGround: true,
    velY: 0,
    blindUntil: -99,
    stunUntil: -99,
    state: 'hold',
    plan: 'hunt',
    weaponId: 'm4a1',
    path: null,
    hasGoal: false,
    goal: new THREE.Vector3(),
    routeActive: false,
    routeQueue: [],
    destinationHistory: [],
    target: null,
    targetBot: null,
    targetHuman: null,
    targetIsPlayer: false,
    targetVisible: false,
    lastSeenTime: -99,
    lastSeenPos: new THREE.Vector3(),
    damageTime: -99,
    damageFromPos: new THREE.Vector3(),
    heardTime: -99,
    heardPos: new THREE.Vector3(),
    trackTime: 0,
    reactionTimer: 0,
    fireCooldown: 0,
    reloadTimer: 0,
    pauseTimer: 0,
    burstLeft: 0,
    mag: 30,
    aimBlend: 0,
    aimPitch: 0,
    strafeDir: 1,
    strafeTimer: 1,
    formationSide: 1,
    holdTimer: 1,
    scanTimer: 1,
    scanYaw: 0,
    moveSpeed: 0,
    anchor: new THREE.Vector3(),
    avoidUntil: 0,
    avoidSide: 1,
    recoveryUntil: 0,
    recoveryDir: new THREE.Vector3(),
    recoveryCount: 0,
    repathCooldown: 0,
    repathTimer: 0,
    navSampleTimer: 0,
    navSamplePathIndex: -1,
    navSampleDistance: Infinity,
    navSamplePos: new THREE.Vector3(),
    stuckTime: 0,
    blockedTime: 0,
    footAccum: 0,
    decisionSeq: 0,
    ...overrides,
  };
}

test('three tiers, each sharper than the last', () => {
  assert.deepEqual(BOT_SKILL_IDS, ['recruit', 'regular', 'veteran']);
  assert.equal(normalizeBotSkill('VETERAN'), 'veteran');
  assert.equal(normalizeBotSkill('nightmare'), 'regular');
  assert.equal(botSkill(undefined), BOT_SKILLS.regular);
  const [r, g, v] = BOT_SKILL_IDS.map((id) => BOT_SKILLS[id]);
  for (const [lo, hi] of [[r, g], [g, v]]) {
    assert.ok(hi.reaction[1] < lo.reaction[1], 'reacts faster');
    assert.ok(hi.turnSpeed > lo.turnSpeed, 'turns faster');
    assert.ok(hi.aimError < lo.aimError, 'aims tighter');
    assert.ok(hi.fov > lo.fov && hi.engageRange > lo.engageRange, 'sees more');
    assert.ok(hi.loseTime > lo.loseTime, 'remembers longer');
  }
  // Regular keeps the original bot's numbers.
  assert.deepEqual(g.reaction, [0.22, 0.55]);
  assert.equal(g.turnSpeed, 8);
  assert.equal(g.fov, 110);
  assert.equal(g.engageRange, 45);
});

test('bots play the menu tier solo and the room tier online', () => {
  const { brain } = makeBrain('veteran');
  assert.equal(brain._skill().id, 'veteran');
  brain.game.botSkill = 'recruit';
  assert.equal(brain._skill().id, 'recruit');
  brain.game.multiplayer = { active: true, botSkill: 'veteran', humans: () => [] };
  assert.equal(brain._skill().id, 'veteran');
});

test('sight range and field of view follow the tier', () => {
  const enemy = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -40) });
  const side = makeBot({ team: 't', pos: new THREE.Vector3(-10, 0, -6) }); // ~59 deg off facing
  const recruit = makeBrain('recruit').brain;
  const veteran = makeBrain('veteran').brain;
  const bot = makeBot();
  assert.equal(recruit._canSee(bot, enemy, false), false, 'recruit sees 32 m');
  assert.equal(veteran._canSee(bot, enemy, false), true, 'veteran sees 55 m');
  assert.equal(recruit._canSee(bot, side, false), false, 'outside a 90 deg cone');
  assert.equal(veteran._canSee(bot, side, false), true, 'inside a 130 deg cone');
});

test('a flashed bot sees nothing and acquires no one', () => {
  const { brain } = makeBrain();
  const enemy = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -10) });
  const bot = makeBot({ blindUntil: brain.time + 2 });
  brain.all = [bot, enemy];
  assert.equal(brain._canSee(bot, enemy, false), false);
  brain._perceive(bot);
  assert.equal(bot.target, null);
  bot.blindUntil = 0;
  brain._perceive(bot);
  assert.equal(bot.target, enemy);
});

test('a Regular bot turns on whoever shoots it; a Recruit keeps its target', () => {
  for (const [tier, expectSwitch] of [['regular', true], ['recruit', false]]) {
    const { brain } = makeBrain(tier);
    const a = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -12) });
    const b = makeBot({ team: 't', pos: new THREE.Vector3(3, 0, -14) });
    const bot = makeBot();
    brain.all = [bot, a, b];
    brain._perceive(bot);
    assert.equal(bot.target, a, 'the nearer enemy first');
    bot.targetVisible = true;
    brain.time += 0.5;
    brain._damageBot(bot, 10, { from: b });
    brain._perceive(bot);
    assert.equal(bot.target === b, expectSwitch, tier);
    if (expectSwitch) assert.ok(bot.reactionTimer > 0, 'a switch still costs a reaction');
  }
});

test('every tier drops a target behind cover for one in the open', () => {
  const { brain } = makeBrain('recruit');
  const hidden = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -30) });
  const open = makeBot({ team: 't', pos: new THREE.Vector3(2, 0, -12) });
  const bot = makeBot({ target: hidden, targetBot: hidden, targetVisible: false, state: 'engage' });
  brain.all = [bot, hidden, open];
  brain._perceive(bot);
  assert.equal(bot.target, open);
});

test('a crouched target is aimed at its crouched chest', () => {
  const { brain } = makeBrain();
  const standing = makeBot({ team: 't' });
  const crouched = makeBot({ team: 't', crouching: true });
  const bot = makeBot({ targetBot: standing });
  const high = brain._aimHeight(bot);
  bot.targetBot = crouched;
  const low = brain._aimHeight(bot);
  assert.ok(high > 1.2 && high < 1.45);
  assert.ok(low < high - 0.4, `crouched ${low} vs standing ${high}`);
  bot.aimHead = true;
  assert.ok(brain._aimHeight(bot) > low + 0.2, 'a head burst aims higher');
});

test('the pause between bursts runs while the target is hidden', () => {
  const { brain } = makeBrain();
  const enemy = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -15) });
  const bot = makeBot({
    state: 'engage', target: enemy, targetBot: enemy, targetVisible: false,
    lastSeenTime: brain.time, lastSeenPos: enemy.pos.clone(), pauseTimer: 0.4,
  });
  brain._combatFrame(bot, 0.25);
  assert.ok(Math.abs(bot.pauseTimer - 0.15) < 1e-9);
});

test('a reloading bot keeps tracking its target', () => {
  const { brain } = makeBrain();
  const enemy = makeBot({ team: 't', pos: new THREE.Vector3(15, 0, 0) });
  const bot = makeBot({
    state: 'engage', target: enemy, targetBot: enemy, targetVisible: true,
    lastSeenTime: brain.time, reloadTimer: 2, mag: 0, yaw: 0,
  });
  let shots = 0;
  brain._fireShot = () => { shots++; };
  for (let i = 0; i < 30; i++) brain._combatFrame(bot, 1 / 30);
  assert.ok(Math.abs(bot.yaw - (-Math.PI / 2)) < 0.05, `turned to face it (yaw ${bot.yaw})`);
  assert.equal(shots, 0);
});

test('a bot out of the fight tops up a part-empty magazine', () => {
  const { brain } = makeBrain();
  const bot = makeBot({ mag: 10 });
  brain.all = [bot];
  brain._thinkHunt = () => {};
  brain._think(bot);
  assert.ok(bot.reloadTimer > 0);
});

test('a target coming back out from cover has to be reacquired', () => {
  const { brain } = makeBrain();
  const enemy = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -12) });
  const bot = makeBot({
    state: 'engage', target: enemy, targetBot: enemy, targetVisible: false,
    lastSeenTime: brain.time - 1, reactionTimer: 0, trackTime: 3,
  });
  brain.all = [bot, enemy];
  brain._think(bot);
  assert.equal(bot.targetVisible, true);
  assert.ok(bot.reactionTimer > 0, 'a fresh, shorter reaction');
  assert.ok(bot.trackTime <= 0.1, 'aim settles again');
});

test('a new hit redirects a bot that was investigating something else', () => {
  const { brain } = makeBrain();
  brain.game.world = { findPath: (_from, to) => [to.clone()] };
  const bot = makeBot({ state: 'investigate', hasGoal: true, goal: new THREE.Vector3(20, 0, 0) });
  brain.all = [bot];
  brain._damageBot(bot, 10, { from: { pos: new THREE.Vector3(-15, 0, 0), team: 't', alive: true } });
  brain._think(bot);
  assert.equal(bot.state, 'investigate');
  assert.ok(bot.goal.x < 0, 'heads for the new shots');
});

test('flash cancels a plant in progress', () => {
  const { brain } = makeBrain();
  const bot = makeBot({ state: 'plant', plantTimer: 2 });
  brain.all = [bot];
  brain._botEye = (_b, out) => out.set(0, 1.6, 0);
  brain.applyFlash(new THREE.Vector3(0, 1, -3));
  assert.equal(bot.state, 'hold');
  assert.equal(bot.plantTimer, 0);
});

test('Regular and Veteran frag a target that ducked behind cover; Recruit does not', () => {
  for (const [tier, throws] of [['veteran', true], ['recruit', false]]) {
    const { brain, events } = makeBrain(tier);
    const bot = makeBot({ grenades: tier === 'recruit' ? 0 : 1, lastSeenPos: new THREE.Vector3(0, 0, -11) });
    brain.all = [bot];
    const random = Math.random;
    Math.random = () => 0;
    try {
      assert.equal(brain._tryGrenade(bot, brain._skill()), throws, tier);
    } finally {
      Math.random = random;
    }
    const thrown = events.filter(([type]) => type === 'bot:grenade');
    assert.equal(thrown.length, throws ? 1 : 0);
    if (throws) {
      const { dir, strength } = thrown[0][1];
      assert.ok(strength > 6 && strength <= 14, `strength ${strength}`);
      assert.ok(dir.z < 0 && dir.y > 0, 'lobbed toward the target');
      assert.equal(bot.grenades, 0, 'one per life');
      assert.equal(brain._tryGrenade(bot, brain._skill()), false);
    }
  }
});

test('no grenade into a teammate standing at the spot', () => {
  const { brain } = makeBrain('veteran');
  const bot = makeBot({ grenades: 1, lastSeenPos: new THREE.Vector3(0, 0, -11) });
  const mate = makeBot({ pos: new THREE.Vector3(1, 0, -11) });
  brain.all = [bot, mate];
  const random = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(brain._tryGrenade(bot, brain._skill()), false);
  } finally {
    Math.random = random;
  }
});

test('a bot runs from a live enemy grenade, and only once per throw', () => {
  const nade = { active: true, type: 'hegrenade', throwId: 7, pos: new THREE.Vector3(1, 0, 0), fuse: 1.2, throwerTeam: 't', thrower: {} };
  const { brain } = makeBrain('veteran', { combat: { liveExplosives: () => [nade] } });
  brain.game.world = {
    resolveMovement: (pos, delta) => ({ pos: pos.clone().add(delta), onGround: true }),
  };
  const bot = makeBot();
  brain.all = [bot];
  brain._dodgeGrenade(bot, brain._skill());
  assert.ok(bot.dodgeUntil > brain.time);
  const x0 = bot.pos.x;
  brain._moveBot(bot, 0.1);
  assert.ok(bot.pos.x < x0 - 0.2, 'moves away from it');
  bot.dodgeUntil = 0;
  brain._dodgeGrenade(bot, brain._skill());
  assert.equal(bot.dodgeUntil, 0, 'the same throw is not re-rolled');
});

test('a teammate grenade is not dodged', () => {
  const nade = { active: true, type: 'hegrenade', throwId: 1, pos: new THREE.Vector3(1, 0, 0), fuse: 1.2, throwerTeam: 'ct', thrower: {} };
  const { brain } = makeBrain('veteran', { combat: { liveExplosives: () => [nade] } });
  const bot = makeBot();
  brain._dodgeGrenade(bot, brain._skill());
  assert.ok(!(bot.dodgeUntil > brain.time));
});

test('a declined noise is not re-rolled while the noise continues', () => {
  const { brain } = makeBrain();
  const bot = makeBot();
  brain.all = [bot];
  brain._thinkHunt = () => {};
  const random = Math.random;
  let rolls = 0;
  Math.random = () => { rolls++; return 0.99; };
  try {
    for (let i = 0; i < 10; i++) {
      bot.heardTime = brain.time;            // gunfire keeps re-arming it
      brain._think(bot);
      brain.time += 0.1;
    }
  } finally {
    Math.random = random;
  }
  assert.notEqual(bot.state, 'investigate');
  assert.ok(rolls <= 3, `rolled ${rolls} times`);
});

test('a reloading Regular bot breaks for cover; a Recruit stands and trades', () => {
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const crate = new THREE.Box3(new THREE.Vector3(-5, 0, -3.5), new THREE.Vector3(-3, 4, -2.5));
  const world = {
    waypoints: { nodes: [{ id: 0, pos: new THREE.Vector3(-4, 0, -1) }] },
    raycast(origin, dir, maxDist) {
      ray.set(origin, dir);
      if (!ray.intersectBox(crate, hit)) return null;
      const distance = hit.distanceTo(origin);
      return distance <= maxDist ? { distance } : null;
    },
    resolveMovement: (pos, delta) => {
      const next = pos.clone().add(delta);
      next.y = Math.max(0, next.y);
      return { pos: next, onGround: next.y === 0 };
    },
  };
  for (const [tier, expectCover] of [['regular', true], ['recruit', false]]) {
    const { brain } = makeBrain(tier);
    brain.game.world = world;
    const enemy = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -20) });
    const bot = makeBot({
      state: 'engage', target: enemy, targetBot: enemy, targetVisible: true,
      lastSeenTime: brain.time, lastSeenPos: enemy.pos.clone(), reloadTimer: 2, mag: 0, health: 100,
    });
    brain.all = [bot, enemy];
    brain._canSee = () => true;
    brain._think(bot);
    assert.equal(bot.coverUntil > brain.time, expectCover, tier);
    if (!expectCover) continue;
    assert.deepEqual([bot.coverPos.x, bot.coverPos.z], [-4, -1]);
    for (let i = 0; i < 40; i++) { brain.time += 1 / 30; brain._moveBot(bot, 1 / 30); }
    assert.ok(bot.pos.distanceTo(new THREE.Vector3(-4, 0, -1)) < 0.6, `reached cover (${bot.pos.toArray()})`);
    assert.equal(bot.state, 'engage', 'still fighting (aiming) on the way');
  }
});

test('against a human, only the token holders hit; the rest and a first shot near-miss', () => {
  const { brain, events } = makeBrain('recruit');
  const human = brain.game.player;
  human.position.set(0, 0, -10);
  const first = makeBot({ slot: 0, state: 'engage', target: human, targetHuman: human, targetIsPlayer: true, targetVisible: true, engagedAt: 1, shotsAtTarget: 0, trackTime: 9 });
  const second = makeBot({ slot: 1, pos: new THREE.Vector3(2, 0, 0), state: 'engage', target: human, targetHuman: human, targetIsPlayer: true, targetVisible: true, engagedAt: 2, shotsAtTarget: 5, trackTime: 9 });
  brain.all = [first, second];
  const sk = brain._skill();
  const random = Math.random;
  Math.random = () => 0.999999; // no gaussian noise
  try {
    assert.equal(brain._meansToMiss(first, sk), true, "Recruit's first shot at someone misses");
    first.shotsAtTarget = 1;
    assert.equal(brain._meansToMiss(first, sk), false, 'then it holds the token');
    assert.equal(brain._meansToMiss(second, sk), true, 'one token: the second bot suppresses');
    // The miss is real: the shot passes clear of a man-sized target.
    brain._fireShot(second, 10, false);
    const dir = events.at(-1)[1].dir;
    const off = Math.abs(Math.atan2(-dir.x, -dir.z) - second.yaw);
    assert.ok(off > Math.atan2(0.7, 10), `deliberate miss off by ${off.toFixed(3)} rad`);
    // A bot-against-bot fight is untouched.
    second.targetIsPlayer = false;
    brain._fireShot(second, 10, false);
    const straight = events.at(-1)[1].dir;
    assert.ok(Math.abs(Math.atan2(-straight.x, -straight.z) - second.yaw) < 0.02);
  } finally {
    Math.random = random;
  }
  // Veterans have no token limit and no free first shot.
  const vet = makeBrain('veteran').brain;
  vet.all = [first, second];
  second.targetIsPlayer = true;
  first.shotsAtTarget = 0;
  assert.equal(vet._meansToMiss(first, vet._skill()), false);
  assert.equal(vet._meansToMiss(second, vet._skill()), false);
});
