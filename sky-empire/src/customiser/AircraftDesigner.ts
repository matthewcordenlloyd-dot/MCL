import * as THREE from 'three';
import D from '@data/economy/designer.json';
import type { AircraftType } from '../economy/types';
import { EditorShell, escAttr, field } from './EditorShell';
import type { Brand } from './liveryPainter';

type Family = keyof typeof D.families;
type Wing = keyof typeof D.wings;
type Engine = keyof typeof D.engines;
type Fuel = keyof typeof D.fuel;
export interface Design { name: string; family: Family; stretch: number; wing: Wing; engine: Engine; fuel: Fuel }

/** Turn a design into a catalogue type plus its development cost. */
export function buildType(d: Design, maker: string, id?: string): { type: AircraftType; devUSD: number; lengthM: number; spanM: number } {
  const F = D.families[d.family];
  const W = D.wings[d.wing];
  const E = D.engines[d.engine];
  const U = D.fuel[d.fuel];
  const S = D.stretchPerStep;
  const k = d.stretch;
  const seatsY = Math.max(20, F.seats[1] + k * F.seatsPerStep);
  const seatsJ = F.seats[0] + (k >= 2 ? 4 : 0);
  const total = seatsJ + seatsY;
  const price = F.priceUSD * (1 + S.price * k) * W.price * E.price * U.price;
  const type: AircraftType = {
    id: id ?? `custom-${Date.now().toString(36)}`,
    name: d.name.trim() || 'Custom aircraft',
    maker,
    role: 'airliner',
    category: F.category,
    seats: [seatsJ, seatsY],
    rangeKm: Math.round((F.rangeKm * (1 + S.range * k) * W.range * U.range) / 50) * 50,
    cruiseKt: F.cruiseKt + E.cruiseKt,
    fuelKgPerHr: Math.round(F.fuelKgPerHr * (1 + S.burn * k) * W.burn * E.burn / 10) * 10,
    mtowT: Math.round(F.mtowT * (1 + S.mtow * k) * W.mtow * U.mtow),
    runwayM: Math.round((F.runwayM * (1 + S.runway * k) * W.runway * E.runway) / 50) * 50,
    priceUSD: Math.round(price / 1e5) * 1e5,
    leaseMonthUSD: Math.round((price * D.leasePerMonthOfPrice) / 1000) * 1000,
    maintPerHrUSD: Math.round(F.maintPerHrUSD * E.maint * (1 + 0.02 * k)),
    cabinCrew: Math.max(F.cabinCrew, Math.ceil(total / 50)),
    deliveryMonths: D.deliveryMonths,
    newAvailable: true,
    turnMin: Math.round(F.turnMin + k * 2),
    custom: true,
    design: { ...d },
  };
  const devUSD = F.devUSD * (1 + 0.08 * Math.abs(k) + W.dev + E.dev + U.dev);
  return { type, devUSD, lengthM: F.fuselageM + k * F.stepM, spanM: F.spanM * W.span };
}

/**
 * Custom aircraft designer: choose a family and parts, see the numbers change, and spin a
 * procedural 3D model. Certifying the design charges development and adds it to the catalogue.
 */
export class AircraftDesigner {
  private shell: EditorShell;
  private d: Design;
  private model = new THREE.Group();

  constructor(private brand: Brand, private existing: AircraftType | undefined, private money: (usd: number) => string, onApply: (t: AircraftType, devUSD: number) => void, onClose: () => void) {
    this.d = (existing?.design as unknown as Design) ?? { name: `${brand.name || 'Sky'} Jet 1`, family: 'narrowbody', stretch: 0, wing: 'medium', engine: 'standard', fuel: 'standard' };
    this.d = { ...this.d };
    this.shell = new EditorShell(existing ? `Redesign · ${existing.name}` : 'Aircraft designer', 'Build a new type from proven parts. Development costs money once; after that you can order it like any other aircraft.', onClose, existing ? 'Update design' : 'Certify design');
    this.shell.scene.add(this.model);
    this.shell.controls.autoRotate = true;
    this.shell.controls.autoRotateSpeed = 0.5;
    this.shell.renderer.domElement.addEventListener('pointerdown', () => (this.shell.controls.autoRotate = false));
    this.shell.onApply(() => {
      const r = buildType(this.d, brand.name || 'Custom', existing?.id);
      // redesigning an existing type costs a quarter of the original development
      onApply(r.type, existing ? r.devUSD * 0.25 : r.devUSD);
    });
    this.render();
    this.rebuild(true);
  }

