import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import a320 from '@data/aircraft/a320neo.json';
import { AircraftModel, type AircraftData } from '../flight/AircraftModel';
import type { Livery, LiveryLayer } from '../economy/types';
import { EditorShell, bindFields, escAttr, field } from './EditorShell';
import { defaultLivery, newLayer, type Brand } from './liveryPainter';

const FONT_OPTS: [string, string][] = [['sans', 'Modern sans'], ['condensed', 'Condensed'], ['rounded', 'Rounded'], ['serif', 'Classic serif'], ['script', 'Script'], ['mono', 'Technical']];
const KIND_LABEL: Record<LiveryLayer['kind'], string> = { band: 'Band', stripe: 'Stripe', text: 'Text', logo: 'Logo' };

/**
 * Livery editor: edit base colours, belly and cheatline, titles, tail art, an uploaded
 * logo and any number of paint layers, with a live 3D aircraft to spin around.
 */
export class LiveryEditor {
  private shell: EditorShell;
  private model: AircraftModel;
  private L: Livery;
  private sel: string | null = null;
  private timer = 0;

  constructor(gltf: GLTF, livery: Livery | undefined, private brand: Brand, private reg: string, onApply: (l: Livery) => void, onClose: () => void) {
    this.L = structuredClone(livery ?? defaultLivery(brand));
    this.shell = new EditorShell('Livery editor', 'Design your airline\'s look. Drag the aircraft to spin it, scroll to zoom. Changes apply to the whole fleet.', onClose, 'Apply to fleet');
    this.model = new AircraftModel(gltf, a320 as unknown as AircraftData, brand, reg, 2048, 50);
    this.shell.scene.add(this.model.root);
    this.shell.camera.position.set(-44, 16, -46);
    this.shell.controls.target.set(0, 4.5, 2);
    this.shell.controls.autoRotate = true;
    this.shell.controls.autoRotateSpeed = 0.6;
    this.shell.renderer.domElement.addEventListener('pointerdown', () => (this.shell.controls.autoRotate = false));
    this.shell.onApply(() => onApply(structuredClone(this.L)));
    this.render();
    this.repaint();
  }

