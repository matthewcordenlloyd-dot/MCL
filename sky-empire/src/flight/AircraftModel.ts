import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { paintFuselage, paintLivery, paintTail, paintTailLivery, type AircraftLiveryData, type Brand } from '../customiser/liveryPainter';
import type { Livery } from '../economy/types';
import { AircraftLights } from '../world/Lights';

export interface AircraftData extends AircraftLiveryData {
  id: string;
  name: string;
  model: { file: string; lodDistances: number[]; rootName?: string; lights?: { wingtip: number[]; tail: number[]; beaconTop: number[]; beaconBottom: number[] } };
}

/**
 * A parked/visual aircraft instance: LOD switching, livery textures, shadow settings,
 * and the collision hull meshes (consumed by Physics).
 */
export class AircraftModel {
  readonly root = new THREE.Group();
  readonly lod = new THREE.LOD();
  readonly colliders: THREE.Mesh[] = [];
  readonly gears: THREE.Object3D[] = [];
  readonly fans: THREE.Object3D[] = [];
  door: THREE.Object3D | null = null;
  readonly lights: AircraftLights;

  private fusMats: THREE.MeshStandardMaterial[] = [];
  private tailMats: THREE.MeshStandardMaterial[] = [];
  private brandMats: THREE.MeshStandardMaterial[] = [];

  constructor(gltf: GLTF, private data: AircraftData, brand: Brand, private registration: string, private liveryRes: number, lodBias: number) {
    const src = gltf.scene.getObjectByName(data.model.rootName ?? 'A320neo') ?? gltf.scene;
    const fus = paintFuselage(data, brand, registration, liveryRes);
    const tail = paintTail(brand, liveryRes >= 4096 ? 1024 : 512);
    const brandColor = new THREE.Color(brand.colors.primary);

    const matCache = new Map<THREE.Material, THREE.Material>();
    const restyle = (m: THREE.Material): THREE.Material => {
      let out = matCache.get(m);
      if (out) return out;
      const sm = (m as THREE.MeshStandardMaterial).clone();
      if (sm.name === 'fuselage_livery') {
        sm.map = fus;
        sm.color.set(0xffffff);
        this.fusMats.push(sm);
      } else if (sm.name === 'tail_livery') {
        sm.map = tail;
        sm.color.set(0xffffff);
        this.tailMats.push(sm);
      } else if (sm.name === 'paint_brand') {
        sm.color.copy(brandColor);
        this.brandMats.push(sm);
      }
      sm.envMapIntensity = 1;
      // Blender exports double-sided by default; the skin must be single-sided so you can see out from inside
      sm.side = sm.name === 'metal_dark' ? THREE.DoubleSide : THREE.FrontSide;
      matCache.set(m, sm);
      return sm;
    };

    for (let i = 0; i < 3; i++) {
      const g = src.getObjectByName(`LOD${i}`);
      if (!g) continue;
      const level = g.clone(true);
      level.position.set(0, 0, 0);
      level.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(restyle) : restyle(mesh.material);
        mesh.castShadow = i === 0;
        mesh.receiveShadow = i === 0;
      });
      level.traverse((o) => {
        if (o.name.startsWith('gear_lod')) this.gears.push(o);
        if (o.name.startsWith('fan_')) this.fans.push(o);
      });
      this.lod.addLevel(level, (data.model.lodDistances[i] ?? i * 200) * lodBias);
    }
    this.root.add(this.lod);
    const door = src.getObjectByName('door_L1');
    if (door) {
      this.door = door.clone(true);
      this.door.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: 0xe9eaec, roughness: 0.35 });
      });
      this.root.add(this.door);
    }

    // Collision hulls travel with this instance (hidden) so their world transform is correct.
    const col = src.getObjectByName('COL')?.clone(true);
    if (col) {
      col.position.set(0, 0, 0);
      col.visible = false;
      this.root.add(col);
      col.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) this.colliders.push(mesh);
      });
    }
    this.lights = new AircraftLights((data as unknown as { dimensions: { span: number } }).dimensions.span, data.model.lights);
    this.root.add(this.lights.group);
    this.root.userData.aircraft = data.id;
    this.root.add(this.makeContactShadow(data.dimensions.length, 36));
  }

  /** Repaint in another airline brand (new game, livery changes). */
  repaint(brand: Brand, registration = this.registration): void {
    this.registration = registration;
    const fus = paintFuselage(this.data, brand, registration, this.liveryRes);
    const tail = paintTail(brand, this.liveryRes >= 4096 ? 1024 : 512);
    for (const m of this.fusMats) {
      m.map?.dispose();
      m.map = fus;
    }
    for (const m of this.tailMats) {
      m.map?.dispose();
      m.map = tail;
    }
    for (const m of this.brandMats) m.color.set(brand.colors.primary);
  }

  /** Paint a full custom livery (livery editor). Repaints again once an uploaded logo has decoded. */
  applyLivery(livery: Livery, registration = this.registration, res = this.liveryRes): void {
    this.registration = registration;
    const again = () => this.applyLivery(livery, registration, res);
    const fus = paintLivery(this.data, livery, registration, res, again);
    const tail = paintTailLivery(livery, res >= 4096 ? 1024 : 512, again);
    for (const m of this.fusMats) {
      m.map?.dispose();
      m.map = fus;
    }
    for (const m of this.tailMats) {
      m.map?.dispose();
      m.map = tail;
    }
    for (const m of this.brandMats) m.color.set(livery.engines);
  }

  /** Gear retraction (simple slide into the bays), fan spin and the L1 door swing. */
  animate(gearPos: number, n1: number[], doorOpen: number, dt: number): void {
    for (const g of this.gears) {
      g.visible = gearPos > 0.35;
      g.position.y = (1 - gearPos) * 1.4;
    }
    this.fans.forEach((f, i) => {
      const n = n1[f.name.startsWith('fan_L') ? 0 : 1] ?? n1[i % 2] ?? 0;
      f.rotation.z += Math.min(n * 60, 22) * dt;
    });
    if (this.door) this.door.rotation.y = -doorOpen * 1.75;
  }

  /** Soft fake ambient-occlusion footprint: cheap, works on Low where real shadows are off. */
  private makeContactShadow(length: number, span: number): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 0.55, length * 0.95).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 }),
    );
    m.position.set(0, 0.04, 0.8); // origin is under the main gear; the fuselage centre is ~1 m aft
    m.renderOrder = 2;
    return m;
  }
}
