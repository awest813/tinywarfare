// ---------------------------------------------------------------------------
// TINY WARFARE — src/core/gamepad.js
//
// Controller support (any pad the browser exposes with the "standard"
// mapping: Xbox, PlayStation, Switch Pro, most generic pads).
//
// The pad drives the same virtual-input API the touch controls use, so
// player, weapons and HUD see ordinary keys, mouse buttons, look pixels and
// an analog move vector and need to know nothing about controllers:
//
//   left stick      move (analog)            L3   sprint (latched while moving)
//   right stick     look                     R3   knife
//   RT              fire                     LT   aim down sights
//   A               jump                     B    crouch / slide (held)
//   X               tap: reload, hold: use / plant / defuse
//   Y               next weapon              RB   last weapon
//   LB              grenade                  D-pad up/right/left  streaks 1-3
//   D-pad down      buy menu                 View hold scoreboard
//   Start           pause / resume
//
// Out of a match (menus, pause, buy, settings) the pad navigates the page:
// D-pad or left stick moves focus to the nearest control in that direction,
// A presses it, B backs out (Escape), and left/right nudges a focused slider.
//
// Pointer lock cannot be taken from a gamepad press (it needs a user gesture
// in the page), so a pad takes the same simulated lock touch mode uses; a
// mouse click still upgrades to a real one.
// ---------------------------------------------------------------------------

// Standard-mapping indices.
const B = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

const MOVE_DEADZONE = 0.16;
const LOOK_DEADZONE = 0.12;
const TRIGGER_ON = 0.35;
// Full right-stick deflection turns this fast at 1.00x look sensitivity, in
// the "input pixels" player.js scales by BASE_LOOK_SENSITIVITY (0.0022 rad).
const LOOK_PX_PER_S = 1450;          // ~183 deg/s
const LOOK_CURVE = 2.2;              // fine control near the centre
const USE_HOLD_S = 0.28;             // X held this long is Use, not Reload
const NAV_REPEAT_DELAY = 0.38;
const NAV_REPEAT_RATE = 0.11;
const ACTIVE_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd']);

function radial(x, y, dead) {
  const m = Math.hypot(x, y);
  if (m < dead) return [0, 0, 0];
  const k = Math.min(1, (m - dead) / (1 - dead)) / m;
  return [x * k, y * k, Math.min(1, (m - dead) / (1 - dead))];
}

