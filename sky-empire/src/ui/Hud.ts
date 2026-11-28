import type * as THREE from 'three';
import { PRESETS, PRESET_IDS, type PresetId, type Settings } from '../core/settings';
import type { Input, Context } from '../player/Input';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface HudCallbacks {
  onPreset(p: PresetId): void;
  onSettings(s: Partial<Settings>): void;
  onTeleport(id: string): void;
  onFlightStart(id: string): void;
  onResume(): void;
}

const ACTION_LABELS: Record<string, string> = {
  forward: 'Walk forward', back: 'Walk back', left: 'Strafe left', right: 'Strafe right', run: 'Run', jump: 'Jump',
  toggleView: '1st / 3rd person', interact: 'Interact / sit',
  pitchDown: 'Pitch down', pitchUp: 'Pitch up', rollLeft: 'Roll left', rollRight: 'Roll right', yawLeft: 'Rudder left', yawRight: 'Rudder right',
  throttleUp: 'Throttle up', throttleDown: 'Throttle down', throttleIdle: 'Throttle idle', throttleToga: 'Throttle full (TOGA)',
  reverse: 'Reverse thrust (hold)', brakes: 'Brakes (hold)', parkingBrake: 'Parking brake', gear: 'Landing gear',
  flapsDown: 'Flaps down', flapsUp: 'Flaps up', spoilers: 'Speed brake', autopilot: 'Autopilot (AP1)', autothrust: 'Autothrust (A/THR)',
  hdgDown: 'Selected heading −', hdgUp: 'Selected heading +', altDown: 'Selected altitude −', altUp: 'Selected altitude +',
  camera: 'Cycle camera', skip: 'Skip to approach', hud: 'Toggle HUD', mouseYoke: 'Mouse yoke', pushback: 'Request pushback', leaveSeat: 'Leave seat', menu: 'Menu',
};

const pretty = (code: string) =>
  ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Slash: '/', Equal: '=', Minus: '-', Space: 'Space' } as Record<string, string>)[code] ??
  code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace('Left', ' L').replace('Right', ' R');
const PAD = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→'];

/** DOM overlay: loading screen, stats, hints, prompts and the tabbed pause menu. */
export class Hud {
  private frames = 0;
  private acc = 0;
  private worst = 0;
  private fps = 0;
  private ms = 0;
  private toastTimer = 0;
  private input: Input | null = null;

