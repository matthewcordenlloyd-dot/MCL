import type { Command, FromWorker, GameState, NewGameParams, RouteQuote, Snapshot, ToWorker } from './types';

type Listener<T> = (v: T) => void;

/** Main-thread handle on the economy Web Worker. */
export class EconomyClient {
  private worker: Worker;
  private seq = 1;
  private pending = new Map<number, (v: { ok: boolean; msg: string; data?: unknown } | GameState) => void>();
  private snapListeners: Listener<Snapshot>[] = [];
  private eventListeners: Listener<{ text: string; level: string }>[] = [];
  snap: Snapshot | null = null;
  running = false;

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'snapshot') {
        this.snap = m.snap;
        for (const l of this.snapListeners) l(m.snap);
      } else if (m.type === 'event') {
        for (const l of this.eventListeners) l(m);
      } else if (m.type === 'result') {
        this.pending.get(m.id)?.({ ok: m.ok, msg: m.msg, data: m.data });
        this.pending.delete(m.id);
      } else if (m.type === 'state') {
        this.pending.get(m.id)?.(m.state);
        this.pending.delete(m.id);
      }
    };
  }

  private post(m: ToWorker): void {
    this.worker.postMessage(m);
  }

  newGame(p: NewGameParams): void {
    this.post({ type: 'new', params: p });
    this.running = true;
  }

  load(state: GameState): void {
    this.post({ type: 'load', state });
    this.running = true;
  }

  setSpeed(v: number): void {
    this.post({ type: 'speed', value: v });
  }

  cmd(c: Command): Promise<{ ok: boolean; msg: string; data?: unknown }> {
    const id = this.seq++;
    this.post({ type: 'cmd', id, cmd: c });
    return new Promise((res) => this.pending.set(id, res as (v: unknown) => void));
  }

  async quote(q: Extract<Command, { kind: 'quote' }>): Promise<RouteQuote> {
    return (await this.cmd(q)).data as RouteQuote;
  }

  getState(): Promise<GameState> {
    const id = this.seq++;
    this.post({ type: 'getState', id });
    return new Promise((res) => this.pending.set(id, res as (v: unknown) => void));
  }

  onSnapshot(l: Listener<Snapshot>): void {
    this.snapListeners.push(l);
  }

  onEvent(l: Listener<{ text: string; level: string }>): void {
    this.eventListeners.push(l);
  }
}
