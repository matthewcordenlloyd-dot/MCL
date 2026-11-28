import * as THREE from 'three';
import type { Input } from '../player/Input';
import type { PilotInput } from './FlightModel';
import type { PlayerAircraft } from './PlayerAircraft';

/**
 * Turns keyboard / gamepad / mouse-yoke input into smooth pilot inputs and handles
 * discrete flight commands. Returns messages for on-screen toasts.
 */
export class FlightControls {
  readonly out: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0, reverse: false, brakes: 0 };
  mouseYoke = false;
  private yoke = new THREE.Vector2();
  private kb = { pitch: 0, roll: 0, yaw: 0 };
  hudToggled = false;
  cameraCycled = false;
  leaveSeat = false;

  update(dt: number, I: Input, pa: PlayerAircraft): string[] {
    const F = I.flying;
    const P = I.padFlying;
    const fm = pa.fm;
    const msgs: string[] = [];
    this.hudToggled = I.hit(F, 'hud', P);
    this.cameraCycled = I.hit(F, 'camera', P);
    this.leaveSeat = I.hit(F, 'leaveSeat', P);

    // ---- analog axes: keyboard ramps toward full deflection, gamepad is direct
    const ramp = (cur: number, neg: boolean, pos: boolean, rate = 2.5) => {
      const target = (pos ? 1 : 0) - (neg ? 1 : 0);
      const r = target === 0 ? 6 : rate;
      return cur + THREE.MathUtils.clamp(target - cur, -r * dt, r * dt);
    };
    this.kb.pitch = ramp(this.kb.pitch, I.held(F, 'pitchDown'), I.held(F, 'pitchUp'), 1.6);
    this.kb.roll = ramp(this.kb.roll, I.held(F, 'rollLeft'), I.held(F, 'rollRight'), 2.2);
    this.kb.yaw = ramp(this.kb.yaw, I.held(F, 'yawLeft', P), I.held(F, 'yawRight', P), 2.5);
    if (I.hit(F, 'mouseYoke')) {
      this.mouseYoke = !this.mouseYoke;
      this.yoke.set(0, 0);
      msgs.push(`Mouse yoke ${this.mouseYoke ? 'ON (mouse flies, M to release)' : 'OFF'}`);
    }
    if (this.mouseYoke && I.locked) {
      this.yoke.x = THREE.MathUtils.clamp(this.yoke.x + I.mouseDX * 0.004, -1, 1);
      this.yoke.y = THREE.MathUtils.clamp(this.yoke.y + I.mouseDY * 0.004, -1, 1);
      this.yoke.multiplyScalar(Math.exp(-0.6 * dt)); // gentle self-centring
    }
    const pick = (...v: number[]) => v.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    this.out.pitch = pick(this.kb.pitch, I.padAxes[1], this.mouseYoke ? this.yoke.y : 0);
    this.out.roll = pick(this.kb.roll, I.padAxes[0], this.mouseYoke ? this.yoke.x : 0);
    this.out.yaw = this.kb.yaw;
    // on the ground the roll input also steers the nosewheel (keyboard-friendly taxiing)
    if (fm.onGround && fm.groundSpeedKt < 40) this.out.yaw = pick(this.out.yaw, this.out.roll);

    // ---- throttle lever
    let thr = this.out.throttle;
    if (I.held(F, 'throttleUp')) thr += 0.35 * dt;
    if (I.held(F, 'throttleDown')) thr -= 0.35 * dt;
    thr += (I.padTriggers[1] - I.padTriggers[0]) * 0.45 * dt;
    if (I.hit(F, 'throttleIdle')) thr = 0;
    if (I.hit(F, 'throttleToga')) thr = 1;
    this.out.throttle = THREE.MathUtils.clamp(thr, 0, 1);
    this.out.reverse = I.held(F, 'reverse') && fm.onGround && this.out.throttle < 0.05;
    this.out.brakes = I.held(F, 'brakes', P) ? 1 : 0;

    // ---- discrete commands
    const ap = fm.ap;
    if (I.hit(F, 'parkingBrake', P)) msgs.push(pa.clickControl('ctl_park', 0, false));
    if (I.hit(F, 'gear', P)) msgs.push(pa.clickControl('ctl_gear', 0, false));
    if (I.hit(F, 'flapsDown', P)) msgs.push(pa.clickControl('ctl_flaps', 0, false));
    if (I.hit(F, 'flapsUp', P)) msgs.push(pa.clickControl('ctl_flaps', 2, false));
    if (I.hit(F, 'spoilers')) msgs.push(pa.clickControl('ctl_speedbrake', 0, false));
    if (I.hit(F, 'autopilot', P)) msgs.push(pa.clickControl('ctl_ap1', 0, false));
    if (I.hit(F, 'autothrust', P)) msgs.push(pa.clickControl('ctl_athr', 0, false));
    const big = I.keyHeld('ShiftLeft') || I.keyHeld('ShiftRight');
    if (I.hit(F, 'hdgUp')) msgs.push(pa.clickControl('ctl_hdg', 0, big));
    if (I.hit(F, 'hdgDown')) msgs.push(pa.clickControl('ctl_hdg', 2, big));
    if (I.hit(F, 'altUp')) msgs.push(pa.clickControl('ctl_alt', 0, true));
    if (I.hit(F, 'altDown')) msgs.push(pa.clickControl('ctl_alt', 2, true));
    if (I.hit(F, 'pushback', P)) msgs.push(pa.requestPushback());
    // when autothrust is engaged, the lever follows it so disengaging is smooth
    if (ap.athr) this.out.throttle = fm.throttleCmd;
    return msgs.filter(Boolean);
  }

  /** Sync the lever with the aircraft (e.g. after a teleport). */
  reset(throttle: number): void {
    this.out.throttle = throttle;
    this.kb = { pitch: 0, roll: 0, yaw: 0 };
    this.yoke.set(0, 0);
  }
}
