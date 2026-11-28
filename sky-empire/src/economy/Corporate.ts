import C from '@data/economy/corporate.json';
import type {
  AircraftType, CharterJob, CharterKind, CharterOffer, Command, CorpView, Dept, FleetAircraft, GameState, LedgerCategory, Rival, Route,
} from './types';
import type { Sim } from './Sim';
import { AIRPORTS, TYPES, blockHours, distanceKm, marketWeekly, refFares, seatsOf } from './Sim';

const DAY = 86_400_000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
type Result = { ok: boolean; msg: string; data?: unknown };

export const REVENUE_CATS: LedgerCategory[] = ['ticketRevenue', 'otherRevenue', 'cargoRevenue', 'charterRevenue', 'assetIncome', 'investmentIncome', 'subsidiaryIncome'];
export const OPCOST_CATS: LedgerCategory[] = ['fuel', 'crew', 'maintenance', 'airportFees', 'navigation', 'handling', 'catering', 'leases', 'overhead', 'insurance', 'salaries', 'compensation', 'assetCosts', 'distribution'];
const RATINGS = C.finance.ratings as [string, number, number][];
const DEPT_LABEL: Record<Dept, string> = { pilots: 'Pilots', cabin: 'Cabin crew', engineers: 'Engineers', ground: 'Ground staff', hq: 'Head office' };

/** Default values for M6 state so older saves keep loading. */
export function migrateCorporate(s: GameState): void {
  s.finance ??= { loans: [], creditDrawnUSD: 0, breaches: 0, autoDraw: true };
  s.equity ??= {
    listed: false, ipoAt: null, shares: C.equity.foundingShares, playerShares: C.equity.foundingShares, price: 0, history: [],
    payout: 0, confidence: 0.7, demand: null, nextDemandAt: 0, blockedUntil: 0,
  };
  s.holdings ??= { stakes: {}, owned: {}, bid: null, alliance: null, inviteCooldown: {} };
  s.assets ??= { lounges: [], hotels: [], airports: {} };
  s.charters ??= { offers: [], active: [] };
  s.strikes ??= [];
  s.personal ??= { cashUSD: 0 };
}

/**
 * The corporate layer on top of the flight simulation: debt and credit rating, equity and the
 * share price, the board, rival stakes and takeovers, alliances, lounges / hotels / airport
 * stakes, cargo, charters and strikes. It owns no rendering and runs inside the economy worker.
 */
export class Corporate {
  private rivalCache = new Map<string, { valueUSD: number; profitYearUSD: number; revenueYearUSD: number }>();
  private rivalCacheMonth = '';

  constructor(private sim: Sim) {}

  private get s(): GameState {
    return this.sim.s;
  }

  // ------------------------------------------------------------------ results from the ledger
  /** Annualised revenue, EBITDA and net profit from the last complete months (or the current one early on). */
  results(): { revenue: number; ebitda: number; net: number; months: number } {
    const s = this.s;
    const cur = this.sim.month();
    let keys = Object.keys(s.ledger).filter((m) => m < cur).sort().slice(-3);
    let scale = 12 / Math.max(1, keys.length);
    if (!keys.length) {
      keys = [cur];
      const d = new Date(s.time);
      scale = 12 * (30 / Math.max(1, d.getUTCDate() - 1 + d.getUTCHours() / 24));
      if (s.time - s.startTime < 5 * DAY) scale = 0;
    }
    let rev = 0;
    let op = 0;
    let other = 0;
    for (const k of keys) {
      const L = s.ledger[k] ?? {};
      for (const c of REVENUE_CATS) rev += L[c] ?? 0;
      for (const c of OPCOST_CATS) op += L[c] ?? 0;
      other += (L.interest ?? 0) + (s.depreciation[k] ?? 0);
    }
    return { revenue: rev * scale, ebitda: (rev - op) * scale, net: (rev - op - other) * scale, months: keys.length };
  }

  debt(): number {
    return this.s.finance.loans.reduce((x, l) => x + l.balanceUSD, 0) + this.s.finance.creditDrawnUSD;
  }

  private ownedBookValue(): number {
    return this.s.fleet.filter((a) => a.ownership === 'owned' && a.status !== 'ordered').reduce((x, a) => x + a.bookValueUSD, 0);
  }

  rating(): { name: string; spread: number } {
    const r = this.results();
    const debt = this.debt();
    let i: number;
    if (r.ebitda <= 0) i = debt <= 0 && this.s.cashUSD > 0 ? 4 : this.s.cashUSD > debt * 0.2 ? 5 : 6;
    else {
      const lev = debt / r.ebitda;
      i = RATINGS.findIndex(([, , max]) => lev <= max);
    }
    if (this.s.reputation < 40) i++;
    if (r.revenue < 100e6) i = Math.max(i, 3);
    if (r.revenue < 30e6) i = Math.max(i, 4);
    i = clamp(i, 0, RATINGS.length - 1);
    const [name, spread] = RATINGS[i];
    return { name, spread: spread + (this.s.finance.breaches > 0 ? C.finance.breachPenaltySpread : 0) };
  }

  rate(): number {
    return C.finance.baseRate + this.rating().spread;
  }

  capacity(): number {
    const r = this.results();
    const mult = (C.finance.capacityEbitdaMultiple as Record<string, number>)[this.rating().name] ?? 1;
    return Math.max(C.finance.minCapacityUSD, C.finance.assetAdvance * this.ownedBookValue() + Math.max(0, r.ebitda) * mult);
  }

  creditLimit(): number {
    return Math.max(C.finance.creditLineMinUSD, this.capacity() * C.finance.creditLineShareOfCapacity);
  }

  // ------------------------------------------------------------------ equity
  /** Company equity value: EBITDA multiple adjusted by sentiment, plus cash, minus debt. */
  equityValue(): number {
    const s = this.s;
    const r = this.results();
    const E = C.equity;
    const sentiment = 0.75 + 0.5 * (s.reputation / 100) + (s.equity.confidence - 0.5) * 0.2 + 0.03 * this.sim.empire.lvl('ir');
    const ev = r.ebitda > 0 ? r.ebitda * E.ebitdaMultiple * sentiment : Math.max(0, r.revenue * E.revenueMultipleFloor);
    const assets = this.assetsValue();
    // Sandbox cash is unlimited, so it does not count towards the company value there
    const cash = this.sim.isSandbox() ? 0 : s.cashUSD;
    return Math.max(1e6, ev + cash - this.debt() + this.ownedBookValue() * 0.25 + assets);
  }

  private assetsValue(): number {
    const a = this.s.assets;
    let v = 0;
    for (const h of a.hotels) v += C.hotels.sizes[h.size].buildUSD * C.hotels.resaleShare;
    for (const [icao, pct] of Object.entries(a.airports)) v += this.airportValue(icao) * pct;
    for (const [id, pct] of Object.entries(this.s.holdings.stakes)) if (!this.s.holdings.owned[id]) v += (this.rivalFin(id)?.valueUSD ?? 0) * pct;
    for (const id of Object.keys(this.s.holdings.owned)) v += this.rivalFin(id)?.valueUSD ?? 0;
    return v;
  }

  fundamentalPrice(): number {
    return this.equityValue() / this.s.equity.shares;
  }

  private ipoCheck(): { ok: boolean; reason: string } {
    const s = this.s;
    if (s.equity.listed) return { ok: false, reason: 'Already listed' };
    if (this.sim.isSandbox()) return { ok: true, reason: '' };
    const r = this.results();
    if (r.revenue < C.equity.ipoMinAnnualRevenueUSD) return { ok: false, reason: 'revenue' };
    if (r.ebitda <= 0) return { ok: false, reason: 'Investors want a profitable airline: get EBITDA positive first' };
    return { ok: true, reason: '' };
  }

