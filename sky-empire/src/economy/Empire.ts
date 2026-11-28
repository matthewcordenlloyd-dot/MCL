import E from '@data/economy/empire.json';
import HQ from '@data/economy/hq.json';
import ACH from '@data/economy/achievements.json';
import countries from '@data/world/countries.json';
import type { Command, EmpireState, EmpireView, GameState, HqDept, Opportunity } from './types';
import type { Sim } from './Sim';
import { AIRPORTS, TYPES, blockHours, distanceKm, refFares } from './Sim';

const DAY = 86_400_000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
type Result = { ok: boolean; msg: string; data?: unknown };
export const HQ_DEPTS = Object.keys(HQ.departments) as HqDept[];
const CONTINENT = countries as unknown as Record<string, [string, string]>;
const PEOPLE = E.richList.people as [string, string, number][];
const ACH_NAME: Record<string, string> = Object.fromEntries(ACH.list.map((a) => [a.id, a.name]));

/** Default values for M7 state so older saves keep loading. */
export function migrateEmpire(s: GameState): void {
  s.empire ??= {
    salaryUSDPerYear: E.ceoSalary.defaultUSDPerYear, cars: [], aircraft: [], yachts: [], properties: [], homeTier: 0, activeCar: null,
    hq: { tier: 0, depts: Object.fromEntries(HQ_DEPTS.map((d) => [d, 0])) as Record<HqDept, number> },
    achievements: {}, rich: PEOPLE.map((p) => p[2]), location: s.base, trips: 0,
  };
}

/**
 * The personal side of the game (M7): your salary and personal assets (cars, aircraft, yachts,
 * properties, your home), the rich list, the HQ departments that boost the airline, and achievements.
 */
export class Empire {
  constructor(private sim: Sim) {}

  private get s(): GameState {
    return this.sim.s;
  }

  private get e(): EmpireState {
    return this.sim.s.empire;
  }

  /** HQ department level (0..3). */
  lvl(d: HqDept): number {
    return this.e.hq.depts[d] ?? 0;
  }

  assetsValue(): number {
    const e = this.e;
    return e.cars.reduce((x, c) => x + c.valueUSD, 0) + e.aircraft.reduce((x, a) => x + a.valueUSD, 0) + e.yachts.reduce((x, y) => x + y.valueUSD, 0)
      + e.properties.reduce((x, p) => x + p.valueUSD, 0) + E.home[e.homeTier].valueUSD;
  }

  netWorth(): number {
    const c = this.sim.corp;
    const eq = this.s.equity;
    const stake = eq.playerShares / eq.shares;
    const stakeValue = stake * (eq.listed ? eq.shares * eq.price : c.equityValue());
    return this.s.personal.cashUSD + stakeValue + this.assetsValue();
  }

  upkeepMonth(): number {
    const e = this.e;
    let u = E.home[e.homeTier].upkeepMonthUSD;
    for (const c of e.cars) u += E.cars.find((x) => x.id === c.model)?.upkeepMonthUSD ?? 0;
    for (const a of e.aircraft) u += (TYPES[a.typeId]?.priceUSD ?? 0) * E.aircraft.upkeepShareYear / 12;
    for (const y of e.yachts) u += (E.yachts.find((x) => x.id === y.model)?.priceUSD ?? 0) * (E.yachts.find((x) => x.id === y.model)?.upkeepShareYear ?? 0.1) / 12;
    for (const p of e.properties) {
      const d = E.properties.find((x) => x.id === p.id);
      if (d) u += p.valueUSD * d.upkeepShareYear / 12;
    }
    return u;
  }

  hqMonth(): number {
    let m = HQ.tiers[this.e.hq.tier].monthUSD;
    for (const d of HQ_DEPTS) for (let i = 0; i < this.lvl(d); i++) m += HQ.levelMonthUSD[i];
    return m;
  }

