import * as THREE from 'three';

/**
 * Procedural ground textures generated on a canvas at load time: no downloads,
 * and they tile seamlessly. A low-frequency "macro" map breaks up visible repetition
 * across the large airfield surfaces.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a size x size grid with `cells` lattice cells. */
function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const lat = new Float32Array(cells * cells).map(() => r());
  const out = new Float32Array(size * size);
  const k = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * k;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const ya = (y0 % cells) * cells;
    const yb = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * k;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const xa = x0 % cells;
      const xb = (x0 + 1) % cells;
      const a = lat[ya + xa] + (lat[ya + xb] - lat[ya + xa]) * sx;
      const b = lat[yb + xa] + (lat[yb + xb] - lat[yb + xa]) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  }
  return out;
}

function fbm(size: number, base: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, base << o, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

type Painter = (img: ImageData, size: number, r: () => number) => void;

function canvasTexture(size: number, seed: number, paint: Painter, post?: (ctx: CanvasRenderingContext2D, r: () => number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const r = rng(seed);
  paint(img, size, r);
  ctx.putImageData(img, 0, 0);
  post?.(ctx, r);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function grainy(base: [number, number, number], blotch: number, grain: number, speck: number, seed: number): Painter {
  return (img, size, r) => {
    const n = fbm(size, 8, 4, seed);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      let v = (n[i] - 0.5) * blotch + (r() - 0.5) * grain;
      if (r() < speck) v += 25 + r() * 30;
      d[i * 4] = base[0] + v;
      d[i * 4 + 1] = base[1] + v;
      d[i * 4 + 2] = base[2] + v * 0.95;
      d[i * 4 + 3] = 255;
    }
  };
}

function cracks(count: number, color: string): (ctx: CanvasRenderingContext2D, r: () => number) => void {
  return (ctx, r) => {
    const s = ctx.canvas.width;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < count; i++) {
      let x = r() * s;
      let y = r() * s;
      let a = r() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const n = 8 + r() * 20;
      for (let k = 0; k < n; k++) {
        a += (r() - 0.5) * 0.9;
        x += Math.cos(a) * 9;
        y += Math.sin(a) * 9;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };
}

export interface GroundTextures {
  asphalt: THREE.Texture;
  runway: THREE.Texture;
  concrete: THREE.Texture;
  grass: THREE.Texture;
  paint: THREE.Texture;
  macro: THREE.Texture;
}

export function makeGroundTextures(size = 1024): GroundTextures {
  const asphalt = canvasTexture(size, 11, grainy([60, 61, 63], 22, 26, 0.004, 3), cracks(10, 'rgba(25,25,25,0.55)'));
  const runway = canvasTexture(size, 12, grainy([50, 51, 53], 18, 22, 0.003, 5), cracks(6, 'rgba(20,20,20,0.5)'));
  const concrete = canvasTexture(size, 13, grainy([156, 155, 149], 20, 14, 0.0, 7), (ctx, r) => {
    // 5 m slabs on a 10 m tile -> joints every half texture
    const s = ctx.canvas.width;
    ctx.fillStyle = 'rgba(70,70,66,0.75)';
    for (const p of [0, s / 2]) {
      ctx.fillRect(p - 1, 0, 2, s);
      ctx.fillRect(0, p - 1, s, 2);
    }
    for (let i = 0; i < 5; i++) {
      const x = r() * s;
      const y = r() * s;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 40 + r() * 90);
      g.addColorStop(0, 'rgba(60,55,50,0.25)');
      g.addColorStop(1, 'rgba(60,55,50,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  });
  const grass = canvasTexture(size, 14, (img, s, r) => {
    const n = fbm(s, 6, 5, 21);
    const m = fbm(s, 32, 2, 33);
    const d = img.data;
    for (let i = 0; i < s * s; i++) {
      const g = (r() - 0.5) * 26;
      const v = (n[i] - 0.5) * 50;
      const w = (m[i] - 0.5) * 20;
      d[i * 4] = 82 + v * 0.7 + g * 0.6 + w;
      d[i * 4 + 1] = 108 + v + g + w * 0.5;
      d[i * 4 + 2] = 54 + v * 0.4 + g * 0.4;
      d[i * 4 + 3] = 255;
    }
  });
  const paint = canvasTexture(512, 15, grainy([232, 232, 232], 30, 30, 0.0, 9));
  const macro = canvasTexture(512, 16, (img, s) => {
    const a = fbm(s, 4, 5, 41);
    const b = fbm(s, 9, 3, 57);
    const d = img.data;
    for (let i = 0; i < s * s; i++) {
      d[i * 4] = a[i] * 255;
      d[i * 4 + 1] = b[i] * 255;
      d[i * 4 + 2] = 128;
      d[i * 4 + 3] = 255;
    }
  });
  macro.colorSpace = THREE.NoColorSpace;
  return { asphalt, runway, concrete, grass, paint, macro };
}

/**
 * Adds world-space macro variation to a standard material so large tiled surfaces
 * don't show obvious repetition.
 */
export function addMacroVariation(mat: THREE.MeshStandardMaterial, macro: THREE.Texture, strength = 1): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.macroMap = { value: macro };
    shader.uniforms.macroStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMacroXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMacroXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D macroMap;\nuniform float macroStrength;\nvarying vec2 vMacroXZ;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float mA = texture2D(macroMap, vMacroXZ / 900.0).r;
        float mB = texture2D(macroMap, vMacroXZ / 137.0).g;
        diffuseColor.rgb *= mix(1.0, mix(0.78, 1.16, mA) * mix(0.9, 1.08, mB), macroStrength);`,
      );
  };
  mat.customProgramCacheKey = () => `macro-${strength}`;
}
