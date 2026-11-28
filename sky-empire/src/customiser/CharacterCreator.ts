import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterLook } from '../economy/types';
import { EditorShell, bindFields, field } from './EditorShell';
import { DEFAULT_LOOK, HAIR_COLOURS, SKIN_TONES, applyLook } from './characterLook';
import type { Brand } from './liveryPainter';

/** Character creator: proportions, skin, hair and outfit, previewed on the animated pilot rig. */
export class CharacterCreator {
  private shell: EditorShell;
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction> = {};
  private post: () => void = () => {};
  private look: CharacterLook;
  private anim = 'Idle';

  constructor(gltf: GLTF, look: CharacterLook | undefined, private brand: Brand, onApply: (l: CharacterLook) => void, onClose: () => void) {
    this.look = { ...DEFAULT_LOOK, ...look };
    this.shell = new EditorShell('Character creator', 'This is you: walking the airport, flying, and later at your mansion. Drag to turn, scroll to zoom.', onClose, 'Save look');
    this.model = cloneSkinned(gltf.scene);
    this.model.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    this.shell.scene.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(clip.name === this.anim ? 1 : 0);
      this.actions[clip.name] = a;
    }
    this.shell.camera.position.set(1.5, 1.45, -3.6);
    this.shell.camera.near = 0.02;
    this.shell.controls.target.set(0, 0.95, 0);
    this.shell.controls.minDistance = 0.8;
    this.shell.controls.maxDistance = 8;
    this.shell.onFrame = (dt) => {
      this.mixer.update(dt);
      this.post();
    };
    this.shell.onApply(() => onApply({ ...this.look }));
    this.render();
    this.refresh();
  }

  private refresh(): void {
    this.post = applyLook(this.model, this.look, this.brand);
  }

  private render(): void {
    const L = this.look;
    const sw = (key: 'skin' | 'hair', list: string[]) => `<div class="swatches">${list.map((c) => `<button class="swatch ${L[key] === c ? 'on' : ''}" data-sw="${key}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>`;
    this.shell.setBody(`
      <section><h2>Body</h2>
        ${field.range('height', 'Height', L.height, 0.9, 1.1, 0.01, '×')}
        ${field.range('build', 'Build', L.build, 0.85, 1.2, 0.01, '×')}
        ${field.range('head', 'Head size', L.head, 0.9, 1.12, 0.01, '×')}
      </section>
      <section><h2>Skin</h2>${sw('skin', SKIN_TONES)}${field.color('skin', 'Custom', L.skin)}</section>
      <section><h2>Hair</h2>
        ${field.select('hairStyle', 'Style', L.hairStyle, [['short', 'Short'], ['long', 'Long'], ['bald', 'Shaved']])}
        ${sw('hair', HAIR_COLOURS)}${field.color('hair', 'Custom', L.hair)}
      </section>
      <section><h2>Outfit</h2>
        ${field.select('outfit', 'Outfit', L.outfit, [['pilot', 'Captain\'s uniform'], ['ceo', 'CEO suit'], ['casual', 'Casual (airline polo)']])}
        ${L.outfit === 'pilot' ? field.check('cap', 'Captain\'s cap', L.cap) : ''}
        <p class="note">Uniforms use your airline colours (${this.brand.name || 'your brand'}).</p>
      </section>
      <section><h2>Preview</h2><div class="chips">${['Idle', 'Walk', 'Run'].map((a) => `<button class="chip ${a === this.anim ? 'on' : ''}" data-anim="${a}">${a}</button>`).join('')}</div></section>`);
    const body = this.shell.panel;
    bindFields(body, L as unknown as Record<string, unknown>, (k) => {
      this.refresh();
      if (k === 'outfit') this.render();
    });
    body.querySelectorAll<HTMLElement>('[data-sw]').forEach((b) => b.addEventListener('click', () => {
      L[b.dataset.sw as 'skin' | 'hair'] = b.dataset.c!;
      this.refresh();
      this.render();
    }));
    body.querySelectorAll<HTMLElement>('[data-anim]').forEach((b) => b.addEventListener('click', () => {
      this.anim = b.dataset.anim!;
      for (const [n, a] of Object.entries(this.actions)) a.setEffectiveWeight(n === this.anim ? 1 : 0);
      this.render();
    }));
  }
}
