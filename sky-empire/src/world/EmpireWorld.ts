import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import egkk from '@data/airports/egkk.json';
import hqData from '@data/economy/hq.json';
import empireData from '@data/economy/empire.json';
import type { Physics } from './Physics';
import type { Airport } from './Airport';
import type { HqDept, Snapshot } from '../economy/types';
import { AIRPORTS } from '../economy/Sim';
import { makeCarMesh, type CarStyle } from '../vehicles/Car';

type Rect = { x0: number; x1: number; z0: number; z1: number };
const H = 4; // storey height
const T = 0.3; // wall thickness

/** Collects boxes per material (merged into one mesh each) plus cuboid colliders, in the airport frame. */
class Kit {
  private geos = new Map<THREE.Material, THREE.BufferGeometry[]>();
  readonly loose: THREE.Object3D[] = [];
  readonly boxes: { c: THREE.Vector3; h: THREE.Vector3; rot: number }[] = [];

  box(mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, collide = true): void {
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    const d = Math.abs(z1 - z0);
    if (w < 1e-3 || h < 1e-3 || d < 1e-3) return;
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(mat, new THREE.BoxGeometry(w, h, d).translate(c.x, c.y, c.z));
    if (collide) this.boxes.push({ c, h: new THREE.Vector3(w / 2, h / 2, d / 2), rot: 0 });
  }

  add(mat: THREE.Material, g: THREE.BufferGeometry): void {
    const list = this.geos.get(mat) ?? [];
    list.push(g.index ? g.toNonIndexed() : g);
    this.geos.set(mat, list);
  }

  /** A wall along x at z, from x0 to x1, with door gaps [a, b] (full height openings up to `door` m). */
  wallX(mat: THREE.Material, z: number, x0: number, x1: number, gaps: [number, number][] = [], h = H, door = 2.6): void {
    let x = Math.min(x0, x1);
    const end = Math.max(x0, x1);
    for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
      this.box(mat, x, a, 0, h, z - T / 2, z + T / 2);
      this.box(mat, a, b, door, h, z - T / 2, z + T / 2);
      x = b;
    }
    this.box(mat, x, end, 0, h, z - T / 2, z + T / 2);
  }

  wallZ(mat: THREE.Material, x: number, z0: number, z1: number, gaps: [number, number][] = [], h = H, door = 2.6): void {
    let z = Math.min(z0, z1);
    const end = Math.max(z0, z1);
    for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
      this.box(mat, x - T / 2, x + T / 2, 0, h, z, a);
      this.box(mat, x - T / 2, x + T / 2, door, h, a, b);
      z = b;
    }
    this.box(mat, x - T / 2, x + T / 2, 0, h, z, end);
  }

  mesh(o: THREE.Object3D): void {
    this.loose.push(o);
  }

  build(group: THREE.Group): void {
    for (const [mat, list] of this.geos) {
      const g = mergeGeometries(list);
      list.forEach((x) => x.dispose());
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    for (const o of this.loose) group.add(o);
  }
}

const canvasTex = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
};

/**
 * M7 buildings next to your base: the airline headquarters (rooms unlock with HQ department levels,
 * a CEO office with a trophy cabinet) and your home estate (grows with your home tier, with a garage
 * showing your cars). Rebuilt when the relevant state changes.
 */
