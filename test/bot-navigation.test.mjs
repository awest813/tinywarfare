import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import Bots from '../src/ai/bots.js';
import { CONFIG } from '../src/shared/config.js';

function makeBrain(world = null) {
  const events = [];
  const brain = Object.create(Bots.prototype);
  brain.game = {
    config: CONFIG,
    state: { phase: 'live' },
    world,
    player: { team: 'ct', alive: true, position: new THREE.Vector3() },
    events: { emit: (type, payload) => events.push([type, payload]) },
  };
  brain._cfg = CONFIG.BOT;
  brain._match = CONFIG.MATCH;
  brain.all = [];
  brain.time = 0;
  brain.bombCarrier = null;
  brain._bombPlanted = false;
  brain._bombPos = new THREE.Vector3();
  return { brain, events };
}

function makeBot(overrides = {}) {
  const pos = overrides.pos || new THREE.Vector3();
  return {
    name: 'Test bot',
    team: 'ct',
    alive: true,
    pos,
    yaw: 0,
    radius: CONFIG.BOT.RADIUS,
    height: CONFIG.BOT.HEIGHT,
    crouching: false,
    velY: 0,
    onGround: true,
    blindUntil: -99,
    state: 'move',
    plan: 'defend',
    weaponId: 'usp',
    path: [new THREE.Vector3(8, 0, 0)],
    pathIndex: 0,
    goal: new THREE.Vector3(8, 0, 0),
    hasGoal: true,
    routeActive: false,
    routeQueue: [],
    routeName: null,
    anchor: new THREE.Vector3(),
    anchorReached: false,
    patrolPoints: null,
    destinationHistory: [],
    decisionSeq: 0,
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
    mag: 12,
    aimBlend: 0,
    aimPitch: 0,
    blindSpray: false,
    strafeDir: 1,
    strafeTimer: 1,
    formationSide: 1,
    wantCrouch: false,
    sneak: false,
    avoidUntil: 0,
    avoidSide: 1,
    recoveryUntil: 0,
    recoveryDir: new THREE.Vector3(),
    recoveryCount: 0,
    repathCooldown: 0,
    navSampleTimer: 0,
    navSamplePathIndex: -1,
    navSampleDistance: Infinity,
    navSamplePos: pos.clone(),
    stuckTime: 0,
    blockedTime: 0,
    moveSpeed: 0,
    footAccum: 0,
    holdTimer: 0,
    scanTimer: 1,
    scanYaw: 0,
    ...overrides,
  };
}

function freeWorld() {
  return {
    resolveMovement(pos, delta) {
      const next = pos.clone().add(delta);
      if (next.y < 0) next.y = 0;
      return { pos: next, onGround: next.y === 0, hitCeiling: false };
    },
    findPath(_from, to) {
      return [to.clone()];
    },
  };
}

test('bot speed reflects post-collision displacement', () => {
  const world = {
    resolveMovement: (pos) => ({ pos: pos.clone(), onGround: true, hitCeiling: false }),
    findPath: (_from, to) => [to.clone()],
  };
  const { brain } = makeBrain(world);
  const bot = makeBot();
  brain.all = [bot];

  for (let i = 0; i < 2; i++) {
    brain.time += 1 / 60;
    brain._moveBot(bot, 1 / 60);
  }

  assert.equal(bot.moveSpeed, 0);
  assert.ok(bot.blockedTime > 0, 'blocked movement is accumulated');
});

test('free navigation reports real running speed', () => {
  const { brain } = makeBrain(freeWorld());
  const bot = makeBot();
  brain.all = [bot];

  brain.time += 1 / 60;
  brain._moveBot(bot, 1 / 60);

  assert.ok(Math.abs(bot.moveSpeed - CONFIG.BOT.RUN_SPEED) < 1e-6);
  assert.ok(bot.pos.x > 0);
});

