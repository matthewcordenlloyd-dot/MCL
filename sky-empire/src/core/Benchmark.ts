import * as THREE from 'three';
import { PRESET_IDS, PRESETS, type PresetId } from './settings';
import type { Game } from './Game';

/**
 * Automated performance test: open the game with ?bench. For each preset it holds
 * three fixed camera views (apron, terminal interior, runway vista) and records frame
 * times. Results appear on screen and in window.__bench. Note: browsers cap frame
 * rate at the display refresh (usually 60 Hz), so 60 fps means "at least 60".
 */
type View = { name: string; pos: [number, number, number]; look: [number, number, number] };
let VIEWS: View[] = [];
const WARMUP = 1.2;
const MEASURE = 4;

export interface BenchResult {
  preset: PresetId;
  view: string;
  avgFps: number;
  low1Fps: number;
  avgMs: number;
}

export function runBenchmark(game: Game): void {
  VIEWS = game.benchViews();
  const results: BenchResult[] = [];
  const panel = document.createElement('div');
  panel.id = 'bench';
  panel.className = 'glass';
  document.body.appendChild(panel);
  const startPreset = game.settings.preset;
  const queue: { preset: PresetId; view: number }[] = [];
  const only = new URLSearchParams(location.search).get('bench');
  const presets = only && (PRESET_IDS as string[]).includes(only) ? [only as PresetId] : PRESET_IDS;
  for (const p of presets) for (let v = 0; v < VIEWS.length; v++) queue.push({ preset: p, view: v });

  let step = -1;
  let t = 0;
  let samples: number[] = [];
  const cam = game.camera;
  const next = () => {
    step++;
    t = 0;
    samples = [];
    if (step >= queue.length) return finish();
    const q = queue[step];
    if (game.settings.preset !== q.preset) game.setPreset(q.preset);
    const v = VIEWS[q.view];
    game.cameraOverride = () => {
      cam.position.set(...v.pos);
      cam.lookAt(new THREE.Vector3(...v.look));
    };
  };
  const render = () => {
    const rows = results.map((r) => `<tr><td>${PRESETS[r.preset].label}</td><td>${r.view}</td><td>${r.avgFps.toFixed(0)}</td><td>${r.low1Fps.toFixed(0)}</td><td>${r.avgMs.toFixed(1)}</td></tr>`).join('');
    const cur = queue[step];
    panel.innerHTML = `<b>Benchmark</b> ${cur ? `· running ${PRESETS[cur.preset].label} / ${VIEWS[cur.view].name}` : '· done'}
      <table><tr><th>preset</th><th>view</th><th>avg fps</th><th>1% low</th><th>ms</th></tr>${rows}</table>`;
  };
  const finish = () => {
    game.cameraOverride = null;
    game.onFrame = null;
    game.setPreset(startPreset);
    (window as unknown as { __bench: BenchResult[] }).__bench = results;
    console.table(results);
    render();
  };
  game.onFrame = (dt) => {
    if (step < 0) return next();
    t += dt;
    if (t > WARMUP) samples.push(dt);
    if (t >= WARMUP + MEASURE) {
      const sorted = [...samples].sort((a, b) => b - a);
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      const p99 = sorted[Math.floor(sorted.length * 0.01)] ?? avg;
      results.push({ preset: queue[step].preset, view: VIEWS[queue[step].view].name, avgFps: 1 / avg, low1Fps: 1 / p99, avgMs: avg * 1000 });
      render();
      next();
    }
  };
  render();
}
