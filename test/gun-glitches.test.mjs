// Glitches from the gun/movement audit: frame-rate independence (sprint
// speed, grenade range, landing spread), the AWP re-scope mid-sprint, the
// toggle-aim latch under Shift-then-W, the throw cut short by a weapon key,
// and a hitmarker on a spawn-protected target.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

class FakeTarget { addEventListener() {} removeEventListener() {} }
globalThis.window ??= new FakeTarget();
globalThis.document ??= Object.assign(new FakeTarget(), { visibilityState: 'visible', pointerLockElement: null });

const [{ default: Input }, { default: GameSettings }, { default: Player }, { default: Weapons },
  { default: Combat }, { CONFIG }, { EventBus }] = await Promise.all([
  import('../src/core/input.js'), import('../src/core/settings.js'), import('../src/player/player.js'),
  import('../src/weapons/weapons.js'), import('../src/combat/combat.js'), import('../src/shared/config.js'),
  import('../src/shared/events.js'),
]);

function makeGame({ realInput = false } = {}) {
  const events = new EventBus();
  const held = new Set();
  const game = {
    debug: false, canvas: {}, config: CONFIG, events,
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250),
    state: { phase: 'live', buyOpen: false },
    bots: { all: [] },
    multiplayer: { active: false, remotePlayers: [] },
    world: {
      resolveMovement(pos, delta) {
        const next = pos.clone().add(delta);
        const onGround = next.y <= 0;
        if (onGround) next.y = 0;
        return { pos: next, onGround };
      },
    },
  };
  if (realInput) {
    game.settings = new GameSettings(game, null);
    game.input = new Input(game);
    game.input.locked = true;
  } else {
    game.input = {
      firing: false, aiming: false, locked: true, isDown: (k) => held.has(k),
      consumeLook: () => ({ dx: 0, dy: 0 }), wasPressed: () => false, clearAimLatch() {},
    };
  }
  game.player = new Player(game);
  game.weapons = new Weapons(game);
  return { game, held };
}
const run = (game, seconds, dt = 1 / 60) => {
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) { game.player.update(dt); game.weapons.update(dt); }
};

test('sprint speed is the same at 30 and 240 fps', () => {
  const speed = (dt) => {
    const { game, held } = makeGame();
    game.weapons.currentId = 'knife';
    game.weapons._state = 'idle';
    game.player.perk = 'lightweight';
    held.add('w');
    held.add('shift');
    run(game, 2, dt);
    const z0 = game.player.position.z;
    run(game, 2, dt);
    return (z0 - game.player.position.z) / 2;
  };
  const slow = speed(1 / 30);
  const fast = speed(1 / 240);
  assert.ok(Math.abs(slow - fast) < 0.02, `${slow.toFixed(3)} vs ${fast.toFixed(3)} m/s`);
});

test('the AWP does not re-scope a player who started sprinting after the shot', () => {
  const { game, held } = makeGame();
  const w = game.weapons;
  w.give('awp');
  w.equip('awp');
  run(game, 1);
  w._onMouseDown({ button: 2 });
  run(game, 0.5);
  w._onMouseDown({ button: 0 });
  run(game, 1 / 60);
  w._onMouseUp({ button: 0 });
  held.add('w');
  held.add('shift');
  run(game, 1.6);
  assert.equal(game.player.sprinting, true);
  assert.equal(w.scopeLevel, 0);
});

test('with toggle aim, Shift then W drops the sights and sprints', () => {
  const { game } = makeGame({ realInput: true });
  game.settings.setAimToggle(true);
  game.weapons.give('m4a1');
  game.weapons.equip('m4a1');
  run(game, 1);
  game.input._onMouseDown({ button: 2, target: null, preventDefault() {} });
  game.input._onMouseUp({ button: 2 });
  run(game, 0.5);
  assert.equal(game.input.aiming, true);
  const key = (k) => game.input._onKeyDown({ key: k, code: k === 'w' ? 'KeyW' : 'ShiftLeft', preventDefault() {}, repeat: false, target: null });
  key('Shift');
  run(game, 2 / 60);
  key('w');
  run(game, 1);
  assert.equal(game.input.aiming, false);
  assert.equal(game.player.sprinting, true);
});

test('jumping again on landing is never more accurate than standing on the landing', () => {
  for (const dt of [1 / 30, 1 / 144]) {
    const { game } = makeGame();
    const w = game.weapons;
    w.give('ak47');
    w.equip('ak47');
    run(game, 1, dt);
    game.player.onGround = false;
    w.update(dt);
    for (let i = 0; i < 30; i++) w.update(dt);           // airborne 0.2+ s
    game.player.onGround = true;
    w.update(dt);                                          // lands
    const landing = w.currentSpread();
    game.player.onGround = false;
    w.update(dt);                                          // hops straight away
    assert.ok(w.currentSpread() >= landing - 1e-9, `dt ${dt}: ${w.currentSpread()} < ${landing}`);
  }
});