test('a network death snapshot starts the corpse animation exactly once', () => {
  const { brain } = makeBrain();
  brain.time = 12.5;
  brain._applyGunLook = () => {};
  const botMesh = new THREE.Group();
  const bot = makeBot({
    health: 100,
    armor: 0,
    moveSpeed: 4.6,
    deathTime: -1,
    deathPlayed: true,
    corpseSettled: true,
    fallAxis: 'x',
    fallSign: -1,
    mesh: botMesh,
  });
  brain.all = [bot];
  const snapshot = [{
    pos: { x: 3, y: 0, z: 4 },
    yaw: 0.4,
    aimPitch: 0,
    alive: false,
    health: 0,
    armor: 0,
    moveSpeed: 4.6,
    state: 'move',
    fallAxis: 'z',
    fallSign: 1,
  }];

  assert.equal(brain.applyNetworkSnapshot(snapshot), true);
  assert.equal(bot.alive, false);
  assert.equal(bot.deathTime, 12.5);
  assert.equal(bot.deathPlayed, false);
  assert.equal(bot.corpseSettled, false);
  assert.equal(bot.moveSpeed, 0);
  assert.equal(bot.fallAxis, 'z');
  assert.equal(bot.fallSign, 1);

  brain.time = 12.75;
  brain._animateDeath(bot, 0.25);
  assert.ok(bot.mesh.rotation.z > 0, 'the replicated corpse visibly begins falling');

  brain.time = 13;
  assert.equal(brain.applyNetworkSnapshot(snapshot), false);
  assert.equal(bot.deathTime, 12.5, 'later dead snapshots do not restart the fall');
});

test('a network respawn clears a replicated corpse pose', () => {
  const { brain } = makeBrain();
  brain._applyGunLook = () => {};
  const botMesh = new THREE.Group();
  botMesh.rotation.x = 0.7;
  botMesh.rotation.z = -1.2;
  const bot = makeBot({
    alive: false,
    health: 0,
    armor: 0,
    deathTime: 4,
    deathPlayed: true,
    corpseSettled: true,
    mesh: botMesh,
  });
  brain.all = [bot];

  const changed = brain.applyNetworkSnapshot([{
    pos: { x: 1, y: 0, z: 2 },
    alive: true,
    health: 100,
    armor: 0,
    moveSpeed: 0,
    state: 'idle',
  }]);

  assert.equal(changed, true);
  assert.equal(bot.alive, true);
  assert.equal(bot.deathTime, -1);
  assert.equal(bot.deathPlayed, false);
  assert.equal(bot.corpseSettled, false);
  assert.equal(bot.mesh.rotation.x, 0);
  assert.equal(bot.mesh.rotation.z, 0);
});

test('replicated deaths transition both CT and T bot visuals on a non-host client', () => {
  const { brain } = makeBrain();
  brain.time = 7;
  brain._applyGunLook = () => {};
  brain.all = ['ct', 't'].map((team) => makeBot({
    name: `${team.toUpperCase()} replica`,
    team,
    mesh: new THREE.Group(),
    health: 100,
    deathTime: -1,
  }));

  const changed = brain.applyNetworkSnapshot(brain.all.map((bot, index) => ({
    pos: { x: index * 2, y: 0, z: 3 },
    yaw: index * 0.4,
    alive: false,
    health: 0,
    armor: 0,
    moveSpeed: CONFIG.BOT.RUN_SPEED,
    state: 'move',
    fallAxis: index ? 'x' : 'z',
    fallSign: index ? -1 : 1,
  })));

  assert.equal(changed, true);
  for (const bot of brain.all) {
    assert.equal(bot.alive, false);
    assert.equal(bot.deathTime, 7);
    assert.equal(bot.moveSpeed, 0);
    brain.time = 7.2;
    brain._animateDeath(bot, 0.2);
    assert.ok(Math.abs(bot.mesh.rotation.x) + Math.abs(bot.mesh.rotation.z) > 0,
      `${bot.team} replica visibly leaves its last running pose`);
  }
});

