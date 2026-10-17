// ============================================================================
// TINY WARFARE — src/weapons/weapons.js (module D)
//
// Player inventory + firing state machine. This module NEVER raycasts — it
// emits 'weapon:fire' and combat resolves hits. It owns:
//   - slots / ammo / current weapon, equip + reload + throw state machine
//   - CS-style recoil: recoilIndex-driven spray pattern (aim drift), bloom
//     that recovers on trigger discipline, movement/jump inaccuracy
//   - AWP scope: RMB zoom levels with smooth camera fov lerp (this module
//     writes game.camera.fov), shot forces brief unscope + bolt delay
//   - buy() with money / canBuy / slot-replacement rules + armor & kit
//
// Events emitted: weapon:fire, weapon:dryfire, weapon:equip,
// weapon:reload:start, weapon:reload:end, weapon:scope, grenade:throw,
// econ:buy, ui:toggle-buy.
// ============================================================================

import * as THREE from 'three';
import { WEAPONS, GEAR, BUY_MENU } from './data.js';
import { PERK_TUNING, hasAttachment, hasPerk } from '../game/loadouts.js';

// Raise time by slot. Matches the viewmodel's own raise (the event carries the
// duration), so the gun is ready to fire the moment it looks ready — at 0.6 s
// against a 0.28 s animation, a click in between was simply eaten.
const SWITCH_TIME = { 1: 0.45, 2: 0.32, 3: 0.28, 4: 0.3 };
const FAST_SWITCH_TIME = 0.35;  // post-throw / round-start raise
const THROW_DUR = 0.5;          // full throw animation length
const THROW_RELEASE = 0.11;     // seconds into the throw when grenade leaves hand
const DRYFIRE_INTERVAL = 0.35;  // min gap between dry-fire clicks
const RESCOPE_DELAY = 1.05;     // AWP: bolt time before auto re-scope
// A scope is not accurate the instant RMB goes down: spread blends from the
// unscoped cone to the scoped one over this long, so a same-frame
// right-click + left-click is no longer a perfect shot.
const SCOPE_SETTLE = 0.24;
// Longest the drift waits after a shot before it starts to recover. Without a
// cap the bolt-action AWP waited 2.4 s — longer than its own 1.46 s cycle — so
// its view kick only ever came back down long after the follow-up shot.
const RECOVERY_WAIT_MAX = 0.3;
const FOV_LERP_RATE = 12;       // per-second exponential fov approach
const DRIFT_CLAMP = 0.22;       // max accumulated aim drift (rad)
const SCOPED_MOVE_SCALE = 0.55; // extra move slowdown while scoped (feel)
// Share of the spray drift shown by the camera; the rest stays a bullet
// offset from the crosshair. Total deviation is unchanged.
const VIEW_RECOIL_SHARE = 0.6;
const GRENADE_ORDER = ['hegrenade', 'semtex', 'flashbang', 'stun', 'smokegrenade'];
const INPUT_BUFFER = 0.08;      // s a click waits for a cooldown / raise to end
const AIR_RAMP = 0.15;          // s for the jump penalty to reach full
const LAND_PENALTY = 0.5;       // share of the jump penalty right after landing
const LAND_RECOVER = 0.3;       // s for the landing penalty to fade