  /** The board blocks big spending when it has lost confidence and you no longer hold a majority. */
  blocked(costUSD: number): string | null {
    const e = this.s.equity;
    if (!e.listed || this.s.time > e.blockedUntil) return null;
    const cap = e.shares * e.price;
    return costUSD > cap * C.equity.boardBlockShareOfValue ? `The board blocks spending over ${(cap * C.equity.boardBlockShareOfValue / 1e6).toFixed(0)}M until it trusts you again` : null;
  }

  // ------------------------------------------------------------------ rivals
  rivalFin(id: string): { valueUSD: number; profitYearUSD: number; revenueYearUSD: number } | undefined {
    const m = this.sim.month();
    if (m !== this.rivalCacheMonth) {
      this.rivalCache.clear();
      this.rivalCacheMonth = m;
    }
    let f = this.rivalCache.get(id);
    if (f) return f;
    const r = this.s.rivals.find((x) => x.id === id);
    if (!r) return undefined;
    const R = C.rivals;
    let rev = 0;
    for (const rt of r.routes) {
      const A = AIRPORTS[rt.a];
      const B = AIRPORTS[rt.b];
      if (!A || !B) continue;
      rev += rt.freq * 2 * r.seats * R.loadFactor * refFares(distanceKm(A, B)).y * R.fareMixFactor * rt.fare;
    }
    rev *= 52;
    const margin = (R.margins as Record<string, number>)[r.model] ?? 0.05;
    const q = 0.8 + r.quality * 0.4;
    f = { revenueYearUSD: rev, profitYearUSD: rev * margin * q, valueUSD: rev * R.valueRevenueMultiple * q };
    this.rivalCache.set(id, f);
    return f;
  }

  invalidateRivals(): void {
    this.rivalCacheMonth = '';
  }

  /** How much a rival's capacity competes with you on a route: 0 owned, 0.5 allied (codeshare), 1 otherwise. */
  rivalWeight(id: string): number {
    const h = this.s.holdings;
    if (h.owned[id]) return 0;
    if (h.alliance?.members.includes(id)) return C.alliance.codeshareCapacityWeight;
    return 1;
  }

  friendly(id: string): boolean {
    return this.rivalWeight(id) < 1;
  }

  private overlap(r: Rival): number {
    const mine = new Set(this.s.routes.map((x) => pairKey(x.a, x.b)));
    return r.routes.filter((rt) => mine.has(pairKey(rt.a, rt.b))).length;
  }

  // ------------------------------------------------------------------ demand / cost effects used by the sim
  /** Connecting traffic at your base, plus the alliance boost on routes to members' hubs. */
  demandBoost(a: string, b: string): number {
    const s = this.s;
    let m = 1;
    if (a === s.base || b === s.base) {
      const n = s.routes.filter((r) => r.a === s.base || r.b === s.base).length;
      m += Math.min(C.connecting.max, C.connecting.perSqrtRoute * Math.sqrt(n));
    }
    const al = s.holdings.alliance;
    if (al?.members.length) {
      const hubs = new Set(s.rivals.filter((r) => al.members.includes(r.id)).flatMap((r) => r.hubs));
      if (hubs.has(a) || hubs.has(b)) m += C.alliance.demandBoost;
    }
    return m;
  }

  /** Business-class demand boost from your lounges at either end. */
  jBoost(a: string, b: string): number {
    let best = 0;
    for (const l of this.s.assets.lounges) if (l.icao === a || l.icao === b) best = Math.max(best, C.lounges[l.level - 1].jBoost);
    return 1 + best;
  }

  /** Airport-fee discount where you control the airport. */
  feeFactor(icao: string): number {
    return (this.s.assets.airports[icao] ?? 0) >= 0.5 ? 1 - C.airports.controlFeeDiscount : 1;
  }

  comfortBonus(): number {
    let b = 0;
    for (const l of this.s.assets.lounges) b = Math.max(b, C.lounges[l.level - 1].comfort);
    if (this.s.holdings.alliance?.members.length) b += C.alliance.comfortBonus;
    return b;
  }

  // ------------------------------------------------------------------ cargo
  static refCargoRate(km: number): number {
    const G = C.cargo;
    const k = km > G.longHaulKm ? G.longHaulKm + (km - G.longHaulKm) * G.longHaulFactor : km;
    return Math.max(G.minRatePerKg, (G.ratePerTonneKm * k) / 1000);
  }

  /** Belly cargo carried on a passenger flight: tonnes and revenue. */
  bellyCargo(t: AircraftType, km: number): { tonnes: number; revenue: number } {
    const G = C.cargo;
    const cap = (G.bellyTonnes as Record<string, number>)[t.category] ?? 0;
    if (!cap) return { tonnes: 0, revenue: 0 };
    const fill = (G.bellyFill[0] + this.sim.rand() * (G.bellyFill[1] - G.bellyFill[0])) * (1 + 0.08 * this.sim.empire.lvl('cargo'));
    const tonnes = cap * fill;
    return { tonnes, revenue: tonnes * 1000 * Corporate.refCargoRate(km) };
  }

  /** Average belly cargo per flight (for quotes). */
  expectedBelly(t: AircraftType, km: number): { tonnes: number; revenue: number } {
    const G = C.cargo;
    const cap = (G.bellyTonnes as Record<string, number>)[t.category] ?? 0;
    const tonnes = cap * ((G.bellyFill[0] + G.bellyFill[1]) / 2) * (1 + 0.08 * this.sim.empire.lvl('cargo'));
    return { tonnes, revenue: tonnes * 1000 * Corporate.refCargoRate(km) };
  }

  /** Weekly freight demand for your freighters on a pair at a given rate. */
  cargoDemand(a: string, b: string, capacityWeek: number, ratePerKg: number): { tonnes: number; fill: number } {
    const G = C.cargo;
    const A = AIRPORTS[a];
    const B = AIRPORTS[b];
    if (!A || !B || capacityWeek <= 0) return { tonnes: 0, fill: 0 };
    const market = marketWeekly(A, B) * G.tonnesPerWeeklyPax * (1 + 0.1 * this.sim.empire.lvl('cargo'));
    const ref = Corporate.refCargoRate(distanceKm(A, B));
    const w = capacityWeek * Math.pow(Math.max(ratePerKg, 0.01) / ref, -G.elasticity * 2);
    const share = w / (w + market);
    const tonnes = Math.min(capacityWeek, market * share * 1.6);
    return { tonnes, fill: tonnes / capacityWeek };
  }

  // ------------------------------------------------------------------ assets
  airportValue(icao: string): number {
    const A = AIRPORTS[icao];
    if (!A) return 0;
    return Math.max(C.airports.minValueUSD, A.market * C.airports.annualPaxPerMarket * C.airports.valuePerAnnualPaxUSD);
  }

  /** Your passengers per month through an airport, from the last 30 days of route stats. */
  private paxThrough(icao: string): number {
    let p = 0;
    for (const r of this.s.routes) {
      if (r.a !== icao && r.b !== icao) continue;
      const days = Math.max(1, (this.s.time - r.last30.since) / DAY);
      p += ((r.last30.paxY + r.last30.paxJ) * 30) / days;
    }
    return p;
  }

