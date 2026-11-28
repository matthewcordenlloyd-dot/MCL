import * as THREE from 'three';
import { runwayEnds, TDZ_M, type RunwayDef } from '../flight/Approach';
import { lightSprite } from './Lights';

/**
 * Approach lighting and PAPIs for a set of runways (world coordinates).
 * Approach lights: a 900 m centre line of light bars with a crossbar at 300 m.
 * PAPI: four lights left of the touchdown zone that show white/red by your angle above it
 * (2.5° / 2.83° / 3.17° / 3.5°): two white and two red means on the 3° path.
 */
export class ApproachAids {
  readonly group = new THREE.Group();
  private papis: { lights: THREE.Sprite[]; origin: THREE.Vector3 }[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(runways: RunwayDef[]) {
    const bars: THREE.Matrix4[] = [];
    const white = new THREE.Color(2.6, 2.6, 2.4);
    for (const e of runwayEnds(runways)) {
      const yaw = Math.atan2(e.dir.x, e.dir.z);
      const side = new THREE.Vector3(e.dir.z, 0, -e.dir.x); // left of the landing direction
      // approach light bars every 30 m out to 900 m, crossbar at 300 m
      for (let d = 30; d <= 900; d += 30) {
        const p = e.thr.clone().addScaledVector(e.dir, -d);
        bars.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, e.thr.y + 0.4, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)));
      }
      for (let k = -6; k <= 6; k++) {
        const p = e.thr.clone().addScaledVector(e.dir, -300).addScaledVector(side, k * 2.5);
        bars.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, e.thr.y + 0.4, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(0.3, 1, 1)));
      }
      // PAPI on the left, abeam the touchdown point
      const lights: THREE.Sprite[] = [];
      const base = e.thr.clone().addScaledVector(e.dir, TDZ_M).addScaledVector(side, e.widthM / 2 + 15);
      for (let i = 0; i < 4; i++) {
        const p = base.clone().addScaledVector(side, i * 9);
        const s = lightSprite('#ffffff', 3.5);
        s.position.set(p.x, e.thr.y + 0.9, p.z);
        lights.push(s);
        this.group.add(s);
      }
      this.papis.push({ lights, origin: base.clone().setY(e.thr.y) });
    }
    const geo = new THREE.BoxGeometry(6, 0.25, 0.35);
    const mat = new THREE.MeshBasicMaterial({ color: white, toneMapped: false });
    const im = new THREE.InstancedMesh(geo, mat, bars.length);
    bars.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    this.group.add(im);
    this.disposables.push(geo, mat);
  }

  /** Colour the PAPIs for a viewer (the camera); night 0..1 enlarges the halos. */
  update(viewer: THREE.Vector3, night: number): void {
    const limits = [3.5, 3.17, 2.83, 2.5]; // inner unit first (nearest the runway)
    for (const p of this.papis) {
      const dx = viewer.x - p.origin.x;
      const dz = viewer.z - p.origin.z;
      const angle = (Math.atan2(viewer.y - p.origin.y, Math.hypot(dx, dz)) * 180) / Math.PI;
      p.lights.forEach((s, i) => {
        // each unit shows white above its angle and red below it
        (s.material as THREE.SpriteMaterial).color.set(angle > limits[i] ? '#ffffff' : '#ff2020');
        s.scale.setScalar(2.5 + night * 4);
      });
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const p of this.papis) for (const s of p.lights) s.material.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
