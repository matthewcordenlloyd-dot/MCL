import * as THREE from 'three';
import cfg from '@data/terrain.json';
import { geoToLocal, localToGeo, type GeoOrigin } from '../core/geo';
import { ancestor, children, fillUrl, keyOf, latToTileY, lonToTileX, tileBounds, tileYToLat, tileXToLon, type TileKey } from './mercator';

const R_EARTH = 6371000;

interface ElevTile {
  data: Float32Array; // 256 x 256 metres
}

interface Tile {
  key: TileKey;
  id: string;
  state: 'loading' | 'ready' | 'error';
  mesh?: THREE.Mesh;
  lastUsed: number;
  width: number; // metres
  center: THREE.Vector3;
}

export interface Mask {
  min: number[];
  max: number[];
  blendM: number;
  /** ground height of the airport inside the mask (local y) */
  y: number;
}

/**
 * Streams real-world terrain around the camera as a quadtree of Web Mercator tiles.
 * Elevation comes from AWS Terrarium tiles, imagery from EOX Sentinel-2 cloudless
 * (or MapTiler when a key is configured). Airport footprints are flattened to y = 0
 * and blended into the airport's own grass so detailed airports sit cleanly on the map.
 */
export class Terrain {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Tile>();
  private elev = new Map<string, Promise<ElevTile | null>>();
  private elevReady = new Map<string, ElevTile>();
  private queue: { prio: number; run: () => Promise<void> }[] = [];
  private active = 0;
  private lastSelect = -1;
  private frame = 0;
  private maxZoom: number;
  private radius: number;
  private imagery: { url: string; maxZoom: number; attribution: string; key: string };
  private masks: Mask[];
  private material: (map: THREE.Texture) => THREE.MeshLambertMaterial;
  private anisotropy = 4;
  private uniforms!: { maskRects: { value: THREE.Vector4[] }; maskBlends: { value: number[] } };
  enabled = true;

  get originGeo(): GeoOrigin & { elevation: number } {
    return this.origin;
  }

  /**
   * Re-centre the world on a new origin (floating origin): every tile is rebuilt in the new
   * local frame. Elevation data and the browser's image cache are reused, so this is quick.
   */
  setOrigin(origin: GeoOrigin & { elevation: number }, masks: Mask[]): void {
    this.origin = origin;
    this.masks = masks.slice(0, 4);
    this.uniforms.maskRects.value.forEach((v, i) => {
      const m = this.masks[i];
      if (m) v.set(m.min[0], m.min[1], m.max[0], m.max[1]);
      else v.set(0, 0, -1, -1);
    });
    this.uniforms.maskBlends.value = [0, 1, 2, 3].map((i) => this.masks[i]?.blendM ?? 1);
    for (const t of this.tiles.values()) {
      if (t.mesh) {
        t.mesh.geometry.dispose();
        const m = t.mesh.material as THREE.MeshLambertMaterial;
        m.map?.dispose();
        m.dispose();
      }
    }
    this.tiles.clear();
    this.queue = [];
    this.group.clear();
    this.lastSelect = -1;
  }

