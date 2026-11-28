import type { FlightModel } from '../flight/FlightModel';
import type { IlsState } from '../flight/Approach';

/**
 * Simple flight HUD (H): artificial horizon, speed / altitude / vertical speed / heading,
 * engine and configuration state, autopilot modes, warnings.
 */
export class FlightHud {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  visible = true;
  private last = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'flighthud';
    this.canvas.width = 900;
    this.canvas.height = 190;
    document.body.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
  }

  show(on: boolean): void {
    this.canvas.style.display = on ? 'block' : 'none';
  }

  draw(fm: FlightModel, t: number, extra: { view: string; state: string; throttle: number; ils?: IlsState | null }): void {
    if (t - this.last < 1 / 30) return;
    this.last = t;
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,13,24,0.62)';
    g.beginPath();
    g.roundRect(0, 0, W, H, 16);
    g.fill();

    // horizon
    const cx = 95;
    const cy = 95;
    const r = 78;
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate((-fm.bankDeg * Math.PI) / 180);
    g.translate(0, fm.pitchDeg * 3.2);
    g.fillStyle = '#2c79d6';
    g.fillRect(-200, -400, 400, 400);
    g.fillStyle = '#7a5129';
    g.fillRect(-200, 0, 400, 400);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    for (let p = -30; p <= 30; p += 10) {
      if (!p) continue;
      g.beginPath();
      g.moveTo(-22, -p * 3.2);
      g.lineTo(22, -p * 3.2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-200, 0);
    g.lineTo(200, 0);
    g.stroke();
    g.restore();
    // ILS deviation on the horizon: glideslope on the right edge, localiser along the bottom
    const ils = extra.ils;
    if (ils) {
      g.fillStyle = '#ff4fd8';
      const dia = (x: number, y: number) => {
        g.beginPath();
        g.moveTo(x, y - 6);
        g.lineTo(x + 5, y);
        g.lineTo(x, y + 6);
        g.lineTo(x - 5, y);
        g.closePath();
        g.fill();
      };
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      for (let i = -2; i <= 2; i++) {
        if (!i) continue;
        g.strokeRect(cx + r - 14 - 2, cy + i * 18 - 2, 4, 4);
        g.strokeRect(cx + i * 18 - 2, cy + r - 14 - 2, 4, 4);
      }
      dia(cx + r - 14, cy - ils.gs * 18);
      dia(cx + ils.loc * 18, cy + r - 14);
      g.font = 'bold 12px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText(`ILS ${ils.ident} · ${ils.distNm.toFixed(1)} NM`, cx, cy - r + 16);
    }
    g.strokeStyle = '#ffe14d';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 40, cy);
    g.lineTo(cx - 12, cy);
    g.moveTo(cx + 12, cy);
    g.lineTo(cx + 40, cy);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();

    // big numbers
    const cell = (x: number, label: string, value: string, color = '#e6edf7', sub = '') => {
      g.fillStyle = '#8da0bb';
      g.font = '600 12px Segoe UI, sans-serif';
      g.textAlign = 'left';
      g.fillText(label, x, 30);
      g.fillStyle = color;
      g.font = '600 30px Segoe UI, sans-serif';
      g.fillText(value, x, 64);
      if (sub) {
        g.fillStyle = '#8da0bb';
        g.font = '12px Segoe UI, sans-serif';
        g.fillText(sub, x, 84);
      }
    };
    const vs = fm.vsFpm;
    const stall = fm.stallSpeedKt();
    cell(200, 'IAS KT', String(Math.round(fm.iasKt)), fm.iasKt < stall * 1.1 && !fm.onGround ? '#f2b84b' : '#e6edf7', `GS ${Math.round(fm.groundSpeedKt)} · M ${fm.mach.toFixed(2)}`);
    cell(330, 'ALT FT', String(Math.round(fm.altFt)), '#e6edf7', fm.ap.ap ? `SEL ${fm.ap.altFt}` : '');
    cell(460, 'V/S FPM', `${vs >= 0 ? '+' : ''}${Math.round(vs / 10) * 10}`, Math.abs(vs) > 3000 ? '#f2b84b' : '#e6edf7');
    cell(590, 'HDG', String(Math.round(fm.headingDeg) % 360).padStart(3, '0') + '°', '#e6edf7', fm.ap.ap ? `SEL ${String(Math.round(fm.ap.hdgDeg)).padStart(3, '0')}` : '');
    cell(710, 'THRUST', `${Math.round(extra.throttle * 100)}%`, '#e6edf7', `N1 ${Math.round(fm.n1[0] * 100)} / ${Math.round(fm.n1[1] * 100)}`);

    // status line
    const flap = fm.d.flaps[fm.flapIndex]?.name ?? '';
    const tags: [string, string][] = [
      [`FLAPS ${flap}`, '#e6edf7'],
      [fm.gearPos > 0.99 ? 'GEAR DOWN' : fm.gearPos < 0.01 ? 'GEAR UP' : 'GEAR TRANSIT', fm.gearPos > 0.99 ? '#3ccf8e' : fm.gearPos < 0.01 ? '#8da0bb' : '#f2b84b'],
      [fm.parkingBrake ? 'PARK BRAKE' : '', '#f2b84b'],
      [fm.spoilers ? 'SPOILERS' : '', '#e6edf7'],
      [fm.ap.ap ? `AP ${fm.ap.vmode} HDG` : '', '#3ccf8e'],
      [fm.ap.athr ? `A/THR ${fm.ap.spdKt}` : '', '#3ccf8e'],
      [fm.profile === 'arcade' ? 'ARCADE' : fm.protections ? 'REALISTIC · NORMAL LAW' : 'REALISTIC · DIRECT LAW', '#3d7bf5'],
      [extra.state, '#e0a526'],
    ];
    g.font = '600 13px Segoe UI, sans-serif';
    let x = 200;
    for (const [text, color] of tags) {
      if (!text) continue;
      const w = g.measureText(text).width + 16;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.beginPath();
      g.roundRect(x, 110, w, 24, 6);
      g.fill();
      g.fillStyle = color;
      g.fillText(text, x + 8, 127);
      x += w + 6;
    }
    // warnings / landing rate
    g.font = '700 18px Segoe UI, sans-serif';
    if (fm.stallWarning && Math.floor(t * 3) % 2 === 0) {
      g.fillStyle = '#f2555a';
      g.fillText('STALL', 200, 170);
    } else if (fm.onGround && fm.touchdownFpm < -10) {
      const f = Math.round(fm.touchdownFpm);
      g.fillStyle = f > -240 ? '#3ccf8e' : f > -600 ? '#f2b84b' : '#f2555a';
      g.fillText(`Touchdown ${f} fpm${f > -150 ? ' · butter!' : ''}`, 200, 170);
    }
    g.fillStyle = '#8da0bb';
    g.font = '12px Segoe UI, sans-serif';
    g.textAlign = 'right';
    g.fillText(`${extra.view.toUpperCase()} VIEW · C camera · H hud`, W - 16, 170);
  }
}
