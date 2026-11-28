import * as THREE from 'three';
import runwaysData from '@data/world/runways.json';
import { geoToLocal, type GeoOrigin } from '../core/geo';
import type { GroundTextures } from './textures';
import type { Mask } from '../terrain/Terrain';
import { lightSprite, poolTexture } from './Lights';

type RunwayRow = [string, string, number, number, number, number, number, number, string];
const RUNWAYS = (runwaysData as unknown as { byIcao: Record<string, RunwayRow[]> }).byIcao;

export interface ProcRunway {
  ends: [string, string];
  a: THREE.Vector3; // le threshold (world)
  b: THREE.Vector3; // he threshold
  lengthM: number;
  widthM: number;
}

/**
 * A destination airport generated at runtime from real runway data (OurAirports):
 * every runway with correct position, heading, length and width, ICAO-style markings,
 * designators and edge lights, plus an apron and a generic terminal building.
 * Used for any airport that has no hand-built detailed model.
 */
export class ProceduralAirport {
  readonly group = new THREE.Group();
  readonly runways: ProcRunway[] = [];
  /** Where a visitor (private jet trip) stands: the apron next to the terminal. */
  apronSpawn: THREE.Vector3 | null = null;
  /** Parking stands facing the terminal (world position of the aircraft origin, yaw). */
  readonly stands: { pos: THREE.Vector3; yaw: number }[] = [];
  private glassMat: THREE.MeshStandardMaterial | null = null;
  private night = new THREE.Group();
  private pools: THREE.MeshBasicMaterial | null = null;
  private daylight = -1;
  private apronShift = 0;
  private disposables: { dispose(): void }[] = [];

