import type { FlightModel } from './FlightModel';
import type { IlsState } from './Approach';

export interface AtcContext {
  fm: FlightModel;
  groundState: string; // PlayerAircraft.state
  aglFt: number;
  onRunway: string | null; // runway end you are lined up on
  ils: IlsState | null;
  airport: string; // e.g. "Gatwick"
  windDir: number;
  windKt: number;
  qnh: number;
  landed: boolean;
}

const DIGITS = ['zero', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];
/** "26L" -> "two six left" */
export function sayRunway(id: string): string {
  const num = id.replace(/[LCR]$/, '');
  const side = { L: ' left', R: ' right', C: ' centre' }[id.slice(num.length)] ?? '';
  return num.split('').map((d) => DIGITS[+d] ?? d).join(' ') + side;
}
const sayNum = (n: number | string) => String(n).split('').map((d) => DIGITS[+d] ?? d).join(' ');

/**
 * Air traffic control for your flights: pushback, taxi, take-off clearance, handoff, approach
 * and landing clearances, vacate. Messages appear in the radio box and are spoken.
 */
export class Atc {
  readonly callsign: string;
  private spoken: string;
  private done = new Set<string>();
  readonly log: { from: 'atc' | 'ai'; text: string; t: number }[] = [];

  constructor(airlineName: string, code: string, private say: (text: string, who: 'atc' | 'ai') => void) {
    const n = 100 + Math.floor(Math.random() * 899);
    this.callsign = `${code.toUpperCase()}${n}`;
    const tel = airlineName.split(/\s+/).slice(0, 2).join(' ');
    this.spoken = `${tel} ${sayNum(n)}`;
  }

  reset(): void {
    this.done.clear();
  }

  private send(key: string, text: string, speech: string): void {
    if (this.done.has(key)) return;
    this.done.add(key);
    this.push('atc', `${this.callsign}, ${text}`);
    this.say(`${this.spoken}, ${speech}`, 'atc');
  }

  push(from: 'atc' | 'ai', text: string): void {
    this.log.unshift({ from, text, t: performance.now() });
    this.log.length = Math.min(this.log.length, 4);
  }

  /** Other traffic on frequency (AI aircraft), only spoken when you are around. */
  traffic(text: string, speech: string): void {
    this.push('ai', text);
    this.say(speech, 'ai');
  }

  update(c: AtcContext): void {
    const fm = c.fm;
    const wind = `${String(Math.round(c.windDir / 10) * 10).padStart(3, '0')} at ${c.windKt}`;
    const windSpoken = `wind ${sayNum(String(Math.round(c.windDir / 10) * 10).padStart(3, '0'))} degrees, ${c.windKt} knots`;
    if (c.groundState === 'closing' || c.groundState === 'pushing') {
      this.send('push', `${c.airport} Ground, push and start approved.`, `${c.airport} Ground, push and start approved`);
    }
    if (fm.onGround && !c.landed && fm.groundSpeedKt > 6 && !c.onRunway && this.done.has('push')) {
      this.send('taxi', 'taxi to the holding point via J. Report ready.', 'taxi to the holding point via juliet, report ready');
    }
    if (fm.onGround && !c.landed && c.onRunway && fm.groundSpeedKt < 40) {
      this.send('takeoff', `wind ${wind}, runway ${c.onRunway} cleared for take-off.`, `${windSpoken}, runway ${sayRunway(c.onRunway)}, cleared for take-off`);
    }
    if (!fm.onGround && !c.landed && c.aglFt > 1500 && this.done.has('takeoff') && !c.ils) {
      this.send('handoff', 'contact London Control. Good day.', 'contact London Control, good day');
    }
    if (!fm.onGround && c.ils && c.ils.distNm < 20 && c.ils.distNm > 5 && c.aglFt > 800) {
      this.send('approach', `descend altitude 3000 ft, QNH ${c.qnh}, cleared ILS approach runway ${c.ils.ident}.`, `descend altitude three thousand feet, Q N H ${sayNum(c.qnh)}, cleared I L S approach runway ${sayRunway(c.ils.ident)}`);
    }
    if (!fm.onGround && c.ils && c.ils.distNm < 5) {
      this.send('land', `wind ${wind}, runway ${c.ils.ident} cleared to land.`, `${windSpoken}, runway ${sayRunway(c.ils.ident)}, cleared to land`);
    }
    if (c.landed && fm.onGround && fm.groundSpeedKt < 50 && this.done.has('land')) {
      this.send('vacate', `vacate when able, contact Ground. Welcome to ${c.airport}.`, `vacate when able, contact ground. Welcome to ${c.airport}`);
    }
  }
}
