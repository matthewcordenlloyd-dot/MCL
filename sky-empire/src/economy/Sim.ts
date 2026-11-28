import airportsData from '@data/world/airports.json';
import markets from '@data/economy/markets.json';
import catalog from '@data/economy/aircraft_catalog.json';
import econ from '@data/economy/economy.json';
import dmg from '@data/damage.json';
import difficulty from '@data/economy/difficulty.json';
import fx from '@data/fx_fallback.json';
import rivalsData from '@data/economy/rivals.json';
import eventsData from '@data/economy/events.json';
import countries from '@data/world/countries.json';
import type {
  ActiveEvent, AircraftType, AirportInfo, Command, Competitor, Dept, FleetAircraft, GameState, LedgerCategory, NewGameParams, Rival, Route, RouteQuote, RouteStats, Snapshot, StaffDept, UsedListing,
} from './types';
import { cabinStats, defaultCabin } from './cabin';
import { Corporate, OPCOST_CATS, REVENUE_CATS, migrateCorporate } from './Corporate';
import { Empire, migrateEmpire } from './Empire';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const KT_TO_KMH = 1.852;

// ------------------------------------------------------------------ static data
export const TYPES: Record<string, AircraftType> = Object.fromEntries((catalog.types as AircraftType[]).map((t) => [t.id, t]));

function buildAirports(): Record<string, AirportInfo> {
  const gdp = markets.countryGdpPerCapitaUSD as Record<string, number>;
  const metroByIata = new Map<string, { share: number; pop: number; gdp: number; tourism: number }>();
  for (const [, ap, pop, g, tourism] of markets.metros as [string, Record<string, number>, number, number, number][]) {
    for (const [iata, share] of Object.entries(ap)) metroByIata.set(iata, { share, pop, gdp: g, tourism });
  }
  const D = econ.demand;
  const out: Record<string, AirportInfo> = {};
  for (const r of airportsData.rows as unknown as [string, string, string, string, string, number, number, number, number, number, number][]) {
    const [icao, iata, name, city, country, lat, lon, elevFt, type, runwayM, sched] = r;
    const metro = iata ? metroByIata.get(iata) : undefined;
    let market: number;
    let tourism = 1;
    if (metro) {
      market = metro.pop * metro.share * Math.pow(metro.gdp / D.gdpReference, D.gdpExp);
      tourism = metro.tourism;
    } else {
      const g = gdp[country] ?? 8000;
      const base = type === 0 ? D.unlistedLargeAirportMarket : D.unlistedMediumAirportMarket;
      // income helps, but small rich-country airports must not outgrow real hubs
      market = base * (sched ? 1 : 0.4) * Math.pow(Math.min(g, 45000) / D.gdpReference, D.gdpExp * 0.6);
    }
    out[icao] = { icao, iata, name, city, country, lat, lon, type, runwayM, market, tourism, elevFt };
  }
  return out;
}
export const AIRPORTS = buildAirports();

