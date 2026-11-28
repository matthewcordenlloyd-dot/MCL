import * as THREE from 'three';
import a320 from '@data/aircraft/a320neo.json';
import world from '@data/world.json';
import type { Assets } from '../core/assets';
import type { GraphicsPreset } from '../core/settings';
import { geoToLocal, headingToYaw, type GeoOrigin } from '../core/geo';
import { AircraftModel, type AircraftData } from '../flight/AircraftModel';
import type { Brand } from '../customiser/liveryPainter';
import type { Livery } from '../economy/types';
import { addMacroVariation, type GroundTextures } from './textures';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from './Physics';
import W from '@data/weather.json';
import { lightSprite, poolTexture } from './Lights';

const R_EARTH = 6371000;

export interface AirportData {
  icao: string;
  iata: string;
  name: string;
  arp: { lat: number; lon: number; elevationM: number };
  frameRotationDeg: number;
  runways: { id: string; ends: string[]; center: number[]; headingTrueDeg: number; lengthM: number; widthM: number; shoulderM: number; surface: string }[];
  taxiways: { id: string; from: number[]; to: number[]; widthM: number }[];
  apron: { min: number[]; max: number[] };
  terminal: { model: string; lightmap: string; center: number[]; rotationDeg: number; sizeM: number[]; lightmapScale: number };
  stands: { id: string; nose: number[]; headingDeg: number }[];
  playerStand: string;
  reservedStands: string[];
  jetBridgeRotunda: number[];
  spawnPoints: Record<string, { pos: number[]; yawDeg: number; label: string }>;
  mask: { min: number[]; max: number[]; blendM: number };
  bakeSun: { azimuthDeg: number; elevationDeg: number; strength: number; skyStrength: number };
}

/**
 * A detailed airport built from its data file: airfield surfaces, the lightmapped terminal,
 * parked aircraft, instanced lights and collision. Laid out in its own airport frame and
 * placed in the world at its true offset from the world origin (including earth curvature).
 */
export class Airport {
  readonly group = new THREE.Group();
  readonly aircraft: AircraftModel[] = [];
  private grass: THREE.Mesh[] = [];
  private terminalBaked: THREE.Mesh[] = [];
  private lmBase = 1;
  private glassMats: THREE.MeshStandardMaterial[] = [];
  private night = new THREE.Group();
  private pools: THREE.MeshBasicMaterial | null = null;
  private daylight = -1; // forces the first update
  private colliders: RAPIER.Collider[] = [];
  /** Height of this airport's ground in world (local) coordinates. */
  groundY = 0;
  rotation = 0;

  constructor(private assets: Assets, readonly data: AirportData, origin: GeoOrigin & { elevation: number }) {
    this.group.name = data.icao;
    const p = geoToLocal(origin, data.arp.lat, data.arp.lon);
    const curvature = (p.x * p.x + p.z * p.z) / (2 * R_EARTH);
    this.groundY = data.arp.elevationM - origin.elevation - curvature;
    this.rotation = THREE.MathUtils.degToRad(data.frameRotationDeg ?? 0);
    this.group.position.set(p.x, this.groundY, p.z);
    this.group.rotation.y = this.rotation;
    this.group.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------ frame conversions
  /** Airport-frame point (x, y, z) to world. */
  toWorld(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.group.matrixWorld);
  }

  /** Airport-frame heading (deg) to world heading. */
  toWorldHeading(h: number): number {
    return (((h - this.data.frameRotationDeg) % 360) + 360) % 360;
  }

  spawn(id: string): { pos: THREE.Vector3; heading: number; label: string } | null {
    const sp = this.data.spawnPoints[id];
    if (!sp) return null;
    return { pos: this.toWorld(sp.pos[0], sp.pos[1], sp.pos[2]), heading: this.toWorldHeading(sp.yawDeg), label: sp.label };
  }

