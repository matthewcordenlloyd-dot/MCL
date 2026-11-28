import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import a320 from '@data/aircraft/a320neo.json';
import world from '@data/world.json';
import type { Physics } from '../world/Physics';
import { AircraftModel, type AircraftData } from './AircraftModel';
import { FlightModel, type FlightData, type PilotInput } from './FlightModel';
import { Instruments, type InstrumentExtras } from './Instruments';
import type { Brand } from '../customiser/liveryPainter';
import { seatPlan, FREE_ITEMS, type CabinLayout } from '../economy/cabin';

/** Aircraft data file (data/aircraft/*.json). The A320neo is the reference layout; other types add optional fields. */
export type AircraftSpec = typeof a320 & {
  model: typeof a320.model & {
    rootName?: string;
    interior: Partial<typeof a320.model.interior> & { rootName?: string; lit?: boolean; captainSeat?: number[]; standS?: number; pedestalS?: number; panelS?: number };
    lights?: { wingtip: number[]; tail: number[]; beaconTop: number[]; beaconBottom: number[] };
  };
};
const DEG = Math.PI / 180;


export type GroundState = 'gate' | 'closing' | 'pushing' | 'starting' | 'ready';


/**
 * The aircraft the player boards and flies: flight model + exterior + interior,
 * cockpit instruments and controls, a kinematic physics body you can walk inside,
 * and the gate/pushback sequence.
 */
export class PlayerAircraft {
  readonly fm: FlightModel;
  readonly model: AircraftModel;
  readonly interior = new THREE.Group();
  readonly instruments = new Instruments();
  readonly controls: THREE.Mesh[] = [];
  state: GroundState = 'gate';
  stateMsg = '';
  door = 1; // 0 closed .. 1 open
  doorTarget = 1;
  private body: RAPIER.RigidBody;
  private tug: THREE.Group;
  private timer = 0;
  private pushDist = 0;
  private apMats: Record<string, THREE.MeshBasicMaterial> = {};
  private extras: InstrumentExtras;
  onBridgeRetract: ((t: number) => void) | null = null;
  readonly D: AircraftSpec;
  private g: { noseY: number; zc: number; floor: number; rx: number; rz: number; door: AircraftSpec['livery']['doors'][number] };

  constructor(
    exterior: GLTF,
    interiorGltf: GLTF,
    interiorLightmap: THREE.Texture | null,
    private physics: Physics,
    brand: Brand,
    public registration: string,
    liveryRes: number,
    lodBias: number,
    extras: Omit<InstrumentExtras, 'doorOpen' | 'pushbackState' | 'profile'>,
    spec: AircraftSpec = a320 as AircraftSpec,
  ) {
    this.D = spec;
    const zc = spec.model.centerlineHeight;
    this.g = { noseY: spec.model.noseY, zc, floor: zc - spec.model.cabinFloorBelowCenterline, rx: spec.dimensions.fuselageWidth / 2, rz: spec.dimensions.fuselageHeight / 2, door: spec.livery.doors[0] };
    this.fm = new FlightModel(this.D.flight as unknown as FlightData);
    this.model = new AircraftModel(exterior, this.D as unknown as AircraftData, brand, registration, liveryRes, lodBias);
    this.extras = { ...extras, doorOpen: true, pushbackState: '', profile: 'arcade' };
    this.buildInterior(interiorGltf, interiorLightmap);
    this.model.root.add(this.interior);
    this.tug = makeTug();
    this.tug.visible = false;
    this.model.root.add(this.tug);
    this.body = physics.world.createRigidBody(physics.R.RigidBodyDesc.kinematicPositionBased());
    this.buildColliders();
    this.fm.enginesRunning = false;
    this.fm.n1 = [0, 0];
    this.fm.parkingBrake = true;
  }

