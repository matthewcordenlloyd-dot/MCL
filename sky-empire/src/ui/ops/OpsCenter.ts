import { AIRPORTS, TYPES, refFares, distanceKm, seatsOf } from '../../economy/Sim';
import { money, ratesSource, toCurrency, fromCurrency, symbol } from '../../economy/currency';
import type { EconomyClient } from '../../economy/EconomyClient';
import type { Currency, LedgerCategory, RouteQuote, Snapshot } from '../../economy/types';
import { Globe } from './Globe';
import { Corporate } from '../../economy/Corporate';
import corpData from '@data/economy/corporate.json';
import empireData from '@data/economy/empire.json';
import hqData from '@data/economy/hq.json';
import achData from '@data/economy/achievements.json';
import type { HqDept, Opportunity } from '../../economy/types';

type Tab = 'overview' | 'map' | 'routes' | 'fleet' | 'market' | 'charters' | 'staff' | 'competition' | 'finances' | 'shares' | 'assets' | 'empire' | 'hq' | 'customise' | 'airline';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['map', 'Route map'], ['routes', 'Routes'], ['fleet', 'Fleet'], ['market', 'Buy & lease'], ['charters', 'Charters & cargo'], ['staff', 'Staff'], ['competition', 'Rivals & M&A'], ['finances', 'Finances & debt'], ['shares', 'Shares & board'], ['assets', 'Lounges, hotels, airports'], ['hq', 'Headquarters'], ['empire', 'Personal empire'], ['customise', 'Customise'], ['airline', 'Airline & saves'],
];
const DEPT_LABEL: Record<string, string> = { pilots: 'Pilots', cabin: 'Cabin crew', engineers: 'Engineers', ground: 'Ground staff', hq: 'Head office' };
const DEPT_SALARY: Record<string, number> = { pilots: 12000, cabin: 3000, engineers: 5500, ground: 2800, hq: 6500 };
const SPEEDS = [0, 1, 10, 100, 1000];
const COST_CATS: [LedgerCategory, string][] = [
  ['fuel', 'Fuel'], ['crew', 'Crew'], ['maintenance', 'Maintenance'], ['airportFees', 'Airport fees'], ['navigation', 'Navigation'],
  ['handling', 'Handling'], ['catering', 'Catering'], ['salaries', 'Salaries'], ['compensation', 'Delay compensation'], ['distribution', 'Sales & distribution'], ['leases', 'Aircraft leases'], ['insurance', 'Insurance'], ['overhead', 'Overhead'], ['assetCosts', 'Lounges & hotels running costs'],
];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const apLabel = (icao: string) => {
  const a = AIRPORTS[icao];
  return a ? `${a.iata || a.icao} · ${a.city || a.name}` : icao;
};
const STATUS: Record<string, string> = { ordered: 'On order', delivering: 'Delivering', idle: 'On ground', flying: 'In flight', turnaround: 'Turnaround', maintenance: 'Maintenance', ferry: 'Ferry flight', charter: 'On charter' };

export interface OpsCallbacks {
  onSpeed(v: number): void;
  onSave(slot: string): void;
  onLoadMenu(): void;
  onExport(): void;
  onClose(): void;
  onFly(from: string, to: string): void;
  onCustomise(kind: 'livery' | 'cabin' | 'designer' | 'character', arg?: string): void;
  onVisit(place: 'home' | 'hq'): void;
  onTravel(icao: string, aircraftId: string): void;
  onDrive(): void;
  onFlyJet(icao: string, aircraftId: string): void;
}

/**
 * The airline operations centre: a full-screen overlay with the business tabs.
 * Data comes from economy snapshots; every action is a command to the worker.
 */
export class OpsCenter {
  readonly el: HTMLElement;
  private tab: Tab = 'overview';
  private globe: Globe | null = null;
  private snap: Snapshot | null = null;
  private chosenSpeed = 10;
  private draft = { a: '', b: '', aircraft: [] as string[], freq: 14, fareY: 0, fareJ: 0, fareW: 0, editing: '' };
  private charterPick: Record<string, string> = {};
  private quote: RouteQuote | null = null;
  private financeMonth = '';
  private bidTarget = '';
  private ideas: Opportunity[] | null = null;
  private carColour = empireData.carColours[0];
  isOpen = false;

