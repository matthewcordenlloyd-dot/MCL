import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import egkk from '@data/airports/egkk.json';
import egll from '@data/airports/egll.json';
import world from '@data/world.json';
import a320 from '@data/aircraft/a320neo.json';
import defaultBrand from '@data/brand_default.json';
import terrainCfg from '@data/terrain.json';
import { Assets } from './assets';
import { PRESETS, PRESET_IDS, loadSettings, saveSettings, urlPreset, type PresetId, type Settings } from './settings';
import { Environment } from '../world/Environment';
import { Airport, type AirportData } from '../world/Airport';
import { Physics } from '../world/Physics';
import { JetBridge } from '../world/JetBridge';
import { makeGroundTextures } from '../world/textures';
import { Terrain } from '../terrain/Terrain';
import { Input } from '../player/Input';
import { Player } from '../player/Player';
import { PlayerAircraft } from '../flight/PlayerAircraft';
import { FlightControls } from '../flight/FlightControls';
import { FlightCamera } from '../flight/FlightCamera';
import { Hud } from '../ui/Hud';
import { FlightHud } from '../ui/FlightHud';
import { EconomyClient } from '../economy/EconomyClient';
import { loadRates, money, toCurrency } from '../economy/currency';
import { exportJson, saveGame } from '../economy/saves';
import type { GameState, NewGameParams } from '../economy/types';
import { OpsCenter, fmtDate, toast } from '../ui/ops/OpsCenter';
import { MainMenu } from '../ui/ops/MainMenu';
import type { Brand } from '../customiser/liveryPainter';
import { runBenchmark } from './Benchmark';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ProceduralAirport } from '../world/ProceduralAirport';
import type { GroundTextures } from '../world/textures';
import type { InstrumentExtras } from '../flight/Instruments';
import { AIRPORTS, TYPES, distanceKm, registerCustomTypes } from '../economy/Sim';
import { LiveryEditor } from '../customiser/LiveryEditor';
import { CabinEditor } from '../customiser/CabinEditor';
import { AircraftDesigner } from '../customiser/AircraftDesigner';
import { CharacterCreator } from '../customiser/CharacterCreator';
import { EmpireWorld } from '../world/EmpireWorld';
import { Car, type CarStyle } from '../vehicles/Car';
import empireData from '@data/economy/empire.json';
import gl7tData from '@data/aircraft/gl7t.json';
import type { AircraftSpec } from '../flight/PlayerAircraft';
import { defaultLivery } from '../customiser/liveryPainter';
import W from '@data/weather.json';
import { Weather, solarPosition } from '../world/Weather';
import { DamageMonitor, type Incident } from '../flight/Damage';
import { Traffic } from '../world/Traffic';
import { AircraftModel, type AircraftData } from '../flight/AircraftModel';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { People } from '../world/People';
import { AudioSystem } from '../audio/AudioSystem';
import { ilsFor, runwayEnds, type RunwayDef } from '../flight/Approach';
import { Atc } from '../flight/Atc';
import { ApproachAids } from '../world/ApproachAids';
import { geoToLocal } from './geo';

const R_EARTH = 6371000;
const DEG = Math.PI / 180;
const AUTOSAVE_MS = 5 * 60_000;

const CONTROL_LABELS: Record<string, string> = {
  ctl_gear: 'Landing gear lever', ctl_flaps: 'Flap lever', ctl_speedbrake: 'Speed brake lever', ctl_park: 'Parking brake',
  ctl_thrust_L: 'Thrust lever 1', ctl_thrust_R: 'Thrust lever 2', ctl_ap1: 'AP1', ctl_athr: 'A/THR',
  ctl_spd: 'Speed knob', ctl_hdg: 'Heading knob', ctl_alt: 'Altitude knob', ctl_vs: 'Vertical speed knob',
};

