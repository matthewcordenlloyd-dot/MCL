import presetsData from '@data/graphics_presets.json';

export type PresetId = 'low' | 'medium' | 'high' | 'ultra';

export interface GraphicsPreset {
  label: string;
  renderScale: number;
  maxPixelRatio: number;
  msaa: number;
  shadows: boolean;
  shadowMapSize: number;
  shadowDistance: number;
  anisotropy: number;
  lodBias: number;
  bloom: boolean;
  envMapSize: number;
  liveryResolution: number;
  drawDistance: number;
  clouds: boolean;
}

export interface Settings {
  preset: PresetId;
  showStats: boolean;
  mouseSensitivity: number;
  invertY: boolean;
  thirdPerson: boolean;
  flightProfile: 'arcade' | 'realistic';
  protections: boolean;
  showHud: boolean;
  terrain: boolean;
  timeOfDay: 'real' | 'day' | 'night';
  weather: 'live' | 'clear';
  damage: boolean;
  volume: number;
  autoRes: boolean;
}

export const PRESET_IDS: PresetId[] = ['low', 'medium', 'high', 'ultra'];
export const PRESETS = presetsData.presets as Record<PresetId, GraphicsPreset>;

const KEY = 'skyempire.settings.v1';

const defaults: Settings = {
  preset: presetsData.default as PresetId,
  showStats: true,
  mouseSensitivity: 1,
  invertY: false,
  thirdPerson: true,
  flightProfile: 'arcade',
  protections: true,
  showHud: true,
  terrain: true,
  timeOfDay: 'real',
  weather: 'live',
  damage: true,
  volume: 0.7,
  autoRes: true,
};

/** Per-viewer settings live in localStorage (saves go to IndexedDB from M3). */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable: use defaults */
  }
  return { ...defaults };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** URL overrides for testing: ?preset=low|medium|high|ultra */
export function urlPreset(): PresetId | null {
  const p = new URLSearchParams(location.search).get('preset');
  return p && (PRESET_IDS as string[]).includes(p) ? (p as PresetId) : null;
}