  runwayWorld(i = 0): { a: THREE.Vector3; b: THREE.Vector3; heading: number; rw: AirportData['runways'][number] } {
    const rw = this.data.runways[i];
    const h = (rw.headingTrueDeg * Math.PI) / 180;
    const along = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    const c = new THREE.Vector3(rw.center[0], 0, rw.center[1]);
    return {
      a: c.clone().addScaledVector(along, -rw.lengthM / 2).applyMatrix4(this.group.matrixWorld),
      b: c.clone().addScaledVector(along, rw.lengthM / 2).applyMatrix4(this.group.matrixWorld),
      heading: this.toWorldHeading(rw.headingTrueDeg),
      rw,
    };
  }

  /** World-space axis-aligned box of the flattening mask (for terrain). */
  maskWorld(): { min: [number, number]; max: [number, number]; blendM: number; y: number } {
    const m = this.data.mask;
    const pts = [[m.min[0], m.min[1]], [m.max[0], m.min[1]], [m.max[0], m.max[1]], [m.min[0], m.max[1]]].map(([x, z]) => this.toWorld(x, 0, z));
    return {
      min: [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.z))],
      max: [Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.z))],
      blendM: m.blendM,
      y: this.groundY,
    };
  }

  // ------------------------------------------------------------------ load
  async load(preset: GraphicsPreset, physics: Physics, renderer: THREE.WebGLRenderer, tex: GroundTextures, parkedBrand: Brand): Promise<void> {
    const d = this.data;
    const code = d.icao.toLowerCase();
    const [airfield, terminal, lightmap, plane] = await Promise.all([
      this.assets.loadGLTF(`models/${code}_airfield.glb`),
      this.assets.loadGLTF(d.terminal.model),
      this.assets.loadTexture(d.terminal.lightmap),
      this.assets.loadGLTF(a320.model.file),
    ]);
    const aniso = Math.min(preset.anisotropy, renderer.capabilities.getMaxAnisotropy());

    // ---------------------------------------------------------- airfield surfaces
    const groundMat = (name: string, map: THREE.Texture, color: string, order: number, macro: number, rough = 0.9) => {
      const m = new THREE.MeshStandardMaterial({ name, map, color, roughness: rough, metalness: 0 });
      if (order > 0) {
        m.polygonOffset = true;
        m.polygonOffsetFactor = -order;
        m.polygonOffsetUnits = -order * 4;
      }
      if (macro > 0) addMacroVariation(m, tex.macro, macro);
      return m;
    };
    const mats: Record<string, THREE.MeshStandardMaterial> = {
      grass: groundMat('grass', tex.grass, '#ffffff', 0, 1, 1),
      asphalt: groundMat('asphalt', tex.asphalt, '#ffffff', 1, 0.8),
      asphalt_runway: groundMat('asphalt_runway', tex.runway, '#ffffff', 2, 0.6),
      concrete: groundMat('concrete', tex.concrete, '#ffffff', 2, 0.7, 0.85),
      paint_white: groundMat('paint_white', tex.paint, '#f2f2ee', 4, 0, 0.7),
      paint_yellow: groundMat('paint_yellow', tex.paint, '#e8b62a', 4, 0, 0.7),
    };
    const orderOf: Record<string, number> = { grass: 0, asphalt: 1, asphalt_runway: 2, concrete: 2, paint_white: 3, paint_yellow: 3 };
    airfield.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name;
      if (mats[name]) mesh.material = mats[name];
      if (name === 'grass') this.grass.push(mesh);
      mesh.renderOrder = orderOf[name] ?? 0;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
    });
    this.group.add(airfield.scene);

    // ---------------------------------------------------------- terminal (baked)
    lightmap.flipY = false;
    lightmap.channel = 0;
    lightmap.anisotropy = aniso;
    const lmIntensity = Math.PI * d.terminal.lightmapScale * (world.sunIntensity / d.bakeSun.strength) * world.lightmapExposure;
    this.lmBase = lmIntensity;
    const t = terminal.scene;
    t.position.set(d.terminal.center[0], 0, d.terminal.center[1]);
    t.rotation.y = THREE.MathUtils.degToRad(-d.terminal.rotationDeg);
    const colliders: THREE.Mesh[] = [];
    t.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.name.startsWith('COL')) {
        mesh.visible = false;
        colliders.push(mesh);
        return;
      }
      const baked = isBaked(mesh);
      const remap = (m: THREE.Material): THREE.Material => {
        const sm = m as THREE.MeshStandardMaterial;
        if (baked) return new THREE.MeshBasicMaterial({ name: sm.name, color: sm.color, lightMap: lightmap, lightMapIntensity: lmIntensity });
        if (sm.name === 'glass') {
          const g = new THREE.MeshStandardMaterial({ name: 'glass', color: '#8fa8b8', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.6, emissive: '#ffcf8a', emissiveIntensity: 0 });
          this.glassMats.push(g);
          return g;
        }
        return new THREE.MeshBasicMaterial({ name: sm.name, color: sm.emissive.clone().multiplyScalar(sm.emissiveIntensity) });
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(remap) : remap(mesh.material);
      if (baked) {
        this.terminalBaked.push(mesh);
        mesh.castShadow = true;
      }
      if (mesh.name.includes('glass')) mesh.renderOrder = 5;
    });
    this.group.add(t);

    // ---------------------------------------------------------- parked aircraft
    const regs = ['G-EMPA', 'G-EMPB', 'G-EMPC', 'G-EMPD', 'G-EMPE'];
    d.stands.forEach((st, i) => {
      if (d.reservedStands.includes(st.id)) return;
      const ac = new AircraftModel(plane, a320 as unknown as AircraftData, parkedBrand, regs[i % regs.length], preset.liveryResolution, preset.lodBias);
      const yaw = headingToYaw(st.headingDeg);
      const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      ac.root.position.copy(new THREE.Vector3(st.nose[0], 0, st.nose[1]).addScaledVector(fwd, -a320.model.noseY));
      ac.root.rotation.y = yaw;
      this.group.add(ac.root);
      this.aircraft.push(ac);
      colliders.push(...ac.colliders);
    });

    this.group.add(this.makeAirfieldLights());
    this.makeFloodlights();
    this.group.add(this.night);
    this.group.updateMatrixWorld(true);
    this.colliders.push(...physics.addGround(5000, 500, this.group.position.x, this.group.position.z, this.groundY));
    const hulls = physics.addHulls(colliders);
    this.colliders.push(...hulls);
    console.info(`[${d.icao}] ${hulls.length} collision hulls`);
  }

  /** Show/hide this airport and switch its collision on/off (while you are elsewhere in the world). */
  setActive(on: boolean): void {
    this.group.visible = on;
    for (const c of this.colliders) c.setEnabled(on);
  }

  repaintParked(brand: Brand, livery?: Livery): void {
    for (const ac of this.aircraft) {
      if (livery) ac.applyLivery(livery);
      else ac.repaint(brand);
    }
  }

  /** Apron floodlight masts: lamp halos and warm light pools on the ground (no real lights: cheap at night). */
  private makeFloodlights(): void {
    const a = this.data.apron;
    if (!a) return;
    const poleG = new THREE.CylinderGeometry(0.25, 0.35, 24, 8).translate(0, 12, 0);
    const poleM = new THREE.MeshStandardMaterial({ color: '#8a8f96', roughness: 0.6, metalness: 0.5 });
    this.pools = new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -24 });
    const poolG = new THREE.PlaneGeometry(70, 70).rotateX(-Math.PI / 2);
    const z = Math.max(a.min[1], a.max[1]) + 6; // runway side of the apron
    for (let x = Math.min(a.min[0], a.max[0]) + 20; x <= Math.max(a.min[0], a.max[0]) - 10; x += 70) {
      const pole = new THREE.Mesh(poleG, poleM);
      pole.position.set(x, 0, z);
      pole.castShadow = true;
      this.group.add(pole);
      const head = lightSprite('#ffd8a0', 5);
      head.position.set(x, 24.3, z);
      head.userData.lamp = true;
      this.night.add(head);
      const p = new THREE.Mesh(poolG, this.pools);
      p.position.set(x, 0.12, z - 30);
      p.renderOrder = 3;
      this.night.add(p);
    }
  }

  /** 1 = day, 0 = night: dims the baked terminal light, lights the windows and floodlights. */
  setDaylight(day: number): void {
    if (Math.abs(day - this.daylight) < 0.01) return;
    this.daylight = day;
    const night = 1 - day;
    const lm = this.lmBase * THREE.MathUtils.lerp(W.night.terminalNightLightmap, 1, day);
    for (const m of this.terminalBaked) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mt of mats) (mt as THREE.MeshBasicMaterial).lightMapIntensity = lm;
    }
    for (const g of this.glassMats) {
      g.emissiveIntensity = night * 0.9;
      g.opacity = 0.22 + night * 0.35;
    }
    if (this.pools) this.pools.opacity = night * 0.55;
    this.night.visible = night > 0.05;
    for (const o of this.night.children) if (o.userData.lamp) (o as THREE.Sprite).scale.setScalar(2 + night * 6);
    for (const ac of this.aircraft) {
      ac.lights.beacon = false;
      ac.lights.update(0, night);
    }
  }

  /** All runway + taxiway lights as one instanced mesh (one draw call). */
  private makeAirfieldLights(): THREE.InstancedMesh {
    const d = this.data;
    const pts: { p: THREE.Vector3; c: THREE.Color }[] = [];
    const white = new THREE.Color(3, 3, 2.6);
    const green = new THREE.Color(0.2, 3, 0.6);
    const red = new THREE.Color(3, 0.2, 0.15);
    const blue = new THREE.Color(0.3, 0.6, 3);
    for (const rw of d.runways) {
      const yaw = headingToYaw(rw.headingTrueDeg);
      const along = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const across = new THREE.Vector3(along.z, 0, -along.x);
      const c = new THREE.Vector3(rw.center[0], 0.2, rw.center[1]);
      const half = rw.lengthM / 2;
      for (let a = -half; a <= half + 0.1; a += 60) {
        for (const s of [-1, 1]) pts.push({ p: c.clone().addScaledVector(along, a).addScaledVector(across, s * (rw.widthM / 2 + 1.5)), c: white });
      }
      for (let k = -9; k <= 9; k++) {
        const off = k * (rw.widthM / 19);
        pts.push({ p: c.clone().addScaledVector(along, -half - 1).addScaledVector(across, off), c: green });
        pts.push({ p: c.clone().addScaledVector(along, half + 1).addScaledVector(across, off), c: red });
      }
    }
    for (const tw of d.taxiways) {
      const a = new THREE.Vector3(tw.from[0], 0.2, tw.from[1]);
      const b = new THREE.Vector3(tw.to[0], 0.2, tw.to[1]);
      const len = a.distanceTo(b);
      const dir = b.clone().sub(a).normalize();
      const side = new THREE.Vector3(dir.z, 0, -dir.x);
      for (let dd = 0; dd <= len; dd += 30) {
        for (const s of [-1, 1]) pts.push({ p: a.clone().addScaledVector(dir, dd).addScaledVector(side, s * (tw.widthM / 2 + 1)), c: blue });
      }
    }
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.16, 0.35, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), pts.length);
    const m = new THREE.Matrix4();
    pts.forEach((pt, i) => {
      m.makeTranslation(pt.p.x, pt.p.y, pt.p.z);
      im.setMatrixAt(i, m);
      im.setColorAt(i, pt.c);
    });
    im.computeBoundingSphere();
    im.name = 'airfield_lights';
    return im;
  }

  setGrassVisible(v: boolean): void {
    for (const g of this.grass) g.visible = v;
  }

  setShadows(enabled: boolean): void {
    for (const m of this.terminalBaked) m.castShadow = enabled;
  }
}

function isBaked(mesh: THREE.Object3D): boolean {
  let o: THREE.Object3D | null = mesh;
  while (o) {
    if (o.userData?.baked) return true;
    o = o.parent;
  }
  return false;
}