  constructor(
    private settings: Settings,
    cb: HudCallbacks,
    spawns: Record<string, { label: string }>,
    flightStarts: Record<string, string>,
  ) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="loading"><div class="box">
        <h1>SKY <span>EMPIRE</span></h1>
        <div class="bar"><i></i></div><p>Starting…</p>
      </div></div>
      <div id="stats" class="glass"></div>
      <div id="crosshair"></div>
      <div id="prompt" class="glass"></div>
      <div id="toast" class="glass"></div>
      <div id="hint" class="glass"></div>
      <div id="metar" class="glass"></div>
      <div id="radio" class="glass"></div>
      <div id="crash" class="hidden"><div class="crashbox glass"><h1>Accident</h1><p id="crashText"></p><p class="note">The investigation and the insurers will take it from here. You are back in the captain's seat at the gate.</p></div></div>
      <div id="overlay" class="hidden"><div class="menu glass">
        <div class="brandline"><h1>SKY <span>EMPIRE</span></h1>
          <div class="tabs"><button class="tab on" data-tab="game">Game</button><button class="tab" data-tab="controls">Controls</button></div>
        </div>
        <div class="tabpage" data-page="game">
          <div class="cols">
            <div>
              <h2>Graphics</h2>
              <div class="seg" id="presets">${PRESET_IDS.map((p) => `<button data-p="${p}">${PRESETS[p].label}</button>`).join('')}</div>
              <div class="toggles">
                <label>Show FPS / stats (F3) <input type="checkbox" id="optStats"></label>
                <label>Real-world terrain <input type="checkbox" id="optTerrain"></label>
                <label>Auto resolution (steadier frame rate) <input type="checkbox" id="optAutoRes"></label>
                <label>Third-person camera (V) <input type="checkbox" id="optThird"></label>
                <label>Invert mouse Y <input type="checkbox" id="optInvert"></label>
                <label>Mouse sensitivity <input type="range" id="optSens" min="0.3" max="2.5" step="0.05"></label>
              </div>
              <h2 style="margin-top:18px">World</h2>
              <div class="toggles">
                <label>Time of day <select id="optTod"><option value="real">Follows the game clock</option><option value="day">Always day</option><option value="night">Always night</option></select></label>
                <label>Weather <select id="optWx"><option value="live">Live (changes with time)</option><option value="clear">Always clear</option></select></label>
                <label>Damage and crashes <input type="checkbox" id="optDamage"></label>
                <label>Volume <input type="range" id="optVol" min="0" max="1" step="0.05"></label>
              </div>
              <h2 style="margin-top:18px">Flight model</h2>
              <div class="seg two" id="profiles"><button data-f="arcade">Arcade</button><button data-f="realistic">Realistic</button></div>
              <div class="toggles">
                <label>Fly-by-wire protections (realistic) <input type="checkbox" id="optProt"></label>
                <label>Flight HUD (H) <input type="checkbox" id="optHud"></label>
              </div>
            </div>
            <div>
              <h2>Fly</h2>
              <div class="teleports" id="flystarts">${Object.entries(flightStarts).map(([k, v]) => `<button class="btn" data-fs="${k}">${v}</button>`).join('')}</div>
              <h2 style="margin-top:18px">Walk to</h2>
              <div class="teleports" id="walkto">${Object.entries(spawns).map(([k, v], i) => `<button class="btn" data-t="${k}">${i + 1} · ${v.label}</button>`).join('')}</div>
              <h2 style="margin-top:18px">Boarding</h2>
              <p class="note">Walk from the terminal through the jet bridge at stand 103 into your A320neo, go forward to the cockpit and press <kbd>E</kbd> at the captain's seat. Press <kbd>P</kbd> for pushback.</p>
            </div>
          </div>
        </div>
        <div class="tabpage hidden" data-page="controls">
          <p class="note" id="padstatus"></p>
          <div class="bindcols" id="bindings"></div>
          <div class="footer"><small>Click a binding, then press a key or gamepad button. Esc cancels.</small><button class="btn" id="resetBinds">Reset to defaults</button></div>
        </div>
        <div class="footer"><small>Settings are saved in this browser.</small><button class="btn primary" id="resume">Click to play</button></div>
      </div></div>`);

    $('presets').addEventListener('click', (e) => {
      const p = (e.target as HTMLElement).dataset.p as PresetId | undefined;
      if (p) cb.onPreset(p);
    });
    $('profiles').addEventListener('click', (e) => {
      const f = (e.target as HTMLElement).dataset.f as Settings['flightProfile'] | undefined;
      if (f) cb.onSettings({ flightProfile: f });
    });
    const check = (id: string, key: keyof Settings) =>
      $(id).addEventListener('change', (e) => cb.onSettings({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>));
    check('optStats', 'showStats');
    check('optThird', 'thirdPerson');
    check('optInvert', 'invertY');
    check('optProt', 'protections');
    check('optHud', 'showHud');
    check('optTerrain', 'terrain');
    $('optSens').addEventListener('input', (e) => cb.onSettings({ mouseSensitivity: Number((e.target as HTMLInputElement).value) }));
    check('optDamage', 'damage');
    check('optAutoRes', 'autoRes');
    $('optTod').addEventListener('change', (e) => cb.onSettings({ timeOfDay: (e.target as HTMLSelectElement).value as Settings['timeOfDay'] }));
    $('optWx').addEventListener('change', (e) => cb.onSettings({ weather: (e.target as HTMLSelectElement).value as Settings['weather'] }));
    $('optVol').addEventListener('input', (e) => cb.onSettings({ volume: Number((e.target as HTMLInputElement).value) }));
    $('walkto').addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).dataset.t;
      if (t) cb.onTeleport(t);
    });
    $('flystarts').addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).dataset.fs;
      if (t) cb.onFlightStart(t);
    });
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === b));
        document.querySelectorAll<HTMLElement>('.tabpage').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== b.dataset.tab));
        if (b.dataset.tab === 'controls') this.renderBindings();
      }),
    );
    $('resume').addEventListener('click', () => cb.onResume());
    $('resetBinds').addEventListener('click', () => {
      this.input?.resetBindings();
      this.renderBindings();
    });
    this.sync(settings);
    this.setMode('walk');
  }

  attachInput(i: Input): void {
    this.input = i;
  }

  private renderBindings(): void {
    const I = this.input;
    if (!I) return;
    $('padstatus').textContent = I.padConnected ? `Gamepad connected: ${I.padName}` : 'No gamepad detected. Press a button on your Xbox or PlayStation controller to wake it up.';
    const section = (title: string, ctx: Context, keys: Record<string, string[]>, padCtx: 'walking' | 'flying' | null, pad: Record<string, number[]> | null) => {
      const rows = Object.keys({ ...keys, ...(pad ?? {}) })
        .filter((a) => ACTION_LABELS[a])
        .map((a) => {
          const k = (keys[a] ?? []).map(pretty).join(' / ') || '—';
          const p = pad ? (pad[a] ?? []).map((b) => PAD[b] ?? `#${b}`).join(' / ') || '—' : '';
          return `<div class="bind"><span>${ACTION_LABELS[a]}</span>
            <button class="kbtn" data-ctx="${ctx}" data-a="${a}">${k}</button>
            ${padCtx ? `<button class="kbtn pad" data-pctx="${padCtx}" data-a="${a}">${p}</button>` : ''}</div>`;
        })
        .join('');
      return `<div><h2>${title}</h2>${rows}</div>`;
    };
    $('bindings').innerHTML =
      section('Walking', 'walking', I.walking, 'walking', I.padWalking) + section('Flying', 'flying', I.flying, 'flying', I.padFlying);
    $('bindings').querySelectorAll<HTMLButtonElement>('.kbtn').forEach((btn) =>
      btn.addEventListener('click', () => {
        btn.textContent = 'press…';
        btn.classList.add('wait');
        I.capture = (code, padBtn) => {
          if (btn.dataset.pctx && padBtn !== null) I.setPad(btn.dataset.pctx as 'walking' | 'flying', btn.dataset.a!, [padBtn]);
          else if (btn.dataset.ctx && code) I.setKey(btn.dataset.ctx as Context, btn.dataset.a!, [code]);
          this.renderBindings();
        };
      }),
    );
  }

  sync(s: Settings): void {
    this.settings = s;
    for (const b of $('presets').querySelectorAll('button')) b.classList.toggle('on', b.dataset.p === s.preset);
    for (const b of $('profiles').querySelectorAll('button')) b.classList.toggle('on', b.dataset.f === s.flightProfile);
    ($('optStats') as HTMLInputElement).checked = s.showStats;
    ($('optThird') as HTMLInputElement).checked = s.thirdPerson;
    ($('optInvert') as HTMLInputElement).checked = s.invertY;
    ($('optProt') as HTMLInputElement).checked = s.protections;
    ($('optHud') as HTMLInputElement).checked = s.showHud;
    ($('optTerrain') as HTMLInputElement).checked = s.terrain;
    ($('optSens') as HTMLInputElement).value = String(s.mouseSensitivity);
    ($('optDamage') as HTMLInputElement).checked = s.damage;
    ($('optAutoRes') as HTMLInputElement).checked = s.autoRes;
    ($('optTod') as HTMLSelectElement).value = s.timeOfDay;
    ($('optWx') as HTMLSelectElement).value = s.weather;
    ($('optVol') as HTMLInputElement).value = String(s.volume);
    $('stats').style.display = s.showStats ? '' : 'none';
  }

  setMode(mode: 'walk' | 'fly'): void {
    $('hint').innerHTML =
      mode === 'walk'
        ? '<kbd>WASD</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · <kbd>V</kbd> 1st/3rd · <kbd>E</kbd> interact · <kbd>1-4</kbd> teleport · <kbd>Esc</kbd> menu'
        : '<kbd>WASD</kbd> pitch/roll · <kbd>Q E</kbd> rudder · <kbd>Shift Ctrl</kbd> thrust · <kbd>G</kbd> gear · <kbd>[ ]</kbd> flaps · <kbd>Space</kbd> brakes · <kbd>N</kbd> park · <kbd>Z</kbd> AP · <kbd>P</kbd> pushback · <kbd>K</kbd> skip to approach · <kbd>C</kbd> camera · <kbd>F</kbd> leave seat';
  }

  /** Weather report line shown while flying. */
  metar(text: string): void {
    const el = $('metar');
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }

  /** The last radio calls (ATC in white, other traffic in grey). */
  radio(lines: { from: 'atc' | 'ai'; text: string }[]): void {
    const el = $('radio');
    el.style.display = lines.length ? 'block' : 'none';
    el.innerHTML = lines.map((l) => `<div class="${l.from}">${l.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</div>`).join('');
  }

  crashReport(text: string | null): void {
    $('crash').classList.toggle('hidden', !text);
    if (text) $('crashText').textContent = text;
  }

  crosshair(on: boolean): void {
    $('crosshair').style.display = on ? 'block' : 'none';
  }

  prompt(text: string): void {
    const p = $('prompt');
    if (p.dataset.text === text) return;
    p.dataset.text = text;
    p.innerHTML = text;
    p.style.display = text ? 'block' : 'none';
  }

  progress(frac: number, label: string): void {
    // models loaded later (your jet, the livery editor) arrive after the loading screen has gone
    const el = document.getElementById('loading');
    if (!el) return;
    (el.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    el.querySelector('p')!.textContent = label;
  }

  loaded(): void {
    $('loading').classList.add('done');
    setTimeout(() => $('loading').remove(), 600);
  }

  error(msg: string): void {
    const p = $('loading').querySelector('p') as HTMLElement;
    p.textContent = msg;
    p.style.color = 'var(--bad)';
  }

  setPaused(paused: boolean): void {
    $('overlay').classList.toggle('hidden', !paused);
    $('hint').style.display = paused ? 'none' : '';
    if (paused && this.input) this.renderBindings();
  }

  toast(msg: string): void {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200);
  }

  /** Called every frame with the real frame time (seconds). Updates twice a second. */
  frame(dt: number, renderer: THREE.WebGLRenderer, extra: { preset: string; res: string; pos: THREE.Vector3; physicsMs: number; cpuMs: number; terrain: string }): void {
    this.frames++;
    this.acc += dt;
    this.worst = Math.max(this.worst, dt);
    if (this.acc < 0.5) return;
    this.fps = this.frames / this.acc;
    this.ms = (this.acc / this.frames) * 1000;
    const worst = this.worst * 1000;
    this.frames = 0;
    this.acc = 0;
    this.worst = 0;
    if (!this.settings.showStats) return;
    const i = renderer.info;
    const cls = this.fps >= 50 ? 'good' : this.fps >= 30 ? 'warn' : 'bad';
    $('stats').innerHTML = `
      <div class="fps ${cls}">${this.fps.toFixed(0)}<small>fps · ${this.ms.toFixed(1)} ms (worst ${worst.toFixed(0)})</small></div>
      <div class="row"><span>preset</span><b>${extra.preset}</b></div>
      <div class="row"><span>render</span><b>${extra.res}</b></div>
      <div class="row"><span>draw calls</span><b>${i.render.calls}</b></div>
      <div class="row"><span>triangles</span><b>${(i.render.triangles / 1000).toFixed(0)}k</b></div>
      <div class="row"><span>geometries / tex</span><b>${i.memory.geometries} / ${i.memory.textures}</b></div>
      <div class="row"><span>terrain tiles</span><b>${extra.terrain}</b></div>
      <div class="row"><span>cpu frame / physics</span><b>${extra.cpuMs.toFixed(1)} / ${extra.physicsMs.toFixed(1)} ms</b></div>
      <div class="row"><span>pos</span><b>${extra.pos.x.toFixed(0)}, ${extra.pos.y.toFixed(0)}, ${extra.pos.z.toFixed(0)}</b></div>`;
  }

  get currentFps(): number {
    return this.fps;
  }
}