test('a persistently blocked order is bounded and abandoned', () => {
  const world = {
    resolveMovement: (pos) => ({ pos: pos.clone(), onGround: true, hitCeiling: false }),
    findPath: (_from, to) => [to.clone()],
  };
  const { brain } = makeBrain(world);
  const bot = makeBot();
  brain.all = [bot];

  for (let i = 0; i < 240; i++) {
    brain.time += 1 / 60;
    brain._moveBot(bot, 1 / 60);
  }

  assert.equal(bot.moveSpeed, 0);
  assert.equal(bot.path, null);
  assert.equal(bot.hasGoal, false);
  assert.equal(bot.state, 'hold');
  assert.ok(bot.holdTimer >= 3.5, 'defender pauses before selecting another post');
});

test('repath failure stage survives progress through an earlier path node', () => {
  const { brain } = makeBrain(freeWorld());
  const bot = makeBot({
    path: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(8, 0, 0)],
    pathIndex: 1,
    recoveryCount: 2,
    navSamplePathIndex: 0,
    navSampleDistance: 7,
  });

  brain._updateNavigationProgress(bot, 1 / 60, CONFIG.BOT.RUN_SPEED, 0.07);

  assert.equal(bot.recoveryCount, 2);
  assert.equal(bot.navSamplePathIndex, 1);
});

test('a vertically unreachable node enters recovery instead of idling forever', () => {
  const world = {
    resolveMovement: (pos) => ({ pos: pos.clone(), onGround: true, hitCeiling: false }),
    findPath: (_from, to) => [to.clone()],
  };
  const { brain } = makeBrain(world);
  const bot = makeBot({
    path: [new THREE.Vector3(0, 2, 0)],
    goal: new THREE.Vector3(0, 2, 0),
  });
  brain.all = [bot];

  for (let i = 0; i < 240; i++) {
    brain.time += 1 / 60;
    brain._moveBot(bot, 1 / 60);
  }

  assert.equal(bot.path, null);
  assert.equal(bot.state, 'hold');
});

test('arrival is resolved before a defender can be assigned another patrol point', () => {
  const { brain } = makeBrain(freeWorld());
  const bot = makeBot({
    state: 'move',
    path: null,
    hasGoal: false,
    anchor: new THREE.Vector3(),
    anchorReached: false,
  });
  let objectiveCalls = 0;
  brain.all = [bot];
  brain._perceive = () => {};
  brain._thinkCT = () => { objectiveCalls++; };

  brain._think(bot);

  assert.equal(objectiveCalls, 0);
  assert.equal(bot.state, 'hold');
  assert.equal(bot.anchorReached, true);
  assert.ok(bot.holdTimer >= 6.5 && bot.holdTimer <= 10.5);
});

test('defenders take their assigned anchor before choosing a patrol point', () => {
  const { brain } = makeBrain(freeWorld());
  const anchor = new THREE.Vector3(4, 0, -3);
  const bot = makeBot({
    state: 'idle',
    path: null,
    hasGoal: false,
    anchor,
    anchorReached: false,
  });
  let assigned = null;
  brain._setGoal = (_bot, goal) => { assigned = goal.clone(); return true; };
  brain._patrolGoal = () => { throw new Error('patrol should not run before anchor'); };

  brain._thinkCT(bot);

  assert.ok(assigned.equals(anchor));
  assert.equal(bot.state, 'move');
});

test('enemy noise cannot divert a CT rotating to a planted bomb', () => {
  const { brain } = makeBrain(freeWorld());
  const bot = makeBot({ heardTime: 0, state: 'move' });
  let objectiveCalls = 0;
  brain.time = 1;
  brain._bombPlanted = true;
  brain.all = [bot];
  brain._perceive = () => {};
  brain._thinkCT = () => { objectiveCalls++; };

  brain._think(bot);

  assert.equal(objectiveCalls, 1);
  assert.notEqual(bot.state, 'investigate');
});