export default class Gamepads {
  constructor(game) {
    this.game = game;
    this.connected = false;
    this.active = false;          // the last input came from a pad
    this._prev = new Array(17).fill(false);
    this._held = new Set();       // virtual actions / buttons this module holds
    this._xHeld = 0;
    this._sprintLatch = false;
    this._navDir = null;
    this._navT = 0;
    this._index = -1;

    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', (e) => this._onConnect(e));
      window.addEventListener('gamepaddisconnected', (e) => this._onDisconnect(e));
      // Any mouse movement or key hands control back to keyboard and mouse.
      // (Trusted events only: the pad's own Escape for "back" is synthetic.)
      window.addEventListener('mousemove', (e) => { if (e.isTrusted && (e.movementX || e.movementY)) this._setActive(false); });
      window.addEventListener('keydown', (e) => { if (e.isTrusted) this._setActive(false); }, { capture: true });
    }
    game.events?.on?.('input:unlock', () => this._releaseAll());
    // A focus ring the pad can be followed by (keyboard focus styles in the
    // menus are subtle; on a TV-distance screen they must not be).
    if (typeof document !== 'undefined' && document.head && !document.getElementById('gamepad-nav-style')) {
      const style = document.createElement('style');
      style.id = 'gamepad-nav-style';
      style.textContent = 'html.gamepad-nav :focus{outline:3px solid #ffd35a!important;outline-offset:2px!important;' +
        'box-shadow:0 0 0 6px rgba(255,211,90,.25)!important}';
      document.head.appendChild(style);
    }
  }

  _onConnect(e) {
    if (!e?.gamepad || e.gamepad.mapping !== 'standard') return;
    this.connected = true;
    this.game.events?.emit?.('hud:notice', { text: 'CONTROLLER CONNECTED' });
  }

  _onDisconnect(e) {
    if (e?.gamepad && e.gamepad.index === this._index) {
      this._releaseAll();
      this._index = -1;
      this.connected = this._pad() !== null;
      this.game.events?.emit?.('hud:notice', { text: 'CONTROLLER DISCONNECTED' });
    }
  }

  _setActive(on) {
    if (this.active === on) return;
    this.active = on;
    if (typeof document !== 'undefined') document.documentElement?.classList?.toggle('gamepad-nav', on);
  }

  _pad() {
    const list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    if (!list) return null;
    const cur = this._index >= 0 ? list[this._index] : null;
    if (cur && cur.connected && cur.mapping === 'standard') return cur;
    for (const p of list) {
      if (p && p.connected && p.mapping === 'standard') { this._index = p.index; return p; }
    }
    return null;
  }

  update(dt) {
    const pad = this._pad();
    if (!pad) {
      if (this._held.size) this._releaseAll();
      return;
    }
    const btn = pad.buttons;
    const down = (i) => !!(btn[i] && (btn[i].pressed || btn[i].value > TRIGGER_ON));
    const now = new Array(17);
    for (let i = 0; i < 17; i++) now[i] = down(i);
    const pressed = (i) => now[i] && !this._prev[i];
    const released = (i) => !now[i] && this._prev[i];
    const ax = pad.axes;
    const anyInput = now.some(Boolean) || Math.hypot(ax[0] || 0, ax[1] || 0) > 0.5 || Math.hypot(ax[2] || 0, ax[3] || 0) > 0.5;
    if (anyInput) this._setActive(true);

    const input = this.game.input;
    const phase = this.game.state?.phase;
    const inMatch = ACTIVE_PHASES.has(phase);

    if (input && inMatch && input.locked) {
      this._play(dt, now, pressed, released, ax, input);
    } else {
      if (this._held.size) this._releaseAll();
      // Start resumes a paused match; anything else navigates the page.
      if (inMatch && pressed(B.START) && !this._overlayOpen()) {
        input?.requestLock?.({ virtual: true });
      } else if (this.active) {
        this._navigate(dt, now, pressed, ax);
      }
    }
    this._prev = now;
  }

  // ---- gameplay ------------------------------------------------------------

  _hold(id, on, setter) {
    const key = id;
    if (on && !this._held.has(key)) { this._held.add(key); setter(true); }
    else if (!on && this._held.has(key)) { this._held.delete(key); setter(false); }
  }

  _play(dt, now, pressed, released, ax, input) {
    // Move: forward is -y on the stick, +y in the move vector.
    const [mx, my, mm] = radial(ax[0] || 0, ax[1] || 0, MOVE_DEADZONE);
    input.setMoveVector(mx, my ? -my : 0);
    this._padMoving = mm > 0;

    // Look: radial deadzone, then a power curve for precision near centre.
    const [lx, ly, lm] = radial(ax[2] || 0, ax[3] || 0, LOOK_DEADZONE);
    if (lm > 0) {
      const curve = Math.pow(lm, LOOK_CURVE) / lm;
      input.addVirtualLook(lx * curve * LOOK_PX_PER_S * dt, ly * curve * LOOK_PX_PER_S * dt);
    }

    const button = (b, on) => this._hold('btn' + b, on, (v) => input.setVirtualButton(b, v));
    const action = (a, on) => this._hold(a, on, (v) => input.setVirtualAction(a, v));
    button(0, now[B.RT]);
    button(2, now[B.LT]);
    action('jump', now[B.A]);
    action('crouch', now[B.B]);
    action('scoreboard', now[B.VIEW]);

    // Sprint: L3 latches it on until the stick comes back.
    if (pressed(B.L3)) this._sprintLatch = true;
    if (mm < 0.3 || -my < 0.2) this._sprintLatch = false;
    action('sprint', this._sprintLatch);

    // X: a tap reloads on release; held, it becomes Use (plant / defuse).
    if (now[B.X]) {
      this._xHeld += dt;
      if (this._xHeld >= USE_HOLD_S) action('use', true);
    } else {
      if (released(B.X) && this._xHeld < USE_HOLD_S) input.pulseVirtualAction('reload');
      this._xHeld = 0;
      action('use', false);
    }

    if (pressed(B.Y)) input.virtualWheel(1);
    if (pressed(B.RB)) input.pulseVirtualAction('lastWeapon');
    if (pressed(B.LB)) input.pulseVirtualAction('weapon4');
    if (pressed(B.R3)) input.pulseVirtualAction('weapon3');
    if (pressed(B.UP)) input.pulseVirtualAction('streak1');
    if (pressed(B.RIGHT)) input.pulseVirtualAction('streak2');
    if (pressed(B.LEFT)) input.pulseVirtualAction('streak3');
    if (pressed(B.DOWN)) input.pulseVirtualAction('buy');
    if (pressed(B.START)) input.releaseLock();
  }

  _releaseAll() {
    const input = this.game.input;
    for (const id of this._held) {
      if (id.startsWith('btn')) input?.setVirtualButton?.(Number(id.slice(3)), false);
      else input?.setVirtualAction?.(id, false);
    }
    this._held.clear();
    if (this._padMoving) { input?.setMoveVector?.(0, 0); this._padMoving = false; }
    this._sprintLatch = false;
    this._xHeld = 0;
  }

  // ---- menus -------------------------------------------------------------

  _overlayOpen() {
    const hud = this.game.hud;
    return !!(hud && (hud._settingsOpen || hud._buyOpen || hud._howtoOpen || hud._onlineOpen ||
      hud._profileOpen || hud._leaderboardOpen));
  }

  _navigate(dt, now, pressed, ax) {
    if (typeof document === 'undefined') return;
    let dir = null;
    if (now[B.UP] || (ax[1] || 0) < -0.6) dir = 'up';
    else if (now[B.DOWN] || (ax[1] || 0) > 0.6) dir = 'down';
    else if (now[B.LEFT] || (ax[0] || 0) < -0.6) dir = 'left';
    else if (now[B.RIGHT] || (ax[0] || 0) > 0.6) dir = 'right';
    if (dir !== this._navDir) {
      this._navDir = dir;
      this._navT = NAV_REPEAT_DELAY;
      if (dir) this._step(dir);
    } else if (dir) {
      this._navT -= dt;
      if (this._navT <= 0) { this._navT = NAV_REPEAT_RATE; this._step(dir); }
    }
    const el = document.activeElement;
    if (pressed(B.A) && el && el !== document.body && typeof el.click === 'function') el.click();
    if (pressed(B.B) || (pressed(B.START) && this._overlayOpen())) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
  }

  _focusables() {
    const sel = 'button, a[href], input, select, [tabindex]:not([tabindex="-1"])';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.disabled || el.closest('[hidden], [aria-hidden="true"], #touch-controls')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 ||
        r.top > innerHeight || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || Number(cs.opacity) === 0) continue;
      // Only what is actually on top at its centre (an overlay hides the menu
      // behind it from the pad, as it does from the mouse).
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top && top !== el && !el.contains(top)) continue;
      out.push({ el, r });
    }
    return out;
  }

  /** Spatial navigation: the nearest control whose centre lies that way. */
  _step(dir) {
    const cur = document.activeElement;
    if (cur && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      if (dir === 'left') cur.stepDown(); else cur.stepUp();
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      cur.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const items = this._focusables();
    if (!items.length) return;
    const from = cur && cur !== document.body ? items.find((i) => i.el === cur) : null;
    if (!from) { items[0].el.focus({ preventScroll: false }); return; }
    const cx = from.r.left + from.r.width / 2, cy = from.r.top + from.r.height / 2;
    let best = null, bestScore = Infinity;
    for (const it of items) {
      if (it.el === cur) continue;
      const x = it.r.left + it.r.width / 2, y = it.r.top + it.r.height / 2;
      const dx = x - cx, dy = y - cy;
      const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 4) continue;
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = it.el; }
    }
    if (best) {
      best.focus({ preventScroll: false });
      best.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }
}
