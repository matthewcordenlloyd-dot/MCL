import { Sim } from './Sim';
import type { FromWorker, ToWorker } from './types';

/**
 * Economy worker: owns the business simulation and advances it in real time × speed,
 * independently of rendering. The main thread only sends commands and receives snapshots.
 */
let sim: Sim | null = null;
let speed = 0;
let last = performance.now();
let lastSnap = 0;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

function attach(s: Sim): void {
  sim = s;
  sim.onEvent((text, level) => post({ type: 'event', text, level }));
  post({ type: 'snapshot', snap: sim.snapshot() });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'new':
      attach(Sim.create(m.params));
      break;
    case 'load':
      attach(new Sim(m.state));
      break;
    case 'speed':
      speed = m.value;
      if (sim) sim.s.speed = m.value;
      break;
    case 'cmd': {
      if (!sim) return post({ type: 'result', id: m.id, ok: false, msg: 'No game running' });
      const r = sim.command(m.cmd);
      // snapshot first, so the UI already has fresh data when the command's promise resolves
      if (m.cmd.kind !== 'quote') post({ type: 'snapshot', snap: sim.snapshot() });
      post({ type: 'result', id: m.id, ...r });
      break;
    }
    case 'getState':
      if (sim) post({ type: 'state', id: m.id, state: sim.s });
      break;
  }
};

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(now - last, 1000);
  last = now;
  if (!sim) return;
  if (speed > 0 && !sim.s.bankrupt) sim.step(dt * speed);
  if (now - lastSnap > 250) {
    lastSnap = now;
    post({ type: 'snapshot', snap: sim.snapshot() });
  }
}, 50);