test('post-plant perimeter bots arrive and hold while a teammate defuses', () => {
  const { brain } = makeBrain(freeWorld());
  const bot = makeBot({
    state: 'move',
    path: null,
    hasGoal: false,
    postPlantRole: 'perimeter',
  });
  const defuser = makeBot({
    state: 'defuse',
    postPlantRole: 'defuse',
    pos: new THREE.Vector3(1, 0, 1),
  });
  brain._bombPlanted = true;
  brain.all = [bot, defuser];
  brain._perceive = () => {};

  brain._think(bot);
  const initialHold = bot.holdTimer;
  brain._think(bot);

  assert.equal(bot.state, 'hold');
  assert.equal(bot.path, null);
  assert.ok(initialHold >= 6.5);
  assert.ok(bot.holdTimer < initialHold, 'holding continues instead of issuing a new cover goal');
});

test('a declined sound reaction is consumed instead of rerolled every think', () => {
  const { brain } = makeBrain(freeWorld());
  const bot = makeBot({ state: 'hold', path: null, hasGoal: false, heardTime: 0, holdTimer: 5 });
  const originalRandom = Math.random;
  let calls = 0;
  brain.time = 1;
  brain.all = [bot];
  brain._perceive = () => {};
  brain._thinkCT = () => {};
  Math.random = () => { calls++; return 0.99; };
  try {
    brain._think(bot);
    brain._think(bot);
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(bot.heardTime, -99);
  assert.equal(bot.state, 'hold');
  assert.equal(calls, 1);
});

test('a combat standstill feint always returns to a real strafe direction', () => {
  const { brain } = makeBrain(freeWorld());
  const enemy = { alive: true, pos: new THREE.Vector3(0, 0, -15) };
  const bot = makeBot({
    state: 'engage',
    target: enemy,
    targetBot: enemy,
    targetVisible: true,
    strafeDir: 0,
    strafeTimer: 0,
    formationSide: -1,
  });
  brain.all = [bot];

  brain.time += 1 / 60;
  brain._moveBot(bot, 1 / 60);

  assert.equal(bot.strafeDir, -1);
  assert.ok(bot.moveSpeed > 0);
});

test('an occluded target is aimed at its last-seen position, not tracked through a wall', () => {
  const { brain } = makeBrain(freeWorld());
  const enemy = { alive: true, pos: new THREE.Vector3(10, 0, 0) };
  const bot = makeBot({
    state: 'engage',
    target: enemy,
    targetBot: enemy,
    targetVisible: false,
    lastSeenPos: new THREE.Vector3(0, 0, -10),
    lastSeenTime: 0,
    yaw: 0,
  });
  brain.time = 1;

  brain._combatFrame(bot, 0.1);

  assert.ok(Math.abs(bot.yaw) < 1e-8, 'aim remains on the north-facing last-seen angle');
});

test('a failed production path does not fall back to running straight at the goal', () => {
  const { brain } = makeBrain({ findPath: () => null });
  const bot = makeBot({ state: 'idle' });

  const accepted = brain._setGoal(bot, new THREE.Vector3(2, 0, 2));

  assert.equal(accepted, false);
  assert.equal(bot.path, null);
  assert.equal(bot.hasGoal, false);
  assert.equal(bot.state, 'hold');
});

test('same-goal objective refresh preserves the active path and index', () => {
  let findCalls = 0;
  const world = {
    findPath: (_from, to) => {
      findCalls++;
      return [to.clone()];
    },
  };
  const { brain } = makeBrain(world);
  const activePath = [new THREE.Vector3(2, 0, 0), new THREE.Vector3(8, 0, 0)];
  const bot = makeBot({ path: activePath, pathIndex: 1 });

  const accepted = brain._setGoal(bot, bot.goal.clone());

  assert.equal(accepted, true);
  assert.equal(findCalls, 0);
  assert.equal(bot.path, activePath);
  assert.equal(bot.pathIndex, 1);
});

test('replicated bots snap across teleport-sized corrections instead of sliding', () => {
  const { brain } = makeBrain();
  brain._applyGunLook = () => {};
  const bot = makeBot({ mesh: new THREE.Group(), health: 100, deathTime: -1 });
  brain.all = [bot];

  // 20 m in one snapshot is a teleport — a round respawn, or the canonical
  // resync applied when a backgrounded tab is fronted again (which first
  // resets bodies to their round spawns). The body must land on the canonical
  // spot immediately instead of visibly sliding there from the stale one.
  brain.applyNetworkSnapshot([{
    pos: { x: 20, y: 0, z: 0 }, yaw: 0.8, alive: true,
    health: 100, armor: 0, moveSpeed: 0, state: 'idle',
  }]);
  assert.equal(bot.pos.x, 20);
  assert.equal(bot.yaw, 0.8);
  assert.equal(bot.mesh.position.x, 20);

  // Ordinary corrections keep interpolating via netPos in update().
  brain.applyNetworkSnapshot([{
    pos: { x: 21, y: 0, z: 0 }, yaw: 0.8, alive: true,
    health: 100, armor: 0, moveSpeed: 4, state: 'move',
  }]);
  assert.equal(bot.pos.x, 20, 'sub-threshold corrections leave pos to the lerp');
  assert.equal(bot.netPos.x, 21);
});

test('a Kill Confirmed bot paths onto the tag itself, not a nearby waypoint', async () => {
  const { KillConfirmed, KC } = await import('../src/game/objectives.js');
  const tagPos = new THREE.Vector3(10, 0, 0);
  // Every waypoint near the tag sits just outside the pickup radius.
  const nodes = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(12.4, 0, 0), new THREE.Vector3(10, 0, 2.6)]
    .map((pos, id) => ({ id, pos }));
  const world = {
    waypoints: { nodes },
    findPath: (from, to) => [nodes[0].pos.clone(), to.clone()],
  };
  const { brain } = makeBrain(world);
  const kc = new KillConfirmed({ scene: null, player: { team: 'ct' } });
  kc.onDeath('t', tagPos);
  brain.game.rounds = { tdm: { objective: kc } };
  const random = Math.random;
  Math.random = () => 0; // take the objective branch
  try {
    const bot = makeBot({ hasGoal: false, path: null, state: 'move' });
    brain._thinkHunt(bot);
    assert.ok(bot.hasGoal, 'the bot takes an order');
    const dx = bot.goal.x - tagPos.x;
    const dz = bot.goal.z - tagPos.z;
    assert.ok(Math.hypot(dx, dz) <= KC.PICKUP_RADIUS, `goal ${bot.goal.toArray()} is off the tag`);
  } finally {
    Math.random = random;
  }
});

