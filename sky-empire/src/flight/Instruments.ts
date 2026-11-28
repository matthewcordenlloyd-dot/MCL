import * as THREE from 'three';
import type { FlightModel } from './FlightModel';

/**
 * Glass-cockpit displays drawn to canvases and used as textures on the cockpit
 * display meshes (disp_* in the interior model). Style is a generic Airbus-like
 * layout: PFD, ND (arc), E/WD (engines), SD (wheel/systems) and the FCU window.
 */

export interface InstrumentExtras {
  runways: { a: THREE.Vector3; b: THREE.Vector3; id: string }[];
  airportLabel: { pos: THREE.Vector3; text: string } | null;
  doorOpen: boolean;
  pushbackState: string;
  profile: string;
  ils?: IlsState | null;
}

import type { IlsState } from './Approach';

const GREEN = '#3ee68a';
const CYAN = '#3fd0ff';
const MAGENTA = '#ff4fd8';
const AMBER = '#ffb020';
const WHITE = '#f2f2f2';
const YELLOW = '#ffe14d';
const RED = '#ff3b3b';
const SKY = '#2c79d6';
const GROUND = '#8a5a2c';
const FONT = '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';

function make(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.flipY = false; // glTF UV convention on the display meshes
  tex.generateMipmaps = false; // re-uploaded often: mipmaps cost more than they add at cockpit distance
  tex.minFilter = THREE.LinearFilter;
  return { canvas, ctx, tex };
}

export class Instruments {
  readonly pfd = make(512, 512);
  readonly nd = make(512, 512);
  readonly ewd = make(512, 512);
  readonly sd = make(512, 512);
  readonly fcu = make(1024, 112);
  private last = -1;

  get textures(): Record<string, THREE.CanvasTexture> {
    return {
      disp_pfd_c: this.pfd.tex,
      disp_pfd_f: this.pfd.tex,
      disp_nd_c: this.nd.tex,
      disp_nd_f: this.nd.tex,
      disp_ewd: this.ewd.tex,
      disp_sd: this.sd.tex,
      disp_fcu: this.fcu.tex,
    };
  }

  private tick = 0;
  private static readonly ORDER = ['pfd', 'nd', 'pfd', 'ewd', 'pfd', 'sd', 'pfd', 'fcu'] as const;

  /**
   * Canvas-to-GPU uploads stall the pipeline on integrated graphics, so exactly one display
   * is redrawn and uploaded per 30 Hz tick: PFD at 15 Hz, the others at about 4 Hz.
   */
  update(fm: FlightModel, x: InstrumentExtras, t: number, hz = 30): void {
    if (t - this.last < 1 / hz) return;
    this.last = t;
    const which = Instruments.ORDER[this.tick++ % Instruments.ORDER.length];
    switch (which) {
      case 'pfd':
        this.drawPfd(fm, x.ils ?? null);
        this.pfd.tex.needsUpdate = true;
        break;
      case 'nd':
        this.drawNd(fm, x);
        this.nd.tex.needsUpdate = true;
        break;
      case 'ewd':
        this.drawEwd(fm, x);
        this.ewd.tex.needsUpdate = true;
        break;
      case 'sd':
        this.drawSd(fm, x);
        this.sd.tex.needsUpdate = true;
        break;
      case 'fcu':
        this.drawFcu(fm);
        this.fcu.tex.needsUpdate = true;
        break;
    }
  }

  // ------------------------------------------------------------------ PFD
  private drawPfd(fm: FlightModel, ils: IlsState | null): void {
    const g = this.pfd.ctx;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 512);
    const cx = 256;
    const cy = 236;
    const pxDeg = 6.2;
    const pitch = fm.pitchDeg;
    const bank = fm.bankDeg;