  /** Model-space point from fuselage station s (m from nose), lateral x and height y. */
  private sPt(s: number, x: number, y: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, s - this.g.noseY);
  }

  private fusShape(s: number): { f: number; dz: number } {
    const P = this.D.model.profile;
    if (s <= P.nose[P.nose.length - 1][0]) {
      for (let i = 0; i < P.nose.length - 1; i++) {
        const [a, fa, za] = P.nose[i];
        const [b, fb, zb] = P.nose[i + 1];
        if (s >= a && s <= b) {
          const t = (s - a) / (b - a);
          return { f: fa + (fb - fa) * t, dz: za + (zb - za) * t };
        }
      }
      return { f: P.nose[0][1], dz: P.nose[0][2] };
    }
    if (s >= P.tail[0][0]) {
      for (let i = 0; i < P.tail.length - 1; i++) {
        const [a, fa] = P.tail[i];
        const [b, fb] = P.tail[i + 1];
        if (s >= a && s <= b) {
          const f = fa + ((fb - fa) * (s - a)) / (b - a);
          return { f, dz: this.g.rz * (1 - f) * P.tailCentreRise };
        }
      }
    }
    return { f: 1, dz: 0 };
  }

  get root(): THREE.Object3D {
    return this.model.root;
  }

  // ------------------------------------------------------------------ interior
  private buildInterior(g: GLTF, lm: THREE.Texture | null): void {
    const src = g.scene.getObjectByName(this.D.model.interior.rootName ?? 'A320neo_Interior') ?? g.scene;
    const inst = src.clone(true);
    if (lm) {
      lm.flipY = false;
      lm.channel = 0;
    }
    const lmIntensity = Math.PI * (this.D.model.interior.lightmapScale ?? 1) * (world.interiorLightmapExposure ?? 1);
    const litRoot = inst.getObjectByName('interior_lit');
    const tex = this.instruments.textures;
    let seatTemplate: THREE.Object3D | null = null;
    inst.traverse((o) => {
      if (o.name === 'seat_economy') seatTemplate = o;
    });
    inst.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const inSeat = seatTemplate && isChildOf(mesh, seatTemplate);
      if (inSeat) return;
      const baked = isChildOf(mesh, inst.getObjectByName('interior_baked'));
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (litRoot && isChildOf(mesh, litRoot)) {
        // unbaked interior (business jet): lit by the scene plus a soft self-glow for cabin lighting
        mesh.material = new THREE.MeshLambertMaterial({ name: m.name, color: m.color, emissive: m.color.clone().multiplyScalar(/cockpit/.test(m.name) ? 0.35 : 0.5) });
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        return;
      }
      if (baked && lm) {
        // the cockpit gets less daylight in the bake; lift it so instruments and panels read well
        const boost = /cockpit|seat_crew/.test(m.name) ? 2.2 : 1;
        mesh.material = new THREE.MeshBasicMaterial({ name: m.name, color: m.color, lightMap: lm, lightMapIntensity: lmIntensity * boost });
      } else if (tex[m.name]) {
        mesh.material = new THREE.MeshBasicMaterial({ name: m.name, map: tex[m.name], toneMapped: false });
      } else if (m.name.startsWith('ctl_')) {
        const mat = new THREE.MeshBasicMaterial({ name: m.name, color: m.name === 'ctl_amber' ? 0x2a2c30 : m.color.clone().multiplyScalar(0.8) });
        mesh.material = mat;
        const ctl = findCtl(mesh);
        if (ctl && m.name === 'ctl_amber') this.apMats[ctl.name] = mat;
      } else {
        mesh.material = new THREE.MeshBasicMaterial({ name: m.name, color: m.emissive.clone().multiplyScalar(m.emissiveIntensity || 1) });
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const ctl = findCtl(mesh);
      if (ctl) {
        mesh.userData.control = ctl.name;
        this.controls.push(mesh);
      }
    });
    if (seatTemplate) {
      (seatTemplate as THREE.Object3D).visible = false;
      this.seatTemplate = seatTemplate;
      this.setCabin(undefined);
    }
    this.interior.add(inst);
  }

  private seatTemplate: THREE.Object3D | null = null;
  private seatGroup: THREE.Group | null = null;

  /** Rebuild the cabin seats from a cabin-editor layout (undefined = factory layout). */
  setCabin(c: CabinLayout | undefined): void {
    if (!this.seatTemplate) return;
    if (this.seatGroup) {
      this.interior.remove(this.seatGroup);
      this.seatGroup.traverse((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).dispose());
    }
    this.seatGroup = c ? this.makeCustomSeats(this.seatTemplate, c) : this.makeSeats(this.seatTemplate);
    this.interior.add(this.seatGroup);
  }

  /** Seats from a layout, fitted into the cabin between the forward galley and the aft lavatories. */
  private makeCustomSeats(template: THREE.Object3D, c: CabinLayout): THREE.Group {
    const L = this.D.cabin.layout;
    const s0 = L.firstRowS - 0.38;
    const s1 = L.firstRowS + (L.rows - 1) * L.pitchM + L.exitRows.length * L.exitExtraM + 0.4;
    const avail = s1 - s0;
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const extras = new THREE.Group();
    const tint = { J: new THREE.Color(0.75, 0.85, 1.25), W: new THREE.Color(0.95, 1.0, 1.12), Y: new THREE.Color(1, 1, 1) };
    if (c.mode === 'rows') {
      const plan = seatPlan(c, this.D.cabin.cabinWidthM);
      if (!plan.seats.length) return extras;
      const pitch0 = (c.zones[0]?.pitchIn ?? 30) * 0.0254;
      const z0 = plan.seats[0].z - pitch0 / 2;
      const z1 = plan.seats[plan.seats.length - 1].z + 0.4;
      const k = Math.min(1, avail / Math.max(0.1, z1 - z0));
      for (const st of plan.seats) {
        const sc = new THREE.Vector3(st.w / L.seatWidthM, st.cls === 'J' ? 1.1 : 1, st.cls === 'J' ? 1.45 : 1);
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(st.x, this.g.floor, s0 + (st.z - z0) * k - this.g.noseY), new THREE.Quaternion(), sc));
        cols.push(tint[st.cls]);
      }
    } else {
      const len = Math.max(...c.items.map((i) => i.z), 1) + 1;
      const k = Math.min(1, avail / len);
      for (const it of c.items) {
        const d = FREE_ITEMS[it.kind];
        if (!d) continue;
        const pos = new THREE.Vector3(it.x, this.g.floor, s0 + it.z * k - this.g.noseY);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-it.rot * Math.PI) / 180);
        if (it.kind === 'seat') {
          mats.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1.6, 1.05, 1.3)));
          cols.push(new THREE.Color(1.2, 1.05, 0.8));
          continue;
        }
        const h = it.kind === 'bed' ? 0.5 : it.kind === 'shower' || it.kind === 'lav' ? 2.0 : it.kind === 'screen' ? 0.8 : it.kind === 'table' || it.kind === 'meeting' ? 0.75 : 1.0;
        const m = new THREE.Mesh(new THREE.BoxGeometry(d.w, h, d.d), new THREE.MeshBasicMaterial({ color: new THREE.Color(d.color).multiplyScalar(0.7) }));
        m.position.copy(pos).y += it.kind === 'screen' ? 1.1 : h / 2;
        m.quaternion.copy(q);
        extras.add(m);
      }
    }
    template.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mats.length) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      const mat = new THREE.MeshBasicMaterial({ color: m.color.clone().multiplyScalar(1.1), vertexColors: !!mesh.geometry.getAttribute('color') });
      const im = new THREE.InstancedMesh(mesh.geometry, mat, mats.length);
      mats.forEach((mm, i) => {
        im.setMatrixAt(i, mm);
        im.setColorAt(i, cols[i]);
      });
      im.computeBoundingSphere();
      extras.add(im);
    });
    extras.name = 'cabin_seats';
    return extras;
  }

  private makeSeats(template: THREE.Object3D): THREE.Group {
    const L = this.D.cabin.layout;
    const mats: THREE.Matrix4[] = [];
    let s = L.firstRowS;
    for (let r = 0; r < L.rows; r++) {
      if (L.exitRows.includes(r)) s += L.exitExtraM;
      for (const side of [-1, 1]) {
        for (let k = 0; k < L.seatsPerSide; k++) {
          const x = side * (L.aisleM / 2 + L.seatWidthM / 2 + k * L.seatWidthM);
          mats.push(new THREE.Matrix4().makeTranslation(x, this.g.floor, s - this.g.noseY));
        }
      }
      s += L.pitchM;
    }
    const out = new THREE.Group();
    out.name = 'cabin_seats';
    template.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      const mat = new THREE.MeshBasicMaterial({ color: m.color.clone().multiplyScalar(1.1), vertexColors: !!mesh.geometry.getAttribute('color') });
      const im = new THREE.InstancedMesh(mesh.geometry, mat, mats.length);
      mats.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.computeBoundingSphere();
      out.add(im);
    });
    return out;
  }

  // ------------------------------------------------------------------ colliders (model space, kinematic body)
  private buildColliders(): void {
    const R = this.physics.R;
    const W = this.physics.world;
    const box = (c: THREE.Vector3, half: THREE.Vector3, rotZ = 0) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotZ);
      W.createCollider(R.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }), this.body);
    };
    // exterior parts you cannot walk through (not the fuselage: it is hollow, below)
    const v = new THREE.Vector3();
    for (const mesh of this.model.colliders) {
      if (/fuselage|fairing/.test(mesh.name)) continue;
      const pos = mesh.geometry.getAttribute('position');
      const pts = new Float32Array(pos.count * 3);
      mesh.updateMatrix();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrix);
        pts.set([v.x, v.y, v.z], i * 3);
      }
      const d = R.ColliderDesc.convexHull(pts);
      if (d) W.createCollider(d, this.body);
    }
    // hollow fuselage: rings of thin plates, with a gap at door L1
    const seg = 12;
    const step = 1.2;
    for (let s = Math.max(0.9, this.g.door.s - step * 4); s <= (this.D.model.interior.aftBulkheadS ?? 31.8) + 1.2; s += step) {
      const { f, dz } = this.fusShape(s);
      const rx = this.g.rx * f;
      const rz = this.g.rz * f;
      for (let k = 0; k < seg; k++) {
        const th = ((k + 0.5) / seg) * Math.PI * 2;
        const zRel = -rz * Math.cos(th);
        const isDoor = Math.abs(s - this.g.door.s) < 0.1 && Math.sin(th) < 0 && zRel > -this.g.door.sillBelowCenterline - 0.3 && zRel < -this.g.door.sillBelowCenterline + this.g.door.height;
        if (isDoor) continue;
        const c = new THREE.Vector3(rx * Math.sin(th), this.g.zc + dz + zRel, s - this.g.noseY);
        const w = (2 * Math.PI * Math.max(rx, rz)) / seg / 2 + 0.06;
        box(c, new THREE.Vector3(w, 0.08, step / 2 + 0.02), th + Math.PI);
      }
    }
    const bulk = (s: number, gap = 0) => {
      const { f } = this.fusShape(s);
      const hw = this.g.rx * f;
      if (gap <= 0) {
        box(this.sPt(s, 0, this.g.zc), new THREE.Vector3(hw, this.g.rz * f, 0.05));
        return;
      }
      const side = (hw - gap / 2) / 2;
      box(this.sPt(s, -(gap / 2 + side), this.g.zc), new THREE.Vector3(side, this.g.rz, 0.05));
      box(this.sPt(s, gap / 2 + side, this.g.zc), new THREE.Vector3(side, this.g.rz, 0.05));
      box(this.sPt(s, 0, this.g.floor + 1.98 + 0.6), new THREE.Vector3(gap / 2, 0.6, 0.05));
    };
    const I = this.D.model.interior;
    const ck = I.cockpitBulkheadS ?? 4.6;
    const aft = I.aftBulkheadS ?? 31.8;
    bulk(0.8);
    bulk(ck, I.lit ? 0.7 : 0.82);
    bulk(aft);
    // floor
    box(this.sPt((1.5 + aft) / 2, 0, this.g.floor - 0.1), new THREE.Vector3(this.g.rx - 0.1, 0.1, (aft - 1.5) / 2));
    // seat blocks (aisle stays clear), galleys and lavs
    const L = this.D.cabin.layout;
    const s0 = L.firstRowS - 0.35;
    const s1 = L.firstRowS + (L.rows - 1) * L.pitchM + L.exitRows.length * L.exitExtraM + 0.45;
    if (L.rows > 0) for (const side of [-1, 1]) box(this.sPt((s0 + s1) / 2, side * 1.1, this.g.floor + 0.55), new THREE.Vector3(0.77, 0.55, (s1 - s0) / 2));
    const fg = I.forwardGalley;
    if (fg && I.aftLavs && I.aftGalley) {
    box(this.sPt((fg.s[0] + fg.s[1]) / 2, (fg.x[0] + fg.x[1]) / 2, this.g.floor + 1), new THREE.Vector3((fg.x[1] - fg.x[0]) / 2, 1, (fg.s[1] - fg.s[0]) / 2));
    for (const side of [-1, 1]) box(this.sPt((I.aftLavs.s[0] + I.aftLavs.s[1]) / 2, side * 0.88, this.g.floor + 1), new THREE.Vector3(0.47, 1, (I.aftLavs.s[1] - I.aftLavs.s[0]) / 2));
    box(this.sPt((I.aftGalley.s[0] + I.aftGalley.s[1]) / 2, 0, this.g.floor + 0.8), new THREE.Vector3(1.2, 0.8, (I.aftGalley.s[1] - I.aftGalley.s[0]) / 2));
    }
    // cockpit: pedestal, main panel
    box(this.sPt(I.pedestalS ?? 3.5, 0, this.g.floor + 0.3), new THREE.Vector3(0.22, 0.3, 0.45));
    box(this.sPt(I.panelS ?? 2.95, 0, this.g.zc), new THREE.Vector3(this.g.rx * 0.6, 0.42, 0.12));
  }

  /** ILS guidance for the PFD (null when no runway is ahead). */
  setIls(ils: InstrumentExtras['ils']): void {
    this.extras.ils = ils;
  }

  /** Runways and airport label shown on the navigation display. */
  setInstrumentRunways(runways: InstrumentExtras['runways'], label: InstrumentExtras['airportLabel']): void {
    this.extras.runways = runways;
    this.extras.airportLabel = label;
  }

  // ------------------------------------------------------------------ placement & geometry helpers
  /** Park the aircraft with its nose at a stand position (local x/z) facing heading. */
  placeAtStand(nose: [number, number], headingDeg: number, heightAt: (x: number, z: number) => number): void {
    const yaw = -headingDeg * DEG;
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const origin = new THREE.Vector3(nose[0], 0, nose[1]).addScaledVector(fwd, -this.g.noseY);
    const cg = new THREE.Vector3(...this.D.flight.cgModel).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(origin);
    this.fm.heightAt = heightAt;
    this.fm.place(cg, headingDeg);
    this.settle();
    this.state = 'gate';
    this.door = this.doorTarget = 1;
    this.fm.enginesRunning = false;
    this.fm.n1 = [0, 0];
    this.fm.parkingBrake = true;
    this.fm.flapIndex = this.fm.flapPos = 0;
    this.sync();
  }

  /** Let the gear springs settle so the aircraft sits naturally on its wheels. */
  settle(): void {
    const brake = this.fm.parkingBrake;
    this.fm.parkingBrake = true;
    const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, reverse: false, brakes: 1 };
    for (let i = 0; i < 240; i++) this.fm.step(1 / 120, idle);
    this.fm.vel.set(0, 0, 0);
    this.fm.omega.set(0, 0, 0);
    this.fm.parkingBrake = brake;
  }

  /** Door L1 sill (floor level) in world space and its outward direction. */
  doorSill(): { pos: THREE.Vector3; outward: THREE.Vector3 } {
    const pos = this.sPt(this.g.door.s, -this.g.rx, this.g.floor).applyMatrix4(this.root.matrixWorld);
    const outward = new THREE.Vector3(-1, 0, 0).transformDirection(this.root.matrixWorld);
    return { pos, outward };
  }

  /** Captain's eye in world space. */
  eyeWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.D.flight.cockpitEye[0], this.D.flight.cockpitEye[1], this.D.flight.cockpitEye[2]).applyMatrix4(this.root.matrixWorld);
  }

  seatWorld(): THREE.Vector3 {
    const cs = this.D.model.interior.captainSeat ?? [-0.55, 3.92];
    return this.sPt(cs[1], cs[0], this.g.floor + 0.5).applyMatrix4(this.root.matrixWorld);
  }

  /** Where the player stands after leaving the seat (behind the seats). */
  standWorld(): THREE.Vector3 {
    return this.sPt(this.D.model.interior.standS ?? 4.35, 0, this.g.floor + 0.05).applyMatrix4(this.root.matrixWorld);
  }

  // ------------------------------------------------------------------ per-frame
  sync(): void {
    this.fm.modelOrigin(this.root.position);
    this.root.quaternion.copy(this.fm.quat);
    this.root.updateMatrixWorld(true);
    const p = this.root.position;
    const q = this.root.quaternion;
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
    this.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  }

  /** Teleport-style move (keeps the physics body exactly in sync, no sweeping). */
  hardSync(): void {
    this.sync();
    const p = this.root.position;
    const q = this.root.quaternion;
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  }

  update(dt: number, input: PilotInput | null, timeSec: number, cockpitVisible: boolean): void {
    this.groundOps(dt);
    if (this.state === 'pushing') {
      this.pushStep(dt);
    } else if (input) {
      const n = Math.max(1, Math.ceil(dt * 120));
      for (let i = 0; i < n; i++) this.fm.step(dt / n, input);
    }
    this.door += THREE.MathUtils.clamp(this.doorTarget - this.door, -dt / 3, dt / 3);
    this.model.animate(this.fm.gearPos, this.fm.n1, this.door, dt);
    this.animateControls();
    this.sync();
    this.extras.doorOpen = this.door > 0.05;
    this.extras.pushbackState = this.stateMsg;
    this.extras.profile = this.fm.profile;
    if (cockpitVisible) this.instruments.update(this.fm, this.extras, timeSec);
  }

  private animateControls(): void {
    for (const m of this.controls) {
      const ctl = findCtl(m);
      if (!ctl) continue;
      switch (ctl.name) {
        case 'ctl_thrust_L':
        case 'ctl_thrust_R':
          ctl.rotation.x = -this.fm.throttleCmd * 0.65 + 0.1;
          break;
        case 'ctl_flaps':
          ctl.rotation.x = this.fm.flapIndex * 0.14 - 0.2;
          break;
        case 'ctl_speedbrake':
          ctl.rotation.x = this.fm.spoilers * 0.5;
          break;
        case 'ctl_gear':
          ctl.rotation.x = this.fm.gearDown ? 0.45 : -0.45;
          break;
        case 'ctl_park':
          ctl.rotation.y = this.fm.parkingBrake ? Math.PI / 2 : 0;
          break;
      }
    }
    const on = new THREE.Color(0x35ff8a);
    const off = new THREE.Color(0x2a2c30);
    this.apMats.ctl_ap1?.color.copy(this.fm.ap.ap ? on : off);
    this.apMats.ctl_athr?.color.copy(this.fm.ap.athr ? on : off);
  }

  /** Cockpit control clicked: button 0 = increase / toggle, 2 = decrease. */
  clickControl(name: string, button: number, big: boolean): string {
    const fm = this.fm;
    const ap = fm.ap;
    const sgn = button === 2 ? -1 : 1;
    switch (name) {
      case 'ctl_gear':
        if (!fm.onGround || !fm.gearDown) fm.gearDown = !fm.gearDown;
        return `Gear ${fm.gearDown ? 'DOWN' : 'UP'}`;
      case 'ctl_flaps':
        fm.flapIndex = THREE.MathUtils.clamp(fm.flapIndex + sgn, 0, fm.d.flaps.length - 1);
        return `Flaps ${fm.d.flaps[fm.flapIndex].name}`;
      case 'ctl_speedbrake':
        fm.spoilers = fm.spoilers > 0 ? 0 : 1;
        return `Speed brake ${fm.spoilers ? 'EXTENDED' : 'RETRACTED'}`;
      case 'ctl_park':
        fm.parkingBrake = !fm.parkingBrake;
        return `Parking brake ${fm.parkingBrake ? 'SET' : 'RELEASED'}`;
      case 'ctl_thrust_L':
      case 'ctl_thrust_R':
        return 'Thrust levers: use the throttle keys';
      case 'ctl_ap1':
        ap.ap = !ap.ap;
        if (ap.ap) {
          ap.hdgDeg = Math.round(fm.headingDeg);
          ap.vmode = Math.abs(ap.altFt - fm.altFt) > 200 ? 'VS' : 'ALT';
          ap.vsFpm = ap.altFt > fm.altFt ? 1500 : -1500;
        }
        return `AP1 ${ap.ap ? 'ON' : 'OFF'}`;
      case 'ctl_athr':
        ap.athr = !ap.athr;
        if (ap.athr) ap.spdKt = Math.round(Math.max(fm.iasKt, 140));
        return `A/THR ${ap.athr ? 'ON' : 'OFF'}`;
      case 'ctl_spd':
        ap.spdKt = THREE.MathUtils.clamp(ap.spdKt + sgn * (big ? 10 : 1), 100, 350);
        return `SPD ${ap.spdKt}`;
      case 'ctl_hdg':
        ap.hdgDeg = (ap.hdgDeg + sgn * (big ? 10 : 1) + 360) % 360;
        return `HDG ${String(Math.round(ap.hdgDeg)).padStart(3, '0')}`;
      case 'ctl_alt':
        ap.altFt = THREE.MathUtils.clamp(ap.altFt + sgn * (big ? 1000 : 100), 0, 39000);
        if (ap.ap) {
          ap.vmode = 'VS';
          ap.vsFpm = (ap.altFt > fm.altFt ? 1 : -1) * Math.max(Math.abs(ap.vsFpm), 1000);
        }
        return `ALT ${ap.altFt}`;
      case 'ctl_vs':
        ap.vsFpm = THREE.MathUtils.clamp(ap.vsFpm + sgn * (big ? 500 : 100), -6000, 6000);
        if (ap.ap) ap.vmode = 'VS';
        return `V/S ${ap.vsFpm > 0 ? '+' : ''}${ap.vsFpm}`;
    }
    return '';
  }

  // ------------------------------------------------------------------ gate & pushback
  requestPushback(): string {
    if (this.state !== 'gate') return this.state === 'ready' ? 'Pushback already complete' : 'Pushback in progress';
    this.state = 'closing';
    this.timer = 0;
    this.doorTarget = 0;
    this.stateMsg = 'Closing door';
    return 'Pushback requested: closing door, retracting jet bridge';
  }

  private groundOps(dt: number): void {
    this.timer += dt;
    if (this.state === 'closing') {
      this.onBridgeRetract?.(Math.min(1, this.timer / 4));
      if (this.timer > 4.5) {
        this.state = 'pushing';
        this.timer = 0;
        this.pushDist = 0;
        this.fm.parkingBrake = false;
        this.tug.visible = true;
        this.stateMsg = 'Pushback in progress';
      }
    } else if (this.state === 'starting') {
      // engine 2 then engine 1, like a real start sequence (simplified to ~12 s)
      if (this.timer > 1 && !this.fm.enginesRunning) this.fm.enginesRunning = true;
      if (this.timer < 12) this.fm.n1 = this.fm.n1.map((n, i) => Math.min(n, Math.max(0, (this.timer - (i === 1 ? 1 : 5)) / 7) * 0.2));
      this.stateMsg = this.timer < 5 ? 'Starting engine 2' : this.timer < 12 ? 'Starting engine 1' : '';
      if (this.timer >= 12 && this.fm.n1[0] > 0.04) {
        this.state = 'ready';
        this.stateMsg = '';
      }
    }
  }

  /** Start the engines where you are (no pushback): used by aircraft parked nose-out. */
  startEngines(): void {
    this.state = 'starting';
    this.timer = 0;
    this.door = this.doorTarget = 0;
    this.stateMsg = 'Starting engines';
  }

  private pushStep(dt: number): void {
    const speed = 1.6; // m/s
    const ds = speed * dt;
    const fm = this.fm;
    const back = fm.forward.clone().multiplyScalar(-1).setY(0).normalize();
    const turning = this.pushDist > 26;
    fm.pos.addScaledVector(back, ds);
    if (turning) {
      // swing the tail west so the nose ends up pointing east along the taxilane
      fm.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ds / 24));
    }
    this.pushDist += ds;
    fm.vel.copy(back).multiplyScalar(speed);
    fm.pos.y = fm.heightAt(fm.pos.x, fm.pos.z) + fm.d.cgModel[1] - 0.12;
    this.tug.position.set(0, 0, -this.D.dimensions.wheelbase - 3.2);
    const hdg = fm.headingDeg;
    if (turning && hdg > 88 && hdg < 180) {
      fm.vel.set(0, 0, 0);
      fm.omega.set(0, 0, 0);
      fm.parkingBrake = true;
      this.tug.visible = false;
      this.state = 'starting';
      this.timer = 0;
      this.stateMsg = 'Starting engines';
      this.settle();
    }
  }
}

function isChildOf(o: THREE.Object3D, parent: THREE.Object3D | null | undefined): boolean {
  if (!parent) return false;
  let p: THREE.Object3D | null = o;
  while (p) {
    if (p === parent) return true;
    p = p.parent;
  }
  return false;
}

function findCtl(o: THREE.Object3D): THREE.Object3D | null {
  let p: THREE.Object3D | null = o;
  while (p) {
    if (p.name.startsWith('ctl_')) return p;
    p = p.parent;
  }
  return null;
}

function makeTug(): THREE.Group {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 5.2), yellow);
  body.position.y = 0.8;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.2), dark);
  cab.position.set(-0.6, 1.75, -1.6);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 3), dark);
  bar.position.set(0, 0.5, 3.6);
  for (const m of [body, cab, bar]) {
    m.castShadow = true;
    g.add(m);
  }
  for (const [x, z] of [[-1.1, -1.8], [1.1, -1.8], [-1.1, 1.8], [1.1, 1.8]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.4, 12).rotateZ(Math.PI / 2), dark);
    w.position.set(x, 0.45, z);
    g.add(w);
  }
  g.name = 'tug';
  return g;
}