export function distanceKm(a: AirportInfo, b: AirportInfo): number {
  const R = 6371;
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function refFares(km: number): { y: number; j: number } {
  const F = econ.fares;
  const y = F.base + F.perKm * Math.min(km, F.longHaulKm) + F.perKmLong * Math.max(0, km - F.longHaulKm);
  return { y: Math.round(y), j: Math.round(y * F.businessMultiplier) };
}

export function marketWeekly(a: AirportInfo, b: AirportInfo): number {
  const D = econ.demand;
  const km = Math.max(distanceKm(a, b), D.minDistanceKm);
  let d = (D.k * Math.pow(a.market * b.market, D.massExp) * Math.pow(a.tourism * b.tourism, D.tourismExp)) / Math.pow(km, D.distExp);
  if (km < D.shortHaulKm) d *= km / D.shortHaulKm;
  return d;
}

function slotPrice(icao: string): number | null {
  const a = (econ.airports as Record<string, unknown>)[icao] as { slotPairUSD?: number } | undefined;
  return a?.slotPairUSD ?? null;
}

function feeMult(icao: string): number {
  const a = (econ.airports as Record<string, unknown>)[icao] as { feeMultiplier?: number } | undefined;
  if (a?.feeMultiplier) return a.feeMultiplier;
  return AIRPORTS[icao]?.type === 0 ? econ.airports.defaultLarge : econ.airports.defaultMedium;
}

/** Passengers avoid narrow cabins on long flights. */
export function cabinFit(t: AircraftType, km: number): number {
  const N = econ.demand.narrowbodyLongHaul;
  if (t.category === 'widebody' || t.category === 'jumbo' || t.role !== 'airliner') return 1;
  return 1 - N.maxPenalty * Math.max(0, Math.min(1, (km - N.fromKm) / N.overKm));
}

export function blockHours(km: number, t: AircraftType): number {
  return km / (t.cruiseKt * KT_TO_KMH) + econ.costs.taxiAndClimbHours;
}

const CONTINENT = countries as unknown as Record<string, [string, string]>;
export const inEurope = (icao: string) => CONTINENT[AIRPORTS[icao]?.country ?? '']?.[1] === 'EU';
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const DEPTS: Dept[] = ['pilots', 'cabin', 'engineers', 'ground', 'hq'];
type RivalModel = { fareFactor: number; shortShare: number; minKm: number; maxKm: number; freqShort: number; freqLong: number; seats: number; touristOnly?: boolean };
const MODELS = rivalsData.models as Record<string, RivalModel>;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Default values for state added after M3, so older saves keep loading. */
/** Custom aircraft designed in-game join the catalogue (worker and main thread). */
export function registerCustomTypes(list: AircraftType[]): void {
  for (const t of list) TYPES[t.id] = t;
}

/** Seats per class and comfort of one aircraft (its own cabin, or the type's default). */
export function seatsOf(t: AircraftType, ac?: FleetAircraft): { j: number; w: number; y: number; total: number; comfort: number } {
  const st = cabinStats(t, ac?.cabin ?? defaultCabin(t));
  return { j: st.j, w: st.w, y: st.y, total: st.total, comfort: st.comfort };
}

/** Premium economy takes a slice of economy demand, depending on its price. */
function splitPremium(yDemand: number, wSeats: number, fareW: number, refY: number): { w: number; y: number } {
  if (wSeats <= 0) return { w: 0, y: yDemand };
  const want = yDemand * 0.12 * Math.pow(Math.max(fareW, 1) / (refY * 1.6), -1.2);
  const w = Math.min(wSeats, want);
  return { w, y: yDemand - w * 0.85 };
}

function migrate(s: GameState): void {
  s.rivals ??= [];
  s.fuelPrice ??= econ.fuel.meanUSDPerKg;
  s.fuelHistory ??= [];
  s.events ??= [];
  s.staff ??= Object.fromEntries(DEPTS.map((d) => [d, { pay: 1, staffing: 1, morale: 0.7, headcount: 0, required: 0 }])) as Record<Dept, StaffDept>;
  s.reputation ??= econ.reputation.start;
  s.drivers ??= { punctuality: 0.8, service: 0.6, comfort: 0.6, value: 0.6, safety: 0.9 };
  s.monthOps ??= { flights: 0, delayed: 0, cancelled: 0, landingsHard: 0 };
  s.reviews ??= [];
  s.lastDay ??= new Date(s.time).toISOString().slice(0, 10);
  s.playerFlights ??= { count: 0, best: -9999 };
  s.customTypes ??= [];
  s.player ??= { character: { height: 1, build: 1, head: 1, skin: '#c9956f', hair: '#3b2a1e', hairStyle: 'short', outfit: 'pilot', cap: false } };
  for (const r of s.routes) r.fareW ??= Math.round(r.fareY * 1.6);
  migrateCorporate(s);
  migrateEmpire(s);
  s.version = 4;
}

const INCOME = new Set<LedgerCategory>(['ticketRevenue', 'otherRevenue', 'aircraftSales', 'cargoRevenue', 'charterRevenue', 'assetIncome', 'investmentIncome', 'subsidiaryIncome', 'loanIn', 'equityIn', 'divestments']);

const emptyStats = (): RouteStats => ({ flights: 0, paxY: 0, paxJ: 0, seats: 0, revenue: 0, cost: 0 });

/**
 * The airline business simulation. Runs inside a Web Worker (see sim.worker.ts),
 * completely independent of rendering, so the airline keeps flying while you walk or fly.
 */
export class Sim {
  s: GameState;
  private events: ((text: string, level: GameState['log'][number]['level']) => void) | null = null;
  private pendingComp = false;

  /** pair "A|B" -> rival routes serving it (rebuilt from state, not saved) */
  private pairs = new Map<string, { r: Rival; rt: Rival['routes'][number] }[]>();

  /** loans, shares, takeovers, assets, cargo, charters, strikes (M6) */
  readonly corp: Corporate;
  /** personal empire, HQ and achievements (M7) */
  readonly empire: Empire;

  constructor(state: GameState) {
    this.s = state;
    migrate(state);
    this.corp = new Corporate(this);
    this.empire = new Empire(this);
    registerCustomTypes(state.customTypes);
    if (!state.rivals.length) this.initRivals();
    this.indexRivals();
    this.updateStaffing();
  }

  onEvent(cb: (text: string, level: GameState['log'][number]['level']) => void): void {
    this.events = cb;
  }

  // ------------------------------------------------------------------ new game
  static create(p: NewGameParams): Sim {
    const pkg = (difficulty as unknown as Record<string, { cashGBP: number; base: string; fleet: { type: string; how: string; count: number }[]; slots: Record<string, number> }>)[p.difficulty];
    const start = Date.parse(econ.startDate);
    const s: GameState = {
      version: 1,
      airline: { name: p.airlineName, code: p.code, primary: p.primary, accent: p.accent, currency: p.currency },
      difficulty: p.difficulty,
      base: pkg.base,
      time: start,
      startTime: start,
      speed: 1,
      cashUSD: pkg.cashGBP / (p.gbpPerUsd ?? fx.rates.GBP),
      fleet: [],
      routes: [],
      slots: { ...pkg.slots },
      used: [],
      usedRefreshAt: 0,
      ledger: {},
      depreciation: {},
      history: [],
      seed: p.seed ?? (Math.random() * 2 ** 31) | 0,
      nextId: 1,
      regSeq: 0,
      lastMonth: new Date(start).toISOString().slice(0, 7),
      negativeSince: null,
      bankrupt: false,
      log: [],
    } as unknown as GameState;
    const sim = new Sim(s);
    for (const f of pkg.fleet) {
      for (let i = 0; i < f.count; i++) {
        const a = sim.makeAircraft(f.type, f.how === 'own' ? 'owned' : 'leased', 0, 1, s.base);
        a.status = 'idle';
        a.deliveryAt = start;
        s.fleet.push(a);
      }
    }
    sim.refreshUsed();
    sim.log(`${p.airlineName} founded at ${AIRPORTS[s.base]?.name ?? s.base}.`, 'good');
    return sim;
  }

  // ------------------------------------------------------------------ rivals
  /** Builds each rival's starting network from its hubs and the demand model (resembles, does not copy, real schedules). */
  private initRivals(): void {
    const cands = Object.values(AIRPORTS).filter((a) => a.market > 0.35);
    const fictional = rivalsData.fictionalNames;
    for (const d of rivalsData.airlines) {
      const m = MODELS[d.model];
      const routes: Rival['routes'] = [];
      const taken = new Set<string>();
      const perHub = Math.ceil(d.routes / d.hubs.length);
      for (const hubCode of d.hubs) {
        const hub = AIRPORTS[hubCode];
        if (!hub) continue;
        const scored = cands
          .filter((c) => c.icao !== hubCode)
          .map((c) => {
            const km = distanceKm(hub, c);
            return { c, km, score: km >= m.minKm && km <= m.maxKm && (!m.touristOnly || c.tourism >= 1.4) ? marketWeekly(hub, c) * (0.7 + this.rand() * 0.6) : 0 };
          })
          .filter((x) => x.score > 0);
        const short = scored.filter((x) => x.km < 3000).sort((a, b) => b.score - a.score);
        const long = scored.filter((x) => x.km >= 3000).sort((a, b) => b.score - a.score);
        const nShort = Math.round(perHub * m.shortShare);
        const picks = [...short.slice(0, nShort), ...long.slice(0, perHub - nShort)];
        for (const p of picks) {
          const key = pairKey(hubCode, p.c.icao);
          if (taken.has(key)) continue;
          taken.add(key);
          const base = p.km < 3000 ? m.freqShort : m.freqLong;
          const freq = Math.max(3, Math.round(base * clamp(Math.sqrt(p.score / 30000), 0.3, 2.0)));
          routes.push({ a: hubCode, b: p.c.icao, freq, fare: m.fareFactor * (0.95 + this.rand() * 0.1) });
        }
      }
      this.s.rivals.push({
        id: d.id, name: fictional ? d.alias : d.name, colors: d.colors as [string, string], model: d.model,
        quality: d.quality, aggression: d.aggression, hubs: d.hubs, seats: m.seats, routes,
      });
    }
  }

  reindexRivals(): void {
    this.indexRivals();
  }

  private indexRivals(): void {
    this.pairs.clear();
    for (const r of this.s.rivals) {
      for (const rt of r.routes) {
        const k = pairKey(rt.a, rt.b);
        if (!this.pairs.has(k)) this.pairs.set(k, []);
        this.pairs.get(k)!.push({ r, rt });
      }
    }
  }

  /** Demand multiplier from active events (downturns, tourism booms). */
  private demandMult(a: string, b: string): number {
    let m = 1;
    for (const e of this.s.events) {
      if (e.demandMult === 1) continue;
      if (e.scope === 'all') m *= e.demandMult;
      else if (e.scope === 'region' && (AIRPORTS[a]?.country === e.country || AIRPORTS[b]?.country === e.country)) m *= e.demandMult;
    }
    return m;
  }

  /** Quality the market sees for the player: reputation, lifted or dragged by cabin service. */
  private playerQuality(): number {
    const svc = this.s.drivers.service;
    return clamp(this.s.reputation / 100 + (svc - 0.6) * 0.15, 0.05, 0.98);
  }

  // ------------------------------------------------------------------ helpers
  rand(): number {
    // mulberry32, deterministic per save
    let t = (this.s.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  id(prefix: string): string {
    return `${prefix}${this.s.nextId++}`;
  }

  private nextReg(): string {
    const n = this.s.regSeq++;
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const code = (this.s.airline.code || 'SE').toUpperCase().slice(0, 1);
    return `${econ.registrationPrefix}${code}${L[Math.floor(n / 676) % 26]}${L[Math.floor(n / 26) % 26]}${L[n % 26]}`;
  }

  month(t = this.s.time): string {
    return new Date(t).toISOString().slice(0, 7);
  }

  book(cat: LedgerCategory, usd: number): void {
    const m = this.month();
    const L = (this.s.ledger[m] ??= {});
    L[cat] = (L[cat] ?? 0) + usd;
    const income = INCOME.has(cat);
    this.s.cashUSD += income ? usd : -usd;
  }

  log(text: string, level: GameState['log'][number]['level'] = 'info'): void {
    this.s.log.unshift({ t: this.s.time, text, level });
    if (this.s.log.length > 120) this.s.log.length = 120;
    this.events?.(text, level);
  }

  makeAircraft(typeId: string, ownership: 'owned' | 'leased', age: number, condition: number, location: string, price?: number): FleetAircraft {
    const t = TYPES[typeId];
    return {
      id: this.id('ac'),
      typeId,
      reg: this.nextReg(),
      ownership,
      ageYears: age,
      condition,
      bookValueUSD: ownership === 'owned' ? (price ?? t.priceUSD) : 0,
      leaseMonthUSD: ownership === 'leased' ? Math.round(t.leaseMonthUSD * (1 - Math.min(age, 20) * 0.03)) : 0,
      leaseStart: this.s.time,
      deliveryAt: this.s.time,
      balanceDueUSD: 0,
      location,
      routeId: null,
      status: 'idle',
      hours: age * 3000,
      hoursSinceCheck: 0,
      cycles: 0,
      phase: 'wait',
      nextAt: 0,
      periodStart: 0,
      flightFrom: location,
      flightTo: location,
      flightDep: 0,
      flightArr: 0,
    };
  }

  isSandbox(): boolean {
    return this.s.difficulty === 'sandbox';
  }

  slotsUsed(): Record<string, number> {
    const used: Record<string, number> = {};
    for (const r of this.s.routes) {
      const daily = Math.ceil(r.weeklyFreq / 7);
      for (const ap of [r.a, r.b]) if (slotPrice(ap) !== null) used[ap] = (used[ap] ?? 0) + daily;
    }
    return used;
  }

  // ------------------------------------------------------------------ demand & economics
  /** Weekly passengers wanting the player's flights in one direction, per cabin. */
  playerDemand(a: AirportInfo, b: AirportInfo, weeklySeats: number, fareY: number, fareJ: number): { y: number; j: number; market: number; competitors: Competitor[]; share: number } {
    const D = econ.demand;
    const S = econ.share;
    const market = marketWeekly(a, b) * this.demandMult(a.icao, b.icao) * this.corp.demandBoost(a.icao, b.icao);
    const ref = refFares(distanceKm(a, b));
    const qw = (q: number) => Math.exp(S.qualityWeight * (q - 0.5));
    // competition: modelled rivals on this pair plus unmodelled "other airlines"
    const compSeatsTotal = (market * D.competitorShareOfMarket) / 0.8;
    const rivals = this.pairs.get(pairKey(a.icao, b.icao)) ?? [];
    let rivalSeats = 0;
    let wRivals = 0;
    let fareMix = 0;
    const comps: Competitor[] = [];
    for (const { r, rt } of rivals) {
      const cw = this.corp.rivalWeight(r.id);
      if (cw === 0) continue;
      const seats = rt.freq * r.seats * cw;
      rivalSeats += seats;
      const w = seats * qw(r.quality) * Math.pow(rt.fare, -S.fareElasticity);
      wRivals += w;
      fareMix += w * rt.fare;
      comps.push({ id: r.id, name: r.name, color: r.colors[0], freq: rt.freq, fare: rt.fare, share: w });
    }
    const otherSeats = Math.max(compSeatsTotal * S.othersMinShareOfCompetition, compSeatsTotal - rivalSeats);
    const pq = qw(this.playerQuality());
    const wY = weeklySeats * pq * Math.pow(Math.max(fareY, 1) / ref.y, -D.elasticityEconomy);
    const wJ = weeklySeats * pq * Math.pow(Math.max(fareJ, 1) / ref.j, -D.elasticityBusiness);
    const total = wY + wRivals + otherSeats;
    const shareY = wY / total;
    const shareJ = wJ / (wJ + wRivals + otherSeats);
    // cheaper average fares grow the whole market a little
    const avgFare = (wY * (fareY / ref.y) + fareMix + otherSeats) / total;
    const grow = Math.pow(avgFare, -0.4);
    for (const c of comps) c.share /= total;
    comps.sort((x, y) => y.share - x.share);
    return { y: market * grow * (1 - D.businessShare) * shareY, j: market * grow * D.businessShare * shareJ * this.corp.jBoost(a.icao, b.icao), market, competitors: comps, share: shareY };
  }

  flightCost(t: AircraftType, km: number, from: string, to: string, paxTotal: number, ac?: FleetAircraft): Record<string, number> {
    const C = econ.costs;
    const bh = blockHours(km, t);
    const pilots = C.pilotPairPerBlockHr * (bh > C.extraPilotOverHours ? 1.5 : 1);
    const ageF = 1 + (ac?.ageYears ?? 0) * C.maintAgeFactorPerYear;
    return {
      fuel: t.fuelKgPerHr * bh * (this.s.fuelPrice ?? C.fuelUSDPerKg),
      crew: (pilots + t.cabinCrew * C.cabinCrewPerBlockHr) * bh * (1 - 0.03 * this.empire.lvl('training')),
      maintenance: t.maintPerHrUSD * bh * ageF * (1 - 0.06 * this.empire.lvl('maintenance')),
      airportFees: t.mtowT * C.landingFeePerTonne * feeMult(to) * this.corp.feeFactor(to) + paxTotal * C.paxFeePerPassenger * feeMult(from) * this.corp.feeFactor(from),
      navigation: km * Math.sqrt(t.mtowT) * C.navigationPerKmPerSqrtTonne,
      handling: paxTotal * C.handlingPerPassenger,
      catering: paxTotal * C.cateringPerPaxPerHour * bh,
    };
  }

  quote(a: string, b: string, typeId: string, aircraftCount: number, weeklyFreq: number, fareY: number, fareJ: number, routeId?: string, aircraftId?: string, fareWIn?: number): RouteQuote {
    const A = AIRPORTS[a];
    const B = AIRPORTS[b];
    const t = TYPES[typeId];
    const fail = (reason: string): RouteQuote => ({ ok: false, reason, distanceKm: 0, blockHours: 0, maxWeeklyFreq: 0, marketWeekly: 0, refFareY: 0, refFareJ: 0, expectedLoadFactor: 0, weeklyRevenue: 0, weeklyCost: 0, weeklyProfit: 0, slotsNeeded: {}, competitors: [], playerShare: 0 });
    if (!A || !B) return fail('Unknown airport');
    if (a === b) return fail('Pick two different airports');
    if (!t) return fail('Pick an aircraft type');
    const km = distanceKm(A, B);
    if (km > t.rangeKm) return fail(`Too far for the ${t.name} (${Math.round(km)} km > ${t.rangeKm} km range)`);
    if (A.runwayM < t.runwayM || B.runwayM < t.runwayM) return fail(`Runway too short for the ${t.name}`);
    const bh = blockHours(km, t);
    const cycleH = 2 * (bh + t.turnMin / 60);
    const maxWeeklyFreq = Math.max(0, aircraftCount) * Math.floor(168 / cycleH);
    const freq = Math.min(weeklyFreq, maxWeeklyFreq);
    const route = routeId ? this.s.routes.find((r) => r.id === routeId) : undefined;
    const used = this.slotsUsed();
    const slotsNeeded: Record<string, number> = {};
    if (!this.isSandbox()) {
      for (const ap of [a, b]) {
        if (slotPrice(ap) === null) continue;
        const need = Math.ceil(freq / 7) - (route ? Math.ceil(route.weeklyFreq / 7) : 0);
        const free = (this.s.slots[ap] ?? 0) - (used[ap] ?? 0);
        if (need > free) slotsNeeded[ap] = need - free;
      }
    }
    const staffMonth = this.staffCostPerAircraft(t);
    const fixed = (aircraftCount * (t.leaseMonthUSD + econ.costs.overheadPerAircraftPerMonth + staffMonth) * 12) / 52;
    if (t.cargoT) {
      // freighter: fareY is the rate per kg; demand from the freight market on this pair
      const capWeek = freq * t.cargoT;
      const ref = Corporate.refCargoRate(km);
      const dem = this.corp.cargoDemand(a, b, capWeek, fareY);
      const perFlightT = freq ? dem.tonnes / freq : 0;
      const perFlight = Object.values(this.flightCost(t, km, a, b, 0)).reduce((x, y) => x + y, 0) + perFlightT * 60;
      const revenue = 2 * dem.tonnes * 1000 * fareY;
      const variable = 2 * freq * perFlight;
      return {
        ok: true, distanceKm: km, blockHours: bh, maxWeeklyFreq, marketWeekly: marketWeekly(A, B) * 0.035, refFareY: ref, refFareJ: 0,
        expectedLoadFactor: dem.fill, weeklyRevenue: revenue, weeklyCost: variable + fixed, weeklyProfit: revenue - variable - fixed, slotsNeeded,
        competitors: [], playerShare: 0, cargo: { tonnesWeek: dem.tonnes * 2, ratePerKg: fareY, refRatePerKg: ref, fill: dem.fill },
      };
    }
    const firstAc = this.s.fleet.find((x) => x.id === (aircraftId ?? route?.aircraftIds[0]));
    const cab = seatsOf(t, firstAc);
    const seats = cab.total;
    const fareW = fareWIn ?? route?.fareW ?? refFares(km).y * 1.6;
    const dem = this.playerDemand(A, B, freq * seats, fareY, fareJ);
    const fit = cabinFit(t, km);
    dem.y *= fit;
    dem.j *= fit;
    const prem = splitPremium(dem.y, freq * cab.w, fareW, refFares(km).y);
    const paxY = Math.min(prem.y, freq * cab.y);
    const paxW = prem.w;
    const paxJ = Math.min(dem.j, freq * cab.j);
    const lf = freq > 0 ? (paxY + paxW + paxJ) / (freq * seats) : 0;
    const ticket = 2 * (paxY * fareY + paxW * fareW + paxJ * fareJ) * (1 + 0.02 * this.empire.lvl('revenue'));
    const belly = this.corp.expectedBelly(t, km);
    const revenue = ticket + 2 * freq * belly.revenue;
    const perFlight = this.flightCost(t, km, a, b, freq > 0 ? (paxY + paxW + paxJ) / freq : 0);
    const variable = 2 * freq * (Object.values(perFlight).reduce((x, y) => x + y, 0) + belly.tonnes * 60) + ticket * econ.costs.distributionShareOfRevenue + revenue * (econ.costs.adminShareOfRevenue ?? 0);
    const ref = refFares(km);
    return {
      ok: true, distanceKm: km, blockHours: bh, maxWeeklyFreq, marketWeekly: dem.market, refFareY: ref.y, refFareJ: ref.j,
      expectedLoadFactor: lf, weeklyRevenue: revenue, weeklyCost: variable + fixed, weeklyProfit: revenue - variable - fixed, slotsNeeded,
      competitors: dem.competitors, playerShare: dem.share, seats: { j: cab.j, w: cab.w, y: cab.y }, refFareW: ref.y * 1.6, paxW: paxW * 2,
    };
  }

  // ------------------------------------------------------------------ commands
  command(c: Command): { ok: boolean; msg: string; data?: unknown } {
    const s = this.s;
    const E = econ.market;
    const money = (usd: number) => `$${(usd / 1e6).toFixed(1)}M`;
    const canPay = (usd: number) => this.isSandbox() || s.cashUSD >= usd;
    const corp = this.corp.command(c) ?? this.empire.command(c);
    if (corp) return corp;
    switch (c.kind) {
      case 'quote':
        return { ok: true, msg: '', data: this.quote(c.a, c.b, c.typeId, c.aircraftCount, c.weeklyFreq, c.fareY, c.fareJ, c.routeId, c.aircraftId, c.fareW) };
      case 'buyNew': {
        const t = TYPES[c.typeId];
        if (!t?.newAvailable) return { ok: false, msg: `${t?.name ?? c.typeId} is out of production: look in the used market` };
        const deposit = t.priceUSD * E.newDepositShare * c.count;
        if (!canPay(deposit)) return { ok: false, msg: `Not enough cash for the ${money(deposit)} deposit` };
        const blocked = this.corp.blocked(t.priceUSD * c.count);
        if (blocked) return { ok: false, msg: blocked };
        for (let i = 0; i < c.count; i++) {
          const a = this.makeAircraft(t.id, 'owned', 0, 1, s.base);
          a.status = 'ordered';
          a.deliveryAt = s.time + t.deliveryMonths * 30 * DAY + i * 20 * DAY;
          a.balanceDueUSD = t.priceUSD * (1 - E.newDepositShare);
          s.fleet.push(a);
        }
        this.book('deposits', deposit);
        this.log(`Ordered ${c.count} × ${t.name}. First delivery in ${t.deliveryMonths} months.`, 'good');
        return { ok: true, msg: `Ordered ${c.count} × ${t.name}` };
      }
      case 'lease': {
        const t = TYPES[c.typeId];
        if (!t) return { ok: false, msg: 'Unknown type' };
        const deposit = t.leaseMonthUSD * E.leaseDepositMonths * c.count;
        if (!canPay(deposit)) return { ok: false, msg: `Not enough cash for the ${money(deposit)} lease deposit` };
        for (let i = 0; i < c.count; i++) {
          const a = this.makeAircraft(t.id, 'leased', t.newAvailable ? 0 : 8, t.newAvailable ? 1 : 0.85, s.base);
          a.status = 'delivering';
          a.deliveryAt = s.time + E.leaseDeliveryDays * DAY;
          s.fleet.push(a);
        }
        this.book('deposits', deposit);
        this.log(`Leased ${c.count} × ${t.name}. Delivery in ${E.leaseDeliveryDays} days.`, 'good');
        return { ok: true, msg: `Leased ${c.count} × ${t.name}` };
      }
      case 'buyUsed': {
        const l = s.used.find((u) => u.id === c.listingId);
        if (!l) return { ok: false, msg: 'Listing no longer available' };
        if (!canPay(l.priceUSD)) return { ok: false, msg: `Not enough cash (${money(l.priceUSD)})` };
        const a = this.makeAircraft(l.typeId, 'owned', l.ageYears, l.condition, s.base, l.priceUSD);
        a.status = 'delivering';
        a.deliveryAt = s.time + E.usedDeliveryDays * DAY;
        a.hours = l.hours;
        s.fleet.push(a);
        s.used = s.used.filter((u) => u.id !== l.id);
        this.book('aircraftPurchases', l.priceUSD);
        this.log(`Bought a ${l.ageYears}-year-old ${TYPES[l.typeId].name} (${a.reg}).`, 'good');
        return { ok: true, msg: `Bought ${TYPES[l.typeId].name} ${a.reg}` };
      }
      case 'sell': {
        const a = s.fleet.find((x) => x.id === c.aircraftId);
        if (!a || a.ownership !== 'owned') return { ok: false, msg: 'Only owned aircraft can be sold' };
        if (a.routeId) return { ok: false, msg: 'Remove it from its route first' };
        if (a.status === 'charter') return { ok: false, msg: 'It is out on a charter' };
        if (a.status === 'ordered') return { ok: false, msg: 'Cancel orders is not available yet' };
        const value = a.bookValueUSD * E.sellBelowValueShare;
        s.fleet = s.fleet.filter((x) => x.id !== a.id);
        this.book('aircraftSales', value);
        this.log(`Sold ${a.reg} for ${money(value)}.`, 'info');
        return { ok: true, msg: `Sold ${a.reg}` };
      }
      case 'returnLease': {
        const a = s.fleet.find((x) => x.id === c.aircraftId);
        if (!a || a.ownership !== 'leased') return { ok: false, msg: 'Not a leased aircraft' };
        if (a.routeId) return { ok: false, msg: 'Remove it from its route first' };
        if (a.status === 'charter') return { ok: false, msg: 'It is out on a charter' };
        const monthsIn = (s.time - a.leaseStart) / (30 * DAY);
        const fee = monthsIn < E.leaseMinMonths ? a.leaseMonthUSD * E.leaseEarlyReturnMonths : 0;
        if (!canPay(fee)) return { ok: false, msg: `Early return fee ${money(fee)}: not enough cash` };
        s.fleet = s.fleet.filter((x) => x.id !== a.id);
        if (fee) this.book('leases', fee);
        this.log(`Returned leased ${a.reg}${fee ? ` (early return fee ${money(fee)})` : ''}.`, 'info');
        return { ok: true, msg: `Returned ${a.reg}` };
      }
      case 'buySlots': {
        const price = slotPrice(c.icao);
        if (price === null) return { ok: false, msg: 'This airport is not slot-coordinated: no slots needed' };
        const total = price * c.count;
        if (!canPay(total)) return { ok: false, msg: `Not enough cash (${money(total)})` };
        s.slots[c.icao] = (s.slots[c.icao] ?? 0) + c.count;
        this.book('slots', total);
        this.log(`Bought ${c.count} daily slot pair${c.count > 1 ? 's' : ''} at ${c.icao}.`, 'good');
        return { ok: true, msg: `Bought ${c.count} slot pair(s) at ${c.icao}` };
      }
      case 'createRoute':
      case 'editRoute': {
        const existing = c.kind === 'editRoute' ? s.routes.find((r) => r.id === c.routeId) : undefined;
        if (c.kind === 'editRoute' && !existing) return { ok: false, msg: 'Route not found' };
        const a = existing?.a ?? (c as { a: string }).a;
        const b = existing?.b ?? (c as { b: string }).b;
        const ids = c.aircraftIds ?? existing!.aircraftIds;
        const acs = ids.map((id) => s.fleet.find((x) => x.id === id)).filter((x): x is FleetAircraft => !!x);
        if (!acs.length) return { ok: false, msg: 'Assign at least one aircraft' };
        const typeId = acs[0].typeId;
        if (acs.some((x) => x.typeId !== typeId)) return { ok: false, msg: 'All aircraft on a route must be the same type (for now)' };
        if (acs.some((x) => x.routeId && x.routeId !== existing?.id)) return { ok: false, msg: 'An aircraft is already flying another route' };
        if (acs.some((x) => x.status === 'ordered')) return { ok: false, msg: 'An aircraft has not been delivered yet' };
        if (TYPES[typeId].role !== 'airliner' && TYPES[typeId].role !== 'freighter') return { ok: false, msg: 'Business jets, VIP aircraft and helicopters fly charters, not scheduled routes' };
        if (acs.some((x) => x.status === 'charter')) return { ok: false, msg: 'An aircraft is out on a charter' };
        const freq = c.weeklyFreq ?? existing!.weeklyFreq;
        const fareY = c.fareY ?? existing!.fareY;
        const fareJ = c.fareJ ?? existing!.fareJ;
        const q = this.quote(a, b, typeId, acs.length, freq, fareY, fareJ, existing?.id);
        if (!q.ok) return { ok: false, msg: q.reason! };
        if (freq > q.maxWeeklyFreq) return { ok: false, msg: `Max ${q.maxWeeklyFreq} weekly round trips with ${acs.length} aircraft` };
        const missing = Object.entries(q.slotsNeeded);
        if (missing.length) return { ok: false, msg: `Not enough slots: need ${missing.map(([ap, n]) => `${n} more at ${ap}`).join(', ')}` };
        if (existing && !!existing.cargo !== !!TYPES[typeId].cargoT) return { ok: false, msg: 'A cargo route needs freighters, a passenger route needs airliners' };
        let r = existing;
        if (!r) {
          r = { id: this.id('rt'), a, b, distanceKm: q.distanceKm, aircraftIds: [], weeklyFreq: freq, fareY, fareJ, fareW: Math.round(fareY * 1.6), cargo: TYPES[typeId].cargoT ? true : undefined, createdAt: s.time, total: emptyStats(), last30: { ...emptyStats(), since: s.time } };
          s.routes.push(r);
        }
        if (c.fareW !== undefined) r.fareW = c.fareW;
        for (const old of r.aircraftIds) {
          const ac = s.fleet.find((x) => x.id === old);
          if (ac && !ids.includes(old)) this.unassign(ac);
        }
        r.aircraftIds = ids;
        r.weeklyFreq = freq;
        r.fareY = fareY;
        r.fareJ = fareJ;
        this.scheduleRoute(r);
        this.updateStaffing();
        this.log(`${existing ? 'Updated' : 'Opened'} route ${AIRPORTS[a].iata || a}–${AIRPORTS[b].iata || b}: ${freq} weekly round trips.`, 'good');
        return { ok: true, msg: `${existing ? 'Route updated' : 'Route opened'}`, data: r.id };
      }
      case 'deleteRoute': {
        const r = s.routes.find((x) => x.id === c.routeId);
        if (!r) return { ok: false, msg: 'Route not found' };
        for (const id of r.aircraftIds) {
          const ac = s.fleet.find((x) => x.id === id);
          if (ac) this.unassign(ac);
        }
        s.routes = s.routes.filter((x) => x.id !== r.id);
        this.log(`Closed route ${r.a}–${r.b}.`, 'info');
        return { ok: true, msg: 'Route closed' };
      }
      case 'setCurrency':
        s.airline.currency = c.currency;
        return { ok: true, msg: `Currency: ${c.currency}` };
      case 'setLivery':
        s.airline.livery = c.livery;
        this.log('New livery applied to the whole fleet.', 'good');
        return { ok: true, msg: 'Livery applied to the fleet' };
      case 'setBrand':
        Object.assign(s.airline, { name: c.name.trim() || s.airline.name, code: c.code.trim().toUpperCase().slice(0, 2) || s.airline.code, primary: c.primary, accent: c.accent });
        return { ok: true, msg: 'Brand updated' };
      case 'setCabin': {
        let n = 0;
        for (const id of c.aircraftIds) {
          const ac = s.fleet.find((x) => x.id === id);
          if (!ac) continue;
          const st = cabinStats(TYPES[ac.typeId], c.cabin);
          if (st.errors.length) return { ok: false, msg: st.errors[0] };
          ac.cabin = structuredClone(c.cabin);
          n++;
        }
        // refitting takes the aircraft out of service for a few days and costs money
        const cost = n * 150_000;
        if (!this.isSandbox() && s.cashUSD < cost) return { ok: false, msg: 'Not enough cash for the refit' };
        this.book('maintenance', cost);
        this.log(`Cabin refit on ${n} aircraft.`, 'good');
        return { ok: true, msg: `Cabin layout applied to ${n} aircraft` };
      }
      case 'designType': {
        if (!this.isSandbox() && s.cashUSD < c.devCostUSD) return { ok: false, msg: 'Not enough cash for development' };
        const t = { ...c.type, custom: true, newAvailable: true };
        s.customTypes = s.customTypes.filter((x) => x.id !== t.id).concat(t);
        registerCustomTypes([t]);
        if (c.devCostUSD) this.book('aircraftPurchases', c.devCostUSD);
        this.log(`${t.name} certified and added to the catalogue.`, 'good');
        return { ok: true, msg: `${t.name} is now in the catalogue`, data: t.id };
      }
      case 'setCharacter':
        s.player.character = c.look;
        return { ok: true, msg: 'Look saved' };
      case 'setStaff': {
        const d = s.staff[c.dept];
        if (c.pay !== undefined) d.pay = clamp(c.pay, 0.7, 1.5);
        if (c.staffing !== undefined) d.staffing = clamp(c.staffing, 0.7, 1.4);
        this.updateStaffing();
        return { ok: true, msg: `${econ.staff.departments[c.dept].label}: pay ${Math.round(d.pay * 100)}%, staffing ${Math.round(d.staffing * 100)}%` };
      }
      case 'incident': {
        // damage or a crash while you were flying: repairs, reputation, time out of service
        const ac = s.fleet.find((x) => x.typeId === 'a320neo' && x.status !== 'ordered' && x.status !== 'charter') ?? s.fleet[0];
        const value = ac ? (ac.ownership === 'owned' ? ac.bookValueUSD : TYPES[ac.typeId].priceUSD * 0.6) : 0;
        const crash = c.severity === 'crash';
        const cost = crash ? value * c.costUSD * (1 - dmg.insuredShare) + 2e6 : c.costUSD;
        this.book('maintenance', cost);
        s.reputation = clamp(s.reputation + dmg.reputation[c.severity], 0, 100);
        s.monthOps.landingsHard += crash ? 5 : 1;
        if (ac) {
          ac.condition = Math.max(0.3, ac.condition - (crash ? 0.4 : 0.05));
          if (!ac.routeId || crash) {
            ac.status = 'maintenance';
            ac.nextAt = s.time + dmg.outOfServiceDays[c.severity] * DAY;
          }
        }
        this.log(`${crash ? 'ACCIDENT' : 'Incident'}: ${c.cause}. Repairs ${(cost / 1e6).toFixed(1)}M${crash ? ' after insurance' : ''}.`, 'bad');
        return { ok: true, msg: '', data: { cost } };
      }
      case 'playerFlight':
        return this.playerFlight(c.from, c.to, c.typeId, c.touchdownFpm);
      case 'advance':
        // time skipped while the player skips a cruise: the whole airline moves on too
        this.step(Math.max(0, Math.min(c.ms, 24 * HOUR)));
        return { ok: true, msg: '' };
    }
    return { ok: false, msg: 'Unknown command' };
  }

  private unassign(ac: FleetAircraft): void {
    ac.routeId = null;
    // aircraft in the air finish their flight and then stay where they land
    if (ac.status !== 'flying' && ac.status !== 'ferry') {
      ac.status = ac.status === 'maintenance' ? 'maintenance' : 'idle';
      ac.phase = 'wait';
    }
  }

  /** Spread each aircraft's departures evenly across the week. */
  private scheduleRoute(r: Route): void {
    const n = r.aircraftIds.length;
    const period = (WEEK * n) / Math.max(r.weeklyFreq, 1);
    r.aircraftIds.forEach((id, k) => {
      const ac = this.s.fleet.find((x) => x.id === id)!;
      ac.routeId = r.id;
      if (ac.status === 'flying' || ac.status === 'ferry' || ac.status === 'delivering' || ac.status === 'maintenance') return;
      ac.periodStart = this.s.time + (k * period) / n + 30 * 60_000;
      if (ac.location !== r.a && ac.location !== r.b) {
        this.startFlight(ac, ac.location, r.a, true);
      } else {
        ac.phase = 'wait';
        ac.status = 'idle';
        ac.nextAt = ac.periodStart;
      }
    });
  }

  // ------------------------------------------------------------------ simulation
  step(dtMs: number): void {
    if (dtMs <= 0) return;
    const target = this.s.time + dtMs;
    // process events in time order, in chunks of at most 15 sim-minutes for month/day boundaries
    while (this.s.time < target) {
      const next = Math.min(target, this.s.time + 15 * 60_000);
      this.s.time = next;
      this.tickFleet();
      this.tickCalendar();
    }
  }

  private tickFleet(): void {
    const now = this.s.time;
    for (const ac of this.s.fleet) {
      if ((ac.status === 'ordered' || ac.status === 'delivering') && now >= ac.deliveryAt) {
        if (ac.balanceDueUSD > 0) {
          this.book('aircraftPurchases', ac.balanceDueUSD);
          ac.balanceDueUSD = 0;
        }
        ac.status = 'idle';
        ac.location = this.s.base;
        this.log(`${TYPES[ac.typeId].name} ${ac.reg} delivered to ${this.s.base}.`, 'good');
        const r = this.s.routes.find((x) => x.aircraftIds.includes(ac.id));
        if (r) this.scheduleRoute(r);
      }
      // a few events can be due in one tick at high speed
      for (let guard = 0; guard < 6 && ac.nextAt && now >= ac.nextAt; guard++) this.advanceAircraft(ac);
    }
  }

  private advanceAircraft(ac: FleetAircraft): void {
    if (ac.status === 'charter') {
      this.corp.completeJob(ac);
      return;
    }
    const r = ac.routeId ? this.s.routes.find((x) => x.id === ac.routeId) : undefined;
    const t = TYPES[ac.typeId];
    if (ac.status === 'flying' || ac.status === 'ferry') {
      // landed
      ac.location = ac.flightTo;
      ac.cycles++;
      ac.status = 'turnaround';
      ac.nextAt = this.s.time + t.turnMin * 60_000;
      if (ac.hoursSinceCheck > 600) {
        ac.status = 'maintenance';
        ac.nextAt = this.s.time + DAY;
        ac.hoursSinceCheck = 0;
        ac.condition = Math.min(1, ac.condition + 0.05);
        this.book('maintenance', t.maintPerHrUSD * 40);
      }
      return;
    }
    if (ac.status === 'maintenance' || ac.status === 'turnaround' || ac.status === 'idle') {
      if (!r) {
        ac.status = 'idle';
        ac.nextAt = 0;
        return;
      }
      const period = (WEEK * r.aircraftIds.length) / Math.max(r.weeklyFreq, 1);
      if (ac.location === r.b) {
        // fly back to A straight after the turnaround
        this.startFlight(ac, r.b, r.a, false, r);
        return;
      }
      if (ac.location === r.a) {
        while (ac.periodStart + period < this.s.time) ac.periodStart += period;
        if (this.s.time >= ac.periodStart) {
          this.startFlight(ac, r.a, r.b, false, r);
          ac.periodStart += period;
        } else {
          ac.status = 'idle';
          ac.nextAt = ac.periodStart;
        }
        return;
      }
      this.startFlight(ac, ac.location, r.a, true);
    }
  }

  /** Event / staffing effects on a departure: [delay probability, cancellation probability]. */
  private disruption(from: string, to: string): [number, number] {
    const O = econ.operations;
    let delay = O.baseDelayProb;
    let cancel = 0;
    for (const e of this.s.events) {
      const hit = e.scope === 'all' || (e.scope === 'base' && (from === this.s.base || to === this.s.base)) || (e.scope === 'europe' && (inEurope(from) || inEurope(to)));
      if (!hit) continue;
      delay += e.delayProb;
      cancel = Math.max(cancel, e.cancelShare);
    }
    const st = this.s.staff;
    const short = Math.max(0, 1 - Math.min(st.ground.staffing, st.engineers.staffing, st.pilots.staffing));
    delay += short * O.understaffDelayWeight + (1 - st.ground.morale) * 0.08;
    if (st.pilots.staffing < 0.9) cancel = Math.max(cancel, (0.9 - st.pilots.staffing) * 0.6);
    const ops = this.empire.lvl('ops');
    delay *= 1 - 0.12 * ops;
    cancel *= 1 - 0.15 * ops;
    return [clamp(delay, 0, 0.95), clamp(cancel, 0, 0.95)];
  }

  private startFlight(ac: FleetAircraft, from: string, to: string, ferry: boolean, r?: Route): void {
    const t = TYPES[ac.typeId];
    const A = AIRPORTS[from];
    const B = AIRPORTS[to];
    const km = distanceKm(A, B);
    const bh = blockHours(km, t);
    let paxY = 0;
    let paxJ = 0;
    if (!ferry && r) {
      const [pDelay, pCancel] = this.disruption(from, to);
      this.s.monthOps.flights++;
      if (this.rand() < pCancel) {
        // cancelled: the aircraft stays put, the crew and handling are still paid
        this.s.monthOps.cancelled++;
        this.book('crew', (econ.costs.pilotPairPerBlockHr + t.cabinCrew * econ.costs.cabinCrewPerBlockHr) * bh);
        ac.status = 'idle';
        ac.nextAt = this.s.time + 6 * HOUR;
        return;
      }
      if (this.rand() < pDelay) {
        this.s.monthOps.delayed++;
        if (this.rand() < econ.operations.longDelayShare) this.pendingComp = true;
      }
    }
    let paxW = 0;
    const cab = seatsOf(t, ac);
    if (!ferry && r?.cargo) {
      // freighter flight
      const dem = this.corp.cargoDemand(from, to, r.weeklyFreq * (t.cargoT ?? 0), r.fareY);
      const tonnes = Math.min(t.cargoT ?? 0, (dem.tonnes / Math.max(1, r.weeklyFreq)) * (1 + (this.rand() * 2 - 1) * 0.15));
      const rev = tonnes * 1000 * r.fareY;
      let total = 0;
      for (const [cat, v] of Object.entries(this.flightCost(t, km, from, to, 0, ac))) {
        this.book(cat as LedgerCategory, v);
        total += v;
      }
      this.book('handling', tonnes * 60);
      total += tonnes * 60;
      this.book('cargoRevenue', rev);
      for (const st of [r.total, r.last30]) {
        st.flights++;
        st.seats += t.cargoT ?? 0;
        st.cargoT = (st.cargoT ?? 0) + tonnes;
        st.cargoRev = (st.cargoRev ?? 0) + rev;
        st.revenue += rev;
        st.cost += total;
      }
      ac.status = 'flying';
      ac.flightFrom = from;
      ac.flightTo = to;
      ac.flightDep = this.s.time;
      ac.flightArr = this.s.time + bh * HOUR;
      ac.nextAt = ac.flightArr;
      ac.hours += bh;
      ac.hoursSinceCheck += bh;
      ac.condition = Math.max(0.5, ac.condition - bh * 0.00004);
      return;
    }
    if (!ferry && r) {
      const seatsWeek = r.weeklyFreq * cab.total;
      const dem = this.playerDemand(A, B, seatsWeek, r.fareY, r.fareJ);
      const day = new Date(this.s.time).getUTCDay();
      const noise = 1 + (this.rand() * 2 - 1) * econ.demand.dailyNoise;
      const f = (econ.demand.weekdayFactor[(day + 6) % 7] ?? 1) * noise / Math.max(r.weeklyFreq, 1);
      const fit = cabinFit(t, km);
      const prem = splitPremium(dem.y * f * fit, cab.w, r.fareW ?? r.fareY * 1.6, refFares(km).y);
      paxW = Math.round(prem.w);
      paxY = Math.min(cab.y, Math.round(prem.y));
      paxJ = Math.min(cab.j, Math.round(dem.j * f * fit));
    }
    const costs = this.flightCost(t, km, from, to, paxY + paxW + paxJ, ac);
    let total = 0;
    for (const [cat, v] of Object.entries(costs)) {
      this.book(cat as LedgerCategory, v);
      total += v;
    }
    const revenue = (paxY * (r?.fareY ?? 0) + paxW * (r?.fareW ?? 0) + paxJ * (r?.fareJ ?? 0)) * (1 + 0.02 * this.empire.lvl('revenue'));
    if (revenue) {
      this.book('ticketRevenue', revenue);
      this.book('distribution', revenue * econ.costs.distributionShareOfRevenue);
      total += revenue * econ.costs.distributionShareOfRevenue;
    }
    const belly = !ferry && r ? this.corp.bellyCargo(t, km) : { tonnes: 0, revenue: 0 };
    if (belly.revenue) {
      this.book('cargoRevenue', belly.revenue);
      this.book('handling', belly.tonnes * 60);
      total += belly.tonnes * 60;
    }
    if (this.pendingComp) {
      // a long delay: some passengers claim EU261-style compensation
      const comp = (paxY + paxJ) * econ.operations.compensationUSDPerPax * econ.operations.claimRate;
      this.book('compensation', comp);
      total += comp;
      this.pendingComp = false;
    }
    if (r && !ferry) {
      for (const st of [r.total, r.last30]) {
        st.flights++;
        st.paxY += paxY + paxW;
        st.paxW = (st.paxW ?? 0) + paxW;
        st.paxJ += paxJ;
        st.seats += cab.total;
        st.cargoT = (st.cargoT ?? 0) + belly.tonnes;
        st.cargoRev = (st.cargoRev ?? 0) + belly.revenue;
        st.revenue += revenue + belly.revenue;
        st.cost += total;
      }
    }
    ac.status = ferry ? 'ferry' : 'flying';
    ac.flightFrom = from;
    ac.flightTo = to;
    ac.flightDep = this.s.time;
    ac.flightArr = this.s.time + bh * HOUR;
    ac.nextAt = ac.flightArr;
    ac.hours += bh;
    ac.hoursSinceCheck += bh;
    ac.condition = Math.max(0.5, ac.condition - bh * 0.00004);
  }

  private tickCalendar(): void {
    const s = this.s;
    const day = new Date(s.time).toISOString().slice(0, 10);
    if (day !== s.lastDay) {
      s.lastDay = day;
      this.newDay();
    }
    const m = this.month();
    if (m !== s.lastMonth) {
      this.monthEnd(s.lastMonth);
      s.lastMonth = m;
    }
    const last = s.history[s.history.length - 1];
    if (!last || s.time - last.t >= 6 * HOUR) {
      s.history.push({ t: s.time, cash: s.cashUSD });
      if (s.history.length > 3000) s.history = s.history.filter((_, i) => i % 2 === 0);
    }
    if (s.time >= s.usedRefreshAt) this.refreshUsed();
    for (const r of s.routes) if (s.time - r.last30.since > 30 * DAY) r.last30 = { ...emptyStats(), since: s.time };
    // cash warnings / bankruptcy watch
    if (!this.isSandbox()) {
      if (s.cashUSD < 0) {
        if (s.negativeSince === null) {
          s.negativeSince = s.time;
          this.log('Cash is negative! You have 30 days to recover: take a loan or draw on the credit line (Finances).', 'bad');
        } else if (s.time - s.negativeSince > 30 * DAY && !s.bankrupt) {
          s.bankrupt = true;
          this.log('Bankrupt: cash has been negative for 30 days.', 'bad');
        }
      } else s.negativeSince = null;
    }
  }

  /** Daily: fuel price random walk, random events, event expiry. */
  private newDay(): void {
    const s = this.s;
    const F = econ.fuel;
    const dt = 1 / 365;
    const gauss = () => Math.sqrt(-2 * Math.log(this.rand() + 1e-9)) * Math.cos(2 * Math.PI * this.rand());
    s.fuelPrice = clamp(s.fuelPrice + F.reversionPerYear * (F.meanUSDPerKg - s.fuelPrice) * dt + F.volatilityPerYear * Math.sqrt(dt) * s.fuelPrice * gauss(), F.min, F.max);
    if (!s.fuelHistory.length || s.time - s.fuelHistory[s.fuelHistory.length - 1].t > 3 * DAY) {
      s.fuelHistory.push({ t: s.time, p: s.fuelPrice });
      if (s.fuelHistory.length > 400) s.fuelHistory.shift();
    }
    s.events = s.events.filter((e) => e.until > s.time);
    this.corp.newDay();
    if (this.isSandbox() && s.routes.length === 0) return;
    for (const ev of eventsData.events as unknown as (Partial<ActiveEvent> & { id: string; ratePerYear: number; days: number; level: 'good' | 'warn' | 'bad'; fuelMult?: number; reputation?: number; minReputation?: number; text: string })[]) {
      if (this.rand() > ev.ratePerYear / 365) continue;
      if (ev.minReputation && s.reputation < ev.minReputation) continue;
      if (s.events.some((e) => e.id === ev.id)) continue;
      let country: string | undefined;
      let region = '';
      if (ev.scope === 'region') {
        const dests = s.routes.flatMap((r) => [r.a, r.b]).filter((x) => x !== s.base);
        const pick = dests.length ? dests[Math.floor(this.rand() * dests.length)] : 'LEBL';
        country = AIRPORTS[pick]?.country;
        region = CONTINENT[country ?? '']?.[0] ?? country ?? '';
      }
      if (ev.fuelMult) s.fuelPrice = clamp(s.fuelPrice * ev.fuelMult, F.min, F.max);
      if (ev.reputation) s.reputation = clamp(s.reputation + ev.reputation * (ev.reputation < 0 ? 1 - 0.25 * this.empire.lvl('pr') : 1), 0, 100);
      const text = ev.text.replace('{base}', AIRPORTS[s.base]?.iata || s.base).replace('{airline}', s.airline.name).replace('{region}', region);
      if (ev.days > 0) {
        s.events.push({ id: ev.id, until: s.time + ev.days * DAY, scope: ev.scope ?? 'all', country, delayProb: ev.delayProb ?? 0, cancelShare: ev.cancelShare ?? 0, demandMult: ev.demandMult ?? 1, text });
      }
      this.log(text, ev.level);
    }
  }

  // ------------------------------------------------------------------ staff
  staffCostPerAircraft(t: AircraftType): number {
    const D = econ.staff.departments;
    const pilots = t.category === 'turboprop' ? D.pilots.perTurboprop : t.category === 'widebody' || t.category === 'jumbo' ? D.pilots.perWidebody : D.pilots.perNarrowbody;
    return pilots * D.pilots.salaryMonthUSD + t.cabinCrew * D.cabin.perCabinCrewSeat * D.cabin.salaryMonthUSD + D.engineers.perAircraft * D.engineers.salaryMonthUSD;
  }

  /** Headcount needed per department from the active fleet and the schedule. */
  updateStaffing(): void {
    const s = this.s;
    const D = econ.staff.departments;
    const fleet = s.fleet.filter((a) => a.status !== 'ordered' && TYPES[a.typeId].role === 'airliner');
    let pilots = 0;
    let cabin = 0;
    for (const a of fleet) {
      const t = TYPES[a.typeId];
      pilots += t.category === 'turboprop' ? D.pilots.perTurboprop : t.category === 'widebody' || t.category === 'jumbo' ? D.pilots.perWidebody : D.pilots.perNarrowbody;
      cabin += t.cabinCrew * D.cabin.perCabinCrewSeat;
    }
    const deps = s.routes.reduce((n, r) => n + r.weeklyFreq * 2, 0);
    const req: Record<Dept, number> = {
      pilots, cabin, engineers: fleet.length * D.engineers.perAircraft, ground: Math.ceil(deps * D.ground.perWeeklyDeparture), hq: fleet.length ? D.hq.base + fleet.length * D.hq.perAircraft : 0,
    };
    for (const d of DEPTS) {
      const st = s.staff[d];
      st.required = req[d];
      st.headcount = Math.round(req[d] * st.staffing);
    }
  }

  private staffMonth(): void {
    const s = this.s;
    const D = econ.staff.departments;
    const E = econ.staff;
    this.updateStaffing();
    let pay = 0;
    for (const d of DEPTS) {
      const st = s.staff[d];
      pay += st.headcount * D[d].salaryMonthUSD * st.pay;
      const target = clamp(0.62 + E.moralePayWeight * (st.pay - 1) + E.moraleStaffingWeight * Math.min(0.25, st.staffing - 1) + 0.03 * this.empire.lvl('training'), 0.05, 1);
      st.morale = clamp(st.morale + (target - st.morale) * E.moraleMonthlyBlend, 0, 1);
      if (st.morale < 0.3 && st.required > 0) this.log(`${D[d].label} morale is very low: expect worse service and strikes.`, 'warn');
    }
    this.book('salaries', pay);
    this.corp.strikesMonth();
  }

  // ------------------------------------------------------------------ reputation & reviews
  private reputationMonth(): void {
    const s = this.s;
    const R = econ.reputation;
    const ops = s.monthOps;
    const fleet = s.fleet.filter((a) => a.status !== 'ordered' && a.status !== 'delivering');
    if (!ops.flights || !fleet.length) return;
    const onTime = 1 - (ops.delayed + ops.cancelled) / ops.flights;
    const age = fleet.reduce((x, a) => x + a.ageYears, 0) / fleet.length;
    const cond = fleet.reduce((x, a) => x + a.condition, 0) / fleet.length;
    let fareRatio = 1;
    if (s.routes.length) fareRatio = s.routes.reduce((x, r) => x + r.fareY / refFares(r.distanceKm).y, 0) / s.routes.length;
    const dr = s.drivers;
    dr.punctuality = clamp((onTime - 0.6) / 0.35, 0, 1);
    dr.service = clamp(s.staff.cabin.morale * Math.min(1, s.staff.cabin.staffing), 0, 1);
    // comfort = seat comfort of the cabins you fitted, plus fleet age and condition
    const seatComfort = fleet.reduce((x, a) => x + seatsOf(TYPES[a.typeId], a).comfort, 0) / fleet.length;
    dr.comfort = clamp(0.5 * seatComfort + 0.3 * clamp(1 - age / 25, 0, 1) + 0.2 * cond + this.corp.comfortBonus(), 0, 1);
    dr.value = clamp(1.45 - fareRatio * 0.75, 0, 1);
    dr.safety = clamp(cond - ops.landingsHard * 0.05, 0, 1);
    const w = R.weights;
    const target = 100 * (w.punctuality * dr.punctuality + w.service * dr.service + w.comfort * dr.comfort + w.value * dr.value + w.safety * dr.safety) + 1.5 * this.empire.lvl('pr');
    s.reputation = clamp(s.reputation + (target - s.reputation) * R.monthlyBlend, 0, 100);
    // a few passenger reviews generated from what actually happened
    const lines: [number, string][] = [
      [dr.punctuality, dr.punctuality > 0.7 ? 'Left on time and landed early. No complaints.' : 'Over an hour late and nobody told us why.'],
      [dr.service, dr.service > 0.65 ? 'Lovely cabin crew, genuinely friendly.' : 'Crew looked exhausted and the service was slow.'],
      [dr.comfort, dr.comfort > 0.65 ? 'Modern, clean aircraft. Comfortable seats.' : 'Tired cabin and the seat would not recline.'],
      [dr.value, dr.value > 0.6 ? 'Great price for the route.' : 'Far too expensive for what you get.'],
    ];
    for (let i = 0; i < 3; i++) {
      const [score, text] = lines[Math.floor(this.rand() * lines.length)];
      const stars = clamp(Math.round(1 + score * 3 + this.rand()), 1, 5);
      s.reviews.unshift({ t: s.time, stars, text });
    }
    s.reviews.length = Math.min(s.reviews.length, 30);
    this.log(`Reputation ${Math.round(s.reputation)}/100 · on time ${Math.round(onTime * 100)}% (${ops.delayed} delayed, ${ops.cancelled} cancelled).`, onTime > 0.8 ? 'info' : 'warn');
    s.monthOps = { flights: 0, delayed: 0, cancelled: 0, landingsHard: 0 };
  }

  // ------------------------------------------------------------------ rivals react
  private rivalsMonth(): void {
    const s = this.s;
    let changed = false;
    for (const r of s.routes) {
      const k = pairKey(r.a, r.b);
      const on = this.pairs.get(k) ?? [];
      const lf = r.last30.seats ? (r.last30.paxY + r.last30.paxJ) / r.last30.seats : 0;
      for (const { r: rv, rt } of on) {
        if (this.corp.friendly(rv.id)) continue;
        if (this.rand() > rv.aggression * 0.35) continue;
        const floor = MODELS[rv.model].fareFactor * 0.82;
        if (rt.fare > floor && this.rand() < 0.6) {
          rt.fare *= 0.93;
          this.log(`${rv.name} cuts fares on ${AIRPORTS[r.a]?.iata}–${AIRPORTS[r.b]?.iata} to fight you.`, 'warn');
        } else {
          rt.freq += Math.max(2, Math.round(rt.freq * 0.2));
          this.log(`${rv.name} adds flights on ${AIRPORTS[r.a]?.iata}–${AIRPORTS[r.b]?.iata}.`, 'warn');
        }
        changed = true;
      }
      // a profitable route attracts a new rival from either end's hub
      if (lf > 0.82 && on.length < 4) {
        const entrant = s.rivals.find((rv) => !this.corp.friendly(rv.id) && (rv.hubs.includes(r.a) || rv.hubs.includes(r.b)) && !on.some((o) => o.r === rv) && this.rand() < rv.aggression * 0.12);
        if (entrant) {
          const hub = entrant.hubs.includes(r.a) ? r.a : r.b;
          entrant.routes.push({ a: hub, b: hub === r.a ? r.b : r.a, freq: 7, fare: MODELS[entrant.model].fareFactor * 0.95 });
          this.log(`${entrant.name} launches ${AIRPORTS[r.a]?.iata}–${AIRPORTS[r.b]?.iata} against you.`, 'bad');
          changed = true;
        }
      }
    }
    // quiet background growth of rival networks
    for (let i = 0; i < 3; i++) {
      const rv = s.rivals[Math.floor(this.rand() * s.rivals.length)];
      const rt = rv.routes[Math.floor(this.rand() * rv.routes.length)];
      if (rt) {
        rt.freq = Math.max(2, Math.round(rt.freq * (0.95 + this.rand() * 0.15)));
        changed = true;
      }
    }
    if (changed) this.indexRivals();
  }

  // ------------------------------------------------------------------ flights you fly yourself
  playerFlight(from: string, to: string, typeId: string, fpm: number): { ok: boolean; msg: string; data?: unknown } {
    const s = this.s;
    const A = AIRPORTS[from];
    const B = AIRPORTS[to];
    const t = TYPES[typeId];
    if (!A || !B || !t) return { ok: false, msg: 'Unknown flight' };
    const P = econ.playerFlight;
    const job = this.corp.flownLeg(from, to);
    if (job) {
      const costs = this.flightCost(t, distanceKm(A, B), from, to, job.pax);
      let cost = 0;
      for (const [cat, v] of Object.entries(costs)) {
        this.book(cat as LedgerCategory, v);
        cost += v;
      }
      const bonusShare = fpm >= P.bonusButterFpm ? P.bonusButter : fpm >= P.bonusGoodFpm ? P.bonusGood : 0;
      const bonus = job.payUSD * 0.1 * bonusShare;
      if (bonus) this.book('otherRevenue', bonus);
      if (fpm < P.hardFpm) s.monthOps.landingsHard++;
      s.playerFlights.count++;
      s.playerFlights.best = Math.max(s.playerFlights.best, fpm);
      this.log(`You flew the charter for ${job.client} yourself. The client adds a 10% bonus when the job ends.`, 'good');
      return { ok: true, msg: 'Charter leg logged', data: { pax: job.pax, revenue: 0, bonus, cost, profit: bonus - cost, fpm, bonusShare } };
    }
    const route = s.routes.find((r) => (r.a === from && r.b === to) || (r.a === to && r.b === from));
    const ref = refFares(distanceKm(A, B));
    const fareY = route?.fareY ?? ref.y;
    const fareJ = route?.fareJ ?? ref.j;
    const freq = (route?.weeklyFreq ?? 0) + 1;
    const flyer = s.fleet.find((x) => x.typeId === typeId && x.location === from) ?? s.fleet.find((x) => x.typeId === typeId);
    const cab = seatsOf(t, flyer);
    const dem = this.playerDemand(A, B, freq * cab.total, fareY, fareJ);
    const prem = splitPremium(dem.y / freq, cab.w, route?.fareW ?? fareY * 1.6, ref.y);
    const paxW = Math.round(prem.w);
    const paxY = Math.min(cab.y, Math.round(prem.y)) + paxW;
    const paxJ = Math.min(cab.j, Math.round(dem.j / freq));
    const km = distanceKm(A, B);
    const costs = this.flightCost(t, km, from, to, paxY + paxJ);
    let cost = 0;
    for (const [cat, v] of Object.entries(costs)) {
      this.book(cat as LedgerCategory, v);
      cost += v;
    }
    const base = paxY * fareY + paxJ * fareJ;
    this.book('distribution', base * econ.costs.distributionShareOfRevenue);
    const bonusShare = fpm >= P.bonusButterFpm ? P.bonusButter : fpm >= P.bonusGoodFpm ? P.bonusGood : 0;
    const bonus = base * bonusShare;
    this.book('ticketRevenue', base);
    if (bonus) this.book('otherRevenue', bonus);
    if (fpm >= P.bonusButterFpm) s.reputation = clamp(s.reputation + P.butterReputation, 0, 100);
    if (fpm < P.hardFpm) {
      s.reputation = clamp(s.reputation + P.hardReputation, 0, 100);
      s.monthOps.landingsHard++;
    }
    if (route) {
      for (const st of [route.total, route.last30]) {
        st.flights++;
        st.paxY += paxY;
        st.paxJ += paxJ;
        st.seats += cab.total;
        st.revenue += base + bonus;
        st.cost += cost;
      }
    }
    s.playerFlights.count++;
    s.playerFlights.best = Math.max(s.playerFlights.best, fpm);
    const summary = { pax: paxY + paxJ, revenue: base, bonus, cost, profit: base + bonus - cost, fpm, bonusShare };
    this.log(`You flew ${A.iata || from}→${B.iata || to} with ${paxY + paxJ} passengers. Landing ${Math.round(fpm)} fpm${bonusShare ? ` (+${Math.round(bonusShare * 100)}% bonus)` : ''}.`, 'good');
    return { ok: true, msg: 'Flight logged', data: summary };
  }

  private monthEnd(month: string): void {
    const s = this.s;
    const C = econ.costs;
    let leases = 0;
    let insurance = 0;
    let dep = 0;
    for (const ac of s.fleet) {
      if (ac.status === 'ordered') continue;
      if (ac.ownership === 'leased' && ac.status !== 'delivering') leases += ac.leaseMonthUSD;
      if (ac.ownership === 'owned') {
        insurance += ac.bookValueUSD * C.insurancePerMonthOfValue;
        const d = ac.bookValueUSD * C.depreciationPerMonth;
        ac.bookValueUSD -= d;
        dep += d;
      }
      ac.ageYears += 1 / 12;
    }
    const active = s.fleet.filter((a) => a.status !== 'ordered').length;
    this.staffMonth();
    this.reputationMonth();
    this.rivalsMonth();
    this.book('leases', leases);
    this.book('insurance', insurance);
    this.book('overhead', C.overheadPerMonth + C.overheadPerAircraftPerMonth * active);
    s.depreciation[month] = dep;
    // head office, sales and marketing scale with the business
    const monthRev = REVENUE_CATS.reduce((x, k) => x + (s.ledger[month]?.[k] ?? 0), 0);
    if (monthRev > 0) this.book('overhead', monthRev * (econ.costs.adminShareOfRevenue ?? 0));
    this.corp.monthEnd();
    this.empire.monthEnd();
    const L = s.ledger[month] ?? {};
    const rev = REVENUE_CATS.reduce((x, k) => x + (L[k] ?? 0), 0);
    const opCost = OPCOST_CATS.reduce((x, k) => x + (L[k] ?? 0), 0);
    this.log(`${month} closed: revenue ${(rev / 1e6).toFixed(2)}M, operating costs ${(opCost / 1e6).toFixed(2)}M.`, rev >= opCost ? 'good' : 'warn');
    if (rev > opCost && s.routes.length) this.empire.unlock('profit_month');
  }

  refreshUsed(): void {
    const E = econ.market;
    const pool = Object.values(TYPES).filter((t) => t.role === 'airliner' || this.rand() < 0.2);
    const list: UsedListing[] = [];
    const bigAirports = Object.values(AIRPORTS).filter((a) => a.type === 0);
    for (let i = 0; i < E.usedListings; i++) {
      const t = pool[Math.floor(this.rand() * pool.length)];
      const age = Math.max(2, Math.round(this.rand() * E.usedMaxAgeYears));
      const share = Math.max(E.usedMinValueShare, Math.pow(1 - E.usedValuePerYear, age));
      list.push({
        id: this.id('u'), typeId: t.id, ageYears: age, condition: +(0.62 + this.rand() * 0.33).toFixed(2),
        priceUSD: Math.round((t.priceUSD * share * (0.9 + this.rand() * 0.2)) / 1e4) * 1e4,
        location: bigAirports[Math.floor(this.rand() * bigAirports.length)].icao, hours: Math.round(age * (2500 + this.rand() * 1500)),
      });
    }
    this.s.used = list.sort((a, b) => a.typeId.localeCompare(b.typeId) || a.ageYears - b.ageYears);
    this.s.usedRefreshAt = this.s.time + 30 * DAY;
  }

  /** Your current world rank by weekly passengers (merged airlines included). */
  rankNow(): number {
    let pax = 0;
    for (const r of this.s.routes) {
      const days = Math.max(1, (this.s.time - r.last30.since) / DAY);
      pax += ((r.last30.paxY + r.last30.paxJ) * 7) / days;
    }
    return this.worldView(pax).rank;
  }

  // ------------------------------------------------------------------ snapshot
  snapshot(): Snapshot {
    const s = this.s;
    const months = Object.keys(s.ledger).sort().slice(-13);
    let rev = 0;
    let cost = 0;
    let pax = 0;
    let seats = 0;
    let flights = 0;
    for (const r of s.routes) {
      const days = Math.max(1, (s.time - r.last30.since) / DAY);
      const k = 7 / days;
      rev += r.last30.revenue * k;
      cost += r.last30.cost * k;
      pax += (r.last30.paxY + r.last30.paxJ) * k;
      seats += r.last30.seats * k;
      flights += r.last30.flights * k;
    }
    return {
      time: s.time, speed: s.speed, cashUSD: s.cashUSD, airline: s.airline, difficulty: s.difficulty, base: s.base,
      fleet: s.fleet, routes: s.routes, slots: s.slots, slotsUsed: this.slotsUsed(), used: s.used,
      ledgerMonths: months.map((m) => ({ month: m, items: s.ledger[m], depreciation: s.depreciation[m] ?? 0 })),
      history: s.history.slice(-400), log: s.log.slice(0, 40), bankrupt: s.bankrupt,
      weekly: { revenue: rev, cost, pax, flights, loadFactor: seats ? pax / seats : 0 },
      ...this.worldView(pax),
      corp: this.corp.view(),
      empire: this.empire.view(),
    };
  }

  private worldView(playerPax: number): Pick<Snapshot, 'customTypes' | 'player' | 'rivals' | 'rank' | 'fuelPrice' | 'fuelHistory' | 'events' | 'staff' | 'reputation' | 'drivers' | 'reviews' | 'onTime' | 'playerFlights'> {
    const s = this.s;
    const rivals = s.rivals.map((r) => ({
      id: r.id, name: r.name, colors: r.colors, model: r.model, routes: r.routes.length, quality: r.quality,
      weeklyPax: r.routes.reduce((x, rt) => x + rt.freq * 2 * r.seats * 0.8, 0),
    })).sort((a, b) => b.weeklyPax - a.weeklyPax);
    const owned = s.holdings.owned;
    const visible = rivals.filter((r) => owned[r.id] !== 'merge');
    const myPax = playerPax + this.corp.mergedWeeklyPax();
    const rank = visible.filter((r) => r.weeklyPax > myPax).length + 1;
    const ops = s.monthOps;
    return {
      customTypes: s.customTypes, player: s.player,
      rivals: visible, rank, fuelPrice: s.fuelPrice, fuelHistory: s.fuelHistory.slice(-120), events: s.events, staff: s.staff, reputation: s.reputation,
      drivers: s.drivers, reviews: s.reviews.slice(0, 9), onTime: ops.flights ? 1 - (ops.delayed + ops.cancelled) / ops.flights : 1, playerFlights: s.playerFlights,
    };
  }
}
