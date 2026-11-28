import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Physics } from './Physics';

const CAB_LEN = 2.4;
const ROT_R = 1.9;

/**
 * A jet bridge assembled from Blender parts (rotunda, stretchable tunnel, cab).
 * It docks to an aircraft door, retracts for pushback, and builds walkable colliders.
 */
export class JetBridge {
  readonly group = new THREE.Group();
  private rotunda: THREE.Object3D;
  private tunnel: THREE.Object3D;
  private cab: THREE.Object3D;
  private colliders: RAPIER.Collider[] = [];
  private docked = new THREE.Vector3();
  private outward = new THREE.Vector3();
  private floorY = 0;
  retract = 0; // 0 = docked, 1 = fully retracted

  constructor(gltf: GLTF, private physics: Physics, private rotundaXZ: [number, number]) {
    const get = (n: string) => {
      const o = gltf.scene.getObjectByName(n)!.clone(true);
      o.traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (mat.name === 'bridge_light') mesh.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.9, 2.6) });
        }
      });
      this.group.add(o);
      return o;
    };
    this.rotunda = get('jb_rotunda');
    this.tunnel = get('jb_tunnel');
    this.cab = get('jb_cab');
    this.group.name = 'jetbridge';
  }

  /** Dock the cab to a door: sill position (floor level) and the door's outward direction. */
  dock(doorSill: THREE.Vector3, outward: THREE.Vector3): void {
    this.docked.copy(doorSill);
    this.outward.copy(outward).setY(0).normalize();
    this.floorY = doorSill.y;
    this.retract = 0;
    this.layout(true);
  }

  setRetract(t: number): void {
    const v = THREE.MathUtils.clamp(t, 0, 1);
    if (v === this.retract) return;
    const wasDocked = this.retract === 0;
    this.retract = v;
    this.layout(v === 0 || wasDocked);
  }

  private layout(rebuildColliders: boolean): void {
    const cabCenter = this.docked.clone().addScaledVector(this.outward, CAB_LEN / 2 + 0.55 + this.retract * 2.6);
    cabCenter.y = this.floorY;
    this.cab.position.copy(cabCenter);
    this.cab.rotation.set(0, Math.atan2(this.outward.x, this.outward.z), 0); // cab front (-Z) faces the aircraft
    const rot = new THREE.Vector3(this.rotundaXZ[0], 0.03, this.rotundaXZ[1]);
    const back = cabCenter.clone().addScaledVector(this.outward, CAB_LEN / 2 - 0.1);
    const dirFlat = back.clone().sub(rot).setY(0).normalize();
    this.rotunda.position.copy(rot);
    this.rotunda.rotation.set(0, Math.atan2(-dirFlat.x, -dirFlat.z), 0);
    const start = rot.clone().addScaledVector(dirFlat, ROT_R - 0.2);
    const end = back;
    const len = start.distanceTo(end);
    this.tunnel.position.copy(start);
    this.tunnel.lookAt(start.clone().sub(end.clone().sub(start)));
    this.tunnel.scale.set(1, 1, len);
    this.group.updateMatrixWorld(true);
    if (rebuildColliders) this.buildColliders(this.retract === 0);
  }

  private buildColliders(enabled: boolean): void {
    const W = this.physics.world;
    for (const c of this.colliders) W.removeCollider(c, false);
    this.colliders = [];
    if (!enabled) return;
    const R = this.physics.R;
    const add = (obj: THREE.Object3D, local: THREE.Vector3, half: THREE.Vector3, ignoreScale = false) => {
      const q = obj.getWorldQuaternion(new THREE.Quaternion());
      const p = local.clone();
      if (!ignoreScale) p.multiply(obj.scale);
      p.applyQuaternion(q).add(obj.getWorldPosition(new THREE.Vector3()));
      const desc = R.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      this.colliders.push(W.createCollider(desc));
    };
    const len = this.tunnel.scale.z;
    // tunnel floor + walls (tunnel geometry runs along local -Z)
    add(this.tunnel, new THREE.Vector3(0, -0.1, -0.5), new THREE.Vector3(1.3, 0.1, len / 2), false);
    for (const s of [-1, 1]) add(this.tunnel, new THREE.Vector3(s * 1.27, 1.35, -0.5), new THREE.Vector3(0.05, 1.35, len / 2), false);
    // cab floor, sides and the bridge plate to the door sill
    add(this.cab, new THREE.Vector3(0, -0.1, -0.35), new THREE.Vector3(1.6, 0.1, CAB_LEN / 2 + 0.4), true);
    for (const s of [-1, 1]) add(this.cab, new THREE.Vector3(s * 1.56, 1.35, 0), new THREE.Vector3(0.05, 1.35, CAB_LEN / 2), true);
  }
}