  private hotelMonth(h: { icao: string; size: number }): { occupancy: number; revenue: number; cost: number } {
    const H = C.hotels;
    const A = AIRPORTS[h.icao];
    const rooms = H.sizes[h.size].rooms;
    const adr = H.adrBaseUSD + H.adrPerSqrtMarket * Math.sqrt(A?.market ?? 1) * (A?.tourism ?? 1);
    const occupancy = clamp(0.42 + 0.03 * Math.min(A?.market ?? 1, 10) + 0.3 * Math.min(1, this.paxThrough(h.icao) / (rooms * 30 * 6)), 0.3, 0.92);
    const revenue = rooms * 30 * adr * occupancy;
    return { occupancy, revenue, cost: revenue * H.costShare + rooms * H.fixedPerRoomMonthUSD };
  }

  // ------------------------------------------------------------------ daily and monthly
  newDay(): void {
    const s = this.s;
    // credit line safety net
    if (s.finance.autoDraw && s.cashUSD < 0) {
      const room = this.creditLimit() - s.finance.creditDrawnUSD;
      const need = Math.min(room, -s.cashUSD + 1e6);
      if (need > 0) {
        s.finance.creditDrawnUSD += need;
        this.sim.book('loanIn', need);
        this.sim.log(`Drew ${(need / 1e6).toFixed(1)}M from the credit line to cover negative cash.`, 'warn');
      }
    }
    this.priceDay();
    this.bidDay();
    this.charterDay();
    this.strikeDay();
  }

  private priceDay(): void {
    const e = this.s.equity;
    const E = C.equity;
    const f = this.fundamentalPrice();
    if (!e.price) e.price = f;
    const g = Math.sqrt(-2 * Math.log(this.sim.rand() + 1e-9)) * Math.cos(2 * Math.PI * this.sim.rand());
    const vol = (e.listed ? E.dailyVolatility : E.dailyVolatility * 0.3) * (1 - 0.25 * this.sim.empire.lvl('ir'));
    e.price = Math.max(0.01, e.price + E.reversionPerDay * (f - e.price) + vol * e.price * g);
    const last = e.history[e.history.length - 1];
    if (!last || this.s.time - last.t > 2 * DAY) {
      e.history.push({ t: this.s.time, p: e.price });
      if (e.history.length > 400) e.history.shift();
    }
  }

  monthEnd(): void {
    const s = this.s;
    // loans
    let interest = 0;
    let principal = 0;
    for (const l of s.finance.loans) {
      const i = (l.balanceUSD * l.ratePerYear) / 12;
      const p = Math.min(l.balanceUSD, Math.max(0, l.paymentUSD - i));
      interest += i;
      principal += p;
      l.balanceUSD -= p;
      l.monthsLeft--;
    }
    s.finance.loans = s.finance.loans.filter((l) => l.balanceUSD > 1 && l.monthsLeft > 0);
    interest += (s.finance.creditDrawnUSD * (this.rate() + C.finance.creditLineExtraSpread)) / 12;
    if (interest) this.sim.book('interest', interest);
    if (principal) this.sim.book('loanRepayment', principal);
    // covenant
    const r = this.results();
    const debt = this.debt();
    if (debt > 0 && (r.ebitda <= 0 || debt / r.ebitda > C.finance.covenantMaxDebtToEbitda) && r.months > 0) {
      s.finance.breaches++;
      this.sim.log(`Loan covenant breached (debt ${(debt / 1e6).toFixed(0)}M vs EBITDA ${(r.ebitda / 1e6).toFixed(0)}M). Banks add ${C.finance.breachPenaltySpread * 100}% to your rates.`, 'bad');
      if (s.finance.breaches >= 3 && s.finance.creditDrawnUSD > 0) {
        const pay = Math.min(s.finance.creditDrawnUSD, Math.max(0, s.cashUSD));
        s.finance.creditDrawnUSD -= pay;
        this.sim.book('loanRepayment', pay);
        this.sim.log('The banks have called in part of your credit line.', 'bad');
      }
    } else s.finance.breaches = 0;

    // stakes, subsidiaries, assets
    let inv = 0;
    let subs = 0;
    for (const [id, pct] of Object.entries(s.holdings.stakes)) {
      if (s.holdings.owned[id]) continue;
      inv += ((this.rivalFin(id)?.profitYearUSD ?? 0) / 12) * pct * C.rivals.stakeDividendPayout;
    }
    for (const id of Object.keys(s.holdings.owned)) subs += (this.rivalFin(id)?.profitYearUSD ?? 0) / 12;
    for (const [icao, pct] of Object.entries(s.assets.airports)) inv += (this.airportValue(icao) * C.airports.yieldPerYear * pct) / 12;
    if (inv > 0) this.sim.book('investmentIncome', inv);
    if (subs > 0) this.sim.book('subsidiaryIncome', subs);
    else if (subs < 0) this.sim.book('assetCosts', -subs);
    let aInc = 0;
    let aCost = 0;
    for (const l of s.assets.lounges) {
      const L = C.lounges[l.level - 1];
      aInc += this.paxThrough(l.icao) * L.feePerPax;
      aCost += L.monthUSD;
    }
    for (const h of s.assets.hotels) {
      const m = this.hotelMonth(h);
      aInc += m.revenue;
      aCost += m.cost;
    }
    if (aInc) this.sim.book('assetIncome', aInc);
    if (aCost) this.sim.book('assetCosts', aCost);

    // dividends from last month's net profit (paid out of company cash)
    const e = s.equity;
    const net = r.net / 12;
    if (e.payout > 0 && net > 0 && s.cashUSD > 0) {
      const div = Math.min(net * e.payout, s.cashUSD * 0.5);
      this.sim.book('dividends', div);
      const mine = div * (e.playerShares / e.shares);
      s.personal.cashUSD += mine;
      this.sim.log(`Dividend paid: ${(div / 1e6).toFixed(2)}M (you receive ${(mine / 1e6).toFixed(2)}M personally).`, 'good');
    }
    this.boardMonth();
    this.allianceMonth();
    this.invalidateRivals();
  }

  private boardMonth(): void {
    const s = this.s;
    const e = s.equity;
    if (!e.listed) return;
    const r = this.results();
    const pax = this.weeklyPax();
    if (e.demand && s.time >= e.demand.deadline) {
      const d = e.demand;
      const met = d.kind === 'profit' ? r.net > 0 : d.kind === 'dividend' ? e.payout >= d.target : d.kind === 'debt' ? (r.ebitda > 0 ? this.debt() / r.ebitda : 99) <= d.target : pax >= d.target;
      e.confidence = clamp(e.confidence + (met ? 0.15 : -0.25), 0, 1);
      e.price *= met ? 1.03 : 0.95;
      this.sim.log(met ? `The board is pleased: "${d.text}" achieved.` : `The board is unhappy: "${d.text}" was missed.`, met ? 'good' : 'bad');
      e.demand = null;
      if (!met && e.confidence < 0.25 && e.playerShares / e.shares < 0.5) {
        e.blockedUntil = s.time + 90 * DAY;
        this.sim.log('With no majority and little trust, the board now blocks large purchases for 3 months.', 'bad');
      }
    }
    if (!e.demand && s.time >= e.nextDemandAt) {
      const lev = r.ebitda > 0 ? this.debt() / r.ebitda : 0;
      const M = 30 * DAY;
      if (r.net < 0) e.demand = { kind: 'profit', text: 'Return to a net profit within 6 months', start: s.time, deadline: s.time + 6 * M, target: 0 };
      else if (lev > 4) e.demand = { kind: 'debt', text: 'Cut debt below 3.5× EBITDA within 9 months', start: s.time, deadline: s.time + 9 * M, target: 3.5 };
      else if (e.payout < 0.2) e.demand = { kind: 'dividend', text: 'Pay at least 20% of profit as dividends within 3 months', start: s.time, deadline: s.time + 3 * M, target: 0.2 };
      else e.demand = { kind: 'growth', text: 'Grow weekly passengers by 15% within 12 months', start: s.time, deadline: s.time + 12 * M, target: Math.round(pax * 1.15) };
      e.nextDemandAt = s.time + C.equity.boardDemandEveryMonths * M;
      this.sim.log(`The board asks: ${e.demand.text}.`, 'warn');
    }
  }