  private repaint(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.model.applyLivery(this.L, this.reg, 2048), 120);
  }

  private render(): void {
    const L = this.L;
    const sel = L.layers.find((x) => x.id === this.sel);
    this.shell.setBody(`
      <section><h2>Quick start</h2><div class="chips">
        <button class="chip" data-preset="classic">Classic</button><button class="chip" data-preset="bold">Bold belly</button>
        <button class="chip" data-preset="minimal">Minimal white</button><button class="chip" data-preset="tail">Statement tail</button></div></section>
      <section><h2>Fuselage</h2>
        ${field.color('base', 'Fuselage', L.base)}
        ${field.color('belly.color', 'Belly', L.belly.color)}
        ${field.range('belly.height', 'Belly line height', L.belly.height, -2, 1.6, 0.05, ' m')}
        ${field.range('belly.sweep', 'Sweep toward the tail', L.belly.sweep, 0, 1.6, 0.05)}
        ${field.check('cheat.on', 'Cheatline', L.cheat.on)}
        ${field.color('cheat.color', 'Cheatline colour', L.cheat.color)}
        ${field.range('cheat.width', 'Cheatline width', L.cheat.width, 0.04, 0.6, 0.01, ' m')}
        ${field.color('windowFrame', 'Window frames', L.windowFrame)}
        ${field.color('engines', 'Engines', L.engines)}
      </section>
      <section><h2>Titles</h2>
        ${field.text('title.text', 'Text', L.title.text)}
        ${field.select('title.font', 'Font', L.title.font, FONT_OPTS)}
        ${field.color('title.color', 'Colour', L.title.color)}
        ${field.range('title.size', 'Size', L.title.size, 0.3, 1.5, 0.02, ' m')}
        ${field.range('title.s', 'Position along fuselage', L.title.s, 6, 26, 0.1, ' m')}
        ${field.range('title.height', 'Height', L.title.height, 0.4, 1.7, 0.02, ' m')}
        ${field.check('title.italic', 'Italic', L.title.italic)}
        ${field.color('regColor', 'Registration', L.regColor)}
      </section>
      <section><h2>Tail</h2>
        ${field.select('tail.style', 'Tail art', L.tail.style, [['swoosh', 'Swoosh + emblem'], ['emblem', 'Emblem'], ['stripes', 'Speed stripes'], ['logo', 'Your logo'], ['solid', 'Solid colour']])}
        ${field.color('tail.color', 'Tail colour', L.tail.color)}
        ${field.color('tail.accent', 'Accent', L.tail.accent)}
      </section>
      <section><h2>Logo</h2>
        <div class="logobox">${L.logo ? `<img src="${L.logo}" alt="Airline logo">` : '<span class="note">No logo yet</span>'}</div>
        <div class="row"><label class="btn sm">Upload PNG or SVG<input type="file" id="logoFile" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden></label>
        ${L.logo ? '<button class="btn sm" id="logoRemove">Remove</button>' : ''}</div>
        <p class="note">Use it on the tail (Tail art: Your logo) or add a Logo layer on the fuselage.</p>
      </section>
      <section><h2>Layers</h2>
        <div class="chips"><button class="chip" data-add="band">+ Band</button><button class="chip" data-add="stripe">+ Stripe</button><button class="chip" data-add="text">+ Text</button><button class="chip" data-add="logo">+ Logo</button></div>
        <ul class="layers">${L.layers.map((ly, i) => `<li class="${ly.id === this.sel ? 'on' : ''}" data-sel="${ly.id}"><i class="sw" style="background:${ly.color}"></i>${KIND_LABEL[ly.kind]}${ly.kind === 'text' ? `: ${escAttr(ly.text)}` : ''}
          <span><button data-vis="${ly.id}" title="Show/hide">${ly.visible ? '👁' : '–'}</button><button data-up="${i}" title="Move up">↑</button><button data-del="${ly.id}" title="Delete">✕</button></span></li>`).join('')}</ul>
        ${sel ? `<div class="layerprops">
          ${sel.kind !== 'logo' ? field.color('color', 'Colour', sel.color) : ''}
          ${sel.kind === 'text' ? field.text('text', 'Text', sel.text) + field.select('font', 'Font', sel.font, FONT_OPTS) : ''}
          ${field.range('s0', sel.kind === 'band' || sel.kind === 'stripe' ? 'Start (from nose)' : 'Position along fuselage', sel.s0, 0, 37.5, 0.1, ' m')}
          ${sel.kind === 'band' || sel.kind === 'stripe' ? field.range('s1', 'End', sel.s1, 0, 37.6, 0.1, ' m') : ''}
          ${field.range('h', 'Height', sel.h, -2, 2, 0.02, ' m')}
          ${field.range('height', sel.kind === 'band' || sel.kind === 'stripe' ? 'Thickness' : 'Size', sel.height, 0.04, 2, 0.02, ' m')}
          ${sel.kind === 'band' ? field.range('sweep', 'Sweep toward the tail', sel.sweep, 0, 1.6, 0.05) : ''}
        </div>` : '<p class="note">Select a layer to edit it.</p>'}
      </section>`);
    const body = this.shell.panel;
    bindFields(body, L as unknown as Record<string, unknown>, () => this.repaint(), '.layerprops');
    const props = body.querySelector<HTMLElement>('.layerprops');
    if (props && sel) bindFields(props, sel as unknown as Record<string, unknown>, () => this.repaint());
    const on = (q: string, fn: (el: HTMLElement) => void) => body.querySelectorAll<HTMLElement>(q).forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); fn(el); }));
    on('[data-add]', (el) => {
      const ly = newLayer(el.dataset.add as LiveryLayer['kind'], L.cheat.color);
      L.layers.push(ly);
      this.sel = ly.id;
      this.render();
      this.repaint();
    });
    on('[data-sel]', (el) => { this.sel = el.dataset.sel!; this.render(); });
    on('[data-vis]', (el) => { const ly = L.layers.find((x) => x.id === el.dataset.vis)!; ly.visible = !ly.visible; this.render(); this.repaint(); });
    on('[data-del]', (el) => { L.layers = L.layers.filter((x) => x.id !== el.dataset.del); this.render(); this.repaint(); });
    on('[data-up]', (el) => {
      const i = +el.dataset.up!;
      if (i > 0) [L.layers[i - 1], L.layers[i]] = [L.layers[i], L.layers[i - 1]];
      this.render();
      this.repaint();
    });
    on('[data-preset]', (el) => { this.preset(el.dataset.preset!); this.render(); this.repaint(); });
    body.querySelector('#logoRemove')?.addEventListener('click', () => { L.logo = undefined; this.render(); this.repaint(); });
    body.querySelector<HTMLInputElement>('#logoFile')?.addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      L.logo = await shrinkImage(f, 512);
      if (L.tail.style !== 'logo') L.tail.style = 'logo';
      this.render();
      this.repaint();
    });
  }

  private preset(id: string): void {
    const L = this.L;
    const p = this.brand.colors;
    if (id === 'classic') Object.assign(this.L, defaultLivery(this.brand), { logo: L.logo, title: { ...L.title } });
    if (id === 'bold') Object.assign(L, { belly: { color: p.primary, height: 0.2, sweep: 0.6 }, cheat: { on: true, color: p.accent, width: 0.1 }, base: '#ffffff' });
    if (id === 'minimal') Object.assign(L, { base: '#ffffff', belly: { color: '#d9dde2', height: -1.7, sweep: 0 }, cheat: { on: false, color: p.accent, width: 0.1 }, engines: '#e8eaed' });
    if (id === 'tail') {
      L.tail = { color: p.primary, style: 'stripes', accent: p.accent };
      L.layers.push({ ...newLayer('band', p.accent), s0: 18, s1: 37.6, h: -0.6, height: 0.3, sweep: 1.1 });
    }
  }
}

/** Read an uploaded image (PNG/SVG/JPG) and shrink it to fit `max` px, as a PNG data URL. */
async function shrinkImage(file: File, max: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || max;
    const h = img.naturalHeight || max;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type { Brand };
export { THREE };
