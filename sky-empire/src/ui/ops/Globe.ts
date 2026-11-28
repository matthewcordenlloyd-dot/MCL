import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AIRPORTS } from '../../economy/Sim';
import type { Snapshot } from '../../economy/types';

const DEG = Math.PI / 180;

/** Unit-sphere position for a lat/lon (y up, lon 0 facing +z). */
export function latLonToVec(lat: number, lon: number, r = 1): THREE.Vector3 {
  const phi = lat * DEG;
  const lam = lon * DEG;
  return new THREE.Vector3(Math.cos(phi) * Math.sin(lam), Math.sin(phi), Math.cos(phi) * Math.cos(lam)).multiplyScalar(r);
}

function vecToLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  const n = v.clone().normalize();
  return { lat: Math.asin(n.y) / DEG, lon: Math.atan2(n.x, n.z) / DEG };
}

/**
 * The route-map globe: satellite Earth (EOX Sentinel-2 cloudless tiles), every
 * airline-capable airport, your routes as great-circle arcs and your flights live.
 * Uses its own small WebGL renderer while the ops centre is open.
 */
export class Globe {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private controls: OrbitControls;
  private routesGroup = new THREE.Group();
  private flights: THREE.Points;
  private airportPts: THREE.Points;
  private airportList = Object.values(AIRPORTS);
  private highlight: THREE.Mesh;
  private raf = 0;
  private lastRoutesKey = '';
  onAirportClick: ((icao: string) => void) | null = null;
  onHover: ((text: string) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    host.appendChild(this.renderer.domElement);
    this.camera.position.set(0.6, 1.7, 2.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.minDistance = 1.15;
    this.controls.maxDistance = 6;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.enableDamping = true;

    // earth: a mercator atlas from 16 zoom-2 tiles, re-projected on the sphere in the shader
    const atlas = document.createElement('canvas');
    atlas.width = atlas.height = 1024;
    const g = atlas.getContext('2d')!;
    g.fillStyle = '#0d2236';
    g.fillRect(0, 0, 1024, 1024);
    const tex = new THREE.CanvasTexture(atlas);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          g.drawImage(img, x * 256, y * 256);
          tex.needsUpdate = true;
        };
        img.src = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/2/${y}/${x}.jpg`;
      }
    }
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { atlas: { value: tex }, sunDir: { value: new THREE.Vector3(0.5, 0.4, 1).normalize() } },
        vertexShader: `varying vec3 vN; varying vec3 vW;
          void main(){ vN = normalize(position); vW = normalize((modelMatrix*vec4(position,1.)).xyz); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
        fragmentShader: `uniform sampler2D atlas; uniform vec3 sunDir; varying vec3 vN; varying vec3 vW;
          void main(){
            float lat = asin(clamp(vN.y,-1.,1.)); float lon = atan(vN.x, vN.z);
            float u = lon / 6.2831853 + 0.5;
            float latc = clamp(lat, -1.4844, 1.4844);
            float v = (1.0 - log(tan(0.7853982 + latc*0.5)) / 3.1415927) * 0.5;
            vec3 c = texture2D(atlas, vec2(u, v)).rgb;
            if (abs(lat) > 1.4844) c = vec3(0.86,0.9,0.95);
            float l = 0.55 + 0.6*max(dot(vW, sunDir), 0.0);
            vec3 col = c * l * 1.1; // the atlas is sRGB-decoded by the sampler already
            float rim = pow(1.0 - abs(dot(vW, normalize(cameraPosition - vW))), 3.0);
            col += vec3(0.25,0.45,0.9) * rim * 0.35;
            gl_FragColor = vec4(pow(col, vec3(1.0/2.2)), 1.0);
          }`,
      }),
    );
    this.scene.add(earth);
    // atmosphere glow
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1.06, 64, 48),
      new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, depthWrite: false,
        vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
        fragmentShader: 'varying vec3 vN; void main(){ float i = pow(0.65 - dot(vN, vec3(0,0,1.)), 3.0); gl_FragColor = vec4(0.35,0.6,1.0,1.0)*i; }',
      }),
    );
    this.scene.add(atmo);

    // airports: one point cloud
    const pos = new Float32Array(this.airportList.length * 3);
    const col = new Float32Array(this.airportList.length * 3);
    this.airportList.forEach((a, i) => {
      latLonToVec(a.lat, a.lon, 1.002).toArray(pos, i * 3);
      const c = a.type === 0 ? [1, 0.82, 0.45] : [0.55, 0.7, 0.9];
      col.set(c, i * 3);
    });
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ag.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.airportPts = new THREE.Points(ag, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
    this.scene.add(this.airportPts);
    this.scene.add(this.routesGroup);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 512), 3));
    fg.setDrawRange(0, 0);
    this.flights = new THREE.Points(fg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, color: 0xffffff, depthWrite: false }));
    this.scene.add(this.flights);
    this.highlight = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.018, 24), new THREE.MeshBasicMaterial({ color: 0xe0a526, side: THREE.DoubleSide, depthWrite: false }));
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    // picking
    const ray = new THREE.Raycaster();
    const pick = (e: PointerEvent) => {
      const r = this.renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObject(earth)[0];
      if (!hit) return null;
      const { lat, lon } = vecToLatLon(hit.point);
      let best: (typeof this.airportList)[number] | null = null;
      let bd = Infinity;
      const tol = 0.9 * this.camera.position.length();
      for (const a of this.airportList) {
        const d = Math.hypot(a.lat - lat, (a.lon - lon) * Math.cos(lat * DEG)) - (a.type === 0 ? 0.3 : 0);
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
      return best && bd < tol ? best : null;
    };
    let downAt = 0;
    this.renderer.domElement.addEventListener('pointerdown', () => (downAt = performance.now()));
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (performance.now() - downAt > 250) return; // it was a drag
      const a = pick(e);
      if (a) {
        this.focusAirport(a.icao);
        this.onAirportClick?.(a.icao);
      }
    });
    this.renderer.domElement.addEventListener('pointermove', (e) => {
      const a = pick(e);
      this.onHover?.(a ? `${a.iata || a.icao} · ${a.name}${a.city ? `, ${a.city}` : ''}` : '');
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  focusAirport(icao: string, fly = false): void {
    const a = AIRPORTS[icao];
    if (!a) return;
    const p = latLonToVec(a.lat, a.lon, 1.003);
    this.highlight.position.copy(p);
    this.highlight.lookAt(p.clone().multiplyScalar(2));
    this.highlight.visible = true;
    if (fly) this.camera.position.copy(latLonToVec(a.lat, a.lon, this.camera.position.length()));
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(snap: Snapshot, routeColor: string): void {
    // route arcs (rebuilt only when the route list changes)
    const key = snap.routes.map((r) => r.id).join(',');
    if (key !== this.lastRoutesKey) {
      this.lastRoutesKey = key;
      this.routesGroup.clear();
      const mat = new THREE.LineBasicMaterial({ color: routeColor, transparent: true, opacity: 0.9 });
      for (const r of snap.routes) {
        const pts = arc(r.a, r.b);
        if (pts.length) this.routesGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
      }
    }
    // flights in the air
    const attr = this.flights.geometry.getAttribute('position') as THREE.BufferAttribute;
    let n = 0;
    for (const ac of snap.fleet) {
      if ((ac.status !== 'flying' && ac.status !== 'ferry') || n >= 512) continue;
      const t = Math.min(1, Math.max(0, (snap.time - ac.flightDep) / Math.max(1, ac.flightArr - ac.flightDep)));
      const p = arcPoint(ac.flightFrom, ac.flightTo, t);
      if (p) attr.setXYZ(n++, p.x, p.y, p.z);
    }
    attr.needsUpdate = true;
    this.flights.geometry.setDrawRange(0, n);
  }

  start(): void {
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}

function arcPoint(a: string, b: string, t: number): THREE.Vector3 | null {
  const A = AIRPORTS[a];
  const B = AIRPORTS[b];
  if (!A || !B) return null;
  const va = latLonToVec(A.lat, A.lon);
  const vb = latLonToVec(B.lat, B.lon);
  const ang = va.angleTo(vb);
  const q = new THREE.Quaternion().setFromUnitVectors(va, vb);
  const p = va.clone().applyQuaternion(new THREE.Quaternion().slerp(q, t));
  return p.multiplyScalar(1.004 + Math.sin(Math.PI * t) * ang * 0.08);
}

function arc(a: string, b: string): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= 48; i++) {
    const p = arcPoint(a, b, i / 48);
    if (p) out.push(p);
  }
  return out;
}