  private weeklyPax(): number {
    let p = 0;
    for (const r of this.s.routes) {
      const days = Math.max(1, (this.s.time - r.last30.since) / DAY);
      p += ((r.last30.paxY + r.last30.paxJ) * 7) / days;
    }
    return p;
  }

  private allianceMonth(): void {
    const s = this.s;
    const al = s.holdings.alliance;
    if (!al?.members.length || s.reputation >= 40) return;
    if (this.sim.rand() < 0.3) {
      const id = al.members[Math.floor(this.sim.rand() * al.members.length)];
      al.members = al.members.filter((x) => x !== id);
      this.sim.log(`${this.rivalName(id)} leaves ${al.name}: your reputation is too low.`, 'bad');
    }
  }

  private rivalName(id: string): string {
    return this.s.rivals.find((r) => r.id === id)?.name ?? id;
  }

  // ------------------------------------------------------------------ takeovers
  private bidDay(): void {
    const s = this.s;
    const b = s.holdings.bid;
    if (!b || s.time < b.decideAt) return;
    s.holdings.bid = null;
    const r = s.rivals.find((x) => x.id === b.rivalId);
    if (!r) return;
    const stake = s.holdings.stakes[r.id] ?? 0;
    const rank = this.rivalRank(r.id);
    const p = clamp(0.1 + b.premium * 1.8 + stake * 0.8 + (s.reputation - 50) / 200 - r.aggression * 0.2 - (rank <= 3 ? 0.2 : 0) + 0.05 * this.sim.empire.lvl('legal'), 0.02, 0.95);
    if (this.sim.rand() > p) {
      this.sim.log(`${r.name}'s board rejected your offer (premium ${Math.round(b.premium * 100)}%). Try a higher premium or build a bigger stake first.`, 'bad');
      return;
    }
    // competition regulator
    const ov = this.overlap(r);
    const big = rank <= 3 && this.playerRank() <= 5;
    const block = clamp((ov - C.rivals.regulatorBlockOverlap) / 30 + (big ? 0.25 : 0), 0, 0.8) * (1 - 0.3 * this.sim.empire.lvl('legal'));
    if (this.sim.rand() < block) {
      this.sim.log(`The competition regulator blocked your takeover of ${r.name} (${ov} overlapping routes).`, 'bad');
      return;
    }
    const cost = (this.rivalFin(r.id)?.valueUSD ?? 0) * (1 - stake) * (1 + b.premium);
    if (!this.sim.isSandbox() && s.cashUSD < cost) {
      this.sim.log(`${r.name} accepted, but you no longer have the ${(cost / 1e6).toFixed(0)}M in cash. The deal collapsed.`, 'bad');
      return;
    }
    this.sim.book('investments', cost);
    if (ov >= C.rivals.regulatorRemedyOverlap) {
      const mine = new Set(s.routes.map((x) => pairKey(x.a, x.b)));
      const before = r.routes.length;
      r.routes = r.routes.filter((rt) => !mine.has(pairKey(rt.a, rt.b)));
      this.sim.log(`Regulator remedy: ${r.name} gives up ${before - r.routes.length} routes that overlap with yours.`, 'warn');
    }
    s.holdings.stakes[r.id] = 1;
    s.holdings.owned[r.id] = b.mode;
    if (s.holdings.alliance) s.holdings.alliance.members = s.holdings.alliance.members.filter((x) => x !== r.id);
    if (b.mode === 'merge') {
      for (const hub of r.hubs) {
        if (s.slots[hub] !== undefined || hub === 'EGLL' || hub === 'EGKK') s.slots[hub] = (s.slots[hub] ?? 0) + C.rivals.mergeSlotsPerHub;
      }
      for (const d of Object.values(s.staff)) d.morale = clamp(d.morale - C.rivals.mergeMoraleHit, 0, 1);
      this.sim.log(`You now own ${r.name}. Its network and slots merge into yours; staff morale takes a hit during integration.`, 'good');
    } else this.sim.log(`You now own ${r.name}. It keeps flying under its own brand and sends you its profits.`, 'good');
    this.sim.reindexRivals();
    this.invalidateRivals();
  }

  private rivalRank(id: string): number {
    const list = this.s.rivals.map((r) => ({ id: r.id, v: this.rivalFin(r.id)?.revenueYearUSD ?? 0 })).sort((a, b) => b.v - a.v);
    return list.findIndex((x) => x.id === id) + 1;
  }

  private playerRank(): number {
    const mine = this.results().revenue;
    return this.s.rivals.filter((r) => (this.rivalFin(r.id)?.revenueYearUSD ?? 0) > mine).length + 1;
  }

  /** Merged rivals' passengers count as yours in the world ranking. */
  mergedWeeklyPax(): number {
    let p = 0;
    for (const [id, mode] of Object.entries(this.s.holdings.owned)) {
      if (mode !== 'merge') continue;
      const r = this.s.rivals.find((x) => x.id === id);
      if (r) p += r.routes.reduce((x, rt) => x + rt.freq * 2 * r.seats * C.rivals.loadFactor, 0);
    }
    return p;
  }

  // ------------------------------------------------------------------ charters
  private charterDay(): void {
    const s = this.s;
    s.charters.offers = s.charters.offers.filter((o) => o.expiresAt > s.time);
    if (s.charters.offers.length < C.charter.maxOffers && this.sim.rand() < (C.charter.offersPerMonth * (1 + 0.4 * this.sim.empire.lvl('charter'))) / 30) {
      const o = this.makeOffer();
      if (o) {
        s.charters.offers.push(o);
        this.sim.log(`Charter request: ${o.client}, ${o.kind === 'acmi' ? `${o.months} months wet lease` : `${AIRPORTS[o.from]?.iata}–${AIRPORTS[o.to]?.iata}, ${o.pax} passengers`}, pays ${(o.payUSD / 1e6).toFixed(2)}M.`, 'info');
      }
    }
  }

  private pick<T>(a: T[]): T {
    return a[Math.floor(this.sim.rand() * a.length)];
  }

  private between(r: number[]): number {
    return r[0] + this.sim.rand() * (r[1] - r[0]);
  }

