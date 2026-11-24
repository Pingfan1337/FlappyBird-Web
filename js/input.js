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

    this.activePointerId = null;
    this.pointers = new Map();
    this.twoFingerDownAt = 0;
    this.twoFingerLastTapAt = 0;
    this.twoFingerPending = false;
    this.activeKey = null;
    this.prevGamepadDown = false;
    this.hasGamepad = false;

    this._bindEvents();
  }

  _toLayout(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const layout = this.getLayout();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return [layout.inputX(x), layout.inputY(y)];
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
    const unlock = () => this.actions.unlockAudio();
    for (const ev of ['touchstart', 'touchend', 'mousedown', 'click']) {
      window.addEventListener(ev, unlock, { capture: true, passive: true });
    }

    c.addEventListener('contextmenu', e => e.preventDefault());

    c.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.actions.unlockAudio();
      this.actions.onFirstInteract();

      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (this.pointers.size === 2 && e.pointerType === 'touch') {
        this.twoFingerPending = true;
        this.twoFingerDownAt = performance.now();
      } else if (this.pointers.size > 2) {
        this.twoFingerPending = false;
      }

      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.actions.isModalOpen()) return;
      if (this.actions.isPaused()) {
        this.actions.togglePause(false);
        return;
      }

      if (this.activePointerId !== null && this.pointers.size > 1) return;

      const [lx, ly] = this._toLayout(e.clientX, e.clientY);
      this.activePointerId = e.pointerId;
      try { c.setPointerCapture(e.pointerId); } catch {}
      g.touchX = lx;
      g.touchY = ly;
      g.touching = true;
      g.touchLatch = true;
      g.touchBegin();
    });

    c.addEventListener('pointermove', e => {
      if (this.pointers.has(e.pointerId)) {
        const p = this.pointers.get(e.pointerId);
        if (this.twoFingerPending && (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 24)) {
          this.twoFingerPending = false;
        }
      }
      const [lx, ly] = this._toLayout(e.clientX, e.clientY);
      if (e.pointerId === this.activePointerId) {
        g.touchX = lx;
        g.touchY = ly;
      }
      if (e.pointerType === 'mouse') {
        this._updateHoverCursor(lx, ly);
      }
    });

    const endPointer = e => {
      this.pointers.delete(e.pointerId);
      if (this.twoFingerPending && this.pointers.size === 0) {
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
      if (e.pointerId === this.activePointerId) {
        g.touching = false;
        this.activePointerId = null;
      }
    };

    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);
    c.addEventListener('lostpointercapture', endPointer);

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
      this.pointers.clear();
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
