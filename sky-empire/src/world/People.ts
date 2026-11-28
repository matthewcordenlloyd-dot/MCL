import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import T from '@data/traffic.json';
import { applyLook, HAIR_COLOURS, SKIN_TONES } from '../customiser/characterLook';
import type { CharacterLook } from '../economy/types';
import type { Airport } from './Airport';

type Zone = { min: [number, number]; max: [number, number] };
interface Walker {
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  walk: THREE.AnimationAction;
  idle: THREE.AnimationAction;
  post: () => void;
  zone: Zone;
  target: THREE.Vector2;
  wait: number;
  speed: number;
}

// walkable areas in the Gatwick frame (clear of the terminal furniture built in blender/build_terminal.py)
const ZONES: Zone[] = [
  { min: [-535, -675], max: [-265, -670] }, // airside concourse between the shops and the gate seating
  { min: [-535, -709], max: [-265, -706] }, // landside entry band inside the doors
  { min: [-540, -736], max: [-260, -726] }, // forecourt outside
  { min: [-165, -800], max: [-60, -790] }, // HQ forecourt
];

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/**
 * Travellers and staff walking around the terminal and forecourts: clones of the character rig
 * with random looks, strolling between random points with idle pauses. Only animated near you.
 */
export class People {
  readonly group = new THREE.Group();
  private walkers: Walker[] = [];

  constructor(private airport: Airport, gltf: GLTF) {
    const brands = [['#1b2a55', '#e0a526'], ['#7a1020', '#f2f2f2'], ['#0f5132', '#c9d6df'], ['#2a2d33', '#d4a537']];
    for (let i = 0; i < T.people.count; i++) {
      const obj = cloneSkinned(gltf.scene);
      obj.traverse((o) => ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).castShadow = true)));
      const look: CharacterLook = {
        height: 0.92 + Math.random() * 0.14, build: 0.9 + Math.random() * 0.25, head: 0.96 + Math.random() * 0.08,
        skin: pick(SKIN_TONES), hair: pick(HAIR_COLOURS), hairStyle: pick(['short', 'short', 'long', 'bald'] as const),
        outfit: pick(['casual', 'casual', 'casual', 'ceo', 'pilot'] as const), cap: Math.random() < 0.5,
      };
      const [p, a] = pick(brands);
      const post = applyLook(obj, look, { name: '', colors: { primary: p, accent: a, secondary: '#ffffff', window: '#1b2430' } });
      const mixer = new THREE.AnimationMixer(obj);
      const clip = (n: string) => gltf.animations.find((c) => c.name === n) ?? gltf.animations[0];
      const walk = mixer.clipAction(clip('Walk'));
      const idle = mixer.clipAction(clip('Idle'));
      walk.play();
      idle.play();
      const zone = ZONES[i % ZONES.length];
      const w: Walker = { obj, mixer, walk, idle, post, zone, target: new THREE.Vector2(), wait: Math.random() * 4, speed: 1.1 + Math.random() * 0.5 };
      obj.position.set(THREE.MathUtils.randFloat(zone.min[0], zone.max[0]), 0, THREE.MathUtils.randFloat(zone.min[1], zone.max[1]));
      this.newTarget(w);
      mixer.update(Math.random() * 2);
      this.group.add(obj);
      this.walkers.push(w);
    }
    airport.group.add(this.group);
  }

  private newTarget(w: Walker): void {
    w.target.set(THREE.MathUtils.randFloat(w.zone.min[0], w.zone.max[0]), THREE.MathUtils.randFloat(w.zone.min[1], w.zone.max[1]));
  }

  /** camLocal: the camera position in the airport frame. */
  update(dt: number, camWorld: THREE.Vector3): void {
    const cam = this.airport.group.worldToLocal(camWorld.clone());
    for (const w of this.walkers) {
      const d = Math.hypot(w.obj.position.x - cam.x, w.obj.position.z - cam.z);
      const near = d < T.people.activeRadiusM;
      w.obj.visible = d < T.people.drawRadiusM; // keep walking further out, but only draw people close to you
      if (!near) continue;
      const p = w.obj.position;
      const to = new THREE.Vector2(w.target.x - p.x, w.target.y - p.z);
      const dist = to.length();
      let moving = false;
      if (w.wait > 0) w.wait -= dt;
      else if (dist < 0.4) {
        w.wait = Math.random() < 0.4 ? 2 + Math.random() * 8 : 0;
        this.newTarget(w);
      } else {
        moving = true;
        to.divideScalar(dist);
        p.x += to.x * w.speed * dt;
        p.z += to.y * w.speed * dt;
        const yaw = Math.atan2(-to.x, -to.y); // the rig faces -Z
        let dy = yaw - w.obj.rotation.y;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        w.obj.rotation.y += THREE.MathUtils.clamp(dy, -dt * 4, dt * 4);
      }
      w.walk.setEffectiveWeight(THREE.MathUtils.damp(w.walk.getEffectiveWeight(), moving ? 1 : 0, 6, dt));
      w.idle.setEffectiveWeight(1 - w.walk.getEffectiveWeight());
      w.walk.timeScale = w.speed / 1.4;
      w.mixer.update(dt);
      w.post();
    }
  }

  setActive(on: boolean): void {
    this.group.visible = on;
  }
}
