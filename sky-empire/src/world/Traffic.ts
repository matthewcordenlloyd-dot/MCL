import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import a320 from '@data/aircraft/a320neo.json';
import T from '@data/traffic.json';
import { AircraftModel, type AircraftData } from '../flight/AircraftModel';
import type { Brand } from '../customiser/liveryPainter';
import type { Airport } from './Airport';

type WP = { x: number; y: number; z: number; v: number; gear?: number };
interface Mover {
  model: AircraftModel;
  path: WP[];
  i: number;
  pos: THREE.Vector3;
  speed: number;
  yaw: number;
  pitch: number;
  gear: number;
  n1: number;
  wait: number; // seconds to hold at the current point (turnaround)
  call: string;
  spoken: string;
  kind: 'arrival' | 'departure' | 'turnaround';
  active: boolean;
}

const TAN3 = Math.tan((3 * Math.PI) / 180);

/**
 * AI traffic at your base: rival airliners land, roll out, taxi on the real taxiway layout, turn
 * around at a stand, push back and take off, using the runway direction the wind favours. They are
 * visual only (no physics) and hold or go around when you are on the runway.
 */
export class Traffic {
  private pool: Mover[] = [];
  private nextAt = 20;
  private elapsed = 0;
  private standBusy = false;
  brands: Brand[] = [];
  /** 'east' = runway 08 (moving +x in the airport frame), 'west' = runway 26 */
  flow: 'east' | 'west' = 'west';
  playerOnRunway = false;
  /** Radio calls from AI traffic (text, speech). */
  onRadio: ((text: string, speech: string) => void) | null = null;

  constructor(private airport: Airport, gltf: GLTF, lodBias: number) {
    const neutral: Brand = { name: '', colors: { primary: '#5a6470', accent: '#9aa3ad', secondary: '#ffffff', window: '#1b2430' } };
    for (let i = 0; i < T.maxAircraft; i++) {
      const model = new AircraftModel(gltf, a320 as unknown as AircraftData, neutral, 'G-AITR', T.liveryResolution, lodBias);
      model.root.visible = false;
      model.root.rotation.order = 'YXZ';
      airport.group.add(model.root);
      this.pool.push({ model, path: [], i: 0, pos: new THREE.Vector3(), speed: 0, yaw: 0, pitch: 0, gear: 1, n1: 0.2, wait: 0, kind: 'arrival', active: false, call: '', spoken: '' });
    }
  }

  /** Wind from (true degrees) picks the runway: land and take off into the wind. */
  setWind(fromDeg: number): void {
    // true heading of the +x direction (runway 08): frame heading minus the frame rotation
    const east = ((this.airport.data.runways[0].headingTrueDeg - this.airport.data.frameRotationDeg) % 360 + 360) % 360;
    const diff = Math.cos(((fromDeg - east) * Math.PI) / 180);
    this.flow = diff >= 0 ? 'east' : 'west';
  }

  private spawn(kind: Mover['kind']): void {
    const m = this.pool.find((x) => !x.active);
    if (!m || !this.brands.length) return;
    // spacing: one aircraft on approach and one departure rolling at a time
    const inbound = this.pool.some((x) => x.active && (x.kind === 'arrival' || x.kind === 'turnaround') && x.pos.y > 1);
    const outbound = this.pool.some((x) => x.active && x.kind === 'departure' && x.pos.y < 400);
    if ((kind !== 'departure' && inbound) || (kind === 'departure' && outbound)) return;
    const b = this.brands[Math.floor(Math.random() * this.brands.length)];
    const reg = `${String.fromCharCode(65 + Math.floor(Math.random() * 26))}-${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`;
    m.model.repaint(b, reg);
    const num = 100 + Math.floor(Math.random() * 899);
    m.call = `${b.name} ${num}`;
    m.spoken = `${b.name} ${String(num).split('').join(' ')}`;
    m.kind = kind;
    m.path = this.route(kind);
    m.i = 1;
    m.pos.set(m.path[0].x, m.path[0].y, m.path[0].z);
    m.speed = m.path[0].v;
    m.yaw = Math.atan2(-(m.path[1].x - m.path[0].x), -(m.path[1].z - m.path[0].z));
    m.gear = kind === 'arrival' ? 1 : 1;
    m.wait = kind === 'turnaround' ? T.turnaroundSeconds : 0;
    m.active = true;
    m.model.root.visible = true;
    if (kind === 'turnaround') this.standBusy = true;
  }

