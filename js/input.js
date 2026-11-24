// Unified low-latency input controller for touch, mouse, trackpad, keyboard, and gamepad.
//
// - Pointer Events unify touch, pen, mouse, and trackpad tap/click without 300ms delay.
// - Two-finger double-tap matches the iOS shell's FPS toggle gesture.
// - Sub-16ms taps/keypresses are latched across 1 simulation tick so fast clicks never miss UI buttons.
// - Keyboard repeat is ignored so holding Space/Up cannot auto-flap.
// - Gamepad polling runs inside the render loop with zero event allocations.

const FLAP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW', 'KeyJ', 'Enter']);

export class InputController {
  constructor(canvas, game, getLayout, actions) {
    this.canvas = canvas;
    this.game = game;
    this.getLayout = getLayout;
    this.actions = actions; // { unlockAudio, isPaused, togglePause, toggleMute, toggleFps, isModalOpen, closeModal, onFirstInteract }
    this.rectLeft = 0;
    this.rectTop = 0;
    this._lx = 0;
    this._ly = 0;

    this.activePointerId = null;
    this.touchCount = 0;
    this.p0Id = -1; this.p0X = 0; this.p0Y = 0;
    this.p1Id = -1; this.p1X = 0; this.p1Y = 0;
    this.twoFingerDownAt = 0;
    this.twoFingerLastTapAt = 0;
    this.twoFingerPending = false;
    this.activeKey = null;
    this.prevGamepadDown = false;
    this.hasGamepad = false;

    this._bindEvents();
  }

  setCanvasOrigin(left, top) {
    this.rectLeft = left;
    this.rectTop = top;
  }

  _updateCoords(clientX, clientY) {
    const layout = this.getLayout();
    this._lx = layout.inputX(clientX - this.rectLeft);
    this._ly = layout.inputY(clientY - this.rectTop);
  }

  _canUseVirtualPlayButton() {
    const g = this.game;
    return g.fade.done && ((g.menu && g.buttons[0].shown) || (g.panelMode === 2 && g.buttons[0].shown));
  }

  _updateHoverCursor(lx, ly) {
    let overButton = false;
    const buttons = this.game.buttons;
    for (let i = 0; i < 8; i++) {
      if (buttons[i].shown && buttons[i].contains(lx, ly)) { overButton = true; break; }
    }
    this.canvas.style.cursor = overButton ? 'pointer' : 'default';
  }

  _bindEvents() {
    const c = this.canvas;
    const g = this.game;

    // WebKit/iOS Safari reliably grants Web Audio user-activation on touchstart/touchend/mousedown/click,
    // whereas pointerdown alone may not unlock AudioContext on all iOS versions.
    // Remove these extra capture listeners once unlocked so zero overhead remains per tap.
    const unlockEvents = ['touchstart', 'touchend', 'mousedown', 'click'];
    const unlock = () => {
      if (this.actions.unlockAudio()) {
        for (const ev of unlockEvents) window.removeEventListener(ev, unlock, true);
      }
    };
    for (const ev of unlockEvents) {
      window.addEventListener(ev, unlock, { capture: true, passive: true });
    }

    c.addEventListener('contextmenu', e => e.preventDefault());

    // CSS touch-action: none handles gesture suppression on the compositor thread,
    // allowing passive: true pointer listeners without blocking WebKit's touch-to-rAF pipeline.
    c.addEventListener('pointerdown', e => {
      this.actions.unlockAudio();
      this.actions.onFirstInteract();

      if (e.pointerType === 'touch') {
        this.touchCount++;
        if (this.touchCount === 1) { this.p0Id = e.pointerId; this.p0X = e.clientX; this.p0Y = e.clientY; }
        else if (this.touchCount === 2) {
          this.p1Id = e.pointerId; this.p1X = e.clientX; this.p1Y = e.clientY;
          this.twoFingerPending = true;
          this.twoFingerDownAt = performance.now();
        } else {
          this.twoFingerPending = false;
        }
      }

      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.actions.isModalOpen()) return;
      if (this.actions.isPaused()) {
        this.actions.togglePause(false);
        return;
      }

      if (this.activePointerId !== null && this.touchCount > 1) return;

      this._updateCoords(e.clientX, e.clientY);
      this.activePointerId = e.pointerId;
      g.touchX = this._lx;
      g.touchY = this._ly;
      g.touching = true;
      g.touchLatch = true;
      g.touchBegin();
    }, { passive: true });