  makeOffer(kindIn?: CharterKind): CharterOffer | null {
    const s = this.s;
    const K = C.charter.kinds;
    const kinds: CharterKind[] = ['sports', 'tour', 'tour', 'government', 'vip', 'acmi'];
    const kind = kindIn ?? this.pick(kinds);
    const from = s.base;
    const id = this.sim.id('ch');
    const expiresAt = s.time + this.between(C.charter.expiryDays) * DAY;
    if (kind === 'acmi') {
      const months = Math.round(this.between(K.acmi.months));
      const client = this.pick(s.rivals.filter((r) => !s.holdings.owned[r.id])).name;
      const t = TYPES.a320neo;
      return { id, kind, client, from, to: from, pax: 150, departAt: s.time + 3 * DAY, stayDays: 0, months, payUSD: Math.round(t.leaseMonthUSD * K.acmi.payLeaseFactor * months), expiresAt, needsVip: false, km: 0 };
    }
    const k = K[kind] as { clients: string[]; pax: number[]; km: number[]; stayDays: number[]; margin: number[]; needsVip?: boolean; tourism?: number };
    const A = AIRPORTS[from];
    const cands = Object.values(AIRPORTS).filter((b) => {
      if (b.icao === from || b.runwayM < 1800 || b.market < 0.5) return false;
      const km = distanceKm(A, b);
      return km >= k.km[0] && km <= k.km[1] && (!k.tourism || b.tourism >= k.tourism);
    });
    if (!cands.length) return null;
    const B = this.pick(cands);
    const km = distanceKm(A, B);
    const pax = Math.round(this.between(k.pax));
    const t = k.needsVip ? TYPES.gl7t ?? TYPES.a320neo : km > 6000 ? TYPES.a339 ?? TYPES.a320neo : TYPES.a320neo;
    const stayDays = Math.round(this.between(k.stayDays));
    const legCost = Object.values(this.sim.flightCost(t, km, from, B.icao, pax)).reduce((x, y) => x + y, 0);
    const legs = Corporate.charterLegs(stayDays);
    const busyDays = Corporate.busyDays(km, t, stayDays);
    const pay = Math.round(((legs * legCost) + busyDays * (t.leaseMonthUSD / 30) * C.charter.dailyRateLeaseFactor) * (1 + this.between(k.margin) + 0.1 * this.sim.empire.lvl('charter')) / 1000) * 1000;
    return {
      id, kind, client: this.pick(k.clients), from, to: B.icao, pax, departAt: s.time + this.between([3, 20]) * DAY, stayDays,
      months: 0, payUSD: pay, expiresAt, needsVip: !!k.needsVip, km,
    };
  }

  /** Long stays: the aircraft flies home empty and comes back to collect (4 legs); short stays it waits (2 legs). */
  static charterLegs(stayDays: number): number {
    return stayDays > 2 ? 4 : 2;
  }

  static busyDays(km: number, t: AircraftType, stayDays: number): number {
    return (Corporate.charterLegs(stayDays) * blockHours(km, t)) / 24 + (stayDays > 2 ? 1 : stayDays);
  }

  private suits(o: CharterOffer, ac: FleetAircraft): string | null {
    const t = TYPES[ac.typeId];
    if (ac.routeId) return `${ac.reg} flies a route: take it off the route first`;
    if (ac.status !== 'idle') return `${ac.reg} is not available (${ac.status})`;
    if (t.cargoT) return 'Freighters cannot fly passenger charters';
    if (o.kind === 'acmi') return t.role === 'airliner' && seatsOf(t, ac).total >= 120 ? null : 'Wet leases need an airliner with 120+ seats';
    if (o.needsVip && !(t.role === 'vip' || t.role === 'bizjet' || ac.cabin?.mode === 'free')) return 'This client wants a VIP cabin or a business jet';
    if (seatsOf(t, ac).total < o.pax) return `Not enough seats (${seatsOf(t, ac).total} < ${o.pax})`;
    if (t.rangeKm < o.km) return `Out of range (${t.rangeKm} km)`;
    if ((AIRPORTS[o.to]?.runwayM ?? 9999) < t.runwayM) return 'Runway too short at the destination';
    return null;
  }

  completeJob(ac: FleetAircraft): void {
    const s = this.s;
    const job = s.charters.active.find((j) => j.aircraftId === ac.id);
    ac.status = 'idle';
    ac.nextAt = 0;
    if (!job) return;
    s.charters.active = s.charters.active.filter((j) => j !== job);
    const t = TYPES[ac.typeId];
    let cost = 0;
    if (job.kind === 'acmi') {
      cost = job.months * (this.sim.staffCostPerAircraft(t) + 300 * t.maintPerHrUSD);
      this.sim.book('crew', cost);
      ac.hours += job.months * 300;
    } else {
      const legs: [string, string, number][] = [[job.from, job.to, job.pax], [job.to, job.from, job.pax]];
      if (Corporate.charterLegs(job.stayDays) === 4) legs.push([job.to, job.from, 0], [job.from, job.to, 0]);
      if (ac.location !== job.from) legs.unshift([ac.location, job.from, 0]);
      for (const [a, b, pax] of legs) {
        const km = distanceKm(AIRPORTS[a], AIRPORTS[b]);
        for (const [cat, v] of Object.entries(this.sim.flightCost(t, km, a, b, pax, ac))) {
          if (job.flown && a === job.from && pax > 0) continue; // you flew the outbound leg yourself: already booked
          this.sim.book(cat as LedgerCategory, v);
          cost += v;
        }
        ac.hours += blockHours(km, t);
      }
      ac.location = job.from;
    }
    const pay = job.payUSD * (job.flown ? 1 + C.charter.selfFlyBonus : 1);
    this.sim.book('charterRevenue', pay);
    this.sim.empire.unlock('charter');
    this.sim.log(`Charter for ${job.client} completed: earned ${(pay / 1e6).toFixed(2)}M, costs ${(cost / 1e6).toFixed(2)}M.`, 'good');
  }

  /** You flew a charter leg yourself (from the cockpit). Returns the job if it matched. */
  flownLeg(from: string, to: string): CharterJob | null {
    const job = this.s.charters.active.find((j) => j.selfFly && !j.flown && j.from === from && j.to === to);
    if (job) job.flown = true;
    return job ?? null;
  }

  // ------------------------------------------------------------------ strikes
  private targetMorale(d: Dept): number {
    const st = this.s.staff[d];
    return 0.62 + 0.9 * (st.pay - 1) + 0.6 * Math.min(0.25, st.staffing - 1);
  }

  strikesMonth(): void {
    const s = this.s;
    for (const [d, st] of Object.entries(s.staff) as [Dept, (typeof s.staff)[Dept]][]) {
      if (d === 'hq' || st.required === 0 || st.morale >= C.strikes.moraleThreshold) continue;
      if (s.strikes.some((x) => x.dept === d)) continue;
      s.strikes.push({ dept: d, stage: 'warning', until: s.time + C.strikes.warningDays * DAY });
      this.sim.log(`${DEPT_LABEL[d]} union warning: improve pay within ${C.strikes.warningDays} days or they ballot for a strike.`, 'bad');
    }
  }

  private strikeDay(): void {
    const s = this.s;
    const K = C.strikes;
    for (const x of [...s.strikes]) {
      if (s.time < x.until) continue;
      const label = DEPT_LABEL[x.dept];
      if (x.stage === 'warning' || x.stage === 'ballot') {
        if (this.targetMorale(x.dept) >= K.satisfiedMorale) {
          s.strikes = s.strikes.filter((y) => y !== x);
          this.sim.log(`${label}: the union accepts your offer. No strike.`, 'good');
          continue;
        }
        if (x.stage === 'warning') {
          x.stage = 'ballot';
          x.until = s.time + K.ballotDays * DAY;
          this.sim.log(`${label} are balloting for strike action.`, 'bad');
        } else {
          const days = Math.round(this.between(K.strikeDays));
          x.stage = 'strike';
          x.until = s.time + days * DAY;
          s.events.push({
            id: `strike_${x.dept}`, until: x.until, scope: 'all', delayProb: (K.delayProb as Record<string, number>)[x.dept] ?? 0,
            cancelShare: (K.cancelShare as Record<string, number>)[x.dept] ?? 0, demandMult: 1, text: `${label} on strike for ${days} days`,
          });
          s.reputation = clamp(s.reputation - 3, 0, 100);
          this.sim.log(`${label} are on strike for ${days} days! Expect cancellations.`, 'bad');
        }
      } else {
        s.strikes = s.strikes.filter((y) => y !== x);
        s.staff[x.dept].morale = clamp(s.staff[x.dept].morale + K.afterStrikeMorale, 0, 1);
        this.sim.log(`${label} strike is over.`, 'info');
      }
    }
  }