  // ------------------------------------------------------------------ monthly
  monthEnd(): void {
    const s = this.s;
    const e = this.e;
    // CEO salary: an airline cost; you keep about 60% after tax
    const sal = e.salaryUSDPerYear / 12;
    if (sal > 0) {
      this.sim.book('salaries', sal);
      s.personal.cashUSD += sal * 0.6;
    }
    if (s.equity.listed && e.salaryUSDPerYear > E.ceoSalary.boardFrownsOverUSD) s.equity.confidence = clamp(s.equity.confidence - 0.02, 0, 1);
    // HQ running costs
    this.sim.book('overhead', this.hqMonth());
    // personal upkeep and asset values
    if (!this.sim.isSandbox()) s.personal.cashUSD -= this.upkeepMonth();
    if (s.personal.cashUSD < 0 && !this.sim.isSandbox()) this.sim.log('Your personal cash is negative: sell something or raise your dividend or salary.', 'warn');
    for (const c of e.cars) c.valueUSD *= 1 - (E.cars.find((x) => x.id === c.model)?.depreciation ?? 0.1) / 12;
    for (const a of e.aircraft) a.valueUSD *= 1 - E.aircraft.depreciation / 12;
    for (const y of e.yachts) y.valueUSD *= 1 - (E.yachts.find((x) => x.id === y.model)?.depreciation ?? 0.06) / 12;
    for (const p of e.properties) p.valueUSD *= 1 + ((E.properties.find((x) => x.id === p.id)?.appreciation ?? 0.03) / 12) * (0.6 + this.sim.rand() * 0.8);
    // the rich get richer (with noise)
    const g = E.richList.growthPerYear / 12;
    const v = E.richList.volatilityPerMonth;
    e.rich = e.rich.map((w) => Math.max(5e8, w * (1 + g + (this.sim.rand() * 2 - 1) * v)));
    this.checkAchievements();
  }

  // ------------------------------------------------------------------ achievements
  unlock(id: string): void {
    const e = this.e;
    if (e.achievements[id] || !ACH_NAME[id]) return;
    e.achievements[id] = this.s.time;
    this.sim.log(`Achievement unlocked: ${ACH_NAME[id]}`, 'achievement');
  }

  checkAchievements(): void {
    const s = this.s;
    const e = this.e;
    const snapRank = this.sim.rankNow();
    const fleet = s.fleet.filter((a) => a.status !== 'ordered').length;
    const nw = this.netWorth();
    const rr = this.richRank(nw);
    const cond: [string, boolean][] = [
      ['first_route', s.routes.length >= 1], ['ten_routes', s.routes.length >= 10], ['fifty_routes', s.routes.length >= 50],
      ['fleet_10', fleet >= 10], ['fleet_50', fleet >= 50], ['fleet_100', fleet >= 100],
      ['top_10', s.routes.length > 0 && snapRank <= 10], ['top_3', s.routes.length > 0 && snapRank <= 3], ['number_one', s.routes.length > 0 && snapRank === 1],
      ['ipo', s.equity.listed], ['takeover', Object.keys(s.holdings.owned).length > 0], ['alliance', (s.holdings.alliance?.members.length ?? 0) > 0],
      ['freighter', s.routes.some((r) => r.cargo && r.total.flights > 0)], ['pilot_25', s.playerFlights.count >= 25], ['butter', s.playerFlights.best >= -100 && s.playerFlights.count > 0],
      ['millionaire', nw >= 1e6], ['hundred_m', nw >= 1e8], ['billionaire', nw >= 1e9],
      ['richlist_100', rr <= 50], ['richlist_10', rr <= 10], ['richest', rr === 1],
      ['first_car', e.cars.length > 0], ['hypercar', e.cars.some((c) => c.model === 'hyper')], ['private_jet', e.aircraft.length > 0], ['yacht', e.yachts.length > 0],
      ['mega_mansion', e.homeTier >= E.home.length - 1],
      ['globetrotter', new Set(e.properties.map((p) => CONTINENT[AIRPORTS[E.properties.find((x) => x.id === p.id)?.icao ?? '']?.country ?? '']?.[1]).filter(Boolean)).size >= 3],
      ['tower', e.hq.tier >= HQ.tiers.length - 1], ['hq_complete', HQ_DEPTS.every((d) => this.lvl(d) >= 3)],
    ];
    for (const [id, ok] of cond) if (ok) this.unlock(id);
  }

  /** Your place on the rich list (51 = not on it). */
  richRank(nw = this.netWorth()): number {
    return this.e.rich.filter((w) => w > nw).length + 1;
  }