    c.addEventListener('pointermove', e => {
      if (this.twoFingerPending) {
        if (e.pointerId === this.p0Id && Math.hypot(e.clientX - this.p0X, e.clientY - this.p0Y) > 24) this.twoFingerPending = false;
        else if (e.pointerId === this.p1Id && Math.hypot(e.clientX - this.p1X, e.clientY - this.p1Y) > 24) this.twoFingerPending = false;
      }
      if (e.pointerId === this.activePointerId) {
        this._updateCoords(e.clientX, e.clientY);
        g.touchX = this._lx;
        g.touchY = this._ly;
      } else if (e.pointerType === 'mouse') {
        this._updateCoords(e.clientX, e.clientY);
        this._updateHoverCursor(this._lx, this._ly);
      }
    }, { passive: true });

    const endPointer = e => {
      if (e.pointerType === 'touch') {
        if (this.touchCount > 0) this.touchCount--;
        if (e.pointerId === this.p0Id) this.p0Id = -1;
        if (e.pointerId === this.p1Id) this.p1Id = -1;
        if (this.twoFingerPending && this.touchCount === 0) {
          this.twoFingerPending = false;
          const now = performance.now();
          if (now - this.twoFingerDownAt < 380) {
            if (now - this.twoFingerLastTapAt < 450) {
              this.twoFingerLastTapAt = 0;
              this.actions.toggleFps();
            } else {
              this.twoFingerLastTapAt = now;
            }
          }
        }
      }
      if (e.pointerId === this.activePointerId) {
        g.touching = false;
        this.activePointerId = null;
      }
    };

    window.addEventListener('pointerup', endPointer, { passive: true });
    window.addEventListener('pointercancel', endPointer, { passive: true });

    window.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === 'Escape') {
        if (this.actions.isModalOpen()) { e.preventDefault(); this.actions.closeModal(); return; }
        if (g.playing || this.actions.isPaused()) { e.preventDefault(); this.actions.togglePause(); return; }
        return;
      }

      if (this.actions.isModalOpen()) {
        if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); this.actions.closeModal(); }
        return;
      }

      if (e.code === 'KeyP') {
        e.preventDefault();
        if (g.playing || this.actions.isPaused()) this.actions.togglePause();
        return;
      }
      if (e.code === 'KeyM') { e.preventDefault(); this.actions.toggleMute(); return; }
      if (e.code === 'KeyF' || e.code === 'F3') { e.preventDefault(); this.actions.toggleFps(); return; }
      if (e.code === 'KeyR') {
        if (!g.menu && g.fade.done && !this.actions.isPaused()) {
          e.preventDefault();
          this.actions.unlockAudio();
          g.beginFade(5);
        }
        return;
      }

      if (!FLAP_KEYS.has(e.code)) return;
      e.preventDefault();
      if (e.repeat) return;

      this.actions.unlockAudio();
      this.actions.onFirstInteract();

      if (this.actions.isPaused()) {
        this.actions.togglePause(false);
        return;
      }

      if (this._canUseVirtualPlayButton()) {
        this.activeKey = e.code;
        g.virtualButton = 0;
        g.virtualHeld = true;
        g.virtualLatch = true;
      } else {
        g.touchBegin();
      }
    });

    window.addEventListener('keyup', e => {
      if (e.code === this.activeKey) {
        this.activeKey = null;
        g.virtualHeld = false;
      }
    });

    window.addEventListener('blur', () => {
      this.touchCount = 0;
      this.p0Id = this.p1Id = -1;
      this.activePointerId = null;
      this.activeKey = null;
      g.touching = false;
      g.virtualHeld = false;
      this.prevGamepadDown = false;
    });

    window.addEventListener('gamepadconnected', () => { this.hasGamepad = true; });
    window.addEventListener('gamepaddisconnected', () => {
      const pads = navigator.getGamepads?.() || [];
      this.hasGamepad = Array.from(pads).some(Boolean);
    });
  }

  pollGamepad() {
    if (!this.hasGamepad || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let down = false;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p) continue;
      if (p.buttons[0]?.pressed || p.buttons[12]?.pressed || p.buttons[9]?.pressed) {
        down = true;
        break;
      }
    }
    if (down !== this.prevGamepadDown) {
      this.prevGamepadDown = down;
      if (down) {
        this.actions.unlockAudio();
        this.actions.onFirstInteract();
        if (this.actions.isModalOpen()) { this.actions.closeModal(); return; }
        if (this.actions.isPaused()) { this.actions.togglePause(false); return; }
        if (this._canUseVirtualPlayButton()) {
          this.game.virtualButton = 0;
          this.game.virtualHeld = true;
          this.game.virtualLatch = true;
        } else {
          this.game.touchBegin();
        }
      } else {
        this.game.virtualHeld = false;
      }
    }
  }
}
