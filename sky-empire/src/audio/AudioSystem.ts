/**
 * Game audio with the Web Audio API. Everything is synthesised by default (filtered noise and
 * oscillators), so no downloads are needed. Optional CC0 recordings can be dropped into
 * public/audio/ and listed in public/audio/manifest.json (see AUDIO.md); they replace the synth
 * loops of the same name. Cockpit callouts use the browser's built-in speech synthesis.
 */
export interface AudioFrame {
  mode: 'walk' | 'fly' | 'drive' | 'ops';
  cockpit: boolean;
  n1: number;
  iasKt: number;
  raFt: number;
  onGround: boolean;
  precip: number;
  windKt: number;
  storm: boolean;
  jet: { dist: number; thrust: number };
  carSpeed: number;
  carThrottle: number;
}

type Loop = { gain: GainNode; filter: BiquadFilterNode; src: AudioScheduledSourceNode; osc?: OscillatorNode };

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private loops: Record<string, Loop> = {};
  private files: Record<string, AudioBuffer> = {};
  private volume = 0.7;
  private lastRa = Infinity;
  private said = new Set<string>();
  private thunderAt = 0;

  constructor() {
    const start = () => this.start();
    addEventListener('pointerdown', start, { once: true });
    addEventListener('keydown', start, { once: true });
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  /** Browsers only allow audio after a user gesture. */
  private async start(): Promise<void> {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    await this.loadFiles();
    const noise = this.noiseBuffer();
    const loop = (name: string, type: BiquadFilterType, freq: number, q = 0.7, osc?: OscillatorType): Loop => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      let src: AudioScheduledSourceNode;
      let o: OscillatorNode | undefined;
      const file = this.files[name];
      if (file) {
        const b = ctx.createBufferSource();
        b.buffer = file;
        b.loop = true;
        src = b;
      } else if (osc) {
        o = ctx.createOscillator();
        o.type = osc;
        o.frequency.value = 100;
        src = o;
      } else {
        const b = ctx.createBufferSource();
        b.buffer = noise;
        b.loop = true;
        b.playbackRate.value = 0.9 + Math.random() * 0.2;
        src = b;
      }
      src.connect(filter).connect(gain).connect(this.master!);
      src.start();
      return { gain, filter, src, osc: o };
    };
    this.loops = {
      engine: loop('engine', 'lowpass', 400, 0.8),
      whine: loop('whine', 'bandpass', 2000, 6, 'sawtooth'),
      airflow: loop('airflow', 'bandpass', 700, 0.5),
      rain: loop('rain', 'highpass', 1800, 0.4),
      wind: loop('wind', 'lowpass', 350, 0.6),
      jets: loop('jets', 'lowpass', 400, 0.7),
      car: loop('car', 'lowpass', 900, 1.2, 'sawtooth'),
    };
  }

  private async loadFiles(): Promise<void> {
    try {
      const r = await fetch('audio/manifest.json');
      if (!r.ok) return;
      const list = (await r.json()) as Record<string, string>;
      for (const [name, file] of Object.entries(list)) {
        try {
          const buf = await (await fetch(`audio/${file}`)).arrayBuffer();
          this.files[name] = await this.ctx!.decodeAudioData(buf);
        } catch {
          /* missing or unreadable file: keep the synth */
        }
      }
    } catch {
      /* no manifest: synth only */
    }
  }

  /** Brown-ish noise: a warmer base for engines, wind and rain. */
  private noiseBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      d[i] = last * 3.2 + white * 0.15;
    }
    return b;
  }

  private set(name: string, gain: number, freq?: number, oscFreq?: number): void {
    const l = this.loops[name];
    const ctx = this.ctx;
    if (!l || !ctx) return;
    const t = ctx.currentTime;
    l.gain.gain.setTargetAtTime(Math.max(0, gain), t, 0.15);
    if (freq !== undefined) l.filter.frequency.setTargetAtTime(freq, t, 0.15);
    if (oscFreq !== undefined && l.osc) l.osc.frequency.setTargetAtTime(oscFreq, t, 0.1);
  }

  update(f: AudioFrame): void {
    if (!this.ctx) return;
    const flying = f.mode === 'fly';
    const inside = flying && f.cockpit;
    const muffle = inside ? 0.45 : 1;
    // your aircraft
    const n1 = flying ? f.n1 : 0;
    this.set('engine', n1 * n1 * 0.7 * muffle, 150 + n1 * (inside ? 500 : 1400));
    this.set('whine', n1 * n1 * 0.05 * (inside ? 0.4 : 1), 1500 + n1 * 3000, 900 + n1 * 3800);
    const air = flying && !f.onGround ? Math.min(1, f.iasKt / 280) : flying ? Math.min(1, f.iasKt / 200) * 0.4 : 0;
    this.set('airflow', air * air * (inside ? 0.35 : 0.5), 400 + air * 900);
    // weather
    this.set('rain', f.precip * (inside ? 0.18 : f.mode === 'ops' ? 0 : 0.3), inside ? 2500 : 1800);
    const windy = f.mode === 'walk' ? Math.min(1, f.windKt / 35) : 0;
    this.set('wind', windy * 0.25, 250 + windy * 400);
    if (f.storm && f.mode !== 'ops' && this.ctx.currentTime > this.thunderAt) {
      this.thunderAt = this.ctx.currentTime + 12 + Math.random() * 25;
      this.thunder();
    }
    // other aircraft around the airport
    const jet = f.mode === 'ops' ? 0 : (f.jet.thrust * f.jet.thrust) / (1 + f.jet.dist / 120);
    this.set('jets', Math.min(0.6, jet * 0.9) * (inside ? 0.4 : 1), 200 + f.jet.thrust * 700);
    // your car
    const drive = f.mode === 'drive';
    const rpm = drive ? 800 + ((f.carSpeed % 22) / 22) * 5200 + f.carThrottle * 600 : 0;
    this.set('car', drive ? 0.05 + f.carThrottle * 0.06 : 0, 400 + rpm * 0.4, rpm / 25);
    // radio-altimeter callouts on landing
    if (flying && !f.onGround && f.raFt < 1100) {
      for (const h of [1000, 500, 100, 50, 40, 30, 20, 10]) {
        if (this.lastRa > h && f.raFt <= h && !this.said.has(String(h))) {
          this.said.add(String(h));
          this.say(h === 1000 ? 'one thousand' : h === 500 ? 'five hundred' : h === 100 ? 'one hundred' : String(h));
        }
      }
      if (f.raFt < 20 && f.n1 > 0.3 && !this.said.has('retard') && this.lastRa >= 20) {
        this.said.add('retard');
        setTimeout(() => this.say('retard'), 700);
      }
    }
    if (f.raFt > 1500 || f.onGround) this.said.clear();
    this.lastRa = f.raFt;
  }

  private say(text: string): void {
    if (!('speechSynthesis' in window) || this.volume <= 0) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.15;
    u.pitch = 0.6;
    u.volume = this.volume;
    speechSynthesis.speak(u);
  }

  /** Radio transmission: a squelch click, then the message in a radio-ish voice. */
  radio(text: string, who: 'atc' | 'ai'): void {
    if (this.ctx && this.master) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      src.connect(f).connect(g).connect(this.master);
      src.start();
      src.stop(t + 0.13);
    }
    if (!('speechSynthesis' in window) || this.volume <= 0) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    const gb = voices.filter((v) => v.lang === 'en-GB');
    u.voice = (who === 'atc' ? gb[0] ?? voices[0] : voices.find((v) => v !== gb[0]) ?? voices[1] ?? voices[0]) ?? null;
    u.rate = who === 'atc' ? 1.15 : 1.1;
    u.pitch = who === 'atc' ? 0.95 : 0.8;
    u.volume = this.volume * (who === 'atc' ? 1 : 0.6);
    speechSynthesis.speak(u);
  }

  private thunder(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 180;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.8, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.5);
    src.connect(f).connect(g).connect(this.master!);
    src.start();
    src.stop(t + 3.6);
  }

  /** Short UI sounds. */
  chime(kind: 'achievement' | 'click' | 'bad'): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const notes = kind === 'achievement' ? [660, 880, 1320] : kind === 'bad' ? [330, 247] : [1200];
    notes.forEach((n, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = n;
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(kind === 'click' ? 0.05 : 0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g).connect(this.master!);
      o.start(t);
      o.stop(t + 0.55);
    });
  }
}