  // ------------------------------------------------------------------ network planning
  opportunities(): Opportunity[] {
    const s = this.s;
    const n = this.lvl('network');
    if (!n) return [];
    const count = (HQ.departments.network.perLevel.ideas as number[])[n - 1];
    const base = AIRPORTS[s.base];
    const served = new Set(s.routes.flatMap((r) => [r.a, r.b]));
    const t = TYPES.a320neo;
    const out: Opportunity[] = [];
    for (const a of Object.values(AIRPORTS)) {
      if (a.market < 1 || served.has(a.icao) || a.icao === s.base || a.runwayM < t.runwayM) continue;
      const km = distanceKm(base, a);
      if (km < 300 || km > t.rangeKm) continue;
      const f = refFares(km);
      const q = this.sim.quote(s.base, a.icao, t.id, 1, 14, f.y, f.j);
      if (q.ok) out.push({ icao: a.icao, km, weeklyProfit: q.weeklyProfit, loadFactor: q.expectedLoadFactor, marketWeekly: q.marketWeekly });
    }
    return out.sort((x, y) => y.weeklyProfit - x.weeklyProfit).slice(0, count);
  }

  /** Revenue management: grid-search fares that maximise weekly profit. */
  suggestFares(c: Extract<Command, { kind: 'suggestFares' }>): { fareY: number; fareJ: number; weeklyProfit: number } | null {
    if (!this.lvl('revenue')) return null;
    const A = AIRPORTS[c.a];
    const B = AIRPORTS[c.b];
    if (!A || !B) return null;
    const ref = refFares(distanceKm(A, B));
    let best = { fareY: ref.y, fareJ: ref.j, weeklyProfit: -Infinity };
    for (const my of [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35]) {
      for (const mj of [0.8, 1, 1.2, 1.4]) {
        const q = this.sim.quote(c.a, c.b, c.typeId, c.aircraftCount, c.weeklyFreq, ref.y * my, ref.j * mj, undefined, c.aircraftId);
        if (q.ok && q.weeklyProfit > best.weeklyProfit) best = { fareY: Math.round(ref.y * my), fareJ: Math.round(ref.j * mj), weeklyProfit: q.weeklyProfit };
      }
    }
    return Number.isFinite(best.weeklyProfit) ? best : null;
  }

