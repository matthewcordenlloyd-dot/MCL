import * as THREE from 'three';
import type { Input } from '../player/Input';
import type { PlayerAircraft } from './PlayerAircraft';

export type ViewMode = 'cockpit' | 'chase' | 'orbit' | 'tower';
export const VIEW_MODES: ViewMode[] = ['cockpit', 'chase', 'orbit', 'tower'];

/** Flight cameras: cockpit (free head look), chase, orbit and tower. */
export class FlightCamera {
  mode: ViewMode = 'cockpit';
  private headYaw = 0;
  private headPitch = -0.12;
  private orbitYaw = 0;
  private orbitPitch = 0.18;
  private dist = 62;
  private chasePos = new THREE.Vector3();
  private initialized = false;
  tower = new THREE.Vector3(-900, 32, -175);

  cycle(): ViewMode {
    this.mode = VIEW_MODES[(VIEW_MODES.indexOf(this.mode) + 1) % VIEW_MODES.length];
    this.initialized = false;
    return this.mode;
  }

  resetHead(): void {
    this.headYaw = 0;
    this.headPitch = -0.12;
  }

  update(dt: number, cam: THREE.PerspectiveCamera, pa: PlayerAircraft, I: Input, mouseFree: boolean, sensitivity: number): void {
    const look = mouseFree && I.locked ? 1 : 0;
    const sens = 0.0022 * sensitivity;
    const padX = I.padAxes[2] * 2.2 * dt;
    const padY = I.padAxes[3] * 2.2 * dt;
    const root = pa.root;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(root.quaternion);
    const target = root.position.clone().add(new THREE.Vector3(0, 4, 0));
    if (this.mode === 'cockpit') {
      this.headYaw = THREE.MathUtils.clamp(this.headYaw - I.mouseDX * sens * look - padX, -2.6, 2.6);
      this.headPitch = THREE.MathUtils.clamp(this.headPitch - I.mouseDY * sens * look - padY, -1.3, 1.2);
      pa.eyeWorld(cam.position);
      cam.quaternion.copy(root.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.headPitch, this.headYaw, 0, 'YXZ')));
      cam.near = 0.04;
    } else if (this.mode === 'chase' || this.mode === 'orbit') {
      this.orbitYaw -= I.mouseDX * sens * look + padX;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + I.mouseDY * sens * look + padY, -0.3, 1.4);
      if (I.wheel) this.dist = THREE.MathUtils.clamp(this.dist * (1 + I.wheel * 0.1), 18, 400);
      const baseYaw = this.mode === 'chase' ? Math.atan2(-fwd.x, -fwd.z) : 0;
      const yaw = baseYaw + this.orbitYaw;
      const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(this.orbitPitch), Math.sin(this.orbitPitch), Math.cos(yaw) * Math.cos(this.orbitPitch)).multiplyScalar(this.dist);
      const want = target.clone().add(off);
      if (!this.initialized || this.mode === 'orbit') this.chasePos.copy(want);
      else this.chasePos.lerp(want, 1 - Math.exp(-6 * dt));
      // keep the camera above the ground near the airport
      this.chasePos.y = Math.max(this.chasePos.y, 1.5);
      cam.position.copy(this.chasePos);
      cam.lookAt(target);
      cam.near = 0.5;
      // after a frame the chase camera follows smoothly
      this.initialized = true;
      if (this.mode === 'chase' && Math.abs(I.mouseDX) + Math.abs(I.mouseDY) < 0.5 && Math.abs(I.padAxes[2]) + Math.abs(I.padAxes[3]) < 0.05) this.orbitYaw *= Math.exp(-0.8 * dt);
    } else {
      cam.position.copy(this.tower);
      cam.lookAt(target);
      const d = this.tower.distanceTo(target);
      cam.fov = THREE.MathUtils.clamp(2 * Math.atan(60 / d) * (180 / Math.PI), 4, 65);
      cam.near = 1;
    }
    if (this.mode !== 'tower' && cam.fov !== 65) cam.fov = 65;
    cam.updateProjectionMatrix();
  }
}
