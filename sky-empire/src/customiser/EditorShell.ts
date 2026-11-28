import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Full-screen editor frame: a controls panel on the left and a live 3D preview on the right
 * (its own small renderer with studio lighting and orbit controls). Shared by the livery editor,
 * cabin editor, aircraft designer and character creator.
 */
export class EditorShell {
  readonly el: HTMLElement;
  readonly panel: HTMLElement;
  readonly view: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 2000);
  readonly controls: OrbitControls;
  private raf = 0;
  private ro: ResizeObserver;
  onFrame: ((dt: number) => void) | null = null;

  constructor(title: string, subtitle: string, private onClose: () => void, applyLabel = 'Apply') {
    this.el = document.createElement('div');
    this.el.className = 'editor';
    this.el.innerHTML = `<aside class="edpanel"><header><h1>${title}</h1><p class="note">${subtitle}</p></header><div class="edbody"></div>
      <footer><button class="btn" data-ed="close">Close</button><button class="btn primary" data-ed="apply">${applyLabel}</button></footer></aside>
      <main class="edview"></main>`;
    document.body.appendChild(this.el);
    this.panel = this.el.querySelector('.edbody')!;
    this.view = this.el.querySelector('.edview')!;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.view.appendChild(this.renderer.domElement);
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__editor = this;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.background = new THREE.Color('#0b1220');
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(30, 60, 40);
    this.scene.add(sun, new THREE.HemisphereLight('#c9dcff', '#1a1f2a', 0.6));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#141c2b', roughness: 0.9 }));
    floor.position.y = -0.01;
    this.scene.add(floor);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.view);
    this.el.querySelector('[data-ed="close"]')!.addEventListener('click', () => this.close());
    this.resize();
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      this.onFrame?.((now - last) / 1000);
      last = now;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  onApply(fn: () => void): void {
    this.el.querySelector('[data-ed="apply"]')!.addEventListener('click', fn);
  }

  setBody(html: string): void {
    this.panel.innerHTML = html;
  }

  private resize(): void {
    const w = this.view.clientWidth;
    const h = this.view.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.dispose();
    this.el.remove();
    this.onClose();
  }
}

/** Small helpers for building editor forms. */
export const field = {
  color: (key: string, label: string, value: string) => `<label class="edf"><span>${label}</span><input type="color" data-k="${key}" value="${value}"></label>`,
  range: (key: string, label: string, value: number, min: number, max: number, step: number, unit = '') =>
    `<label class="edf"><span>${label} <b data-out="${key}">${round(value, step)}${unit}</b></span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`,
  text: (key: string, label: string, value: string) => `<label class="edf"><span>${label}</span><input type="text" data-k="${key}" value="${escAttr(value)}"></label>`,
  select: (key: string, label: string, value: string, opts: [string, string][]) =>
    `<label class="edf"><span>${label}</span><select data-k="${key}">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`,
  check: (key: string, label: string, value: boolean) => `<label class="edf row"><span>${label}</span><input type="checkbox" data-k="${key}" ${value ? 'checked' : ''}></label>`,
};

function round(v: number, step: number): string {
  const d = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return v.toFixed(d);
}

export const escAttr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Read/write nested values by dotted keys ("title.size"). */
export function getPath(o: Record<string, unknown>, k: string): unknown {
  return k.split('.').reduce<unknown>((x, p) => (x as Record<string, unknown>)?.[p], o);
}

export function setPath(o: Record<string, unknown>, k: string, v: unknown): void {
  const parts = k.split('.');
  const last = parts.pop()!;
  const target = parts.reduce<Record<string, unknown>>((x, p) => x[p] as Record<string, unknown>, o);
  target[last] = v;
}

/** Wire every [data-k] input in `root` to `obj`, calling onChange after each edit. */
export function bindFields(root: HTMLElement, obj: Record<string, unknown>, onChange: (key: string) => void, exclude?: string): void {
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
    if (exclude && el.closest(exclude)) return;
    const key = el.dataset.k!;
    const ev = el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'color' || el.type === 'text') ? 'input' : 'change';
    el.addEventListener(ev, () => {
      let v: unknown = el.value;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'range') v = Number(el.value);
      setPath(obj, key, v);
      const out = root.querySelector<HTMLElement>(`[data-out="${key}"]`);
      if (out && el instanceof HTMLInputElement && el.type === 'range') out.textContent = round(Number(el.value), Number(el.step));
      onChange(key);
    });
  });
}
