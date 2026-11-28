import * as THREE from 'three';

let glow: THREE.CanvasTexture | null = null;
let pool: THREE.CanvasTexture | null = null;

/** Soft radial glow used for light halos (additive sprites). */
export function glowTexture(): THREE.CanvasTexture {
  if (glow) return glow;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  glow = new THREE.CanvasTexture(c);
  return glow;
}

/** Warm light pool painted on the ground under floodlights. */
export function poolTexture(): THREE.CanvasTexture {
  if (pool) return pool;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,214,160,0.9)');
  gr.addColorStop(0.5, 'rgba(255,200,140,0.35)');
  gr.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  pool = new THREE.CanvasTexture(c);
  pool.colorSpace = THREE.SRGBColorSpace;
  return pool;
}

export function lightSprite(color: THREE.ColorRepresentation, size: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false }));
  s.scale.setScalar(size);
  s.userData.size = size;
  return s;
}

/**
 * Exterior aircraft lights: red/green navigation lights, white tail light, red beacons and white
 * strobes. Small by day, glowing halos at night. Positions are for the A320 model (origin under
 * the main gear, nose towards -Z).
 */
export class AircraftLights {
  readonly group = new THREE.Group();
  private nav: THREE.Sprite[] = [];
  private beacons: THREE.Sprite[] = [];
  private strobes: THREE.Sprite[] = [];
  beacon = true;
  strobe = false;

  constructor(span = 35.8, pos?: { wingtip: number[]; tail: number[]; beaconTop: number[]; beaconBottom: number[] }) {
    const tip = span / 2 - 0.1;
    const P = pos ?? { wingtip: [tip, 3.95, 4.2], tail: [0, 4.4, 20.4], beaconTop: [0, 6.05, 1.5], beaconBottom: [0, 1.75, 1.5] };
    const [wx, wy, wz] = P.wingtip;
    const add = (list: THREE.Sprite[], color: string, size: number, x: number, y: number, z: number) => {
      const s = lightSprite(color, size);
      s.position.set(x, y, z);
      list.push(s);
      this.group.add(s);
    };
    add(this.nav, '#ff2a2a', 0.9, -wx, wy, wz);
    add(this.nav, '#2aff6a', 0.9, wx, wy, wz);
    add(this.nav, '#ffffff', 0.8, P.tail[0], P.tail[1], P.tail[2]);
    add(this.beacons, '#ff3020', 1.2, P.beaconTop[0], P.beaconTop[1], P.beaconTop[2]);
    add(this.beacons, '#ff3020', 1.2, P.beaconBottom[0], P.beaconBottom[1], P.beaconBottom[2]);
    add(this.strobes, '#ffffff', 2.2, -wx, wy, wz + 0.3);
    add(this.strobes, '#ffffff', 2.2, wx, wy, wz + 0.3);
    add(this.strobes, '#ffffff', 1.6, P.tail[0], P.tail[1], P.tail[2] + 0.2);
  }

  /** t: seconds; night: 0 day … 1 night (halos grow). */
  update(t: number, night: number): void {
    const k = 0.35 + night * 1.4;
    for (const s of this.nav) s.scale.setScalar(s.userData.size * k);
    const b = this.beacon && t % 1.2 < 0.12;
    for (const s of this.beacons) {
      s.visible = b;
      s.scale.setScalar(s.userData.size * k * 1.3);
    }
    const ph = t % 1.1;
    const st = this.strobe && (ph < 0.05 || (ph > 0.12 && ph < 0.17));
    for (const s of this.strobes) {
      s.visible = st;
      s.scale.setScalar(s.userData.size * (0.6 + night * 2.4));
    }
  }
}