  /** Waypoints in the airport frame for each movement type and the runway in use. */
  private route(kind: Mover['kind'], fromStand = false): WP[] {
    const d = this.flow === 'east' ? 1 : -1; // direction of travel along x on the runway
    const end = T.runwayHalfLength;
    const thr = -d * end; // landing threshold
    const exitX = d * T.exitX; // rapid exit near the far end
    const conn = d * T.connectorX; // runway end connector (JE for east, JW for west) used by arrivals
    const depConn = -d * T.connectorX; // departures line up at the start of the runway
    const J = T.taxiwayZ;
    const AP = T.apronTaxiX;
    const st = T.stand;
    if (kind === 'arrival' || kind === 'turnaround') {
      const far = T.approachKm * 1000;
      const td = thr + d * T.touchdownM;
      const pts: WP[] = [
        { x: td - d * far, y: far * TAN3, z: 0, v: 72, gear: 1 },
        { x: td - d * 1500, y: 1500 * TAN3, z: 0, v: 70, gear: 1 },
        { x: td - d * 150, y: 10, z: 0, v: 68, gear: 1 },
        { x: td, y: 0, z: 0, v: 62, gear: 1 },
        { x: td + d * 900, y: 0, z: 0, v: 20 },
        { x: exitX, y: 0, z: 0, v: 9 },
        { x: conn, y: 0, z: -T.connectorZ, v: 6 },
        { x: conn, y: 0, z: J, v: 6 },
      ];
      if (kind === 'turnaround') {
        pts.push({ x: AP, y: 0, z: J, v: 9 }, { x: AP, y: 0, z: st.taxiZ, v: 5 }, { x: st.x, y: 0, z: st.taxiZ, v: 4 }, { x: st.x, y: 0, z: st.parkZ, v: 1.5 });
      } else {
        pts.push({ x: conn - d * T.despawnTaxiM, y: 0, z: J, v: 9 });
      }
      return pts;
    }
    // departure: from the stand (after a turnaround) or from a remote apron at the far end
    const start: WP[] = fromStand
      ? [{ x: st.x, y: 0, z: st.parkZ, v: 0 }, { x: st.x, y: 0, z: st.taxiZ, v: 1.5 }, { x: AP, y: 0, z: st.taxiZ, v: 5 }, { x: AP, y: 0, z: J, v: 6 }]
      : [{ x: depConn + d * T.despawnTaxiM, y: 0, z: J, v: 8 }];
    return [
      ...start,
      { x: depConn, y: 0, z: J, v: 6 },
      { x: depConn, y: 0, z: -T.connectorZ, v: 5 },
      { x: -d * end, y: 0, z: 0, v: 3 },
      { x: -d * end + d * 1500, y: 0, z: 0, v: 76 },
      { x: -d * end + d * 4000, y: 300, z: 0, v: 85 },
      { x: -d * end + d * 14000, y: 1600, z: 0, v: 110 },
    ];
  }

