import * as THREE from 'three';

/**
 * Six-degree-of-freedom flight model with ground handling.
 *
 * Body axes (three.js): x = right, y = up, z = aft (the nose points along -z).
 * Conventions for pilot inputs: pitch +1 = pull (nose up), roll +1 = right, yaw +1 = right.
 *
 * Two control profiles share the same physics:
 *  - arcade:     attitude-rate control, auto-trim, auto-coordination, stall protection,
 *                faster engines, gentle ground handling.
 *  - realistic:  Airbus-style normal law (stick = load factor / roll rate, protections),
 *                or direct law when protections are switched off (full stalls possible).
 */

export interface FlightData {
  massEmptyKg: number;
  defaultFuelKg: number;
  defaultPayloadKg: number;
  inertiaKgM2: { pitch: number; yaw: number; roll: number };
  wingAreaM2: number;
  spanM: number;
  macM: number;
  aero: Record<string, number>;
  flaps: { name: string; dCL: number; dCD: number; dAlphaStallDeg: number; vmaxKt: number }[];
  engines: { count: number; staticThrustN: number; idleFraction: number; reverseFraction: number; spoolSeconds: number; fuelKgPerSecPerKN: number; x: number[] };
  gear: {
    retractSeconds: number;
    points: { id: string; pos: number[]; k: number; c: number; steer: boolean; brake: boolean }[];
    rollingFriction: number;
    brakeFriction: number;
    lateralFriction: number;
    nosewheelMaxDegLowSpeed: number;
    nosewheelMaxDegHighSpeed: number;
  };
  structure: { points: number[][] };
  cockpitEye: number[];
  cgModel: number[];
  arcade: { maxPitchRateDeg: number; maxRollRateDeg: number; maxBankDeg: number; spoolSeconds: number; autoCoordinate: boolean };
  normalLaw: { maxRollRateDeg: number; bankHoldLimitDeg: number; maxBankDeg: number; nzMax: number; nzMin: number; alphaProtDeg: number; alphaMaxDeg: number };
}

export type Profile = 'arcade' | 'realistic';

export interface PilotInput {
  pitch: number; // -1..1
  roll: number;
  yaw: number;
  throttle: number; // 0..1 (lever)
  reverse: boolean;
  brakes: number; // 0..1
}

export interface Autopilot {
  ap: boolean;
  athr: boolean;
  spdKt: number;
  hdgDeg: number;
  altFt: number;
  vsFpm: number;
  mode: 'HDG' | 'NAV';
  vmode: 'ALT' | 'VS' | 'OP';
}

const DEG = Math.PI / 180;
const KT = 0.514444;
const FT = 0.3048;
const G = 9.80665;

export function isaDensity(altM: number): number {
  const h = Math.max(-500, Math.min(altM, 20000));
  if (h < 11000) {
    const T = 288.15 - 0.0065 * h;
    return 1.225 * Math.pow(T / 288.15, 4.2559);
  }
  return 0.3639 * Math.exp(-(h - 11000) / 6341.6);
}

