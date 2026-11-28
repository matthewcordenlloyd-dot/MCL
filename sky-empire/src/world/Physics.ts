import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export type Rapier = typeof RAPIER;

/** Thin wrapper around a Rapier world plus helpers to build colliders from meshes. */
export class Physics {
  readonly world: RAPIER.World;
  readonly R: Rapier = RAPIER;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  /**
   * Flat ground at y = 0, built from 500 m tiles. A single 16 km box loses f32 precision
   * in contact queries and lets the character controller slowly sink through it.
   */
  addGround(halfSize = 4000, tile = 500, cx = 0, cz = 0, y = 0): RAPIER.Collider[] {
    const h = tile / 2;
    const out: RAPIER.Collider[] = [];
    for (let x = -halfSize; x < halfSize; x += tile) {
      for (let z = -halfSize; z < halfSize; z += tile) {
        out.push(this.world.createCollider(RAPIER.ColliderDesc.cuboid(h, 1, h).setTranslation(cx + x + h, y - 1, cz + z + h)));
      }
    }
    return out;
  }

  /** Convex hull per mesh, in world space. Collision meshes are simple boxes/cylinders. */
  addHulls(meshes: THREE.Mesh[]): RAPIER.Collider[] {
    const out: RAPIER.Collider[] = [];
    const v = new THREE.Vector3();
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const pos = mesh.geometry.getAttribute('position');
      const pts = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        pts[i * 3] = v.x;
        pts[i * 3 + 1] = v.y;
        pts[i * 3 + 2] = v.z;
      }
      const desc = RAPIER.ColliderDesc.convexHull(pts);
      if (desc) out.push(this.world.createCollider(desc));
    }
    return out;
  }

  step(dt: number): void {
    this.world.timestep = Math.min(dt, 1 / 20);
    this.world.step();
  }
}