// Aim down sights (every gun without a scope). Hip fire keeps the original
// tuning; ADS tightens it, zooms the view, and slows the walk.
const ADS_SPREAD_SCALE = 0.55;  // spread multiplier at full ADS
const ADS_RECOIL_CUT = 0.2;     // recoil kick removed at full ADS
const ADS_MOVE_SCALE = 0.72;    // move speed multiplier at full ADS
const ADS_ZOOM = { 1: 0.2, 2: 0.12 }; // fov reduction by slot at full ADS
const ADS_TIME = { 1: 0.22, 2: 0.15 }; // s from hip to full ADS by slot
// Sprint-out: delay between leaving a sprint and the first shot.
const SPRINT_OUT = { 1: 0.22, 2: 0.13, 3: 0.08, 4: 0.15 };
const SPRINT_OUT_SCOPED = 0.32;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Box-Muller gaussian (per-shot only — never in a hot loop).
function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export default class Weapons {
  constructor(game) {
    this.game = game;

    // ---- public inventory state -------------------------------------------
    this.slots = { 1: null, 2: null, 3: 'knife', 4: [] };
    this.ammo = {};              // id -> { mag, reserve }
    this.currentId = 'knife';
    this.lastWeaponId = null;
    this.scopeLevel = 0;         // 0 / 1 / 2
    this.adsT = 0;               // 0 hip .. 1 fully aimed down sights

    // ---- internal state machine -------------------------------------------
    this._now = 0;
    this._state = 'idle';        // idle | equipping | reloading | winding | throwing
    this._stateT = 0;
    this._stateDur = 0;
    this._thrown = false;

    this._nextFireAt = 0;
    this._lastShotAt = -10;
    this._dryAt = 0;

    // Recoil: spray-pattern aim drift + bloom (extra spread from firing).
    this._recoilIndexF = 0;      // continuous; floor() indexes the pattern
    this._driftP = 0;            // accumulated pitch drift (rad, + = up)
    this._driftY = 0;            // accumulated yaw drift (rad)
    this._bloom = 0;

    // One-frame input queues (set by event handlers, consumed in update).
    this._semiQueued = false;
    this._rmbQueued = false;
    this._releaseQueued = false;

    // AWP scope / fov.
    const baseFov =
      (game.config && game.config.PLAYER && game.config.PLAYER.FOV) || 74;
    this._fovTarget = baseFov;
    this._fovCurrent = baseFov;
    this._rescopeAt = -1;
    this._rescopeLevel = 0;
    this._scopeT = 0;            // 0..1 settle since the scope went up

    this._everReset = false;
    this._wasSprinting = false;
    this._sprintRecoverAt = 0;
    this._airT = 0;              // time airborne (jump penalty ramp)
    this._landT = 9;             // time since landing (landing penalty)
    this._semiQueuedAt = -1;
    this._rmbQueuedAt = -1;

    // Scratch vectors (never allocated per frame).
    this._fwd = new THREE.Vector3();

    const ev = game.events;
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onKey = this._onKey.bind(this);
    ev.on('input:mousedown', this._onMouseDown);
    ev.on('input:mouseup', this._onMouseUp);
    ev.on('input:wheel', this._onWheel);
    ev.on('input:keydown', this._onKey);
    ev.on('kill', (e) => this._onKillScavenge(e));
    ev.on('ui:restart', () => {
      // Full match reset: next resetForRound() deals a fresh loadout.
      this._everReset = false;
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  current() {
    return WEAPONS[this.currentId] || WEAPONS.knife;
  }

  currentAmmo() {
    const def = this.current();
    if (!def || def.melee) return null;
    if (def.slot === 4) {
      const a = this.ammo[def.id];
      return a || { mag: 0, reserve: 0 };
    }
    return this.ammo[def.id] || null;
  }

  currentMoveMult() {
    const def = this.current();
    let mult = def && typeof def.moveSpeedMult === 'number' ? def.moveSpeedMult : 1;
    if (this.scopeLevel > 0) mult *= SCOPED_MOVE_SCALE;
    mult *= 1 - (1 - ADS_MOVE_SCALE) * this.adsT;
    return mult;
  }

  /** Full resupply: both guns to full mag and reserve, class grenades back. */
  resupply(loadout = null) {
    for (const slot of [1, 2]) {
      const id = this.slots[slot];
      const def = id && WEAPONS[id];
      if (!def || !this.ammo[id]) continue;
      this.ammo[id].mag = this.magSizeOf(def);
      this.ammo[id].reserve = def.reserve;
    }
    if (loadout) {
      for (const id of [loadout.lethal, loadout.tactical]) {
        if (!id || !WEAPONS[id]) continue;
        const max = WEAPONS[id].maxCarry || WEAPONS[id].magSize || 1;
        while (this._grenadeCount(id) < max && this.give(id)) { /* top up */ }
      }
    }
    this.game.events.emit('weapon:resupply', {});
  }

  /** Scavenger: each local kill tops up a magazine of reserve for both guns. */
  _onKillScavenge(e) {
    if (!e || !e.killerIsLocal || !hasPerk(this.game.player, 'scavenger')) return;
    for (const slot of [1, 2]) {
      const id = this.slots[slot];
      const def = id && WEAPONS[id];
      const ammo = id && this.ammo[id];
      if (!def || !ammo) continue;
      ammo.reserve = Math.min(def.reserve * 2, ammo.reserve + this.magSizeOf(def));
    }
  }

  /** Magazine size including an extended-mag attachment on the primary. */
  magSizeOf(def) {
    if (!def) return 0;
    if (def.slot === 1 && hasAttachment(this.game && this.game.player, 'extmag')) {
      return Math.round(def.magSize * PERK_TUNING.EXTMAG_SCALE);
    }
    return def.magSize;
  }

  /** Camera recoil (rad) the player adds to its view: the visible spray climb. */
  viewRecoilPitch() {
    return this._driftP * VIEW_RECOIL_SHARE;
  }

  viewRecoilYaw() {
    return this._driftY * VIEW_RECOIL_SHARE;
  }

  /** 0 (hip) .. 1 (fully aimed down sights). */
  adsFraction() {
    return this.adsT;
  }

  /** Look sensitivity multiplier that keeps ADS and scoped tracking speed constant. */
  adsSensitivityScale() {
    // On-screen speed goes with tan(fov/2), not with the angle itself: the
    // linear ratio left aimed turning ~6% fast at the rifle's 20% zoom. The
    // scope uses the same rule (fixed 0.45 / 0.22 factors turned 1.5-1.7x
    // too fast at the default FOV, and worse at a wide one).
    const half = (deg) => Math.tan((deg * Math.PI) / 360);
    return clamp(half(this._fovCurrent) / half(this._baseFov()), 0.05, 1);
  }

  /** True when the held weapon has sights to aim down (not knife, grenade, scope). */
  canAim() {
    return this._canAds(this.current());
  }

  /** Grenade hand for the viewmodel: 'winding', 'throwing' or null. */
  grenadeHand() {
    return this._state === 'winding' || this._state === 'throwing' ? this._state : null;
  }

  /** True when the trigger, aim, or a throw should stop the player sprinting. */
  blocksSprint() {
    const input = this.game.input;
    return !!(
      (input && (input.firing || (input.aiming && this._canAds(this.current())))) ||
      this._semiQueued ||
      this.scopeLevel > 0 ||
      this._state === 'winding' ||
      this._state === 'throwing'
    );
  }

  /** Seconds after a sprint before the held weapon can fire. */
  sprintOutTime() {
    return this._sprintOutTime(this.current());
  }

  _sprintOutTime(def) {
    if (def && def.zoomFov) return SPRINT_OUT_SCOPED;
    return SPRINT_OUT[def && def.slot] || 0.15;
  }

  _canAds(def) {
    return !!(def && !def.melee && def.slot !== 4 && !def.zoomFov && ADS_TIME[def.slot]);
  }

  // Total cone half-angle (rad). HUD crosshair gap reads this every frame.
  currentSpread() {
    const def = this.current();
    if (!def || def.melee || def.slot === 4) return 0;
    const g = this.game;
    const p = g.player;
    const scoped = this.scopeLevel > 0;

    let spread;
    if (def.zoomFov) {
      const unscoped = def.spreadUnscoped !== undefined ? def.spreadUnscoped : 0.05;
      const k = scoped ? this._scopeT * this._scopeT * (3 - 2 * this._scopeT) : 0;
      spread = unscoped + (def.spreadBase - unscoped) * k;
    } else {
      spread = def.spreadBase;
    }

    // Movement inaccuracy — rewards stopping to shoot. Superlinear so a slow
    // counter-strafe shoulder-peek stays usable while full sprint is punished.
    if (p && typeof p.moveSpeed2D === 'number') {
      const run = (g.config && g.config.PLAYER && g.config.PLAYER.RUN_SPEED) || 5.2;
      const frac = clamp(p.moveSpeed2D / run, 0, 1);
      let movePen = def.spreadMove * Math.pow(frac, 1.35);
      if (scoped) movePen *= 0.5; // scoped halves the move penalty
      // Aimed down sights the gun is shouldered: strafing while aimed is how
      // this kind of game is played, so ADS keeps only 30% of the move penalty
      // (an aimed-walk AK went from a 0.73 deg cone to ~0.27).
      movePen *= 1 - 0.7 * this.adsT;
      spread += movePen;
    }
    // Jump inaccuracy ramps in over AIR_RAMP and leaves a short landing tail.
    if (p && p.onGround === false) spread += def.spreadJump * Math.min(1, this._airT / AIR_RAMP);
    else if (this._landT < LAND_RECOVER) spread += def.spreadJump * LAND_PENALTY * (1 - this._landT / LAND_RECOVER);

    spread += this._bloom;

    // Crouch accuracy follows the crouch animation instead of snapping.
    if (p) {
      const P = g.config && g.config.PLAYER;
      const cur = Number.isFinite(p._heightCur) ? p._heightCur : null;
      const f = P && cur !== null
        ? clamp((P.HEIGHT_STAND - cur) / (P.HEIGHT_STAND - P.HEIGHT_CROUCH), 0, 1)
        : (p.crouching ? 1 : 0);
      spread *= 1 - 0.2 * f;
    }
    if (this.adsT > 0) spread *= 1 - (1 - ADS_SPREAD_SCALE) * this.adsT;
    if (def.slot === 1 && this.adsT < 0.5 && hasAttachment(p, 'laser')) spread *= PERK_TUNING.LASER_HIP_SPREAD;
    return spread;
  }

  isScoped() {
    return this.scopeLevel > 0;
  }

  owns(id) {
    if (!id) return false;
    if (this.slots[1] === id || this.slots[2] === id || this.slots[3] === id) return true;
    return this.slots[4].indexOf(id) !== -1;
  }

  networkSnapshot() {
    const ammo = {};
    for (const [id, counts] of Object.entries(this.ammo)) {
      if (!WEAPONS[id] || !counts) continue;
      ammo[id] = {
        mag: Math.max(0, Math.floor(Number(counts.mag) || 0)),
        reserve: Math.max(0, Math.floor(Number(counts.reserve) || 0)),
      };
    }
    return {
      slots: {
        1: this.slots[1] || null,
        2: this.slots[2] || null,
        3: this.slots[3] || 'knife',
        4: Array.isArray(this.slots[4]) ? this.slots[4].slice(0, 8) : [],
      },
      ammo,
      currentId: this.currentId,
    };
  }

  applyNetworkSnapshot(value) {
    if (!value || typeof value !== 'object') return false;
    const rawSlots = value.slots && typeof value.slots === 'object' ? value.slots : {};
    const slotWeapon = (slot) => {
      const id = typeof rawSlots[slot] === 'string' ? rawSlots[slot] : null;
      return id && WEAPONS[id]?.slot === Number(slot) ? id : null;
    };
    const grenades = [];
    const grenadeCounts = new Map();
    for (const id of Array.isArray(rawSlots[4]) ? rawSlots[4] : []) {
      const def = typeof id === 'string' ? WEAPONS[id] : null;
      if (!def || def.slot !== 4 || grenades.length >= 8) continue;
      const count = grenadeCounts.get(id) || 0;
      const maxCarry = Math.max(1, Math.floor(Number(def.maxCarry || def.magSize) || 1));
      if (count >= maxCarry) continue;
      grenadeCounts.set(id, count + 1);
      grenades.push(id);
    }
    this.slots = {
      1: slotWeapon(1),
      2: slotWeapon(2),
      3: slotWeapon(3) || 'knife',
      4: grenades,
    };
    this.ammo = {};
    const rawAmmo = value.ammo && typeof value.ammo === 'object' ? value.ammo : {};
    for (const id of [this.slots[1], this.slots[2], ...grenades]) {
      const def = id ? WEAPONS[id] : null;
      if (!def) continue;
      const counts = rawAmmo[id] || {};
      this.ammo[id] = {
        mag: Math.max(0, Math.min(Number.isFinite(def.magSize) ? this.magSizeOf(def) : 999,
          Math.floor(Number(counts.mag) || 0))),
        reserve: Math.max(0, Math.min(Number.isFinite(def.reserve) ? def.reserve : 9999,
          Math.floor(Number(counts.reserve) || 0))),
      };
    }
    const requested = typeof value.currentId === 'string' ? value.currentId : null;
    const target = requested && this.owns(requested)
      ? requested
      : this.slots[1] || this.slots[2] || this.slots[3] || 'knife';
    this._cancelActivity();
    this._forceEquip(target, FAST_SWITCH_TIME, false);
    return true;
  }

  // Switch to an owned weapon (0.6 s raise). Emits 'weapon:equip'.
  equip(id) {
    if (!id || !WEAPONS[id] || !this.owns(id)) return false;
    if (id === this.currentId && this._state !== 'throwing') return false;
    const swap = hasPerk(this.game.player, 'quickhands') ? PERK_TUNING.QUICKHANDS_SWAP : 1;
    this._forceEquip(id, this._switchTime(id) * swap, true);
    return true;
  }

  // Grant a weapon without charging (round-start loadouts, debug).
  give(id, free) {
    void free; // grants are always free; param kept for API compatibility
    const def = WEAPONS[id];
    if (!def) return false;
    if (def.slot === 4) {
      const max = def.maxCarry || def.magSize || 1;
      if (this._grenadeCount(id) >= max) return false;
      this.slots[4].push(id);
      this._syncGrenadeAmmo(id);
      return true;
    }
    if (def.slot === 3) {
      this.slots[3] = 'knife';
      return true;
    }
    const old = this.slots[def.slot];
    if (old && old !== id) delete this.ammo[old];
    // Respawn loadouts swap the team pistol for the class sidearm after the
    // equip; Q pointed at a pistol no longer owned and did nothing.
    if (old && old !== id && this.lastWeaponId === old) this.lastWeaponId = id;
    this.slots[def.slot] = id;
    this.ammo[id] = { mag: this.magSizeOf(def), reserve: def.reserve };
    return true;
  }

  // Robust purchase: money, buy window (game.state.canBuy from rounds), slot
  // replacement, grenade carry caps, and 'armor' / 'kit' pseudo-items.
  buy(id) {
    const g = this.game;
    const state = g.state;
    if (!state) return false;

    const canBuy =
      typeof state.canBuy === 'boolean' ? state.canBuy : state.phase === 'freeze';
    if (!canBuy) return false;

    const player = g.player;
    if (player && player.alive === false) return false;

    const econ = (g.config && g.config.ECON) || {};

    // ---- gear pseudo-items ------------------------------------------------
    if (id === 'armor') {
      const price = econ.ARMOR_PRICE !== undefined ? econ.ARMOR_PRICE : 650;
      const maxArmor =
        (g.config && g.config.PLAYER && g.config.PLAYER.MAX_ARMOR) || 100;
      if (state.money < price) return false;
      if (player && player.armor >= maxArmor) return false;
      if (player) player.armor = maxArmor;
      state.money = Math.max(0, state.money - price);
      g.events.emit('econ:buy', { id: id, price: price });
      return true;
    }
    if (id === 'kit') {
      const price = econ.KIT_PRICE !== undefined ? econ.KIT_PRICE : 400;
      if (state.money < price) return false;
      if (player && player.hasKit) return false;
      if (player) player.hasKit = true;
      state.money = Math.max(0, state.money - price);
      g.events.emit('econ:buy', { id: id, price: price });
      return true;
    }

    // ---- real weapons -----------------------------------------------------
    const def = WEAPONS[id];
    if (!def || !def.price) return false;
    if (state.money < def.price) return false;

    if (def.slot === 4) {
      const max = def.maxCarry || def.magSize || 1;
      if (this._grenadeCount(id) >= max) return false;
      this.slots[4].push(id);
      this._syncGrenadeAmmo(id);
    } else if (def.slot === 1 || def.slot === 2) {
      const old = this.slots[def.slot];
      if (old === id) return false; // already own this exact weapon
      if (old) delete this.ammo[old];
      this.slots[def.slot] = id;
      this.ammo[id] = { mag: this.magSizeOf(def), reserve: def.reserve };
      // CS-style: a freshly bought gun goes straight into your hands (this
      // also covers the spec's "auto-equip if slot empty" case).
      this._forceEquip(id, this._switchTime(id), true);
    } else {
      return false;
    }

    state.money = Math.max(0, state.money - def.price);
    g.events.emit('econ:buy', { id: id, price: def.price });
    return true;
  }

  dropCurrent() {
    // Optional per spec — intentional no-op.
    return false;
  }

  // Round-start loadout. rounds passes { died }: survivors keep guns (mags
  // refilled free, grenades kept); on death (or match start) back to team pistol+knife.
  resetForRound(opts) {
    const died = !!(opts && typeof opts === 'object' ? opts.died : opts);
    const fresh = !this._everReset || died;
    this._everReset = true;

    if (fresh) {
      const pistolId = this.game.player && this.game.player.team === 't' ? 'glock' : 'usp';
      this.slots = { 1: null, 2: pistolId, 3: 'knife', 4: [] };
      this.ammo = {};
      const pistol = WEAPONS[pistolId];
      this.ammo[pistolId] = { mag: this.magSizeOf(pistol), reserve: pistol.reserve };
    } else {
      const s1 = this.slots[1];
      const s2 = this.slots[2];
      if (s1 && WEAPONS[s1]) {
        this.ammo[s1] = { mag: this.magSizeOf(WEAPONS[s1]), reserve: WEAPONS[s1].reserve };
      }
      if (s2 && WEAPONS[s2]) {
        this.ammo[s2] = { mag: this.magSizeOf(WEAPONS[s2]), reserve: WEAPONS[s2].reserve };
      }
      for (const id of GRENADE_ORDER) this._syncGrenadeAmmo(id);
    }

    // Wipe transient combat state.
    this._nextFireAt = 0;
    this._nextFireById = {};
    this._lastShotAt = -10;
    this._dryAt = 0;
    this._semiQueued = false;
    this._rmbQueued = false;
    this._releaseQueued = false;
    this._recoilIndexF = 0;
    this._driftP = 0;
    this._driftY = 0;
    this._bloom = 0;
    this._cancelActivity(); // also unscopes + resets fov target to base

    // Snap fov instantly across the round transition (no visible zoom-out).
    this._fovCurrent = this._fovTarget;
    const cam = this.game.camera;
    if (cam && Math.abs(cam.fov - this._fovCurrent) > 0.01) {
      cam.fov = this._fovCurrent;
      cam.updateProjectionMatrix();
    }

    const target = fresh
      ? this.slots[2] || 'knife'
      : this.owns(this.currentId)
        ? this.currentId
        : this.slots[1] || this.slots[2] || 'knife';
    this.lastWeaponId = null;
    this._forceEquip(target, FAST_SWITCH_TIME, false);
  }

  // ==========================================================================
  // Per-frame update
  // ==========================================================================
  update(dt) {
    this._now += dt;

    const g = this.game;
    const state = g.state;
    const player = g.player;   // lazy sibling lookup every frame (rule 9)
    const input = g.input;

    if (player && player.onGround === false) {
      this._airT += dt;
    } else {
      if (this._airT > 0.12) this._landT = 0; // a real jump/fall, not a step
      this._airT = 0;
      this._landT += dt;
    }

    this._updateFov(dt);
    this._scopeT = this.scopeLevel > 0 ? Math.min(1, this._scopeT + dt / SCOPE_SETTLE) : 0;

    const def = this.current();
    const phase = state ? state.phase : 'menu';
    const canAct =
      player &&
      player.alive !== false &&
      phase !== 'menu' &&
      phase !== 'gameEnd';

    if (!canAct) {
      // Dead / menu: no shooting, no scope. Drop any in-progress action.
      if (this.scopeLevel > 0 || this._fovTarget !== this._baseFov()) this._unscope();
      if (this._state === 'winding' || this._state === 'throwing') this._state = 'idle';
      this.adsT = 0;
      g.input?.clearAimLatch?.();
      this._wasSprinting = false;
      this._semiQueued = false;
      this._rmbQueued = false;
      this._releaseQueued = false;
      this._decayRecoil(dt, def);
      return;
    }

    // ---- advance state machine timers -------------------------------------
    if (this._state === 'equipping') {
      this._stateT += dt;
      if (this._stateT >= this._stateDur) {
        this._state = 'idle';
        // R pressed during the raise, or a gun drawn empty, reloads now.
        const drawn = this.ammo[this.currentId];
        const reload = this._reloadQueued || (drawn && drawn.mag === 0 && drawn.reserve > 0);
        this._reloadQueued = false;
        if (reload) this._startReload();
      }
    } else if (this._state === 'reloading') {
      this._stateT += dt;
      if (this._stateT >= this._stateDur) {
        const rdef = this.current();
        const ammo = this.ammo[rdef.id];
        if (ammo && rdef.magSize > 0) {
          const take = Math.min(this.magSizeOf(rdef) - ammo.mag, ammo.reserve);
          ammo.mag += take;
          ammo.reserve -= take;
        }
        this._state = 'idle';
        g.events.emit('weapon:reload:end', { id: rdef.id });
      }
    } else if (this._state === 'throwing') {
      this._stateT += dt;
      if (!this._thrown && this._stateT >= THROW_RELEASE) {
        this._thrown = true;
        this._emitThrow(def, player);
      }
      if (this._stateT >= this._stateDur) {
        this._state = 'idle';
        // Out of that grenade: back to the gun it was thrown from.
        const last = this.lastWeaponId;
        const lastDef = last && WEAPONS[last];
        const next = this.owns(def.id)
          ? def.id
          : (lastDef && lastDef.slot !== 4 && this.owns(last) ? last : this.slots[1] || this.slots[2] || 'knife');
        if (next !== def.id) {
          // Back on the gun the grenade came from: Q goes where it went before.
          const before = this._lastBeforeThrow;
          this.lastWeaponId = before && before !== next && this.owns(before)
            ? before
            : (next === this.slots[1] ? this.slots[2] : this.slots[1]) || null;
        }
        this._forceEquip(next, FAST_SWITCH_TIME, false);
      }
    }

    // ---- AWP auto re-scope after bolt cycle --------------------------------
    if (this._rescopeAt > 0 && this._now >= this._rescopeAt) {
      this._rescopeAt = -1;
      const d = this.current();
      if (d.zoomFov && this._state === 'idle') {
        this.scopeLevel = this._rescopeLevel;
        const fov = d.zoomFov[this.scopeLevel - 1];
        this._fovTarget = fov;
        g.events.emit('weapon:scope', { level: this.scopeLevel, fov: fov });
      }
    }

    // ---- RMB: scope toggle (buffered briefly through a raise) ---------------
    if (this._rmbQueued) {
      // Kept for the whole raise (the AWP's is 0.45 s); otherwise briefly.
      const stale = this._state !== 'equipping' && this._now - this._rmbQueuedAt > INPUT_BUFFER * 4;
      if (this._state === 'idle' || stale) {
        this._rmbQueued = false;
        this._toggleScope();
      }
    }

    const buyOpen = !!(state && state.buyOpen);
    const held = !!(input && input.firing && input.locked !== false);
    const isGrenade = def.slot === 4;

    // ---- sprint: no firing while sprinting, then a short sprint-out --------
    const sprinting = !!(player && player.sprinting);
    if (this._wasSprinting && !sprinting) {
      this._sprintRecoverAt = this._now + this._sprintOutTime(def);
    }
    this._wasSprinting = sprinting;
    const sprintLocked = sprinting || this._now < this._sprintRecoverAt;

    // ---- aim down sights ---------------------------------------------------
    this._updateAds(dt, def, input, buyOpen, sprinting);

    // ---- grenade wind-up / release ----------------------------------------
    if (this._state === 'winding') {
      if (!isGrenade || phase === 'freeze' || buyOpen) {
        this._state = 'idle'; // cancelled, grenade not consumed
      } else if (this._releaseQueued || !held) {
        this._state = 'throwing';
        this._stateT = 0;
        this._stateDur = THROW_DUR;
        this._thrown = false;
      }
    }

    const fireBlocked =
      phase === 'freeze' ||
      buyOpen ||
      this._state === 'equipping' ||
      this._state === 'reloading' ||
      this._state === 'winding' ||
      this._state === 'throwing' ||
      sprintLocked;

    // ---- trigger -----------------------------------------------------------
    if (!fireBlocked) {
      if (isGrenade) {
        // Fresh click pulls the pin; release throws.
        if (this._semiQueued && this._grenadeCount(def.id) > 0) {
          this._state = 'winding';
          this._stateT = 0;
          this._stateDur = 0;
        }
      } else if (this._semiQueued || (def.auto && held)) {
        this._tryFire(def, player);
      }
    }
    // A click that only lost to the sprint-out fires as soon as it ends; any
    // other click waits INPUT_BUFFER for a cooldown or raise to finish.
    // A grenade click is kept for the whole raise after a throw (0.35 s), so
    // throwing a second one does not need a click timed to the frame it ends.
    const buffered = this._semiQueued && (isGrenade
      ? this._state === 'equipping'
      : this._now - this._semiQueuedAt <= INPUT_BUFFER);
    if (!(sprintLocked && !sprinting && this._semiQueued) && !buffered) this._semiQueued = false;
    this._releaseQueued = false;

    // ---- recoil / bloom recovery (trigger discipline pays off) -------------
    this._decayRecoil(dt, def);
  }

  // ==========================================================================
  // Input event handlers (queue only; consumed in update)
  // ==========================================================================
  _onMouseDown(e) {
    if (!e) return;
    if (e.button === 0) {
      this._semiQueued = true;
      this._semiQueuedAt = this._now;
    } else if (e.button === 2) {
      this._rmbQueued = true;
      this._rmbQueuedAt = this._now;
    }
  }

  _onMouseUp(e) {
    if (e && e.button === 0) this._releaseQueued = true;
  }

  _onWheel(e) {
    const dir = e && e.dir ? e.dir : 0;
    if (!dir) return;
    if (this.game.player && this.game.player.alive === false) return;
    const list = this._equipList();
    if (list.length < 2) return;
    let idx = list.indexOf(this.currentId);
    if (idx === -1) idx = 0;
    const next = list[(idx + (dir > 0 ? 1 : -1) + list.length) % list.length];
    this.equip(next);
  }

  _onKey(e) {
    const key = e && e.key;
    if (!key) return;
    // Dead, 1-4 pick the next class (HUD); here they would only replay the
    // equip sound and raise on a body.
    if (key !== 'b' && this.game.player && this.game.player.alive === false) return;
    switch (key) {
      case '1':
        if (this.slots[1]) this.equip(this.slots[1]);
        break;
      case '2':
        if (this.slots[2]) this.equip(this.slots[2]);
        break;
      case '3':
        this.equip('knife');
        break;
      case '4':
        this._cycleGrenade();
        break;
      case 'q': {
        const last = this.lastWeaponId;
        if (last && this.owns(last)) this.equip(last);
        break;
      }
      case 'r':
        this._startReload();
        break;
      case 'b':
        this.game.events.emit('ui:toggle-buy');
        break;
      default:
        break;
    }
  }

  // ==========================================================================
  // Firing
  // ==========================================================================
  /**
   * Next shot time keeps the sub-frame remainder of a sustained burst, so the
   * cyclic rate matches `rpm` instead of rounding every gap up to a frame.
   */
  _scheduleNextShot(def) {
    const interval = 60 / def.rpm;
    const late = this._now - this._nextFireAt;
    // Only a SUB-FRAME remainder carries (a step is at most 0.05 s). Carrying
    // anything up to a whole interval meant a semi-auto clicked shortly after
    // its cooldown ended had its next shot scheduled from the stale time — the
    // AWP's second bolt came 0.24 s early at 144 fps, a pistol's could double-tap.
    this._nextFireAt = (late >= 0 && late < Math.min(interval, 0.05) ? this._nextFireAt : this._now) + interval;
  }

  _tryFire(def, player) {
    if (this._now < this._nextFireAt) return;
    this._semiQueued = false; // this click is spent, whatever happens next

    if (def.melee) {
      this._nextFireAt = this._now + 60 / def.rpm;
      this._fireShot(def, player, true);
      return;
    }

    const ammo = this.ammo[def.id];
    if (!ammo || ammo.mag <= 0) {
      this._tryDryFire(def, ammo);
      return;
    }

    ammo.mag -= 1;
    this._scheduleNextShot(def);
    this._fireShot(def, player, false);

    // AWP: shot forces a brief unscope while the bolt cycles, then re-scopes.
    if (def.zoomFov && this.scopeLevel > 0) {
      this._rescopeLevel = this.scopeLevel; // back to the zoom the player chose
      this.scopeLevel = 0;
      const base = this._baseFov();
      this._fovTarget = base;
      this.game.events.emit('weapon:scope', { level: 0, fov: base });
      this._rescopeAt = this._now + RESCOPE_DELAY;
    }
  }

  _tryDryFire(def, ammo) {
    // The click sound is rate-limited; the auto-reload is not — an empty
    // trigger pull always racks a reload when there's reserve ammo.
    if (this._now >= this._dryAt) {
      this._dryAt = this._now + DRYFIRE_INTERVAL;
      this.game.events.emit('weapon:dryfire', { id: def.id });
    }
    if (ammo && ammo.reserve > 0) this._startReload();
    else if (ammo && ammo.mag <= 0) this._switchFromEmpty(def);
  }

  /**
   * Bone dry (no mag, no reserve): a trigger pull after the click goes to the
   * other gun if it has rounds, else the knife, instead of clicking forever.
   */
  _switchFromEmpty(def) {
    const other = def.slot === 1 ? this.slots[2] : def.slot === 2 ? this.slots[1] : null;
    const left = other && this.ammo[other];
    const next = left && (left.mag > 0 || left.reserve > 0) ? other : 'knife';
    if (next !== def.id && this.owns(next)) this.equip(next);
  }

  _fireShot(def, player, melee) {
    const cam = this.game.camera;
    cam.getWorldDirection(this._fwd);

    // Decompose camera forward into yaw/pitch so drift + spread apply in
    // stable angular space regardless of camera convention.
    let pitch = Math.asin(clamp(this._fwd.y, -1, 1));
    let yaw = Math.atan2(this._fwd.x, this._fwd.z);

    if (!melee) {
      // Current shot flies with the EXISTING drift (first bullet true to the
      // crosshair) plus a gaussian sample of the live spread cone.
      const spread = this.currentSpread();
      const sigma = spread * 0.45;
      // A scoped bolt-action shot must agree with the reticle. AWP recoil is
      // applied after firing, while unscoped shots and automatic weapons keep
      // the accumulated ballistic drift. Movement/jump spread still applies.
      const scopedBolt = !!(def.zoomFov && this.scopeLevel > 0);
      // The camera already shows VIEW_RECOIL_SHARE of the drift.
      const hidden = 1 - VIEW_RECOIL_SHARE;
      const driftP = scopedBolt ? 0 : this._driftP * hidden;
      const driftY = scopedBolt ? 0 : this._driftY * hidden;
      pitch += driftP + clamp(gauss() * sigma, -spread, spread);
      yaw += driftY + clamp(gauss() * sigma, -spread, spread);
    }

    const cp = Math.cos(pitch);
    // Per-shot allocation is fine — event consumers may retain these.
    const dir = new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const origin = player.eyePos().clone();

    const payload = { weaponId: def.id, origin: origin, dir: dir, byPlayer: true };
    if (melee) payload.melee = true;
    // A suppressed primary hides its muzzle flash and dims its tracer.
    if (!melee && def.slot === 1 && hasAttachment(player, 'suppressor')) payload.suppressed = true;
    if (!melee && def.pellets > 1) {
      // Extra pellets fan out around the aimed direction (uniform in a disc).
      payload.pellets = [];
      const cone = def.pelletSpread || 0.05;
      for (let i = 1; i < def.pellets; i++) {
        const r = cone * Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        const pp = pitch + Math.sin(a) * r;
        const py = yaw + Math.cos(a) * r;
        const c = Math.cos(pp);
        payload.pellets.push(new THREE.Vector3(Math.sin(py) * c, Math.sin(pp), Math.cos(py) * c));
      }
    }
    this.game.events.emit('weapon:fire', payload);
    this._lastShotAt = this._now;

    if (melee) {
      if (player.addViewPunch) {
        player.addViewPunch(0.006, (Math.random() - 0.5) * 0.006);
      }
      return;
    }

    // ---- advance the spray: pattern kick joins the drift AFTER this shot ---
    const rec = def.recoil;
    const pat = rec.pattern;
    let kp = rec.pitchPerShot;
    let ky = 0;
    if (pat && pat.length) {
      const idx = Math.min(pat.length - 1, this._recoilIndexF | 0);
      kp = pat[idx].p;
      ky = pat[idx].y;
    }
    if (def.slot === 1 && hasAttachment(player, 'grip')) {
      kp *= PERK_TUNING.GRIP_RECOIL;
      ky *= PERK_TUNING.GRIP_RECOIL;
    }
    // Shouldered, the gun climbs less.
    const steady = 1 - ADS_RECOIL_CUT * this.adsT;
    kp *= steady;
    ky *= steady;
    if (typeof player.applyRecoil === 'function') {
      // The kick goes into the player's aim (player.applyRecoil): what you see
      // is what you shoot. The old model kept 40% of the climb as a hidden
      // bullet offset no amount of pulling down could correct, then sprang
      // the view back on release against the player's own compensation.
      player.applyRecoil(kp, ky);
    } else {
      // Actors without an aim to kick (tests, tools) keep the drift model.
      this._driftP = Math.min(DRIFT_CLAMP, this._driftP + kp);
      this._driftY = clamp(this._driftY + ky, -DRIFT_CLAMP, DRIFT_CLAMP);
    }
    this._recoilIndexF = Math.min(pat && pat.length ? pat.length : 30, this._recoilIndexF + 1);
    this._bloom = Math.min(def.bloomMax, this._bloom + def.bloomPerShot);

    // Cosmetic view kick (player decays it ~8/s) — part of the punch feel;
    // the aim drift above is what actually steers bullets.
    if (player.addViewPunch) {
      player.addViewPunch(
        kp * 0.25,
        ky * 0.5 + (Math.random() - 0.5) * rec.yawJitter
      );
    }
  }

  // Recoil recovery: drift and recoilIndex unwind once the trigger rests;
  // bloom recovers continuously, much faster off-trigger.
  _decayRecoil(dt, def) {
    const rec = def && def.recoil ? def.recoil : null;
    const interval = def && def.rpm > 0 ? 60 / def.rpm : 0.2;
    const idleFor = this._now - this._lastShotAt;

    if (idleFor > Math.min(interval * 1.6 + 0.06, RECOVERY_WAIT_MAX)) {
      const rate = rec ? rec.recovery : 8;
      const k = Math.exp(-rate * dt);
      this._driftP *= k;
      this._driftY *= k;
      if (Math.abs(this._driftP) < 1e-4) this._driftP = 0;
      if (Math.abs(this._driftY) < 1e-4) this._driftY = 0;
      this._recoilIndexF = Math.max(0, this._recoilIndexF - dt * rate * 1.6);
    }

    if (this._bloom > 0) {
      const brate = idleFor > interval + 0.05 ? 5 : 1.2;
      this._bloom *= Math.exp(-brate * dt);
      if (this._bloom < 1e-5) this._bloom = 0;
    }
  }

  // ==========================================================================
  // Grenades
  // ==========================================================================
  _emitThrow(def, player) {
    const cam = this.game.camera;
    cam.getWorldDirection(this._fwd);
    const dir = this._fwd.clone();
    const origin = player.eyePos().clone();
    this.game.events.emit('grenade:throw', {
      type: def.id,
      origin: origin,
      dir: dir,
      strength: def.throwStrength || 14,
    });
    this._consumeGrenade(def.id);
  }

  _grenadeCount(id) {
    const arr = this.slots[4];
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] === id) n++;
    return n;
  }

  _consumeGrenade(id) {
    const arr = this.slots[4];
    const i = arr.indexOf(id);
    if (i !== -1) arr.splice(i, 1);
    this._syncGrenadeAmmo(id);
  }

  _syncGrenadeAmmo(id) {
    const n = this._grenadeCount(id);
    if (n > 0) {
      let a = this.ammo[id];
      if (!a) {
        a = { mag: 0, reserve: 0 };
        this.ammo[id] = a;
      }
      a.mag = n;
      a.reserve = 0;
    } else {
      delete this.ammo[id];
    }
  }

  _cycleGrenade() {
    const order = GRENADE_ORDER;
    const owned = [];
    for (let i = 0; i < order.length; i++) {
      if (this._grenadeCount(order[i]) > 0) owned.push(order[i]);
    }
    if (!owned.length) return;
    const cur = owned.indexOf(this.currentId);
    const next = owned[(cur + 1) % owned.length];
    this.equip(next);
  }

  // ==========================================================================
  // Equip / reload
  // ==========================================================================
  _equipList() {
    const out = [];
    if (this.slots[1]) out.push(this.slots[1]);
    if (this.slots[2]) out.push(this.slots[2]);
    if (this.slots[3]) out.push(this.slots[3]);
    const seen = {};
    const g4 = this.slots[4];
    for (let i = 0; i < g4.length; i++) {
      if (!seen[g4[i]]) {
        seen[g4[i]] = 1;
        out.push(g4[i]);
      }
    }
    return out;
  }

  /** Raise time for a weapon (s), by its slot. */
  _switchTime(id) {
    const def = WEAPONS[id];
    return (def && SWITCH_TIME[def.slot]) || SWITCH_TIME[1];
  }

  _forceEquip(id, dur, trackLast) {
    // A non-finite duration would leave the state machine 'equipping' forever
    // (stateT >= NaN is never true) — a gun that can never fire.
    if (!Number.isFinite(dur) || dur < 0) dur = SWITCH_TIME[1];
    this._cancelActivity();
    this._reloadQueued = false;
    // Each gun keeps its own cooldown: the AWP's 1.46 s bolt used to lock out
    // a pistol drawn straight after the shot (the click was lost), and a
    // shared reset would let a quick switch skip the bolt instead.
    if (id !== this.currentId) {
      if (!this._nextFireById) this._nextFireById = {};
      if (this.currentId) this._nextFireById[this.currentId] = this._nextFireAt;
      const own = this._nextFireById[id];
      this._nextFireAt = Number.isFinite(own) ? own : 0;
    }
    this.game.input?.clearAimLatch?.(); // toggle aim drops on a switch
    if (id !== this.currentId) {
      // A click or right-click queued for the outgoing weapon must not fire
      // the incoming one (a grenade thrown, an AWP raised scoped); clicks made
      // during the new raise arrive after this and are still buffered.
      this._semiQueued = false;
      this._rmbQueued = false;
    }
    if (trackLast && id !== this.currentId) {
      // A respawn loadout may already have replaced the held weapon (the team
      // pistol swapped for the class sidearm): Q goes to what is in its slot.
      const cur = this.currentId;
      const inSlot = cur && WEAPONS[cur] ? this.slots[WEAPONS[cur].slot] : null;
      const last = this.owns(cur) ? cur : (typeof inSlot === 'string' ? inSlot : null);
      if (WEAPONS[id] && WEAPONS[id].slot === 4) this._lastBeforeThrow = this.lastWeaponId;
      if (last && last !== id) this.lastWeaponId = last;
    }
    this.currentId = id;
    this._state = 'equipping';
    this._stateT = 0;
    this._stateDur = dur;
    // Switching resets the spray — CS muscle memory.
    this._recoilIndexF = 0;
    this._driftP = 0;
    this._driftY = 0;
    this._bloom = 0;
    this.game.events.emit('weapon:equip', { id: id, duration: dur });
  }

  _cancelActivity() {
    // Cancels reload / wind-up / throw-in-progress silently. A grenade whose
    // pin was pulled but not yet released is kept (no consume happened).
    this._state = 'idle';
    this._stateT = 0;
    this._stateDur = 0;
    this._thrown = false;
    this.adsT = 0;
    this._unscope();
  }

  _startReload() {
    const def = this.current();
    if (!def || def.melee || def.slot === 4 || def.magSize <= 0) return;
    if (this._state === 'equipping') {
      this._reloadQueued = true; // runs when the raise ends
      return;
    }
    if (
      this._state === 'reloading' ||
      this._state === 'winding' ||
      this._state === 'throwing'
    ) {
      return;
    }
    const ammo = this.ammo[def.id];
    if (!ammo || ammo.reserve <= 0 || ammo.mag >= this.magSizeOf(def)) return;
    const player = this.game.player;
    if (player && player.alive === false) return;

    this._unscope(); // reloading the AWP drops the scope
    this.game.input?.clearAimLatch?.();
    this._state = 'reloading';
    this._stateT = 0;
    this._stateDur = def.reloadTime * (hasPerk(player, 'quickhands') ? PERK_TUNING.QUICKHANDS_RELOAD : 1);
    this.game.events.emit('weapon:reload:start', { id: def.id, duration: this._stateDur });
  }

  // ==========================================================================
  // Scope / FOV
  // ==========================================================================
  _updateAds(dt, def, input, buyOpen, sprinting) {
    const can = this._canAds(def);
    const want = can && !!(input && input.aiming) && !buyOpen && !sprinting &&
      this._state !== 'reloading' && this._state !== 'equipping';
    const rate = can ? 1 / (def.adsTime || ADS_TIME[def.slot]) : 8;
    this.adsT = want ? Math.min(1, this.adsT + dt * rate) : Math.max(0, this.adsT - dt * rate);
    if (can && this.scopeLevel === 0 && this._rescopeAt < 0) {
      const e = this.adsT * this.adsT * (3 - 2 * this.adsT);
      const fov = this._baseFov() * (1 - ADS_ZOOM[def.slot] * e);
      // ADS already eases; drive the camera directly instead of re-smoothing.
      this._fovTarget = fov;
      this._fovCurrent = fov;
      const cam = this.game.camera;
      if (cam && Math.abs(cam.fov - fov) > 1e-3) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    }
  }

  _baseFov() {
    const cfg = this.game.config;
    return (cfg && cfg.PLAYER && cfg.PLAYER.FOV) || 74;
  }

  _toggleScope() {
    const def = this.current();
    if (!def || !def.zoomFov) return;
    if (this._state !== 'idle') return;
    this._rescopeAt = -1; // manual toggle overrides a pending auto re-scope
    const levels = def.zoomFov.length;
    this.scopeLevel = (this.scopeLevel + 1) % (levels + 1);
    const fov =
      this.scopeLevel === 0 ? this._baseFov() : def.zoomFov[this.scopeLevel - 1];
    this._fovTarget = fov;
    this.game.events.emit('weapon:scope', { level: this.scopeLevel, fov: fov });
  }

  _unscope() {
    this._rescopeAt = -1;
    const base = this._baseFov();
    if (this.scopeLevel > 0) {
      this.scopeLevel = 0;
      this._fovTarget = base;
      this.game.events.emit('weapon:scope', { level: 0, fov: base });
    } else {
      this._fovTarget = base;
    }
  }

  _updateFov(dt) {
    const diff = this._fovTarget - this._fovCurrent;
    if (diff === 0) return;
    if (Math.abs(diff) < 0.02) {
      this._fovCurrent = this._fovTarget;
    } else {
      this._fovCurrent += diff * (1 - Math.exp(-FOV_LERP_RATE * dt));
    }
    const cam = this.game.camera;
    if (cam) {
      cam.fov = this._fovCurrent;
      cam.updateProjectionMatrix();
    }
  }
}

// Re-exports for convenience (bots/HUD may import from either file).
export { WEAPONS, GEAR, BUY_MENU };