  // ------------------------------------------------------------------ commands
  command(c: Command): Result | null {
    const s = this.s;
    const sandbox = this.sim.isSandbox();
    const canPay = (usd: number) => sandbox || s.cashUSD >= usd;
    const M = (usd: number) => `${(usd / 1e6).toFixed(1)}M`;
    switch (c.kind) {
      // ---- debt
      case 'takeLoan': {
        if (!(C.finance.terms as number[]).includes(c.termMonths)) return { ok: false, msg: 'Pick a loan term' };
        if (c.amountUSD <= 0) return { ok: false, msg: 'Enter an amount' };
        const room = this.capacity() - this.debt();
        if (c.amountUSD > room) return { ok: false, msg: `Banks will lend at most ${M(Math.max(0, room))} more at your rating (${this.rating().name})` };
        const r = this.rate() / 12;
        const n = c.termMonths;
        const payment = (c.amountUSD * r) / (1 - Math.pow(1 + r, -n));
        s.finance.loans.push({ id: this.sim.id('ln'), principalUSD: c.amountUSD, balanceUSD: c.amountUSD, ratePerYear: this.rate(), termMonths: n, monthsLeft: n, paymentUSD: payment, takenAt: s.time });
        this.sim.book('loanIn', c.amountUSD);
        this.sim.log(`Borrowed ${M(c.amountUSD)} over ${n / 12} years at ${(this.rate() * 100).toFixed(1)}%.`, 'info');
        return { ok: true, msg: `Loan of ${M(c.amountUSD)} received` };
      }
      case 'repayLoan': {
        const l = s.finance.loans.find((x) => x.id === c.loanId);
        if (!l) return { ok: false, msg: 'No such loan' };
        const amt = Math.min(l.balanceUSD, c.amountUSD);
        if (!canPay(amt)) return { ok: false, msg: 'Not enough cash' };
        l.balanceUSD -= amt;
        this.sim.book('loanRepayment', amt);
        if (l.balanceUSD < 1) s.finance.loans = s.finance.loans.filter((x) => x !== l);
        else l.paymentUSD = (l.balanceUSD * (l.ratePerYear / 12)) / (1 - Math.pow(1 + l.ratePerYear / 12, -Math.max(1, l.monthsLeft)));
        return { ok: true, msg: `Repaid ${M(amt)}` };
      }
      case 'drawCredit': {
        const room = this.creditLimit() - s.finance.creditDrawnUSD;
        const amt = Math.min(room, c.amountUSD);
        if (amt <= 0) return { ok: false, msg: 'The credit line is fully drawn' };
        s.finance.creditDrawnUSD += amt;
        this.sim.book('loanIn', amt);
        return { ok: true, msg: `Drew ${M(amt)} from the credit line` };
      }
      case 'repayCredit': {
        const amt = Math.min(s.finance.creditDrawnUSD, c.amountUSD, Math.max(0, s.cashUSD));
        if (amt <= 0) return { ok: false, msg: 'Nothing to repay (or no cash)' };
        s.finance.creditDrawnUSD -= amt;
        this.sim.book('loanRepayment', amt);
        return { ok: true, msg: `Repaid ${M(amt)} of the credit line` };
      }
      case 'setAutoDraw':
        s.finance.autoDraw = c.on;
        return { ok: true, msg: c.on ? 'The credit line now covers negative cash automatically' : 'Automatic credit line draws off' };
      case 'saleLeaseback': {
        const ac = s.fleet.find((x) => x.id === c.aircraftId);
        if (!ac || ac.ownership !== 'owned' || ac.status === 'ordered') return { ok: false, msg: 'Only delivered, owned aircraft can be sold and leased back' };
        const t = TYPES[ac.typeId];
        const price = ac.bookValueUSD * C.finance.saleLeasebackPriceShare;
        ac.ownership = 'leased';
        ac.leaseMonthUSD = Math.round(t.leaseMonthUSD * C.finance.saleLeasebackLeaseFactor * Math.max(0.4, 1 - ac.ageYears * 0.03));
        ac.leaseStart = s.time;
        ac.bookValueUSD = 0;
        this.sim.book('aircraftSales', price);
        this.sim.log(`Sale and leaseback: ${ac.reg} sold for ${M(price)} and leased back at ${(ac.leaseMonthUSD / 1000).toFixed(0)}k a month.`, 'info');
        return { ok: true, msg: `Raised ${M(price)}` };
      }
      // ---- equity
      case 'ipo': {
        const chk = this.ipoCheck();
        if (!chk.ok) return { ok: false, msg: chk.reason === 'revenue' ? 'Not enough annual revenue for an IPO yet' : chk.reason };
        const f = clamp(c.float, C.equity.minFloat, C.equity.maxFloat);
        const e = s.equity;
        const price = this.fundamentalPrice() * C.equity.ipoDiscount;
        const total = e.shares / (1 - f);
        const fresh = total - e.shares;
        const raise = fresh * price * (1 - C.equity.ipoFees);
        e.shares = total;
        e.listed = true;
        e.ipoAt = s.time;
        e.price = price;
        e.confidence = 0.7;
        e.nextDemandAt = s.time + 60 * DAY;
        this.sim.book('equityIn', raise);
        this.sim.log(`${s.airline.name} floats ${Math.round(f * 100)}% on the stock exchange at ${price.toFixed(2)} a share, raising ${M(raise)}.`, 'good');
        return { ok: true, msg: `IPO done: raised ${M(raise)}` };
      }
      case 'setPayout':
        s.equity.payout = clamp(c.payout, 0, 0.8);
        return { ok: true, msg: `Dividend payout set to ${Math.round(s.equity.payout * 100)}% of profit` };
      case 'buyback': {
        const e = s.equity;
        if (!e.listed) return { ok: false, msg: 'Only a listed company can buy back shares' };
        const n = Math.min((e.shares - e.playerShares) * clamp(c.share, 0, 1), e.shares - e.playerShares);
        const cost = n * e.price * 1.02;
        if (!canPay(cost)) return { ok: false, msg: `Needs ${M(cost)}` };
        this.sim.book('buybacks', cost);
        e.shares -= n;
        e.price *= 1.01;
        return { ok: true, msg: `Bought back ${(n / 1e6).toFixed(1)}M shares for ${M(cost)}` };
      }
      case 'secondary': {
        const e = s.equity;
        if (!e.listed) return { ok: false, msg: 'List the company first (IPO)' };
        const n = e.shares * clamp(c.share, 0, C.equity.maxSecondaryShare);
        const raise = n * e.price * 0.95;
        e.shares += n;
        e.price *= 0.97;
        e.confidence = clamp(e.confidence - 0.05, 0, 1);
        this.sim.book('equityIn', raise);
        this.sim.log(`Issued ${(n / 1e6).toFixed(1)}M new shares, raising ${M(raise)}.`, 'info');
        return { ok: true, msg: `Raised ${M(raise)}` };
      }
      case 'sellPersonalShares': {
        const e = s.equity;
        if (!e.listed) return { ok: false, msg: 'Your shares can only be sold after the IPO' };
        const n = e.playerShares * clamp(c.share, 0, 1);
        const proceeds = n * e.price * C.equity.personalSaleDiscount;
        e.playerShares -= n;
        e.price *= 1 - 0.4 * (n / e.shares);
        s.personal.cashUSD += proceeds;
        this.sim.log(`You sold ${(n / 1e6).toFixed(1)}M of your shares for ${M(proceeds)} (now ${Math.round((e.playerShares / e.shares) * 100)}% of the company).`, 'info');
        return { ok: true, msg: `+${M(proceeds)} personal cash` };
      }
      case 'buyPersonalShares': {
        const e = s.equity;
        if (!e.listed) return { ok: false, msg: 'The company is not listed' };
        const free = e.shares - e.playerShares;
        const n = Math.min(free, free * clamp(c.share, 0, 1));
        const cost = n * e.price * 1.02;
        if (s.personal.cashUSD < cost) return { ok: false, msg: `Needs ${M(cost)} of personal cash` };
        s.personal.cashUSD -= cost;
        e.playerShares += n;
        e.price *= 1 + 0.3 * (n / e.shares);
        return { ok: true, msg: `Bought ${(n / 1e6).toFixed(1)}M shares (${Math.round((e.playerShares / e.shares) * 100)}%)` };
      }
      // ---- rivals
      case 'buyStake': {
        const r = s.rivals.find((x) => x.id === c.rivalId);
        if (!r || s.holdings.owned[r.id]) return { ok: false, msg: 'Not available' };
        const had = s.holdings.stakes[r.id] ?? 0;
        const pct = clamp(c.pct, 0, 0.49 - had);
        if (pct <= 0.001) return { ok: false, msg: 'Above 49% you need a takeover bid' };
        const v = this.rivalFin(r.id)!.valueUSD;
        const cost = v * pct * (1 + C.rivals.stakePriceImpact * (had + pct));
        if (!canPay(cost)) return { ok: false, msg: `Needs ${M(cost)}` };
        const block = this.blocked(cost);
        if (block) return { ok: false, msg: block };
        this.sim.book('investments', cost);
        s.holdings.stakes[r.id] = had + pct;
        for (const th of C.rivals.disclosure) if (had < th && had + pct >= th) this.sim.log(`Disclosure: ${s.airline.name} now holds over ${th * 100}% of ${r.name}.`, 'info');
        return { ok: true, msg: `Bought ${Math.round(pct * 100)}% of ${r.name} for ${M(cost)}` };
      }
      case 'sellStake': {
        const had = s.holdings.stakes[c.rivalId] ?? 0;
        if (!had || s.holdings.owned[c.rivalId]) return { ok: false, msg: 'No stake to sell' };
        const pct = clamp(c.pct, 0, had);
        const proceeds = (this.rivalFin(c.rivalId)?.valueUSD ?? 0) * pct * 0.97;
        s.holdings.stakes[c.rivalId] = had - pct;
        if (s.holdings.stakes[c.rivalId] < 0.001) delete s.holdings.stakes[c.rivalId];
        this.sim.book('divestments', proceeds);
        return { ok: true, msg: `Sold for ${M(proceeds)}` };
      }
      case 'bid': {
        const r = s.rivals.find((x) => x.id === c.rivalId);
        if (!r || s.holdings.owned[r.id]) return { ok: false, msg: 'Not available' };
        if (s.holdings.bid) return { ok: false, msg: 'You already have a bid waiting for an answer' };
        const stake = s.holdings.stakes[r.id] ?? 0;
        const premium = clamp(c.premium, 0, 1);
        const cost = (this.rivalFin(r.id)?.valueUSD ?? 0) * (1 - stake) * (1 + premium);
        if (!canPay(cost)) return { ok: false, msg: `A ${Math.round(premium * 100)}% premium needs ${M(cost)} in cash` };
        const block = this.blocked(cost);
        if (block) return { ok: false, msg: block };
        s.holdings.bid = { rivalId: r.id, premium, mode: c.mode, costUSD: cost, decideAt: s.time + C.rivals.bidDays * DAY };
        this.sim.log(`Takeover bid for ${r.name}: ${M(cost)} (${Math.round(premium * 100)}% premium). Their board answers in ${C.rivals.bidDays} days.`, 'info');
        return { ok: true, msg: 'Bid submitted' };
      }
      case 'foundAlliance': {
        if (s.holdings.alliance) return { ok: false, msg: 'You already lead an alliance' };
        if (!sandbox && (s.reputation < C.alliance.minReputation || s.routes.length < C.alliance.minRoutes)) return { ok: false, msg: `Needs reputation ${C.alliance.minReputation}+ and ${C.alliance.minRoutes}+ routes` };
        const name = c.name.trim().slice(0, 32) || `${s.airline.name} Alliance`;
        s.holdings.alliance = { name, members: [] };
        this.sim.log(`You founded ${name}. Invite rival airlines to join.`, 'good');
        return { ok: true, msg: `${name} founded` };
      }
      case 'inviteAlliance': {
        const al = s.holdings.alliance;
        const r = s.rivals.find((x) => x.id === c.rivalId);
        if (!al || !r) return { ok: false, msg: 'Found an alliance first' };
        if (al.members.includes(r.id) || s.holdings.owned[r.id]) return { ok: false, msg: 'Already with you' };
        if (al.members.length >= C.alliance.maxMembers) return { ok: false, msg: 'The alliance is full' };
        if (C.alliance.refusesModels.includes(r.model)) return { ok: false, msg: `${r.name} is a low-cost airline and does not join alliances` };
        if ((s.holdings.inviteCooldown[r.id] ?? 0) > s.time) return { ok: false, msg: `${r.name} said no recently: ask again later` };
        const mine = this.weeklyPax() + this.mergedWeeklyPax();
        const theirs = r.routes.reduce((x, rt) => x + rt.freq * 2 * r.seats * 0.8, 0);
        const p = clamp(0.2 + (s.reputation - 50) / 100 + (mine >= theirs * 0.3 ? 0.2 : 0) + (s.holdings.stakes[r.id] ?? 0) - al.members.length * 0.03, 0.05, 0.9);
        if (sandbox || this.sim.rand() < p) {
          al.members.push(r.id);
          this.sim.log(`${r.name} joins ${al.name}: codeshares and lounge sharing begin.`, 'good');
          return { ok: true, msg: `${r.name} joined` };
        }
        s.holdings.inviteCooldown[r.id] = s.time + C.alliance.inviteCooldownDays * DAY;
        return { ok: false, msg: `${r.name} declined (chance was ${Math.round(p * 100)}%)` };
      }
      case 'leaveAlliance':
        if (!s.holdings.alliance) return { ok: false, msg: 'No alliance' };
        this.sim.log(`${s.holdings.alliance.name} dissolved.`, 'warn');
        s.holdings.alliance = null;
        return { ok: true, msg: 'Alliance dissolved' };
      // ---- assets
      case 'buildLounge': {
        if (!s.routes.some((r) => r.a === c.icao || r.b === c.icao) && c.icao !== s.base) return { ok: false, msg: 'You can only build lounges where you fly' };
        const l = s.assets.lounges.find((x) => x.icao === c.icao);
        const level = (l?.level ?? 0) + 1;
        if (level > C.lounges.length) return { ok: false, msg: 'Already a flagship lounge' };
        const cost = C.lounges[level - 1].buildUSD;
        if (!canPay(cost)) return { ok: false, msg: `Needs ${M(cost)}` };
        this.sim.book('investments', cost);
        if (l) l.level = level;
        else s.assets.lounges.push({ icao: c.icao, level });
        this.sim.log(`${C.lounges[level - 1].label} opened at ${AIRPORTS[c.icao]?.iata || c.icao}.`, 'good');
        return { ok: true, msg: `${C.lounges[level - 1].label} at ${AIRPORTS[c.icao]?.iata}` };
      }
      case 'buildHotel': {
        const H = C.hotels.sizes[c.size];
        if (!H || !AIRPORTS[c.icao]) return { ok: false, msg: 'Pick an airport and a size' };
        if (s.assets.hotels.some((h) => h.icao === c.icao)) return { ok: false, msg: 'You already have a hotel there' };
        if (!canPay(H.buildUSD)) return { ok: false, msg: `Needs ${M(H.buildUSD)}` };
        const block = this.blocked(H.buildUSD);
        if (block) return { ok: false, msg: block };
        this.sim.book('investments', H.buildUSD);
        s.assets.hotels.push({ icao: c.icao, size: c.size, builtAt: s.time });
        this.sim.log(`${H.label} opened at ${AIRPORTS[c.icao]?.name}.`, 'good');
        return { ok: true, msg: 'Hotel opened' };
      }
      case 'sellHotel': {
        const h = s.assets.hotels.find((x) => x.icao === c.icao);
        if (!h) return { ok: false, msg: 'No hotel there' };
        const v = C.hotels.sizes[h.size].buildUSD * C.hotels.resaleShare;
        s.assets.hotels = s.assets.hotels.filter((x) => x !== h);
        this.sim.book('divestments', v);
        return { ok: true, msg: `Hotel sold for ${M(v)}` };
      }
      case 'buyAirportStake': {
        const had = s.assets.airports[c.icao] ?? 0;
        const pct = clamp(c.pct, 0, 1 - had);
        if (pct <= 0) return { ok: false, msg: 'You already own all of it' };
        const cost = this.airportValue(c.icao) * pct;
        if (!canPay(cost)) return { ok: false, msg: `Needs ${M(cost)}` };
        const block = this.blocked(cost);
        if (block) return { ok: false, msg: block };
        this.sim.book('investments', cost);
        s.assets.airports[c.icao] = had + pct;
        if (had < 0.5 && had + pct >= 0.5) {
          s.slots[c.icao] = (s.slots[c.icao] ?? 0) + C.airports.controlSlots;
          this.sim.log(`You now control ${AIRPORTS[c.icao]?.name}: ${Math.round(C.airports.controlFeeDiscount * 100)}% off your fees there and ${C.airports.controlSlots} extra slot pairs.`, 'good');
        }
        return { ok: true, msg: `Bought ${Math.round(pct * 100)}% of ${AIRPORTS[c.icao]?.iata || c.icao} for ${M(cost)}` };
      }
      case 'sellAirportStake': {
        const had = s.assets.airports[c.icao] ?? 0;
        const pct = clamp(c.pct, 0, had);
        if (pct <= 0) return { ok: false, msg: 'No stake' };
        const v = this.airportValue(c.icao) * pct * C.airports.resaleShare;
        s.assets.airports[c.icao] = had - pct;
        if (s.assets.airports[c.icao] < 0.001) delete s.assets.airports[c.icao];
        this.sim.book('divestments', v);
        return { ok: true, msg: `Sold for ${M(v)}` };
      }
      // ---- charters
      case 'acceptCharter': {
        const o = s.charters.offers.find((x) => x.id === c.offerId);
        const ac = s.fleet.find((x) => x.id === c.aircraftId);
        if (!o || !ac) return { ok: false, msg: 'Offer expired' };
        const why = this.suits(o, ac);
        if (why) return { ok: false, msg: why };
        const t = TYPES[ac.typeId];
        const endsAt = o.kind === 'acmi' ? s.time + o.months * 30 * DAY : o.departAt + Corporate.busyDays(o.km, t, o.stayDays) * DAY;
        s.charters.offers = s.charters.offers.filter((x) => x !== o);
        s.charters.active.push({ ...o, aircraftId: ac.id, endsAt, selfFly: c.selfFly && o.kind !== 'acmi', flown: false });
        ac.status = 'charter';
        ac.nextAt = endsAt;
        this.sim.log(`${ac.reg} booked for ${o.client}.`, 'good');
        return { ok: true, msg: `Accepted: ${ac.reg} is busy until ${new Date(endsAt).toISOString().slice(0, 10)}` };
      }
      case 'declineCharter':
        s.charters.offers = s.charters.offers.filter((x) => x.id !== c.offerId);
        return { ok: true, msg: 'Declined' };
      case 'settleStrike': {
        const x = s.strikes.find((y) => y.dept === c.dept);
        const st = s.staff[c.dept];
        st.pay = clamp(st.pay + C.strikes.settlePayRise, 0.7, 1.5);
        st.morale = clamp(st.morale + C.strikes.settleMorale, 0, 1);
        if (x) {
          s.strikes = s.strikes.filter((y) => y !== x);
          s.events = s.events.filter((e) => e.id !== `strike_${c.dept}`);
        }
        this.sim.log(`${DEPT_LABEL[c.dept]}: settled with a ${Math.round(C.strikes.settlePayRise * 100)}% pay rise.`, 'good');
        return { ok: true, msg: 'Settled with the union' };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ snapshot
  view(): CorpView {
    const s = this.s;
    const r = this.results();
    const rt = this.rating();
    const ipo = this.ipoCheck();
    const eqv = this.equityValue();
    const rivals: CorpView['rivals'] = {};
    for (const rv of s.rivals) {
      const f = this.rivalFin(rv.id)!;
      rivals[rv.id] = { ...f, overlap: this.overlap(rv) };
    }
    const lounges: CorpView['assetStats']['lounges'] = {};
    for (const l of s.assets.lounges) lounges[l.icao] = { incomeMonth: this.paxThrough(l.icao) * C.lounges[l.level - 1].feePerPax, costMonth: C.lounges[l.level - 1].monthUSD };
    const hotels: CorpView['assetStats']['hotels'] = {};
    for (const h of s.assets.hotels) {
      const m = this.hotelMonth(h);
      hotels[h.icao] = { occupancy: m.occupancy, profitMonth: m.revenue - m.cost };
    }
    const airportValues: Record<string, number> = {};
    for (const icao of new Set([...Object.keys(s.assets.airports), ...s.routes.flatMap((x) => [x.a, x.b]), s.base])) airportValues[icao] = this.airportValue(icao);
    const e = s.equity;
    const stake = e.playerShares / e.shares;
    const stakeValue = stake * (e.listed ? e.shares * e.price : eqv);
    let cargoT = 0;
    let cargoRev = 0;
    for (const x of s.routes) {
      const days = Math.max(1, (s.time - x.last30.since) / DAY);
      cargoT += ((x.last30.cargoT ?? 0) * 7) / days;
      cargoRev += ((x.last30.cargoRev ?? 0) * 7) / days;
    }
    return {
      revenueYearUSD: r.revenue, ebitdaYearUSD: r.ebitda, netYearUSD: r.net, debtUSD: this.debt(), rating: rt.name, rate: this.rate(),
      capacityUSD: this.capacity(), creditLimitUSD: this.creditLimit(), finance: s.finance, equity: e, equityValueUSD: eqv,
      ipoEligible: ipo.ok, ipoReason: ipo.reason, holdings: s.holdings, rivals, assets: s.assets, assetStats: { lounges, hotels, airportValues },
      charters: s.charters, strikes: s.strikes,
      personal: { cashUSD: s.personal.cashUSD, stake, stakeValueUSD: stakeValue, netWorthUSD: s.personal.cashUSD + stakeValue + this.sim.empire.assetsValue() },
      cargoWeek: { tonnes: cargoT, revenue: cargoRev },
    };
  }
}

export type { Route };
