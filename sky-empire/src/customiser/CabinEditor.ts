import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CLASS_COLOR, FREE_ITEMS, abreastOptions, cabinGeometry, cabinStats, cabinWidthM, defaultCabin, seatPlan, type CabinClass, type CabinItem, type CabinLayout } from '../economy/cabin';
import type { AircraftType, FleetAircraft } from '../economy/types';
import { EditorShell } from './EditorShell';

const CLS_LABEL: Record<CabinClass, string> = { J: 'Business', W: 'Premium economy', Y: 'Economy' };
const PITCH: Record<CabinClass, [number, number]> = { J: [36, 80], W: [32, 42], Y: [28, 36] };

/** Seat mesh: cushion, backrest and armrests, unit width; scaled per instance. */
function seatGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.BoxGeometry(0.9, 0.12, 0.8).translate(0, 0.42, 0.05),
    new THREE.BoxGeometry(0.9, 0.75, 0.12).translate(0, 0.78, 0.42),
    new THREE.BoxGeometry(0.08, 0.2, 0.7).translate(-0.46, 0.55, 0.05),
    new THREE.BoxGeometry(0.08, 0.2, 0.7).translate(0.46, 0.55, 0.05),
    new THREE.BoxGeometry(0.6, 0.36, 0.5).translate(0, 0.18, 0.1),
  ];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

/**
 * Cabin editor. Row mode: class zones (rows × abreast × pitch), galleys and lavatories, with live
 * seat counts, comfort and validation. Free mode (VIP): place furniture on the floor plan in 3D,
 * snapped to a 10 cm grid and to the walls.
 */
export class CabinEditor {
  private shell: EditorShell;
  private c: CabinLayout;
  private widthM: number;
  private lengthM: number;
  private content = new THREE.Group();
  private seatGeo = seatGeometry();
  private apply = new Set<string>();
  private sel = -1;
  private drag = false;
  private ray = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private itemMeshes: THREE.Mesh[] = [];

  constructor(private t: AircraftType, private fleet: FleetAircraft[], start: FleetAircraft, onApply: (ids: string[], c: CabinLayout) => void, onClose: () => void) {
    this.c = structuredClone(start.cabin ?? defaultCabin(t));
    this.widthM = cabinWidthM(t);
    this.lengthM = cabinGeometry(t).lengthM;
    this.apply.add(start.id);
    this.shell = new EditorShell(`Cabin · ${t.name}`, 'Seats, classes and legroom. More seats earn more per flight; more space and premium cabins raise comfort and reviews.', onClose, 'Refit cabin');
    this.shell.scene.add(this.content);
    this.shell.scene.background = new THREE.Color('#0d1524');
    const L = this.lengthM;
    this.shell.camera.position.set(-Math.max(7, L * 0.7), Math.max(10, L * 1.3), L * 0.5);
    this.shell.controls.target.set(0, 0, L / 2);
    this.shell.onApply(() => onApply([...this.apply], structuredClone(this.c)));
    this.bindPointer();
    this.render();
    this.rebuild();
  }