  constructor(private origin: GeoOrigin & { elevation: number }, grass: THREE.Texture, macro: THREE.Texture, masks: Mask[]) {
    this.masks = masks.slice(0, 4);
    this.group.name = 'terrain';
    const key = (import.meta.env.VITE_MAPTILER_KEY as string | undefined) ?? '';
    this.imagery = key ? { ...cfg.imagery.maptiler, key } : { ...cfg.imagery.eox, key: '' };
    this.maxZoom = cfg.maxZoom;
    this.radius = cfg.radiusKm * 1000;
    // up to 4 airport masks: (minX, minZ, maxX, maxZ) + blend distance
    const rects = [0, 1, 2, 3].map((i) => {
      const m = this.masks[i];
      return m ? new THREE.Vector4(m.min[0], m.min[1], m.max[0], m.max[1]) : new THREE.Vector4(0, 0, -1, -1);
    });
    const blends = [0, 1, 2, 3].map((i) => this.masks[i]?.blendM ?? 1);
    const uniforms = {
      grassMap: { value: grass },
      macroMap: { value: macro },
      maskRects: { value: rects },
      maskBlends: { value: blends },
    };
    this.uniforms = uniforms;
    this.material = (map) => {
      const mat = new THREE.MeshLambertMaterial({ map });
      mat.onBeforeCompile = (s) => {
        Object.assign(s.uniforms, uniforms);
        s.vertexShader = s.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vTerrXZ;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', `#include <common>
            uniform sampler2D grassMap; uniform sampler2D macroMap;
            uniform vec4 maskRects[4]; uniform float maskBlends[4];
            varying vec2 vTerrXZ;`)
          .replace('#include <map_fragment>', `#include <map_fragment>
            float inside = 0.0;
            for (int i = 0; i < 4; i++) {
              vec2 dIn = min(vTerrXZ - maskRects[i].xy, maskRects[i].zw - vTerrXZ);
              inside = max(inside, smoothstep(0.0, maskBlends[i], min(dIn.x, dIn.y)));
            }
            // satellite water is near-black: tint it toward a natural sea blue
            float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            float water = (1.0 - smoothstep(0.012, 0.05, lum)) * step(diffuseColor.r, diffuseColor.b + 0.01);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.085, 0.13), water * 0.75);
            if (inside > 0.0) {
              vec3 g = texture2D(grassMap, vTerrXZ / 24.0).rgb;
              float mA = texture2D(macroMap, vTerrXZ / 900.0).r;
              g *= mix(0.78, 1.16, mA);
              diffuseColor.rgb = mix(diffuseColor.rgb, g, inside);
            }`);
      };
      mat.customProgramCacheKey = () => 'terrain';
      return mat;
    };
    this.ensureAttribution();
  }

  setQuality(maxZoom: number, radiusM: number, anisotropy: number): void {
    this.maxZoom = Math.min(maxZoom, this.imagery.maxZoom, cfg.maxZoom);
    this.radius = radiusM;
    this.anisotropy = anisotropy;
    this.lastSelect = -1;
  }

  // ------------------------------------------------------------------ geometry helpers
  private curvature(x: number, z: number): number {
    return (x * x + z * z) / (2 * R_EARTH);
  }

  /** Blend weight toward an airport (0..1) and that airport's ground height. */
  private maskAt(x: number, z: number): { w: number; y: number } {
    let best = 0;
    let y = 0;
    for (const m of this.masks) {
      const d = Math.min(x - m.min[0], m.max[0] - x, z - m.min[1], m.max[1] - z);
      if (d <= 0) continue;
      const t = Math.min(1, d / m.blendM);
      const w = t * t * (3 - 2 * t);
      if (w > best) {
        best = w;
        y = m.y;
      }
    }
    return { w: best, y: y - 0.08 };
  }

  /** Terrain height (local y) at a local position, from the best loaded elevation data. */
  heightAt(x: number, z: number): number {
    const mask = this.maskAt(x, z);
    if (mask.w >= 1) return mask.y;
    const { lat, lon } = localToGeo(this.origin, x, z);
    let h = 0;
    for (let zz = cfg.elevation.maxZoom; zz >= cfg.minZoom; zz--) {
      const tx = lonToTileX(lon, zz);
      const ty = latToTileY(lat, zz);
      const e = this.elevReady.get(`${zz}/${Math.floor(tx)}/${Math.floor(ty)}`);
      if (e) {
        h = sample(e.data, tx - Math.floor(tx), ty - Math.floor(ty)) - this.origin.elevation;
        break;
      }
    }
    h -= this.curvature(x, z);
    return h * (1 - mask.w) + mask.y * mask.w;
  }

  // ------------------------------------------------------------------ loading
  private schedule(prio: number, run: () => Promise<void>): void {
    this.queue.push({ prio, run });
  }

  private pump(): void {
    this.queue.sort((a, b) => a.prio - b.prio);
    while (this.active < cfg.maxConcurrentRequests && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      job.run().finally(() => {
        this.active--;
      });
    }
  }

  private loadElevation(t: TileKey): Promise<ElevTile | null> {
    const id = keyOf(t);
    let p = this.elev.get(id);
    if (!p) {
      p = loadImage(fillUrl(cfg.elevation.url, t))
        .then((img) => {
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const g = c.getContext('2d', { willReadFrequently: true })!;
          g.drawImage(img, 0, 0);
          const px = g.getImageData(0, 0, 256, 256).data;
          const data = new Float32Array(256 * 256);
          for (let i = 0; i < data.length; i++) data[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
          const e = { data };
          this.elevReady.set(id, e);
          return e;
        })
        .catch(() => null);
      this.elev.set(id, p);
    }
    return p;
  }

  private requestTile(t: TileKey, prio: number): Tile {
    const id = keyOf(t);
    let tile = this.tiles.get(id);
    if (tile) return tile;
    const b = tileBounds(t);
    const c = geoToLocal(this.origin, (b.n + b.s) / 2, (b.w + b.e) / 2);
    const width = Math.abs(geoToLocal(this.origin, b.n, b.e).x - geoToLocal(this.origin, b.n, b.w).x);
    tile = { key: t, id, state: 'loading', lastUsed: this.frame, width, center: new THREE.Vector3(c.x, 0, c.z) };
    this.tiles.set(id, tile);
    const tt = tile;
    this.schedule(prio, async () => {
      const ez = Math.min(t.z, cfg.elevation.maxZoom);
      const anc = ancestor(t, ez);
      const [img, elev] = await Promise.all([
        loadImage(fillUrl(this.imagery.url, t, this.imagery.key)).catch(() => null),
        this.loadElevation(anc.key),
      ]);
      if (!this.tiles.has(id)) return; // evicted meanwhile
      if (!img) {
        tt.state = 'error';
        return;
      }
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      tt.mesh = this.buildMesh(t, elev, anc, tex);
      tt.state = 'ready';
    });
    return tile;
  }

  private buildMesh(t: TileKey, elev: ElevTile | null, anc: { u0: number; v0: number; size: number }, tex: THREE.Texture): THREE.Mesh {
    const n = cfg.segments;
    const b = tileBounds(t);
    const verts = (n + 1) * (n + 1);
    const ring = 4 * n;
    const pos = new Float32Array((verts + ring) * 3);
    const uv = new Float32Array((verts + ring) * 2);
    const center = this.tiles.get(keyOf(t))!.center;
    let k = 0;
    for (let j = 0; j <= n; j++) {
      const v = j / n;
      const lat = tileYToLat(t.y + v, t.z);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const lon = b.w + (b.e - b.w) * u;
        const p = geoToLocal(this.origin, lat, lon);
        let h = elev ? sample(elev.data, anc.u0 + u * anc.size, anc.v0 + v * anc.size) - this.origin.elevation : 0;
        h -= this.curvature(p.x, p.z);
        const m = this.maskAt(p.x, p.z);
        h = h * (1 - m.w) + m.y * m.w;
        pos[k * 3] = p.x - center.x;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = p.z - center.z;
        uv[k * 2] = u;
        uv[k * 2 + 1] = 1 - v;
        k++;
      }
    }
    // skirt: duplicate the border ring, pushed down, to hide cracks between LOD levels
    const skirt = Math.max(4, this.tiles.get(keyOf(t))!.width / n * 0.6);
    const border: number[] = [];
    for (let i = 0; i < n; i++) border.push(i);
    for (let j = 0; j < n; j++) border.push(j * (n + 1) + n);
    for (let i = n; i > 0; i--) border.push(n * (n + 1) + i);
    for (let j = n; j > 0; j--) border.push(j * (n + 1));
    border.forEach((src, r) => {
      const d = verts + r;
      pos[d * 3] = pos[src * 3];
      pos[d * 3 + 1] = pos[src * 3 + 1] - skirt;
      pos[d * 3 + 2] = pos[src * 3 + 2];
      uv[d * 2] = uv[src * 2];
      uv[d * 2 + 1] = uv[src * 2 + 1];
    });
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b2 = a + 1;
        const c = a + n + 1;
        const d = c + 1;
        idx.push(a, c, b2, b2, c, d);
      }
    }
    for (let r = 0; r < ring; r++) {
      const a = border[r];
      const b2 = border[(r + 1) % ring];
      const sa = verts + r;
      const sb = verts + ((r + 1) % ring);
      idx.push(a, b2, sa, b2, sb, sa);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material(tex));
    mesh.position.copy(center);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.name = `terrain ${keyOf(t)}`;
    return mesh;
  }

  // ------------------------------------------------------------------ selection
  private shouldSplit(t: TileKey, cam: THREE.Vector3): boolean {
    if (t.z >= this.maxZoom) return false;
    const b = tileBounds(t);
    const nw = geoToLocal(this.origin, b.n, b.w);
    const se = geoToLocal(this.origin, b.s, b.e);
    const dx = Math.max(nw.x - cam.x, 0, cam.x - se.x);
    const dz = Math.max(nw.z - cam.z, 0, cam.z - se.z);
    const dist = Math.hypot(dx, dz, Math.max(0, cam.y));
    return dist < (se.x - nw.x) * cfg.lodFactor;
  }

  update(cam: THREE.Vector3, timeSec: number): void {
    this.frame++;
    if (!this.enabled) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    if (timeSec - this.lastSelect < 0.25 && this.lastSelect >= 0) {
      this.pump();
      return;
    }
    this.lastSelect = timeSec;
    const { lat, lon } = localToGeo(this.origin, cam.x, cam.z);
    const z0 = cfg.minZoom;
    const span = this.radius / (40075000 * Math.cos((lat * Math.PI) / 180) / 2 ** z0);
    const cx = lonToTileX(lon, z0);
    const cy = latToTileY(lat, z0);
    // Progressive refinement: a tile is replaced by its four children only once all four
    // are loaded, so there are never holes or overlaps and detail sharpens level by level.
    const render: Tile[] = [];
    const visit = (t: TileKey) => {
      const tile = this.requestTile(t, this.tileCenterDistance(t, cam));
      tile.lastUsed = this.frame;
      if (tile.state !== 'ready') return;
      if (this.shouldSplit(t, cam)) {
        const kids = children(t).map((k) => {
          const kt = this.requestTile(k, this.tileCenterDistance(k, cam));
          kt.lastUsed = this.frame;
          return kt;
        });
        if (kids.every((k) => k.state === 'ready')) {
          kids.forEach((k) => visit(k.key));
          return;
        }
      }
      render.push(tile);
    };
    for (let x = Math.floor(cx - span); x <= Math.floor(cx + span); x++) {
      for (let y = Math.floor(cy - span); y <= Math.floor(cy + span); y++) visit({ z: z0, x, y });
    }
    this.group.clear();
    for (const t of render) if (t.mesh) this.group.add(t.mesh);
    this.evict();
    this.pump();
  }

  private tileCenterDistance(t: TileKey, cam: THREE.Vector3): number {
    const b = tileBounds(t);
    const c = geoToLocal(this.origin, (b.n + b.s) / 2, (b.w + b.e) / 2);
    return Math.hypot(c.x - cam.x, c.z - cam.z) / (t.z + 1);
  }

  private evict(): void {
    if (this.tiles.size <= cfg.cacheTiles) return;
    const old = [...this.tiles.values()].filter((t) => t.lastUsed < this.frame).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, this.tiles.size - cfg.cacheTiles)) {
      if (t.mesh) {
        t.mesh.geometry.dispose();
        const m = t.mesh.material as THREE.MeshLambertMaterial;
        m.map?.dispose();
        m.dispose();
      }
      this.tiles.delete(t.id);
    }
  }

  get stats(): { tiles: number; visible: number; pending: number } {
    return { tiles: this.tiles.size, visible: this.group.children.length, pending: this.queue.length + this.active };
  }

  private ensureAttribution(): void {
    if (document.getElementById('attribution')) return;
    const el = document.createElement('div');
    el.id = 'attribution';
    el.textContent = `${this.imagery.attribution} · ${cfg.elevation.attribution}`;
    document.body.appendChild(el);
  }

  /** Tile size helper for debugging */
  static tileWidthAt(lat: number, z: number): number {
    return (40075000 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  }

  static boundsDeg(t: TileKey) {
    return { ...tileBounds(t), lonW: tileXToLon(t.x, t.z) };
  }
}

function sample(data: Float32Array, u: number, v: number): number {
  const x = Math.min(Math.max(u * 255, 0), 255);
  const y = Math.min(Math.max(v * 255, 0), 255);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, 255);
  const y1 = Math.min(y0 + 1, 255);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * 256 + x0] * (1 - fx) + data[y0 * 256 + x1] * fx;
  const b = data[y1 * 256 + x0] * (1 - fx) + data[y1 * 256 + x1] * fx;
  return a * (1 - fy) + b * fy;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile failed: ${url}`));
    img.src = url;
  });
}
