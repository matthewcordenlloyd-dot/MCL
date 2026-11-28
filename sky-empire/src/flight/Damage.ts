import * as THREE from 'three';
import D from '@data/damage.json';
import type { FlightModel } from './FlightModel';

export interface Incident {
  kind: 'damage' | 'crash';
  cause: string;
  costUSD: number;
}

/**
 * Watches the flight for things that damage a real airliner: hard landings, tail and wingtip
 * strikes, gear-up landings, runway excursions, overspeed and flying too fast with flaps or gear
 * out. Severe events are crashes. The game turns these into repair bills, reputation loss and
 * (for crashes) a crash report. Can be switched off in the settings.
 */
export class DamageMonitor {
  enabled = true;
  /** Damage this flight, 0..1 per part (for the HUD / report). */
  readonly parts = { gear: 0, structure: 0, flaps: 0 };
  private wasGround = true;
  private timers = { overspeed: 0, flaps: 0, gear: 0 };
  private reported = new Set<string>();
  /** Runway centrelines (world) for excursion checks. */
  runways: { a: THREE.Vector3; b: THREE.Vector3; widthM: number }[] = [];

  reset(): void {
    this.parts.gear = this.parts.structure = this.parts.flaps = 0;
    this.timers = { overspeed: 0, flaps: 0, gear: 0 };
    this.reported.clear();
    this.wasGround = true;
  }

  private once(key: string, inc: Incident): Incident | null {
    if (this.reported.has(key)) return null;
    this.reported.add(key);
    return inc;
  }

  /** Call every frame while flying; returns at most one new incident. */
  update(fm: FlightModel, dt: number): Incident | null {
    if (!this.enabled || fm.crashed) {
      this.wasGround = fm.onGround;
      return null;
    }
    const L = D.limits;
    const ias = fm.iasKt;
    let out: Incident | null = null;
    // touchdown
    if (fm.onGround && !this.wasGround) {
      const fpm = fm.touchdownFpm;
      if (fm.gearPos < 0.95 && fm.groundSpeedKt > 40) out = { kind: 'crash', cause: 'Gear-up landing: the aircraft slid down the runway on its belly', costUSD: D.costs.hullLossShare };
      else if (fpm < L.crashFpm) out = { kind: 'crash', cause: `Touched down at ${Math.round(-fpm)} ft/min: the landing gear collapsed`, costUSD: D.costs.hullLossShare };
      else if (fpm < L.hardLandingFpm) {
        this.parts.gear = Math.min(1, this.parts.gear + 0.5);
        out = this.once('hard', { kind: 'damage', cause: `Hard landing (${Math.round(-fpm)} ft/min): gear and structure inspection`, costUSD: D.costs.hardLanding });
      }
    }
    this.wasGround = fm.onGround;
    if (out) return out;
    if (fm.onGround) {
      const bank = Math.abs(fm.bankDeg);
      if (bank > L.wingCrashBankDeg && fm.groundSpeedKt > 30) return { kind: 'crash', cause: `The wing dug into the ground (bank ${Math.round(bank)}°)`, costUSD: D.costs.hullLossShare };
      if (bank > L.wingStrikeBankDeg && fm.groundSpeedKt > 30) {
        this.parts.structure = Math.min(1, this.parts.structure + 0.3);
        out = this.once('wing', { kind: 'damage', cause: `Wingtip strike (bank ${Math.round(bank)}° on the ground)`, costUSD: D.costs.wingStrike });
      }
      if (!out && fm.pitchDeg > L.tailStrikePitchDeg && ias > 60) {
        this.parts.structure = Math.min(1, this.parts.structure + 0.3);
        out = this.once('tail', { kind: 'damage', cause: `Tail strike (pitch ${fm.pitchDeg.toFixed(1)}° on the runway)`, costUSD: D.costs.tailStrike });
      }
      // runway excursion: fast on the ground well away from every runway
      if (!out && fm.groundSpeedKt > L.excursionKt && this.runways.length) {
        const off = Math.min(...this.runways.map((r) => distToSegment(fm.pos, r.a, r.b) - r.widthM / 2));
        if (off > L.excursionOffM) out = { kind: 'crash', cause: 'Runway excursion: the aircraft left the paved surface at speed', costUSD: D.costs.hullLossShare };
      }
      if (out) return out;
    } else {
      // speed limits in the air
      const vmo = fm.d.flaps[0]?.vmaxKt ?? L.vmoKt; // each type's own limits
      this.timers.overspeed = ias > vmo ? this.timers.overspeed + dt : 0;
      if (this.timers.overspeed > L.overspeedSeconds) {
        this.parts.structure = Math.min(1, this.parts.structure + 0.2);
        out = this.once('vmo', { kind: 'damage', cause: `Overspeed (${Math.round(ias)} kt above VMO ${vmo} kt): structural inspection`, costUSD: D.costs.overspeed });
      }
      const flapLimit = Math.round(fm.flapPos) > 0 ? fm.d.flaps[Math.round(fm.flapPos)]?.vmaxKt ?? 999 : 999;
      this.timers.flaps = fm.flapPos > 0.3 && ias > flapLimit + 5 ? this.timers.flaps + dt : 0;
      if (!out && this.timers.flaps > L.limitSeconds) {
        this.parts.flaps = 1;
        out = this.once('flaps', { kind: 'damage', cause: `Flaps overspeed (${Math.round(ias)} kt, limit ${flapLimit} kt)`, costUSD: D.costs.flaps });
      }
      this.timers.gear = fm.gearPos > 0.3 && ias > L.gearLimitKt + 5 ? this.timers.gear + dt : 0;
      if (!out && this.timers.gear > L.limitSeconds) {
        this.parts.gear = Math.min(1, this.parts.gear + 0.3);
        out = this.once('gearspeed', { kind: 'damage', cause: `Gear extended at ${Math.round(ias)} kt (limit ${L.gearLimitKt} kt): gear doors damaged`, costUSD: D.costs.gearDoors });
      }
    }
    return out;
  }
}

function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / (abx * abx + abz * abz || 1)));
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}