  update(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed > this.nextAt) {
      this.nextAt = this.elapsed + T.intervalSeconds * (0.6 + Math.random() * 0.8);
      if (!this.playerOnRunway) {
        const r = Math.random();
        if (!this.standBusy && r < 0.35) this.spawn('turnaround');
        else this.spawn(r < 0.68 ? 'arrival' : 'departure');
      }
    }
    for (const m of this.pool) if (m.active) this.step(m, dt);
  }

  private step(m: Mover, dt: number): void {
    if (m.wait > 0 && m.i >= m.path.length) {
      // parked at the stand: engines idle down, then the same aircraft departs
      m.wait -= dt;
      m.n1 = Math.max(0, m.n1 - dt * 0.05);
      if (m.wait <= 0) {
        m.kind = 'departure';
        m.path = this.route('departure', true);
        m.i = 1;
        m.speed = 0;
      }
      this.pose(m, dt);
      return;
    }
    const wp = m.path[m.i];
    if (!wp) {
      if (m.kind === 'turnaround') {
        m.wait = Math.max(m.wait, 1);
        return;
      }
      m.active = false;
      m.model.root.visible = false;
      if (m.kind === 'departure' && m.path[0].v === 0) this.standBusy = false;
      return;
    }
    // runway incursion protection: arrivals go around if you are on the runway
    if (this.playerOnRunway && m.kind !== 'departure' && m.pos.y > 5 && m.pos.y < 200 && m.i <= 3) {
      const d = this.flow === 'east' ? 1 : -1;
      m.path = [{ x: m.pos.x + d * 6000, y: 900, z: 0, v: 85 }];
      m.i = 0;
      m.kind = 'departure';
    }
    // hold short of the runway while you are on it
    const holding = this.playerOnRunway && m.kind === 'departure' && Math.abs(wp.z) < 1 && m.pos.y < 1 && Math.abs(m.pos.z) > 20;
    const target = holding ? 0 : wp.v;
    const acc = m.speed < target ? (m.pos.y < 1 && target > 30 ? 2.3 : 1.2) : m.pos.y < 1 && m.speed > 25 ? 2.6 : 1.5;
    m.speed += THREE.MathUtils.clamp(target - m.speed, -acc * dt, acc * dt);
    const to = new THREE.Vector3(wp.x, wp.y, wp.z).sub(m.pos);
    const dist = to.length();
    const step = m.speed * dt;
    if (step >= dist || dist < 0.5) {
      m.pos.set(wp.x, wp.y, wp.z);
      m.i++;
      // radio: landing clearance on short final, take-off clearance when lined up
      const rw = this.flow === 'east' ? '08R' : '26L';
      const rwSpoken = this.flow === 'east' ? 'zero eight right' : 'two six left';
      if (m.kind !== 'departure' && m.i === 2) this.onRadio?.(`${m.call}, runway ${rw} cleared to land.`, `${m.spoken}, runway ${rwSpoken}, cleared to land`);
      if (m.kind === 'departure' && wp.y === 0 && wp.z === 0 && wp.v === 3) this.onRadio?.(`${m.call}, runway ${rw} cleared for take-off.`, `${m.spoken}, runway ${rwSpoken}, cleared for take-off`);
    } else m.pos.addScaledVector(to.divideScalar(dist), step);
    if (wp.gear !== undefined || m.pos.y < 1) m.gear = 1;
    else if (m.pos.y > 120) m.gear = Math.max(0, m.gear - dt / 8);
    const climbing = m.kind === 'departure' && m.pos.y > 0.5;
    m.n1 = THREE.MathUtils.damp(m.n1, climbing || (m.kind === 'departure' && m.speed > 15 && m.pos.y < 1 && wp.v > 30) ? 0.92 : m.pos.y > 1 ? 0.45 : 0.25, 1.5, dt);
    // heading follows the path; pitch from the flight-path angle plus attitude
    const pushback = m.kind === 'departure' && m.path[0].v === 0 && m.i === 1;
    if (dist > 0.5 && !pushback) {
      const h = Math.atan2(-(wp.x - m.pos.x), -(wp.z - m.pos.z));
      let dh = h - m.yaw;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      m.yaw += THREE.MathUtils.clamp(dh, -dt * 0.6, dt * 0.6);
      const horiz = Math.hypot(wp.x - m.pos.x, wp.z - m.pos.z);
      const gamma = Math.atan2(wp.y - m.pos.y, Math.max(1, horiz));
      const attitude = m.pos.y > 0.5 ? (m.kind === 'departure' ? 0.12 : 0.07) : 0;
      m.pitch = THREE.MathUtils.damp(m.pitch, gamma + attitude, 2, dt);
    }
    this.pose(m, dt);
  }

  private pose(m: Mover, dt: number): void {
    m.model.root.position.copy(m.pos);
    m.model.root.rotation.set(m.pitch, m.yaw, 0);
    m.model.animate(m.gear, [m.n1, m.n1], 0, dt);
    m.model.lights.beacon = true;
    m.model.lights.strobe = m.pos.y > 0.5 || m.speed > 20;
  }

  /** Light halos follow day/night. */
  lights(t: number, night: number): void {
    for (const m of this.pool) if (m.active) m.model.lights.update(t, night);
  }

  /** The loudest nearby jet for the audio: distance (m) and thrust 0..1. */
  loudest(cam: THREE.Vector3): { dist: number; thrust: number } {
    let best = { dist: Infinity, thrust: 0 };
    for (const m of this.pool) {
      if (!m.active) continue;
      const w = this.airport.toWorld(m.pos.x, m.pos.y, m.pos.z);
      const dist = w.distanceTo(cam);
      if (m.n1 / Math.max(1, dist / 100) > best.thrust / Math.max(1, best.dist / 100)) best = { dist, thrust: m.n1 };
    }
    return best;
  }

  setActive(on: boolean): void {
    if (!on) for (const m of this.pool) {
      m.active = false;
      m.model.root.visible = false;
    }
    this.standBusy = false;
  }
}