  constructor(readonly icao: string, origin: GeoOrigin, tex: GroundTextures) {
    this.group.name = `proc_${icao}`;
    const rows = RUNWAYS[icao] ?? [];
    const asphalt = this.mat(new THREE.MeshStandardMaterial({ map: tex.runway, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }));
    const paint = this.mat(new THREE.MeshStandardMaterial({ map: tex.paint, color: '#f2f2ee', roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 }));
    const concrete = this.mat(new THREE.MeshStandardMaterial({ map: tex.concrete, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
    const lights: THREE.Vector3[] = [];
    for (const r of rows) {
      const [le, he, laLat, laLon, hbLat, hbLon, lenM, widM] = r;
      const pa = geoToLocal(origin, laLat, laLon);
      const pb = geoToLocal(origin, hbLat, hbLon);
      const a = new THREE.Vector3(pa.x, 0, pa.z);
      const b = new THREE.Vector3(pb.x, 0, pb.z);
      const len = a.distanceTo(b) || lenM;
      const w = Math.max(widM || 45, 23);
      this.runways.push({ ends: [le, he], a, b, lengthM: len, widthM: w });
      const dir = b.clone().sub(a).normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const strip = (len2: number, w2: number, at: THREE.Vector3, mat: THREE.Material, y: number) => {
        const g = new THREE.PlaneGeometry(w2, len2).rotateX(-Math.PI / 2);
        const uv = g.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w2) / 30, (uv.getY(i) * len2) / 30);
        const m = new THREE.Mesh(g, mat);
        m.position.set(at.x, y, at.z);
        m.rotation.y = yaw;
        m.receiveShadow = true;
        this.disposables.push(g);
        this.group.add(m);
        return m;
      };
      strip(len + 60, w + 15, mid, asphalt, 0.03);
      const side = new THREE.Vector3(dir.z, 0, -dir.x);
      // edge lines, centreline dashes, threshold piano keys, aiming points
      for (const s of [-1, 1]) strip(len, 0.9, mid.clone().addScaledVector(side, s * (w / 2 - 0.5)), paint, 0.05);
      for (let d = 130; d < len - 130; d += 50) strip(30, 0.9, a.clone().addScaledVector(dir, d + 15), paint, 0.05);
      const keys = Math.max(4, Math.min(16, Math.floor(w / 3)));
      for (const [th, sgn] of [[a, 1], [b, -1]] as [THREE.Vector3, number][]) {
        for (let k = 0; k < keys; k++) {
          const off = (k - (keys - 1) / 2) * (w / (keys + 1));
          strip(30, 1.8, th.clone().addScaledVector(dir, sgn * 21).addScaledVector(side, off), paint, 0.05);
        }
        for (const s of [-1, 1]) strip(60, 10, th.clone().addScaledVector(dir, sgn * 430).addScaledVector(side, s * Math.min(10.5, w / 4)), paint, 0.05);
      }
      this.designator(le, a, dir, yaw);
      this.designator(he, b, dir.clone().negate(), yaw + Math.PI);
      for (let d = 0; d <= len; d += 60) for (const s of [-1, 1]) lights.push(a.clone().addScaledVector(dir, d).addScaledVector(side, s * (w / 2 + 1.5)));
    }
    // apron + generic terminal beside the longest runway
    const main = [...this.runways].sort((x, y) => y.lengthM - x.lengthM)[0];
    if (main) {
      const dir = main.b.clone().sub(main.a).normalize();
      const runMid = main.a.clone().add(main.b).multiplyScalar(0.5);
      // put the apron where it clears every other runway: try both sides and a few distances
      const others = this.runways.filter((r) => r !== main);
      const clearance = (p: THREE.Vector3) => Math.min(Infinity, ...others.map((r) => segDist(p, r.a, r.b) - r.widthM / 2));
      let best = { sign: 1, shift: 0, clear: -Infinity };
      for (const shift of [0, 350, 700, 1050]) {
        for (const sign of [1, -1]) {
          const n = new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(sign);
          // the whole apron band (taxiway at 160 … terminal at 400) must stay clear
          let c = Infinity;
          for (const o of [140, 260, 330, 400]) for (const t of [-0.4, 0, 0.4]) c = Math.min(c, clearance(runMid.clone().addScaledVector(dir, t * main.lengthM).addScaledVector(n, shift + o)));
          if (c > best.clear + 1) best = { sign, shift, clear: c };
        }
        if (best.clear > 120) break;
      }
      const side = new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(best.sign);
      const mid = runMid.clone().addScaledVector(side, best.shift);
      this.apronShift = best.shift;
      const apron = mid.clone().addScaledVector(side, 260);
      this.apronSpawn = mid.clone().addScaledVector(side, 340);
      const g = new THREE.PlaneGeometry(420, 170).rotateX(-Math.PI / 2);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 42, uv.getY(i) * 17);
      const am = new THREE.Mesh(g, concrete);
      am.position.set(apron.x, 0.03, apron.z);
      am.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI / 2;
      am.receiveShadow = true;
      this.disposables.push(g);
      this.group.add(am);
      const termPos = mid.clone().addScaledVector(side, 380);
      const tg = new THREE.BoxGeometry(260, 16, 50);
      const term = new THREE.Mesh(tg, this.mat(new THREE.MeshStandardMaterial({ color: '#c9ccd1', roughness: 0.6, metalness: 0.2 })));
      term.position.set(termPos.x, 8, termPos.z);
      term.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI / 2;
      term.castShadow = true;
      this.disposables.push(tg);
      this.group.add(term);
      const glassG = new THREE.BoxGeometry(258, 9, 50.6);
      this.glassMat = this.mat(new THREE.MeshStandardMaterial({ color: '#2d4250', roughness: 0.08, metalness: 0.6, emissive: '#ffcf8a', emissiveIntensity: 0 }));
      const glass = new THREE.Mesh(glassG, this.glassMat);
      glass.position.set(termPos.x, 7, termPos.z);
      glass.rotation.y = term.rotation.y;
      this.disposables.push(glassG);
      this.group.add(glass);
      this.extras(main, mid, dir, side, asphalt, concrete);
    }
    this.group.add(this.night);
    if (lights.length) {
      const lg = new THREE.CylinderGeometry(0.12, 0.16, 0.35, 6);
      const lm = this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 2.6) }));
      const im = new THREE.InstancedMesh(lg, lm, lights.length);
      const m = new THREE.Matrix4();
      lights.forEach((p, i) => im.setMatrixAt(i, m.makeTranslation(p.x, 0.2, p.z)));
      im.computeBoundingSphere();
      this.disposables.push(lg);
      this.group.add(im);
    }
  }

  /** Parallel taxiway with connectors, stands with jet bridges, a control tower and apron floodlights. */
  private extras(main: ProcRunway, mid: THREE.Vector3, dir: THREE.Vector3, side: THREE.Vector3, asphalt: THREE.Material, concrete: THREE.Material): void {
    const yaw = Math.atan2(dir.x, dir.z);
    const box = (w: number, h: number, d: number, at: THREE.Vector3, y: number, mat: THREE.Material, rotY = yaw) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(g, mat);
      m.position.set(at.x, y, at.z);
      m.rotation.y = rotY;
      m.castShadow = true;
      m.receiveShadow = true;
      this.disposables.push(g);
      this.group.add(m);
      return m;
    };
    const flat = (w: number, len: number, at: THREE.Vector3, mat: THREE.Material, rotY = yaw) => {
      const g = new THREE.PlaneGeometry(w, len).rotateX(-Math.PI / 2);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / 30, (uv.getY(i) * len) / 30);
      const m = new THREE.Mesh(g, mat);
      m.position.set(at.x, 0.025, at.z);
      m.rotation.y = rotY;
      m.receiveShadow = true;
      this.disposables.push(g);
      this.group.add(m);
    };
    // parallel taxiway 160 m from the runway on the terminal side, with end and middle connectors
    const tw = mid.clone().addScaledVector(side, 160);
    flat(23, main.lengthM, tw, asphalt);
    const reach = 160 + this.apronShift; // from the runway centreline to the parallel taxiway
    for (const t of [-0.5, 0, 0.5]) flat(23, reach, mid.clone().addScaledVector(dir, t * (main.lengthM - 40)).addScaledVector(side, 160 - reach / 2), asphalt, yaw + Math.PI / 2);
    flat(23, 100, mid.clone().addScaledVector(side, 210), asphalt, yaw + Math.PI / 2);
    // stands: aircraft parked nose-in towards the terminal
    const white = this.mat(new THREE.MeshStandardMaterial({ color: '#d9dcdf', roughness: 0.6, metalness: 0.2 }));
    for (let k = 0; k < 4; k++) {
      const along = (k - 1.5) * 62;
      const nose = mid.clone().addScaledVector(dir, along).addScaledVector(side, 312);
      const facing = side.clone(); // nose towards the terminal
      const origin = nose.clone().addScaledVector(facing, -17.6);
      this.stands.push({ pos: origin, yaw: Math.atan2(-facing.x, -facing.z) });
      // jet bridge from the terminal face to the forward door
      const bridgeStart = mid.clone().addScaledVector(dir, along - 6).addScaledVector(side, 355);
      const bridgeEnd = nose.clone().addScaledVector(dir, -6).addScaledVector(side, -12);
      const c = bridgeStart.clone().add(bridgeEnd).multiplyScalar(0.5);
      const len = bridgeStart.distanceTo(bridgeEnd);
      box(3, 3, len, c, 4.8, white, Math.atan2(bridgeEnd.x - bridgeStart.x, bridgeEnd.z - bridgeStart.z));
      box(0.8, 4, 0.8, bridgeEnd, 2, white);
    }
    // control tower beside the terminal
    const tp = mid.clone().addScaledVector(dir, 200).addScaledVector(side, 400);
    const shaft = new THREE.CylinderGeometry(3.2, 4, 46, 16);
    const sm = new THREE.Mesh(shaft, white);
    sm.position.set(tp.x, 23, tp.z);
    sm.castShadow = true;
    const cabG = new THREE.CylinderGeometry(7, 5.5, 6, 12);
    const cab = new THREE.Mesh(cabG, this.glassMat!);
    cab.position.set(tp.x, 49, tp.z);
    const capG = new THREE.CylinderGeometry(7.6, 7.6, 1.2, 12);
    const cap = new THREE.Mesh(capG, white);
    cap.position.set(tp.x, 52.6, tp.z);
    this.disposables.push(shaft, cabG, capG);
    this.group.add(sm, cab, cap);
    // apron floodlights with light pools at night
    const poleG = new THREE.CylinderGeometry(0.25, 0.35, 24, 8).translate(0, 12, 0);
    this.disposables.push(poleG);
    this.pools = this.mat(new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -24 }));
    const poolG = new THREE.PlaneGeometry(70, 70).rotateX(-Math.PI / 2);
    this.disposables.push(poolG);
    for (let k = -2; k <= 2; k++) {
      const p = mid.clone().addScaledVector(dir, k * 80).addScaledVector(side, 180);
      const pole = new THREE.Mesh(poleG, white);
      pole.position.set(p.x, 0, p.z);
      this.group.add(pole);
      const head = lightSprite('#ffd8a0', 5);
      head.position.set(p.x, 24.3, p.z);
      head.userData.lamp = true;
      this.night.add(head);
      const pool = new THREE.Mesh(poolG, this.pools);
      const pp = p.clone().addScaledVector(side, 30);
      pool.position.set(pp.x, 0.1, pp.z);
      this.night.add(pool);
    }
    void concrete;
  }

  /** 1 = day, 0 = night: terminal windows glow and the floodlights come on. */
  setDaylight(day: number): void {
    if (Math.abs(day - this.daylight) < 0.01) return;
    this.daylight = day;
    const night = 1 - day;
    if (this.glassMat) this.glassMat.emissiveIntensity = night * 0.8;
    if (this.pools) this.pools.opacity = night * 0.55;
    this.night.visible = night > 0.05;
    for (const o of this.night.children) if (o.userData.lamp) (o as THREE.Sprite).scale.setScalar(2 + night * 6);
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.disposables.push(m);
    return m;
  }

  /** Runway number (+ L/C/R) painted on the threshold, readable from the approach. */
  private designator(text: string, th: THREE.Vector3, inward: THREE.Vector3, yaw: number): void {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 512;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.font = 'bold 230px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const num = text.replace(/[LCR]$/, '');
    const letter = text.slice(num.length);
    g.fillText(num.padStart(2, '0'), 128, 150);
    if (letter) g.fillText(letter, 128, 380);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    const geo = new THREE.PlaneGeometry(12, 24).rotateX(-Math.PI / 2);
    const mat = this.mat(new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -20, color: '#e8e8e4' }));
    const m = new THREE.Mesh(geo, mat);
    const p = th.clone().addScaledVector(inward, 62);
    m.position.set(p.x, 0.06, p.z);
    m.rotation.y = yaw + Math.PI;
    this.disposables.push(geo, t);
    this.group.add(m);
  }

  /** Flattening mask for the terrain (axis-aligned box around the airfield). */
  mask(margin = 700 + this.apronShift): Mask {
    const pts = this.runways.flatMap((r) => [r.a, r.b]);
    if (!pts.length) return { min: [-1500, -1500], max: [1500, 1500], blendM: 400, y: 0 };
    return {
      min: [Math.min(...pts.map((p) => p.x)) - margin, Math.min(...pts.map((p) => p.z)) - margin],
      max: [Math.max(...pts.map((p) => p.x)) + margin, Math.max(...pts.map((p) => p.z)) + margin],
      blendM: 400,
      y: 0,
    };
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}

function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / (abx * abx + abz * abz || 1)));
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}
