import * as THREE from 'three';
import type { FlightModel } from './FlightModel';

export interface RunwayDef { a: THREE.Vector3; b: THREE.Vector3; id: string; widthM?: number }

export interface IlsState {
  ident: string; // e.g. "26L"
  courseDeg: number;
  distNm: number;
  /** localiser deviation in dots (−2..2), + = runway centreline is to the right of you */
  loc: number;
  /** glideslope deviation in dots (−2..2), + = glide path is above you (fly up) */
  gs: number;
  heightAboveTdzFt: number;
}

const DEG = Math.PI / 180;
export const GLIDE_DEG = 3;
export const TDZ_M = 300; // touchdown point (and glideslope antenna) beyond the threshold

/** Both landing directions of each runway: threshold, unit direction, designator. */
export function runwayEnds(rws: RunwayDef[]): { thr: THREE.Vector3; dir: THREE.Vector3; ident: string; widthM: number }[] {
  const out: { thr: THREE.Vector3; dir: THREE.Vector3; ident: string; widthM: number }[] = [];
  for (const r of rws) {
    const [e1, e2] = r.id.split('/');
    const d = r.b.clone().sub(r.a).setY(0).normalize();
    out.push({ thr: r.a.clone(), dir: d, ident: e1 ?? r.id, widthM: r.widthM ?? 45 });
    out.push({ thr: r.b.clone(), dir: d.clone().negate(), ident: e2 ?? r.id, widthM: r.widthM ?? 45 });
  }
  return out;
}

/**
 * ILS for the runway end you are most plausibly approaching: within 30 km, in front of the
 * threshold, heading roughly down the runway. Localiser: 1 dot = 0.8°; glideslope (3°): 1 dot = 0.35°.
 */
export function ilsFor(fm: FlightModel, rws: RunwayDef[]): IlsState | null {
  let best: IlsState | null = null;
  let bestScore = Infinity;
  const hdg = fm.headingDeg;
  for (const e of runwayEnds(rws)) {
    const tdz = e.thr.clone().addScaledVector(e.dir, TDZ_M);
    const rel = fm.pos.clone().sub(tdz);
    const along = -(rel.x * e.dir.x + rel.z * e.dir.z); // metres before the touchdown point
    if (along < -200 || along > 30000) continue;
    const course = (Math.atan2(e.dir.x, -e.dir.z) / DEG + 360) % 360;
    let dh = Math.abs(hdg - course) % 360;
    if (dh > 180) dh = 360 - dh;
    if (dh > 70) continue;
    const cross = rel.x * e.dir.z - rel.z * e.dir.x; // + = you are left of the centreline
    const locDeg = Math.atan2(cross, Math.max(1, along)) / DEG;
    const h = fm.pos.y - tdz.y - 3; // gear-on-ground reference
    const angle = Math.atan2(h, Math.max(1, along)) / DEG;
    const score = Math.abs(locDeg) * 3 + dh;
    if (score < bestScore) {
      bestScore = score;
      best = {
        ident: e.ident, courseDeg: course, distNm: Math.max(0, along) / 1852,
        loc: THREE.MathUtils.clamp(locDeg / 0.8, -2.5, 2.5), gs: THREE.MathUtils.clamp((GLIDE_DEG - angle) / 0.35, -2.5, 2.5), heightAboveTdzFt: h / 0.3048,
      };
    }
  }
  return best;
}