  // ------------------------------------------------------------------ commands
  command(c: Command): Result | null {
    const s = this.s;
    const e = this.e;
    const sandbox = this.sim.isSandbox();
    const M = (usd: number) => (usd >= 1e9 ? `${(usd / 1e9).toFixed(2)}B` : `${(usd / 1e6).toFixed(1)}M`);
    const pay = (usd: number): boolean => {
      if (sandbox) return true;
      if (s.personal.cashUSD < usd) return false;
      s.personal.cashUSD -= usd;
      return true;
    };
    const sell = (usd: number) => {
      s.personal.cashUSD += usd;
    };
    const done = (msg: string): Result => {
      this.checkAchievements();
      return { ok: true, msg };
    };
    switch (c.kind) {
      case 'setSalary':
        e.salaryUSDPerYear = clamp(Math.round(c.usdPerYear), 0, E.ceoSalary.maxUSDPerYear);
        return { ok: true, msg: `Your salary: ${M(e.salaryUSDPerYear)} a year` };
      case 'buyCar': {
        const m = E.cars.find((x) => x.id === c.model);
        if (!m) return { ok: false, msg: 'Unknown car' };
        if (!pay(m.priceUSD)) return { ok: false, msg: `You need ${M(m.priceUSD)} of personal cash` };
        const id = this.sim.id('car');
        e.cars.push({ id, model: m.id, color: c.color, valueUSD: m.priceUSD, boughtAt: s.time });
        e.activeCar = id;
        this.sim.log(`You bought a ${m.name}.`, 'good');
        return done(`${m.name} delivered to your home`);
      }
      case 'sellCar': {
        const car = e.cars.find((x) => x.id === c.id);
        if (!car) return { ok: false, msg: 'No such car' };
        sell(car.valueUSD * 0.92);
        e.cars = e.cars.filter((x) => x !== car);
        if (e.activeCar === car.id) e.activeCar = e.cars[0]?.id ?? null;
        return { ok: true, msg: `Sold for ${M(car.valueUSD * 0.92)}` };
      }
      case 'paintCar': {
        const car = e.cars.find((x) => x.id === c.id);
        if (!car) return { ok: false, msg: 'No such car' };
        if (!pay(8000)) return { ok: false, msg: 'A respray costs 8k' };
        car.color = c.color;
        return { ok: true, msg: 'Resprayed' };
      }
      case 'setActiveCar':
        if (!e.cars.some((x) => x.id === c.id)) return { ok: false, msg: 'No such car' };
        e.activeCar = c.id;
        return { ok: true, msg: 'Your driver brings it round' };
      case 'buyPersonalAircraft': {
        const t = TYPES[c.typeId];
        if (!t || !(E.aircraft.types as string[]).includes(c.typeId)) return { ok: false, msg: 'Not available as a personal aircraft' };
        if (!pay(t.priceUSD)) return { ok: false, msg: `You need ${M(t.priceUSD)} of personal cash` };
        const n = e.aircraft.length;
        e.aircraft.push({ id: this.sim.id('pa'), typeId: t.id, reg: `G-${(s.airline.code || 'XX').slice(0, 2).toUpperCase()}P${String.fromCharCode(65 + (n % 26))}`, valueUSD: t.priceUSD, boughtAt: s.time });
        this.sim.log(`Your private ${t.name} is ready at ${AIRPORTS[s.base]?.iata}.`, 'good');
        return done(`${t.name} bought`);
      }
      case 'sellPersonalAircraft': {
        const a = e.aircraft.find((x) => x.id === c.id);
        if (!a) return { ok: false, msg: 'No such aircraft' };
        sell(a.valueUSD * 0.9);
        e.aircraft = e.aircraft.filter((x) => x !== a);
        return { ok: true, msg: `Sold for ${M(a.valueUSD * 0.9)}` };
      }
      case 'buyYacht': {
        const y = E.yachts.find((x) => x.id === c.model);
        if (!y) return { ok: false, msg: 'Unknown yacht' };
        if (!pay(y.priceUSD)) return { ok: false, msg: `You need ${M(y.priceUSD)} of personal cash` };
        e.yachts.push({ id: this.sim.id('yt'), model: y.id, name: c.name.trim().slice(0, 24) || 'Sea Empire', valueUSD: y.priceUSD });
        this.sim.log(`Your ${y.name} "${c.name}" has been delivered.`, 'good');
        return done('Yacht delivered');
      }
      case 'sellYacht': {
        const y = e.yachts.find((x) => x.id === c.id);
        if (!y) return { ok: false, msg: 'No such yacht' };
        sell(y.valueUSD * 0.88);
        e.yachts = e.yachts.filter((x) => x !== y);
        return { ok: true, msg: `Sold for ${M(y.valueUSD * 0.88)}` };
      }
      case 'buyProperty': {
        const p = E.properties.find((x) => x.id === c.id);
        if (!p || e.properties.some((x) => x.id === c.id)) return { ok: false, msg: 'Not available' };
        if (!pay(p.priceUSD)) return { ok: false, msg: `You need ${M(p.priceUSD)} of personal cash` };
        e.properties.push({ id: p.id, valueUSD: p.priceUSD, boughtAt: s.time });
        this.sim.log(`You bought: ${p.name}.`, 'good');
        return done('Keys handed over');
      }
      case 'sellProperty': {
        const p = e.properties.find((x) => x.id === c.id);
        if (!p) return { ok: false, msg: 'Not yours' };
        sell(p.valueUSD * 0.95);
        e.properties = e.properties.filter((x) => x !== p);
        return { ok: true, msg: `Sold for ${M(p.valueUSD * 0.95)}` };
      }
      case 'upgradeHome': {
        const next = E.home[e.homeTier + 1];
        if (!next) return { ok: false, msg: 'Already a mega-mansion' };
        // the old home is sold towards the new one
        const net = next.priceUSD - E.home[e.homeTier].valueUSD * 0.9;
        if (!pay(net)) return { ok: false, msg: `You need ${M(net)} of personal cash (after selling your current home)` };
        e.homeTier++;
        this.sim.log(`You moved into your new ${next.name.toLowerCase()} near ${AIRPORTS[s.base]?.city || s.base}.`, 'good');
        return done(`Welcome home: ${next.name}`);
      }
      case 'upgradeHqTier': {
        const next = HQ.tiers[e.hq.tier + 1];
        if (!next) return { ok: false, msg: 'Already a landmark tower' };
        if (!sandbox && s.cashUSD < next.priceUSD) return { ok: false, msg: `The airline needs ${M(next.priceUSD)} in cash` };
        const block = this.sim.corp.blocked(next.priceUSD);
        if (block) return { ok: false, msg: block };
        this.sim.book('investments', next.priceUSD);
        e.hq.tier++;
        this.sim.log(`New headquarters: ${next.name}.`, 'good');
        return done(next.name);
      }
      case 'upgradeDept': {
        const d = HQ.departments[c.dept];
        const l = this.lvl(c.dept);
        if (!d) return { ok: false, msg: 'Unknown department' };
        if (l >= 3) return { ok: false, msg: 'Already at the top level' };
        if (l + 1 > e.hq.tier + 1) return { ok: false, msg: `Level ${l + 1} needs a bigger HQ (${HQ.tiers[l].name})` };
        const cost = HQ.levelCostUSD[l];
        if (!sandbox && s.cashUSD < cost) return { ok: false, msg: `The airline needs ${M(cost)} in cash` };
        this.sim.book('investments', cost);
        e.hq.depts[c.dept] = l + 1;
        this.sim.log(`${d.name} upgraded to level ${l + 1}.`, 'good');
        return done(`${d.name}: level ${l + 1}`);
      }
      case 'travel': {
        const a = e.aircraft.find((x) => x.id === c.aircraftId);
        const to = AIRPORTS[c.icao];
        const from = AIRPORTS[e.location] ?? AIRPORTS[s.base];
        if (!a || !to) return { ok: false, msg: 'Pick one of your aircraft and a destination' };
        if (c.icao === e.location) return { ok: false, msg: 'You are already there' };
        const t = TYPES[a.typeId];
        const km = distanceKm(from, to);
        if (km > t.rangeKm) return { ok: false, msg: `Too far for the ${t.name} (${Math.round(km)} km, range ${t.rangeKm} km)` };
        if (to.runwayM < t.runwayM && t.role !== 'heli') return { ok: false, msg: 'The runway there is too short for it' };
        const h = blockHours(km, t);
        const fuel = h * ((E.aircraft.fuelUSDPerHour as Record<string, number>)[t.category] ?? 1600);
        if (!pay(fuel)) return { ok: false, msg: `The trip costs ${M(fuel)} in fuel and fees` };
        this.sim.step(h * 3_600_000);
        e.location = c.icao;
        e.trips++;
        return { ok: true, msg: `Landed at ${to.name} after ${h.toFixed(1)} hours`, data: { hours: h } };
      }
      case 'arrivePersonal': {
        // you flew your own jet there: fuel and fees from personal cash; the clock already moved with you
        const a = e.aircraft.find((x) => x.id === c.aircraftId);
        const A = AIRPORTS[c.fromIcao];
        const B = AIRPORTS[c.icao];
        if (!a || !A || !B) return { ok: false, msg: 'Unknown trip' };
        const t = TYPES[a.typeId];
        const fuel = blockHours(distanceKm(A, B), t) * ((E.aircraft.fuelUSDPerHour as Record<string, number>)[t.category] ?? 1600);
        if (!sandbox) s.personal.cashUSD -= fuel;
        e.location = c.icao;
        e.trips++;
        this.sim.log(`You flew your ${t.name} to ${B.name} yourself.`, 'good');
        return { ok: true, msg: `Welcome to ${B.city || B.name}`, data: { fuel } };
      }
      case 'arriveHome':
        e.location = s.base;
        return { ok: true, msg: '' };
      case 'opportunities':
        return { ok: true, msg: '', data: this.opportunities() };
      case 'suggestFares': {
        const r = this.suggestFares(c);
        return r ? { ok: true, msg: '', data: r } : { ok: false, msg: 'Needs Revenue Management (HQ)' };
      }
    }
    return null;
  }

  view(): EmpireView {
    const nw = this.netWorth();
    const rank = this.richRank(nw);
    const list = PEOPLE.map(([name, field], i) => ({ name, field, worthUSD: this.e.rich[i] }));
    list.push({ name: 'You', field: this.s.airline.name, worthUSD: nw, you: true } as (typeof list)[number] & { you: boolean });
    list.sort((a, b) => b.worthUSD - a.worthUSD);
    return { state: this.e, assetsValueUSD: this.assetsValue(), netWorthUSD: nw, upkeepMonthUSD: this.upkeepMonth(), hqMonthUSD: this.hqMonth(), richRank: rank, richList: list };
  }
}

export { DAY };