    // attitude
    g.save();
    g.beginPath();
    g.roundRect(150, 92, 212, 288, 18);
    g.clip();
    g.translate(cx, cy);
    g.rotate((-bank * Math.PI) / 180);
    g.translate(0, pitch * pxDeg);
    g.fillStyle = SKY;
    g.fillRect(-400, -800, 800, 800);
    g.fillStyle = GROUND;
    g.fillRect(-400, 0, 800, 800);
    g.strokeStyle = WHITE;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-400, 0);
    g.lineTo(400, 0);
    g.stroke();
    g.font = `16px ${FONT}`;
    g.fillStyle = WHITE;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 2.5) {
      if (p === 0) continue;
      const y = -p * pxDeg;
      const w = p % 10 === 0 ? 70 : p % 5 === 0 ? 40 : 18;
      g.beginPath();
      g.moveTo(-w / 2, y);
      g.lineTo(w / 2, y);
      g.stroke();
      if (p % 10 === 0) {
        g.fillText(String(Math.abs(p)), -w / 2 - 18, y);
        g.fillText(String(Math.abs(p)), w / 2 + 18, y);
      }
    }
    g.restore();

    // bank scale
    g.save();
    g.translate(cx, cy);
    g.strokeStyle = WHITE;
    g.lineWidth = 2;
    for (const a of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const r = (a * Math.PI) / 180;
      const len = a % 30 === 0 ? 14 : 8;
      g.beginPath();
      g.moveTo(Math.sin(r) * 128, -Math.cos(r) * 128);
      g.lineTo(Math.sin(r) * (128 + len), -Math.cos(r) * (128 + len));
      g.stroke();
    }
    g.rotate((-bank * Math.PI) / 180);
    g.fillStyle = YELLOW;
    g.beginPath();
    g.moveTo(0, -126);
    g.lineTo(-9, -110);
    g.lineTo(9, -110);
    g.fill();
    g.restore();

    // aircraft symbol
    g.fillStyle = '#000';
    g.strokeStyle = YELLOW;
    g.lineWidth = 4;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * 95, cy);
      g.lineTo(cx + s * 45, cy);
      g.lineTo(cx + s * 45, cy + 14);
      g.stroke();
    }
    g.strokeRect(cx - 5, cy - 5, 10, 10);

    // speed tape
    const kt = fm.iasKt;
    this.tape(g, 40, 92, 84, 288, kt, 3.2, 10, 20, (v) => String(Math.round(v)), 'left');
    const vs = fm.stallSpeedKt();
    g.save();
    g.beginPath();
    g.rect(40, 92, 84, 288);
    g.clip();
    const yStall = cy + (kt - vs) * 3.2;
    g.fillStyle = RED;
    for (let y = yStall; y < 380; y += 16) g.fillRect(112, y, 10, 8);
    const vmax = fm.maxSpeedKt();
    const yMax = cy + (kt - vmax) * 3.2;
    for (let y = yMax; y > 92; y -= 16) g.fillRect(112, y - 8, 10, 8);
    if (fm.ap.athr || fm.ap.ap) {
      const ys = cy + (kt - fm.ap.spdKt) * 3.2;
      g.fillStyle = MAGENTA;
      g.beginPath();
      g.moveTo(124, ys);
      g.lineTo(136, ys - 8);
      g.lineTo(136, ys + 8);
      g.fill();
    }
    g.restore();
    g.fillStyle = YELLOW;
    g.fillRect(28, cy - 2, 108, 4);

    // altitude tape + readout
    const alt = fm.altFt;
    this.tape(g, 392, 92, 76, 288, alt, 0.32, 100, 500, (v) => String(Math.round(v / 100)).padStart(3, '0'), 'right');
    g.save();
    g.beginPath();
    g.rect(392, 92, 76, 288);
    g.clip();
    const ya = cy + (alt - fm.ap.altFt) * 0.32;
    g.fillStyle = CYAN;
    g.fillRect(392, ya - 2, 10, 4);
    g.restore();
    g.fillStyle = '#000';
    g.strokeStyle = YELLOW;
    g.lineWidth = 2;
    g.fillRect(398, cy - 18, 90, 36);
    g.strokeRect(398, cy - 18, 90, 36);
    g.fillStyle = GREEN;
    g.font = `bold 24px ${FONT}`;
    g.textAlign = 'right';
    g.fillText(String(Math.round(alt)).padStart(5, ' '), 484, cy + 1);
    g.font = `16px ${FONT}`;
    g.fillStyle = CYAN;
    g.fillText(String(Math.round(fm.ap.altFt)), 466, 80);

    // VS
    const v = fm.vsFpm;
    g.fillStyle = Math.abs(v) > 6000 ? AMBER : GREEN;
    g.textAlign = 'center';
    g.font = `bold 18px ${FONT}`;
    const vy = cy - THREE.MathUtils.clamp(v / 6000, -1, 1) * 120;
    g.fillText(String(Math.round(Math.abs(v) / 100)).padStart(2, '0'), 498, vy);
    g.strokeStyle = GREEN;
    g.beginPath();
    g.moveTo(490, cy);
    g.lineTo(498, vy + (v > 0 ? 12 : -12));
    g.stroke();

    // ILS: glideslope scale right of the attitude, localiser scale below it, ident top left
    if (ils) {
      g.fillStyle = MAGENTA;
      g.font = `bold 15px ${FONT}`;
      g.textAlign = 'left';
      g.fillText(`ILS ${ils.ident}  CRS ${String(Math.round(ils.courseDeg)).padStart(3, '0')}  ${ils.distNm.toFixed(1)} NM`, 150, 80);
      g.strokeStyle = WHITE;
      g.lineWidth = 2;
      for (let i = -2; i <= 2; i++) {
        if (!i) continue;
        g.beginPath();
        g.arc(377, cy + i * 30, 3.5, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.arc(cx + i * 30, 390, 3.5, 0, Math.PI * 2);
        g.stroke();
      }
      const diamond = (x: number, y: number) => {
        g.beginPath();
        g.moveTo(x, y - 8);
        g.lineTo(x + 6, y);
        g.lineTo(x, y + 8);
        g.lineTo(x - 6, y);
        g.closePath();
        g.fill();
      };
      g.fillStyle = MAGENTA;
      diamond(377, cy - ils.gs * 30);
      diamond(cx + ils.loc * 30, 390);
    }

    // heading tape
    const hdg = fm.headingDeg;
    g.save();
    g.beginPath();
    g.rect(150, 400, 212, 44);
    g.clip();
    g.fillStyle = '#111';
    g.fillRect(150, 400, 212, 44);
    g.strokeStyle = WHITE;
    g.fillStyle = WHITE;
    g.font = `18px ${FONT}`;
    g.textAlign = 'center';
    for (let d = Math.floor(hdg / 5) * 5 - 30; d <= hdg + 30; d += 5) {
      const x = cx + (d - hdg) * 7;
      const hd = ((d % 360) + 360) % 360;
      g.beginPath();
      g.moveTo(x, 400);
      g.lineTo(x, hd % 10 === 0 ? 414 : 408);
      g.stroke();
      if (hd % 10 === 0) g.fillText(String(hd / 10), x, 428);
    }
    const hs = cx + (((fm.ap.hdgDeg - hdg + 540) % 360) - 180) * 7;
    g.fillStyle = CYAN;
    g.beginPath();
    g.moveTo(hs, 402);
    g.lineTo(hs - 8, 392);
    g.lineTo(hs + 8, 392);
    g.fill();
    g.restore();
    g.fillStyle = YELLOW;
    g.fillRect(cx - 2, 396, 4, 22);

    // flight mode annunciator
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 64);
    g.strokeStyle = '#555';
    for (const x of [102, 204, 306, 408]) {
      g.beginPath();
      g.moveTo(x, 4);
      g.lineTo(x, 58);
      g.stroke();
    }
    g.font = `bold 17px ${FONT}`;
    g.textAlign = 'center';
    const fma = (col: number, row: number, text: string, color = GREEN) => {
      g.fillStyle = color;
      g.fillText(text, 51 + col * 102, 20 + row * 24);
    };
    if (fm.ap.athr) fma(0, 0, 'SPEED');
    else if (fm.throttleCmd > 0.97 && !fm.onGround) fma(0, 0, 'TOGA', WHITE);
    if (fm.ap.ap) {
      fma(1, 0, fm.ap.vmode === 'VS' ? 'V/S' : 'ALT');
      fma(2, 0, 'HDG');
    }
    if (fm.ap.ap) fma(4, 0, 'AP1', WHITE);
    if (fm.ap.athr) fma(4, 1, 'A/THR', WHITE);
    fma(3, 0, fm.profile === 'arcade' ? 'ARCADE' : fm.protections ? 'NORMAL' : 'DIRECT', fm.profile === 'arcade' ? CYAN : fm.protections ? WHITE : AMBER);
    if (fm.stallWarning) {
      g.fillStyle = RED;
      g.font = `bold 26px ${FONT}`;
      g.fillText('STALL', cx, 470);
    } else if (fm.onGround && fm.touchdownFpm < -10) {
      g.fillStyle = WHITE;
      g.font = `16px ${FONT}`;
      g.fillText(`TOUCHDOWN ${Math.round(fm.touchdownFpm)} FPM`, cx, 476);
    }
  }

  private tape(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, value: number, pxPerUnit: number, minor: number, major: number, fmt: (v: number) => string, side: 'left' | 'right'): void {
    const cy = y + h / 2;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = '#4a4f57';
    g.fillRect(x, y, w, h);
    g.strokeStyle = WHITE;
    g.fillStyle = WHITE;
    g.lineWidth = 2;
    g.font = `18px ${FONT}`;
    g.textBaseline = 'middle';
    const span = h / 2 / pxPerUnit;
    const start = Math.floor((value - span) / minor) * minor;
    for (let v = start; v <= value + span; v += minor) {
      if (v < 0 && side === 'left') continue;
      const yy = cy - (v - value) * pxPerUnit;
      const big = Math.round(v) % major === 0;
      g.beginPath();
      if (side === 'left') {
        g.moveTo(x + w - (big ? 16 : 10), yy);
        g.lineTo(x + w, yy);
      } else {
        g.moveTo(x, yy);
        g.lineTo(x + (big ? 16 : 10), yy);
      }
      g.stroke();
      if (big) {
        g.textAlign = side === 'left' ? 'right' : 'left';
        g.fillText(fmt(v), side === 'left' ? x + w - 20 : x + 20, yy);
      }
    }
    g.restore();
  }

  // ------------------------------------------------------------------ ND (arc mode, 10 NM)
  private drawNd(fm: FlightModel, x: InstrumentExtras): void {
    const g = this.nd.ctx;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 512);
    const cx = 256;
    const cy = 430;
    const R = 330;
    const rangeNm = 10;
    const pxPerM = R / (rangeNm * 1852);
    const hdg = fm.headingDeg;
    const toScreen = (p: THREE.Vector3) => {
      const dx = p.x - fm.pos.x;
      const dz = p.z - fm.pos.z;
      const h = (-hdg * Math.PI) / 180;
      // rotate world (east = x, north = -z) into heading-up screen space
      const e = dx;
      const n = -dz;
      const sx = e * Math.cos(h) - n * Math.sin(h);
      const sy = e * Math.sin(h) + n * Math.cos(h);
      return { x: cx + sx * pxPerM, y: cy - sy * pxPerM };
    };
    g.save();
    g.beginPath();
    g.arc(cx, cy, R + 4, Math.PI, 0);
    g.lineTo(512, 512);
    g.lineTo(0, 512);
    g.closePath();
    g.clip();
    // runways
    g.strokeStyle = WHITE;
    g.lineWidth = 3;
    g.font = `14px ${FONT}`;
    g.fillStyle = WHITE;
    for (const rw of x.runways) {
      const a = toScreen(rw.a);
      const b = toScreen(rw.b);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    if (x.airportLabel) {
      const p = toScreen(x.airportLabel.pos);
      g.strokeStyle = MAGENTA;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.x, p.y, 7, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = MAGENTA;
      g.fillText(x.airportLabel.text, p.x + 10, p.y - 10);
    }
    // selected heading line
    const sel = (((fm.ap.hdgDeg - hdg + 540) % 360) - 180) * (Math.PI / 180);
    g.setLineDash([10, 8]);
    g.strokeStyle = CYAN;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.sin(sel) * R, cy - Math.cos(sel) * R);
    g.stroke();
    g.setLineDash([]);
    // track line
    const trk = (((fm.trackDeg - hdg + 540) % 360) - 180) * (Math.PI / 180);
    if (fm.groundSpeedKt > 30) {
      g.strokeStyle = GREEN;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.sin(trk) * R, cy - Math.cos(trk) * R);
      g.stroke();
    }
    g.restore();
    // compass arc
    g.strokeStyle = WHITE;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, R, Math.PI * 1.08, Math.PI * 1.92);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, R / 2, Math.PI * 1.08, Math.PI * 1.92);
    g.stroke();
    g.font = `18px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 5) {
      const rel = (((d - hdg + 540) % 360) - 180) * (Math.PI / 180);
      if (Math.abs(rel) > 0.9 * Math.PI / 2 + 0.25) continue;
      const big = d % 10 === 0;
      g.beginPath();
      g.moveTo(cx + Math.sin(rel) * R, cy - Math.cos(rel) * R);
      g.lineTo(cx + Math.sin(rel) * (R - (big ? 16 : 9)), cy - Math.cos(rel) * (R - (big ? 16 : 9)));
      g.stroke();
      if (d % 30 === 0) {
        g.fillStyle = WHITE;
        g.fillText(String(d / 10), cx + Math.sin(rel) * (R - 32), cy - Math.cos(rel) * (R - 32));
      }
    }
    g.fillStyle = YELLOW;
    g.fillRect(cx - 2, cy - R - 18, 4, 18);
    // aircraft symbol
    g.strokeStyle = YELLOW;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx, cy - 22);
    g.lineTo(cx, cy + 18);
    g.moveTo(cx - 20, cy - 4);
    g.lineTo(cx + 20, cy - 4);
    g.moveTo(cx - 8, cy + 14);
    g.lineTo(cx + 8, cy + 14);
    g.stroke();
    // data
    g.textAlign = 'left';
    g.font = `16px ${FONT}`;
    g.fillStyle = WHITE;
    g.fillText('GS', 12, 22);
    g.fillText('TAS', 92, 22);
    g.fillStyle = GREEN;
    g.fillText(String(Math.round(fm.groundSpeedKt)), 40, 22);
    g.fillText(String(Math.round(fm.tas / 0.514444)), 130, 22);
    g.fillStyle = CYAN;
    g.textAlign = 'right';
    g.fillText(`${rangeNm} NM`, 500, 22);
  }

  // ------------------------------------------------------------------ E/WD (engines + memo)
  private drawEwd(fm: FlightModel, x: InstrumentExtras): void {
    const g = this.ewd.ctx;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 512);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fm.n1.forEach((n1, i) => {
      const cx = 140 + i * 232;
      const cy = 120;
      g.strokeStyle = WHITE;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(cx, cy, 70, Math.PI * 0.75, Math.PI * 2.05);
      g.stroke();
      const a = Math.PI * 0.75 + (Math.PI * 1.3 * Math.min(n1, 1.04)) / 1.04;
      g.strokeStyle = GREEN;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * 64, cy + Math.sin(a) * 64);
      g.stroke();
      g.fillStyle = GREEN;
      g.font = `bold 26px ${FONT}`;
      g.fillText((n1 * 100).toFixed(1), cx + 18, cy + 40);
      g.strokeStyle = '#666';
      g.lineWidth = 1;
      g.strokeRect(cx - 30, cy + 26, 98, 30);
      const egt = Math.round(300 + n1 * 620 * (fm.enginesRunning ? 1 : 0));
      g.font = `20px ${FONT}`;
      g.fillText(String(egt), cx, cy + 100);
    });
    g.fillStyle = CYAN;
    g.font = `15px ${FONT}`;
    g.fillText('N1 %', 256, 108);
    g.fillText('EGT °C', 256, 220);
    g.fillText('FOB', 400, 270);
    g.fillStyle = GREEN;
    g.font = `bold 22px ${FONT}`;
    g.fillText(`${Math.round(fm.fuelKg)} KG`, 400, 296);
    // flaps
    g.fillStyle = WHITE;
    g.font = `16px ${FONT}`;
    g.fillText('FLAP', 150, 270);
    const names = ['UP', '1', '2', '3', 'FULL'];
    g.fillStyle = Math.abs(fm.flapPos - fm.flapIndex) > 0.02 ? CYAN : GREEN;
    g.font = `bold 22px ${FONT}`;
    g.fillText(names[fm.flapIndex] ?? '', 150, 296);
    g.strokeStyle = '#666';
    g.beginPath();
    g.moveTo(10, 330);
    g.lineTo(502, 330);
    g.stroke();
    // memo
    const memo: [string, string][] = [];
    if (fm.parkingBrake) memo.push(['PARK BRK', GREEN]);
    if (fm.spoilers > 0) memo.push(['SPEED BRK', GREEN]);
    if (x.doorOpen) memo.push(['CABIN DOOR L1 OPEN', AMBER]);
    if (!fm.enginesRunning) memo.push(['ENG 1+2 OFF', AMBER]);
    if (x.pushbackState) memo.push([x.pushbackState.toUpperCase(), CYAN]);
    if (fm.stallWarning) memo.push(['STALL', RED]);
    g.textAlign = 'left';
    g.font = `18px ${FONT}`;
    memo.slice(0, 6).forEach(([text, color], i) => {
      g.fillStyle = color;
      g.fillText(text, 24, 360 + i * 26);
    });
  }

  // ------------------------------------------------------------------ SD (wheel page)
  private drawSd(fm: FlightModel, x: InstrumentExtras): void {
    const g = this.sd.ctx;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = WHITE;
    g.font = `bold 20px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('WHEEL', 256, 26);
    const pos: [number, number][] = [[256, 140], [150, 280], [362, 280]];
    pos.forEach(([cx, cy], i) => {
      const down = fm.gearPos > 0.99;
      const up = fm.gearPos < 0.01;
      const col = down ? GREEN : up ? '#333' : RED;
      for (const dx of [-16, 16]) {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(cx + dx, cy - 16);
        g.lineTo(cx + dx - 14, cy + 12);
        g.lineTo(cx + dx + 14, cy + 12);
        g.fill();
      }
      const comp = fm.gearCompression[i] ?? 0;
      g.fillStyle = WHITE;
      g.font = `14px ${FONT}`;
      g.fillText(comp > 0.01 ? 'WOW' : '', cx, cy + 32);
    });
    g.font = `16px ${FONT}`;
    g.fillStyle = CYAN;
    g.fillText('BRAKES', 256, 380);
    g.fillStyle = fm.parkingBrake ? AMBER : GREEN;
    g.font = `bold 18px ${FONT}`;
    g.fillText(fm.parkingBrake ? 'PARKING BRAKE ON' : 'RELEASED', 256, 406);
    g.fillStyle = x.doorOpen ? AMBER : GREEN;
    g.fillText(x.doorOpen ? 'DOOR L1 OPEN' : 'DOORS CLOSED', 256, 450);
  }

  // ------------------------------------------------------------------ FCU
  private drawFcu(fm: FlightModel): void {
    const g = this.fcu.ctx;
    g.fillStyle = '#2b2f35';
    g.fillRect(0, 0, 1024, 112);
    const win = (x: number, label: string, value: string, active: boolean) => {
      g.fillStyle = '#0a0a0a';
      g.fillRect(x, 34, 190, 60);
      g.fillStyle = '#d8d8d8';
      g.font = `bold 18px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(label, x + 95, 20);
      g.fillStyle = active ? '#ffb347' : '#a86a1a';
      g.font = `bold 40px ${FONT}`;
      g.fillText(value, x + 95, 78);
    };
    win(30, 'SPD', String(Math.round(fm.ap.spdKt)), fm.ap.athr);
    win(240, 'HDG', String(Math.round(fm.ap.hdgDeg) % 360).padStart(3, '0'), fm.ap.ap);
    win(594, 'ALT', String(Math.round(fm.ap.altFt)), fm.ap.ap);
    win(804, 'V/S', (fm.ap.vsFpm >= 0 ? '+' : '') + String(Math.round(fm.ap.vsFpm)), fm.ap.ap && fm.ap.vmode === 'VS');
    const light = (x: number, text: string, on: boolean) => {
      g.fillStyle = '#16181b';
      g.fillRect(x, 30, 70, 64);
      g.fillStyle = on ? GREEN : '#2c2f33';
      g.fillRect(x + 20, 38, 30, 8);
      g.fillStyle = '#d8d8d8';
      g.font = `bold 16px ${FONT}`;
      g.fillText(text, x + 35, 76);
    };
    light(440, 'AP1', fm.ap.ap);
    light(514, 'A/THR', fm.ap.athr);
  }
}
