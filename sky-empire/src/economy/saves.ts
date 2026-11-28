import type { GameState } from './types';

/** Save slots in IndexedDB, plus export/import as JSON files. */
const DB = 'skyempire';
const STORE = 'saves';

export interface SaveMeta {
  slot: string;
  airline: string;
  savedAt: number;
  simTime: number;
  cashUSD: number;
  difficulty: string;
}

interface SaveRecord extends SaveMeta {
  state: GameState;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'slot' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveGame(slot: string, state: GameState): Promise<void> {
  const rec: SaveRecord = { slot, airline: state.airline.name, savedAt: Date.now(), simTime: state.time, cashUSD: state.cashUSD, difficulty: state.difficulty, state };
  await tx('readwrite', (s) => s.put(rec));
}

export async function listSaves(): Promise<SaveMeta[]> {
  try {
    const all = (await tx('readonly', (s) => s.getAll())) as SaveRecord[];
    return all.map(({ state: _s, ...meta }) => meta).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function loadGame(slot: string): Promise<GameState | null> {
  const rec = (await tx('readonly', (s) => s.get(slot))) as SaveRecord | undefined;
  return rec?.state ?? null;
}

export async function deleteSave(slot: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(slot));
}

export function exportJson(state: GameState): void {
  const blob = new Blob([JSON.stringify({ format: 'sky-empire-save', version: state.version, state })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.airline.name.replace(/[^\w-]+/g, '_')}_${new Date(state.time).toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function importJson(file: File): Promise<GameState> {
  const j = JSON.parse(await file.text());
  if (j?.format !== 'sky-empire-save' || !j.state?.airline) throw new Error('Not a Sky Empire save file');
  return j.state as GameState;
}
