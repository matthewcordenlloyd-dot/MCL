import * as THREE from 'three';
import type { Livery, LiveryLayer } from '../economy/types';

/**
 * Paints an airline livery onto an aircraft's cylindrical fuselage UV and planar tail UV.
 * Positions are in metres along the fuselage (s, from the nose) and height above the
 * centreline (h). The whole livery is data (economy/types.ts Livery), edited in the
 * livery editor and saved with the game; the 3D preview and the fleet use this painter.
 */

export interface Brand {
  name: string;
  colors: { primary: string; accent: string; secondary: string; window: string };
}

export interface AircraftLiveryData {
  dimensions: { length: number; fuselageWidth: number; fuselageHeight: number };
  livery: {
    windows: { firstS: number; pitch: number; count: number; gaps: number[][]; width: number; height: number; centerAboveCenterline: number };
    overwingExits: { s: number; width: number; height: number }[];
    doors: { s: number; width: number; height: number; sillBelowCenterline: number; sides: string[] }[];
    cargoDoors: { s: number; width: number; height: number; side: string }[];
    cockpit: { panes: number[][] };
  };
}

const TAU = Math.PI * 2;
export const FONTS: Record<string, string> = {
  sans: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  script: '"Segoe Script", "Brush Script MT", cursive',
  mono: '"Cascadia Mono", Consolas, monospace',
  condensed: '"Arial Narrow", "Roboto Condensed", sans-serif',
  rounded: '"Trebuchet MS", "Segoe UI", sans-serif',
};

/** The default livery for a brand (what new airlines start with). */
export function defaultLivery(brand: Brand): Livery {
  return {
    base: brand.colors.secondary,
    belly: { color: brand.colors.primary, height: -0.95, sweep: 1 },
    cheat: { on: true, color: brand.colors.accent, width: 0.16 },
    windowFrame: '#c9ced4',
    engines: brand.colors.primary,
    title: { text: brand.name.toUpperCase(), color: brand.colors.primary, font: 'sans', size: 0.78, s: 12.4, height: 1.0, italic: false },
    regColor: '#2a2f36',
    tail: { color: brand.colors.primary, style: 'swoosh', accent: brand.colors.accent },
    layers: [],
  };
}

export function newLayer(kind: LiveryLayer['kind'], color = '#e0a526'): LiveryLayer {
  const base = { id: Math.random().toString(36).slice(2, 9), kind, color, visible: true, sweep: 0, text: '', font: 'sans' };
  switch (kind) {
    case 'band': return { ...base, s0: 0, s1: 37.6, h: 0.75, height: 0.2 };
    case 'stripe': return { ...base, s0: 24, s1: 33, h: -0.2, height: 0.5 };
    case 'text': return { ...base, s0: 25, s1: 25, h: 1.0, height: 0.7, text: 'Fly with us' };
    case 'logo': return { ...base, s0: 7.2, s1: 7.2, h: 1.05, height: 1.0 };
  }
}