test('a bot on the live hardpoint holds it instead of wandering off to hunt', async () => {
  const { Hardpoint, HP } = await import('../src/game/objectives.js');
  const zone = new THREE.Vector3(0, 0, 0);
  const nodes = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(40, 0, 0)]
    .map((pos, id) => ({ id, pos }));
  const world = { waypoints: { nodes }, findPath: (from, to) => [to.clone()] };
  const { brain } = makeBrain(world);
  const objective = Object.assign(Object.create(Hardpoint.prototype), { goalRadius: HP.RADIUS, zones: [zone], index: 0 });
  brain.game.rounds = { tdm: { objective } };
  const enemy = makeBot({ team: 't', pos: new THREE.Vector3(40, 0, 0) });
  brain.all = [enemy];
  const random = Math.random;
  Math.random = () => 0.99; // the roll that used to send it after the nearest enemy
  try {
    const bot = makeBot({ hasGoal: false, path: null, state: 'hold', holdTimer: 10, pos: new THREE.Vector3(1, 0, 0) });
    brain._thinkHunt(bot);
    assert.ok(bot.holdTimer > 1.6 && bot.holdTimer <= 4, `holds the zone (${bot.holdTimer} s)`);
    bot.holdTimer = 0;
    brain._thinkHunt(bot);
    assert.ok(bot.hasGoal, 'takes an order');
    assert.ok(bot.goal.distanceTo(zone) < HP.RADIUS, `next goal ${bot.goal.toArray()} stays on the hardpoint`);

    // Off the zone the old mix still applies.
    const roamer = makeBot({ hasGoal: false, path: null, state: 'move', pos: new THREE.Vector3(30, 0, 0) });
    brain._thinkHunt(roamer);
    assert.ok(roamer.goal.distanceTo(zone) > HP.RADIUS, 'a bot away from it may still hunt');
  } finally {
    Math.random = random;
  }
});

