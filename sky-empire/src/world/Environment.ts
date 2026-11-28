import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import world from '@data/world.json';
import W from '@data/weather.json';
import type { GraphicsPreset } from '../core/settings';
import { sunDirection } from '../core/geo';
import type { Conditions } from './Weather';

const N = W.night;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Sky, sun (and moon), image-based lighting, fog, stars and rain.
 * M8: the sun follows the game clock and the weather; at night a dim moon light takes over and the
 * exposure opens up so artificial lights carry the scene.
 */
export class Environment {
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(world.sunColor, world.sunIntensity);
  readonly sunDir: THREE.Vector3;
  /** 1 = full day, 0 = night (sun well below the horizon) */
  daylight = 1;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private shadowDistance = 0;
  private texel = 1;
  private renderer: THREE.WebGLRenderer | null = null;
  private preset: GraphicsPreset | null = null;
  private envKey = '';
  private envAt = 0;
  private stars: THREE.Points;
  private rain: THREE.LineSegments;
  private rainOffsets: Float32Array;
  private rainAmount = 0;
  private cloud = 0.3;
  private realSun = new THREE.Vector3();

  constructor(private scene: THREE.Scene, sun: { azimuthDeg: number; elevationDeg: number }) {
    this.sunDir = new THREE.Vector3(...sunDirection(sun.azimuthDeg, sun.elevationDeg));
    this.realSun.copy(this.sunDir);
    this.sky.scale.setScalar(40000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    const u = this.sky.material.uniforms;
    u.turbidity.value = world.sky.turbidity;
    u.rayleigh.value = world.sky.rayleigh;
    u.mieCoefficient.value = world.sky.mieCoefficient;
    u.mieDirectionalG.value = world.sky.mieDirectionalG;
    u.cloudDensity.value = world.sky.cloudDensity;
    u.sunPosition.value.copy(this.sunDir);
    scene.add(this.sky);

    this.sun.position.copy(this.sunDir).multiplyScalar(400);
    scene.add(this.sun, this.sun.target);
    scene.fog = new THREE.FogExp2(world.fogColor, world.fogDensity);
    scene.environmentIntensity = world.environmentIntensity;

    // stars: a sphere of points that fades in at night
    const n = 2500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection();
      v.y = Math.abs(v.y) * 0.95 + 0.05;
      v.normalize().multiplyScalar(30000);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    scene.add(this.stars);

    // rain: streaks in a box that follows the camera
    const drops = W.rain.drops;
    const rp = new Float32Array(drops * 6);
    this.rainOffsets = new Float32Array(drops * 3);
    for (let i = 0; i < drops; i++) this.rainOffsets.set([Math.random(), Math.random(), Math.random()], i * 3);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab7c4, transparent: true, opacity: 0.35, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
  }

  /** Rebuilds the environment map and shadow settings for a graphics preset. */
  apply(renderer: THREE.WebGLRenderer, p: GraphicsPreset): void {
    this.renderer = renderer;
    this.preset = p;
    this.sky.material.uniforms.cloudCoverage.value = p.clouds ? this.cloud : 0;
    this.rebuildEnv();

    this.sun.castShadow = p.shadows;
    this.shadowDistance = p.shadowDistance;
    if (p.shadows) {
      const s = this.sun.shadow;
      s.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      s.map?.dispose();
      s.map = null as unknown as THREE.WebGLRenderTarget;
      const half = p.shadowDistance / 2;
      const cam = s.camera;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 1;
      cam.far = 900;
      cam.updateProjectionMatrix();
      s.bias = -0.0004;
      s.normalBias = 0.04;
      this.texel = p.shadowDistance / p.shadowMapSize;
    }
  }

  /** Image-based lighting from the current sky (no clouds), regenerated when the sun or cloud cover changes enough. */
  private rebuildEnv(): void {
    const renderer = this.renderer;
    const p = this.preset;
    if (!renderer || !p) return;
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    const eu = envSky.material.uniforms;
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'] as const) eu[k].value = this.sky.material.uniforms[k].value;
    // keep the IBL sun a little above the horizon: below it the sky model is black and everything goes flat
    const s = this.realSun.clone();
    s.y = Math.max(s.y, 0.05);
    eu.sunPosition.value.copy(s.normalize());
    eu.cloudCoverage.value = 0;
    eu.showSunDisc.value = 0;
    envScene.add(envSky);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a4030 }));
    ground.position.y = -5;
    envScene.add(ground);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT?.dispose();
    this.envRT = pmrem.fromScene(envScene, 0.02, 0.1, 2000, { size: p.envMapSize });
    pmrem.dispose();
    envSky.material.dispose();
    ground.geometry.dispose();
    this.scene.environment = this.envRT.texture;
  }

  /**
   * Time of day and weather. `sun` is the true sun position for the place and game time.
   * Returns the daylight factor (1 day … 0 night).
   */
  setConditions(sun: { azimuth: number; elevation: number }, c: Conditions): number {
    const el = sun.elevation;
    this.realSun.set(...sunDirection(sun.azimuth, el));
    const day = smooth(-6, 6, el); // civil twilight blend
    const high = smooth(0, 25, el);
    this.daylight = day;
    this.cloud = c.cloud;
    const overcast = 1 - c.cloud * 0.72 - (c.storm ? 0.15 : 0);
    // the directional light is the sun by day and a faint moon by night
    if (el > -2) {
      this.sunDir.copy(this.realSun);
      if (this.sunDir.y < 0.06) this.sunDir.setY(0.06).normalize();
      this.sun.intensity = world.sunIntensity * smooth(-2, 8, el) * overcast;
      this.sun.color.set(world.sunColor).lerp(new THREE.Color('#ff9a55'), 1 - high);
    } else {
      this.sunDir.set(-this.realSun.x, 0.7, -this.realSun.z).normalize();
      this.sun.intensity = N.moonIntensity * (1 - c.cloud * 0.8);
      this.sun.color.set(N.moonColor);
    }
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.realSun);
    u.turbidity.value = world.sky.turbidity + c.cloud * 6;
    u.cloudCoverage.value = this.preset?.clouds === false ? 0 : Math.min(1, 0.15 + c.cloud * 0.85);
    u.cloudDensity.value = world.sky.cloudDensity + c.cloud * 0.4;
    // fog from visibility (exp2: 2% contrast at the visibility distance), darker at night, greyer under cloud
    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = Math.max(world.fogDensity, 1.98 / Math.max(200, c.visibilityM));
    fog.color.set(world.fogColor).lerp(new THREE.Color('#8e959e'), c.cloud * 0.7).lerp(new THREE.Color(N.fogNight), 1 - day);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(N.environmentNight, N.environmentDay * (1 - c.cloud * 0.35), day);
    if (this.renderer) this.renderer.toneMappingExposure = THREE.MathUtils.lerp(N.exposureNight, N.exposureDay * (1 + c.cloud * 0.25), day);
    (this.stars.material as THREE.PointsMaterial).opacity = smooth(0, -8, el) * (1 - c.cloud);
    this.stars.visible = el < 0;
    this.rainAmount = c.precip;
    this.rain.visible = c.precip > 0.02;
    (this.rain.material as THREE.LineBasicMaterial).opacity = 0.15 + c.precip * 0.35;
    // refresh the image-based lighting when the light has changed noticeably (at most every 2 s)
    const key = `${Math.round(el / 2)}|${Math.round(sun.azimuth / 10)}|${Math.round(c.cloud * 5)}`;
    if (key !== this.envKey && performance.now() - this.envAt > 2000) {
      this.envKey = key;
      this.envAt = performance.now();
      this.rebuildEnv();
    }
    return day;
  }

  private tmp = new THREE.Vector3();

  /** Keeps the sky centred on the camera and the shadow box centred on the focus point. */
  update(camera: THREE.Camera, focus: THREE.Vector3, timeSec: number, dt = 0.016, wind?: THREE.Vector3): void {
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.sky.material.uniforms.time.value = timeSec;
    if (this.rain.visible) this.updateRain(camera.position, timeSec, dt, wind);
    if (this.shadowDistance > 0) {
      // Snap the shadow camera to texel-sized steps (in light space) to stop shimmering.
      const t = this.tmp.copy(focus);
      const lightRot = new THREE.Matrix4().lookAt(this.sunDir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
      const inv = lightRot.clone().invert();
      t.applyMatrix4(inv);
      t.x = Math.round(t.x / this.texel) * this.texel;
      t.y = Math.round(t.y / this.texel) * this.texel;
      t.applyMatrix4(lightRot);
      this.sun.target.position.copy(t);
      this.sun.position.copy(t).addScaledVector(this.sunDir, 400);
      this.sun.target.updateMatrixWorld();
    }
  }

  private updateRain(cam: THREE.Vector3, t: number, _dt: number, wind?: THREE.Vector3): void {
    const B = W.rain.boxM;
    const pos = (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const fall = W.rain.speed * (0.8 + this.rainAmount * 0.5);
    const wx = (wind?.x ?? 0) * 0.035;
    const wz = (wind?.z ?? 0) * 0.035;
    const n = Math.floor((pos.length / 6) * Math.min(1, 0.2 + this.rainAmount));
    const len = 0.5 + this.rainAmount * 0.6;
    for (let i = 0; i < pos.length / 6; i++) {
      const o = i * 3;
      if (i >= n) {
        pos.fill(0, i * 6, i * 6 + 6);
        continue;
      }
      const y = (((this.rainOffsets[o + 1] * B - t * fall) % B) + B) % B;
      const x = cam.x + (this.rainOffsets[o] - 0.5) * B + wx * y;
      const z = cam.z + (this.rainOffsets[o + 2] - 0.5) * B + wz * y;
      const yy = cam.y - B / 2 + y;
      pos[i * 6] = x;
      pos[i * 6 + 1] = yy;
      pos[i * 6 + 2] = z;
      pos[i * 6 + 3] = x - wx * len;
      pos[i * 6 + 4] = yy + len;
      pos[i * 6 + 5] = z - wz * len;
    }
    this.rain.geometry.getAttribute('position').needsUpdate = true;
  }
}