test('a grenade lands in the same place at 30 and 144 fps', () => {
  const floor = {
    raycast(o, d, max) {
      if (d.y >= -1e-9) return null;
      const t = -o.y / d.y;
      return t >= 0 && t <= max ? { distance: t, point: o.clone().addScaledVector(d, t), normal: new THREE.Vector3(0, 1, 0) } : null;
    },
  };
  const land = (dt) => {
    const events = new EventBus();
    const game = { events, config: CONFIG, world: floor, player: { team: 'ct', alive: false, velocity: new THREE.Vector3() }, bots: { all: [] }, multiplayer: null, state: { phase: 'live' } };
    const combat = new Combat(game);
    let at = null;
    events.on('fx:explosion', (e) => { at = at || e.pos; });
    const p = 20 * Math.PI / 180;
    events.emit('grenade:throw', { type: 'hegrenade', origin: new THREE.Vector3(0, 1.62, 0), dir: new THREE.Vector3(0, Math.sin(p), -Math.cos(p)), strength: 14 });
    for (let i = 0; i < 4 / dt && !at; i++) combat.update(dt);
    return -at.z;
  };
  assert.ok(Math.abs(land(1 / 30) - land(1 / 144)) < 0.2);
});

test('a weapon key after the grenade leaves the hand waits for the throw', () => {
  const { game } = makeGame();
  const w = game.weapons;
  w.give('ak47');
  w.give('flashbang');
  w.give('flashbang');
  w.equip('ak47');
  run(game, 1);
  w._onKey({ key: '4' });
  run(game, 0.6);
  const throws = [];
  game.events.on('grenade:throw', () => throws.push(w._now));
  w._onMouseDown({ button: 0 });
  run(game, 1 / 60);
  w._onMouseUp({ button: 0 });
  while (!throws.length) run(game, 1 / 60);
  w._onKey({ key: '4' });                // straight after the release
  assert.equal(w._state, 'throwing', 'the throw plays out');
  for (let t = 0; t < 3 && throws.length < 2; t += 1 / 60) {
    if (w._state === 'idle') { w._onMouseDown({ button: 0 }); run(game, 1 / 60); w._onMouseUp({ button: 0 }); }
    run(game, 1 / 60);
  }
  assert.equal(throws.length, 2);
  assert.ok(throws[1] - throws[0] > 0.8, `second throw ${(throws[1] - throws[0]).toFixed(2)} s after the first`);
});

test('an explosion on a spawn-protected bot shows no hitmarker', () => {
  const events = new EventBus();
  const bot = {
    alive: true, team: 't', pos: new THREE.Vector3(0, 0, -3), height: 1.83, spawnProtection: 1,
    takeDamage() {},
  };
  const game = { events, config: CONFIG, world: { raycast: () => null }, player: { team: 'ct', alive: true, position: new THREE.Vector3(0, 0, 20) }, bots: { all: [bot] }, multiplayer: null, state: { phase: 'live', mode: 'tdm' } };
  const combat = new Combat(game);
  let markers = 0;
  events.on('hud:hitmarker', () => markers++);
  combat._detonateHE({ type: 'hegrenade', pos: new THREE.Vector3(0, 0.2, -3), thrower: game.player, team: 'ct' });
  assert.equal(markers, 0);
  bot.spawnProtection = 0;
  combat._detonateHE({ type: 'hegrenade', pos: new THREE.Vector3(0, 0.2, -3), thrower: game.player, team: 'ct' });
  assert.equal(markers, 1, 'an unprotected bot still marks');
});

test('weapon keys and clicks on the pause screen do nothing', () => {
  const { game } = makeGame();
  const w = game.weapons;
  w.give('m4a1');
  w.equip('m4a1');
  run(game, 1);
  game.paused = true;
  w._onKey({ key: '3' });
  w._onMouseDown({ button: 0 });
  assert.equal(w._semiQueued, false, 'no shot queued');
  game.paused = false;
  run(game, 1);
  assert.equal(w.currentId, 'm4a1', 'no switch to the knife');
});

test('a grenade in flight when the match ends never goes off', () => {
  const floor = { raycast: () => null };
  const events = new EventBus();
  const game = { events, config: CONFIG, world: floor, player: { team: 'ct', alive: false, velocity: new THREE.Vector3() }, bots: { all: [] }, multiplayer: null, state: { phase: 'live' } };
  const combat = new Combat(game);
  let booms = 0;
  events.on('fx:explosion', () => booms++);
  events.emit('grenade:throw', { type: 'hegrenade', origin: new THREE.Vector3(0, 1.6, 0), dir: new THREE.Vector3(0, 0.3, -1).normalize(), strength: 12 });
  combat.update(0.5);
  game.state.phase = 'gameEnd';
  events.emit('game:end', { winner: 'ct' });
  for (let i = 0; i < 300; i++) combat.update(1 / 60);
  assert.equal(booms, 0);
});
