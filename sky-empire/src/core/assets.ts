import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

/** Shared loaders. Draco decoder is copied to /public/draco by scripts/copy-draco.mjs. */
export class Assets {
  readonly manager = new THREE.LoadingManager();
  private gltf: GLTFLoader;
  private tex: THREE.TextureLoader;
  private cache = new Map<string, Promise<GLTF>>();

  constructor(onProgress?: (loaded: number, total: number, url: string) => void) {
    if (onProgress) this.manager.onProgress = (url, loaded, total) => onProgress(loaded, total, url);
    const draco = new DRACOLoader(this.manager);
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    this.gltf = new GLTFLoader(this.manager);
    this.gltf.setDRACOLoader(draco);
    this.tex = new THREE.TextureLoader(this.manager);
  }

  url(rel: string): string {
    return `${import.meta.env.BASE_URL}${rel}`;
  }

  loadGLTF(rel: string): Promise<GLTF> {
    let p = this.cache.get(rel);
    if (!p) {
      p = this.gltf.loadAsync(this.url(rel));
      this.cache.set(rel, p);
    }
    return p;
  }

  async loadTexture(rel: string, srgb = true): Promise<THREE.Texture> {
    const t = await this.tex.loadAsync(this.url(rel));
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
}