function speedOfSound(altM: number): number {
  const T = altM < 11000 ? 288.15 - 0.0065 * altM : 216.65;
  return Math.sqrt(1.4 * 287.05 * T);
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

export class FlightModel {
  // state
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(); // world m/s
  readonly quat = new THREE.Quaternion();
  readonly omega = new THREE.Vector3(); // body rad/s (x pitch-up, y yaw-left, z roll-left)
  readonly wind = new THREE.Vector3();
  profile: Profile = 'arcade';
  protections = true;

  // systems
  n1 = [0.2, 0.2]; // 0..1
  enginesRunning = true;
  flapIndex = 0;
  flapPos = 0; // animated, in index units
  gearDown = true;
  gearPos = 1; // 1 = down
  spoilers = 0;
  parkingBrake = true;
  fuelKg: number;
  payloadKg: number;
  readonly ap: Autopilot = { ap: false, athr: false, spdKt: 250, hdgDeg: 270, altFt: 5000, vsFpm: 1500, mode: 'HDG', vmode: 'ALT' };

  // controls actually applied (for animation / instruments)
  elevator = 0;
  aileron = 0;
  rudder = 0;
  steerDeg = 0;
  throttleCmd = 0;

  // derived (updated every step)
  ias = 0; // m/s
  tas = 0;
  mach = 0;
  alpha = 0;
  beta = 0;
  nz = 1;
  onGround = true;
  gearCompression = [0, 0, 0];
  stallWarning = false;
  crashed = false;
  touchdownFpm = 0;

  private pitchTrim = 0;
  private gammaHold = 0;
  private bankHold = 0;
  private lastIas = 0;
  private wasOnGround = true;
  heightAt: (x: number, z: number) => number = () => 0;
  /** Converts local y to altitude above mean sea level (metres). */
  altitudeMsl: (pos: THREE.Vector3) => number = (p) => p.y;

  constructor(readonly d: FlightData) {
    this.fuelKg = d.defaultFuelKg;
    this.payloadKg = d.defaultPayloadKg;
  }

  get mass(): number {
    return this.d.massEmptyKg + this.fuelKg + this.payloadKg;
  }

  // ------------------------------------------------------------------ derived getters
  get forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
  }

  get headingDeg(): number {
    const f = this.forward;
    return (Math.atan2(f.x, -f.z) / DEG + 360) % 360;
  }

  get pitchDeg(): number {
    return Math.asin(THREE.MathUtils.clamp(this.forward.y, -1, 1)) / DEG;
  }

  get bankDeg(): number {
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    return Math.atan2(-r.y, u.y) / DEG;
  }

  get altFt(): number {
    return this.altitudeMsl(this.pos) / FT;
  }

  get gammaDeg(): number {
    const sp = this.vel.length();
    return sp > 1 ? Math.asin(THREE.MathUtils.clamp(this.vel.y / sp, -1, 1)) / DEG : 0;
  }

  get vsFpm(): number {
    return (this.vel.y / FT) * 60;
  }

  get groundSpeedKt(): number {
    return Math.hypot(this.vel.x, this.vel.z) / KT;
  }

  get iasKt(): number {
    return this.ias / KT;
  }

  get trackDeg(): number {
    return (Math.atan2(this.vel.x, -this.vel.z) / DEG + 360) % 360;
  }

  /** World position of the model origin (on the ground under the main gear). */
  modelOrigin(out = new THREE.Vector3()): THREE.Vector3 {
    const cg = this.d.cgModel;
    return out.set(-cg[0], -cg[1], -cg[2]).applyQuaternion(this.quat).add(this.pos);
  }

  /** 1-g stall speed (IAS, knots) for the current weight and flap setting. */
  stallSpeedKt(): number {
    const i = Math.round(this.flapPos);
    const clmax = this.d.aero.CLmaxClean + (this.d.flaps[i]?.dCL ?? 0);
    return Math.sqrt((2 * this.mass * G) / (1.225 * this.d.wingAreaM2 * clmax)) / KT;
  }

  /** Maximum speed for the current configuration (flaps / gear limits), knots. */
  maxSpeedKt(): number {
    let v = 350;
    if (this.flapIndex > 0 || this.flapPos > 0.05) v = Math.min(v, this.d.flaps[Math.max(this.flapIndex, Math.ceil(this.flapPos - 0.05))].vmaxKt);
    if (this.gearPos > 0.05) v = Math.min(v, 280);
    return v;
  }

  // ------------------------------------------------------------------ placement
  place(pos: THREE.Vector3, headingDeg: number, speedKt = 0, onGround = true): void {
    this.pos.copy(pos);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -headingDeg * DEG);
    this.vel.copy(this.forward).multiplyScalar(speedKt * KT);
    this.omega.set(0, 0, 0);
    this.onGround = onGround;
    this.crashed = false;
    this.pitchTrim = 0;
    this.gammaHold = 0;
    this.bankHold = 0;
    if (onGround) {
      // pos is the centre of gravity; start with the gear slightly compressed to avoid a bounce
      this.pos.y = this.heightAt(pos.x, pos.z) + this.d.cgModel[1] - 0.12;
    }
  }

  // ------------------------------------------------------------------ main step
  step(dt: number, input: PilotInput): void {
    if (this.crashed) return;
    const d = this.d;
    const A = d.aero;
    const m = this.mass;
    const altM = this.altitudeMsl(this.pos);
    const rho = isaDensity(altM);

    // ---- air data in body axes
    _qi.copy(this.quat).invert();
    const vAir = _v.copy(this.vel).sub(this.wind);
    const vb = vAir.clone().applyQuaternion(_qi);
    const V = Math.max(vb.length(), 0.01);
    this.lastIas = this.ias;
    this.tas = V;
    this.ias = V * Math.sqrt(rho / 1.225);
    this.mach = V / speedOfSound(altM);
    this.alpha = Math.atan2(-vb.y, -vb.z);
    this.beta = Math.asin(THREE.MathUtils.clamp(vb.x / V, -1, 1));
    const qbar = 0.5 * rho * V * V;
    const S = d.wingAreaM2;
    const b = d.spanM;
    const c = d.macM;

    // ---- systems: flaps, gear, engines
    const flapTarget = this.flapIndex;
    this.flapPos += THREE.MathUtils.clamp(flapTarget - this.flapPos, -dt / 4, dt / 4) ;
    const gTarget = this.gearDown ? 1 : 0;
    this.gearPos += THREE.MathUtils.clamp(gTarget - this.gearPos, -dt / d.gear.retractSeconds, dt / d.gear.retractSeconds);
    const flapLo = Math.floor(this.flapPos);
    const flapHi = Math.min(flapLo + 1, d.flaps.length - 1);
    const ft = this.flapPos - flapLo;
    const fl = (k: 'dCL' | 'dCD' | 'dAlphaStallDeg') => d.flaps[flapLo][k] * (1 - ft) + d.flaps[flapHi][k] * ft;

    // ---- control laws -> surface deflections (-1..1)
    this.applyControlLaws(dt, input);

    // ---- aerodynamics
    const alphaStall = (A.alphaStallDeg + fl('dAlphaStallDeg')) * DEG;
    let CL: number;
    const CLlin = A.CL0 + A.CLalpha * this.alpha + fl('dCL');
    const CLmax = A.CLmaxClean + fl('dCL');
    if (Math.abs(this.alpha) < alphaStall) {
      CL = Math.min(CLlin, CLmax);
    } else {
      // post-stall: lift collapses then recovers slowly toward a flat-plate value
      const over = (Math.abs(this.alpha) - alphaStall) / (10 * DEG);
      const peak = Math.sign(this.alpha) * CLmax;
      CL = peak * (1 - A.postStallCLDrop * Math.min(1, over)) + Math.sign(this.alpha) * 0.9 * Math.sin(2 * Math.abs(this.alpha)) * Math.min(1, over) * 0.3;
    }
    this.stallWarning = this.alpha > alphaStall - 2 * DEG && !this.onGround;
    // ground effect reduces induced drag and adds a little lift
    const agl = this.pos.y - this.heightAt(this.pos.x, this.pos.z);
    const ge = agl < b ? A.groundEffectFactor * (1 - agl / b) : 0;
    CL *= 1 + ge * 0.4;
    const CD = A.CD0 + A.k * CL * CL * (1 - ge) + fl('dCD') + A.CDgear * this.gearPos + A.CDspoilers * this.spoilers + Math.max(0, this.mach - 0.78) * 0.4;
    const CY = A.CYbeta * this.beta + this.rudder * 0.12;
    const L = qbar * S * CL * (1 - this.spoilers * 0.35);
    const D = qbar * S * CD;
    const Y = qbar * S * CY;

    const vHat = vb.clone().divideScalar(V);
    const liftDir = new THREE.Vector3(1, 0, 0).cross(vHat).normalize();
    const Fb = new THREE.Vector3()
      .addScaledVector(liftDir, V > 1 ? L : 0)
      .addScaledVector(vHat, -D)
      .add(new THREE.Vector3(Y, 0, 0));

    // ---- engines
    const spool = this.profile === 'arcade' ? d.arcade.spoolSeconds : d.engines.spoolSeconds;
    let thrustTotal = 0;
    for (let i = 0; i < this.n1.length; i++) {
      const target = this.enginesRunning ? d.engines.idleFraction + (1 - d.engines.idleFraction) * (input.reverse ? 0.75 : this.throttleCmd) : 0;
      // spool-up is slower from idle, like real turbofans
      const rate = (target > this.n1[i] ? (this.n1[i] < 0.5 ? 0.55 : 1) : 1.3) / spool;
      this.n1[i] += THREE.MathUtils.clamp(target - this.n1[i], -rate * dt, rate * dt);
      const lapse = Math.pow(rho / 1.225, 0.75) * (1 - 0.28 * this.mach);
      let t = d.engines.staticThrustN * Math.pow(Math.max(this.n1[i], 0), 1.6) * lapse;
      if (input.reverse && this.onGround) t *= -d.engines.reverseFraction / 0.75;
      thrustTotal += t;
    }
    if (this.enginesRunning) this.fuelKg = Math.max(0, this.fuelKg - (Math.abs(thrustTotal) / 1000) * d.engines.fuelKgPerSecPerKN * dt);
    if (this.fuelKg <= 0) this.enginesRunning = false;
    Fb.z -= thrustTotal;

    // ---- aerodynamic moments (conventional signs)
    const p = -this.omega.z; // roll rate, right +
    const qr = this.omega.x; // pitch rate, up +
    const r = -this.omega.y; // yaw rate, right +
    const Vs = Math.max(V, 20);
    const Cl = A.ClBeta * this.beta + A.ClP * (p * b) / (2 * Vs) + A.ClR * (r * b) / (2 * Vs) + A.ClAileron * this.aileron;
    const Cm = A.Cm0 + A.CmAlpha * (this.alpha - 2 * DEG) + A.CmQ * (qr * c) / (2 * Vs) - A.CmElevator * this.elevator + A.CmFlapPerUnit * this.flapPos;
    const Cn = A.CnBeta * this.beta + A.CnR * (r * b) / (2 * Vs) - A.CnRudder * this.rudder + A.CnAileronAdverse * this.aileron;
    const Mb = new THREE.Vector3(Cm * qbar * S * c, -Cn * qbar * S * b, -Cl * qbar * S * b);

    // ---- to world, plus gravity and ground
    const Fw = Fb.applyQuaternion(this.quat);
    Fw.y -= m * G;
    const Mw = new THREE.Vector3();
    this.groundForces(input, Fw, Mw);
    Mb.add(Mw.applyQuaternion(_qi));

    // ---- integrate translation
    const acc = Fw.divideScalar(m);
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    // load factor along body up (what the pilot feels)
    const accBody = acc.clone().add(new THREE.Vector3(0, G, 0)).applyQuaternion(_qi);
    this.nz = accBody.y / G;

    // ---- integrate rotation (diagonal inertia, gyroscopic term)
    const I = new THREE.Vector3(d.inertiaKgM2.pitch, d.inertiaKgM2.yaw, d.inertiaKgM2.roll).multiplyScalar(m / 67300);
    const Iw = new THREE.Vector3(I.x * this.omega.x, I.y * this.omega.y, I.z * this.omega.z);
    const gyro = new THREE.Vector3().crossVectors(this.omega, Iw);
    const dw = Mb.sub(gyro);
    this.omega.x += (dw.x / I.x) * dt;
    this.omega.y += (dw.y / I.y) * dt;
    this.omega.z += (dw.z / I.z) * dt;
    const wlen = this.omega.length();
    if (wlen > 1e-9) {
      _q.setFromAxisAngle(_w.copy(this.omega).divideScalar(wlen), wlen * dt);
      this.quat.multiply(_q).normalize();
    }
  }

  // ------------------------------------------------------------------ ground contact
  private groundForces(input: PilotInput, Fw: THREE.Vector3, Mw: THREE.Vector3): void {
    const d = this.d;
    const gd = d.gear;
    const cg = d.cgModel;
    let any = false;
    const up = new THREE.Vector3(0, 1, 0);
    const omegaW = this.omega.clone().applyQuaternion(this.quat);
    const gs = this.groundSpeedKt;
    const steerMax = THREE.MathUtils.lerp(gd.nosewheelMaxDegLowSpeed, gd.nosewheelMaxDegHighSpeed, THREE.MathUtils.clamp((gs - 10) / 40, 0, 1));
    this.steerDeg = this.rudder * steerMax;
    const brake = Math.max(input.brakes, this.parkingBrake ? 1 : 0);
    const wasGround = this.wasOnGround;
    let maxSink = 0;

    const contact = (pb: number[], k: number, cDamp: number, wheel: { steer: boolean; brake: boolean } | null, idx: number) => {
      const r = new THREE.Vector3(pb[0] - cg[0], pb[1] - cg[1], pb[2] - cg[2]).applyQuaternion(this.quat);
      const pw = r.clone().add(this.pos);
      const h = this.heightAt(pw.x, pw.z);
      const pen = h - pw.y;
      if (idx >= 0) this.gearCompression[idx] = Math.max(0, pen);
      if (pen <= 0) return;
      any = true;
      const vp = this.vel.clone().add(new THREE.Vector3().crossVectors(omegaW, r));
      maxSink = Math.min(maxSink, vp.y);
      const N = Math.max(0, k * pen - cDamp * vp.y);
      const F = up.clone().multiplyScalar(N);
      if (wheel) {
        const steer = wheel.steer ? -this.steerDeg * DEG : 0;
        const fw = new THREE.Vector3(Math.sin(steer), 0, -Math.cos(steer)).applyQuaternion(this.quat);
        fw.y = 0;
        fw.normalize();
        const lat = new THREE.Vector3().crossVectors(up, fw);
        const vLong = vp.dot(fw);
        const vLat = vp.dot(lat);
        const mu = gd.rollingFriction + (wheel.brake ? gd.brakeFriction * brake : 0);
        F.addScaledVector(fw, -mu * N * Math.tanh(vLong / 0.4));
        F.addScaledVector(lat, -gd.lateralFriction * N * THREE.MathUtils.clamp(vLat / 0.5, -1, 1));
      } else {
        // structure scraping the ground: heavy friction
        const vh = vp.clone();
        vh.y = 0;
        if (vh.lengthSq() > 1e-4) F.addScaledVector(vh.normalize(), -0.6 * N);
      }
      Fw.add(F);
      Mw.add(new THREE.Vector3().crossVectors(r, F));
    };

    if (this.gearPos > 0.95) {
      gd.points.forEach((g, i) => contact(g.pos, g.k, g.c, g, i));
    }
    for (const sp of d.structure.points) contact(sp, 3e6, 4e5, null, -1);
    this.onGround = any;
    if (any && !wasGround) this.touchdownFpm = (maxSink / FT) * 60;
    this.wasOnGround = any;
  }

  // ------------------------------------------------------------------ control laws
  private applyControlLaws(dt: number, input: PilotInput): void {
    const d = this.d;
    const ap = this.ap;
    let pitchIn = input.pitch;
    let rollIn = input.roll;
    const yawIn = input.yaw;

    // autothrust
    if (ap.athr) {
      const err = ap.spdKt * KT - this.ias;
      const accel = (this.ias - this.lastIas) / Math.max(dt, 1e-3);
      this.throttleCmd = THREE.MathUtils.clamp(this.throttleCmd + (err * 0.012 - accel * 0.05) * dt * 6, 0, 1);
    } else {
      this.throttleCmd = input.throttle;
    }

    // autopilot generates the equivalent pilot inputs
    if (ap.ap && !this.onGround) {
      if (Math.abs(input.pitch) > 0.5 || Math.abs(input.roll) > 0.5) ap.ap = false; // instinctive disconnect
      let hErr = ap.hdgDeg - this.headingDeg;
      hErr = ((hErr + 540) % 360) - 180;
      const bankCmd = THREE.MathUtils.clamp(hErr * 1.6, -25, 25);
      rollIn = THREE.MathUtils.clamp((bankCmd - this.bankDeg) * 0.06, -1, 1);
      let vsCmd: number;
      const altErr = ap.altFt - this.altFt;
      if (ap.vmode === 'VS') vsCmd = ap.vsFpm;
      else vsCmd = THREE.MathUtils.clamp(altErr * 4, -2000, 2000);
      if (ap.vmode === 'VS' && Math.abs(altErr) < 200) ap.vmode = 'ALT';
      if (ap.vmode === 'VS' && Math.sign(altErr) !== Math.sign(ap.vsFpm)) ap.vmode = 'ALT';
      const vsErr = vsCmd - this.vsFpm;
      pitchIn = THREE.MathUtils.clamp(vsErr / 1500 - this.omega.x * 2, -1, 1);
    }

    const toSurface = (v: number) => THREE.MathUtils.clamp(v, -1, 1);

    if (this.onGround) {
      // on the ground everything is direct; reset the fly-by-wire state for lift-off
      this.elevator = toSurface(pitchIn);
      this.aileron = toSurface(rollIn);
      this.rudder = toSurface(yawIn);
      this.pitchTrim = 0;
      this.gammaHold = this.gammaDeg;
      this.bankHold = 0;
      return;
    }

    if (this.profile === 'realistic' && !this.protections) {
      // direct law: raw surfaces, plus a basic yaw damper
      this.elevator = toSurface(pitchIn);
      this.aileron = toSurface(rollIn);
      this.rudder = toSurface(yawIn + this.omega.y * 0.6);
      return;
    }

    const arcade = this.profile === 'arcade';
    const NL = d.normalLaw;
    const AR = d.arcade;
    const V = Math.max(this.tas, 30);
    const q = this.omega.x / DEG; // pitch rate, deg/s up
    const p = -this.omega.z / DEG; // roll rate, deg/s right
    const bank = this.bankDeg;
    const gamma = this.gammaDeg;
    const aDeg = this.alpha / DEG;

    // ---- pitch: stick = flight-path rate (normal law: load factor), centred = hold flight path
    const nzRange = pitchIn > 0 ? NL.nzMax - 1 : 1 - NL.nzMin;
    const maxGammaRate = arcade ? AR.maxPitchRateDeg : (nzRange * G) / V / DEG;
    let gammaRate = 0;
    if (Math.abs(pitchIn) > 0.04) {
      gammaRate = pitchIn * maxGammaRate;
      this.gammaHold = gamma;
    }
    // turn compensation: in a bank the nose must keep coming round to hold the path
    const bankComp = Math.abs(bank) <= (arcade ? AR.maxBankDeg : NL.bankHoldLimitDeg) ? ((G / V) * (1 / Math.cos(bank * DEG) - 1)) / DEG : 0;
    let qCmd = gammaRate + THREE.MathUtils.clamp((this.gammaHold - gamma) * 0.9, -4, 4) + bankComp * Math.cos(bank * DEG);
    // high angle-of-attack protection
    const prot = arcade ? NL.alphaProtDeg - 1 : NL.alphaProtDeg;
    if (aDeg > prot) {
      const aMax = arcade ? prot + 0.5 : NL.alphaProtDeg + Math.max(0, pitchIn) * (NL.alphaMaxDeg - NL.alphaProtDeg);
      qCmd = Math.min(qCmd, (aMax - aDeg) * 2);
      this.gammaHold = Math.min(this.gammaHold, gamma);
    }
    const qbarScale = THREE.MathUtils.clamp(9000 / Math.max(0.5 * isaDensity(this.altitudeMsl(this.pos)) * V * V, 500), 0.4, 5);
    const qErr = qCmd - q;
    this.pitchTrim = THREE.MathUtils.clamp(this.pitchTrim + qErr * 0.03 * qbarScale * dt, -0.8, 0.8);
    this.elevator = toSurface(this.pitchTrim + qErr * 0.05 * qbarScale);

    // ---- roll: stick = roll rate, centred = hold bank (arcade levels small banks)
    const maxRate = arcade ? AR.maxRollRateDeg : NL.maxRollRateDeg;
    const holdLimit = arcade ? AR.maxBankDeg : NL.bankHoldLimitDeg;
    const maxBank = arcade ? AR.maxBankDeg : NL.maxBankDeg;
    let pCmd: number;
    if (Math.abs(rollIn) > 0.04) {
      pCmd = rollIn * maxRate;
      this.bankHold = bank;
    } else {
      let target = this.bankHold;
      if (arcade && Math.abs(target) < 7) target = 0;
      target = THREE.MathUtils.clamp(target, -holdLimit, holdLimit);
      pCmd = THREE.MathUtils.clamp((target - bank) * 1.2, -maxRate * 0.6, maxRate * 0.6);
    }
    if (Math.abs(bank) > maxBank && Math.sign(pCmd) === Math.sign(bank)) pCmd = -Math.sign(bank) * 5;
    const ff = pCmd / (0.0058 * V / DEG); // steady-state roll rate per unit aileron ~ 0.0058*V rad/s
    this.aileron = toSurface(ff + (pCmd - p) * 0.03 * qbarScale);

    // ---- yaw: turn coordination + yaw damper
    const yawRate = -this.omega.y / DEG;
    const turnRate = ((G * Math.tan(bank * DEG)) / V) / DEG;
    this.rudder = toSurface(yawIn + this.beta * (arcade ? 5 : 3) - (yawRate - turnRate * Math.cos(bank * DEG)) * 0.03);
  }
}