// uploaded logos are data URLs; decode once and reuse
const logoCache = new Map<string, HTMLImageElement>();
export function logoImage(src: string | undefined, onLoad?: () => void): HTMLImageElement | null {
  if (!src) return null;
  let img = logoCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => onLoad?.();
    img.src = src;
    logoCache.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

export function paintLivery(ac: AircraftLiveryData, L: Livery, registration: string, width = 4096, onLogo?: () => void): THREE.CanvasTexture {
  const W = width;
  const H = width / 4;
  const len = ac.dimensions.length;
  const RZ = ac.dimensions.fuselageHeight / 2;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const px = (s: number) => (s / len) * W;
  const py = (theta: number) => (1 - theta / TAU) * H; // glTF V is flipped by the exporter
  const thetaR = (h: number) => Math.acos(THREE.MathUtils.clamp(-h / RZ, -1, 1));
  const dTheta = (m: number) => m / RZ;
  const both = (fn: (mirror: (t: number) => number, right: boolean) => void) => {
    fn((t) => t, true);
    fn((t) => TAU - t, false);
  };
  const aspect = (W / len) / (H / (TAU * RZ));

  g.fillStyle = L.base;
  g.fillRect(0, 0, W, H);

  // belly + cheatline, both sweeping up toward the tail
  const sweepH = (s: number, h: number, sweep: number) => h + Math.pow(Math.max(0, (s - 19) / 18.6), 1.6) * 2.7 * sweep;
  for (let x = 0; x < W; x++) {
    const s = (x / W) * len;
    const bh = sweepH(s, L.belly.height, L.belly.sweep);
    const tb = thetaR(bh);
    g.fillStyle = L.belly.color;
    g.fillRect(x, py(tb), 1, H - py(tb));
    g.fillRect(x, 0, 1, py(TAU - tb));
    if (L.cheat.on) {
      const ta = thetaR(bh + L.cheat.width);
      g.fillStyle = L.cheat.color;
      g.fillRect(x, py(ta), 1, py(tb) - py(ta));
      g.fillRect(x, py(TAU - tb), 1, py(TAU - ta) - py(TAU - tb));
    }
  }

  const drawText = (text: string, s: number, theta: number, sizeM: number, color: string, font: string, flipX: boolean, flipY: boolean, italic = false, weight = 800) => {
    g.save();
    g.translate(px(s), py(theta));
    g.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    g.scale(aspect, 1);
    g.font = `${italic ? 'italic ' : ''}${weight} ${(dTheta(sizeM) / TAU) * H}px ${FONTS[font] ?? FONTS.sans}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(text, 0, 0);
    g.restore();
  };
  const drawLogo = (img: HTMLImageElement, s: number, theta: number, sizeM: number, flipX: boolean, flipY: boolean) => {
    const hPx = (dTheta(sizeM) / TAU) * H;
    const wPx = hPx * (img.naturalWidth / img.naturalHeight) * aspect;
    g.save();
    g.translate(px(s), py(theta));
    g.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    g.drawImage(img, -wPx / 2, -hPx / 2, wPx, hPx);
    g.restore();
  };
  // extra paint layers (under the windows)
  for (const ly of L.layers) {
    if (!ly.visible) continue;
    if (ly.kind === 'band' || ly.kind === 'stripe') {
      const s0 = Math.max(0, Math.min(ly.s0, ly.s1));
      const s1 = Math.min(len, Math.max(ly.s0, ly.s1));
      g.fillStyle = ly.color;
      for (let x = Math.floor(px(s0)); x < px(s1); x++) {
        const s = (x / W) * len;
        const h = ly.kind === 'band' ? sweepH(s, ly.h, ly.sweep) : ly.h;
        const t0 = thetaR(h - ly.height / 2);
        const t1 = thetaR(h + ly.height / 2);
        g.fillRect(x, py(t1), 1, py(t0) - py(t1));
        g.fillRect(x, py(TAU - t0), 1, py(TAU - t1) - py(TAU - t0));
      }
    } else if (ly.kind === 'text' && ly.text) {
      both((m, right) => drawText(ly.text, ly.s0, m(thetaR(ly.h)), ly.height, ly.color, ly.font, right, !right));
    } else if (ly.kind === 'logo') {
      const img = logoImage(L.logo, onLogo);
      if (img) both((m, right) => drawLogo(img, ly.s0, m(thetaR(ly.h)), ly.height, right, !right));
    }
  }

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.roundRect(x - w / 2, y - h / 2, w, h, Math.min(r, w / 2, h / 2));
  };
  // passenger windows
  const win = ac.livery.windows;
  const wPx = px(win.width);
  const hPx = (dTheta(win.height) / TAU) * H;
  const tWin = thetaR(win.centerAboveCenterline);
  for (let i = 0; i < win.count; i++) {
    const s = win.firstS + i * win.pitch;
    if (win.gaps.some(([a, b]) => s > a && s < b)) continue;
    both((m) => {
      const y = py(m(tWin));
      roundRect(px(s), y, wPx * 1.25, hPx * 1.18, wPx * 0.5);
      g.fillStyle = L.windowFrame;
      g.fill();
      roundRect(px(s), y, wPx, hPx, wPx * 0.45);
      g.fillStyle = '#1b2430';
      g.fill();
    });
  }
  // doors
  g.lineWidth = Math.max(1.5, W / 2048);
  const doorRect = (s: number, wd: number, hd: number, centreH: number, theta: (t: number) => number) => {
    roundRect(px(s), py(theta(thetaR(centreH))), px(wd), (dTheta(hd) / TAU) * H, px(0.12));
    g.strokeStyle = 'rgba(60,70,80,0.75)';
    g.stroke();
  };
  for (const d of ac.livery.doors) {
    const centre = -d.sillBelowCenterline + d.height / 2;
    both((m) => {
      doorRect(d.s, d.width, d.height, centre, m);
      roundRect(px(d.s), py(m(thetaR(centre + 0.45))), wPx * 0.9, hPx * 0.8, wPx * 0.4);
      g.fillStyle = '#1b2430';
      g.fill();
    });
  }
  for (const e of ac.livery.overwingExits) both((m) => doorRect(e.s, e.width, e.height, win.centerAboveCenterline - 0.05, m));
  for (const d of ac.livery.cargoDoors) doorRect(d.s, d.width, d.height, -1.35, (t) => t);
  // cockpit windows
  g.fillStyle = '#141b24';
  for (const [s0, s1, t0, t1] of ac.livery.cockpit.panes as [number, number, number, number][]) {
    both((m) => {
      const ya = py(m(t0));
      const yb = py(m(t1));
      g.beginPath();
      g.roundRect(px(s0), Math.min(ya, yb), px(s1 - s0), Math.abs(yb - ya), px(0.06));
      g.fill();
    });
  }
  // titles + registration
  if (L.title.text) {
    const tT = thetaR(L.title.height);
    drawText(L.title.text, L.title.s, tT, L.title.size, L.title.color, L.title.font, true, false, L.title.italic);
    drawText(L.title.text, L.title.s, TAU - tT, L.title.size, L.title.color, L.title.font, false, true, L.title.italic);
  }
  drawText(registration, 29.2, thetaR(0.55), 0.32, L.regColor, 'sans', true, false, false, 600);
  drawText(registration, 29.2, TAU - thetaR(0.55), 0.32, L.regColor, 'sans', false, true, false, 600);

  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function paintTailLivery(L: Livery, size = 1024, onLogo?: () => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = L.tail.color;
  g.fillRect(0, 0, size, size);
  // canvas top = fin tip, left = leading edge
  const T = L.tail;
  if (T.style === 'swoosh' || T.style === 'emblem') {
    g.strokeStyle = T.accent;
    g.lineWidth = size * 0.035;
    g.beginPath();
    g.moveTo(size * 0.05, size * 0.98);
    g.bezierCurveTo(size * 0.45, size * 0.75, size * 0.7, size * 0.55, size * 1.05, size * 0.5);
    g.stroke();
  }
  if (T.style === 'stripes') {
    g.fillStyle = T.accent;
    for (let i = 0; i < 3; i++) {
      const o = size * (0.25 + i * 0.16);
      g.beginPath();
      g.moveTo(o, size);
      g.lineTo(o + size * 0.08, size);
      g.lineTo(o + size * 0.55, 0);
      g.lineTo(o + size * 0.47, 0);
      g.fill();
    }
  }
  if (T.style === 'emblem' || T.style === 'swoosh') {
    const cx = size * 0.62;
    const cy = size * 0.4;
    const r = size * 0.13;
    g.lineWidth = size * 0.022;
    g.strokeStyle = L.base;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = T.accent;
    g.beginPath();
    g.moveTo(cx - r * 0.8, cy + r * 0.35);
    g.quadraticCurveTo(cx, cy - r * 0.2, cx + r * 0.85, cy - r * 0.6);
    g.lineTo(cx + r * 0.6, cy - r * 0.15);
    g.quadraticCurveTo(cx, cy + r * 0.15, cx - r * 0.8, cy + r * 0.35);
    g.fill();
  }
  if (T.style === 'logo') {
    const img = logoImage(L.logo, onLogo);
    if (img) {
      const s = size * 0.42;
      const w = s * (img.naturalWidth / img.naturalHeight);
      g.drawImage(img, size * 0.62 - w / 2, size * 0.42 - s / 2, w, s);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Compatibility helpers used when only a brand is known (parked stand-ins, new games). */
export function paintFuselage(ac: AircraftLiveryData, brand: Brand, registration: string, width = 4096): THREE.CanvasTexture {
  return paintLivery(ac, defaultLivery(brand), registration, width);
}

export function paintTail(brand: Brand, size = 1024): THREE.CanvasTexture {
  return paintTailLivery(defaultLivery(brand), size);
}
