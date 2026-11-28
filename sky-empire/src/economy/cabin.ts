import type { AircraftType } from './types';

/**
 * Cabin layouts shared by the simulation and the cabin editor.
 * Row mode: class zones (rows × seats abreast × pitch) plus galleys and lavatories.
 * Free mode (VIP / business jets): furniture placed on the floor plan.
 */
export type CabinClass = 'J' | 'W' | 'Y';

export interface CabinZone {
  cls: CabinClass;
  rows: number;
  abreast: number;
  pitchIn: number;
}

export interface CabinItem {
  kind: string;
  x: number; // metres from the cabin centreline (+ = right)
  z: number; // metres from the front of the cabin
  rot: number; // 0 / 90 / 180 / 270
}

export interface CabinLayout {
  mode: 'rows' | 'free';
  zones: CabinZone[];
  galleys: number;
  lavs: number;
  items: CabinItem[];
}

export interface CabinStats {
  j: number;
  w: number;
  y: number;
  total: number;
  lengthUsedM: number;
  lengthAvailM: number;
  comfort: number; // 0..1
  maxSeats: number;
  errors: string[];
}

const IN = 0.0254;
const GALLEY_M = 1.2;
const LAV_M = 1.0;

/** Fuselage class: seats abreast that physically fit per cabin class. */
export function abreastOptions(t: AircraftType, cls: CabinClass): number[] {
  const wide = t.category === 'widebody' || t.category === 'jumbo';
  const small = t.category === 'turboprop' || t.category === 'regional' || t.role === 'bizjet' || t.role === 'heli';
  if (small) return cls === 'Y' ? [4, 3] : cls === 'W' ? [3, 4] : [3, 2];
  if (wide) return cls === 'Y' ? [9, 10, 8] : cls === 'W' ? [8, 7] : [4, 6, 7];
  return cls === 'Y' ? [6] : cls === 'W' ? [6, 4] : [4, 2];
}

/** Cabin geometry derived from the type's default two-class layout. */
export function cabinGeometry(t: AircraftType): { lengthM: number; maxSeats: number } {
  const [j, y] = t.seats;
  const ay = abreastOptions(t, 'Y')[0];
  const aj = abreastOptions(t, 'J')[0];
  const lengthM = (y / ay) * 30 * IN + (j / aj) * 38 * IN + 2 * GALLEY_M + 3 * LAV_M;
  return { lengthM, maxSeats: Math.round((j + y) * 1.15) };
}

export function defaultCabin(t: AircraftType): CabinLayout {
  const [j, y] = t.seats;
  const ay = abreastOptions(t, 'Y')[0];
  const aj = abreastOptions(t, 'J')[0];
  const zones: CabinZone[] = [];
  if (j > 0) zones.push({ cls: 'J', rows: Math.round(j / aj), abreast: aj, pitchIn: 38 });
  if (y > 0) zones.push({ cls: 'Y', rows: Math.round(y / ay), abreast: ay, pitchIn: 30 });
  return { mode: t.role === 'vip' || t.role === 'bizjet' ? 'free' : 'rows', zones, galleys: 2, lavs: 3, items: [] };
}

/** How comfortable a seat is (0..1) from class and pitch. */
export function seatComfort(cls: CabinClass, pitchIn: number): number {
  if (cls === 'J') return pitchIn >= 60 ? 1 : pitchIn >= 45 ? 0.9 : 0.78;
  if (cls === 'W') return Math.min(0.88, 0.55 + (pitchIn - 32) * 0.05);
  return Math.max(0.1, Math.min(0.85, 0.5 + (pitchIn - 30) * 0.12));
}

export const FREE_ITEMS: Record<string, { label: string; w: number; d: number; seats: number; beds: number; color: string }> = {
  seat: { label: 'Club seat', w: 0.8, d: 0.9, seats: 1, beds: 0, color: '#c9b58a' },
  divan: { label: 'Divan (3 seats)', w: 2.0, d: 0.8, seats: 3, beds: 1, color: '#b9a37a' },
  table: { label: 'Dining table', w: 1.2, d: 0.9, seats: 0, beds: 0, color: '#6b4b32' },
  bed: { label: 'Double bed', w: 1.6, d: 2.0, seats: 0, beds: 2, color: '#e8e0d2' },
  bar: { label: 'Bar', w: 1.6, d: 0.6, seats: 0, beds: 0, color: '#3a2a1e' },
  shower: { label: 'Shower', w: 1.0, d: 1.0, seats: 0, beds: 0, color: '#9fc6d8' },
  meeting: { label: 'Meeting table (6)', w: 2.2, d: 1.2, seats: 6, beds: 0, color: '#5a4636' },
  galley: { label: 'Galley', w: 1.4, d: 1.0, seats: 0, beds: 0, color: '#b9bcc0' },
  lav: { label: 'Lavatory', w: 1.0, d: 1.0, seats: 0, beds: 0, color: '#d8dbe0' },
  screen: { label: 'Cinema screen', w: 1.8, d: 0.2, seats: 0, beds: 0, color: '#111111' },
};

