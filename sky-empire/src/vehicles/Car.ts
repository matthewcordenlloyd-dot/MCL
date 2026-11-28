import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../world/Physics';

export type CarStyle = 'saloon' | 'suv' | 'gt' | 'roadster' | 'hyper' | 'classic';
export interface CarSpec { style: CarStyle; topKmh: number; accel: number }

/** Side profiles (x along the car from the front bumper, y up), metres. Roof and glass come from the upper points. */
const PROFILES: Record<CarStyle, { len: number; width: number; body: [number, number][]; cabin: [number, number][]; wheelR: number; ride: number }> = {
  saloon: { len: 4.95, width: 1.95, wheelR: 0.36, ride: 0.16, body: [[0, 0.35], [0.05, 0.72], [1.2, 0.86], [3.9, 0.9], [4.95, 0.82], [4.95, 0.35]], cabin: [[1.3, 0.86], [2.0, 1.42], [3.5, 1.42], [4.3, 0.9]] },
  suv: { len: 4.9, width: 2.0, wheelR: 0.42, ride: 0.26, body: [[0, 0.45], [0.05, 0.98], [1.0, 1.12], [4.8, 1.12], [4.9, 1.05], [4.9, 0.45]], cabin: [[1.1, 1.12], [1.6, 1.82], [4.6, 1.82], [4.75, 1.12]] },
  gt: { len: 4.75, width: 1.98, wheelR: 0.36, ride: 0.12, body: [[0, 0.32], [0.05, 0.62], [1.6, 0.8], [4.3, 0.82], [4.75, 0.72], [4.75, 0.34]], cabin: [[1.9, 0.8], [2.7, 1.25], [3.5, 1.22], [4.4, 0.82]] },
  roadster: { len: 4.5, width: 1.96, wheelR: 0.35, ride: 0.1, body: [[0, 0.3], [0.05, 0.58], [1.7, 0.72], [4.4, 0.85], [4.5, 0.78], [4.5, 0.32]], cabin: [[1.6, 0.72], [2.05, 1.12], [2.9, 1.14], [3.9, 0.84]] },
  hyper: { len: 4.7, width: 2.05, wheelR: 0.36, ride: 0.08, body: [[0, 0.26], [0.05, 0.48], [1.5, 0.66], [4.5, 0.82], [4.7, 0.9], [4.7, 0.3]], cabin: [[1.4, 0.66], [2.1, 1.12], [2.9, 1.14], [4.2, 0.82]] },
  classic: { len: 4.4, width: 1.7, wheelR: 0.34, ride: 0.14, body: [[0, 0.38], [0.05, 0.72], [1.4, 0.82], [3.8, 0.84], [4.4, 0.76], [4.4, 0.38]], cabin: [[1.8, 0.82], [2.3, 1.3], [3.2, 1.3], [3.9, 0.84]] },
};

/** Build a car mesh: extruded body and cabin profiles, dark glass, wheels and lights. Faces -Z (forward). */
export function makeCarMesh(style: CarStyle, color: string): { group: THREE.Group; wheels: THREE.Object3D[]; front: THREE.Object3D[] } {
  const P = PROFILES[style];
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.6, envMapIntensity: 1.2 });
  const glass = new THREE.MeshStandardMaterial({ color: '#0e141c', roughness: 0.05, metalness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: '#141518', roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#c8ccd2', roughness: 0.2, metalness: 1 });
  const extrude = (pts: [number, number][], width: number, mat: THREE.Material, bevel: number) => {
    const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(sh, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 4 });
    geo.translate(0, 0, -(width - bevel * 2) / 2);
    geo.rotateY(-Math.PI / 2); // profile x (front bumper = 0) now runs along +z
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  };
  const body = extrude(P.body, P.width, paint, 0.08);
  const cabin = extrude(P.cabin, P.width * 0.84, glass, 0.05);
  // roof skin over the glass (body colour), a little narrower and higher
  const roofPts = P.cabin.map(([x, y], i) => [x + (i === 0 ? 0.25 : i === P.cabin.length - 1 ? -0.25 : 0), y + (i === 0 || i === P.cabin.length - 1 ? 0.3 : 0.02)] as [number, number]);
  const roof = extrude(roofPts, P.width * 0.78, paint, 0.04);
  for (const m of [body, cabin, roof]) {
    m.position.z = -P.len / 2; // centre the car on its origin
    g.add(m);
  }
  roof.visible = style !== 'roadster';
  if (style === 'roadster') cabin.scale.y = 0.6;
  const wheels: THREE.Object3D[] = [];
  const front: THREE.Object3D[] = [];
  const tyreG = new THREE.CylinderGeometry(P.wheelR, P.wheelR, 0.28, 20).rotateZ(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(P.wheelR * 0.62, P.wheelR * 0.62, 0.3, 12).rotateZ(Math.PI / 2);
  const axle = [P.len * 0.19, P.len * 0.8];
  for (const [i, s] of axle.entries()) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (P.width / 2 - 0.16), P.wheelR, s - P.len / 2);
      const w = new THREE.Group();
      w.add(new THREE.Mesh(tyreG, dark), new THREE.Mesh(rimG, chrome));
      pivot.add(w);
      g.add(pivot);
      wheels.push(w);
      if (i === 0) front.push(pivot);
    }
  }
  // after centring, the front bumper is at z = -len/2 (cars face -Z)
  const lightG = new THREE.BoxGeometry(0.42, 0.1, 0.05);
  const head = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2) });
  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.05, 0.05) });
  const yLight = P.body[1][1] - 0.05;
  for (const side of [-1, 1]) {
    const h = new THREE.Mesh(lightG, head);
    h.position.set(side * (P.width / 2 - 0.35), yLight, -P.len / 2 - 0.02);
    const t = new THREE.Mesh(lightG, tail);
    t.position.set(side * (P.width / 2 - 0.35), P.body[P.body.length - 2][1] - 0.12, P.len / 2 + 0.02);
    g.add(h, t);
  }
  return { group: g, wheels, front };
}