export class EmpireWorld {
  readonly group = new THREE.Group();
  private hqGroup = new THREE.Group();
  private homeGroup = new THREE.Group();
  private colliders: { hq: RAPIER.Collider[]; home: RAPIER.Collider[] } = { hq: [], home: [] };
  private hqSig = '';
  private homeSig = '';
  private liveMap: { tex: THREE.CanvasTexture; t: number } | null = null;
  private disposables: { dispose(): void }[] = [];
  private active = true;
  private M = {
    // interiors get a little emissive warmth: cheap stand-in for indoor lights on integrated GPUs
    wall: new THREE.MeshStandardMaterial({ color: '#efe9df', roughness: 0.9, emissive: '#8a8070', emissiveIntensity: 0.9, envMapIntensity: 0.35 }),
    ceiling: new THREE.MeshStandardMaterial({ color: '#f4f4f2', roughness: 0.9, emissive: '#d8d4cc', emissiveIntensity: 0.7 }),
    floor: new THREE.MeshStandardMaterial({ color: '#d6cfc3', roughness: 0.75, emissive: '#4a4238', emissiveIntensity: 0.8, envMapIntensity: 0.3 }),
    carpet: new THREE.MeshStandardMaterial({ color: '#6a5a4c', roughness: 1, emissive: '#2e2a26', emissiveIntensity: 0.8, envMapIntensity: 0.3 }),
    glass: new THREE.MeshStandardMaterial({ color: '#26394a', roughness: 0.06, metalness: 0.7 }),
    frame: new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.5, metalness: 0.6 }),
    wood: new THREE.MeshStandardMaterial({ color: '#6b4b32', roughness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: '#1c1f24', roughness: 0.6 }),
    fabric: new THREE.MeshStandardMaterial({ color: '#8a8f98', roughness: 1 }),
    leather: new THREE.MeshStandardMaterial({ color: '#4a2f22', roughness: 0.6 }),
    gold: new THREE.MeshStandardMaterial({ color: '#d4a537', roughness: 0.3, metalness: 1, emissive: '#6a4c10', emissiveIntensity: 0.8 }),
    screen: new THREE.MeshBasicMaterial({ color: '#0d1b2a' }),
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.4, 2.2) }),
    grass: new THREE.MeshStandardMaterial({ color: '#4f7a3a', roughness: 1 }),
    hedge: new THREE.MeshStandardMaterial({ color: '#2f5228', roughness: 1 }),
    asphalt: new THREE.MeshStandardMaterial({ color: '#3a3c40', roughness: 0.95 }),
    stone: new THREE.MeshStandardMaterial({ color: '#d8d0c0', roughness: 0.8 }),
    water: new THREE.MeshStandardMaterial({ color: '#2c8fbf', roughness: 0.05, metalness: 0.2 }),
    roof: new THREE.MeshStandardMaterial({ color: '#5a4a44', roughness: 0.9 }),
    white: new THREE.MeshStandardMaterial({ color: '#f6f6f4', roughness: 0.7 }),
    brand: new THREE.MeshStandardMaterial({ color: '#1b2a55', roughness: 0.5 }),
    accent: new THREE.MeshStandardMaterial({ color: '#e0a526', roughness: 0.4, metalness: 0.3 }),
    trunk: new THREE.MeshStandardMaterial({ color: '#5b4030', roughness: 1 }),
    leaves: new THREE.MeshStandardMaterial({ color: '#3d6b30', roughness: 1 }),
  };

  constructor(private physics: Physics, private airport: Airport) {
    this.group.add(this.hqGroup, this.homeGroup);
    airport.group.add(this.group);
  }

  /** Rebuild the parts whose state changed. */
  update(s: Snapshot): void {
    const st = s.empire.state;
    const fleetTypes = [...new Set(s.fleet.map((a) => a.typeId))].slice(0, 6);
    const hqSig = JSON.stringify([st.hq, Object.keys(st.achievements).length, s.airline.name, s.airline.primary, s.airline.accent, fleetTypes]);
    if (hqSig !== this.hqSig) {
      this.hqSig = hqSig;
      this.buildHQ(s);
    }
    const homeSig = JSON.stringify([st.homeTier, st.cars.map((c) => [c.id, c.model, c.color]), st.activeCar, st.yachts.length]);
    if (homeSig !== this.homeSig) {
      this.homeSig = homeSig;
      this.buildHome(s);
    }
  }

  /** Windows glow at night. */
  setNight(n: number): void {
    this.M.glass.emissive.set('#ffcf8a');
    this.M.glass.emissiveIntensity = n * 0.7;
  }

  /** Hide and disable collisions while you are away at another airport. */
  setActive(on: boolean): void {
    this.group.visible = on;
    for (const list of Object.values(this.colliders)) for (const c of list) c.setEnabled(on);
    this.active = on;
  }

  /** Redraw the ops-room flight map (call about once a second when near the HQ). */
  tick(s: Snapshot): void {
    if (!this.liveMap || performance.now() - this.liveMap.t < 1000) return;
    this.liveMap.t = performance.now();
    drawFlightMap(this.liveMap.tex.image as HTMLCanvasElement, s, true);
    this.liveMap.tex.needsUpdate = true;
  }

  /** Spawn points in world space. */
  spawn(id: 'hq' | 'home' | 'garage'): { pos: THREE.Vector3; heading: number } {
    const hq = egkk.empire.hq;
    const home = egkk.empire.home;
    const p = id === 'hq' ? [(hq.min[0] + -140) / 2 + 3, 0.05, hq.max[1] + 6] : id === 'home' ? [home.center[0], 0.05, home.center[1] + 60] : [home.center[0] + 26, 0.05, home.center[1] + 50];
    return { pos: this.airport.toWorld(p[0], p[1], p[2]), heading: this.airport.toWorldHeading(0) };
  }

  /** World position and heading for the car to wait at home. */
  carSpot(): { pos: THREE.Vector3; heading: number } {
    const home = egkk.empire.home;
    return { pos: this.airport.toWorld(home.center[0] + 8, 0, home.center[1] + 70), heading: this.airport.rotation };
  }

  isNearHQ(p: THREE.Vector3): boolean {
    const hq = egkk.empire.hq;
    const c = this.airport.toWorld((hq.min[0] + hq.max[0]) / 2, 0, (hq.min[1] + hq.max[1]) / 2);
    return Math.hypot(p.x - c.x, p.z - c.z) < 120;
  }

  // ------------------------------------------------------------------ colliders
  private makeColliders(kit: Kit, key: 'hq' | 'home'): void {
    const W = this.physics.world;
    for (const c of this.colliders[key]) W.removeCollider(c, false);
    this.colliders[key] = [];
    this.group.updateMatrixWorld(true);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.airport.rotation);
    for (const b of kit.boxes) {
      if (b.h.y < 0.2 && b.c.y < 0.2) continue; // floors: the ground plane already carries you
      const p = this.airport.toWorld(b.c.x, b.c.y, b.c.z);
      const col = W.createCollider(this.physics.R.ColliderDesc.cuboid(b.h.x, b.h.y, b.h.z).setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
      col.setEnabled(this.active);
      this.colliders[key].push(col);
    }
  }

  private clear(g: THREE.Group): void {
    for (const o of [...g.children]) {
      g.remove(o);
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mt of mats) if (!Object.values(this.M).includes(mt as never)) {
            (mt as THREE.MeshBasicMaterial).map?.dispose();
            mt.dispose();
          }
        }
      });
    }
  }

  // ------------------------------------------------------------------ headquarters
  private buildHQ(s: Snapshot): void {
    this.clear(this.hqGroup);
    this.liveMap = null;
    const st = s.empire.state;
    const M = this.M;
    M.brand.color.set(s.airline.primary);
    M.accent.color.set(s.airline.accent);
    const k = new Kit();
    const { min, max } = egkk.empire.hq;
    const [x0, z0] = min;
    const [x1, z1] = max;
    const tier = hqData.tiers[st.hq.tier];
    const floors = tier.floors;
    // forecourt, floor slab, ceiling
    k.box(M.stone, x0 - 12, x1 + 12, -0.05, 0.02, z1, z1 + 30, false);
    k.box(M.floor, x0, x1, 0, 0.04, z0, z1, false);
    // exterior: ground floor glass with the entrance (south, lobby), mullions; upper floors as a glass shell
    const xLobby = -140;
    const entrance: [number, number] = [x0 + 8, x0 + 16];
    k.wallX(M.glass, z1, x0, x1, [entrance], H, 3.2);
    k.wallX(M.glass, z0, x0, x1, [], H);
    k.wallZ(M.glass, x0, z0, z1, [], H);
    k.wallZ(M.glass, x1, z0, z1, [], H);
    for (let x = x0; x <= x1; x += 6) for (const z of [z0, z1]) k.box(M.frame, x - 0.12, x + 0.12, 0, H, z - 0.25, z + 0.25, false);
    k.box(M.ceiling, x0, x1, H - 0.05, H + 0.3, z0, z1, false); // ceiling slab
    for (let x = x0 + 4; x < x1; x += 8) for (let z = z0 + 4; z < z1; z += 8) k.box(M.lamp, x - 0.6, x + 0.6, H - 0.07, H - 0.05, z - 0.6, z + 0.6, false);
    const setback = floors > 8;
    for (let f = 1; f < floors; f++) {
      const inset = setback && f >= 8 ? 16 : 0;
      const zi = setback && f >= 8 ? 8 : 0;
      const y = f * H;
      k.box(M.glass, x0 + inset, x1 - inset, y + 0.3, y + H, z0 + zi, z1 - zi, false);
      k.box(M.frame, x0 + inset - 0.2, x1 - inset + 0.2, y, y + 0.3, z0 + zi - 0.2, z1 - zi + 0.2, false);
    }
    const topY = floors * H;
    const inset = setback ? 16 : 0;
    const zi = setback ? 8 : 0;
    k.box(M.frame, x0 + inset - 0.3, x1 - inset + 0.3, topY, topY + 1.2, z0 + zi - 0.3, z1 - zi + 0.3, false);
    if (st.hq.tier === 2) k.box(M.frame, -112, -108, topY + 1.2, topY + 26, -842, -838, false); // spire
    // brand sign on the facade (south), near the top
    const sign = canvasTex(1024, 192, (g) => {
      g.fillStyle = s.airline.primary;
      g.fillRect(0, 0, 1024, 192);
      g.fillStyle = '#ffffff';
      g.font = '800 110px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.airline.name.toUpperCase(), 512, 100, 980);
    });
    const signW = Math.min(60, (x1 - x0 - 2 * inset) * 0.8);
    const signM = new THREE.Mesh(new THREE.PlaneGeometry(signW, signW * 0.1875), new THREE.MeshBasicMaterial({ map: sign }));
    signM.position.set((x0 + x1) / 2, topY - 3, z1 - zi + 0.35);
    k.mesh(signM);
    // interior walls: lobby | corridor | rooms
    const zc0 = -843;
    const zc1 = -837;
    k.wallZ(M.wall, xLobby, z0, z1, [[zc0 + 0.5, zc1 - 0.5]]);
    k.wallX(M.wall, zc0, x0, xLobby, [[-158, -154]]); // CEO office door from the lobby
    const rw = (x1 - xLobby) / 5;
    const depts = Object.keys(hqData.departments) as HqDept[];
    const north = depts.slice(0, 5);
    const south = depts.slice(5);
    const doorGaps = (i: number): [number, number] => [xLobby + rw * i + rw / 2 - 1.5, xLobby + rw * i + rw / 2 + 1.5];
    k.wallX(M.wall, zc0, xLobby, x1, north.map((_, i) => doorGaps(i)));
    k.wallX(M.wall, zc1, xLobby, x1, south.map((_, i) => doorGaps(i)));
    for (let i = 1; i < 5; i++) {
      k.wallZ(M.wall, xLobby + rw * i, z0, zc0);
      k.wallZ(M.wall, xLobby + rw * i, zc1, z1);
    }
    k.box(M.carpet, xLobby, x1, 0.04, 0.06, zc0, zc1, false);
    const rooms: [HqDept, Rect, 1 | -1][] = [
      ...north.map((d, i) => [d, { x0: xLobby + rw * i, x1: xLobby + rw * (i + 1), z0, z1: zc0 }, -1] as [HqDept, Rect, 1 | -1]),
      ...south.map((d, i) => [d, { x0: xLobby + rw * i, x1: xLobby + rw * (i + 1), z0: zc1, z1 }, 1] as [HqDept, Rect, 1 | -1]),
    ];
    for (const [d, r, side] of rooms) {
      const lvl = st.hq.depts[d] ?? 0;
      const doorZ = side < 0 ? zc0 : zc1;
      const g = doorGaps(rooms.filter((x) => x[2] === side).findIndex((x) => x[0] === d));
      // name plaque above the door, on the corridor side
      const plaque = canvasTex(512, 96, (c) => {
        c.fillStyle = lvl ? '#1c1f24' : '#4a4d52';
        c.fillRect(0, 0, 512, 96);
        c.fillStyle = lvl ? '#ffd981' : '#b9bcc0';
        c.font = '700 34px "Segoe UI", sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(hqData.departments[d].name, 256, 36, 490);
        c.font = '24px "Segoe UI", sans-serif';
        c.fillText(lvl ? `Level ${lvl}` : 'Locked: upgrade in Headquarters', 256, 74, 490);
      });
      const pm = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.68), new THREE.MeshBasicMaterial({ map: plaque }));
      pm.position.set((g[0] + g[1]) / 2, 3.15, doorZ + -side * 0.17);
      if (side < 0) pm.rotation.y = 0;
      else pm.rotation.y = Math.PI;
      k.mesh(pm);
      if (!lvl) {
        k.box(M.wood, g[0], g[1], 0, 2.6, doorZ - 0.06, doorZ + 0.06); // closed door
        continue;
      }
      k.box(M.carpet, r.x0, r.x1, 0.04, 0.06, r.z0, r.z1, false);
      this.furnish(k, d, lvl, r, side, s);
    }
    // lobby: reception desk, logo wall, sofas, plants
    const lobbyLogo = canvasTex(1024, 512, (g) => {
      g.fillStyle = s.airline.primary;
      g.fillRect(0, 0, 1024, 512);
      g.fillStyle = s.airline.accent;
      g.beginPath();
      g.arc(512, 190, 110, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = '800 96px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText(s.airline.name, 512, 420, 980);
    });
    const ll = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), new THREE.MeshBasicMaterial({ map: lobbyLogo }));
    ll.position.set(xLobby - 0.17, 2.1, (zc1 + z1) / 2 + 2);
    ll.rotation.y = -Math.PI / 2;
    k.mesh(ll);
    k.box(M.white, -152, -144, 0, 1.1, -826, -824);
    k.box(M.dark, -152, -144, 1.1, 1.16, -826.3, -823.7);
    for (const [sx, sz] of [[-166, -828], [-166, -818]]) this.sofa(k, sx, sz, 0, M.fabric);
    for (const [px, pz] of [[-168.5, -812], [-141.5, -812], [-168.5, -835]]) this.plant(k, px, pz);
    // CEO office (north of the lobby)
    this.ceoOffice(k, { x0, x1: xLobby, z0, z1: zc0 }, s);
    k.build(this.hqGroup);
    this.makeColliders(k, 'hq');
  }

  private sofa(k: Kit, x: number, z: number, rotQuarter: number, mat: THREE.Material): void {
    const along = rotQuarter % 2 === 0;
    const w = 2.4;
    const d = 0.9;
    const [hx, hz] = along ? [w / 2, d / 2] : [d / 2, w / 2];
    k.box(mat, x - hx, x + hx, 0, 0.45, z - hz, z + hz);
    const back = rotQuarter === 0 ? [x - hx, x + hx, z + hz - 0.2, z + hz] : rotQuarter === 2 ? [x - hx, x + hx, z - hz, z - hz + 0.2] : rotQuarter === 1 ? [x - hx, x - hx + 0.2, z - hz, z + hz] : [x + hx - 0.2, x + hx, z - hz, z + hz];
    k.box(mat, back[0], back[1], 0.45, 0.9, back[2], back[3], false);
  }

  private plant(k: Kit, x: number, z: number): void {
    k.box(this.M.dark, x - 0.3, x + 0.3, 0, 0.6, z - 0.3, z + 0.3);
    k.add(this.M.leaves, new THREE.SphereGeometry(0.6, 8, 6).translate(x, 1.3, z));
  }

  private desk(k: Kit, x: number, z: number, w = 1.6, d = 0.8, screens = 1, facing: 1 | -1 = 1): void {
    const M = this.M;
    k.box(M.white, x - w / 2, x + w / 2, 0.72, 0.76, z - d / 2, z + d / 2);
    k.box(M.frame, x - w / 2 + 0.05, x - w / 2 + 0.1, 0, 0.72, z - d / 2 + 0.05, z + d / 2 - 0.05, false);
    k.box(M.frame, x + w / 2 - 0.1, x + w / 2 - 0.05, 0, 0.72, z - d / 2 + 0.05, z + d / 2 - 0.05, false);
    for (let i = 0; i < screens; i++) {
      const sx = x + (i - (screens - 1) / 2) * 0.62;
      const sz = z - facing * (d / 2 - 0.12);
      k.box(M.dark, sx - 0.28, sx + 0.28, 0.85, 1.2, sz - 0.02, sz + 0.02, false);
      k.box(M.screen, sx - 0.26, sx + 0.26, 0.87, 1.18, sz + facing * 0.025, sz + facing * 0.03, false);
    }
    k.box(M.fabric, x - 0.25, x + 0.25, 0, 0.5, z + facing * (d / 2 + 0.45) - 0.25, z + facing * (d / 2 + 0.45) + 0.25, false);
  }

  /** Room furniture per department. `side` is -1 for rooms north of the corridor (door on their south wall). */
  private furnish(k: Kit, d: HqDept, lvl: number, r: Rect, side: 1 | -1, s: Snapshot): void {
    const M = this.M;
    const cx = (r.x0 + r.x1) / 2;
    const back = side < 0 ? r.z0 + 0.2 : r.z1 - 0.2; // wall away from the corridor
    const dir = side < 0 ? 1 : -1; // from the back wall into the room
    const wallScreen = (tex: THREE.Texture, w: number, h: number, y = 2.1) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      m.position.set(cx, y, back + dir * 0.02);
      m.rotation.y = dir > 0 ? 0 : Math.PI;
      k.mesh(m);
    };
    const rows = (n: number, startOff: number, gap: number, screens: number) => {
      for (let i = 0; i < n; i++) for (const ox of [-4.5, 0, 4.5]) this.desk(k, cx + ox, back + dir * (startOff + i * gap), 1.8, 0.8, screens, (-dir) as 1 | -1);
    };
    switch (d) {
      case 'ops': {
        const c = document.createElement('canvas');
        c.width = 1024;
        c.height = 512;
        drawFlightMap(c, s, true);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        this.liveMap = { tex, t: 0 };
        wallScreen(tex, 14, 7, 2.0);
        rows(Math.min(3, lvl + 1), 5, 3, 3);
        break;
      }
      case 'revenue':
        wallScreen(canvasTex(1024, 512, (g) => drawBars(g, s)), 10, 5);
        rows(Math.min(3, lvl + 1), 4.5, 3, 2);
        break;
      case 'network': {
        const tex = canvasTex(1024, 512, (g) => drawFlightMap(g.canvas, s, false));
        k.box(M.wood, cx - 4, cx + 4, 0, 0.9, back + dir * 9 - 2.2, back + dir * 9 + 2.2);
        const top = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 3.8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
        top.position.set(cx, 0.91, back + dir * 9);
        k.mesh(top);
        wallScreen(canvasTex(1024, 512, (g) => drawBars(g, s)), 8, 4);
        break;
      }
      case 'training':
        for (let i = 0; i < 3; i++) for (const ox of [-5, -2.5, 0, 2.5]) this.desk(k, cx + ox - 2, back + dir * (4 + i * 2.6), 1.6, 0.6, 0, (-dir) as 1 | -1);
        // full-motion simulator: a cab on six legs
        k.box(M.white, cx + 4, cx + 8, 1.6, 4.0 - 0.2, back + dir * 12 - 2, back + dir * 12 + 2);
        for (const [ox, oz] of [[4.3, -1.6], [7.7, -1.6], [6, 1.7]]) k.box(M.frame, cx + ox - 0.1, cx + ox + 0.1, 0, 1.6, back + dir * 12 + oz - 0.1, back + dir * 12 + oz + 0.1, false);
        k.box(M.brand, cx + 4.02, cx + 7.98, 2.6, 2.9, back + dir * 12 - 2.02, back + dir * 12 + 2.02, false);
        break;
      case 'maintenance':
        k.add(M.frame, new THREE.CylinderGeometry(1.1, 0.9, 3.2, 20).rotateX(Math.PI / 2).translate(cx, 1.3, back + dir * 8));
        k.box(M.dark, cx - 1.8, cx + 1.8, 0, 0.2, back + dir * 8 - 2, back + dir * 8 + 2);
        for (const ox of [-6, 6]) k.box(M.frame, cx + ox - 1.5, cx + ox + 1.5, 0, 2.4, back + dir * 0.4 - 0.3, back + dir * 0.4 + 0.3);
        rows(1, 13, 3, 2);
        break;
      case 'pr': {
        const bd = canvasTex(1024, 512, (g) => {
          g.fillStyle = '#ffffff';
          g.fillRect(0, 0, 1024, 512);
          g.font = '700 40px "Segoe UI", sans-serif';
          for (let y = 0; y < 6; y++) for (let x = 0; x < 4; x++) {
            g.fillStyle = (x + y) % 2 ? s.airline.primary : s.airline.accent;
            g.fillText(s.airline.name, x * 260 + (y % 2) * 120 - 40, y * 90 + 60);
          }
        });
        wallScreen(bd, 10, 5, 2.4);
        k.box(M.wood, cx - 0.5, cx + 0.5, 0, 1.15, back + dir * 2.5 - 0.35, back + dir * 2.5 + 0.35);
        for (let i = 0; i < 3 + lvl; i++) for (let j = -5; j <= 5; j += 1.2) k.box(M.fabric, cx + j - 0.25, cx + j + 0.25, 0, 0.48, back + dir * (6 + i * 1.6) - 0.25, back + dir * (6 + i * 1.6) + 0.25, false);
        break;
      }
      case 'cargo':
        rows(Math.min(2, lvl), 4.5, 3, 2);
        for (let i = 0; i < 2 + lvl * 2; i++) k.box(M.frame, cx - 7 + (i % 4) * 2.1, cx - 5.4 + (i % 4) * 2.1, 0, 1.6, back + dir * (12 + Math.floor(i / 4) * 2.2) - 0.8, back + dir * (12 + Math.floor(i / 4) * 2.2) + 0.8);
        break;
      case 'charter':
        this.sofa(k, cx - 4, back + dir * 5, dir > 0 ? 0 : 2, M.leather);
        this.sofa(k, cx + 4, back + dir * 5, dir > 0 ? 0 : 2, M.leather);
        k.box(M.wood, cx - 1, cx + 1, 0, 0.42, back + dir * 7 - 0.6, back + dir * 7 + 0.6);
        k.box(M.wood, cx - 6, cx + 6, 0, 1.1, back + dir * 13 - 0.4, back + dir * 13 + 0.4);
        k.box(M.gold, cx - 6, cx + 6, 1.1, 1.14, back + dir * 13 - 0.45, back + dir * 13 + 0.45, false);
        for (const ox of [-7.5, 7.5]) this.plant(k, cx + ox, back + dir * 2);
        break;
      case 'ir': {
        const chart = canvasTex(1024, 512, (g) => drawShare(g, s));
        wallScreen(chart, 8, 4);
        k.box(M.wood, cx - 5.5, cx + 5.5, 0.72, 0.8, back + dir * 9 - 1.4, back + dir * 9 + 1.4);
        k.box(M.dark, cx - 4.5, cx + 4.5, 0, 0.72, back + dir * 9 - 0.6, back + dir * 9 + 0.6);
        for (let j = -4.5; j <= 4.5; j += 1.5) for (const oz of [-2, 2]) k.box(M.leather, cx + j - 0.3, cx + j + 0.3, 0, 1.1, back + dir * 9 + oz - 0.3, back + dir * 9 + oz + 0.3, false);
        break;
      }
      case 'legal':
        for (let i = -3; i <= 3; i++) {
          k.box(M.wood, cx + i * 2.4 - 1.1, cx + i * 2.4 + 1.1, 0, 2.6, back + dir * 0.35 - 0.3, back + dir * 0.35 + 0.3);
          for (let sh = 0; sh < 5; sh++) k.box(sh % 2 ? M.brand : M.leather, cx + i * 2.4 - 1, cx + i * 2.4 + 1, 0.15 + sh * 0.5, 0.45 + sh * 0.5, back + dir * 0.65 - 0.02, back + dir * 0.65 + 0.02, false);
        }
        rows(Math.min(2, lvl), 6, 3.5, 1);
        break;
    }
  }

  private ceoOffice(k: Kit, r: Rect, s: Snapshot): void {
    const M = this.M;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    // big desk facing the door, chair, sofa corner
    k.box(M.wood, cx - 2, cx + 2, 0.74, 0.8, cz - 4.5, cz - 3.3);
    k.box(M.dark, cx - 1.9, cx + 1.9, 0, 0.74, cz - 4.4, cz - 4.2);
    k.box(M.leather, cx - 0.4, cx + 0.4, 0, 1.3, cz - 5.8, cz - 5.1);
    this.sofa(k, cx + 8, cz + 6, 2, M.leather);
    k.box(M.wood, cx + 7, cx + 9, 0, 0.42, cz + 3.6, cz + 4.6);
    k.box(M.carpet, r.x0, r.x1, 0.04, 0.06, r.z0, r.z1, false);
    // model aircraft of your fleet on the desk
    const types = [...new Set(s.fleet.map((a) => a.typeId))].slice(0, 6);
    types.forEach((t, i) => {
      const scale = 0.012;
      const x = cx - 1.6 + i * 0.6;
      const z = cz - 3.9;
      const g = new THREE.Group();
      const fus = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.38, 4, 8).rotateX(Math.PI / 2), M.white);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.008, 0.08), M.white);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.09, 0.06), M.brand);
      fin.position.set(0, 0.06, 0.18);
      g.add(fus, wing, fin);
      g.position.set(x, 0.95, z);
      g.rotation.y = 0.5;
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.03, 0.15, 8), M.frame);
      stand.position.set(x, 0.87, z);
      k.mesh(g);
      k.mesh(stand);
      void scale;
      void t;
    });
    // trophy cabinet along the west wall: one cup per achievement
    const n = Object.keys(s.empire.state.achievements).length;
    const xw = r.x0 + 0.5;
    // open display case: back panel, sides, lit glass shelves
    k.box(M.wood, xw - 0.3, xw - 0.22, 0, 2.6, cz - 8, cz + 8);
    for (const z of [cz - 8, cz + 8]) k.box(M.wood, xw - 0.3, xw + 0.3, 0, 2.6, z - 0.05, z + 0.05);
    k.box(M.wood, xw - 0.3, xw + 0.3, 0, 0.45, cz - 8, cz + 8);
    k.box(M.wood, xw - 0.3, xw + 0.3, 2.55, 2.6, cz - 8, cz + 8);
    for (let sh = 0; sh < 4; sh++) {
      k.box(M.glass, xw - 0.22, xw + 0.3, 0.45 + sh * 0.55, 0.47 + sh * 0.55, cz - 7.95, cz + 7.95, false);
      k.box(M.lamp, xw - 0.2, xw - 0.18, 0.95 + sh * 0.55, 0.98 + sh * 0.55, cz - 7.9, cz + 7.9, false); // light strip
    }
    for (let i = 0; i < Math.min(n, 48); i++) {
      const shelf = Math.floor(i / 12);
      const z = cz - 7.2 + (i % 12) * 1.3;
      const y = 0.47 + shelf * 0.55;
      k.add(M.gold, new THREE.CylinderGeometry(0.11, 0.06, 0.2, 12).translate(xw + 0.04, y + 0.26, z));
      k.add(M.gold, new THREE.CylinderGeometry(0.035, 0.07, 0.16, 8).translate(xw + 0.04, y + 0.08, z));
    }
    const plate = canvasTex(512, 128, (g) => {
      g.fillStyle = '#1c1f24';
      g.fillRect(0, 0, 512, 128);
      g.fillStyle = '#ffd981';
      g.font = '700 40px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText(`Trophies: ${n}`, 256, 60);
      g.font = '26px "Segoe UI", sans-serif';
      g.fillText('Chief Executive', 256, 104);
    });
    const pm = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), new THREE.MeshBasicMaterial({ map: plate }));
    pm.position.set(xw + 0.32, 2.85, cz);
    pm.rotation.y = Math.PI / 2;
    k.mesh(pm);
  }

  // ------------------------------------------------------------------ home estate
  private buildHome(s: Snapshot): void {
    this.clear(this.homeGroup);
    const M = this.M;
    const st = s.empire.state;
    const tier = st.homeTier;
    const k = new Kit();
    const { center, size } = egkk.empire.home;
    const [cx, cz] = center;
    const half = size[0] / 2;
    // lawn, hedge with a gate on the south side, driveway back to the car park
    k.box(M.grass, cx - half, cx + half, -0.05, 0.03, cz - half, cz + half, false);
    k.box(M.hedge, cx - half, cx + half, 0, 1.8, cz - half - 0.6, cz - half);
    k.box(M.hedge, cx - half - 0.6, cx - half, 0, 1.8, cz - half, cz + half);
    k.box(M.hedge, cx + half, cx + half + 0.6, 0, 1.8, cz - half, cz + half);
    k.box(M.hedge, cx - half, cx - 6, 0, 1.8, cz + half, cz + half + 0.6);
    k.box(M.hedge, cx + 6, cx + half, 0, 1.8, cz + half, cz + half + 0.6);
    for (const gx of [-6.5, 6.5]) k.box(M.stone, cx + gx - 0.6, cx + gx + 0.6, 0, 2.6, cz + half - 0.3, cz + half + 0.9);
    const [[dx, dz0], [, dz1]] = egkk.empire.driveway;
    k.box(M.asphalt, dx - 4, dx + 4, 0.01, 0.04, dz1, dz0, false);
    k.box(M.asphalt, cx - 4, cx + 4, 0.03, 0.06, cz + 20, cz + half + 1, false);
    // house size per tier
    const spec = [
      { w: 12, d: 9, floors: 1, pitched: true },
      { w: 26, d: 14, floors: 2, pitched: false },
      { w: 44, d: 20, floors: 2, pitched: false },
      { w: 72, d: 28, floors: 3, pitched: false },
    ][tier];
    const hx0 = cx - spec.w / 2;
    const hx1 = cx + spec.w / 2;
    const hz0 = cz - spec.d / 2 - 10;
    const hz1 = cz + spec.d / 2 - 10;
    const wallMat = tier === 0 ? M.stone : M.white;
    k.box(M.floor, hx0, hx1, 0, 0.06, hz0, hz1, false);
    k.wallX(wallMat, hz1, hx0, hx1, [[cx - 1.2, cx + 1.2], ...(tier ? ([[cx + 4, cx + 10], [cx - 10, cx - 4]] as [number, number][]) : [])], H);
    k.wallX(wallMat, hz0, hx0, hx1, [], H);
    k.wallZ(wallMat, hx0, hz0, hz1, [], H);
    k.wallZ(wallMat, hx1, hz0, hz1, [], H);
    // big windows on the front for modern homes (glass in the wide openings)
    if (tier) for (const [a, b] of [[cx + 4, cx + 10], [cx - 10, cx - 4]]) k.box(M.glass, a, b, 0, H, hz1 - 0.05, hz1 + 0.05);
    k.box(M.white, hx0 - 0.3, hx1 + 0.3, H, H + 0.35, hz0 - 0.3, hz1 + 0.3, false);
    for (let f = 1; f < spec.floors; f++) {
      const y = f * H + 0.35;
      const sx = tier >= 2 && f === spec.floors - 1 ? 6 : 0;
      k.box(M.white, hx0 + sx, hx1 - sx, y, y + H - 0.35, hz0, hz1, false);
      k.box(M.glass, hx0 + sx + 2, hx1 - sx - 2, y + 0.9, y + H - 0.9, hz1 - 0.02, hz1 + 0.12, false);
      k.box(M.white, hx0 + sx - 0.4, hx1 - sx + 0.4, y + H - 0.35, y + H, hz0 - 0.4, hz1 + 0.4, false);
    }
    if (spec.pitched) {
      const roof = new THREE.CylinderGeometry(spec.d * 0.62, spec.d * 0.62, spec.w + 1, 3, 1).rotateZ(Math.PI / 2).scale(1, 0.55, 1).translate(cx, H + 1.6, (hz0 + hz1) / 2);
      k.add(M.roof, roof);
    }
    // inside: living room
    const lz = (hz0 + hz1) / 2;
    this.sofa(k, cx - 2.5, lz + 1, 2, tier ? M.leather : M.fabric);
    k.box(M.wood, cx - 3.5, cx - 1.5, 0, 0.4, lz - 1, lz);
    k.box(M.dark, cx - 4, cx - 1, 1.0, 2.6, hz0 + 0.2, hz0 + 0.3, false);
    k.box(M.wood, cx + 2, cx + 4.5, 0, 0.76, lz - 1, lz + 1);
    if (tier) {
      k.box(M.stone, hx1 - 7, hx1 - 2, 0, 0.92, lz - 1, lz + 1); // kitchen island
      this.plant(k, hx0 + 1.2, hz1 - 1.2);
    }
    // pool, garage, tennis, helipad, lake by tier
    if (tier >= 1) {
      const pw = tier === 1 ? 12 : tier === 2 ? 22 : 34;
      const pz = hz0 - 14;
      k.box(M.stone, cx - pw / 2 - 1.5, cx + pw / 2 + 1.5, 0, 0.12, pz - 5.5, pz + 5.5, false);
      const water = new THREE.Mesh(new THREE.PlaneGeometry(pw, 8).rotateX(-Math.PI / 2), M.water);
      water.position.set(cx, 0.13, pz);
      k.mesh(water);
      for (let i = 0; i < Math.min(6, 2 + tier); i++) k.box(M.white, cx - pw / 2 + 1 + i * 2.2, cx - pw / 2 + 2.6 + i * 2.2, 0, 0.35, pz + 6, pz + 7.8, false);
    }
    // garage with your cars on display (the one you drive waits on the drive)
    const gx0 = hx1 + 6;
    const gW = Math.max(8, Math.min(6, st.cars.length) * 3.6 + 2);
    const gz0 = hz1 - 9;
    const gz1 = hz1;
    k.box(M.floor, gx0, gx0 + gW, 0, 0.06, gz0, gz1, false);
    k.wallX(M.white, gz0, gx0, gx0 + gW, [], 3.2);
    k.wallZ(M.white, gx0, gz0, gz1, [], 3.2);
    k.wallZ(M.white, gx0 + gW, gz0, gz1, [], 3.2);
    k.box(M.white, gx0 - 0.2, gx0 + gW + 0.2, 3.2, 3.5, gz0 - 0.2, gz1 + 0.2, false);
    st.cars.filter((c) => c.id !== st.activeCar).slice(0, 6).forEach((c, i) => {
      const m = empireData.cars.find((x) => x.id === c.model);
      const mesh = makeCarMesh((m?.style ?? 'saloon') as CarStyle, c.color).group;
      mesh.position.set(gx0 + 2.6 + i * 3.6, 0.06, (gz0 + gz1) / 2);
      k.mesh(mesh);
      k.boxes.push({ c: new THREE.Vector3(gx0 + 2.6 + i * 3.6, 0.8, (gz0 + gz1) / 2), h: new THREE.Vector3(1, 0.7, 2.4), rot: 0 });
    });
    if (tier >= 2) {
      // tennis court
      const tx = hx0 - 30;
      const tz = cz + 40;
      k.box(M.grass, tx - 18, tx + 18, 0.03, 0.06, tz - 9, tz + 9, false);
      const court = new THREE.Mesh(new THREE.PlaneGeometry(23.8, 11).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2e6e9e', roughness: 0.9 }));
      court.position.set(tx, 0.07, tz);
      k.mesh(court);
      k.box(M.white, tx - 0.05, tx + 0.05, 0, 1.0, tz - 6, tz + 6);
    }
    if (tier >= 3) {
      const hp = new THREE.Mesh(new THREE.CircleGeometry(11, 32).rotateX(-Math.PI / 2), M.asphalt);
      hp.position.set(cx + 70, 0.07, cz - 60);
      const hTex = canvasTex(256, 256, (g) => {
        g.fillStyle = '#3a3c40';
        g.fillRect(0, 0, 256, 256);
        g.strokeStyle = '#ffffff';
        g.lineWidth = 10;
        g.beginPath();
        g.arc(128, 128, 110, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = '#ffffff';
        g.font = '800 160px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('H', 128, 136);
      });
      const hm = new THREE.Mesh(new THREE.PlaneGeometry(18, 18).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: hTex }));
      hm.position.set(cx + 70, 0.08, cz - 60);
      k.mesh(hp);
      k.mesh(hm);
      const lake = new THREE.Mesh(new THREE.CircleGeometry(26, 40).rotateX(-Math.PI / 2).scale(1.5, 1, 1), M.water);
      lake.position.set(cx - 50, 0.05, cz - 60);
      k.mesh(lake);
    }
    // trees around the plot
    const trees = 14 + tier * 10;
    for (let i = 0; i < trees; i++) {
      const a = (i / trees) * Math.PI * 2;
      const r = half - 6 - (i % 3) * 3;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (Math.abs(x - cx) < 12 && z > cz) continue; // keep the gate clear
      k.add(M.trunk, new THREE.CylinderGeometry(0.25, 0.35, 3, 6).translate(x, 1.5, z));
      k.add(M.leaves, new THREE.ConeGeometry(2.4, 6, 7).translate(x, 5.5, z));
    }
    k.build(this.homeGroup);
    this.makeColliders(k, 'home');
  }

  dispose(): void {
    this.clear(this.hqGroup);
    this.clear(this.homeGroup);
    for (const list of Object.values(this.colliders)) for (const c of list) this.physics.world.removeCollider(c, false);
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}

