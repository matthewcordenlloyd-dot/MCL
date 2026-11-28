import controls from '@data/controls.json';

export type Bindings = Record<string, string[]>;
export type PadBindings = Record<string, number[]>;
export type Context = 'walking' | 'flying' | 'global';

const OVERRIDE_KEY = 'skyempire.bindings.v1';

interface Overrides {
  keys: Partial<Record<Context, Bindings>>;
  pad: Partial<Record<'walking' | 'flying', PadBindings>>;
}

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { keys: {}, pad: {} };
}

/**
 * Keyboard, mouse and gamepad input, mapped through data/controls.json with
 * per-player overrides (rebinding UI in the menu).
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private padHeld = new Set<number>();
  private padPrev = new Set<number>();
  private padHit = new Set<number>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  mouseButtons = 0;
  clicked: number[] = []; // mouse buttons clicked this frame
  locked = false;
  padAxes: number[] = [0, 0, 0, 0];
  padTriggers = [0, 0];
  padConnected = false;
  padName = '';
  private overrides: Overrides = loadOverrides();
  walking!: Bindings;
  flying!: Bindings;
  global!: Bindings;
  padWalking!: PadBindings;
  padFlying!: PadBindings;
  /** When set, the next key or pad button press is reported here instead of being used. */
  capture: ((code: string | null, pad: number | null) => void) | null = null;

  constructor(private el: HTMLElement) {
    this.applyBindings();
    addEventListener('keydown', (e) => {
      if (['F3', 'F9', 'Tab', 'Space', 'Quote', 'Slash'].includes(e.code) || e.code.startsWith('Arrow') || e.code.startsWith('Page')) {
        if (document.activeElement === document.body || document.activeElement === this.el) e.preventDefault();
      }
      if (this.capture && e.code !== 'Escape') {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code, null);
        return;
      }
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    el.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      if (this.locked) this.clicked.push(e.button);
    });
    addEventListener('mouseup', (e) => (this.mouseButtons &= ~(1 << e.button)));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.down.clear();
    });
  }

  applyBindings(): void {
    const o = this.overrides;
    this.walking = { ...controls.walking, ...o.keys.walking };
    this.flying = { ...controls.flying, ...o.keys.flying };
    this.global = { ...controls.global, ...o.keys.global };
    this.padWalking = { ...controls.gamepad.walking, ...o.pad.walking };
    this.padFlying = { ...controls.gamepad.flying, ...o.pad.flying };
  }

  setKey(ctx: Context, action: string, codes: string[]): void {
    (this.overrides.keys[ctx] ??= {})[action] = codes;
    this.save();
  }

  setPad(ctx: 'walking' | 'flying', action: string, buttons: number[]): void {
    (this.overrides.pad[ctx] ??= {})[action] = buttons;
    this.save();
  }

  resetBindings(): void {
    this.overrides = { keys: {}, pad: {} };
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify(this.overrides));
    } catch {
      /* ignore */
    }
    this.applyBindings();
  }

  requestLock(): void {
    this.el.requestPointerLock?.()?.catch?.(() => undefined);
  }

  /** Polls the first connected gamepad (call once per frame before reading). */
  pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = [...pads].find((p) => p && p.connected) ?? null;
    this.padConnected = !!gp;
    this.padHit.clear();
    if (!gp) return;
    this.padName = gp.id;
    const dz = controls.gamepad.deadzone;
    const shape = (v: number) => (Math.abs(v) < dz ? 0 : Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz)) ** 1.6);
    this.padAxes = [0, 1, 2, 3].map((i) => shape(gp.axes[i] ?? 0));
    this.padTriggers = [gp.buttons[6]?.value ?? 0, gp.buttons[7]?.value ?? 0];
    this.padPrev = this.padHeld;
    this.padHeld = new Set();
    gp.buttons.forEach((b, i) => {
      if (b.pressed) this.padHeld.add(i);
    });
    for (const b of this.padHeld) {
      if (!this.padPrev.has(b)) {
        if (this.capture) {
          const cb = this.capture;
          this.capture = null;
          cb(null, b);
          continue;
        }
        this.padHit.add(b);
      }
    }
  }

  /** Action held (any bound key or pad button). */
  held(map: Bindings, action: string, pad?: PadBindings): boolean {
    return (map[action] ?? []).some((k) => this.down.has(k)) || (pad?.[action] ?? []).some((b) => this.padHeld.has(b));
  }

  /** Action pressed this frame. */
  hit(map: Bindings, action: string, pad?: PadBindings): boolean {
    return (map[action] ?? []).some((k) => this.pressed.has(k)) || (pad?.[action] ?? []).some((b) => this.padHit.has(b));
  }

  keyHeld(code: string): boolean {
    return this.down.has(code);
  }

  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    this.clicked = [];
  }
}
