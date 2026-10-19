// ---------------------------------------------------------------------------
// TINY WARFARE — src/core/input.js
//
// Keyboard / mouse / touch / pointer-lock input subsystem (spec section A).
//
// Public API (exact, per SPEC.md):
//   locked        (bool)  — pointer lock active. In game.debug the lock is
//                           simulated: true after the canvas is clicked once
//                           or immediately after requestLock().
//   isDown(key)   (bool)  — lowercase single char ('w','b'), ' ' for space,
//                           or 'shift' | 'control' | 'tab' | 'escape'.
//   wasPressed(key) (bool)— true for the frame of a hardware or touch press.
//   isActionDown(action) / wasActionPressed(action) — semantic equivalents.
//   consumeLook()         — { dx, dy } pixels accumulated since last call,
//                           then zeroed. Accumulates only while locked.
//   firing        (bool)  — LMB currently held (while locked).
//   aiming        (bool)  — RMB currently held (while locked).
//   requestLock(options)  — request a virtual or real lock on game.canvas
//                           ({ virtual: true } or an active gamepad: simulated).
//   setTouchMode(on)      — use a virtual lock on touch-only browsers.
//   setVirtualKey(k,on)   — feed a held key from an on-screen control.
//   pulseVirtualKey(k)    — feed a one-frame key press.
//   setVirtualAction / pulseVirtualAction — semantic touch input.
//   captureNextKey / cancelKeyCapture — remap without gameplay leakage.
//   setVirtualButton(b,on)— feed a held mouse button from touch.
//   addVirtualLook(dx,dy) — add touch-look pixels to consumeLook().
//   setMoveVector(x,y)    — set analog strafe/forward input (-1..1).
//   moveVector()          — current analog movement (reused object).
//   virtualWheel(dir)     — cycle weapons from an on-screen control.
//   releaseVirtualControls() — release every touch-owned input source.
//   update(dt)            — clears one-frame state (wheel, just-pressed).
//
// Events emitted on game.events:
//   'input:keydown'   { key, source? } lowercased press edge (no repeat)
//   'input:mousedown' { button }  only while locked (0 left, 2 right)
//   'input:mouseup'   { button }  only while locked
//   'input:wheel'     { dir }     +1 down / -1 up, only while locked
//   'input:lock' / 'input:unlock' on pointer-lock change (lock simulated in
//                                 debug mode)
//
// Design notes:
//  - Listeners are attached to `window` so synthetic events dispatched by
//    automated tests are observed like real input. Keydown uses capture phase
//    so a remap can stop target handlers before the assigned key leaks through.
//  - Auto-repeat keydown is filtered twice: via `e.repeat` AND via the
//    held-key set (covers synthetic events that forget the repeat flag).
//  - Tab / space / quote / slash / arrows / alt are suppressed while locked so
//    the page never scrolls or opens quick-find mid-firefight. Unlocked Tab is
//    left alone so menu and Settings controls remain keyboard-accessible.
//  - contextmenu over the canvas (or while locked) is suppressed so RMB
//    aiming never pops a menu.
//  - Pointer-lock is requested with { unadjustedMovement: true } for raw,
//    accel-free mouse input (falls back cleanly where unsupported).
//  - Huge single-event movement spikes (a known Chromium pointer-lock bug)
//    are discarded in real mode; debug mode accepts anything so tests can
//    fling the view with one large synthetic mousemove.
//  - Window blur / tab-hide / unlock release all held keys and buttons so
//    nothing ever sticks (with matching 'input:mouseup' emissions while the
//    lock is still considered active, keeping listener state consistent —
//    e.g. a wound-up grenade gets its release event).
//  - Zero allocation in per-frame paths: consumeLook() returns a reused
//    object, update() only clears sets/counters.
// ---------------------------------------------------------------------------

import {
  canBindPhysicalKey,
  canonicalKeyForAction,
  KEY_BINDING_DEFINITIONS,
  normalizePhysicalKey,
} from './settings.js';