  constructor(private eco: EconomyClient, private cb: OpsCallbacks) {
    this.el = document.createElement('div');
    this.el.id = 'ops';
    this.el.className = 'hidden';
    this.el.innerHTML = `
      <aside class="opsnav">
        <div class="opsbrand"><i class="dot"></i><b id="opsAirline"></b></div>
        ${TABS.map(([t, l]) => `<button data-tab="${t}">${l}</button>`).join('')}
        <div class="opsfoot"><button class="btn" id="opsClose">Back to the world (Tab)</button></div>
      </aside>
      <main class="opsmain"><div id="opsBody"></div><div id="globeHost"></div><div id="globeTip" class="glass"></div></main>`;
    document.body.appendChild(this.el);
    this.el.querySelector('.opsnav')!.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).dataset.tab as Tab | undefined;
      if (t) this.show(t);
    });
    this.el.querySelector('#opsClose')!.addEventListener('click', () => cb.onClose());
    eco.onSnapshot((s) => {
      this.snap = s;
      if (this.isOpen) this.refresh();
    });
  }

  get speed(): number {
    return this.chosenSpeed;
  }

  setSpeed(v: number): void {
    this.chosenSpeed = v;
  }

  open(tab?: Tab): void {
    this.isOpen = true;
    this.el.classList.remove('hidden');
    this.show(tab ?? this.tab);
  }

  close(): void {
    this.isOpen = false;
    this.el.classList.add('hidden');
    this.globe?.stop();
  }

  private get cur(): Currency {
    return this.snap?.airline.currency ?? 'GBP';
  }

  /** Share prices: two decimals in the display currency. */
  private px(usd: number): string {
    return `${symbol(this.cur)}${toCurrency(usd, this.cur).toFixed(2)}`;
  }

  private m(usd: number, compact = true): string {
    return money(usd, this.cur, compact);
  }

  private show(tab: Tab): void {
    this.tab = tab;
    this.el.querySelectorAll<HTMLButtonElement>('.opsnav button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const host = this.el.querySelector<HTMLElement>('#globeHost')!;
    const withGlobe = tab === 'map' || tab === 'routes';
    host.style.display = withGlobe ? 'block' : 'none';
    this.el.classList.toggle('withglobe', withGlobe);
    if (withGlobe) {
      if (!this.globe) {
        this.globe = new Globe(host);
        this.globe.onAirportClick = (icao) => this.pickAirport(icao);
        const tip = this.el.querySelector<HTMLElement>('#globeTip')!;
        this.globe.onHover = (t) => {
          tip.textContent = t;
          tip.style.display = t ? 'block' : 'none';
        };
      }
      this.globe.start();
    } else this.globe?.stop();
    this.render();
  }

  /** Re-render after an editor closes. */
  redraw(): void {
    if (this.isOpen) this.render();
  }

  /** Full re-render of the current tab (forms keep their values in this.draft). */
  private render(): void {
    const body = this.el.querySelector<HTMLElement>('#opsBody')!;
    const s = this.snap;
    if (!s) {
      body.innerHTML = '<p class="note">No game running.</p>';
      return;
    }
    (this.el.querySelector('#opsAirline') as HTMLElement).textContent = s.airline.name;
    (this.el.querySelector('.opsbrand .dot') as HTMLElement).style.background = s.airline.primary;
    body.innerHTML = this.html(this.tab, s);
    this.bind(body);
    this.refresh();
  }

  /** Cheap live update of values that change every snapshot. */
  private refresh(): void {
    const s = this.snap;
    if (!s) return;
    this.el.querySelectorAll<HTMLElement>('[data-live]').forEach((e) => {
      const k = e.dataset.live!;
      if (k === 'cash') e.textContent = s.difficulty === 'sandbox' ? '∞' : this.m(s.cashUSD);
      if (k === 'date') e.textContent = fmtDate(s.time);
      if (k === 'weekly') e.textContent = this.m(s.weekly.revenue - s.weekly.cost);
      if (k === 'lf') e.textContent = `${Math.round(s.weekly.loadFactor * 100)}%`;
      if (k === 'flying') e.textContent = String(s.fleet.filter((a) => a.status === 'flying').length);
    });
    if (this.tab === 'fleet') {
      for (const a of s.fleet) {
        const row = this.el.querySelector<HTMLElement>(`[data-ac="${a.id}"] .st`);
        if (row) row.textContent = STATUS[a.status] + (a.status === 'flying' || a.status === 'ferry' ? ` ${AIRPORTS[a.flightFrom]?.iata}→${AIRPORTS[a.flightTo]?.iata}` : ` @ ${AIRPORTS[a.location]?.iata || a.location}`);
      }
    }
    if (this.globe && (this.tab === 'map' || this.tab === 'routes')) this.globe.update(s, s.airline.accent);
  }

  // ------------------------------------------------------------------ templates
  private html(tab: Tab, s: Snapshot): string {
    switch (tab) {
      case 'overview': return this.overview(s);
      case 'map': return this.mapTab(s);
      case 'routes': return this.routesTab(s);
      case 'fleet': return this.fleetTab(s);
      case 'market': return this.marketTab(s);
      case 'finances': return this.financesTab(s);
      case 'staff': return this.staffTab(s);
      case 'competition': return this.competitionTab(s);
      case 'customise': return this.customiseTab(s);
      case 'shares': return this.sharesTab(s);
      case 'assets': return this.assetsTab(s);
      case 'charters': return this.chartersTab(s);
      case 'empire': return this.empireTab(s);
      case 'hq': return this.hqTab(s);
      case 'airline': return this.airlineTab(s);
    }
  }

  private kpi(label: string, value: string, live = ''): string {
    return `<div class="kpi glass"><small>${label}</small><b ${live ? `data-live="${live}"` : ''}>${value}</b></div>`;
  }

  private overview(s: Snapshot): string {
    const active = s.fleet.filter((a) => a.status !== 'ordered').length;
    const orders = s.fleet.filter((a) => a.status === 'ordered' || a.status === 'delivering');
    return `<h1>${esc(s.airline.name)}</h1>
      <p class="note">Based at ${apLabel(s.base)} · ${difficultyLabel(s.difficulty)} · <span data-live="date"></span></p>
      <div class="kpis">
        ${this.kpi('Cash', '', 'cash')}
        ${this.kpi('Profit / week (last 30 days)', '', 'weekly')}
        ${this.kpi('Load factor', '', 'lf')}
        ${this.kpi('Aircraft', `${active}${orders.length ? ` (+${orders.length} coming)` : ''}`)}
        ${this.kpi('Routes', String(s.routes.length))}
        ${this.kpi('In the air now', '', 'flying')}
        ${this.kpi('World rank (passengers)', `#${s.rank} of ${s.rivals.length + 1}`)}
        ${this.kpi('Reputation', `${Math.round(s.reputation)}/100`)}
        ${this.kpi('On time this month', `${Math.round(s.onTime * 100)}%`)}
        ${this.kpi('Jet fuel', `${this.m(s.fuelPrice * 1000)}/tonne`)}
        ${this.kpi(s.corp.equity.listed ? 'Share price' : 'Company value', s.corp.equity.listed ? this.px(s.corp.equity.price) : this.m(s.corp.equityValueUSD))}
        ${this.kpi('Debt', `${this.m(s.corp.debtUSD)} · ${s.corp.rating}`)}
        ${this.kpi('Your net worth', this.m(s.corp.personal.netWorthUSD))}
      </div>
      ${s.corp.strikes.length ? `<div class="events">${s.corp.strikes.map((x) => `<div class="event glass bad"><b>Union:</b> ${DEPT_LABEL[x.dept]} ${x.stage === 'warning' ? 'warn of a strike' : x.stage === 'ballot' ? 'are balloting' : 'are ON STRIKE'} <a data-go="staff">Staff</a></div>`).join('')}</div>` : ''}
      ${s.events.length ? `<div class="events">${s.events.map((e) => `<div class="event glass"><b>Now:</b> ${esc(e.text)} <small>until ${fmtDate(e.until, true)}</small></div>`).join('')}</div>` : ''}
      ${this.firstSteps(s)}
      <div class="fingrid"><div><h2>Latest news</h2>
      <ul class="log">${s.log.slice(0, 14).map((l) => `<li class="${l.level}"><time>${fmtDate(l.t, true)}</time>${esc(l.text)}</li>`).join('')}</ul></div>
      <div><h2>Passenger reviews</h2>${s.reviews.length ? `<ul class="reviews">${s.reviews.map((r) => `<li><span class="stars">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span> ${esc(r.text)}</li>`).join('')}</ul>` : '<p class="note">Reviews arrive at the end of your first month of flying.</p>'}</div></div>`;
  }

  /** First-steps checklist for new players (hidden once done or dismissed). */
  private firstSteps(s: Snapshot): string {
    let hidden = false;
    try {
      hidden = localStorage.getItem('skyempire.guide.hidden') === '1';
    } catch {
      /* storage unavailable */
    }
    const st = s.empire.state;
    const steps: [boolean, string, string][] = [
      [s.routes.length > 0, 'Open your first route: pick a destination on the globe, assign an aircraft, set fares.', 'routes'],
      [s.fleet.length >= 3, 'Grow the fleet to three aircraft (leasing is quickest).', 'market'],
      [s.playerFlights.count > 0, 'Fly one of your routes yourself (Routes → Fly), then press K once airborne to skip the cruise.', 'routes'],
      [!!s.airline.livery, 'Paint your fleet in the livery editor.', 'customise'],
      [!!st.achievements.profit_month, 'Close a month with an operating profit (speed up time at the top).', 'finances'],
      [Object.values(st.hq.depts).some((l) => l > 0), 'Upgrade a department at your headquarters.', 'hq'],
      [s.routes.length >= 5, 'Run five routes. Network Planning (HQ) suggests good ones.', 'routes'],
    ];
    const done = steps.filter((x) => x[0]).length;
    if (hidden || done === steps.length) return '';
    return `<div class="callout glass guide"><div class="row" style="margin:0;justify-content:space-between"><b>First steps · ${done}/${steps.length}</b><button class="btn sm" id="guideHide">Hide</button></div>
      <ul>${steps.map(([ok, text, tab]) => `<li class="${ok ? 'ok' : ''}"><span>${ok ? '✓' : '○'}</span> <a data-go="${tab}">${text}</a></li>`).join('')}</ul></div>`;
  }

  private mapTab(s: Snapshot): string {
    return `<div class="floatpanel glass"><h2>Network</h2><p class="note">${s.routes.length} routes · <span data-live="flying"></span> aircraft flying. Drag to spin, scroll to zoom, click an airport to start a route from your base.</p></div>`;
  }

  private routesTab(s: Snapshot): string {
    const d = this.draft;
    const free = s.fleet.filter((a) => (a.routeId === null || a.routeId === d.editing) && a.status !== 'ordered' && a.status !== 'charter' && (TYPES[a.typeId].role === 'airliner' || TYPES[a.typeId].role === 'freighter'));
    const isCargo = !!TYPES[s.fleet.find((a) => a.id === d.aircraft[0])?.typeId ?? '']?.cargoT;
    const q = this.quote;
    const cur = this.cur;
    const sym = symbol(cur);
    const rows = s.routes.map((r) => {
      const lf = r.last30.seats ? (r.cargo ? (r.last30.cargoT ?? 0) : r.last30.paxY + r.last30.paxJ) / r.last30.seats : 0; // paxY includes premium economy
      const days = Math.max(1, (s.time - r.last30.since) / 86400000);
      const wk = ((r.last30.revenue - r.last30.cost) * 7) / days;
      const t = TYPES[s.fleet.find((a) => a.id === r.aircraftIds[0])?.typeId ?? '']?.name ?? '';
      return `<tr><td><b>${apLabel(r.a)} ⇄ ${apLabel(r.b)}</b><br><small>${Math.round(r.distanceKm)} km · ${r.aircraftIds.length} × ${t}</small></td>
        <td>${r.weeklyFreq}/wk</td><td>${r.cargo ? `${this.px(r.fareY)}/kg cargo` : `${this.m(r.fareY)} / ${this.m(r.fareW ?? r.fareY * 1.6)} / ${this.m(r.fareJ)}`}</td><td>${Math.round(lf * 100)}%</td>
        <td class="${wk >= 0 ? 'pos' : 'neg'}">${this.m(wk)}</td>
        <td><button class="btn sm primary" data-fly="${r.a}|${r.b}" title="Fly a flight on this route yourself">Fly</button> <button class="btn sm" data-edit="${r.id}">Edit</button> <button class="btn sm" data-close="${r.id}">Close</button></td></tr>`;
    }).join('');
    const slotWarn = q && Object.keys(q.slotsNeeded).length
      ? `<div class="warn">Needs ${Object.entries(q.slotsNeeded).map(([ap, n]) => `${n} more daily slot pair(s) at ${ap}`).join(', ')}. ${Object.entries(q.slotsNeeded).map(([ap, n]) => `<button class="btn sm" data-slots="${ap}" data-n="${n}">Buy ${n} at ${ap}</button>`).join(' ')}</div>` : '';
    return `<div class="routesgrid">
      <div class="panel glass">
        <h2>${d.editing ? 'Edit route' : 'New route'}</h2>
        <div class="form">
          <label>From <input list="aplist" id="rA" value="${d.a ? esc(apLabel(d.a)) : ''}" placeholder="Type a city or code, or click the globe"></label>
          <label>To <input list="aplist" id="rB" value="${d.b ? esc(apLabel(d.b)) : ''}" placeholder="Destination"></label>
          <datalist id="aplist">${Object.values(AIRPORTS).filter((a) => a.type === 0 || a.market > 0.3).map((a) => `<option value="${esc(apLabel(a.icao))}">${esc(a.name)}</option>`).join('')}</datalist>
          <label>Aircraft <span class="chips">${free.length ? free.map((a) => `<button class="chip ${d.aircraft.includes(a.id) ? 'on' : ''}" data-pick="${a.id}">${a.reg} · ${TYPES[a.typeId].name}</button>`).join('') : '<small>No free aircraft: buy or lease one first.</small>'}</span></label>
          <label>Weekly round trips <input type="number" id="rF" min="1" max="200" value="${d.freq}"></label>
          ${isCargo ? `<label>Cargo rate (${sym} per kg) <input type="number" id="rY" min="0.05" step="0.05" value="${toCurrency(d.fareY, cur).toFixed(2)}"></label>` : `
          <label>Economy fare (${sym}) <input type="number" id="rY" min="1" value="${Math.round(toCurrency(d.fareY, cur))}"></label>
          <label>Premium economy fare (${sym}) <input type="number" id="rW" min="1" value="${Math.round(toCurrency(d.fareW, cur))}"></label>
          <label>Business fare (${sym}) <input type="number" id="rJ" min="1" value="${Math.round(toCurrency(d.fareJ, cur))}"></label>`}
        </div>
        ${q?.ok && q.cargo ? `<div class="quote">
            <div><small>Distance</small><b>${Math.round(q.distanceKm)} km · ${q.blockHours.toFixed(1)} h</b></div>
            <div><small>Freight market</small><b>${Math.round(q.marketWeekly).toLocaleString()} t/wk each way</b></div>
            <div><small>Max frequency</small><b>${q.maxWeeklyFreq}/wk</b></div>
            <div><small>Expected fill</small><b>${Math.round(q.cargo.fill * 100)}%</b></div>
            <div><small>Revenue / week</small><b>${this.m(q.weeklyRevenue)}</b></div>
            <div><small>Profit / week</small><b class="${q.weeklyProfit >= 0 ? 'pos' : 'neg'}">${this.m(q.weeklyProfit)}</b></div>
            <div class="wide"><small>Reference rate ${this.px(q.cargo.refRatePerKg)}/kg. You carry about ${Math.round(q.cargo.tonnesWeek)} t a week (both ways). Cheaper rates win more freight.</small></div>
          </div>${slotWarn}` : q ? (q.ok ? `<div class="quote">
            <div><small>Distance</small><b>${Math.round(q.distanceKm)} km · ${q.blockHours.toFixed(1)} h</b></div>
            <div><small>Market (both ways)</small><b>${Math.round(q.marketWeekly * 2).toLocaleString()} pax/wk</b></div>
            <div><small>Max frequency</small><b>${q.maxWeeklyFreq}/wk</b></div>
            <div><small>Expected load</small><b>${Math.round(q.expectedLoadFactor * 100)}%</b></div>
            <div><small>Revenue / week</small><b>${this.m(q.weeklyRevenue)}</b></div>
            <div><small>Profit / week</small><b class="${q.weeklyProfit >= 0 ? 'pos' : 'neg'}">${this.m(q.weeklyProfit)}</b></div>
            <div class="wide"><small>Reference fares: ${this.m(q.refFareY)} economy, ${this.m(q.refFareW ?? q.refFareY * 1.6)} premium, ${this.m(q.refFareJ)} business. Higher fares mean fewer passengers.${q.seats ? ` Cabin: ${q.seats.j} J · ${q.seats.w} W · ${q.seats.y} Y${q.seats.w ? ` (premium ${Math.round(q.paxW ?? 0)} pax/wk)` : ' (no premium economy seats: add them in Customise → Cabins)'}` : ''}</small></div>
            <div class="wide"><small>Your share of economy demand: <b>${Math.round(q.playerShare * 100)}%</b>${q.competitors.length ? ' · competing with:' : ' · no big rival on this route (smaller airlines share the rest)'}</small>
              ${q.competitors.map((c) => `<div class="comp"><i class="sw" style="background:${c.color}"></i>${esc(c.name)} · ${c.freq}/wk · fares ×${c.fare.toFixed(2)} · ${Math.round(c.share * 100)}%</div>`).join('')}</div>
          </div>${slotWarn}` : `<div class="warn">${esc(q.reason ?? '')}</div>`) : '<p class="note">Pick two airports and at least one aircraft.</p>'}
        ${s.empire.state.hq.depts.revenue && !isCargo && d.a && d.b && d.aircraft.length ? '<div class="row"><button class="btn sm" id="rOptimise" title="Revenue Management (HQ)">Optimise fares</button></div>' : ''}
        <div class="row"><button class="btn primary" id="rOpen">${d.editing ? 'Save changes' : 'Open route'}</button>${d.editing ? '<button class="btn" id="rCancel">Cancel</button>' : ''}</div>
      </div>
      <div class="panel glass list">
        ${s.empire.state.hq.depts.network ? `<h2>Route ideas <small>(Network Planning)</small></h2>${this.ideas ? (this.ideas.length ? `<table>${this.ideas.map((o) => `<tr><td><b>${apLabel(o.icao)}</b><br><small>${Math.round(o.km)} km</small></td><td>${Math.round(o.loadFactor * 100)}% load</td><td class="${o.weeklyProfit >= 0 ? 'pos' : 'neg'}">${this.m(o.weeklyProfit)}/wk</td><td><button class="btn sm" data-idea="${o.icao}">Plan</button></td></tr>`).join('')}</table><p class="note">Estimates for one A320neo, 14 round trips a week at reference fares.</p>` : '<p class="note">No ideas right now.</p>') : '<button class="btn sm" id="rIdeas">Show route ideas</button>'}` : ''}
        <h2>Your routes</h2>
        ${s.routes.length ? `<table><tr><th>Route</th><th>Freq</th><th>Fares Y / W / J</th><th>Load</th><th>Profit/wk</th><th></th></tr>${rows}</table>` : '<p class="note">No routes yet.</p>'}
      </div></div>`;
  }

  private fleetTab(s: Snapshot): string {
    const rows = s.fleet.map((a) => {
      const t = TYPES[a.typeId];
      const r = s.routes.find((x) => x.id === a.routeId);
      const action = a.ownership === 'owned'
        ? (a.status === 'ordered' ? `<small>Delivery ${fmtDate(a.deliveryAt, true)}</small>` : `<button class="btn sm" data-sell="${a.id}">Sell ~${this.m(a.bookValueUSD * 0.92)}</button> <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'saleLeaseback', aircraftId: a.id })}' data-confirm="Sell ${a.reg} for ${this.m(a.bookValueUSD)} and lease it back?" title="Raise cash: sell it to a lessor and keep flying it on a lease">Sale &amp; leaseback</button>`)
        : `<button class="btn sm" data-return="${a.id}">Return lease</button>`;
      return `<tr data-ac="${a.id}"><td><b>${a.reg}</b><br><small>${t.name}</small></td><td>${a.ownership === 'owned' ? 'Owned' : `Leased ${this.m(a.leaseMonthUSD)}/mo`}</td>
        <td>${a.ageYears.toFixed(1)} y · ${Math.round(a.condition * 100)}%</td><td class="st"></td><td>${r ? `${apLabel(r.a)} ⇄ ${apLabel(r.b)}` : '—'}</td><td>${Math.round(a.hours).toLocaleString()} h</td><td>${action}</td></tr>`;
    }).join('');
    return `<h1>Fleet</h1><div class="panel glass"><table><tr><th>Aircraft</th><th>Ownership</th><th>Age · condition</th><th>Status</th><th>Route</th><th>Hours</th><th></th></tr>${rows}</table></div>`;
  }

  private marketTab(s: Snapshot): string {
    const types = Object.values(TYPES);
    const card = (t: (typeof types)[number]) => `<div class="actype glass">
        <h3>${t.name}</h3><small>${t.maker} · ${t.category}${t.model ? ' · <span class="tag">3D model</span>' : ''}</small>
        <ul><li>${t.cargoT ? `${t.cargoT} t cargo` : `${t.seats[0] + t.seats[1]} seats (${t.seats[0]} J / ${t.seats[1]} Y)`}</li><li>${t.rangeKm.toLocaleString()} km range · ${t.cruiseKt} kt</li><li>${t.fuelKgPerHr.toLocaleString()} kg/h fuel</li></ul>
        <div class="prices"><span>Buy new <b>${t.newAvailable ? this.m(t.priceUSD) : 'out of production'}</b>${t.newAvailable ? `<small>${t.deliveryMonths} mo delivery, 20% deposit</small>` : ''}</span><span>Lease <b>${this.m(t.leaseMonthUSD)}/mo</b><small>3 weeks delivery</small></span></div>
        <div class="row">${t.newAvailable ? `<button class="btn sm" data-buy="${t.id}">Order</button>` : ''}<button class="btn sm primary" data-lease="${t.id}">Lease</button></div></div>`;
    const used = s.used.map((u) => `<tr><td><b>${TYPES[u.typeId].name}</b></td><td>${u.ageYears} y</td><td>${Math.round(u.condition * 100)}%</td><td>${u.hours.toLocaleString()} h</td><td>${apLabel(u.location)}</td><td>${this.m(u.priceUSD)}</td><td><button class="btn sm" data-used="${u.id}">Buy</button></td></tr>`).join('');
    const roles: [string, string][] = [['airliner', 'Airliners'], ['freighter', 'Freighters (cargo routes)'], ['bizjet', 'Business jets (charters)'], ['vip', 'VIP (charters)'], ['heli', 'Helicopters']];
    return `<h1>Buy & lease aircraft</h1>
      ${roles.map(([r, l]) => `<h2>${l}</h2><div class="cards">${types.filter((t) => t.role === r).map(card).join('')}</div>`).join('')}
      <h2>Used market <small>(refreshes monthly)</small></h2>
      <div class="panel glass"><table><tr><th>Type</th><th>Age</th><th>Condition</th><th>Hours</th><th>Location</th><th>Price</th><th></th></tr>${used}</table></div>`;
  }

  private financesTab(s: Snapshot): string {
    const months = s.ledgerMonths.map((m) => m.month);
    if (!this.financeMonth || !months.includes(this.financeMonth)) this.financeMonth = months[months.length - 1] ?? '';
    const mo = s.ledgerMonths.find((m) => m.month === this.financeMonth);
    const it = mo?.items ?? {};
    const REV: [LedgerCategory, string][] = [['ticketRevenue', 'Ticket revenue'], ['cargoRevenue', 'Cargo'], ['charterRevenue', 'Charters & wet leases'], ['assetIncome', 'Lounges & hotels'], ['otherRevenue', 'Other (landing bonuses)']];
    const rev = REV.reduce((x, [k]) => x + (it[k] ?? 0), 0);
    const costs = COST_CATS.map(([k]) => it[k] ?? 0);
    const opCost = costs.reduce((a, b) => a + b, 0);
    const opRes = rev - opCost;
    const line = (l: string, v: number, cls = '') => `<tr class="${cls}"><td>${l}</td><td>${this.m(v, false)}</td></tr>`;
    const lineNZ = (l: string, v: number) => (Math.abs(v) > 0.5 ? line(l, v) : '');
    return `<h1>Finances</h1>
      <div class="row"><label>Month <select id="finMonth">${months.map((m) => `<option ${m === this.financeMonth ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <span class="note">Cash: <b data-live="cash"></b></span></div>
      <div class="fingrid">
        <div class="panel glass"><h2>Profit & loss · ${this.financeMonth}</h2><table class="pl">
          ${REV.filter(([k]) => it[k]).map(([k, l]) => line(l, it[k] ?? 0, 'pos')).join('')}
          ${COST_CATS.filter((_, i) => costs[i]).map(([, l]) => line(l, -(it[COST_CATS.find((c) => c[1] === l)![0]] ?? 0))).join('')}
          ${line('Operating result (EBITDA)', opRes, opRes >= 0 ? 'total pos' : 'total neg')}
          ${line('Stakes & airport dividends', it.investmentIncome ?? 0)}
          ${line('Subsidiaries', it.subsidiaryIncome ?? 0)}
          ${line('Interest', -(it.interest ?? 0))}
          ${line('Depreciation (non-cash)', -(mo?.depreciation ?? 0))}
          ${line('Net result', opRes + (it.investmentIncome ?? 0) + (it.subsidiaryIncome ?? 0) - (it.interest ?? 0) - (mo?.depreciation ?? 0), 'total')}
          <tr><td colspan="2"><small>Cash movements</small></td></tr>
          ${lineNZ('Aircraft purchases & deposits', -((it.aircraftPurchases ?? 0) + (it.deposits ?? 0)))}
          ${lineNZ('Aircraft sales', it.aircraftSales ?? 0)}
          ${lineNZ('Slot purchases', -(it.slots ?? 0))}
          ${lineNZ('Loans received', it.loanIn ?? 0)}
          ${lineNZ('Loan repayments', -(it.loanRepayment ?? 0))}
          ${lineNZ('Shares issued', it.equityIn ?? 0)}
          ${lineNZ('Dividends paid', -(it.dividends ?? 0))}
          ${lineNZ('Share buybacks', -(it.buybacks ?? 0))}
          ${lineNZ('Investments (stakes, takeovers, assets)', -(it.investments ?? 0))}
          ${lineNZ('Sales of stakes & assets', it.divestments ?? 0)}
        </table></div>
        <div class="panel glass"><h2>Cash</h2><canvas id="cashChart" width="640" height="260"></canvas>
          <p class="note">Operating margin this month: <b>${rev ? Math.round((opRes / rev) * 100) : 0}%</b>.</p></div>
      </div>
      ${this.debtPanel(s)}`;
  }

  private staffTab(s: Snapshot): string {
    const rows = Object.entries(s.staff).map(([d, st]) => {
      const cost = st.headcount * DEPT_SALARY[d] * st.pay;
      const mood = st.morale > 0.7 ? 'good' : st.morale > 0.45 ? 'warn' : 'bad';
      return `<tr><td><b>${DEPT_LABEL[d]}</b></td><td>${st.headcount} / ${st.required}</td>
        <td><input type="range" min="70" max="140" step="5" value="${Math.round(st.staffing * 100)}" data-staff="${d}.staffing"> ${Math.round(st.staffing * 100)}%</td>
        <td><input type="range" min="70" max="150" step="5" value="${Math.round(st.pay * 100)}" data-staff="${d}.pay"> ${Math.round(st.pay * 100)}%</td>
        <td><span class="bar ${mood}"><i style="width:${Math.round(st.morale * 100)}%"></i></span> ${Math.round(st.morale * 100)}%</td><td>${this.m(cost)}/mo</td></tr>`;
    }).join('');
    const d = s.drivers;
    const bar = (l: string, v: number) => `<div class="drv"><span>${l}</span><span class="bar ${v > 0.66 ? 'good' : v > 0.4 ? 'warn' : 'bad'}"><i style="width:${Math.round(v * 100)}%"></i></span></div>`;
    return `<h1>Staff</h1>
      <p class="note">Headcount follows your fleet and schedule. Staffing above 100% gives slack (fewer delays); below 100% means overtime. Pay above market raises morale; low morale hurts service and reviews, and below about 32% morale the union threatens to strike. Morale moves month by month.</p>
      ${s.corp.strikes.length ? `<div class="panel glass"><h2>Unions</h2>${s.corp.strikes.map((x) => `<div class="row"><b>${DEPT_LABEL[x.dept]}</b> ${x.stage === 'warning' ? 'have issued a strike warning' : x.stage === 'ballot' ? 'are balloting for a strike' : 'are on strike'} until ${fmtDate(x.until, true)}. <button class="btn sm primary" data-cmd='${JSON.stringify({ kind: 'settleStrike', dept: x.dept })}'>Settle: +${Math.round(corpData.strikes.settlePayRise * 100)}% pay</button></div>`).join('')}<p class="note">Or raise their pay with the slider: if the union is satisfied before the deadline, the strike is called off.</p></div>` : ''}
      <div class="panel glass"><table><tr><th>Department</th><th>Staff / needed</th><th>Staffing</th><th>Pay vs market</th><th>Morale</th><th>Cost</th></tr>${rows}</table></div>
      <h2>What drives your reputation (${Math.round(s.reputation)}/100)</h2>
      <div class="panel glass drivers">${bar('Punctuality', d.punctuality)}${bar('Cabin service', d.service)}${bar('Comfort (fleet age & condition)', d.comfort)}${bar('Value for money', d.value)}${bar('Safety', d.safety)}</div>`;
  }

  private competitionTab(s: Snapshot): string {
    const me = { id: 'me', name: s.airline.name, colors: [s.airline.primary, s.airline.accent] as [string, string], model: 'you', routes: s.routes.length, weeklyPax: s.weekly.pax, quality: s.reputation / 100 };
    const all = [...s.rivals, me].sort((a, b) => b.weeklyPax - a.weeklyPax);
    const MODEL: Record<string, string> = { legacy: 'Full service', longhaul: 'Long-haul', lcc: 'Low-cost', ulcc: 'Ultra low-cost', leisure: 'Leisure', gulf: 'Gulf super-connector', regional: 'Regional', you: 'You' };
    const H = s.corp.holdings;
    const al = H.alliance;
    const bid = H.bid;
    const row = (r: (typeof all)[number], i: number) => {
      if (r.id === 'me') return `<tr class="me"><td>${i + 1}</td><td><b>${esc(r.name)}</b>${s.corp.rivals && Object.values(H.owned).includes('merge') ? ' <small>(incl. merged airlines)</small>' : ''}</td><td>You</td><td>${r.routes}</td><td>${Math.round(r.weeklyPax).toLocaleString()}</td><td></td><td></td><td></td></tr>`;
      const f = s.corp.rivals[r.id];
      const stake = H.stakes[r.id] ?? 0;
      const owned = H.owned[r.id];
      const allied = al?.members.includes(r.id);
      const tag = owned ? '<span class="tag good">Yours</span>' : allied ? '<span class="tag">Alliance</span>' : stake ? `<span class="tag">${Math.round(stake * 100)}% stake</span>` : '';
      const acts = owned ? '' : `<button class="btn sm" data-cmd='${JSON.stringify({ kind: 'buyStake', rivalId: r.id, pct: 0.05 })}' title="Buy 5% of their shares">+5%</button>${stake ? ` <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellStake', rivalId: r.id, pct: stake })}' data-confirm="Sell your whole stake?">Sell</button>` : ''} <button class="btn sm" data-bidopen="${r.id}">Bid…</button>${al && !allied ? ` <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'inviteAlliance', rivalId: r.id })}'>Invite</button>` : ''}`;
      return `<tr><td>${i + 1}</td><td><i class="sw" style="background:${r.colors[0]}"></i><i class="sw" style="background:${r.colors[1]}"></i> <b>${esc(r.name)}</b> ${tag}</td><td>${MODEL[r.model] ?? r.model}</td><td>${r.routes}${f?.overlap ? ` <small>(${f.overlap} vs you)</small>` : ''}</td><td>${Math.round(r.weeklyPax).toLocaleString()}</td><td><span class="bar"><i style="width:${Math.round(r.quality * 100)}%"></i></span></td><td>${f ? this.m(f.valueUSD) : ''}</td><td class="acts">${acts}</td></tr>`;
    };
    const target = this.bidTarget ? s.rivals.find((r) => r.id === this.bidTarget) : undefined;
    const tf = target ? s.corp.rivals[target.id] : undefined;
    const tStake = target ? H.stakes[target.id] ?? 0 : 0;
    return `<h1>Rivals, mergers & alliances</h1><p class="note">World ranking by weekly passengers: get to number one. Buy shares in rivals (they pay dividends), take them over, or bring them into your alliance. Owned and allied airlines stop fighting you; allies share codeshare traffic and lounges.</p>
      ${bid ? `<div class="callout glass"><b>Takeover bid pending:</b> ${esc(s.rivals.find((r) => r.id === bid.rivalId)?.name ?? '')}, ${this.m(bid.costUSD)} (${Math.round(bid.premium * 100)}% premium, ${bid.mode === 'merge' ? 'merge into your airline' : 'keep their brand'}). Their board answers on ${fmtDate(bid.decideAt, true)}.</div>` : ''}
      ${target && tf ? `<div class="panel glass bidform"><h2>Takeover bid: ${esc(target.name)}</h2>
        <p class="note">Value ${this.m(tf.valueUSD)} · profit about ${this.m(tf.profitYearUSD)}/year · you hold ${Math.round(tStake * 100)}% · ${tf.overlap} routes overlap with yours (regulators look at this).</p>
        <div class="form inline"><label>Premium over market value <select id="bidPrem">${[0.1, 0.2, 0.3, 0.45, 0.6, 0.8].map((p) => `<option value="${p}" ${p === 0.3 ? 'selected' : ''}>${Math.round(p * 100)}% · ${this.m(tf.valueUSD * (1 - tStake) * (1 + p))}</option>`).join('')}</select></label>
        <label>After the deal <select id="bidMode"><option value="merge">Merge into my airline (network and slots join yours)</option><option value="brand">Keep their brand (subsidiary, sends you its profit)</option></select></label></div>
        <div class="row"><button class="btn primary" id="bidGo">Submit bid</button><button class="btn" id="bidCancel">Cancel</button></div>
        <p class="note">A bigger premium and a bigger stake make the board more likely to say yes. Large overlaps can make the competition regulator demand route sales or block the deal.</p></div>` : ''}
      <div class="fingrid"><div class="panel glass"><h2>Alliance</h2>${al ? `<p><b>${esc(al.name)}</b> · ${al.members.length} member${al.members.length === 1 ? '' : 's'}: ${al.members.map((id) => esc(s.rivals.find((r) => r.id === id)?.name ?? id)).join(', ') || 'invite airlines from the table below'}</p>
          <p class="note">Members don't fight you, share codeshare traffic (+${Math.round(corpData.alliance.demandBoost * 100)}% demand on routes to their hubs) and lounges. Low-cost airlines don't join. Members leave if your reputation drops below 40.</p>
          <div class="row"><button class="btn sm" data-cmd='${JSON.stringify({ kind: 'leaveAlliance' })}' data-confirm="Dissolve the alliance?">Dissolve</button></div>`
        : `<p class="note">Found your own alliance (reputation ${corpData.alliance.minReputation}+ and ${corpData.alliance.minRoutes}+ routes), then invite full-service rivals.</p>
          <div class="row"><input id="alName" placeholder="Alliance name" value="${esc(s.airline.name)} Alliance"><button class="btn primary" id="alFound">Found alliance</button></div>`}</div>
        <div class="panel glass"><h2>Your holdings</h2>${Object.keys(H.stakes).length ? `<table>${Object.entries(H.stakes).map(([id, p]) => `<tr><td>${esc(s.rivals.find((r) => r.id === id)?.name ?? id)}</td><td>${H.owned[id] ? (H.owned[id] === 'merge' ? 'Merged' : 'Subsidiary') : `${Math.round(p * 100)}%`}</td><td>${this.m((s.corp.rivals[id]?.valueUSD ?? 0) * p)}</td></tr>`).join('')}</table>` : '<p class="note">No stakes yet. Stakes pay dividends; crossing 5%, 10% and 25% is announced publicly. Above 49% you need a takeover bid.</p>'}</div></div>
      <div class="panel glass"><table><tr><th>#</th><th>Airline</th><th>Model</th><th>Routes</th><th>Passengers / week</th><th>Product</th><th>Value</th><th></th></tr>
      ${all.map(row).join('')}
      </table></div>`;
  }

  private customiseTab(s: Snapshot): string {
    const a = s.airline;
    const L = a.livery;
    const fleet = s.fleet.filter((x) => TYPES[x.typeId]?.role !== 'freighter');
    const rows = fleet.map((x) => {
      const t = TYPES[x.typeId];
      const st = seatsOf(t, x);
      return `<tr><td><b>${x.reg}</b><br><small>${t.name}</small></td><td>${x.cabin ? (x.cabin.mode === 'free' ? 'Custom VIP' : 'Custom') : 'Factory'}</td>
        <td>${st.j} J · ${st.w} W · ${st.y} Y <small>(${st.total})</small></td><td><span class="bar"><i style="width:${Math.round(st.comfort * 100)}%"></i></span></td>
        <td><button class="btn sm" data-cabin="${x.id}">Edit cabin</button></td></tr>`;
    }).join('');
    const custom = s.customTypes.map((t) => `<li><b>${esc(t.name)}</b> · ${t.seats[0] + t.seats[1]} seats · ${t.rangeKm.toLocaleString()} km · ${this.m(t.priceUSD)} <button class="btn sm" data-design="${t.id}">Edit</button></li>`).join('');
    return `<h1>Customise</h1>
      <div class="custgrid">
        <div class="panel glass"><h2>Brand</h2>
          <div class="form">
            <label>Airline name <input id="bName" value="${esc(a.name)}" maxlength="32"></label>
            <label>Two-letter code <input id="bCode" value="${esc(a.code)}" maxlength="2"></label>
            <label>Primary colour <input type="color" id="bPrimary" value="${a.primary}"></label>
            <label>Accent colour <input type="color" id="bAccent" value="${a.accent}"></label>
          </div>
          <div class="row"><button class="btn primary" id="bSave">Save brand</button></div>
          <p class="note">Renaming does not change your livery titles: edit those in the livery editor.</p></div>
        <div class="panel glass"><h2>Livery</h2>
          <div class="livswatch" style="--b:${L?.base ?? '#ffffff'};--u:${L?.belly.color ?? a.primary};--t:${L?.tail.color ?? a.primary};--c:${L?.cheat.color ?? a.accent}"><i class="fus"></i><i class="belly"></i><i class="cheat"></i><i class="tail"></i></div>
          <p class="note">${L ? `Custom livery · ${L.layers.length} layer(s)${L.logo ? ' · logo' : ''}` : 'Factory livery in your brand colours.'} Paint layers, stripes, titles, tail art and your own logo on a live 3D aircraft.</p>
          <div class="row"><button class="btn primary" data-cust="livery">Open livery editor</button></div></div>
        <div class="panel glass"><h2>Your character</h2>
          <p class="note">Height, build, skin, hair, and pilot, CEO or casual outfits in your airline colours.</p>
          <div class="row"><button class="btn primary" data-cust="character">Open character creator</button></div></div>
        <div class="panel glass"><h2>Custom aircraft</h2>
          <p class="note">Design your own type from part families: fuselage stretch, wing, engines and fuel. Development costs money; then you can order it like any other aircraft.</p>
          ${custom ? `<ul class="plain">${custom}</ul>` : ''}
          <div class="row"><button class="btn primary" data-cust="designer">Design a new aircraft</button></div></div>
      </div>
      <h2>Cabins</h2>
      <p class="note">Change the seat layout of each aircraft: more seats earn more, more legroom and premium cabins raise comfort and reviews. A refit costs ${this.m(150000)} per aircraft.</p>
      <div class="panel glass">${rows ? `<table><tr><th>Aircraft</th><th>Cabin</th><th>Seats</th><th>Comfort</th><th></th></tr>${rows}</table>` : '<p class="note">No passenger aircraft yet.</p>'}</div>`;
  }

  private debtPanel(s: Snapshot): string {
    const c = s.corp;
    const F = c.finance;
    const cur = this.cur;
    const room = Math.max(0, c.capacityUSD - c.debtUSD);
    return `<h2>Debt</h2><div class="fingrid">
      <div class="panel glass"><div class="kv2"><span>Credit rating</span><b>${c.rating}</b><span>Interest rate</span><b>${(c.rate * 100).toFixed(1)}%${F.breaches ? ' <small class="neg">(covenant breach)</small>' : ''}</b>
        <span>Total debt</span><b>${this.m(c.debtUSD)}</b><span>Banks will lend up to</span><b>${this.m(room)} more</b><span>EBITDA (annualised)</span><b>${this.m(c.ebitdaYearUSD)}</b></div>
        <h2>New term loan</h2><div class="form inline"><label>Amount (${symbol(cur)}) <input type="number" id="loanAmt" min="1" value="${Math.round(toCurrency(Math.min(room, 10e6), cur))}"></label>
        <label>Term <select id="loanTerm">${(corpData.finance.terms as number[]).map((t) => `<option value="${t}" ${t === 60 ? 'selected' : ''}>${t / 12} year${t > 12 ? 's' : ''}</option>`).join('')}</select></label></div>
        <div class="row"><button class="btn primary" id="loanGo">Borrow</button></div>
        <p class="note">Rating comes from debt ÷ EBITDA, size and reputation. Keep debt under ${corpData.finance.covenantMaxDebtToEbitda}× EBITDA or the banks charge more.</p></div>
      <div class="panel glass"><h2>Credit line</h2><p>Drawn <b>${this.m(F.creditDrawnUSD)}</b> of <b>${this.m(c.creditLimitUSD)}</b></p>
        <div class="row"><input type="number" id="clAmt" value="${Math.round(toCurrency(5e6, cur))}"><button class="btn sm" id="clDraw">Draw</button><button class="btn sm" id="clRepay">Repay</button></div>
        <label class="row"><input type="checkbox" id="clAuto" ${F.autoDraw ? 'checked' : ''}> Draw automatically when cash goes negative</label>
        <h2>Loans</h2>${F.loans.length ? `<table><tr><th>Balance</th><th>Rate</th><th>Monthly</th><th>Left</th><th></th></tr>${F.loans.map((l) => `<tr><td>${this.m(l.balanceUSD)}</td><td>${(l.ratePerYear * 100).toFixed(1)}%</td><td>${this.m(l.paymentUSD)}</td><td>${l.monthsLeft} mo</td><td><button class="btn sm" data-cmd='${JSON.stringify({ kind: 'repayLoan', loanId: l.id, amountUSD: l.balanceUSD })}' data-confirm="Repay this loan in full?">Repay</button></td></tr>`).join('')}</table>` : '<p class="note">No loans.</p>'}
        <p class="note">Need cash fast? <b>Sale & leaseback</b> on the Fleet tab sells an owned aircraft and leases it back.</p></div></div>`;
  }

  private sharesTab(s: Snapshot): string {
    const c = s.corp;
    const e = c.equity;
    const P = c.personal;
    const stakePct = Math.round(P.stake * 100);
    const listed = e.listed;
    return `<h1>Shares & board</h1>
      <div class="kpis">${this.kpi(listed ? 'Share price' : 'Private valuation', listed ? this.px(e.price) : this.m(c.equityValueUSD))}${this.kpi('Market value', this.m(listed ? e.shares * e.price : c.equityValueUSD))}
        ${this.kpi('Your stake', `${stakePct}% · ${this.m(P.stakeValueUSD)}`)}${this.kpi('Your personal cash', this.m(P.cashUSD))}${this.kpi('Your net worth', this.m(P.netWorthUSD))}${this.kpi('Net profit (annualised)', this.m(c.netYearUSD))}</div>
      <div class="fingrid">
        <div class="panel glass">${listed ? `<h2>Share price</h2><canvas id="priceChart" width="640" height="220"></canvas>` : `<h2>Stock market listing (IPO)</h2>
          ${c.ipoEligible ? `<p>Float part of the company on the stock exchange. New shares are issued and the money goes to the airline; you keep the rest.</p>
            <div class="form inline"><label>Float <select id="ipoFloat">${[0.1, 0.2, 0.25, 0.3, 0.4, 0.49].map((f) => `<option value="${f}" ${f === 0.25 ? 'selected' : ''}>${Math.round(f * 100)}% · raises about ${this.m((c.equityValueUSD * f) / (1 - f) * corpData.equity.ipoDiscount * (1 - corpData.equity.ipoFees))}</option>`).join('')}</select></label></div>
            <div class="row"><button class="btn primary" id="ipoGo">Go public</button></div>
            <p class="note">After listing, a board represents the shareholders. It sets targets, and if you miss them while holding under 50% it can block large purchases.</p>`
          : `<p class="warn">Not yet: ${c.ipoReason === 'revenue' ? `investors want annual revenue of at least ${this.m(corpData.equity.ipoMinAnnualRevenueUSD)} (now ${this.m(c.revenueYearUSD)})` : esc(c.ipoReason)}.</p>`}`}
          <h2>Dividends</h2><div class="form inline"><label>Pay out <select id="payout">${[0, 0.1, 0.2, 0.3, 0.5, 0.8].map((p) => `<option value="${p}" ${Math.abs(p - e.payout) < 0.01 ? 'selected' : ''}>${Math.round(p * 100)}% of monthly profit</option>`).join('')}</select></label></div>
          <p class="note">You receive your share (${stakePct}%) as personal cash: that's what pays for your mansion, cars and jet in M7.</p></div>
        <div class="panel glass">${listed ? `<h2>Board</h2>
          <p>Board confidence <span class="bar ${e.confidence > 0.6 ? 'good' : e.confidence > 0.3 ? 'warn' : 'bad'}"><i style="width:${Math.round(e.confidence * 100)}%"></i></span> ${Math.round(e.confidence * 100)}%</p>
          ${e.demand ? `<div class="callout glass"><b>The board asks:</b> ${esc(e.demand.text)}<br><small>Deadline ${fmtDate(e.demand.deadline, true)}</small></div>` : '<p class="note">No demands right now.</p>'}
          ${s.time < e.blockedUntil ? `<p class="warn">The board is blocking large purchases until ${fmtDate(e.blockedUntil, true)}.</p>` : ''}
          <h2>Capital</h2><div class="row">
            <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'buyback', share: 0.1 })}' data-confirm="Buy back 10% of the free float with company cash?">Buy back 10% of free float</button>
            <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'secondary', share: 0.1 })}' data-confirm="Issue 10% new shares? This dilutes you.">Issue 10% new shares</button></div>
          <h2>Your shares</h2><div class="row">
            ${[0.05, 0.1, 0.25].map((p) => `<button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellPersonalShares', share: p })}' data-confirm="Sell ${Math.round(p * 100)}% of your shares?">Sell ${Math.round(p * 100)}%</button>`).join('')}
            <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'buyPersonalShares', share: 0.1 })}'>Buy 10% of free float</button></div>
          <p class="note">Selling below 50% means the board can overrule you. Big sales push the price down.</p>`
        : `<h2>Ownership</h2><p>You own ${stakePct}% of ${esc(s.airline.name)}. Until the IPO the value is a private estimate: EBITDA × ${corpData.equity.ebitdaMultiple}, adjusted for reputation, plus cash and assets, minus debt.</p>`}</div>
      </div>`;
  }

  private assetsTab(s: Snapshot): string {
    const c = s.corp;
    const A = c.assets;
    const st = c.assetStats;
    const myAirports = [...new Set([s.base, ...s.routes.flatMap((r) => [r.a, r.b])])];
    const lounges = myAirports.map((icao) => {
      const l = A.lounges.find((x) => x.icao === icao);
      const next = corpData.lounges[l ? l.level : 0];
      const stt = st.lounges[icao];
      return `<tr><td><b>${apLabel(icao)}</b></td><td>${l ? corpData.lounges[l.level - 1].label : '—'}</td><td>${stt ? `${this.m(stt.incomeMonth)} in / ${this.m(stt.costMonth)} out` : ''}</td><td>${next ? `<button class="btn sm" data-cmd='${JSON.stringify({ kind: 'buildLounge', icao })}'>${l ? 'Upgrade' : 'Build'} · ${this.m(next.buildUSD)}</button>` : ''}</td></tr>`;
    }).join('');
    const hotels = A.hotels.map((h) => `<tr><td><b>${apLabel(h.icao)}</b></td><td>${corpData.hotels.sizes[h.size].label}</td><td>${Math.round((st.hotels[h.icao]?.occupancy ?? 0) * 100)}% full</td><td class="${(st.hotels[h.icao]?.profitMonth ?? 0) >= 0 ? 'pos' : 'neg'}">${this.m(st.hotels[h.icao]?.profitMonth ?? 0)}/mo</td><td><button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellHotel', icao: h.icao })}' data-confirm="Sell this hotel?">Sell</button></td></tr>`).join('');
    const airports = Object.entries(st.airportValues).sort((a, b) => b[1] - a[1]).map(([icao, v]) => {
      const pct = A.airports[icao] ?? 0;
      return `<tr><td><b>${apLabel(icao)}</b></td><td>${this.m(v)}</td><td>${pct ? `${Math.round(pct * 100)}%${pct >= 0.5 ? ' <span class="tag good">Control</span>' : ''}` : '—'}</td>
        <td>${[0.1, 0.25, 0.51].filter((p) => pct + p <= 1.0001).map((p) => `<button class="btn sm" data-cmd='${JSON.stringify({ kind: 'buyAirportStake', icao, pct: p })}' data-confirm="Buy ${Math.round(p * 100)}% of ${AIRPORTS[icao]?.name} for ${this.m(v * p)}?">+${Math.round(p * 100)}%</button>`).join(' ')}${pct ? ` <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellAirportStake', icao, pct })}' data-confirm="Sell your stake?">Sell</button>` : ''}</td></tr>`;
    }).join('');
    return `<h1>Lounges, hotels & airports</h1>
      <h2>Lounges</h2><div class="panel glass"><p class="note">Lounges win business travellers (more business-class demand on routes from that airport), raise comfort, and sell lounge passes.</p>
        <table><tr><th>Airport</th><th>Lounge</th><th>Per month</th><th></th></tr>${lounges}</table></div>
      <h2>Hotels</h2><div class="panel glass"><p class="note">Airport hotels earn from travellers and crews. Occupancy rises with the size of the city and the passengers you fly through it.</p>
        ${hotels ? `<table><tr><th>Airport</th><th>Hotel</th><th>Occupancy</th><th>Profit</th><th></th></tr>${hotels}</table>` : ''}
        <div class="row"><select id="hotelAp">${myAirports.filter((i) => !A.hotels.some((h) => h.icao === i)).map((i) => `<option value="${i}">${esc(apLabel(i))}</option>`).join('')}</select>
        <select id="hotelSize">${corpData.hotels.sizes.map((h, i) => `<option value="${i}">${h.label} · ${this.m(h.buildUSD)}</option>`).join('')}</select><button class="btn primary" id="hotelGo">Build hotel</button></div></div>
      <h2>Airports</h2><div class="panel glass"><p class="note">Buy into the airports you fly to. Stakes pay about ${Math.round(corpData.airports.yieldPerYear * 100)}% a year from the airport's profits. With 50% or more you control it: ${Math.round(corpData.airports.controlFeeDiscount * 100)}% off your fees there and ${corpData.airports.controlSlots} extra slot pairs.</p>
        <table><tr><th>Airport</th><th>Value</th><th>Your stake</th><th></th></tr>${airports}</table></div>`;
  }

  private chartersTab(s: Snapshot): string {
    const c = s.corp;
    const KL: Record<string, string> = { sports: 'Sports team', tour: 'Holiday charter', government: 'Government', vip: 'VIP', acmi: 'Wet lease (ACMI)' };
    const idle = s.fleet.filter((a) => a.status === 'idle' && !a.routeId && !TYPES[a.typeId].cargoT);
    const offers = c.charters.offers.map((o) => `<div class="actype glass"><h3>${KL[o.kind]}${o.needsVip ? ' <span class="tag">VIP cabin</span>' : ''}</h3><small>${esc(o.client)}</small>
        <ul>${o.kind === 'acmi' ? `<li>${o.months} months with crew, maintenance and insurance</li><li>Needs an airliner with 120+ seats</li>` : `<li>${apLabel(o.from)} ⇄ ${apLabel(o.to)} (${Math.round(o.km).toLocaleString()} km)</li><li>${o.pax} passengers · departs ${fmtDate(o.departAt, true)} · ${o.stayDays} days there</li>`}<li>Offer ends ${fmtDate(o.expiresAt, true)}</li></ul>
        <div class="prices"><span>Pays <b>${this.m(o.payUSD)}</b></span></div>
        <div class="row"><select data-chpick="${o.id}">${idle.map((a) => `<option value="${a.id}" ${this.charterPick[o.id] === a.id ? 'selected' : ''}>${a.reg} · ${TYPES[a.typeId].name}</option>`).join('') || '<option value="">No free aircraft</option>'}</select>
        ${o.kind !== 'acmi' ? `<label><input type="checkbox" data-chself="${o.id}"> I'll fly it</label>` : ''}</div>
        <div class="row"><button class="btn sm primary" data-chaccept="${o.id}">Accept</button><button class="btn sm" data-cmd='${JSON.stringify({ kind: 'declineCharter', offerId: o.id })}'>Decline</button></div></div>`).join('');
    const active = c.charters.active.map((j) => {
      const ac = s.fleet.find((a) => a.id === j.aircraftId);
      return `<tr><td><b>${esc(j.client)}</b><br><small>${KL[j.kind]}</small></td><td>${j.kind === 'acmi' ? `${j.months} months` : `${apLabel(j.from)} ⇄ ${apLabel(j.to)}`}</td><td>${ac?.reg ?? ''}</td><td>${this.m(j.payUSD)}</td><td>until ${fmtDate(j.endsAt, true)}</td>
        <td>${j.selfFly && !j.flown ? `<button class="btn sm primary" data-fly="${j.from}|${j.to}">Fly outbound leg</button>` : j.flown ? 'You flew it ✓' : ''}</td></tr>`;
    }).join('');
    const cargoRoutes = s.routes.filter((r) => r.cargo);
    return `<h1>Charters & cargo</h1>
      <p class="note">Charter clients book one-off trips; wet leases rent an aircraft with crew to another airline for months. Aircraft must be free (not on a route). Fly a charter yourself for a 10% bonus.</p>
      ${active ? `<h2>Booked</h2><div class="panel glass"><table><tr><th>Client</th><th>Trip</th><th>Aircraft</th><th>Pays</th><th>Busy</th><th></th></tr>${active}</table></div>` : ''}
      <h2>Requests</h2>${offers ? `<div class="cards">${offers}</div>` : '<p class="note">No requests right now: new ones arrive every few days.</p>'}
      <h2>Cargo</h2><div class="panel glass"><p>Last 30 days: <b>${Math.round(c.cargoWeek.tonnes).toLocaleString()} t</b> a week, earning <b>${this.m(c.cargoWeek.revenue)}</b> a week.</p>
        <p class="note">Every passenger flight carries some belly cargo automatically (widebodies carry much more). For dedicated freight, lease or buy a freighter (Buy & lease → Freighters) and open a cargo route with it on the Routes tab; you set a rate per kg instead of fares.</p>
        ${cargoRoutes.length ? `<table><tr><th>Cargo route</th><th>Rate</th><th>Tonnes (30 days)</th><th>Revenue (30 days)</th></tr>${cargoRoutes.map((r) => `<tr><td>${apLabel(r.a)} ⇄ ${apLabel(r.b)}</td><td>${this.px(r.fareY)}/kg</td><td>${Math.round(r.last30.cargoT ?? 0)}</td><td>${this.m(r.last30.cargoRev ?? 0)}</td></tr>`).join('')}</table>` : ''}</div>`;
  }

  private empireTab(s: Snapshot): string {
    const E = s.empire;
    const st = E.state;
    const P = s.corp.personal;
    const cars = st.cars.map((c) => {
      const m = empireData.cars.find((x) => x.id === c.model)!;
      return `<tr><td><i class="sw" style="background:${c.color}"></i> <b>${m.name}</b>${st.activeCar === c.id ? ' <span class="tag good">Driving</span>' : ''}</td><td>${this.m(c.valueUSD)}</td>
        <td>${st.activeCar === c.id ? '' : `<button class="btn sm" data-cmd='${JSON.stringify({ kind: 'setActiveCar', id: c.id })}'>Use</button>`}
        <select data-paint="${c.id}"><option value="">Respray…</option>${empireData.carColours.map((col) => `<option value="${col}" style="background:${col}">${col}</option>`).join('')}</select>
        <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellCar', id: c.id })}' data-confirm="Sell this car?">Sell</button></td></tr>`;
    }).join('');
    const carShop = empireData.cars.map((m) => `<div class="actype glass"><h3>${m.name}</h3><small>${m.topKmh} km/h · 0–100 in ${m.accel}s</small>
      <div class="prices"><span>Price <b>${this.m(m.priceUSD)}</b><small>${this.m(m.upkeepMonthUSD)}/mo upkeep</small></span></div>
      <div class="row"><button class="btn sm primary" data-buycar="${m.id}">Buy</button></div></div>`).join('');
    const loc = st.location;
    const dests = [...new Set([s.base, ...empireData.properties.map((p) => p.icao), ...s.routes.flatMap((r) => [r.a, r.b])])].filter((i) => AIRPORTS[i]);
    const jets = st.aircraft.map((a) => {
      const t = TYPES[a.typeId];
      return `<tr><td><b>${t.name}</b> <small>${a.reg}</small></td><td>${t.rangeKm.toLocaleString()} km</td><td>${this.m(a.valueUSD)}</td>
        <td><select data-travelto="${a.id}">${dests.filter((i) => i !== loc).map((i) => `<option value="${i}">${esc(apLabel(i))} · ${Math.round(distanceKm(AIRPORTS[loc] ?? AIRPORTS[s.base], AIRPORTS[i]))} km</option>`).join('')}</select>
        <button class="btn sm primary" data-travel="${a.id}">Fly there</button>${a.typeId === 'gl7t' ? ` <button class="btn sm primary" data-flyjet="${a.id}" title="Take the controls yourself">Fly it yourself</button>` : ''} <button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellPersonalAircraft', id: a.id })}' data-confirm="Sell it?">Sell</button></td></tr>`;
    }).join('');
    const jetShop = (empireData.aircraft.types as string[]).map((id) => TYPES[id]).filter(Boolean).map((t) => `<div class="actype glass"><h3>${t.name}</h3><small>${t.category} · ${t.rangeKm.toLocaleString()} km</small>
      <div class="prices"><span>Price <b>${this.m(t.priceUSD)}</b><small>${this.m((t.priceUSD * empireData.aircraft.upkeepShareYear) / 12)}/mo crew & upkeep</small></span></div>
      <div class="row"><button class="btn sm primary" data-cmd='${JSON.stringify({ kind: 'buyPersonalAircraft', typeId: t.id })}' data-confirm="Buy a ${t.name} for ${this.m(t.priceUSD)}?">Buy</button></div></div>`).join('');
    const yachts = st.yachts.map((y) => `<tr><td><b>${esc(y.name)}</b><br><small>${empireData.yachts.find((x) => x.id === y.model)?.name}</small></td><td>${this.m(y.valueUSD)}</td><td><button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellYacht', id: y.id })}' data-confirm="Sell it?">Sell</button></td></tr>`).join('');
    const props = empireData.properties.map((p) => {
      const own = st.properties.find((x) => x.id === p.id);
      return `<tr><td><b>${p.name}</b></td><td>${this.m(own?.valueUSD ?? p.priceUSD)}${own ? ' <span class="tag good">Yours</span>' : ''}</td><td>${own ? `<button class="btn sm" data-cmd='${JSON.stringify({ kind: 'sellProperty', id: p.id })}' data-confirm="Sell it?">Sell</button>` : `<button class="btn sm" data-cmd='${JSON.stringify({ kind: 'buyProperty', id: p.id })}' data-confirm="Buy ${p.name} for ${this.m(p.priceUSD)}?">Buy</button>`}</td></tr>`;
    }).join('');
    const nextHome = empireData.home[st.homeTier + 1];
    const rich = E.richList.slice(0, 20);
    const meIn = rich.some((r) => r.you);
    const achs = achData.list.map((a) => `<div class="ach ${st.achievements[a.id] ? 'on' : ''}" title="${esc(a.text)}"><span>🏆</span><b>${esc(a.name)}</b><small>${esc(a.text)}</small></div>`).join('');
    return `<h1>Personal empire</h1>
      <div class="kpis">${this.kpi('Personal cash', this.m(P.cashUSD))}${this.kpi('Net worth', this.m(E.netWorthUSD))}${this.kpi('Rich list', E.richRank <= 50 ? `#${E.richRank}` : 'Not yet (top 50)')}
        ${this.kpi('Your airline stake', this.m(P.stakeValueUSD))}${this.kpi('Possessions', this.m(E.assetsValueUSD))}${this.kpi('Upkeep', `${this.m(E.upkeepMonthUSD)}/mo`)}</div>
      <div class="fingrid"><div class="panel glass"><h2>Income</h2>
        <label>CEO salary <select id="salary">${[0, 250000, 500000, 1000000, 2000000, 3000000, 5000000].map((v) => `<option value="${v}" ${v === st.salaryUSDPerYear ? 'selected' : ''}>${this.m(v)} a year</option>`).join('')}</select></label>
        <p class="note">Paid by the airline; you keep about 60% after tax. Dividends (Shares & board) and share sales also feed your personal cash. A listed company's board dislikes salaries over ${this.m(empireData.ceoSalary.boardFrownsOverUSD)}.</p></div>
      <div class="panel glass"><h2>Home: ${empireData.home[st.homeTier].name}</h2>
        <p class="note">Your home is next to ${apLabel(s.base)}, north of the terminal car park.</p>
        <div class="row"><button class="btn primary" data-visit="home">Go home</button><button class="btn" data-visit="hq">Go to HQ</button><button class="btn" id="drive" ${st.activeCar ? '' : 'disabled'}>Drive your car</button></div>
        ${nextHome ? `<div class="row"><button class="btn sm" data-cmd='${JSON.stringify({ kind: 'upgradeHome' })}' data-confirm="Move to a ${nextHome.name.toLowerCase()} (${this.m(nextHome.priceUSD)}, your current home is sold towards it)?">Upgrade to ${nextHome.name} · ${this.m(nextHome.priceUSD)}</button></div>` : ''}</div></div>
      <h2>Garage</h2>${cars ? `<div class="panel glass"><table>${cars}</table></div>` : ''}
      <div class="row"><span class="note">Colour for new cars:</span><span class="swatches">${empireData.carColours.map((c) => `<button class="swatch ${c === this.carColour ? 'on' : ''}" data-carcol="${c}" style="background:${c}"></button>`).join('')}</span></div>
      <div class="cards">${carShop}</div>
      <h2>Hangar</h2>${jets ? `<div class="panel glass"><table>${jets}</table><p class="note">You are at ${apLabel(loc)}. A trip takes the real flight time on the airline's clock and costs fuel from your personal cash.</p></div>` : ''}
      <div class="cards">${jetShop}</div>
      <h2>Marina</h2>${yachts ? `<div class="panel glass"><table>${yachts}</table></div>` : ''}
      <div class="cards">${empireData.yachts.map((y) => `<div class="actype glass"><h3>${y.name}</h3><div class="prices"><span>Price <b>${this.m(y.priceUSD)}</b><small>${this.m((y.priceUSD * y.upkeepShareYear) / 12)}/mo crew & upkeep</small></span></div>
        <div class="row"><input placeholder="Name her" data-yname="${y.id}" value="Sky Empress"><button class="btn sm primary" data-buyyacht="${y.id}">Buy</button></div></div>`).join('')}</div>
      <h2>Properties</h2><div class="panel glass"><table>${props}</table><p class="note">Property values tend to rise; upkeep is about 1–3% a year.</p></div>
      <div class="fingrid"><div><h2>Rich list</h2><div class="panel glass"><table>${rich.map((r, i) => `<tr class="${r.you ? 'me' : ''}"><td>${i + 1}</td><td><b>${esc(r.name)}</b><br><small>${esc(r.field)}</small></td><td>${this.m(r.worthUSD)}</td></tr>`).join('')}
        ${meIn ? '' : `<tr class="me"><td>${E.richRank <= 50 ? E.richRank : '—'}</td><td><b>You</b></td><td>${this.m(E.netWorthUSD)}</td></tr>`}</table><p class="note">Fictional people. Net worth = personal cash + your airline shares + possessions.</p></div></div>
        <div><h2>Achievements <small>${Object.keys(st.achievements).length} / ${achData.list.length}</small></h2><div class="achs">${achs}</div></div></div>`;
  }

  private hqTab(s: Snapshot): string {
    const st = s.empire.state;
    const tier = hqData.tiers[st.hq.tier];
    const next = hqData.tiers[st.hq.tier + 1];
    const rows = (Object.entries(hqData.departments) as [HqDept, (typeof hqData.departments)[HqDept]][]).map(([id, d]) => {
      const l = st.hq.depts[id] ?? 0;
      const can = l < 3 && l + 1 <= st.hq.tier + 1;
      return `<tr><td><b>${d.name}</b><br><small>${d.room}</small></td><td><span class="pips">${[1, 2, 3].map((i) => `<i class="${i <= l ? 'on' : ''}"></i>`).join('')}</span></td><td><small>${d.effect}</small></td>
        <td>${l >= 3 ? 'Top level' : can ? `<button class="btn sm primary" data-cmd='${JSON.stringify({ kind: 'upgradeDept', dept: id })}'>Level ${l + 1} · ${this.m(hqData.levelCostUSD[l])}</button>` : `<small>Needs ${hqData.tiers[l].name}</small>`}</td></tr>`;
    }).join('');
    return `<h1>Headquarters</h1>
      <div class="kpis">${this.kpi('Building', tier.name)}${this.kpi('Running costs', `${this.m(s.empire.hqMonthUSD)}/mo`)}${this.kpi('Departments', `${Object.values(st.hq.depts).reduce((a, b) => a + b, 0)} / 30 levels`)}</div>
      <div class="row"><button class="btn primary" data-visit="hq">Visit your HQ</button>${next ? `<button class="btn" data-cmd='${JSON.stringify({ kind: 'upgradeHqTier' })}' data-confirm="Move to a ${next.name.toLowerCase()} for ${this.m(next.priceUSD)}?">Move to ${next.name} · ${this.m(next.priceUSD)}</button>` : ''}</div>
      <p class="note">Each department level adds a room you can walk into at your HQ next to the terminal. A rented floor allows level 1, your own building level 2, and a landmark tower level 3. Running costs: ${hqData.levelMonthUSD.map((v) => this.m(v)).join(' / ')} a month per level.</p>
      <div class="panel glass"><table><tr><th>Department</th><th>Level</th><th>Effect</th><th></th></tr>${rows}</table></div>`;
  }

  private airlineTab(s: Snapshot): string {
    return `<h1>Airline & saves</h1>
      <div class="fingrid">
        <div class="panel glass"><h2>${esc(s.airline.name)} <small>(${esc(s.airline.code)})</small></h2>
          <p class="note">Colours <i class="sw" style="background:${s.airline.primary}"></i><i class="sw" style="background:${s.airline.accent}"></i> · edit your brand and livery in <a data-go="customise">Customise</a>.</p>
          <label>Display currency <select id="curSel">${(['GBP', 'USD', 'EUR', 'ZAR'] as Currency[]).map((c) => `<option ${c === s.airline.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <p class="note">Exchange rates: ${ratesSource()}.</p>
          <h2>Airport slots</h2>
          <table><tr><th>Airport</th><th>Daily slot pairs</th><th>In use</th></tr>
          ${Object.keys({ ...s.slots, ...s.slotsUsed }).map((ap) => `<tr><td>${apLabel(ap)}</td><td>${s.slots[ap] ?? 0}</td><td>${s.slotsUsed[ap] ?? 0}</td></tr>`).join('') || '<tr><td colspan="3">None</td></tr>'}</table>
        </div>
        <div class="panel glass"><h2>Save & load</h2>
          <div class="row"><input id="saveName" placeholder="Save name" value="${esc(s.airline.name)}"><button class="btn primary" id="saveBtn">Save</button></div>
          <div class="row"><button class="btn" id="loadBtn">Load a game…</button><button class="btn" id="exportBtn">Export to file (JSON)</button></div>
          <p class="note">The game also autosaves every 5 minutes and when you close the tab.</p></div>
      </div>`;
  }

  // ------------------------------------------------------------------ events
  private bind(body: HTMLElement): void {
    const s = this.snap!;
    const on = (sel: string, ev: string, fn: (e: Event, el: HTMLElement) => void) => body.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener(ev, (e) => fn(e, el)));
    const act = async (cmd: Parameters<EconomyClient['cmd']>[0]) => {
      const r = await this.eco.cmd(cmd);
      toast(r.msg, r.ok ? 'good' : 'bad');
      return r;
    };
    on('[data-go]', 'click', (_e, el) => this.show(el.dataset.go as Tab));
    on('#guideHide', 'click', () => {
      try {
        localStorage.setItem('skyempire.guide.hidden', '1');
      } catch {
        /* ignore */
      }
      this.render();
    });
    // routes
    const readAp = (v: string) => {
      const code = v.split('·')[0].trim().toUpperCase();
      return Object.values(AIRPORTS).find((a) => a.iata === code || a.icao === code)?.icao ?? '';
    };
    on('#rA', 'change', (_e, el) => { this.draft.a = readAp((el as HTMLInputElement).value); this.prefill(); });
    on('#rB', 'change', (_e, el) => { this.draft.b = readAp((el as HTMLInputElement).value); this.prefill(); });
    on('[data-pick]', 'click', (_e, el) => {
      const id = el.dataset.pick!;
      const d = this.draft;
      d.aircraft = d.aircraft.includes(id) ? d.aircraft.filter((x) => x !== id) : [...d.aircraft, id];
      this.requote();
    });
    on('#rF', 'change', (_e, el) => { this.draft.freq = Math.max(1, +(el as HTMLInputElement).value); this.requote(); });
    on('#rY', 'change', (_e, el) => { this.draft.fareY = fromCurrency(+(el as HTMLInputElement).value, this.cur); this.requote(); });
    on('#rJ', 'change', (_e, el) => { this.draft.fareJ = fromCurrency(+(el as HTMLInputElement).value, this.cur); this.requote(); });
    on('#rW', 'change', (_e, el) => { this.draft.fareW = fromCurrency(+(el as HTMLInputElement).value, this.cur); this.requote(); });
    on('#rOpen', 'click', async () => {
      const d = this.draft;
      const r = d.editing
        ? await act({ kind: 'editRoute', routeId: d.editing, aircraftIds: d.aircraft, weeklyFreq: d.freq, fareY: d.fareY, fareJ: d.fareJ, fareW: d.fareW })
        : await act({ kind: 'createRoute', a: d.a, b: d.b, aircraftIds: d.aircraft, weeklyFreq: d.freq, fareY: d.fareY, fareJ: d.fareJ, fareW: d.fareW });
      if (r.ok) {
        this.draft = { a: s.base, b: '', aircraft: [], freq: 14, fareY: 0, fareJ: 0, fareW: 0, editing: '' };
        this.quote = null;
        this.render();
      }
    });
    on('#rCancel', 'click', () => {
      this.draft = { a: s.base, b: '', aircraft: [], freq: 14, fareY: 0, fareJ: 0, fareW: 0, editing: '' };
      this.quote = null;
      this.render();
    });
    on('[data-fly]', 'click', (_e, el) => {
      const [a, b] = el.dataset.fly!.split('|');
      const from = b === s.base ? b : a;
      this.cb.onFly(from, from === a ? b : a);
    });
    on('[data-staff]', 'change', async (_e, el) => {
      const [dept, key] = el.dataset.staff!.split('.');
      await act({ kind: 'setStaff', dept: dept as never, [key]: +(el as HTMLInputElement).value / 100 });
      this.render();
    });
    on('[data-edit]', 'click', (_e, el) => {
      const r = s.routes.find((x) => x.id === el.dataset.edit)!;
      this.draft = { a: r.a, b: r.b, aircraft: [...r.aircraftIds], freq: r.weeklyFreq, fareY: r.fareY, fareJ: r.fareJ, fareW: r.fareW ?? Math.round(r.fareY * 1.6), editing: r.id };
      this.requote();
    });
    on('[data-close]', 'click', async (_e, el) => {
      if (confirm('Close this route? Its aircraft become free.')) {
        await act({ kind: 'deleteRoute', routeId: el.dataset.close! });
        this.render();
      }
    });
    on('[data-slots]', 'click', async (_e, el) => {
      await act({ kind: 'buySlots', icao: el.dataset.slots!, count: +el.dataset.n! });
      this.requote();
    });
    // fleet & market
    on('[data-sell]', 'click', async (_e, el) => { if (confirm('Sell this aircraft?')) { await act({ kind: 'sell', aircraftId: el.dataset.sell! }); this.render(); } });
    on('[data-return]', 'click', async (_e, el) => { if (confirm('Return this leased aircraft? Early returns cost 3 months of lease.')) { await act({ kind: 'returnLease', aircraftId: el.dataset.return! }); this.render(); } });
    on('[data-buy]', 'click', async (_e, el) => { await act({ kind: 'buyNew', typeId: el.dataset.buy!, count: 1 }); });
    on('[data-lease]', 'click', async (_e, el) => { await act({ kind: 'lease', typeId: el.dataset.lease!, count: 1 }); });
    on('[data-used]', 'click', async (_e, el) => { await act({ kind: 'buyUsed', listingId: el.dataset.used! }); this.render(); });
    // finances
    on('#finMonth', 'change', (_e, el) => { this.financeMonth = (el as HTMLSelectElement).value; this.render(); });
    const chart = body.querySelector<HTMLCanvasElement>('#cashChart');
    if (chart) drawCash(chart, s, this.cur);
    // airline
    on('#curSel', 'change', async (_e, el) => { await act({ kind: 'setCurrency', currency: (el as HTMLSelectElement).value as Currency }); this.render(); });
    on('#saveBtn', 'click', () => this.cb.onSave((body.querySelector('#saveName') as HTMLInputElement).value || s.airline.name));
    on('#loadBtn', 'click', () => this.cb.onLoadMenu());
    on('#exportBtn', 'click', () => this.cb.onExport());
    // M7: empire and HQ
    on('[data-visit]', 'click', (_e, el) => this.cb.onVisit(el.dataset.visit as 'home'));
    on('#drive', 'click', () => this.cb.onDrive());
    on('#salary', 'change', async (_e, el) => { await act({ kind: 'setSalary', usdPerYear: +(el as HTMLSelectElement).value }); this.render(); });
    on('[data-carcol]', 'click', (_e, el) => { this.carColour = el.dataset.carcol!; this.render(); });
    on('[data-buycar]', 'click', async (_e, el) => {
      const m = empireData.cars.find((x) => x.id === el.dataset.buycar)!;
      if (!confirm(`Buy the ${m.name} for ${this.m(m.priceUSD)}?`)) return;
      await act({ kind: 'buyCar', model: m.id, color: this.carColour });
      this.render();
    });
    on('[data-paint]', 'change', async (_e, el) => {
      const v = (el as HTMLSelectElement).value;
      if (v) await act({ kind: 'paintCar', id: el.dataset.paint!, color: v });
      this.render();
    });
    on('[data-buyyacht]', 'click', async (_e, el) => {
      const y = empireData.yachts.find((x) => x.id === el.dataset.buyyacht)!;
      const name = (body.querySelector(`[data-yname="${y.id}"]`) as HTMLInputElement).value;
      if (!confirm(`Buy the ${y.name} "${name}" for ${this.m(y.priceUSD)}?`)) return;
      await act({ kind: 'buyYacht', model: y.id, name });
      this.render();
    });
    on('[data-travel]', 'click', (_e, el) => {
      const id = el.dataset.travel!;
      const to = (body.querySelector(`[data-travelto="${id}"]`) as HTMLSelectElement)?.value;
      if (to) this.cb.onTravel(to, id);
    });
    on('[data-flyjet]', 'click', (_e, el) => {
      const id = el.dataset.flyjet!;
      const to = (body.querySelector(`[data-travelto="${id}"]`) as HTMLSelectElement)?.value;
      if (to) this.cb.onFlyJet(to, id);
    });
    on('#rIdeas', 'click', async () => {
      const r = await this.eco.cmd({ kind: 'opportunities' });
      this.ideas = (r.data as Opportunity[]) ?? [];
      this.render();
    });
    on('[data-idea]', 'click', (_e, el) => {
      this.draft.a = s.base;
      this.draft.b = el.dataset.idea!;
      this.prefill();
    });
    on('#rOptimise', 'click', async () => {
      const d = this.draft;
      const ac = s.fleet.find((a) => a.id === d.aircraft[0]);
      if (!ac) return;
      const r = await this.eco.cmd({ kind: 'suggestFares', a: d.a, b: d.b, typeId: ac.typeId, aircraftCount: d.aircraft.length, weeklyFreq: d.freq, aircraftId: ac.id });
      if (!r.ok) return toast(r.msg, 'bad');
      const f = r.data as { fareY: number; fareJ: number };
      d.fareY = f.fareY;
      d.fareJ = f.fareJ;
      toast('Fares optimised for profit', 'good');
      this.requote();
    });
    // M6: generic commands
    on('[data-cmd]', 'click', async (_e, el) => {
      if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
      await act(JSON.parse(el.dataset.cmd!));
      this.render();
    });
    on('#loanGo', 'click', async () => {
      const amt = fromCurrency(+(body.querySelector('#loanAmt') as HTMLInputElement).value, this.cur);
      await act({ kind: 'takeLoan', amountUSD: amt, termMonths: +(body.querySelector('#loanTerm') as HTMLSelectElement).value });
      this.render();
    });
    const clAmt = () => fromCurrency(+(body.querySelector('#clAmt') as HTMLInputElement).value, this.cur);
    on('#clDraw', 'click', async () => { await act({ kind: 'drawCredit', amountUSD: clAmt() }); this.render(); });
    on('#clRepay', 'click', async () => { await act({ kind: 'repayCredit', amountUSD: clAmt() }); this.render(); });
    on('#clAuto', 'change', async (_e, el) => { await act({ kind: 'setAutoDraw', on: (el as HTMLInputElement).checked }); });
    on('#ipoGo', 'click', async () => {
      const f = +(body.querySelector('#ipoFloat') as HTMLSelectElement).value;
      if (!confirm(`Float ${Math.round(f * 100)}% of ${s.airline.name} on the stock exchange?`)) return;
      await act({ kind: 'ipo', float: f });
      this.render();
    });
    on('#payout', 'change', async (_e, el) => { await act({ kind: 'setPayout', payout: +(el as HTMLSelectElement).value }); this.render(); });
    on('[data-bidopen]', 'click', (_e, el) => { this.bidTarget = el.dataset.bidopen!; this.render(); this.el.querySelector('.opsmain')!.scrollTop = 0; });
    on('#bidCancel', 'click', () => { this.bidTarget = ''; this.render(); });
    on('#bidGo', 'click', async () => {
      const r = await act({ kind: 'bid', rivalId: this.bidTarget, premium: +(body.querySelector('#bidPrem') as HTMLSelectElement).value, mode: (body.querySelector('#bidMode') as HTMLSelectElement).value as 'merge' });
      if (r.ok) this.bidTarget = '';
      this.render();
    });
    on('#alFound', 'click', async () => { await act({ kind: 'foundAlliance', name: (body.querySelector('#alName') as HTMLInputElement).value }); this.render(); });
    on('#hotelGo', 'click', async () => {
      const icao = (body.querySelector('#hotelAp') as HTMLSelectElement).value;
      const size = +(body.querySelector('#hotelSize') as HTMLSelectElement).value;
      if (!icao || !confirm(`Build ${corpData.hotels.sizes[size].label} at ${AIRPORTS[icao]?.name}?`)) return;
      await act({ kind: 'buildHotel', icao, size });
      this.render();
    });
    on('[data-chpick]', 'change', (_e, el) => { this.charterPick[el.dataset.chpick!] = (el as HTMLSelectElement).value; });
    on('[data-chaccept]', 'click', async (_e, el) => {
      const id = el.dataset.chaccept!;
      const ac = (body.querySelector(`[data-chpick="${id}"]`) as HTMLSelectElement)?.value;
      const self = (body.querySelector(`[data-chself="${id}"]`) as HTMLInputElement | null)?.checked ?? false;
      if (!ac) return toast('No free aircraft: take one off a route or lease another', 'bad');
      await act({ kind: 'acceptCharter', offerId: id, aircraftId: ac, selfFly: self });
      this.render();
    });
    const pc = body.querySelector<HTMLCanvasElement>('#priceChart');
    if (pc) drawSeries(pc, s.corp.equity.history.map((h) => ({ t: h.t, v: toCurrency(h.p, this.cur) })), (v) => `${symbol(this.cur)}${v.toFixed(2)}`);
    // customise
    on('[data-cust]', 'click', (_e, el) => this.cb.onCustomise(el.dataset.cust as 'livery'));
    on('[data-cabin]', 'click', (_e, el) => this.cb.onCustomise('cabin', el.dataset.cabin));
    on('[data-design]', 'click', (_e, el) => this.cb.onCustomise('designer', el.dataset.design));
    on('#bSave', 'click', async () => {
      const v = (id: string) => (body.querySelector(id) as HTMLInputElement).value;
      await act({ kind: 'setBrand', name: v('#bName'), code: v('#bCode'), primary: v('#bPrimary'), accent: v('#bAccent') });
      this.render();
    });
  }

  /** Globe click: fill the route form (from = base by default). */
  private pickAirport(icao: string): void {
    const d = this.draft;
    if (this.tab !== 'routes') this.show('routes');
    if (!d.a) d.a = this.snap?.base ?? icao;
    if (icao !== d.a) d.b = icao;
    else d.b = '';
    this.prefill();
  }

  private prefill(): void {
    const d = this.draft;
    if (d.a && d.b) {
      const f = refFares(distanceKm(AIRPORTS[d.a], AIRPORTS[d.b]));
      d.fareY = f.y;
      d.fareJ = f.j;
      d.fareW = Math.round(f.y * 1.6);
    }
    this.requote();
  }

  private async requote(): Promise<void> {
    const d = this.draft;
    const s = this.snap!;
    const ac = d.aircraft.map((id) => s.fleet.find((a) => a.id === id)).filter(Boolean);
    // switching between passenger aircraft and freighters resets the fare to a sensible reference
    const t0 = TYPES[ac[0]?.typeId ?? ''];
    if (t0 && d.a && d.b) {
      const km = distanceKm(AIRPORTS[d.a], AIRPORTS[d.b]);
      if (t0.cargoT && d.fareY > 20) d.fareY = +Corporate.refCargoRate(km).toFixed(2);
      else if (!t0.cargoT && d.fareY < 20) d.fareY = refFares(km).y;
    }
    if (d.a && d.b && ac.length) {
      this.quote = await this.eco.quote({ kind: 'quote', a: d.a, b: d.b, typeId: ac[0]!.typeId, aircraftCount: ac.length, weeklyFreq: d.freq, fareY: d.fareY, fareJ: d.fareJ, fareW: d.fareW, routeId: d.editing || undefined, aircraftId: ac[0]!.id });
    } else this.quote = null;
    this.render();
    if (d.a) this.globe?.focusAirport(d.b || d.a);
  }

  speedBar(): string {
    return SPEEDS.map((v) => `<button data-speed="${v}">${v === 0 ? '❚❚' : `${v}×`}</button>`).join('');
  }
}

// ------------------------------------------------------------------ helpers
export function fmtDate(t: number, short = false): string {
  const d = new Date(t);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: short ? undefined : 'numeric', timeZone: 'Europe/London' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  return `${date} ${time}`;
}

function difficultyLabel(d: string): string {
  return { easy: 'Career · Easy', normal: 'Career · Normal', hard: 'Career · Hard', sandbox: 'Sandbox' }[d] ?? d;
}

let toastTimer = 0;
export function toast(text: string, level: string = 'info'): void {
  if (!text) return;
  let el = document.getElementById('opsToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'opsToast';
    el.className = 'glass';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = `glass show ${level}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3000);
}

function drawSeries(c: HTMLCanvasElement, pts: { t: number; v: number }[], fmt: (v: number) => string): void {
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  if (pts.length < 2) {
    g.fillStyle = '#8da0bb';
    g.font = '14px Segoe UI';
    g.fillText('Not enough history yet.', 20, H / 2);
    return;
  }
  const x0 = pts[0].t;
  const x1 = pts[pts.length - 1].t;
  const lo = Math.min(...pts.map((p) => p.v)) * 0.97;
  const hi = Math.max(...pts.map((p) => p.v)) * 1.03;
  const X = (t: number) => 60 + ((t - x0) / Math.max(1, x1 - x0)) * (W - 70);
  const Y = (v: number) => H - 20 - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 36);
  g.font = '11px Segoe UI';
  g.fillStyle = '#8da0bb';
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    g.fillText(fmt(v), 2, Y(v) + 4);
  }
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v))));
  g.strokeStyle = pts[pts.length - 1].v >= pts[0].v ? '#3ccf8e' : '#f2555a';
  g.lineWidth = 2;
  g.stroke();
}

function drawCash(c: HTMLCanvasElement, s: Snapshot, cur: Currency): void {
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  const h = s.history;
  if (h.length < 2) {
    g.fillStyle = '#8da0bb';
    g.font = '14px Segoe UI';
    g.fillText('Not enough history yet: speed up time.', 20, H / 2);
    return;
  }
  const xs = h.map((p) => p.t);
  const ys = h.map((p) => toCurrency(p.cash, cur));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(0, ...ys);
  const y1 = Math.max(...ys) * 1.05 || 1;
  const X = (t: number) => 50 + ((t - x0) / Math.max(1, x1 - x0)) * (W - 60);
  const Y = (v: number) => H - 24 - ((v - y0) / (y1 - y0)) * (H - 40);
  g.strokeStyle = 'rgba(160,190,230,0.16)';
  g.fillStyle = '#8da0bb';
  g.font = '11px Segoe UI';
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4;
    g.beginPath();
    g.moveTo(50, Y(v));
    g.lineTo(W - 10, Y(v));
    g.stroke();
    g.fillText(money(v / (toCurrency(1, cur) || 1), cur), 2, Y(v) + 4);
  }
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(224,165,38,0.35)');
  grad.addColorStop(1, 'rgba(224,165,38,0)');
  g.beginPath();
  g.moveTo(X(xs[0]), Y(ys[0]));
  for (let i = 1; i < xs.length; i++) g.lineTo(X(xs[i]), Y(ys[i]));
  g.strokeStyle = '#e0a526';
  g.lineWidth = 2;
  g.stroke();
  g.lineTo(X(xs[xs.length - 1]), Y(y0));
  g.lineTo(X(xs[0]), Y(y0));
  g.fillStyle = grad;
  g.fill();
  g.fillStyle = '#8da0bb';
  g.fillText(fmtDate(x0, true), 50, H - 6);
  g.textAlign = 'right';
  g.fillText(fmtDate(x1, true), W - 10, H - 6);
  g.textAlign = 'left';
}