  // ------------------------------------------------------------------ 3D
  private rebuild(): void {
    for (const o of [...this.content.children]) {
      this.content.remove(o);
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.isMesh && m.geometry !== this.seatGeo) m.geometry.dispose();
      });
    }
    this.itemMeshes = [];
    const W = this.widthM;
    const L = this.lengthM;
    // floor, side walls (low, so you can see in) and a length marker
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.05, L).translate(0, -0.025, L / 2), new THREE.MeshStandardMaterial({ color: '#39414e', roughness: 0.9 }));
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(0.5, L).rotateX(-Math.PI / 2).translate(0, 0.003, L / 2), new THREE.MeshStandardMaterial({ color: '#4a3550', roughness: 1 }));
    this.content.add(floor);
    if (this.c.mode === 'rows') this.content.add(carpet);
    const wallMat = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.7, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) this.content.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, L).translate(sx * (W / 2 + 0.03), 0.5, L / 2), wallMat));
    const grid = new THREE.GridHelper(Math.ceil(L) * 2, Math.ceil(L) * 2, 0x2b3a52, 0x1f2a3c);
    grid.position.y = -0.06;
    this.content.add(grid);

    if (this.c.mode === 'rows') {
      const plan = seatPlan(this.c, W);
      const over = plan.lengthM > L + 0.05;
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.75 });
      const im = new THREE.InstancedMesh(this.seatGeo, mat, Math.max(1, plan.seats.length));
      const m4 = new THREE.Matrix4();
      const col = new THREE.Color();
      plan.seats.forEach((s, i) => {
        m4.makeScale(s.w, s.cls === 'J' ? 1.15 : 1, s.cls === 'J' ? 1.6 : 1).setPosition(s.x, 0, s.z);
        im.setMatrixAt(i, m4);
        im.setColorAt(i, col.set(s.z > L ? '#c0392b' : CLASS_COLOR[s.cls]));
      });
      im.count = plan.seats.length;
      this.content.add(im);
      for (const b of plan.blocks) {
        const h = b.kind === 'galley' ? 1.1 : 2.0;
        const m = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0 - 0.05, h, b.z1 - b.z0 - 0.05).translate((b.x0 + b.x1) / 2, h / 2, (b.z0 + b.z1) / 2),
          new THREE.MeshStandardMaterial({ color: b.z1 > L ? '#c0392b' : b.kind === 'galley' ? '#aeb3ba' : '#dfe3e8', roughness: 0.5 }));
        this.content.add(m);
      }
      if (over) {
        const end = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.02, 0.06).translate(0, 0.01, L), new THREE.MeshBasicMaterial({ color: '#ff5a4a' }));
        this.content.add(end);
      }
    } else {
      this.c.items.forEach((it, i) => {
        const d = FREE_ITEMS[it.kind];
        if (!d) return;
        const h = it.kind === 'bed' ? 0.5 : it.kind === 'shower' || it.kind === 'lav' ? 2.0 : it.kind === 'screen' ? 1.0 : it.kind === 'table' || it.kind === 'meeting' ? 0.75 : it.kind === 'bar' || it.kind === 'galley' ? 1.05 : 0.9;
        const geo = it.kind === 'seat' ? this.seatGeo : new THREE.BoxGeometry(d.w, h, d.d).translate(0, it.kind === 'screen' ? 1.1 : h / 2, 0);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.6, emissive: i === this.sel ? '#335577' : '#000000' }));
        if (it.kind === 'seat') mesh.scale.set(d.w, 1.05, 1.1);
        mesh.position.set(it.x, 0, it.z);
        mesh.rotation.y = (-it.rot * Math.PI) / 180;
        mesh.userData.index = i;
        this.content.add(mesh);
        this.itemMeshes.push(mesh);
      });
    }
  }

  private bindPointer(): void {
    const el = this.shell.renderer.domElement;
    const ndc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    el.addEventListener('pointerdown', (e) => {
      if (this.c.mode !== 'free') return;
      this.ray.setFromCamera(ndc(e), this.shell.camera);
      const hit = this.ray.intersectObjects(this.itemMeshes, false)[0];
      if (hit) {
        this.sel = hit.object.userData.index;
        this.drag = true;
        this.shell.controls.enabled = false;
        el.setPointerCapture(e.pointerId);
        this.rebuild();
        this.render();
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag || this.sel < 0) return;
      this.ray.setFromCamera(ndc(e), this.shell.camera);
      const p = new THREE.Vector3();
      if (!this.ray.ray.intersectPlane(this.floor, p)) return;
      const it = this.c.items[this.sel];
      this.place(it, p.x, p.z);
      const mesh = this.itemMeshes.find((m) => m.userData.index === this.sel);
      mesh?.position.set(it.x, 0, it.z);
    });
    el.addEventListener('pointerup', () => {
      if (!this.drag) return;
      this.drag = false;
      this.shell.controls.enabled = true;
      this.render();
    });
    this.keyHandler = (e: KeyboardEvent) => {
      if (this.c.mode !== 'free' || this.sel < 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'r' || e.key === 'R') this.rotateSel();
      if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSel();
    };
    addEventListener('keydown', this.keyHandler);
    const close = this.shell.close.bind(this.shell);
    this.shell.close = () => {
      removeEventListener('keydown', this.keyHandler);
      this.seatGeo.dispose();
      close();
    };
  }

  private keyHandler: (e: KeyboardEvent) => void = () => {};

  /** Snap to a 10 cm grid, keep inside the cabin, and stick to a wall when close to it. */
  private place(it: CabinItem, x: number, z: number): void {
    const d = FREE_ITEMS[it.kind];
    const turned = it.rot % 180 !== 0;
    const hw = (turned ? d.d : d.w) / 2;
    const hd = (turned ? d.w : d.d) / 2;
    const lim = this.widthM / 2 - hw;
    x = Math.round(x * 10) / 10;
    z = Math.round(z * 10) / 10;
    if (Math.abs(Math.abs(x) - lim) < 0.2) x = Math.sign(x) * lim;
    it.x = Math.max(-lim, Math.min(lim, x));
    it.z = Math.max(hd, Math.min(this.lengthM - hd, z));
  }

  private rotateSel(): void {
    const it = this.c.items[this.sel];
    if (!it) return;
    it.rot = (it.rot + 90) % 360;
    this.place(it, it.x, it.z);
    this.rebuild();
  }

  private deleteSel(): void {
    if (this.sel < 0) return;
    this.c.items.splice(this.sel, 1);
    this.sel = -1;
    this.rebuild();
    this.render();
  }

  // ------------------------------------------------------------------ panel
  private render(): void {
    const c = this.c;
    const st = cabinStats(this.t, c);
    const same = this.fleet.filter((a) => a.typeId === this.t.id);
    const usedPct = Math.min(100, (st.lengthUsedM / st.lengthAvailM) * 100);
    const zones = c.zones.map((z, i) => `<div class="zone">
        <div class="zhead"><select data-z="${i}.cls">${(['J', 'W', 'Y'] as CabinClass[]).map((k) => `<option value="${k}" ${k === z.cls ? 'selected' : ''}>${CLS_LABEL[k]}</option>`).join('')}</select>
          <button class="btn sm" data-zup="${i}" title="Move forward">↑</button><button class="btn sm" data-zdel="${i}" title="Remove">✕</button></div>
        <label class="edf"><span>Rows <b>${z.rows}</b></span><input type="range" min="1" max="60" step="1" value="${z.rows}" data-z="${i}.rows"></label>
        <label class="edf"><span>Seats abreast</span><select data-z="${i}.abreast">${abreastOptions(this.t, z.cls).concat(z.abreast).filter((v, k, a) => a.indexOf(v) === k).sort().map((v) => `<option ${v === z.abreast ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="edf"><span>Seat pitch <b>${z.pitchIn}"</b></span><input type="range" min="${PITCH[z.cls][0]}" max="${PITCH[z.cls][1]}" step="1" value="${z.pitchIn}" data-z="${i}.pitchIn"></label>
      </div>`).join('');
    const free = Object.entries(FREE_ITEMS).map(([k, d]) => `<button class="chip" data-item="${k}"><i class="sw" style="background:${d.color}"></i>${d.label}</button>`).join('');
    const selItem = c.items[this.sel];
    this.shell.setBody(`
      <section><h2>Layout</h2><div class="chips">
        <button class="chip ${c.mode === 'rows' ? 'on' : ''}" data-mode="rows">Seat rows</button>
        <button class="chip ${c.mode === 'free' ? 'on' : ''}" data-mode="free">VIP free layout</button></div>
        ${c.mode === 'rows' ? `<div class="chips"><button class="chip" data-preset="factory">Factory</button><button class="chip" data-preset="dense">Max density</button><button class="chip" data-preset="premium">Premium heavy</button><button class="chip" data-preset="3class">Three class</button></div>` : ''}</section>
      <section class="stats"><h2>Result</h2>
        <div class="kv"><span>Seats</span><b>${st.total}</b><span>Business / premium / economy</span><b>${st.j} / ${st.w} / ${st.y}</b>
        <span>Comfort</span><b>${Math.round(st.comfort * 100)}%</b><span>Exit limit</span><b>${st.maxSeats}</b></div>
        ${c.mode === 'rows' ? `<div class="meter ${st.lengthUsedM > st.lengthAvailM + 0.05 ? 'bad' : ''}"><i style="width:${usedPct}%"></i></div><p class="note">${st.lengthUsedM.toFixed(1)} m of ${st.lengthAvailM.toFixed(1)} m cabin used</p>` : ''}
        ${st.errors.map((e) => `<div class="warn">${e}</div>`).join('')}
      </section>
      ${c.mode === 'rows' ? `<section><h2>Cabin zones <small>(front to back)</small></h2>${zones}
        <div class="chips"><button class="chip" data-addz="J">+ Business</button><button class="chip" data-addz="W">+ Premium economy</button><button class="chip" data-addz="Y">+ Economy</button></div></section>
        <section><h2>Galleys & lavatories</h2>
        <label class="edf"><span>Galleys <b>${c.galleys}</b></span><input type="range" min="0" max="6" step="1" value="${c.galleys}" data-n="galleys"></label>
        <label class="edf"><span>Lavatories <b>${c.lavs}</b></span><input type="range" min="0" max="10" step="1" value="${c.lavs}" data-n="lavs"></label></section>`
      : `<section><h2>Add furniture</h2><div class="chips">${free}</div>
        <p class="note">Drag items on the floor to move them (10 cm grid, they stick to the walls). Select one, then R to rotate or Delete to remove.</p>
        ${selItem ? `<div class="row"><b>${FREE_ITEMS[selItem.kind].label}</b><button class="btn sm" id="rot">Rotate</button><button class="btn sm" id="del">Remove</button></div>` : ''}
        <div class="row"><button class="btn sm" id="clear">Clear all</button><button class="btn sm" id="vipPreset">VIP starter layout</button></div></section>`}
      <section><h2>Apply to</h2><div class="checks">${same.map((a) => `<label><input type="checkbox" data-ac="${a.id}" ${this.apply.has(a.id) ? 'checked' : ''}> ${a.reg}</label>`).join('')}</div>
        <p class="note">Refit: $150k per aircraft.</p></section>`);
    const body = this.shell.panel;
    const on = (q: string, ev: string, fn: (el: HTMLElement) => void) => body.querySelectorAll<HTMLElement>(q).forEach((el) => el.addEventListener(ev, () => fn(el)));
    const changed = () => { this.rebuild(); this.render(); };
    on('[data-mode]', 'click', (el) => {
      c.mode = el.dataset.mode as CabinLayout['mode'];
      if (c.mode === 'free' && !c.items.length) this.vipPreset();
      this.sel = -1;
      changed();
    });
    on('[data-preset]', 'click', (el) => { this.preset(el.dataset.preset!); changed(); });
    on('[data-z]', 'change', (el) => {
      const [i, k] = el.dataset.z!.split('.');
      const z = c.zones[+i];
      const v = (el as HTMLInputElement).value;
      if (k === 'cls') {
        z.cls = v as CabinClass;
        z.abreast = abreastOptions(this.t, z.cls)[0];
        z.pitchIn = Math.max(PITCH[z.cls][0], Math.min(PITCH[z.cls][1], z.pitchIn));
      } else (z as unknown as Record<string, number>)[k] = +v;
      changed();
    });
    on('input[type=range][data-z]', 'input', (el) => {
      const [i, k] = el.dataset.z!.split('.');
      (c.zones[+i] as unknown as Record<string, number>)[k] = +(el as HTMLInputElement).value;
      this.rebuild();
      const b = el.parentElement?.querySelector('b');
      if (b) b.textContent = k === 'pitchIn' ? `${(el as HTMLInputElement).value}"` : (el as HTMLInputElement).value;
    });
    on('[data-n]', 'input', (el) => {
      (c as unknown as Record<string, number>)[el.dataset.n!] = +(el as HTMLInputElement).value;
      this.rebuild();
      const b = el.parentElement?.querySelector('b');
      if (b) b.textContent = (el as HTMLInputElement).value;
    });
    on('[data-n]', 'change', () => this.render());
    on('[data-zdel]', 'click', (el) => { c.zones.splice(+el.dataset.zdel!, 1); changed(); });
    on('[data-zup]', 'click', (el) => {
      const i = +el.dataset.zup!;
      if (i > 0) [c.zones[i - 1], c.zones[i]] = [c.zones[i], c.zones[i - 1]];
      changed();
    });
    on('[data-addz]', 'click', (el) => {
      const cls = el.dataset.addz as CabinClass;
      const zone = { cls, rows: cls === 'Y' ? 5 : 3, abreast: abreastOptions(this.t, cls)[0], pitchIn: cls === 'J' ? 40 : cls === 'W' ? 36 : 30 };
      const at = cls === 'Y' ? c.zones.length : c.zones.findIndex((z) => z.cls === 'Y' || (cls === 'J' && z.cls === 'W'));
      c.zones.splice(at < 0 ? c.zones.length : at, 0, zone);
      changed();
    });
    on('[data-item]', 'click', (el) => {
      const it: CabinItem = { kind: el.dataset.item!, x: 0, z: this.lengthM / 2, rot: 0 };
      this.place(it, 0, this.lengthM / 2);
      c.items.push(it);
      this.sel = c.items.length - 1;
      changed();
    });
    on('#rot', 'click', () => this.rotateSel());
    on('#del', 'click', () => this.deleteSel());
    on('#clear', 'click', () => { c.items = []; this.sel = -1; changed(); });
    on('#vipPreset', 'click', () => { this.vipPreset(); changed(); });
    on('[data-ac]', 'change', (el) => {
      if ((el as HTMLInputElement).checked) this.apply.add(el.dataset.ac!);
      else this.apply.delete(el.dataset.ac!);
    });
  }

  private preset(id: string): void {
    const t = this.t;
    const c = this.c;
    const L = this.lengthM;
    const fixed = (g: number, l: number) => g * 1.2 + l * 1.0;
    const yA = abreastOptions(t, 'Y')[0];
    const IN = 0.0254;
    if (id === 'factory') Object.assign(c, defaultCabin(t), { mode: 'rows' });
    if (id === 'dense') {
      const total = cabinGeometry(t).maxSeats;
      const rowsFit = Math.floor((L - fixed(2, 2)) / (28 * IN));
      const rows = Math.min(rowsFit, Math.floor(total / yA));
      c.zones = [{ cls: 'Y', rows, abreast: yA, pitchIn: 28 }];
      c.galleys = 2;
      c.lavs = Math.max(2, Math.ceil((rows * yA) / 60));
    }
    if (id === 'premium' || id === '3class') {
      const jA = abreastOptions(t, 'J')[0];
      const wA = abreastOptions(t, 'W')[0];
      const jRows = id === 'premium' ? Math.max(3, Math.round(L / 6)) : Math.max(2, Math.round(L / 10));
      const jP = t.category === 'widebody' || t.category === 'jumbo' ? 60 : 40;
      const wRows = id === '3class' ? Math.max(2, Math.round(L / 12)) : 0;
      c.galleys = 3;
      c.lavs = 4;
      const left = L - fixed(3, 4) - jRows * jP * IN - wRows * 36 * IN;
      c.zones = [{ cls: 'J', rows: jRows, abreast: jA, pitchIn: jP }];
      if (wRows) c.zones.push({ cls: 'W', rows: wRows, abreast: wA, pitchIn: 36 });
      c.zones.push({ cls: 'Y', rows: Math.max(1, Math.floor(left / (31 * IN))), abreast: yA, pitchIn: 31 });
    }
    c.mode = 'rows';
  }

  private vipPreset(): void {
    const L = this.lengthM;
    const W = this.widthM;
    const items: CabinItem[] = [
      { kind: 'galley', x: 0, z: 0.6, rot: 0 },
      { kind: 'lav', x: W / 2 - 0.5, z: 1.8, rot: 0 },
    ];
    let z = 3;
    for (let i = 0; i < 2 && z < L - 4; i++, z += 1.1) items.push({ kind: 'seat', x: -W / 2 + 0.4, z, rot: 0 }, { kind: 'seat', x: W / 2 - 0.4, z, rot: 0 });
    if (W > 3) items.push({ kind: 'divan', x: -W / 2 + 0.4, z: z + 1, rot: 90 }, { kind: 'table', x: 0.3, z: z + 1, rot: 0 });
    z += 2.5;
    if (z < L - 3) items.push({ kind: 'meeting', x: 0, z: z + 0.6, rot: 0 });
    if (L > 14) items.push({ kind: 'bed', x: 0, z: L - 2.2, rot: 0 }, { kind: 'shower', x: W / 2 - 0.5, z: L - 4, rot: 0 });
    items.push({ kind: 'lav', x: -W / 2 + 0.5, z: L - 0.6, rot: 0 });
    this.c.items = items;
    for (const it of items) this.place(it, it.x, it.z);
  }
}
