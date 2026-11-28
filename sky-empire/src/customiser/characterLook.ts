import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CharacterLook } from '../economy/types';
import type { Brand } from './liveryPainter';

export const DEFAULT_LOOK: CharacterLook = { height: 1, build: 1, head: 1, skin: '#c9956f', hair: '#3b2a1e', hairStyle: 'short', outfit: 'pilot', cap: true };

export const SKIN_TONES = ['#f3d2b8', '#e8b994', '#c9956f', '#a8714c', '#7d4f33', '#4f3020'];
export const HAIR_COLOURS = ['#111111', '#3b2a1e', '#6b4a2e', '#a87a46', '#d8b86c', '#9a9a9a', '#e6e6e6', '#8a2f1c'];

const shade = (hex: string, k: number) => {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, hsl.s * 0.9, Math.max(0.04, Math.min(0.9, hsl.l * k)));
};

/**
 * Apply a character look to a cloned pilot model: material colours per outfit (in the airline's
 * colours), proportions, hair style and an optional cap. Returns a function to call after each
 * animation update (bone scales would otherwise be overwritten by the clips).
 */
export function applyLook(model: THREE.Object3D, look: CharacterLook, brand: Brand): () => void {
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const out = list.map((mat) => {
      let c = mats.get(mat.name);
      if (!c) {
        c = (mat as THREE.MeshStandardMaterial).clone();
        mats.set(mat.name, c);
      }
      return c;
    });
    m.material = Array.isArray(m.material) ? out : out[0];
  });
  const set = (name: string, col: THREE.ColorRepresentation, metal?: number) => {
    const m = mats.get(name);
    if (!m) return;
    m.color.set(col);
    if (metal !== undefined) m.metalness = metal;
  };
  const primary = brand.colors.primary;
  set('skin', look.skin);
  set('eyes', '#1a1410');
  set('hair', look.hairStyle === 'bald' ? look.skin : look.hair);
  if (look.outfit === 'pilot') {
    set('uniform_jacket', shade(primary, 0.45));
    set('uniform_trousers', shade(primary, 0.32));
    set('shirt_white', '#eeeeee');
    set('gold_braid', '#d4a537', 0.9);
    set('shoes', '#0a0a0a');
  } else if (look.outfit === 'ceo') {
    set('uniform_jacket', '#24272d');
    set('uniform_trousers', '#24272d'); // the tie shares this material
    set('shirt_white', '#f4f4f4');
    set('gold_braid', '#24272d', 0);
    set('shoes', '#2a1a10');
  } else {
    set('uniform_jacket', primary);
    set('uniform_trousers', '#3b4a63');
    set('shirt_white', brand.colors.accent);
    set('gold_braid', primary, 0);
    set('shoes', '#e8e8e8');
  }

  // extras on the head bone: long hair and the cap
  const head = model.getObjectByName('head');
  model.getObjectByName('look_extras')?.removeFromParent();
  const extras = new THREE.Group();
  extras.name = 'look_extras';
  if (head) {
    head.add(extras);
    // the head bone runs from neck to crown along its +Y; the face looks along F·Z
    const F = -1;
    // face: the base model's eyes sit inside the head, so draw eyes, brows and a nose here
    const white = new THREE.MeshStandardMaterial({ color: '#f2f0ea', roughness: 0.3 });
    const iris = new THREE.MeshStandardMaterial({ color: '#2a1d14', roughness: 0.2 });
    const browMat = new THREE.MeshStandardMaterial({ color: look.hair === look.skin ? '#3b2a1e' : look.hair, roughness: 0.8 });
    const skinMat = mats.get('skin') ?? new THREE.MeshStandardMaterial({ color: look.skin });
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.013, 10, 8).scale(1.2, 0.8, 0.5), white);
      eye.position.set(sx * 0.031, 0.114, F * 0.097);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 8, 6).scale(1, 1, 0.5), iris);
      pupil.position.set(sx * 0.031, 0.114, F * 0.1035);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.006, 0.008), browMat);
      brow.position.set(sx * 0.031, 0.133, F * 0.098);
      brow.rotation.z = sx * -0.12;
      extras.add(eye, pupil, brow);
    }
    const noseM = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8).scale(0.85, 1.35, 0.9), skinMat);
    noseM.position.set(0, 0.088, F * 0.104);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.005, 0.006), new THREE.MeshStandardMaterial({ color: '#7a3b33', roughness: 0.6 }));
    mouth.position.set(0, 0.058, F * 0.094);
    extras.add(noseM, mouth);
    if (look.hairStyle === 'long') {
      const hair = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.17, 6, 16).scale(1.12, 1, 0.72), new THREE.MeshStandardMaterial({ color: look.hair, roughness: 0.8 }));
      hair.position.set(0, 0.04, -F * 0.04);
      extras.add(hair);
    }
    if (look.cap && look.outfit === 'pilot') {
      const capMat = new THREE.MeshStandardMaterial({ color: shade(primary, 0.4), roughness: 0.6 });
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.104, 0.092, 0.07, 20), capMat);
      crown.position.set(0, 0.175, 0);
      const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.008, 20, 1, false, -Math.PI / 2.4, Math.PI / 1.2), new THREE.MeshStandardMaterial({ color: '#0b0b0b', roughness: 0.3 }));
      peak.position.set(0, 0.146, F * 0.045);
      peak.rotation.y = F < 0 ? Math.PI : 0;
      const badge = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.022, 0.006), new THREE.MeshStandardMaterial({ color: '#d4a537', metalness: 0.9, roughness: 0.3 }));
      badge.position.set(0, 0.18, F * 0.096);
      extras.add(crown, peak, badge);
    }
    // one draw call for all the face, hair and cap pieces (vertex colours) instead of ~12
    const parts: THREE.BufferGeometry[] = [];
    for (const o of [...extras.children] as THREE.Mesh[]) {
      o.updateMatrix();
      const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrix);
      g.deleteAttribute('uv');
      const col = (o.material as THREE.MeshStandardMaterial).color;
      const n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [col.r, col.g, col.b][i % 3]), 3));
      parts.push(g);
      o.geometry.dispose();
      extras.remove(o);
    }
    if (parts.length) {
      const merged = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
      parts.forEach((p) => p.dispose());
      extras.add(merged);
    }
  }
  extras.traverse((o) => ((o as THREE.Mesh).castShadow = true));

  model.scale.set(look.build, look.height, look.build);
  const bones: [string, number][] = [['head', look.head]];
  return () => {
    for (const [n, s] of bones) model.getObjectByName(n)?.scale.setScalar(s);
  };
}