test('a spawn-protected bot tracks its target but holds fire until the protection ends', () => {
  const { brain } = makeBrain(null);
  const enemy = makeBot({ team: 't', pos: new THREE.Vector3(0, 0, -15) });
  brain.all = [enemy];
  const bot = makeBot({
    state: 'engage', target: enemy, targetBot: enemy, targetVisible: true,
    lastSeenTime: 0, reactionTimer: 0, yaw: 0, aimPitch: 0, mag: 30, weaponId: 'm4a1',
    spawnProtection: 1.5, trackTime: 0, stunUntil: -99,
  });
  let shots = 0;
  brain._fireShot = () => { shots++; };
  brain._targetPos = (b, out) => out.copy(enemy.pos);
  for (let i = 0; i < 20; i++) { brain._combatFrame(bot, 1 / 30); brain.time += 1 / 30; bot.lastSeenTime = brain.time; }
  assert.equal(shots, 0, 'no shot while protected');
  assert.ok(bot.trackTime > 0.5, 'it keeps settling its aim');
  bot.spawnProtection = 0;
  for (let i = 0; i < 10; i++) { brain._combatFrame(bot, 1 / 30); brain.time += 1 / 30; bot.lastSeenTime = brain.time; }
  assert.ok(shots > 0, 'fires once the protection is gone');
});

test('Hardpoint bots do not chase noises or lost enemies away from the zone', () => {
  const { brain } = makeBrain(null);
  brain.game.state.mode = 'hp';
  const zone = new THREE.Vector3(0, 0, 0);
  brain.game.rounds = { tdm: { objective: { leash: 20, botGoal: () => zone } } };
  const bot = makeBot({ pos: new THREE.Vector3(10, 0, 0) });
  assert.equal(brain._offLeash(bot, new THREE.Vector3(45, 0, 0)), true, 'a noise far beyond the zone');
  assert.equal(brain._offLeash(bot, new THREE.Vector3(-12, 0, 0)), false, 'a fight at the zone is still chased');
  assert.equal(brain._offLeash(bot, new THREE.Vector3(0, 0, -25)), true);
  const far = makeBot({ pos: new THREE.Vector3(60, 0, 0) });
  assert.equal(brain._offLeash(far, new THREE.Vector3(30, 0, 0)), false, 'a noise on the way back is fine');
  brain.game.rounds.tdm.objective = { botGoal: () => zone };
  assert.equal(brain._offLeash(bot, new THREE.Vector3(45, 0, 0)), false, 'no leash outside Hardpoint');
});

test('a fresh Kill Confirmed tag nearby interrupts a bot walking somewhere else', () => {
  const { brain } = makeBrain(freeWorld());
  brain.game.state.mode = 'kc';
  const tag = new THREE.Vector3(6, 0, 0);
  brain.game.rounds = { tdm: { objective: { botGoal: () => tag, goalSpread: 0, preemptRange: 25 } } };
  const bot = makeBot({ state: 'move', plan: 'hunt', hasGoal: true, goal: new THREE.Vector3(-30, 0, 0), path: [new THREE.Vector3(-30, 0, 0)] });
  brain.all = [bot];
  brain._thinkHunt(bot);
  assert.ok(bot.goal.distanceTo(tag) < 0.01, 'heads for the tag');
  // Without a preempt range (Domination, Hardpoint) the errand stands.
  const other = makeBot({ state: 'move', plan: 'hunt', hasGoal: true, goal: new THREE.Vector3(-30, 0, 0), path: [new THREE.Vector3(-30, 0, 0)] });
  brain.game.rounds.tdm.objective = { botGoal: () => tag };
  brain._thinkHunt(other);
  assert.equal(other.goal.x, -30);
});
