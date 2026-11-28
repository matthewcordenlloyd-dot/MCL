import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import world from '@data/world.json';
import controls from '@data/controls.json';
import type { Physics } from '../world/Physics';
import type { Input } from './Input';
import type { CharacterLook } from '../economy/types';
import { applyLook } from '../customiser/characterLook';
import type { Brand } from '../customiser/liveryPainter';

const P = world.player;

/**
 * The walking player: a Rapier kinematic character controller (capsule), switchable
 * first/third-person camera with wall collision, and Idle/Walk/Run animation blending.
 */
export class Player {
  readonly object = new THREE.Group();
  readonly model: THREE.Object3D;
  thirdPerson = true;
  sensitivity = 1;
  invertY = false;

  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private ctrl: RAPIER.KinematicCharacterController;
  private velY = 0;
  private grounded = false;
  private yaw = 0;      // camera yaw (radians, 0 = facing north / -Z)
  private pitch = -0.12;
  private camDist: number = P.thirdPersonDistance;
  private camDistSmoothed: number = P.thirdPersonDistance;
  private facing = 0;   // body yaw
  private speed = 0;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction> = {};
  private current = 'Idle';
  private blob: THREE.Mesh;
  private postAnim: () => void = () => {};

  constructor(private physics: Physics, gltf: GLTF) {
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 2, 0));
    const half = P.capsuleHalfHeight;
    this.collider = physics.world.createCollider(R.ColliderDesc.capsule(half, P.capsuleRadius).setTranslation(0, half + P.capsuleRadius, 0), this.body);
    this.ctrl = physics.world.createCharacterController(0.02);
    this.ctrl.enableAutostep(0.4, 0.25, true);
    this.ctrl.enableSnapToGround(0.35);
    this.ctrl.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(46));
    this.ctrl.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(35));
    this.ctrl.setApplyImpulsesToDynamicBodies(true);

    this.model = cloneSkinned(gltf.scene);
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
      }
    });
    this.object.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(clip.name === 'Idle' ? 1 : 0);
      this.actions[clip.name] = a;
    }
    this.blob = makeBlobShadow();
    this.object.add(this.blob);
  }

  /** Character creator look (outfit in airline colours, proportions, hair, cap). */
  setLook(look: CharacterLook, brand: Brand): void {
    this.postAnim = applyLook(this.model, look, brand);
  }

  /** Camera yaw in radians (0 = facing -Z). */
  facingYaw(): number {
    return this.yaw;
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /** Move the capsule out of the way while the player is seated in an aircraft. */
  park(): void {
    this.body.setTranslation({ x: 0, y: -200, z: 0 }, true);
    this.object.visible = false;
  }

  teleport(pos: number[], headingDeg: number): void {
    this.object.visible = true;
    this.body.setTranslation({ x: pos[0], y: pos[1] + 0.1, z: pos[2] }, true);
    this.body.setNextKinematicTranslation({ x: pos[0], y: pos[1] + 0.1, z: pos[2] });
    this.velY = 0;
    this.yaw = -THREE.MathUtils.degToRad(headingDeg);
    this.facing = this.yaw;
    this.pitch = -0.12;
  }

  update(dt: number, input: Input, camera: THREE.PerspectiveCamera): void {
    const W = input.walking;
    // ---- look
    const sens = controls.mouse.sensitivity * this.sensitivity;
    const PW = input.padWalking;
    this.yaw -= input.mouseDX * sens + input.padAxes[2] * 2.4 * dt;
    this.pitch -= (input.mouseDY * sens + input.padAxes[3] * 1.8 * dt) * (this.invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.35, 1.35);
    if (input.wheel !== 0 && this.thirdPerson) this.camDist = THREE.MathUtils.clamp(this.camDist + input.wheel * 0.5, 1.6, 12);
    if (input.hit(W, 'toggleView', PW)) this.thirdPerson = !this.thirdPerson;

    // ---- move (camera-relative)
    let fx = 0;
    let fz = 0;
    if (input.held(W, 'forward')) fz -= 1;
    if (input.held(W, 'back')) fz += 1;
    if (input.held(W, 'left')) fx -= 1;
    if (input.held(W, 'right')) fx += 1;
    if (Math.abs(input.padAxes[0]) > 0 || Math.abs(input.padAxes[1]) > 0) {
      fx = input.padAxes[0];
      fz = input.padAxes[1];
    }
    const moving = Math.abs(fx) > 0.05 || Math.abs(fz) > 0.05;
    const run = input.held(W, 'run', PW) || Math.hypot(fx, fz) > 0.95 && input.padConnected && !input.held(W, 'forward');
    const target = moving ? (run ? P.runSpeed : P.walkSpeed) : 0;
    this.speed = THREE.MathUtils.damp(this.speed, target, 8, dt);
    const dir = new THREE.Vector3(fx, 0, fz);
    if (moving) dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    if (moving) {
      const want = Math.atan2(-dir.x, -dir.z);
      this.facing = dampAngle(this.facing, want, 12, dt);
    }
    if (this.grounded && input.hit(W, 'jump', PW)) this.velY = P.jumpSpeed;
    this.velY -= P.gravity * dt;
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.facing);
    const horiz = moving ? dir : fwd.multiplyScalar(this.speed > 0.05 ? 1 : 0);
    const desired = { x: horiz.x * this.speed * dt, y: this.velY * dt, z: horiz.z * this.speed * dt };
    this.ctrl.computeColliderMovement(this.collider, desired);
    const mv = this.ctrl.computedMovement();
    this.grounded = this.ctrl.computedGrounded();
    if (this.grounded && this.velY < 0) this.velY = 0;
    const t = this.body.translation();
    const next = { x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z };
    if (next.y < -5) next.y = 1; // safety net
    this.body.setNextKinematicTranslation(next);

    // ---- visual
    this.object.position.set(next.x, next.y, next.z);
    this.model.rotation.y = this.facing;
    this.model.visible = this.thirdPerson;
    this.blob.visible = this.thirdPerson;
    this.animate(dt);

    // ---- camera
    const eye = new THREE.Vector3(next.x, next.y + P.eyeHeight, next.z);
    const look = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(look);
    if (this.thirdPerson) {
      const pivot = new THREE.Vector3(next.x, next.y + 1.55, next.z);
      const back = new THREE.Vector3(0.35, 0, 1).applyEuler(look).normalize();
      // keep the camera out of walls: ray from the pivot toward the camera
      const R = this.physics.R;
      const ray = new R.Ray(pivot, back);
      const hit = this.physics.world.castRay(ray, this.camDist, true, undefined, undefined, this.collider);
      const maxD = hit ? Math.max(0.4, hit.timeOfImpact - 0.25) : this.camDist;
      this.camDistSmoothed = maxD < this.camDistSmoothed ? maxD : THREE.MathUtils.damp(this.camDistSmoothed, maxD, 6, dt);
      camera.position.copy(pivot).addScaledVector(back, this.camDistSmoothed);
      if (camera.position.y < 0.15) camera.position.y = 0.15;
    } else {
      camera.position.copy(eye);
    }
  }

  private animate(dt: number): void {
    const s = this.speed;
    const want = s < 0.25 ? 'Idle' : s < 3.2 ? 'Walk' : 'Run';
    if (want !== this.current) {
      const from = this.actions[this.current];
      const to = this.actions[want];
      if (from && to) {
        to.reset().setEffectiveWeight(1).play();
        to.crossFadeFrom(from, 0.25, true);
      }
      this.current = want;
    }
    // Match the stride to the actual speed so feet don't slide.
    if (this.actions.Walk) this.actions.Walk.timeScale = THREE.MathUtils.clamp(s / P.walkSpeed, 0.5, 2);
    if (this.actions.Run) this.actions.Run.timeScale = THREE.MathUtils.clamp(s / P.runSpeed, 0.6, 1.5);
    this.mixer.update(dt);
    this.postAnim();
  }
}

function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}

function makeBlobShadow(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -24 }),
  );
  m.position.y = 0.05;
  m.renderOrder = 3;
  return m;
}