// ------------------------------------------------------------------ canvas drawings
function drawFlightMap(c: HTMLCanvasElement, s: Snapshot, live: boolean): void {
  const g = c.getContext('2d')!;
  const W = c.width;
  const Hh = c.height;
  g.fillStyle = '#07121f';
  g.fillRect(0, 0, W, Hh);
  g.strokeStyle = 'rgba(120,170,230,0.15)';
  g.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * W;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, Hh);
    g.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * Hh;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  const P = (icao: string) => {
    const a = AIRPORTS[icao];
    return a ? [((a.lon + 180) / 360) * W, ((90 - a.lat) / 180) * Hh] : null;
  };
  g.strokeStyle = s.airline.accent;
  g.globalAlpha = 0.6;
  g.lineWidth = 2;
  for (const r of s.routes) {
    const a = P(r.a);
    const b = P(r.b);
    if (!a || !b) continue;
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
  }
  g.globalAlpha = 1;
  if (live) {
    g.fillStyle = '#ffffff';
    for (const ac of s.fleet) {
      if (ac.status !== 'flying' && ac.status !== 'ferry') continue;
      const a = P(ac.flightFrom);
      const b = P(ac.flightTo);
      if (!a || !b) continue;
      const t = Math.max(0, Math.min(1, (s.time - ac.flightDep) / Math.max(1, ac.flightArr - ac.flightDep)));
      g.beginPath();
      g.arc(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 5, 0, Math.PI * 2);
      g.fill();
    }
    g.font = '600 22px "Segoe UI", sans-serif';
    g.fillStyle = '#9fc2ff';
    g.fillText(`${s.fleet.filter((a) => a.status === 'flying').length} aircraft airborne · ${new Date(s.time).toUTCString().slice(5, 22)} UTC`, 20, Hh - 20);
  }
  const base = P(s.base);
  if (base) {
    g.fillStyle = '#ffd981';
    g.beginPath();
    g.arc(base[0], base[1], 7, 0, Math.PI * 2);
    g.fill();
  }
}