// Keys whose browser default is suppressed while the pointer is locked.
const PREVENT_WHILE_LOCKED = new Set([
  'tab',        // scoreboard instead of focus navigation during a match
  ' ',          // page scroll
  "'", '/',     // Firefox quick-find
  'alt',        // menu-bar focus
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);
const DEFAULT_GAME_KEYS = new Set(KEY_BINDING_DEFINITIONS.map((entry) => entry.defaultKey));

// Real-mode spike filter: a legit pointer-lock mousemove is far below this.
const MOVE_SPIKE_PX = 500;

// Wheel: accumulate normalized deltaY and emit one step per threshold cross.
// One discrete notch (~100-120) always yields exactly one 'input:wheel'.
const WHEEL_STEP = 25;
const WHEEL_STALE_MS = 200;
// Trackpad / smooth scrolling (per-event |delta| below SMOOTH_WHEEL_DELTA).
const SMOOTH_WHEEL_DELTA = 50;
const SMOOTH_WHEEL_STEP = 120;
const SMOOTH_WHEEL_HOLD_MS = 220;

/** Physical punctuation keys, by position, as their US unshifted character. */
export const PUNCTUATION_BY_CODE = Object.freeze({
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
  // ISO / JIS extra keys have no US character: named by position, so a key
  // pressed as '<' and released under Shift as '>' is still one key.
  IntlBackslash: 'intlbackslash', IntlRo: 'intlro', IntlYen: 'intlyen',
});

export default class Input {
  constructor(game) {
    this.game = game;

    // --- public state -----------------------------------------------------
    this.locked = false;
    this.firing = false;
    this.aiming = false;
    this.touchMode = false;
    this._virtualLock = false;

    // --- private state ----------------------------------------------------
    this._down = new Set();          // normalized keys currently held
    this._virtualDown = new Set();   // keys held by on-screen controls
    this._justPressed = new Set();   // pressed since last update() (one-frame)
    this._virtualJustPressed = new Set(); // touch-owned edges (for cancellation)
    this._buttonsDown = new Set();   // mouse buttons currently held
    this._virtualButtonsDown = new Set(); // buttons held by touch controls
    this._dx = 0;                    // accumulated look, pixels
    this._dy = 0;
    this._lookOut = { dx: 0, dy: 0 };// reused return object (no per-frame GC)
    this._move = { x: 0, y: 0, magnitude: 0 };
    this._wheelAcc = 0;
    this._wheelDir = 0;              // one-frame wheel state (cleared in update)
    this._wheelTime = 0;
    this._wheelHoldUntil = 0;
    this._lockedAt = -Infinity;      // performance.now() of the last real lock
    this._moveAt = -Infinity;        // last mousemove (spike filter)
    this._moveEma = 0;               // recent per-event motion (spike filter)
    this._warnedLockError = false;
    this._keyCapture = null;

    // Bind handlers once so add/removeEventListener stay symmetric.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onPointerLockError = this._onPointerLockError.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onVisibility = this._onVisibility.bind(this);

    // Listen on window so synthetic events (bubbles: true) reach us in tests.
    // Capture phase is required while remapping: target handlers (for example
    // Enter in the online room field) must not act before Input consumes it.
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    // passive: false — we preventDefault() wheel while locked.
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('blur', this._onBlur);

    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);
    document.addEventListener('visibilitychange', this._onVisibility);

    // Debug/test convenience: when the match auto-starts (rounds emits the
    // same flow as clicking START), simulate the lock immediately so tests
    // can drive the game without a click. Harmless outside debug (no-op).
    if (game && game.events && typeof game.events.on === 'function') {
      game.events.on('ui:start', () => {
        if (this.game.debug && !this.locked) this.requestLock();
      });
      game.events.on('settings:changed', (detail) => {
        if (detail?.kind === 'bindings' || detail?.kind === 'reset') {
          this._releaseHardwareKeys();
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** True while `key` (normalized: 'w', ' ', 'shift', 'control', ...) is held. */
  isDown(key) {
    return this._down.has(key) || this._virtualDown.has(key);
  }

  /** True only until this frame's update() clears the keydown edge. */
  wasPressed(key) {
    return this._justPressed.has(key);
  }

  /** Semantic counterparts used by touch controls and new gameplay code. */
  isActionDown(actionId) {
    const key = canonicalKeyForAction(actionId);
    return key ? this.isDown(key) : false;
  }

  wasActionPressed(actionId) {
    const key = canonicalKeyForAction(actionId);
    return key ? this.wasPressed(key) : false;
  }

  /**
   * Enable the pointer-lock-free input path used by phones and tablets.
   * Touch mode still exposes `locked=true` during play because weapon and HUD
   * systems use that flag to distinguish active gameplay from a paused mouse.
   */
  setTouchMode(enabled) {
    const next = !!enabled;
    if (next === this.touchMode) return;
    this.touchMode = next;
    if (!next) this.releaseVirtualControls();
  }

  /** Hold or release a normalized keyboard key from a virtual control. */
  setVirtualKey(key, down) {
    key = this._normalizeVirtualKey(key);
    if (key === null) return false;

    if (down) {
      if (this._virtualDown.has(key)) return false;
      const alreadyDown = this.isDown(key);
      this._virtualDown.add(key);
      if (!alreadyDown) {
        this._justPressed.add(key);
        this._virtualJustPressed.add(key);
        this.game.events.emit('input:keydown', { key, source: 'touch' });
      }
      return true;
    }

    return this._virtualDown.delete(key);
  }

  /** Emit a press edge without leaving a key held. */
  pulseVirtualKey(key) {
    const pressed = this.setVirtualKey(key, true);
    this.setVirtualKey(key, false);
    return pressed;
  }

  /** Feed a semantic action from touch without consulting physical bindings. */
  setVirtualAction(actionId, down) {
    const key = canonicalKeyForAction(actionId);
    return key ? this.setVirtualKey(key, down) : false;
  }

  pulseVirtualAction(actionId) {
    const key = canonicalKeyForAction(actionId);
    return key ? this.pulseVirtualKey(key) : false;
  }

  /**
   * Capture the next bare physical key before it can enter gameplay state.
   * Escape cancels; invalid browser chords leave capture active.
   */
  captureNextKey(onComplete, onInvalid = null) {
    if (this.locked || typeof onComplete !== 'function') return false;
    this.cancelKeyCapture('superseded');
    this._releaseHardwareKeys();
    this._keyCapture = {
      complete: onComplete,
      invalid: typeof onInvalid === 'function' ? onInvalid : null,
    };
    return true;
  }

  cancelKeyCapture(reason = 'cancelled') {
    const capture = this._keyCapture;
    if (!capture) return false;
    this._keyCapture = null;
    capture.complete(null, { cancelled: true, reason });
    return true;
  }

  /** Hold or release a mouse button from a virtual control. */
  setVirtualButton(button, down) {
    button = Number(button) | 0;
    if (button < 0 || button > 4) return false;

    if (down) {
      if (this._virtualButtonsDown.has(button)) return false;
      const alreadyDown = this._buttonIsDown(button);
      this._virtualButtonsDown.add(button);
      this._syncButtonFlags();
      if (!alreadyDown) {
        this.game.events.emit('input:mousedown', { button, source: 'touch' });
      }
      return true;
    }

    const wasDown = this._virtualButtonsDown.delete(button);
    this._syncButtonFlags();
    if (wasDown && !this._buttonIsDown(button)) {
      this.game.events.emit('input:mouseup', { button, source: 'touch' });
    }
    return wasDown;
  }

  /** Add finite, bounded touch-look movement to this frame's mouse delta. */
  addVirtualLook(dx, dy) {
    if (!this.locked) return;
    dx = Number(dx);
    dy = Number(dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // Pointer coalescing can occasionally deliver a large jump after a UI
    // interruption. Bound each event without limiting normal drag speed.
    this._dx += Math.max(-180, Math.min(180, dx));
    this._dy += Math.max(-180, Math.min(180, dy));
  }

  /** Set persistent analog strafe/forward movement from an on-screen stick. */
  setMoveVector(x, y) {
    x = Number(x);
    y = Number(y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = 0;
      y = 0;
    }
    const raw = Math.hypot(x, y);
    if (raw > 1) {
      x /= raw;
      y /= raw;
    }
    this._move.x = x;
    this._move.y = y;
    this._move.magnitude = Math.min(1, raw);
  }

  /** Current analog movement; returned object is reused and must not be kept. */
  moveVector() {
    return this._move;
  }

  /** Feed one normalized wheel step from a touch weapon-cycle control. */
  virtualWheel(dir) {
    dir = Number(dir);
    if (!this.locked || !Number.isFinite(dir) || dir === 0) return false;
    const normalized = dir > 0 ? 1 : -1;
    this._wheelDir = normalized;
    this.game.events.emit('input:wheel', { dir: normalized, source: 'touch' });
    return true;
  }

  /** Release touch-owned state without disturbing a hardware keyboard/mouse. */
  releaseVirtualControls() {
    if (this._virtualButtonsDown.size > 0) {
      const releasing = [...this._virtualButtonsDown];
      this._virtualButtonsDown.clear();
      for (const button of releasing) {
        if (!this._buttonsDown.has(button)) {
          this.game.events.emit('input:mouseup', { button, source: 'touch' });
        }
      }
    }
    this._virtualDown.clear();
    for (const key of this._virtualJustPressed) this._justPressed.delete(key);
    this._virtualJustPressed.clear();
    this.setMoveVector(0, 0);
    // A rotate/background interruption must never apply a queued swipe or
    // weapon cycle after the game becomes active again.
    this._dx = 0;
    this._dy = 0;
    this._wheelDir = 0;
    this._syncButtonFlags();
  }

  /**
   * Accumulated mouse look since last call, in pixels; zeroed on read.
   * Returns a reused object — read dx/dy immediately (clone if kept).
   */
  consumeLook() {
    const out = this._lookOut;
    out.dx = this._dx;
    out.dy = this._dy;
    this._dx = 0;
    this._dy = 0;
    return out;
  }

  /**
   * Request gameplay focus. Touch mode normally uses a virtual lock, while a
   * mouse click on a hybrid device can explicitly upgrade it to real pointer
   * lock so aim is not bounded by the edge of the screen.
   */
  requestLock(options = {}) {
    const preferReal = options?.preferReal === true;
    if (this.locked && (!preferReal || !this._virtualLock)) return;
    // A controller cannot take a real pointer lock (that needs a gesture in
    // the page), so while it is the active device the lock is simulated, as
    // in touch mode.
    const pad = options?.virtual === true || (!preferReal && this.game.gamepad?.active === true);

    if (this.game.debug || (this.touchMode && !preferReal) || pad) {
      // Simulated lock: no real pointer capture, but the input pipeline
      // behaves exactly as if locked (synthetic events drive the game).
      this.locked = true;
      this._virtualLock = true;
      this._dx = 0;
      this._dy = 0;
      this.game.events.emit('input:lock');
      return;
    }

    const canvas = this._canvas();
    if (!canvas || typeof canvas.requestPointerLock !== 'function') return;

    // Prefer raw (unadjusted) movement for accel-free FPS aim; retry plain
    // if the browser rejects the option. Both paths swallow rejections —
    // Chrome throttles relock attempts right after an Escape-unlock and we
    // do not want an unhandled promise rejection for that.
    try {
      const p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            const p2 = canvas.requestPointerLock();
            if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
          } catch (_) { /* ignored */ }
        });
      }
    } catch (_) {
      try {
        const p2 = canvas.requestPointerLock();
        if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
      } catch (_2) { /* ignored */ }
    }
  }

  /** Runs last in the frame loop — clears one-frame state. */
  update(dt) { // eslint-disable-line no-unused-vars
    if (this._justPressed.size > 0) this._justPressed.clear();
    if (this._virtualJustPressed.size > 0) this._virtualJustPressed.clear();
    this._wheelDir = 0;
    // Drop a stale partial wheel accumulation (e.g. trackpad micro-scroll
    // that never crossed the threshold) so it cannot combine with a scroll
    // seconds later.
    if (this._wheelAcc !== 0 && performance.now() - this._wheelTime > WHEEL_STALE_MS) {
      this._wheelAcc = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  _onKeyDown(e) {
    const physicalKey = this._normalizePhysicalKey(e);
    if (physicalKey === null) return;

    if (this._keyCapture) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      else if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (e.repeat || e.isComposing) return;

      if (physicalKey === 'escape') {
        this.cancelKeyCapture('escape');
        return;
      }
      const chord =
        (e.metaKey && physicalKey !== 'meta') ||
        (e.ctrlKey && physicalKey !== 'control') ||
        (e.altKey && physicalKey !== 'alt') ||
        (e.shiftKey && physicalKey !== 'shift');
      if (chord || !canBindPhysicalKey(physicalKey)) {
        this._keyCapture.invalid?.('PRESS ONE KEY — ESC CANCELS');
        return;
      }

      const capture = this._keyCapture;
      this._keyCapture = null;
      capture.complete(physicalKey, { cancelled: false });
      return;
    }

    // Cmd/Meta shortcuts belong to the browser/OS and never double as game
    // actions. Ctrl remains a gameplay modifier (crouch), so its combinations
    // are handled below and suppressed while locked.
    if (e.metaKey && physicalKey !== 'meta') return;

    // Game-conflicting browser defaults are suppressed only while locked, and
    // include every currently bound key, including F-keys and Backspace.
    // (preventDefault guarded: bare-bones synthetic events may lack it.)
    const key = this._resolveHardwareKey(physicalKey);
    const settings = this.game?.settings;
    const isGameBinding = typeof settings?.isPhysicalBinding === 'function'
      ? settings.isPhysicalBinding(physicalKey)
      : DEFAULT_GAME_KEYS.has(physicalKey);
    const canPrevent = typeof e.preventDefault === 'function';
    if (
      this.locked &&
      !e.metaKey &&
      (
        PREVENT_WHILE_LOCKED.has(physicalKey) ||
        isGameBinding ||
        e.ctrlKey ||
        e.altKey
      )
    ) {
      if (canPrevent) e.preventDefault();
    }
    if (key === null) return;

    // Auto-repeat guard: browser flag first, held-set second (synthetic
    // events dispatched by tests may omit `repeat` on held-key repeats).
    if (this._down.has(key)) return;
    if (e.repeat) {
      // An auto-repeat proves the key is physically held: one held through a
      // relock (W while the buy menu opened and closed) was cleared by the
      // unlock and then ignored until pressed again. Restore it held, with
      // no new press edge.
      this._down.add(key);
      return;
    }
    const alreadyDown = this.isDown(key);
    this._down.add(key);
    if (alreadyDown) return;
    this._justPressed.add(key);
    this.game.events.emit('input:keydown', { key });
  }

  _onKeyUp(e) {
    const physicalKey = this._normalizePhysicalKey(e);
    if (physicalKey === null) return;
    // macOS sends no keyup for keys released while Cmd is held, so releasing
    // Cmd drops every held hardware key rather than leaving W stuck.
    if (physicalKey === 'meta') {
      this._releaseHardwareKeys();
      return;
    }
    const key = this._resolveHardwareKey(physicalKey);
    if (key === null) return;
    this._down.delete(key);
  }

  /**
   * Normalize a KeyboardEvent to the spec's key space using
   * e.key.toLowerCase(): single lowercase chars, ' ' for space, and named
   * keys like 'shift' / 'control' / 'tab' / 'escape'.
   */
  _normalizeKey(e) {
    const physicalKey = this._normalizePhysicalKey(e);
    return physicalKey === null ? null : this._resolveHardwareKey(physicalKey);
  }

  _normalizePhysicalKey(e) {
    // The digit row is matched by position: with Shift held (walk) or on
    // AZERTY, e.key is a symbol ('!'), which would block weapon slots and
    // leave a key pressed before Shift stuck when its keyup arrives as '!'.
    const digit = /^Digit([0-9])$/.exec(e?.code || '');
    if (digit) return digit[1];
    // Letters are matched by position too: on a Russian (or Greek, Hebrew,
    // Arabic) layout W types 'ц', so WASD did nothing, and on AZERTY the
    // movement keys landed all over the board. Labels show the player's own
    // characters (formatKeyLabel with the browser's layout map).
    const letter = /^Key([A-Z])$/.exec(e?.code || '');
    if (letter) return letter[1].toLowerCase();
    if (e?.code === 'Space') return ' ';
    // And punctuation: with Shift (sprint) held, ';' arrives as ':', so a key
    // bound to it did nothing while sprinting and, released under Shift,
    // stayed held (the player kept strafing). Stored as the US unshifted
    // character; labels come from the player's layout like the letters.
    const punct = PUNCTUATION_BY_CODE[e?.code];
    if (punct) return punct;
    return normalizePhysicalKey(e?.key);
  }

  _resolveHardwareKey(physicalKey) {
    const settings = this.game?.settings;
    if (settings && typeof settings.resolveInputKey === 'function') {
      return settings.resolveInputKey(physicalKey);
    }
    return physicalKey;
  }

  _normalizeVirtualKey(key) {
    if (key === undefined || key === null) return null;
    if (key === ' ' || key === 'Spacebar') return ' ';
    return String(key).toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Mouse
  // -------------------------------------------------------------------------

  _onMouseDown(e) {
    // Touch UI buttons can emit compatibility mouse events after their
    // pointer events. They are already represented by the virtual controls;
    // allowing the compatibility event through can double-toggle scope or
    // accidentally fire while buying equipment.
    if (this.touchMode && e.target?.closest?.('#hud')) return;

    const canvas = this._canvas();

    // Surface-class tablets and other hybrids expose both coarse touch and a
    // fine mouse/trackpad. A genuine mouse click upgrades the touch-friendly
    // virtual lock to pointer lock; synthesized mouse events from touch stay
    // on the virtual path.
    if (
      this.touchMode && this._virtualLock && canvas && e.target === canvas &&
      e.sourceCapabilities?.firesTouchEvents !== true
    ) {
      this.requestLock({ preferReal: true });
      return;
    }

    if (!this.locked) {
      // Clicking the canvas while unlocked captures the mouse. In debug the
      // simulated lock engages on any click (tests dispatch on window, where
      // the target can never be the canvas). The locking click itself is
      // swallowed — it must not fire the weapon.
      if ((canvas && e.target === canvas) || this.game.debug) {
        this.requestLock({ preferReal: this.touchMode && e.sourceCapabilities?.firesTouchEvents !== true });
      }
      return;
    }

    // Middle-click autoscroll would fight the camera — kill it.
    if (e.button === 1 && typeof e.preventDefault === 'function') e.preventDefault();

    const button = e.button | 0;
    const alreadyDown = this._buttonIsDown(button);
    // Toggle aim (a setting): each right click flips the sight in or out.
    // Only a gun with sights latches: the AWP's right click cycles its scope,
    // and a knife or grenade has nothing to aim (a latch there blocked sprint).
    if (button === 2 && this.game.settings?.aimToggle) {
      const w = this.game.weapons;
      const canAim = !w || typeof w.canAim !== 'function' || w.canAim();
      this._aimLatched = canAim ? !this._aimLatched : false;
    }
    this._buttonsDown.add(button);
    this._syncButtonFlags();
    if (!alreadyDown) this.game.events.emit('input:mousedown', { button });
  }

  _onMouseUp(e) {
    const button = e.button | 0;
    // A gaming mouse's side buttons are Back/Forward: mid-match they would
    // navigate away from the game.
    if (this.locked && (button === 3 || button === 4)) e.preventDefault?.();
    const wasDown = this._buttonsDown.delete(button);
    this._syncButtonFlags();
    // The event itself only exists inside the lock (spec), and only for
    // presses we actually saw go down — a stray mouseup (e.g. the release
    // of the click that acquired the lock) is not a game event.
    if (this.locked && wasDown && !this._buttonIsDown(button)) {
      this.game.events.emit('input:mouseup', { button });
    }
  }

  _onMouseMove(e) {
    if (!this.locked) return; // only accumulate while locked (spec)

    const mx = typeof e.movementX === 'number' ? e.movementX : 0;
    const my = typeof e.movementY === 'number' ? e.movementY : 0;
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return;

    // Chromium occasionally reports a massive one-event spike when the OS
    // cursor re-syncs, nearly always just after the lock is taken;
    // discarding beats a violent view snap. Debug mode skips the filter so
    // tests may look around with one big delta.
    //
    // A fixed cap alone also ate real flicks: events are coalesced per frame
    // and raw (unadjusted) counts are large, so a 0.1 s 180-degree flick at a
    // low sensitivity is ~950 counts an event and every frame of it was
    // dropped. Past the first moments of a lock, an event is only a spike if
    // it also towers over the motion just before it; a flick ramps up.
    if (!this.game.debug) {
      const mag = Math.max(Math.abs(mx), Math.abs(my));
      const now = performance.now();
      if (now - this._moveAt > 100) this._moveEma = 0; // a new motion starts
      this._moveAt = now;
      const justLocked = now - this._lockedAt < 150;
      const spike = mag > MOVE_SPIKE_PX && (justLocked || mag > 6 * this._moveEma + 120);
      // Even a rejected event feeds the average: a flick's next frames then
      // pass, while a lone re-sync jump out of stillness is still dropped.
      this._moveEma = this._moveEma * 0.5 + mag * 0.5;
      if (spike) return;
    }

    this._dx += mx;
    this._dy += my;
  }

  _onWheel(e) {
    if (!this.locked) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();

    // Normalize delta across deltaMode (0 pixels / 1 lines / 2 pages).
    let dy = e.deltaY;
    if (!Number.isFinite(dy) || dy === 0) return;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 120;

    const now = performance.now();
    if (now - this._wheelTime > WHEEL_STALE_MS) this._wheelAcc = 0;
    this._wheelTime = now;

    // A mouse notch arrives as one large delta (~100); a trackpad sends a
    // stream of small ones, momentum included. Measured that way a 300 px
    // two-finger swipe was ~12 weapon steps landing anywhere, so smooth
    // scrolling needs a longer travel per step and a pause between steps.
    const smooth = Math.abs(dy) < SMOOTH_WHEEL_DELTA;
    if (smooth && now < this._wheelHoldUntil) return;
    this._wheelAcc += dy;
    if (Math.abs(this._wheelAcc) >= (smooth ? SMOOTH_WHEEL_STEP : WHEEL_STEP)) {
      const dir = this._wheelAcc > 0 ? 1 : -1;
      this._wheelAcc = 0; // full reset: one notch == exactly one step
      this._wheelDir = dir;
      if (smooth) this._wheelHoldUntil = now + SMOOTH_WHEEL_HOLD_MS;
      this.game.events.emit('input:wheel', { dir });
    }
  }

  _onContextMenu(e) {
    // Never let RMB-aim pop a context menu: suppress over the canvas and
    // any time the (real or simulated) lock is active.
    const canvas = this._canvas();
    if (this.locked || (canvas && e.target === canvas)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
  }

  // -------------------------------------------------------------------------
  // Pointer lock lifecycle
  // -------------------------------------------------------------------------

  /** Give up gameplay focus (touch pause button; Escape does this on desktop). */
  releaseLock() {
    if (!this.locked) return;
    if (!this._virtualLock && document.pointerLockElement && document.exitPointerLock) {
      document.exitPointerLock();
      return; // pointerlockchange finishes the unlock
    }
    this._releaseAll(true);
    this.locked = false;
    this._virtualLock = false;
    this.game.events.emit('input:unlock');
  }

  _onPointerLockChange() {
    // Debug mode's lock is simulated and owns `locked` — a real
    // pointerlockchange (there should never be one) must not fight it.
    if (this.game.debug) return;

    const canvas = this._canvas();
    const nowLocked = !!canvas && document.pointerLockElement === canvas;
    if (nowLocked) {
      const wasLocked = this.locked;
      this._virtualLock = false;
      this._lockedAt = performance.now();
      this._moveEma = 0;
      this._dx = 0;
      this._dy = 0;
      if (!wasLocked) {
        this.locked = true;
        this.game.events.emit('input:lock');
      }
      return;
    }

    // An unrelated pointer-lock change must not cancel the virtual gameplay
    // focus used by touch-only browsers.
    if (this._virtualLock) return;
    if (nowLocked === this.locked) return;

    // Release everything BEFORE flipping the flag so the matching
    // 'input:mouseup' events are still delivered "while locked" and
    // listeners (grenade wind-up, spray state, ...) unwind cleanly.
    this._releaseAll(true);
    this.locked = false;
    this.game.events.emit('input:unlock');
  }

  _onPointerLockError() {
    // Chrome refuses a new lock for about a second after Esc; the pause
    // overlay tells the player to click again.
    this.game.events.emit('input:lock-error');
    if (!this._warnedLockError) {
      this._warnedLockError = true;
      console.warn('[input] pointer lock request was rejected by the browser');
    }
  }

  _onBlur() {
    // Alt-tab away: drop all held state so nothing sticks on return.
    this.cancelKeyCapture('blur');
    this._releaseAll(this.locked);
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden') {
      this.cancelKeyCapture('hidden');
      this._releaseAll(this.locked);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Lazy canvas lookup (defensive about construction order). */
  _canvas() {
    return (this.game && this.game.canvas) || null;
  }

  _buttonIsDown(button) {
    return this._buttonsDown.has(button) || this._virtualButtonsDown.has(button);
  }

  /** Drop a toggled aim (weapon switch, reload, sprint, death). */
  clearAimLatch() {
    if (!this._aimLatched) return;
    this._aimLatched = false;
    this._syncButtonFlags();
  }

  _syncButtonFlags() {
    this.firing = this._buttonIsDown(0);
    // Touch AIM is its own latch (a virtual button); the mouse either holds
    // or, with toggle aim on, flips _aimLatched per click.
    const mouseAim = this.game.settings?.aimToggle ? !!this._aimLatched : this._buttonsDown.has(2);
    this.aiming = this._virtualButtonsDown.has(2) || mouseAim;
  }

  _releaseHardwareKeys() {
    this._down.clear();
    for (const key of [...this._justPressed]) {
      if (!this._virtualJustPressed.has(key)) this._justPressed.delete(key);
    }
  }

  /**
   * Clear every held key/button and pending accumulations. When
   * `emitMouseups` is true, emit 'input:mouseup' for each held button first
   * so event-driven listeners stay consistent with `firing`/`aiming`.
   */
  _releaseAll(emitMouseups) {
    if (emitMouseups && (this._buttonsDown.size > 0 || this._virtualButtonsDown.size > 0)) {
      const buttons = new Set([...this._buttonsDown, ...this._virtualButtonsDown]);
      for (const button of buttons) {
        this.game.events.emit('input:mouseup', { button });
      }
    }
    this._buttonsDown.clear();
    this._virtualButtonsDown.clear();
    this._aimLatched = false;
    this._syncButtonFlags();
    this._down.clear();
    this._virtualDown.clear();
    this.setMoveVector(0, 0);
    this._justPressed.clear();
    this._virtualJustPressed.clear();
    this._dx = 0;
    this._dy = 0;
    this._wheelAcc = 0;
    this._wheelDir = 0;
  }
}