export function cabinStats(t: AircraftType, c: CabinLayout): CabinStats {
  const geo = cabinGeometry(t);
  const errors: string[] = [];
  if (c.mode === 'free') {
    let seats = 0;
    let beds = 0;
    for (const it of c.items) {
      seats += FREE_ITEMS[it.kind]?.seats ?? 0;
      beds += FREE_ITEMS[it.kind]?.beds ?? 0;
    }
    const comfort = Math.min(1, 0.75 + beds * 0.04 + (c.items.some((i) => i.kind === 'shower') ? 0.08 : 0) + (c.items.some((i) => i.kind === 'bar') ? 0.05 : 0));
    if (!c.items.some((i) => i.kind === 'lav')) errors.push('Add at least one lavatory');
    return { j: seats, w: 0, y: 0, total: seats, lengthUsedM: 0, lengthAvailM: geo.lengthM, comfort, maxSeats: geo.maxSeats, errors };
  }
  let j = 0;
  let w = 0;
  let y = 0;
  let len = c.galleys * GALLEY_M + c.lavs * LAV_M;
  let comfortSum = 0;
  for (const z of c.zones) {
    const n = z.rows * z.abreast;
    if (z.cls === 'J') j += n;
    else if (z.cls === 'W') w += n;
    else y += n;
    len += z.rows * z.pitchIn * IN;
    comfortSum += n * seatComfort(z.cls, z.pitchIn);
  }
  const total = j + w + y;
  if (len > geo.lengthM + 0.05) errors.push(`Too long: ${len.toFixed(1)} m of ${geo.lengthM.toFixed(1)} m cabin`);
  if (total > geo.maxSeats) errors.push(`Over the exit limit of ${geo.maxSeats} seats`);
  if (c.lavs < Math.ceil(total / 60)) errors.push(`Needs at least ${Math.ceil(total / 60)} lavatories`);
  if (c.galleys < 1) errors.push('Needs at least one galley');
  return { j, w, y, total, lengthUsedM: len, lengthAvailM: geo.lengthM, comfort: total ? comfortSum / total : 0.5, maxSeats: geo.maxSeats, errors };
}

/** Usable cabin floor width (m) by fuselage class. */
export function cabinWidthM(t: AircraftType): number {
  if (t.category === 'jumbo') return 6.1;
  if (t.category === 'widebody') return 5.6;
  if (t.role === 'bizjet' || t.role === 'heli') return 2.2;
  if (t.category === 'turboprop' || t.category === 'regional') return 2.6;
  return 3.7;
}

/** Seat groups across the cabin for a given number abreast (e.g. 6 → [3,3], 9 → [3,3,3]). */
export function seatGroups(abreast: number, widthM: number): number[] {
  if (widthM < 4.5) {
    if (abreast <= 2) return [1, 1];
    const l = Math.floor(abreast / 2);
    return [l, abreast - l];
  }
  const M: Record<number, number[]> = { 4: [1, 2, 1], 6: [2, 2, 2], 7: [2, 3, 2], 8: [2, 4, 2], 9: [3, 3, 3], 10: [3, 4, 3] };
  return M[abreast] ?? [Math.floor(abreast / 3), abreast - 2 * Math.floor(abreast / 3), Math.floor(abreast / 3)];
}

export interface PlanSeat { x: number; z: number; cls: CabinClass; w: number; d: number }
export interface PlanBlock { kind: 'galley' | 'lav'; z0: number; z1: number; x0: number; x1: number }

/**
 * Lay out a row-mode cabin on the floor: seats (x across from the centreline, z from the front)
 * plus galley and lavatory blocks. Front: half the galleys and one lav; rear: the rest.
 */
export function seatPlan(c: CabinLayout, widthM: number): { seats: PlanSeat[]; blocks: PlanBlock[]; lengthM: number } {
  const seats: PlanSeat[] = [];
  const blocks: PlanBlock[] = [];
  const aisle = 0.5;
  let z = 0;
  const half = widthM / 2;
  const fg = Math.ceil(c.galleys / 2);
  const fl = Math.min(1, c.lavs);
  const block = (kind: PlanBlock['kind'], len: number, x0 = -half, x1 = half) => {
    blocks.push({ kind, z0: z, z1: z + len, x0, x1 });
    z += len;
  };
  for (let i = 0; i < fg; i++) block('galley', GALLEY_M);
  for (let i = 0; i < fl; i++) block('lav', LAV_M, half - 1.0, half);
  for (const zone of c.zones) {
    const groups = seatGroups(zone.abreast, widthM);
    const nAisles = groups.length - 1;
    const maxW = zone.cls === 'J' ? 0.75 : zone.cls === 'W' ? 0.5 : 0.46;
    const w = Math.min(maxW, (widthM - nAisles * aisle - 0.1) / zone.abreast);
    const pitch = zone.pitchIn * IN;
    const total = zone.abreast * w + nAisles * aisle;
    for (let r = 0; r < zone.rows; r++) {
      let x = -total / 2;
      for (const g of groups) {
        for (let k = 0; k < g; k++) {
          seats.push({ x: x + w / 2, z: z + pitch / 2, cls: zone.cls, w, d: Math.min(pitch * 0.85, zone.cls === 'J' ? 1.4 : 0.7) });
          x += w;
        }
        x += aisle;
      }
      z += pitch;
    }
  }
  for (let i = fl; i < c.lavs; i++) block('lav', LAV_M, i % 2 ? -half : half - 1.0, i % 2 ? -half + 1.0 : half);
  for (let i = fg; i < c.galleys; i++) block('galley', GALLEY_M);
  return { seats, blocks, lengthM: z };
}

export const CLASS_COLOR: Record<CabinClass, string> = { J: '#24407e', W: '#3f6ea6', Y: '#5c6a80' };