function drawBars(g: CanvasRenderingContext2D, s: Snapshot): void {
  const W = g.canvas.width;
  const Hh = g.canvas.height;
  g.fillStyle = '#0b1622';
  g.fillRect(0, 0, W, Hh);
  g.fillStyle = '#9fc2ff';
  g.font = '600 28px "Segoe UI", sans-serif';
  g.fillText('Revenue by route (last 30 days)', 30, 46);
  const rs = [...s.routes].sort((a, b) => b.last30.revenue - a.last30.revenue).slice(0, 10);
  const max = Math.max(1, ...rs.map((r) => r.last30.revenue));
  rs.forEach((r, i) => {
    const w = ((W - 300) * r.last30.revenue) / max;
    g.fillStyle = i % 2 ? '#3d7bf5' : '#e0a526';
    g.fillRect(260, 80 + i * 40, w, 28);
    g.fillStyle = '#cfd8e6';
    g.font = '22px "Segoe UI", sans-serif';
    g.fillText(`${AIRPORTS[r.a]?.iata}–${AIRPORTS[r.b]?.iata}`, 30, 102 + i * 40);
  });
}

function drawShare(g: CanvasRenderingContext2D, s: Snapshot): void {
  const W = g.canvas.width;
  const Hh = g.canvas.height;
  g.fillStyle = '#0b1622';
  g.fillRect(0, 0, W, Hh);
  const h = s.corp.equity.history;
  g.fillStyle = '#9fc2ff';
  g.font = '600 28px "Segoe UI", sans-serif';
  g.fillText(s.corp.equity.listed ? 'Share price' : 'Company value (private)', 30, 46);
  if (h.length < 2) return;
  const lo = Math.min(...h.map((p) => p.p));
  const hi = Math.max(...h.map((p) => p.p));
  g.strokeStyle = h[h.length - 1].p >= h[0].p ? '#3ccf8e' : '#f2555a';
  g.lineWidth = 4;
  g.beginPath();
  h.forEach((p, i) => {
    const x = 30 + (i / (h.length - 1)) * (W - 60);
    const y = Hh - 40 - ((p.p - lo) / Math.max(1e-9, hi - lo)) * (Hh - 120);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.stroke();
}