/**
 * A drivable car: arcade handling on flat ground, collisions through a Rapier kinematic character
 * controller (cuboid), so it stops at walls, buildings and aircraft.
 */
export class Car {
  readonly root = new THREE.Group();
  private wheels: THREE.Object3D[];
  private front: THREE.Object3D[];
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private ctrl: RAPIER.KinematicCharacterController;
  speed = 0;
  heading = 0; // radians, 0 = facing -Z
  private steer = 0;
  private velY = 0;
  readonly len: number;

  constructor(private physics: Physics, readonly spec: CarSpec, color: string) {
    const m = makeCarMesh(spec.style, color);
    this.root.add(m.group);
    this.wheels = m.wheels;
    this.front = m.front;
    const P = PROFILES[spec.style];
    this.len = P.len;
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -300, 0));
    this.collider = physics.world.createCollider(R.ColliderDesc.cuboid(P.width / 2, 0.55, P.len / 2).setTranslation(0, 0.6, 0), this.body);
    this.ctrl = physics.world.createCharacterController(0.03);
    this.ctrl.enableAutostep(0.25, 0.3, false);
    this.ctrl.enableSnapToGround(0.4);
    this.ctrl.setMaxSlopeClimbAngle(0.5);
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  place(pos: THREE.Vector3, headingRad: number): void {
    this.body.setTranslation({ x: pos.x, y: pos.y + 0.05, z: pos.z }, true);
    this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + 0.05, z: pos.z });
    this.heading = headingRad;
    this.speed = 0;
    this.sync();
  }

  /** Throttle/brake -1..1, steer -1 (left)..1 (right). */
  update(dt: number, throttle: number, steerIn: number, handbrake: boolean): void {
    const top = this.spec.topKmh / 3.6;
    const acc = 27.8 / this.spec.accel;
    const v = this.speed;
    if (throttle > 0) this.speed += (v < 0 ? 12 : acc * (1 - Math.max(0, v) / top) ** 0.7) * throttle * dt;
    else if (throttle < 0) this.speed += (v > 0.5 ? -11 : -4) * -throttle * dt;
    this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), (0.4 + 0.0009 * v * v) * dt * 3);
    if (handbrake) this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 8 * dt);
    this.speed = THREE.MathUtils.clamp(this.speed, -9, top);
    const maxSteer = THREE.MathUtils.lerp(0.6, 0.07, Math.min(1, Math.abs(this.speed) / 60));
    this.steer = THREE.MathUtils.damp(this.steer, steerIn * maxSteer, 8, dt);
    const wheelbase = this.len * 0.61;
    this.heading -= (this.speed / wheelbase) * Math.tan(this.steer) * dt;
    this.velY -= 9.81 * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    const want = { x: fwd.x * this.speed * dt, y: this.velY * dt, z: fwd.z * this.speed * dt };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
    this.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    this.ctrl.computeColliderMovement(this.collider, want);
    const got = this.ctrl.computedMovement();
    if (this.ctrl.computedGrounded()) this.velY = 0;
    const planned = Math.hypot(want.x, want.z);
    const moved = Math.hypot(got.x, got.z);
    if (planned > 0.02 && moved < planned * 0.5) this.speed *= 0.25; // hit something
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + got.x, y: t.y + got.y, z: t.z + got.z });
    this.body.setTranslation({ x: t.x + got.x, y: t.y + got.y, z: t.z + got.z }, true);
    // wheels
    const r = PROFILES[this.spec.style].wheelR;
    for (const w of this.wheels) w.rotation.x -= (this.speed / r) * dt;
    for (const f of this.front) f.rotation.y = -this.steer;
    this.sync();
  }

  private sync(): void {
    const t = this.body.translation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.rotation.y = this.heading;
  }

  /** Where the driver gets out (left side). */
  doorWorld(): THREE.Vector3 {
    const left = new THREE.Vector3(-Math.cos(this.heading), 0, Math.sin(this.heading));
    return this.position.addScaledVector(left, 1.8);
  }

  park(): void {
    this.body.setTranslation({ x: 0, y: -300, z: 0 }, true);
    this.root.visible = false;
  }

  dispose(): void {
    this.physics.world.removeCollider(this.collider, false);
    this.physics.world.removeRigidBody(this.body);
    this.physics.world.removeCharacterController(this.ctrl);
    this.root.removeFromParent();
  }
}