  private render(): void {
    const d = this.d;
    const F = D.families[d.family];
    const r = buildType(d, this.brand.name);
    const t = r.type;
    const opts = <T extends Record<string, { label: string }>>(o: T): [string, string][] => Object.entries(o).map(([k, v]) => [k, v.label]);
    const stat = (l: string, v: string) => `<span>${l}</span><b>${v}</b>`;
    this.shell.setBody(`
      <section><h2>Name</h2>${field.text('name', 'Type name', d.name)}</section>
      <section><h2>Parts</h2>
        ${field.select('family', 'Fuselage family', d.family, opts(D.families))}
        <label class="edf"><span>Stretch <b>${d.stretch > 0 ? '+' : ''}${d.stretch} (${r.lengthM.toFixed(1)} m)</b></span><input type="range" data-k="stretch" min="${F.stepMin}" max="${F.stepMax}" step="1" value="${d.stretch}"></label>
        ${field.select('wing', 'Wing', d.wing, opts(D.wings))}
        ${field.select('engine', 'Engines', d.engine, opts(D.engines))}
        ${field.select('fuel', 'Fuel', d.fuel, opts(D.fuel))}
      </section>
      <section class="stats"><h2>Performance</h2><div class="kv">
        ${stat('Seats (2-class)', `${t.seats[0] + t.seats[1]} (${t.seats[0]} J / ${t.seats[1]} Y)`)}
        ${stat('Range', `${t.rangeKm.toLocaleString()} km`)}
        ${stat('Cruise', `${t.cruiseKt} kt`)}
        ${stat('Fuel burn', `${t.fuelKgPerHr.toLocaleString()} kg/h (${(t.fuelKgPerHr / (t.seats[0] + t.seats[1])).toFixed(1)} per seat)`)}
        ${stat('Max take-off weight', `${t.mtowT} t`)}
        ${stat('Runway needed', `${t.runwayM.toLocaleString()} m`)}
        ${stat('Wingspan', `${r.spanM.toFixed(1)} m`)}
        ${stat('List price', this.money(t.priceUSD))}
        ${stat('Lease', `${this.money(t.leaseMonthUSD)}/mo`)}
        ${stat('Maintenance', `${this.money(t.maintPerHrUSD)}/h`)}
      </div></section>
      <section class="stats"><h2>Development</h2><div class="kv">${stat(this.existing ? 'Redesign cost' : 'Certification cost', this.money(this.existing ? r.devUSD * 0.25 : r.devUSD))}${stat('Delivery after order', `${t.deliveryMonths} months`)}</div>
      <p class="note">Custom types fly in the business simulation. When you fly one yourself in the 3D world it uses the A320neo model for now.</p></section>`);
    const body = this.shell.panel;
    body.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
      el.addEventListener(el.type === 'text' ? 'input' : el.type === 'range' ? 'input' : 'change', () => {
        const k = el.dataset.k as keyof Design;
        const v = el.type === 'range' ? +el.value : el.value;
        (d as unknown as Record<string, unknown>)[k] = v;
        if (k === 'family') d.stretch = 0;
        if (k === 'name') return;
        this.rebuild(k === 'family');
        this.render();
      });
    });
    void escAttr;
  }

  /** Procedural preview: fuselage with nose and tail cones, swept wings, engines and tail. */
  private rebuild(reframe = false): void {
    for (const o of [...this.model.children]) {
      this.model.remove(o);
      o.traverse((x) => (x as THREE.Mesh).geometry?.dispose());
    }
    const d = this.d;
    const F = D.families[d.family];
    const E = D.engines[d.engine];
    const r = buildType(d, '');
    const L = r.lengthM;
    const R = F.diameterM / 2;
    const span = r.spanM;
    const white = new THREE.MeshStandardMaterial({ color: '#f2f4f7', roughness: 0.35, metalness: 0.1 });
    const brand = new THREE.MeshStandardMaterial({ color: this.brand.colors.primary, roughness: 0.4 });
    const grey = new THREE.MeshStandardMaterial({ color: '#b9bec6', roughness: 0.5, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: '#20242b', roughness: 0.4 });
    // fuselage profile (radius along length) lathed around z
    const prof: THREE.Vector2[] = [];
    const nose = R * 2.6;
    const tail = R * 4.2;
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * L;
      let rad = R;
      if (s < nose) rad = R * Math.sqrt(1 - Math.pow(1 - s / nose, 2));
      else if (s > L - tail) rad = R * (0.18 + 0.82 * Math.pow(1 - (s - (L - tail)) / tail, 0.9));
      prof.push(new THREE.Vector2(Math.max(0.01, rad), s));
    }
    const fus = new THREE.Mesh(new THREE.LatheGeometry(prof, 32).rotateX(Math.PI / 2), white);
    fus.position.set(0, R + 1.6, -L / 2);
    // tail cone sweeps up slightly: fake it by lifting the whole mesh is fine at this level of detail
    this.model.add(fus);
    const y0 = R + 1.6;
    const zc = 0;
    // wing: swept trapezoid
    const wing = (sx: number) => {
      const root = R * 3.2;
      const tip = root * 0.28;
      const sweep = span * 0.25;
      const half = span / 2;
      const sh = new THREE.Shape();
      sh.moveTo(0, 0);
      sh.lineTo(half, sweep);
      sh.lineTo(half, sweep + tip);
      sh.lineTo(0, root);
      sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: R * 0.12, bevelEnabled: false });
      g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, white);
      m.scale.x = sx;
      m.position.set(0, y0 - R * 0.55, zc - root * 0.4);
      m.rotation.z = sx * 0.06; // dihedral
      return m;
    };
    this.model.add(wing(1), wing(-1));
    // winglets
    for (const sx of [-1, 1]) {
      const wl = new THREE.Mesh(new THREE.BoxGeometry(0.12, R * 0.9, R * 0.7), brand);
      wl.position.set(sx * span / 2, y0 - R * 0.55 + span * 0.03 + R * 0.4, zc - R * 3.2 * 0.4 + span * 0.25 + R * 0.25);
      this.model.add(wl);
    }
    // engines
    const er = R * 0.42 * E.size;
    const engs = d.family === 'widebody' || d.family === 'narrowbody' || d.family === 'regional' ? [0.33] : [0.33];
    for (const sx of [-1, 1]) for (const f of engs) {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(er, er * 0.85, er * 4.2, 24, 1, true).rotateX(Math.PI / 2), grey);
      const x = sx * span * f * 0.5;
      const z = zc - R * 3.2 * 0.4 + span * 0.25 * f - er * 2.6;
      nac.position.set(x, y0 - R * 0.55 - er * 1.1, z);
      const fan = new THREE.Mesh(new THREE.CircleGeometry(er * 0.95, 24), dark);
      fan.position.set(x, nac.position.y, z - er * 2.1);
      fan.rotation.y = Math.PI;
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.2, er * 0.9, er * 3), white);
      pylon.position.set(x, nac.position.y + er * 0.9, z + er * 0.6);
      this.model.add(nac, fan, pylon);
    }
    // vertical fin in brand colour, horizontal stabilisers
    const finH = R * 3.4;
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(finH * 0.9, finH);
    finShape.lineTo(finH * 1.35, finH);
    finShape.lineTo(finH * 1.25, 0);
    finShape.closePath();
    const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: 0.25, bevelEnabled: false }).rotateY(-Math.PI / 2), brand);
    fin.position.set(0.12, y0 + R * 0.6, L / 2 - finH * 1.45);
    this.model.add(fin);
    for (const sx of [-1, 1]) {
      const st = new THREE.Shape();
      const hs = span * 0.19;
      st.moveTo(0, 0);
      st.lineTo(hs, hs * 0.55);
      st.lineTo(hs, hs * 0.55 + hs * 0.3);
      st.lineTo(0, hs * 0.85);
      st.closePath();
      const m = new THREE.Mesh(new THREE.ExtrudeGeometry(st, { depth: 0.15, bevelEnabled: false }).rotateX(Math.PI / 2), white);
      m.scale.x = sx;
      m.position.set(0, y0 + R * 0.2, L / 2 - tail * 0.85);
      this.model.add(m);
    }
    // windows line and cheatline
    const cheat = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.005, R * 1.005, L - nose - tail, 32, 1, true, Math.PI * 0.25, Math.PI * 0.08).rotateX(Math.PI / 2), brand);
    cheat.position.set(0, y0, (nose - tail) / 2);
    const cheat2 = cheat.clone();
    cheat2.scale.x = -1;
    this.model.add(cheat, cheat2);
    // landing gear stubs
    for (const [x, z] of [[0, -L / 2 + nose * 0.9], [R * 0.9, 0.6], [-R * 0.9, 0.6]] as [number, number][]) {
      const g = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.6), grey);
      g.position.set(x, 0.8, z);
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 16).rotateZ(Math.PI / 2), dark);
      w.position.set(x, 0.55, z);
      this.model.add(g, w);
    }
    this.model.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    if (reframe) {
      const k = Math.max(L, span);
      this.shell.camera.position.set(-k * 1.15, k * 0.5, -k * 1.0);
      this.shell.controls.target.set(0, y0, 0);
      this.shell.camera.far = k * 20;
      this.shell.camera.updateProjectionMatrix();
    }
  }
}