/**
 * Owns the renderer, scene, main loop, graphics presets, the walk/fly modes and the
 * business layer. The economy simulation runs in a Web Worker and keeps ticking while
 * the player walks or flies; the main thread only renders and sends commands.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  settings: Settings;
  mode: 'walk' | 'fly' | 'drive' = 'walk';
  private empireWorld: EmpireWorld | null = null;
  private car: Car | null = null;
  private carSig = '';
  private camYaw = 0;
  readonly weather = new Weather();
  private damage = new DamageMonitor();
  private wxAt = 0;
  private daylight = 1;
  private landingLight: THREE.SpotLight | null = null;
  private gust = new THREE.Vector3();
  private crashTimer = 0;
  private traffic: Traffic | null = null;
  private people: People | null = null;
  readonly audio = new AudioSystem();
  private awayParked: AircraftModel[] = [];
  private homeAids: ApproachAids | null = null;
  private awayAids: ApproachAids | null = null;
  private atc: Atc | null = null;
  private atcAirborne = false;
  private dynScale = 1;
  private frameLog: number[] = [];
  private lastFrameAt = performance.now();
  private resAt = 0;
  private exteriorGltf: GLTF | null = null;
  private composer: EffectComposer | null = null;
  private env: Environment;
  private assets: Assets;
  private physics!: Physics;
  base!: Airport;
  other!: Airport;
  private player!: Player;
  terrain!: Terrain;
  aircraft!: PlayerAircraft;
  /** your airline's A320neo (gate, routes) and your own business jet (M10) */
  private airliner!: PlayerAircraft;
  private jet: PlayerAircraft | null = null;
  private jetLoading = false;
  private bridge!: JetBridge;
  private input: Input;
  private hud: Hud;
  private flightHud = new FlightHud();
  private flightControls = new FlightControls();
  private flightCam = new FlightCamera();
  private raycaster = new THREE.Raycaster();
  private timer = new THREE.Timer();
  private elapsed = 0;
  private paused = true;
  private physicsMs = 0;
  private cpuMs = 0;
  readonly eco = new EconomyClient();
  private ops: OpsCenter;
  private menu: MainMenu;
  private topbar: HTMLElement;
  private lastSpeedSent = -1;
  private lastAutosave = performance.now();
  private inGame = false;
  private editorOpen = false;
  private brandSig = '';
  private readonly origin = { lat: egkk.arp.lat, lon: egkk.arp.lon, elevation: egkk.arp.elevationM };
  /** Current world origin: the home base normally, a destination airport while away. */
  private originCur = { ...this.origin };
  private away: ProceduralAirport | null = null;
  private awayColliders: RAPIER.Collider[] = [];
  private groundTex!: GroundTextures;
  private homeRunways: InstrumentExtras['runways'] = [];
  /** A flight you are flying yourself for the airline. */
  private session: { from: string; to: string; phase: 'gate' | 'airborne' | 'landed'; fpm: number; airborneAt: number; personal?: string } | null = null;
  /** When set (benchmark), the loop skips player control and uses this camera pose. */
  cameraOverride: ((t: number) => void) | null = null;
  onFrame: ((dt: number) => void) | null = null;

  constructor(private container: HTMLElement) {
    this.settings = loadSettings();
    const forced = urlPreset();
    if (forced) this.settings.preset = forced;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, reversedDepthBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = world.toneMapping === 'AGX' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = world.exposure;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;

    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 20000);
    this.env = new Environment(this.scene, egkk.bakeSun);
    this.input = new Input(this.renderer.domElement);
    this.hud = new Hud(this.settings, {
      onPreset: (p) => this.setPreset(p),
      onSettings: (s) => this.updateSettings(s),
      onTeleport: (id) => this.teleport(id),
      onFlightStart: (id) => this.flightStart(id),
      onResume: () => this.input.requestLock(),
    }, this.spawnLabels(), {
      seat: "Captain's seat · Gatwick stand 103",
      lineup: 'Lined up · Gatwick runway 08R',
      final: 'Final approach · Gatwick 26L (8 km)',
    });
    this.hud.attachInput(this.input);
    this.assets = new Assets((loaded, total, url) => this.hud.progress(0.15 + 0.8 * (loaded / Math.max(total, 1)), `Loading ${url.split('/').pop()}`));

    // business layer
    this.ops = new OpsCenter(this.eco, {
      onSpeed: (v) => this.ops.setSpeed(v),
      onSave: (slot) => this.save(slot),
      onLoadMenu: () => {
        this.closeOps();
        this.menu.open().then(() => this.menu.loadList());
      },
      onExport: async () => exportJson(await this.eco.getState()),
      onClose: () => this.closeOps(),
      onFly: (from, to) => this.flyRoute(from, to),
      onCustomise: (kind, arg) => this.openCustomiser(kind, arg),
      onVisit: (place) => {
        this.closeOps();
        this.teleport(place);
      },
      onTravel: (icao, id) => this.travel(icao, id),
      onFlyJet: (icao, id) => this.flyJet(icao, id),
      onDrive: () => {
        this.closeOps();
        this.driveNow();
      },
    });
    this.menu = new MainMenu({ onNew: (p) => this.newGame(p), onLoad: (s) => this.loadGame(s) });
    this.topbar = document.createElement('div');
    this.topbar.id = 'topbar';
    this.topbar.className = 'glass';
    this.topbar.innerHTML = `<span class="air"><i class="dot"></i><span id="tbName"></span></span><span class="date" id="tbDate"></span>
      <span class="speeds" id="tbSpeeds">${this.ops.speedBar()}</span><span class="forced" id="tbForced"></span><span class="cash" id="tbCash"></span>
      <button class="btn sm opsbtn" id="tbOps">Ops centre <kbd>Tab</kbd></button>`;
    document.body.appendChild(this.topbar);
    this.topbar.querySelector('#tbSpeeds')!.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).dataset.speed;
      if (v !== undefined) this.ops.setSpeed(+v);
    });
    this.topbar.querySelector('#tbOps')!.addEventListener('click', () => this.openOps());
    this.eco.onSnapshot(() => {
      const sn = this.eco.snap;
      if (sn) {
        registerCustomTypes(sn.customTypes ?? []);
        if (this.traffic && !this.traffic.brands.length && sn.rivals.length) this.traffic.brands = sn.rivals.map((r) => ({ name: r.name, colors: { primary: r.colors[0], accent: r.colors[1], secondary: '#ffffff', window: '#1b2430' } }));
        if (this.inGame && sn.empire && !this.jet && sn.empire.state.aircraft.some((a) => a.typeId === 'gl7t')) void this.ensureJet();
        if (this.inGame && sn.empire) {
          this.empireWorld?.update(sn);
          this.syncCar();
        }
        // brand edits from the ops centre: repaint when name or colours change
        const sig = [sn.airline.name, sn.airline.primary, sn.airline.accent, sn.airline.livery ? 'L' : ''].join('|');
        if (this.brandSig && sig !== this.brandSig && this.airliner) this.applyBrand(sn.airline, this.airliner.registration);
        this.brandSig = sig;
      }
      this.updateTopbar();
    });
    this.eco.onEvent((e) => {
      if (e.level !== 'info') toast(e.text, e.level);
      if (e.level === 'achievement') this.audio.chime('achievement');
      else if (e.level === 'bad') this.audio.chime('bad');
    });
    addEventListener('resize', () => this.resize());
    document.addEventListener('pointerlockchange', () => this.setPaused(document.pointerLockElement !== this.renderer.domElement));
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.inGame) this.save('Autosave', true);
    });
  }

  private spawnLabels(): Record<string, { label: string }> {
    const out: Record<string, { label: string }> = {};
    for (const [k, v] of Object.entries(egkk.spawnPoints)) out[k] = { label: v.label };
    out.lhr_terminal = { label: 'Heathrow terminal' };
    out.lhr_apron = { label: 'Heathrow apron' };
    return out;
  }

  async start(): Promise<void> {
    try {
      this.hud.progress(0.05, 'Starting physics…');
      this.physics = await Physics.create();
      const preset = PRESETS[this.settings.preset];
      const tex = makeGroundTextures(preset.liveryResolution >= 4096 ? 1024 : 512);
      this.groundTex = tex;
      const aniso = Math.min(preset.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
      for (const t of [tex.asphalt, tex.runway, tex.concrete, tex.grass, tex.paint]) t.anisotropy = aniso;
      this.base = new Airport(this.assets, egkk as unknown as AirportData, this.origin);
      this.other = new Airport(this.assets, egll as unknown as AirportData, this.origin);
      const neutral: Brand = { name: '', colors: { primary: '#5a6470', accent: '#9aa3ad', secondary: '#ffffff', window: '#1b2430' } };
      const [pilot, exterior, interior, interiorLm, bridge] = await Promise.all([
        this.assets.loadGLTF('models/pilot.glb'),
        this.assets.loadGLTF(a320.model.file),
        this.assets.loadGLTF(a320.model.interior.file),
        this.assets.loadTexture(a320.model.interior.lightmap),
        this.assets.loadGLTF('models/jetbridge.glb'),
        this.base.load(preset, this.physics, this.renderer, tex, defaultBrand),
        this.other.load(preset, this.physics, this.renderer, tex, neutral),
      ]);
      this.scene.add(this.base.group, this.other.group);

      // real-world terrain, flattened under both airports
      this.terrain = new Terrain(this.origin, tex.grass, tex.macro, [this.base.maskWorld(), this.other.maskWorld()]);
      this.scene.add(this.terrain.group);

      // the player's aircraft at the base gate with its jet bridge
      const runways = [this.base, this.other].flatMap((ap) => ap.data.runways.map((_, i) => {
        const r = ap.runwayWorld(i);
        return { a: r.a, b: r.b, id: r.rw.id };
      }));
      this.homeRunways = runways;
      this.homeAids = new ApproachAids([this.base, this.other].flatMap((ap) => ap.data.runways.map((rw, i) => {
        const r = ap.runwayWorld(i);
        return { a: r.a, b: r.b, id: rw.id, widthM: rw.widthM };
      })));
      this.scene.add(this.homeAids.group);
      this.aircraft = new PlayerAircraft(exterior, interior, interiorLm, this.physics, defaultBrand, 'G-SKYE', preset.liveryResolution, preset.lodBias, {
        runways,
        airportLabel: { pos: this.base.group.position.clone(), text: egkk.icao },
      });
      this.aircraft.fm.altitudeMsl = (p) => p.y - a320.flight.cgModel[1] + this.originCur.elevation + (p.x * p.x + p.z * p.z) / (2 * R_EARTH);
      this.airliner = this.aircraft;
      this.scene.add(this.aircraft.root);
      this.landingLight = new THREE.SpotLight('#fff3dd', 0, 900, 0.32, 0.45, 2);
      this.landingLight.position.set(0, 2.2, -13);
      this.landingLight.target.position.set(0, -20, -200);
      this.aircraft.root.add(this.landingLight, this.landingLight.target);
      const rot = egkk.jetBridgeRotunda;
      const rotW = this.base.toWorld(rot[0], 0, rot[1]);
      this.bridge = new JetBridge(bridge, this.physics, [rotW.x, rotW.z]);
      this.bridge.group.position.y = 0;
      this.scene.add(this.bridge.group);
      this.aircraft.onBridgeRetract = (t) => this.bridge.setRetract(t);
      this.parkAtGate();

      this.empireWorld = new EmpireWorld(this.physics, this.base);
      this.traffic = new Traffic(this.base, exterior, preset.lodBias);
      this.traffic.onRadio = (text, speech) => {
        if (this.away || this.ops.isOpen || this.mode !== 'fly') return;
        if (!this.atc && this.eco.snap) this.atc = new Atc(this.eco.snap.airline.name, this.eco.snap.airline.code, (t, who) => this.audio.radio(t, who));
        this.atc?.traffic(text, speech);
      };
      this.exteriorGltf = exterior;
      this.people = new People(this.base, pilot);
      this.player = new Player(this.physics, pilot);
      this.player.thirdPerson = this.settings.thirdPerson;
      this.player.sensitivity = this.settings.mouseSensitivity;
      this.player.invertY = this.settings.invertY;
      this.scene.add(this.player.object);
      this.teleport('terminal', true);
      this.applyFlightSettings();
      this.applyPreset();
      this.hud.progress(1, 'Compiling shaders…');
      await this.renderer.compileAsync(this.scene, this.camera);
      this.hud.loaded();
      this.renderer.setAnimationLoop(() => this.loop());
      loadRates().then((src) => console.info(`[fx] ${src}`));
      if (new URLSearchParams(location.search).has('bench')) {
        this.inGame = true;
        runBenchmark(this);
      } else {
        this.menu.open();
      }
    } catch (err) {
      console.error(err);
      this.hud.error(`Failed to start: ${(err as Error).message}`);
    }
  }

  private heightAt = (x: number, z: number) => (this.settings.terrain ? this.terrain.heightAt(x, z) : this.away ? 0 : this.nearestAirportY(x, z));

  // ------------------------------------------------------------------ flying your own routes
  /** Ops centre "Fly": board your aircraft at the base gate for a flight on this route. */
  flyRoute(from: string, to: string): void {
    this.closeOps();
    this.useAirliner();
    if (from !== this.eco.snap?.base) {
      toast('Routes are flown from your base for now: flying the outbound leg', 'warn');
      [from, to] = [this.eco.snap!.base, from === this.eco.snap!.base ? to : from];
    }
    this.flightStart('seat');
    this.session = { from, to, phase: 'gate', fpm: 0, airborneAt: 0 };
    const A = AIRPORTS[from];
    const B = AIRPORTS[to];
    this.hud.toast(`Flight ${A?.iata}→${B?.iata}: push back (P), take off, then press K to skip to the approach.`);
  }

  /** Floating origin: re-centre the world on a destination airport generated from real runway data. */
  private goAway(icao: string): void {
    const ap = AIRPORTS[icao];
    if (!ap) return;
    this.away?.dispose();
    for (const c of this.awayColliders) this.physics.world.removeCollider(c, false);
    this.base.setActive(false);
    this.other.setActive(false);
    this.empireWorld?.setActive(false);
    this.traffic?.setActive(false);
    this.people?.setActive(false);
    if (this.mode === 'drive') this.exitCar();
    this.car?.park();
    this.bridge.group.visible = false;
    this.bridge.setRetract(1);
    this.originCur = { lat: ap.lat, lon: ap.lon, elevation: (airportElevFt(icao) ?? 0) * 0.3048 };
    this.away = new ProceduralAirport(icao, this.originCur, this.groundTex);
    this.scene.add(this.away.group);
    this.parkAwayAircraft();
    this.awayAids?.dispose();
    this.awayAids = new ApproachAids(this.away.runways.map((r) => ({ a: r.a, b: r.b, id: r.ends.join('/'), widthM: r.widthM })));
    this.scene.add(this.awayAids.group);
    if (this.homeAids) this.homeAids.group.visible = false;
    this.awayColliders = this.physics.addGround(4000, 500, 0, 0, 0);
    this.terrain.setOrigin(this.originCur, [this.away.mask()]);
    this.aircraft.setInstrumentRunways(this.away.runways.map((r) => ({ a: r.a, b: r.b, id: r.ends.join('/') })), { pos: new THREE.Vector3(), text: icao });
  }

  private goHome(): void {
    if (!this.away) return;
    this.awayAids?.dispose();
    this.awayAids = null;
    if (this.homeAids) this.homeAids.group.visible = true;
    for (const a of this.awayParked) a.root.visible = false;
    this.away.dispose();
    this.away = null;
    for (const c of this.awayColliders) this.physics.world.removeCollider(c, false);
    this.awayColliders = [];
    this.originCur = { ...this.origin };
    this.base.setActive(true);
    this.other.setActive(true);
    this.empireWorld?.setActive(true);
    this.people?.setActive(true);
    this.carSig = '';
    this.syncCar();
    if (this.eco.snap && this.eco.snap.empire.state.location !== this.eco.snap.base) this.eco.cmd({ kind: 'arriveHome' });
    this.bridge.group.visible = true;
    this.terrain.setOrigin(this.originCur, [this.base.maskWorld(), this.other.maskWorld()]);
    this.aircraft.setInstrumentRunways(this.homeRunways, { pos: this.base.group.position.clone(), text: egkk.icao });
  }

  /** K in flight: jump to ~30 nm out on the approach to the destination; business time moves on. */
  private skipToApproach(): void {
    const s = this.session;
    const fm = this.aircraft.fm;
    if (!s || s.phase !== 'airborne') return void this.hud.toast('Skip works once you are airborne on a route flight (Ops centre → Routes → Fly).');
    const agl = (fm.pos.y - this.heightAt(fm.pos.x, fm.pos.z)) / 0.3048;
    if (agl < 2500) return void this.hud.toast('Climb above 2,500 ft first, then press K to skip to the approach.');
    const A = AIRPORTS[s.from];
    const B = AIRPORTS[s.to];
    const totalH = distanceKm(A, B) / (450 * 1.852) + 0.5;
    const flownH = (performance.now() - s.airborneAt) / 3600_000;
    this.eco.cmd({ kind: 'advance', ms: Math.max(0, totalH - flownH - 0.25) * 3600_000 });
    let runway: { a: THREE.Vector3; b: THREE.Vector3; elevY: number };
    if (s.to === egkk.icao) {
      this.goHome();
      const r = this.base.runwayWorld(0);
      runway = { a: r.a, b: r.b, elevY: this.base.groundY };
    } else if (s.to === egll.icao) {
      this.goHome();
      const r = this.other.runwayWorld(0);
      runway = { a: r.a, b: r.b, elevY: this.other.groundY };
    } else {
      this.goAway(s.to);
      const rws = this.away!.runways;
      if (!rws.length) return void this.hud.toast('No runway data for this airport');
      const main = [...rws].sort((x, y) => y.lengthM - x.lengthM)[0];
      runway = { a: main.a, b: main.b, elevY: 0 };
    }
    // land on the end that faces where we came from
    const back = geoToLocal(this.originCur, A.lat, A.lon);
    const toOrigin = new THREE.Vector3(back.x, 0, back.z).normalize();
    const dAB = runway.b.clone().sub(runway.a).setY(0).normalize();
    const useA = dAB.clone().negate().dot(toOrigin) > dAB.dot(toOrigin);
    const thr = useA ? runway.a : runway.b;
    const dir = useA ? dAB : dAB.clone().negate();
    const dist = 55_600;
    const start = thr.clone().addScaledVector(dir, -dist);
    const heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
    const altAbove = 9000 * 0.3048;
    fm.place(new THREE.Vector3(start.x, runway.elevY + altAbove + fm.d.cgModel[1], start.z), (heading + 360) % 360, 250, false);
    fm.gearDown = false;
    fm.gearPos = 0;
    fm.flapIndex = fm.flapPos = 0;
    fm.spoilers = 0;
    fm.n1 = [0.45, 0.45];
    fm.throttleCmd = 0.45;
    const fieldFt = (runway.elevY + this.originCur.elevation) / 0.3048;
    Object.assign(fm.ap, { ap: true, athr: true, spdKt: 220, hdgDeg: Math.round((heading + 360) % 360), altFt: Math.round((fieldFt + 3000) / 100) * 100, vmode: 'VS', vsFpm: -1500 });
    this.aircraft.hardSync();
    this.flightControls.reset(0.45);
    this.hud.toast(`30 nm from ${B.iata || s.to}, lined up with the runway. Autopilot is descending to 3,000 ft: take over for the landing.`);
  }

  /** Track take-off and landing of a route flight you fly yourself. */
  private trackSession(): void {
    const s = this.session;
    if (!s) return;
    const fm = this.aircraft.fm;
    if (s.phase === 'gate' && !fm.onGround && fm.iasKt > 100) {
      s.phase = 'airborne';
      s.airborneAt = performance.now();
    }
    if (s.phase === 'airborne' && fm.onGround && fm.touchdownFpm < 0) s.fpm = Math.max(s.fpm || -9999, fm.touchdownFpm);
    if (s.phase === 'airborne' && fm.onGround && fm.groundSpeedKt < 3) {
      const destNear = this.away ? fm.pos.length() < 6000 : s.to === egkk.icao ? fm.pos.distanceTo(this.base.group.position) < 6000 : fm.pos.distanceTo(this.other.group.position) < 6000;
      if (!destNear) return;
      s.phase = 'landed';
      const fpm = fm.touchdownFpm || s.fpm;
      if (s.personal) {
        this.eco.cmd({ kind: 'arrivePersonal', icao: s.to, aircraftId: s.personal, fromIcao: s.from }).then((r) => toast(`${r.msg}. Landing ${Math.round(fpm)} ft/min.`, r.ok ? 'good' : 'bad'));
        this.session = null;
        return;
      }
      this.eco.cmd({ kind: 'playerFlight', from: s.from, to: s.to, typeId: 'a320neo', touchdownFpm: fpm }).then((r) => {
        const d = r.data as { pax: number; revenue: number; bonus: number; profit: number } | undefined;
        if (!d) return;
        const cur = this.eco.snap?.airline.currency ?? 'GBP';
        toast(`Flight complete: ${d.pax} passengers, revenue ${money(d.revenue, cur)}${d.bonus ? ` + ${money(d.bonus, cur)} smooth-landing bonus` : ''}, profit ${money(d.profit, cur)}. Landing ${Math.round(fpm)} fpm.`, 'good');
      });
      // offer the return leg
      this.session = { from: s.to, to: s.from, phase: 'gate', fpm: 0, airborneAt: 0 };
      this.aircraft.state = 'ready';
      this.hud.toast('Fly the return leg whenever you like: take off and press K. (Esc → Fly → Captain\'s seat takes you back to base.)');
    }
  }

  private nearestAirportY(x: number, z: number): number {
    const d = (a: Airport) => Math.hypot(a.group.position.x - x, a.group.position.z - z);
    return (d(this.base) < d(this.other) ? this.base : this.other).groundY;
  }

  private parkAtGate(): void {
    const st = egkk.stands.find((s) => s.id === egkk.playerStand)!;
    const nose = this.base.toWorld(st.nose[0], 0, st.nose[1]);
    this.aircraft.placeAtStand([nose.x, nose.z], this.base.toWorldHeading(st.headingDeg), this.heightAt);
    this.aircraft.hardSync();
    const door = this.aircraft.doorSill();
    this.bridge.group.position.y = 0;
    this.bridge.dock(door.pos, door.outward);
  }

  // ------------------------------------------------------------------ business: games, saves, ops centre
  private brandFromState(a: GameState['airline']): Brand {
    return { name: a.name, colors: { primary: a.primary, accent: a.accent, secondary: '#ffffff', window: '#1b2430' } };
  }

  private applyBrand(a: GameState['airline'], reg: string): void {
    const brand = this.brandFromState(a);
    if (a.livery) {
      (this.airliner ?? this.aircraft).model.applyLivery(a.livery, reg);
      this.base.repaintParked(brand, a.livery);
    } else {
      (this.airliner ?? this.aircraft).model.repaint(brand, reg);
      this.base.repaintParked(brand);
    }
    this.aircraft.registration = reg;
    this.brandSig = [a.name, a.primary, a.accent, a.livery ? 'L' : ''].join('|');
    const look = this.eco.snap?.player?.character;
    if (look && this.player) this.player.setLook(look, brand);
    const me = this.eco.snap?.fleet.find((x) => x.reg === reg);
    this.aircraft.setCabin(me?.cabin);
    const dot = this.topbar.querySelector<HTMLElement>('.dot');
    if (dot) dot.style.background = a.primary;
  }

  private enterWorld(): void {
    this.inGame = true;
    this.topbar.classList.add('show');
    this.teleport('terminal', true);
    this.setPaused(true);
    this.lastAutosave = performance.now();
  }

  newGame(p: NewGameParams): void {
    this.atc = null;
    this.eco.newGame({ ...p, gbpPerUsd: toCurrency(1, 'GBP') });
    const once = () => {
      const s = this.eco.snap;
      if (!s) return setTimeout(once, 50);
      this.applyBrand(s.airline, s.fleet[0]?.reg ?? 'G-SKYE');
      this.enterWorld();
      toast(`Welcome to ${p.airlineName}! Press Tab for the ops centre.`, 'good');
      this.openOps('overview');
    };
    setTimeout(once, 50);
  }

  loadGame(state: GameState): void {
    this.atc = null;
    const prev = this.eco.snap;
    this.eco.load(state);
    const reg = state.fleet[0]?.reg ?? 'G-SKYE';
    this.applyBrand(state.airline, reg);
    // character look and cabin come from the snapshot: re-apply once the loaded game's first one arrives
    const once = () => {
      const sn = this.eco.snap;
      if (!sn || sn === prev) return setTimeout(once, 50);
      this.applyBrand(sn.airline, reg);
    };
    setTimeout(once, 50);
    this.enterWorld();
    toast(`Loaded ${state.airline.name} · ${fmtDate(state.time, true)}`, 'good');
  }

  async save(slot: string, quiet = false): Promise<void> {
    if (!this.eco.running) return;
    const st = await this.eco.getState();
    await saveGame(slot, st);
    this.lastAutosave = performance.now();
    if (!quiet) toast(`Saved "${slot}"`, 'good');
  }

  /** Full-screen customisers opened from the ops centre (which stays open underneath). */
  private async openCustomiser(kind: 'livery' | 'cabin' | 'designer' | 'character', arg?: string): Promise<void> {
    const s = this.eco.snap;
    if (!s || this.editorOpen) return;
    this.editorOpen = true;
    const brand = this.brandFromState(s.airline);
    const done = () => {
      this.editorOpen = false;
      this.ops.redraw();
    };
    const run = async (cmd: Parameters<EconomyClient['cmd']>[0]) => {
      const r = await this.eco.cmd(cmd);
      toast(r.msg, r.ok ? 'good' : 'bad');
      return r.ok;
    };
    const reg = this.airliner.registration;
    if (kind === 'livery') {
      const gltf = await this.assets.loadGLTF(a320.model.file);
      new LiveryEditor(gltf, s.airline.livery, brand, reg, async (livery) => {
        if (await run({ kind: 'setLivery', livery })) {
          this.airliner.model.applyLivery(livery, reg);
          this.base.repaintParked(brand, livery);
        }
      }, done);
    } else if (kind === 'cabin') {
      const ac = s.fleet.find((x) => x.id === arg) ?? s.fleet[0];
      if (!ac) return done();
      new CabinEditor(TYPES[ac.typeId], s.fleet, ac, async (ids, cabin) => {
        if (await run({ kind: 'setCabin', aircraftIds: ids, cabin })) {
          const mine = s.fleet.find((x) => x.reg === reg);
          if (mine && ids.includes(mine.id)) this.aircraft.setCabin(cabin);
        }
      }, done);
    } else if (kind === 'designer') {
      const existing = arg ? s.customTypes.find((t) => t.id === arg) : undefined;
      new AircraftDesigner(brand, existing, (usd) => money(usd, s.airline.currency), async (type, devUSD) => {
        await run({ kind: 'designType', type, devCostUSD: s.difficulty === 'sandbox' ? 0 : devUSD });
      }, done);
    } else {
      const gltf = await this.assets.loadGLTF('models/pilot.glb');
      new CharacterCreator(gltf, s.player?.character, brand, async (look) => {
        if (await run({ kind: 'setCharacter', look })) this.player.setLook(look, brand);
      }, done);
    }
  }

  openOps(tab?: Parameters<OpsCenter['open']>[0]): void {
    if (!this.inGame) return;
    if (document.pointerLockElement) document.exitPointerLock();
    this.ops.open(tab);
    this.hud.setPaused(false);
  }

  closeOps(): void {
    this.ops.close();
    this.input.requestLock();
  }

  private updateTopbar(): void {
    const s = this.eco.snap;
    if (!s) return;
    (this.topbar.querySelector('#tbName') as HTMLElement).textContent = s.airline.name;
    (this.topbar.querySelector('#tbDate') as HTMLElement).textContent = fmtDate(s.time);
    (this.topbar.querySelector('#tbCash') as HTMLElement).textContent = s.difficulty === 'sandbox' ? '∞' : money(s.cashUSD, s.airline.currency);
    const eff = this.effectiveSpeed();
    this.topbar.querySelectorAll<HTMLElement>('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed! === this.ops.speed));
    (this.topbar.querySelector('#tbForced') as HTMLElement).textContent = !this.ops.isOpen && this.ops.speed !== eff && !this.paused ? 'real time while you walk or fly' : '';
  }

  /** Real time while walking or flying; the chosen speed in the ops centre; paused in menus. */
  private effectiveSpeed(): number {
    if (!this.inGame || this.cameraOverride) return 0;
    if (this.ops.isOpen) return this.ops.speed;
    if (this.paused) return 0;
    return this.ops.speed === 0 ? 0 : 1;
  }

  // ------------------------------------------------------------------ presets & settings
  setPreset(p: PresetId): void {
    this.settings.preset = p;
    saveSettings(this.settings);
    this.applyPreset();
    this.hud.sync(this.settings);
    this.hud.toast(`Graphics: ${PRESETS[p].label}`);
  }

  applyPreset(): void {
    const p = PRESETS[this.settings.preset];
    this.renderer.shadowMap.enabled = p.shadows;
    this.env.apply(this.renderer, p);
    for (const ap of [this.base, this.other]) ap.setShadows(p.shadows);
    this.camera.far = p.drawDistance;
    this.camera.updateProjectionMatrix();
    const zoom = (terrainCfg.presetMaxZoom as Record<string, number>)[this.settings.preset] ?? 13;
    this.terrain.setQuality(zoom, p.drawDistance, Math.min(p.anisotropy, 8));
    this.terrain.enabled = this.settings.terrain;
    for (const ap of [this.base, this.other]) ap.setGrassVisible(!this.settings.terrain);
    for (const ac of [...this.base.aircraft, ...this.other.aircraft, this.aircraft.model]) {
      ac.lod.levels.forEach((lv, i) => (lv.distance = (a320.model.lodDistances[i] ?? 0) * p.lodBias));
    }
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m)) m.needsUpdate = true;
    });
    this.composer?.dispose();
    this.composer = null;
    if (p.msaa > 0 || p.bloom) {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: p.msaa });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      if (p.bloom) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.25, 0.35, 0.95));
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  get pixelRatio(): number {
    const p = PRESETS[this.settings.preset];
    return Math.min(devicePixelRatio * p.renderScale, p.maxPixelRatio) * (this.settings.autoRes ? this.dynScale : 1);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private applyFlightSettings(): void {
    const fm = this.aircraft.fm;
    fm.profile = this.settings.flightProfile;
    fm.protections = this.settings.protections;
  }

  private updateSettings(s: Partial<Settings>): void {
    const terrainChanged = s.terrain !== undefined && s.terrain !== this.settings.terrain;
    Object.assign(this.settings, s);
    saveSettings(this.settings);
    if (this.player) {
      this.player.thirdPerson = this.settings.thirdPerson;
      this.player.sensitivity = this.settings.mouseSensitivity;
      this.player.invertY = this.settings.invertY;
    }
    if (this.aircraft) this.applyFlightSettings();
    if (terrainChanged && this.terrain) {
      this.terrain.enabled = this.settings.terrain;
      for (const ap of [this.base, this.other]) ap.setGrassVisible(!this.settings.terrain);
    }
    this.hud.sync(this.settings);
  }

  // ------------------------------------------------------------------ M8: time of day, weather, damage
  /** Game time for the sky: the economy clock, or a fixed local time (settings). */
  private skyTime(): number {
    const t = this.eco.snap?.time ?? Date.now();
    if (this.settings.timeOfDay === 'real') return t;
    const day = Math.floor(t / 86_400_000) * 86_400_000;
    const localHour = this.settings.timeOfDay === 'day' ? 13 : 23.5;
    return day + (localHour - this.originCur.lon / 15) * 3_600_000;
  }

  private updateWorldClock(dt: number): void {
    const t = this.skyTime();
    const sun = solarPosition(t, this.originCur.lat, this.originCur.lon);
    if (performance.now() - this.wxAt > 2000) {
      this.wxAt = performance.now();
      this.weather.forced = this.settings.weather;
      const ev = this.away ? [] : (this.eco.snap?.events ?? []).filter((e) => e.scope === 'base').map((e) => e.id);
      this.weather.update(t, this.originCur.lat, ev);
    }
    const c = this.weather.current;
    this.daylight = this.env.setConditions(sun, c);
    const night = 1 - this.daylight;
    this.base.setDaylight(this.daylight);
    this.other.setDaylight(this.daylight);
    this.away?.setDaylight(this.daylight);
    (this.away ? this.awayAids : this.homeAids)?.update(this.camera.position, night);
    for (const a of this.awayParked) if (a.root.visible) a.lights.update(0, night);
    this.empireWorld?.setNight(night);
    // wind (with a gentler layer near the ground) plus gusts and turbulence
    const fm = this.aircraft.fm;
    const to = ((c.windDirDeg + 180) * Math.PI) / 180;
    const agl = Math.max(0, fm.pos.y - this.heightAt(fm.pos.x, fm.pos.z));
    const layer = 0.55 + 0.45 * Math.min(1, agl / 300);
    const kt = c.windKt * 0.5144 * layer;
    const turb = c.turbulence * (c.storm ? W.turbulence.stormScale : 1) * W.turbulence.gustScale * (fm.onGround ? 0.2 : 1);
    const rnd = () => (Math.random() * 2 - 1) * turb * (2 + c.gustKt * 0.25);
    this.gust.lerp(new THREE.Vector3(rnd(), rnd() * 0.6, rnd()), 1 - Math.exp(-dt * 1.5));
    fm.wind.set(Math.sin(to) * kt, 0, -Math.cos(to) * kt).add(this.gust);
    // the player's aircraft lights
    const lights = this.aircraft.model.lights;
    lights.beacon = fm.enginesRunning && fm.n1[0] > 0.1;
    lights.strobe = !fm.onGround || fm.iasKt > 40;
    lights.update(this.elapsed, night);
    if (this.landingLight) this.landingLight.intensity = night > 0.2 && fm.gearPos > 0.5 && (fm.iasKt > 30 || !fm.onGround) ? 50000 * night : 0;
    if (this.crashTimer > 0) {
      this.crashTimer -= dt;
      if (this.crashTimer <= 0) {
        this.hud.crashReport(null);
        this.flightStart('seat');
      }
    }
  }

  /** Rival aircraft parked at a generated airport's stands (a small reused pool). */
  private parkAwayAircraft(): void {
    const away = this.away;
    const rivals = this.eco.snap?.rivals ?? [];
    if (!away || !this.exteriorGltf || !rivals.length) return;
    while (this.awayParked.length < 3) {
      const m = new AircraftModel(this.exteriorGltf, a320 as unknown as AircraftData, this.brandFromState(this.eco.snap!.airline), 'G-PARK', 1024, PRESETS[this.settings.preset].lodBias);
      this.scene.add(m.root);
      this.awayParked.push(m);
    }
    this.awayParked.forEach((m, i) => {
      const st = away.stands[i + 1];
      if (!st) return void (m.root.visible = false);
      const r = rivals[Math.floor(Math.random() * rivals.length)];
      m.repaint({ name: r.name, colors: { primary: r.colors[0], accent: r.colors[1], secondary: '#ffffff', window: '#1b2430' } });
      m.root.position.copy(st.pos);
      m.root.rotation.set(0, st.yaw, 0);
      m.lights.beacon = false;
      m.root.visible = true;
    });
  }

  /** AI traffic, people and audio. */
  private updateLife(dt: number): void {
    const fm = this.aircraft.fm;
    const c = this.weather.current;
    if (this.traffic && !this.away) {
      this.traffic.setWind(c.windDirDeg);
      const f = this.base.group.worldToLocal(fm.pos.clone());
      this.traffic.playerOnRunway = this.mode === 'fly' && Math.abs(f.z) < 80 && Math.abs(f.x) < 1900 && f.y < 300;
      this.traffic.update(dt);
      this.traffic.lights(this.elapsed, 1 - this.daylight);
    }
    if (this.people && !this.away) this.people.update(dt, this.camera.position);
    this.audioFrame(this.mode);
  }

  private audioFrame(mode: 'walk' | 'fly' | 'drive' | 'ops'): void {
    const fm = this.aircraft.fm;
    const c = this.weather.current;
    const agl = fm.pos.y - this.heightAt(fm.pos.x, fm.pos.z);
    this.audio.setVolume(this.settings.volume);
    this.audio.update({
      mode, cockpit: this.flightCam.mode === 'cockpit', n1: (fm.n1[0] + fm.n1[1]) / 2, iasKt: fm.iasKt, raFt: agl / 0.3048 - 8, onGround: fm.onGround,
      precip: c.precip, windKt: c.windKt, storm: c.storm, jet: this.traffic && !this.away ? this.traffic.loudest(this.camera.position) : { dist: 1e9, thrust: 0 },
      carSpeed: Math.abs(this.car?.speed ?? 0), carThrottle: this.mode === 'drive' && this.input.held(this.input.walking, 'forward') ? 1 : 0,
    });
  }

  private currentIls: ReturnType<typeof ilsFor> = null;

  private runwayDefs(): RunwayDef[] {
    if (this.away) return this.away.runways.map((r) => ({ a: r.a, b: r.b, id: r.ends.join('/'), widthM: r.widthM }));
    return [this.base, this.other].flatMap((ap) => ap.data.runways.map((rw, i) => {
      const r = ap.runwayWorld(i);
      return { a: r.a, b: r.b, id: rw.id, widthM: rw.widthM };
    }));
  }

  /** ILS guidance on the PFD and HUD, and ATC clearances. */
  private updateApproach(): void {
    const fm = this.aircraft.fm;
    const rws = this.runwayDefs();
    const ils = fm.onGround ? null : ilsFor(fm, rws);
    this.currentIls = ils;
    this.aircraft.setIls(ils);
    const s = this.eco.snap;
    if (!s) return;
    if (!this.atc) this.atc = new Atc(s.airline.name, s.airline.code, (text, who) => this.audio.radio(text, who));
    const agl = (fm.pos.y - this.heightAt(fm.pos.x, fm.pos.z)) / 0.3048;
    if (!fm.onGround && agl > 150) this.atcAirborne = true;
    // lined up on a runway end?
    let onRunway: string | null = null;
    for (const e of runwayEnds(rws)) {
      const rel = fm.pos.clone().sub(e.thr);
      const along = rel.x * e.dir.x + rel.z * e.dir.z;
      const cross = Math.abs(rel.x * e.dir.z - rel.z * e.dir.x);
      const course = (Math.atan2(e.dir.x, -e.dir.z) * 180) / Math.PI;
      let dh = Math.abs(fm.headingDeg - course) % 360;
      if (dh > 180) dh = 360 - dh;
      if (fm.onGround && along > -60 && along < 900 && cross < e.widthM / 2 + 8 && dh < 25) onRunway = e.ident;
    }
    const icao = this.away?.icao ?? (fm.pos.distanceTo(this.other.group.position) < fm.pos.distanceTo(this.base.group.position) ? egll.icao : egkk.icao);
    const ap = AIRPORTS[icao];
    const c = this.weather.current;
    this.atc.update({ fm, groundState: this.aircraft.state, aglFt: agl, onRunway, ils, airport: (ap?.city || ap?.name || icao).split(/[ ,(]/)[0], windDir: c.windDirDeg, windKt: c.windKt, qnh: c.qnh, landed: this.atcAirborne && fm.onGround });
  }

  private checkDamage(dt: number): void {
    const fm = this.aircraft.fm;
    this.damage.enabled = this.settings.damage;
    this.damage.runways = (this.away ? this.away.runways.map((r) => ({ a: r.a, b: r.b, widthM: r.widthM ?? 45 })) : this.homeRunways.map((r) => ({ a: r.a, b: r.b, widthM: 60 })));
    const inc: Incident | null = this.damage.update(fm, dt);
    if (!inc) return;
    this.eco.cmd({ kind: 'incident', severity: inc.kind, cause: inc.cause, costUSD: inc.costUSD }).then((r) => {
      const cost = (r.data as { cost: number } | undefined)?.cost ?? 0;
      const cur = this.eco.snap?.airline.currency ?? 'GBP';
      if (inc.kind === 'crash') this.hud.crashReport(`${inc.cause}. Repairs and write-off after insurance: ${money(cost, cur)}. Reputation took a heavy hit and the aircraft is out of service.`);
      else toast(`${inc.cause} · repair bill ${money(cost, cur)}`, 'bad');
    });
    if (inc.kind === 'crash') {
      fm.crashed = true;
      fm.vel.set(0, 0, 0);
      this.session = null;
      this.crashTimer = 7;
      this.damage.reset();
    }
  }

  // ------------------------------------------------------------------ M10: your own business jet
  private jetStand(): { pos: THREE.Vector3; heading: number } {
    if (this.away?.stands.length) {
      // stand 0 is free; park nose-out 25 m clear of the jet bridge so you can taxi straight off
      const st = this.away.stands[0];
      const out = new THREE.Vector3(Math.sin(st.yaw), 0, Math.cos(st.yaw));
      return { pos: st.pos.clone().addScaledVector(out, gl7tData.model.noseY + 25), heading: ((180 - (st.yaw * 180) / Math.PI) % 360 + 360) % 360 };
    }
    // east end of the Gatwick apron, angled towards the taxiway
    return { pos: this.base.toWorld(-262, 0, -470), heading: this.base.toWorldHeading(140) };
  }

  /** Load the jet model the first time it's needed. */
  private async ensureJet(): Promise<PlayerAircraft | null> {
    if (this.jet || this.jetLoading) return this.jet;
    this.jetLoading = true;
    const g = await this.assets.loadGLTF(gl7tData.model.file);
    const preset = PRESETS[this.settings.preset];
    const snap = this.eco.snap;
    const brand = snap ? this.brandFromState(snap.airline) : (defaultBrand as unknown as Parameters<PlayerAircraft['model']['repaint']>[0]);
    const spec = gl7tData as unknown as AircraftSpec;
    const jet = new PlayerAircraft(g, g, null, this.physics, brand, 'G-SKYJ', preset.liveryResolution, preset.lodBias, {
      runways: this.homeRunways,
      airportLabel: { pos: this.base.group.position.clone(), text: egkk.icao },
    }, spec);
    jet.fm.altitudeMsl = (p) => p.y - spec.flight.cgModel[1] + this.originCur.elevation + (p.x * p.x + p.z * p.z) / (2 * R_EARTH);
    jet.fm.heightAt = this.heightAt;
    // a personal scheme: your brand colours with small titles that fit a business jet
    const L = defaultLivery(brand);
    Object.assign(L.title, { s: 9.5, height: 0.55, size: 0.42 });
    jet.model.applyLivery(L, jet.registration);
    this.scene.add(jet.root);
    this.jet = jet;
    this.jetLoading = false;
    this.parkJet();
    return jet;
  }

  private parkJet(): void {
    const jet = this.jet;
    if (!jet) return;
    const st = this.jetStand();
    const nose = st.pos.clone();
    jet.placeAtStand([nose.x, nose.z], st.heading, this.heightAt);
    jet.fm.heightAt = this.heightAt;
    jet.door = jet.doorTarget = 0;
    const fm = jet.fm;
    fm.gearDown = true;
    fm.gearPos = 1;
    fm.spoilers = 0;
    fm.touchdownFpm = 0;
    fm.ap.ap = fm.ap.athr = false;
    jet.hardSync();
  }

  private useAirliner(): void {
    if (this.aircraft === this.airliner) return;
    if (this.mode === 'fly') this.exitSeat(false);
    this.aircraft = this.airliner;
    this.parkJet();
  }

  /** Fly your own jet to a destination from where you are now. */
  private async flyJet(to: string, aircraftId: string): Promise<void> {
    const snap = this.eco.snap;
    if (!snap) return;
    const from = snap.empire.state.location;
    if (from === to) return void toast('Pick somewhere else to fly to', 'warn');
    const owned = snap.empire.state.aircraft.find((a) => a.id === aircraftId);
    if (!owned || owned.typeId !== 'gl7t') return;
    this.closeOps();
    if (this.mode === 'drive') this.exitCar();
    // your jet waits where you are (home stand, or the apron of the airport you flew to)
    if (from === snap.base && this.away) this.goHome();
    else if (from !== snap.base && this.away?.icao !== from) this.goAway(from);
    const jet = await this.ensureJet();
    if (!jet) return;
    if (this.mode === 'fly') this.exitSeat(false);
    this.aircraft = jet;
    this.parkJet();
    jet.setInstrumentRunways(this.away ? this.away.runways.map((r) => ({ a: r.a, b: r.b, id: r.ends.join('/') })) : this.homeRunways, { pos: new THREE.Vector3(), text: this.away?.icao ?? egkk.icao });
    const fm = jet.fm;
    fm.parkingBrake = true;
    jet.startEngines();
    this.damage.reset();
    this.atc?.reset();
    this.atcAirborne = false;
    this.session = { from, to, phase: 'gate', fpm: 0, airborneAt: 0, personal: aircraftId };
    this.enterSeat();
    const B = AIRPORTS[to];
    this.hud.toast(`Your ${gl7tData.name} to ${B?.city || B?.name}: engines are starting. Release the parking brake (N), take off, then press K to skip to the approach.`);
  }

  // ------------------------------------------------------------------ M7: cars, jet trips
  /** Keep the active car waiting on the drive at home (rebuilt when you change cars or colours). */
  private syncCar(): void {
    const st = this.eco.snap?.empire.state;
    if (!st || !this.empireWorld || this.away) return;
    const c = st.cars.find((x) => x.id === st.activeCar);
    const sig = c ? `${c.id}|${c.model}|${c.color}` : '';
    if (sig === this.carSig) return;
    this.carSig = sig;
    if (this.mode === 'drive') this.exitCar();
    this.car?.dispose();
    this.car = null;
    if (!c) return;
    const m = empireData.cars.find((x) => x.id === c.model)!;
    this.car = new Car(this.physics, { style: m.style as CarStyle, topKmh: m.topKmh, accel: m.accel }, c.color);
    this.scene.add(this.car.root);
    const spot = this.empireWorld.carSpot();
    this.car.place(spot.pos, spot.heading);
  }

  /** "Drive your car" from the ops centre: the car is brought round to where you stand. */
  private driveNow(): void {
    if (this.away) return void toast('Your cars are at home: fly back first', 'warn');
    this.syncCar();
    if (!this.car) return void toast('Buy a car first (Personal empire → Garage)', 'warn');
    if (this.mode === 'fly') this.exitSeat();
    const p = this.player.position;
    const yaw = this.player.facingYaw();
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    this.car.root.visible = true;
    this.car.place(p.clone().addScaledVector(right, 3.5), yaw);
    this.enterCar();
  }

  private enterCar(): void {
    if (!this.car) return;
    this.mode = 'drive';
    this.player.park();
    this.camYaw = 0;
    this.hud.setMode('walk');
    this.hud.toast('W/S throttle and brake, A/D steer, Space handbrake, E to get out');
  }

  private exitCar(): void {
    if (!this.car) return;
    this.mode = 'walk';
    this.car.speed = 0;
    const p = this.car.doorWorld();
    this.player.teleport([p.x, p.y + 0.1, p.z], ((-this.car.heading * 180) / Math.PI + 360) % 360);
    this.hud.prompt('');
  }

  private updateDrive(dt: number): THREE.Vector3 {
    const I = this.input;
    const car = this.car!;
    const live = !this.paused;
    const k = (a: string) => live && I.held(I.walking, a);
    const throttle = (k('forward') ? 1 : 0) - (k('back') ? 1 : 0) + (live ? I.padTriggers[1] - I.padTriggers[0] : 0);
    const steer = (k('right') ? 1 : 0) - (k('left') ? 1 : 0) + (live ? I.padAxes[0] : 0);
    car.update(dt, THREE.MathUtils.clamp(throttle, -1, 1), THREE.MathUtils.clamp(steer, -1, 1), k('jump'));
    this.aircraft.update(dt, null, this.elapsed, false);
    // chase camera; the mouse swings it around the car
    if (live) this.camYaw = THREE.MathUtils.clamp(this.camYaw - I.mouseDX * 0.003 - I.padAxes[2] * 2 * dt, -Math.PI, Math.PI);
    if (!I.mouseDX && Math.abs(car.speed) > 3) this.camYaw = THREE.MathUtils.damp(this.camYaw, 0, 1.5, dt);
    const h = car.heading + this.camYaw;
    const back = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const target = car.position.add(new THREE.Vector3(0, 1.3, 0));
    const want = target.clone().addScaledVector(back, 7 + Math.abs(car.speed) * 0.04).add(new THREE.Vector3(0, 1.6, 0));
    this.camera.position.lerp(want, 1 - Math.exp(-dt * 8));
    this.camera.near = 0.1;
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.hud.prompt(`${Math.round(Math.abs(car.speed) * 3.6)} km/h · <kbd>E</kbd> Get out`);
    this.hud.crosshair(false);
    this.flightHud.show(false);
    if (live && I.hit(I.walking, 'interact', I.padWalking)) this.exitCar();
    return car.position;
  }

  /** Personal jet trip: the economy moves on by the flight time, then the world re-centres there. */
  private async travel(icao: string, aircraftId: string): Promise<void> {
    const r = await this.eco.cmd({ kind: 'travel', icao, aircraftId });
    if (!r.ok) return void toast(r.msg, 'bad');
    this.closeOps();
    if (this.mode === 'fly') this.exitSeat(false);
    if (this.mode === 'drive') this.exitCar();
    if (icao === this.eco.snap?.base) {
      this.teleport('terminal', true);
    } else {
      this.goAway(icao);
      const p = this.away?.apronSpawn ?? new THREE.Vector3(0, 0, 0);
      this.player.teleport([p.x, 0.1, p.z], 0);
    }
    toast(r.msg, 'good');
  }

  /** Camera views for ?bench, relative to the base airport's player stand. */
  benchViews(): { name: string; pos: [number, number, number]; look: [number, number, number] }[] {
    const st = egkk.stands.find((s) => s.id === egkk.playerStand)!;
    const tc = egkk.terminal.center;
    const w = (x: number, y: number, z: number) => this.base.toWorld(x, y, z).toArray() as [number, number, number];
    return [
      { name: 'apron', pos: w(st.nose[0] - 30, 6, st.nose[1] + 66), look: w(st.nose[0] + 20, 4, st.nose[1] + 1) },
      { name: 'terminal', pos: w(tc[0] - 30, 1.7, tc[1] + 10), look: w(tc[0] + 20, 2, tc[1] - 25) },
      { name: 'runway', pos: w(-1700, 40, -70), look: w(st.nose[0], 5, st.nose[1] + 30) },
    ];
  }

  // ------------------------------------------------------------------ teleports, seats, flight starts
  teleport(id: string, silent = false): void {
    if (!this.player) return;
    if (this.away) {
      this.goHome();
      this.parkAtGate();
      this.session = null;
    }
    const sp = id.startsWith('lhr_') ? this.other.spawn(id.slice(4)) : this.base.spawn(id);
    if (!sp) return;
    if (this.mode === 'fly') this.exitSeat(false);
    if (this.mode === 'drive') this.exitCar();
    this.player.teleport([sp.pos.x, sp.pos.y, sp.pos.z], sp.heading);
    if (!silent) this.hud.toast(sp.label);
  }

  private enterSeat(): void {
    this.mode = 'fly';
    this.player.park();
    this.flightCam.mode = 'cockpit';
    this.flightCam.resetHead();
    this.flightControls.reset(this.aircraft.fm.throttleCmd);
    this.hud.setMode('fly');
    this.hud.toast(this.aircraft.state === 'gate' ? "In the captain's seat. Press P for pushback, F to leave the seat." : 'You have control.');
  }

  private exitSeat(place = true): void {
    this.mode = 'walk';
    this.hud.setMode('walk');
    this.hud.prompt('');
    this.flightHud.show(false);
    if (place) {
      const p = this.aircraft.standWorld();
      this.player.teleport([p.x, p.y, p.z], this.aircraft.fm.headingDeg);
    }
  }

  flightStart(id: string): void {
    this.useAirliner();
    this.goHome();
    this.session = null;
    this.damage.reset();
    this.atc?.reset();
    this.atcAirborne = id === 'final';
    const fm = this.aircraft.fm;
    const r = this.base.runwayWorld(0);
    const along = r.b.clone().sub(r.a).setY(0).normalize();
    if (id === 'seat') {
      this.parkAtGate();
    } else {
      this.bridge.setRetract(1);
      this.aircraft.state = 'ready';
      this.aircraft.stateMsg = '';
      this.aircraft.door = this.aircraft.doorTarget = 0;
      fm.enginesRunning = true;
      fm.crashed = false;
      Object.assign(fm.ap, { ap: false, athr: false });
      if (id === 'lineup') {
        fm.place(r.a.clone().addScaledVector(along, 70), r.heading);
        fm.n1 = [0.2, 0.2];
        fm.flapIndex = fm.flapPos = 1;
        fm.gearDown = true;
        fm.gearPos = 1;
        fm.parkingBrake = true;
        this.aircraft.settle();
        fm.throttleCmd = 0;
        Object.assign(fm.ap, { spdKt: 160, hdgDeg: Math.round(r.heading), altFt: 5000, vsFpm: 1800 });
      } else {
        const dist = 8000;
        const p = r.b.clone().addScaledVector(along, dist);
        const glide = Math.tan(3 * DEG) * dist;
        const hdg = (r.heading + 180) % 360;
        fm.place(new THREE.Vector3(p.x, this.base.groundY + glide + a320.flight.cgModel[1] + 15, p.z), hdg, 150, false);
        fm.vel.y = -150 * 0.5144 * Math.sin(3 * DEG);
        fm.n1 = [0.5, 0.5];
        fm.throttleCmd = 0.5;
        fm.flapIndex = fm.flapPos = 3;
        fm.gearDown = true;
        fm.gearPos = 1;
        fm.parkingBrake = false;
        fm.spoilers = 0;
        Object.assign(fm.ap, { athr: true, spdKt: 142, hdgDeg: Math.round(hdg), altFt: 2000 });
      }
      this.aircraft.hardSync();
    }
    this.enterSeat();
    this.flightControls.reset(fm.throttleCmd);
    if (!this.input.locked) this.input.requestLock();
  }

  setPaused(p: boolean): void {
    if (this.cameraOverride) p = false;
    this.paused = p;
    // the settings overlay only shows when no business screen is on top
    this.hud.setPaused(p && this.inGame && !this.ops.isOpen && this.menu.el.classList.contains('hidden'));
  }

  // ------------------------------------------------------------------ loop
  /** Auto resolution: lower the render scale a little when frames get slow, raise it when there is headroom. */
  private autoResolution(): void {
    const now = performance.now();
    const ms = now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (!this.settings.autoRes || document.hidden || ms > 200) return;
    this.frameLog.push(ms);
    if (now - this.resAt < 1500 || this.frameLog.length < 30) return;
    this.resAt = now;
    const avg = this.frameLog.reduce((a, b) => a + b, 0) / this.frameLog.length;
    this.frameLog = [];
    const before = this.dynScale;
    if (avg > 22 && this.dynScale > 0.6) this.dynScale = Math.max(0.6, this.dynScale - 0.08);
    else if (avg < 14.5 && this.dynScale < 1) this.dynScale = Math.min(1, this.dynScale + 0.05);
    if (before !== this.dynScale) this.resize();
  }

  private loop(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t0 = performance.now();
    this.elapsed += dt;
    this.renderer.info.reset();
    const I = this.input;
    I.pollGamepad();

    // business time
    const speed = this.effectiveSpeed();
    if (speed !== this.lastSpeedSent) {
      this.eco.setSpeed(speed);
      this.lastSpeedSent = speed;
      this.updateTopbar();
    }
    if (this.inGame && performance.now() - this.lastAutosave > AUTOSAVE_MS) this.save('Autosave', true);

    if (!this.ops.isOpen) this.autoResolution();
    if (I.hit(I.global, 'toggleStats')) this.updateSettings({ showStats: !this.settings.showStats });
    if (I.hit(I.global, 'ops') && !this.editorOpen) {
      if (this.ops.isOpen) this.closeOps();
      else this.openOps();
    }
    if (I.hit(I.global, 'cyclePreset')) {
      const i = PRESET_IDS.indexOf(this.settings.preset);
      this.setPreset(PRESET_IDS[(i + 1) % PRESET_IDS.length]);
    }
    const menuBtn = I.hit({}, 'menu', this.mode === 'fly' ? I.padFlying : I.padWalking);
    if (menuBtn) {
      if (this.paused) I.requestLock();
      else document.exitPointerLock();
    }
    // while the ops centre covers the screen, skip the 3D world entirely to free the GPU for the globe
    if (this.ops.isOpen) {
      this.audioFrame('ops');
      I.endFrame();
      return;
    }

    const p0 = performance.now();
    this.physics.step(dt);
    this.physicsMs = performance.now() - p0;

    let focus: THREE.Vector3;
    if (this.cameraOverride) {
      this.cameraOverride(this.elapsed);
      this.aircraft.update(dt, null, this.elapsed, true);
      focus = this.camera.position;
    } else if (this.mode === 'walk') {
      focus = this.updateWalk(dt);
    } else if (this.mode === 'drive') {
      focus = this.updateDrive(dt);
    } else {
      focus = this.updateFly(dt);
    }
    this.aircraft.interior.visible = this.camera.position.distanceTo(this.aircraft.root.position) < 80;
    this.updateWorldClock(dt);
    this.updateLife(dt);
    this.env.update(this.camera, focus, this.elapsed, dt, this.aircraft.fm.wind);
    this.terrain.update(this.camera.position, this.elapsed);
    I.endFrame();

    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.cpuMs = performance.now() - t0;

    const pr = this.pixelRatio;
    const ts = this.terrain.stats;
    this.hud.frame(dt, this.renderer, {
      preset: PRESETS[this.settings.preset].label,
      res: `${Math.round(this.container.clientWidth * pr)}×${Math.round(this.container.clientHeight * pr)}`,
      pos: this.mode === 'fly' ? this.aircraft.root.position : this.player.position,
      physicsMs: this.physicsMs,
      cpuMs: this.cpuMs,
      terrain: `${ts.visible} shown · ${ts.pending} loading`,
    });
    this.onFrame?.(dt);
  }

  private updateWalk(dt: number): THREE.Vector3 {
    const I = this.input;
    const tp: Record<string, string> = { teleportApron: 'apron', teleportTerminal: 'terminal', teleportLandside: 'landside', teleportRunway: 'runway' };
    if (!this.paused) for (const [action, id] of Object.entries(tp)) if (I.hit(I.global, action)) this.teleport(id);
    const vWas = this.player.thirdPerson;
    this.aircraft.update(dt, null, this.elapsed, false);
    this.camera.near = 0.1;
    this.player.update(dt, this.paused ? NO_INPUT : I, this.camera);
    if (vWas !== this.player.thirdPerson) this.updateSettings({ thirdPerson: this.player.thirdPerson });
    this.camera.updateProjectionMatrix();
    const near = this.player.position.distanceTo(this.aircraft.seatWorld()) < 1.5;
    const nearCar = !!this.car && this.car.root.visible && this.player.position.distanceTo(this.car.position) < 3.2;
    this.hud.prompt(near ? "<kbd>E</kbd> Sit in the captain's seat" : nearCar ? '<kbd>E</kbd> Drive' : '');
    if (nearCar && !near && !this.paused && I.hit(I.walking, 'interact', I.padWalking)) this.enterCar();
    if (this.eco.snap && this.empireWorld?.isNearHQ(this.player.position)) this.empireWorld.tick(this.eco.snap);
    this.hud.crosshair(!this.player.thirdPerson);
    if (near && !this.paused && I.hit(I.walking, 'interact', I.padWalking)) this.enterSeat();
    this.flightHud.show(false);
    return this.player.position;
  }

  private updateFly(dt: number): THREE.Vector3 {
    const I = this.input;
    const pa = this.aircraft;
    const fc = this.flightControls;
    if (!this.paused) {
      for (const m of fc.update(dt, I, pa)) this.hud.toast(m);
      if (fc.cameraCycled) this.hud.toast(`${this.flightCam.cycle()} view`);
      if (fc.hudToggled) this.updateSettings({ showHud: !this.settings.showHud });
      if (I.hit(I.flying, 'skip', I.padFlying)) this.skipToApproach();
    }
    this.trackSession();
    this.checkDamage(dt);
    this.updateApproach();
    const cockpit = this.flightCam.mode === 'cockpit';
    pa.update(dt, this.paused ? null : fc.out, this.elapsed, cockpit || this.camera.position.distanceTo(pa.root.position) < 30);
    this.flightCam.tower.copy(this.base.toWorld(egkk.terminal.center[0], 32, egkk.terminal.center[1] + 5));
    this.flightCam.update(dt, this.camera, pa, I, !fc.mouseYoke, this.settings.mouseSensitivity);

    let label = '';
    if (cockpit && !fc.mouseYoke && !this.paused) {
      this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      this.raycaster.far = 1.8;
      const hit = this.raycaster.intersectObjects(pa.controls, false)[0];
      const name = hit?.object.userData.control as string | undefined;
      if (name) {
        label = `${CONTROL_LABELS[name] ?? name} · <kbd>click</kbd> + / toggle · <kbd>right-click</kbd> −`;
        for (const b of I.clicked) this.hud.toast(pa.clickControl(name, b, I.keyHeld('ShiftLeft')));
        if (I.wheel) this.hud.toast(pa.clickControl(name, I.wheel < 0 ? 0 : 2, I.keyHeld('ShiftLeft')));
      }
    }
    this.hud.prompt(label);
    this.hud.crosshair(cockpit && !fc.mouseYoke);
    if (fc.leaveSeat && !this.paused) {
      if (pa.fm.groundSpeedKt < 2 && pa.fm.onGround) this.exitSeat();
      else this.hud.toast('Stop the aircraft before leaving the seat');
    }
    const showHud = this.settings.showHud && !this.paused;
    this.flightHud.show(showHud);
    const sess = this.session ? `${AIRPORTS[this.session.from]?.iata}→${AIRPORTS[this.session.to]?.iata}${this.session.phase === 'airborne' ? ' · K skip' : ''}` : '';
    if (showHud) this.flightHud.draw(pa.fm, this.elapsed, { view: this.flightCam.mode, state: pa.stateMsg || sess, throttle: fc.out.throttle, ils: this.currentIls });
    this.hud.radio(this.paused || !this.atc ? [] : this.atc.log.filter((l) => performance.now() - l.t < 25000).slice(0, 3));
    this.hud.metar(showHud && this.eco.snap ? this.weather.metar(this.away?.icao ?? egkk.icao, this.eco.snap.time) : '');
    return pa.root.position;
  }
}

/** Input stand-in used while paused so the camera keeps following without reacting to keys. */
const NO_INPUT = {
  walking: {}, global: {}, flying: {}, padWalking: {}, padFlying: {}, mouseDX: 0, mouseDY: 0, wheel: 0, locked: false,
  padAxes: [0, 0, 0, 0], padTriggers: [0, 0], padConnected: false, clicked: [],
  held: () => false, hit: () => false, endFrame: () => undefined, requestLock: () => undefined, keyHeld: () => false,
} as unknown as Input;

function airportElevFt(icao: string): number | null {
  const a = AIRPORTS[icao];
  return a ? (a as unknown as { elevFt?: number }).elevFt ?? null : null;
}
