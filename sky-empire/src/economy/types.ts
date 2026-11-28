/** Shared types between the economy Web Worker and the main thread. All money is USD. */
import type { CabinLayout } from './cabin';

export type { CabinLayout };

/** One paint layer on the fuselage (positions in metres: s along the fuselage from the nose, h above the centreline). */
export interface LiveryLayer {
  id: string;
  kind: 'band' | 'stripe' | 'text' | 'logo';
  color: string;
  s0: number;
  s1: number;
  h: number;
  height: number;
  sweep: number;
  text: string;
  font: string;
  visible: boolean;
}

export interface Livery {
  base: string;
  belly: { color: string; height: number; sweep: number };
  cheat: { on: boolean; color: string; width: number };
  windowFrame: string;
  engines: string;
  title: { text: string; color: string; font: string; size: number; s: number; height: number; italic: boolean };
  regColor: string;
  tail: { color: string; style: 'swoosh' | 'emblem' | 'stripes' | 'solid' | 'logo'; accent: string };
  layers: LiveryLayer[];
  logo?: string;
}

export interface CharacterLook {
  height: number;
  build: number;
  head: number;
  skin: string;
  hair: string;
  hairStyle: 'short' | 'bald' | 'long';
  outfit: 'pilot' | 'ceo' | 'casual';
  cap: boolean;
}

export type Difficulty = 'easy' | 'normal' | 'hard' | 'sandbox';
export type Currency = 'GBP' | 'USD' | 'EUR' | 'ZAR';

export interface NewGameParams {
  airlineName: string;
  code: string;
  primary: string;
  accent: string;
  currency: Currency;
  difficulty: Difficulty;
  seed?: number;
  /** GBP per USD at game start (live rate), so start packages are exact in pounds */
  gbpPerUsd?: number;
}

export interface AirportInfo {
  icao: string;
  iata: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: number; // 0 large, 1 medium
  runwayM: number;
  market: number;
  tourism: number;
  elevFt: number;
}

export interface AircraftType {
  id: string;
  name: string;
  maker: string;
  role: string;
  category: string;
  seats: [number, number];
  cargoT?: number;
  rangeKm: number;
  cruiseKt: number;
  fuelKgPerHr: number;
  mtowT: number;
  runwayM: number;
  priceUSD: number;
  leaseMonthUSD: number;
  maintPerHrUSD: number;
  cabinCrew: number;
  deliveryMonths: number;
  newAvailable: boolean;
  turnMin: number;
  model?: string;
  custom?: boolean;
  design?: Record<string, string | number>;
}

export type AircraftStatus = 'ordered' | 'delivering' | 'idle' | 'flying' | 'turnaround' | 'maintenance' | 'ferry' | 'charter';

export interface FleetAircraft {
  id: string;
  typeId: string;
  reg: string;
  ownership: 'owned' | 'leased';
  ageYears: number;
  condition: number;
  bookValueUSD: number;
  leaseMonthUSD: number;
  leaseStart: number;
  deliveryAt: number;
  balanceDueUSD: number;
  location: string;
  routeId: string | null;
  status: AircraftStatus;
  hours: number;
  hoursSinceCheck: number;
  cycles: number;
  // schedule state
  cabin?: CabinLayout;
  phase: 'wait' | 'out' | 'turnB' | 'back' | 'turnA';
  nextAt: number;
  periodStart: number;
  flightFrom: string;
  flightTo: string;
  flightDep: number;
  flightArr: number;
}

export interface RouteStats {
  flights: number;
  paxY: number;
  paxJ: number;
  paxW?: number;
  cargoT?: number;
  cargoRev?: number;
  seats: number;
  revenue: number;
  cost: number;
}

export interface Route {
  id: string;
  a: string;
  b: string;
  distanceKm: number;
  aircraftIds: string[];
  weeklyFreq: number;
  fareY: number;
  fareJ: number;
  fareW?: number;
  /** freighter route: fareY is the cargo rate in USD per kg */
  cargo?: boolean;
  createdAt: number;
  total: RouteStats;
  last30: RouteStats & { since: number };
}

export interface UsedListing {
  id: string;
  typeId: string;
  ageYears: number;
  condition: number;
  priceUSD: number;
  location: string;
  hours: number;
}

export type LedgerCategory =
  | 'ticketRevenue' | 'otherRevenue'
  | 'fuel' | 'crew' | 'maintenance' | 'airportFees' | 'navigation' | 'handling' | 'catering'
  | 'leases' | 'overhead' | 'insurance' | 'slots' | 'aircraftPurchases' | 'aircraftSales' | 'deposits'
  | 'salaries' | 'compensation' | 'distribution'
  // M6
  | 'cargoRevenue' | 'charterRevenue' | 'assetIncome' | 'investmentIncome' | 'subsidiaryIncome' | 'assetCosts'
  | 'interest' | 'loanIn' | 'loanRepayment' | 'equityIn' | 'buybacks' | 'dividends' | 'investments' | 'divestments';

export type Dept = 'pilots' | 'cabin' | 'engineers' | 'ground' | 'hq';

export interface StaffDept {
  pay: number; // 1 = market rate
  staffing: number; // 1 = exactly the headcount needed
  morale: number; // 0..1
  headcount: number;
  required: number;
}

export interface RivalRoute {
  a: string;
  b: string;
  freq: number;
  fare: number; // fare factor vs reference
}

export interface Rival {
  id: string;
  name: string;
  colors: [string, string];
  model: string;
  quality: number;
  aggression: number;
  hubs: string[];
  seats: number;
  routes: RivalRoute[];
}

// ------------------------------------------------------------------ M6 corporate
export interface Loan { id: string; principalUSD: number; balanceUSD: number; ratePerYear: number; termMonths: number; monthsLeft: number; paymentUSD: number; takenAt: number }
export interface FinanceState { loans: Loan[]; creditDrawnUSD: number; breaches: number; autoDraw: boolean }
export interface BoardDemand { kind: 'profit' | 'dividend' | 'growth' | 'debt'; text: string; start: number; deadline: number; target: number }
export interface EquityState {
  listed: boolean;
  ipoAt: number | null;
  shares: number;
  playerShares: number;
  price: number;
  history: { t: number; p: number }[];
  payout: number; // share of monthly net profit paid as dividends
  confidence: number; // board confidence 0..1
  demand: BoardDemand | null;
  nextDemandAt: number;
  blockedUntil: number;
}
export interface TakeoverBid { rivalId: string; premium: number; mode: 'merge' | 'brand'; costUSD: number; decideAt: number }
export interface Holdings {
  stakes: Record<string, number>;
  owned: Record<string, 'merge' | 'brand'>;
  bid: TakeoverBid | null;
  alliance: { name: string; members: string[] } | null;
  inviteCooldown: Record<string, number>;
}
export interface AssetsState { lounges: { icao: string; level: number }[]; hotels: { icao: string; size: number; builtAt: number }[]; airports: Record<string, number> }
export type CharterKind = 'sports' | 'tour' | 'government' | 'vip' | 'acmi';
export interface CharterOffer {
  id: string; kind: CharterKind; client: string; from: string; to: string; pax: number;
  departAt: number; stayDays: number; months: number; payUSD: number; expiresAt: number; needsVip: boolean; km: number;
}
export interface CharterJob extends CharterOffer { aircraftId: string; endsAt: number; selfFly: boolean; flown: boolean }
export interface Strike { dept: Dept; stage: 'warning' | 'ballot' | 'strike'; until: number }

// ------------------------------------------------------------------ M7 personal empire
export type HqDept = 'ops' | 'revenue' | 'network' | 'training' | 'maintenance' | 'pr' | 'cargo' | 'charter' | 'ir' | 'legal';
export interface EmpireState {
  salaryUSDPerYear: number;
  cars: { id: string; model: string; color: string; valueUSD: number; boughtAt: number }[];
  aircraft: { id: string; typeId: string; reg: string; valueUSD: number; boughtAt: number }[];
  yachts: { id: string; model: string; name: string; valueUSD: number }[];
  properties: { id: string; valueUSD: number; boughtAt: number }[];
  homeTier: number;
  activeCar: string | null;
  hq: { tier: number; depts: Record<HqDept, number> };
  achievements: Record<string, number>;
  rich: number[];
  location: string;
  trips: number;
}
export interface Opportunity { icao: string; km: number; weeklyProfit: number; loadFactor: number; marketWeekly: number }
export interface EmpireView {
  state: EmpireState;
  assetsValueUSD: number;
  netWorthUSD: number;
  upkeepMonthUSD: number;
  hqMonthUSD: number;
  richRank: number;
  richList: { name: string; field: string; worthUSD: number; you?: boolean }[];
}

export interface CorpView {
  revenueYearUSD: number;
  ebitdaYearUSD: number;
  netYearUSD: number;
  debtUSD: number;
  rating: string;
  rate: number;
  capacityUSD: number;
  creditLimitUSD: number;
  finance: FinanceState;
  equity: EquityState;
  equityValueUSD: number;
  ipoEligible: boolean;
  ipoReason: string;
  holdings: Holdings;
  rivals: Record<string, { valueUSD: number; profitYearUSD: number; revenueYearUSD: number; overlap: number }>;
  assets: AssetsState;
  assetStats: { lounges: Record<string, { incomeMonth: number; costMonth: number }>; hotels: Record<string, { occupancy: number; profitMonth: number }>; airportValues: Record<string, number> };
  charters: { offers: CharterOffer[]; active: CharterJob[] };
  strikes: Strike[];
  personal: { cashUSD: number; stake: number; stakeValueUSD: number; netWorthUSD: number };
  cargoWeek: { tonnes: number; revenue: number };
}

export interface ActiveEvent {
  id: string;
  until: number;
  scope: string;
  country?: string;
  delayProb: number;
  cancelShare: number;
  demandMult: number;
  text: string;
}

export interface Competitor {
  id: string;
  name: string;
  color: string;
  freq: number;
  fare: number;
  share: number;
}

export interface GameState {
  version: number;
  airline: { name: string; code: string; primary: string; accent: string; currency: Currency; livery?: Livery };
  difficulty: Difficulty;
  base: string;
  time: number; // sim epoch ms
  startTime: number;
  speed: number;
  cashUSD: number;
  fleet: FleetAircraft[];
  routes: Route[];
  slots: Record<string, number>;
  used: UsedListing[];
  usedRefreshAt: number;
  ledger: Record<string, Partial<Record<LedgerCategory, number>>>;
  depreciation: Record<string, number>;
  history: { t: number; cash: number }[];
  seed: number;
  nextId: number;
  regSeq: number;
  lastMonth: string;
  negativeSince: number | null;
  bankrupt: boolean;
  log: { t: number; text: string; level: 'info' | 'good' | 'warn' | 'bad' | 'achievement' }[];
  // M4
  rivals: Rival[];
  fuelPrice: number;
  fuelHistory: { t: number; p: number }[];
  events: ActiveEvent[];
  staff: Record<Dept, StaffDept>;
  reputation: number;
  drivers: { punctuality: number; service: number; comfort: number; value: number; safety: number };
  monthOps: { flights: number; delayed: number; cancelled: number; landingsHard: number };
  reviews: { t: number; stars: number; text: string }[];
  lastDay: string;
  playerFlights: { count: number; best: number };
  // M5
  customTypes: AircraftType[];
  player: { character: CharacterLook };
  // M6
  finance: FinanceState;
  equity: EquityState;
  holdings: Holdings;
  assets: AssetsState;
  charters: { offers: CharterOffer[]; active: CharterJob[] };
  strikes: Strike[];
  personal: { cashUSD: number };
  // M7
  empire: EmpireState;
}

/** Lightweight view sent to the UI a few times a second. */
export interface Snapshot {
  time: number;
  speed: number;
  cashUSD: number;
  airline: GameState['airline'];
  difficulty: Difficulty;
  base: string;
  fleet: FleetAircraft[];
  routes: Route[];
  slots: Record<string, number>;
  slotsUsed: Record<string, number>;
  used: UsedListing[];
  ledgerMonths: { month: string; items: Partial<Record<LedgerCategory, number>>; depreciation: number }[];
  history: { t: number; cash: number }[];
  log: GameState['log'];
  bankrupt: boolean;
  weekly: { revenue: number; cost: number; pax: number; flights: number; loadFactor: number };
  rivals: { id: string; name: string; colors: [string, string]; model: string; routes: number; weeklyPax: number; quality: number }[];
  rank: number;
  fuelPrice: number;
  fuelHistory: { t: number; p: number }[];
  events: ActiveEvent[];
  staff: Record<Dept, StaffDept>;
  reputation: number;
  drivers: GameState['drivers'];
  reviews: GameState['reviews'];
  onTime: number;
  playerFlights: GameState['playerFlights'];
  customTypes: AircraftType[];
  player: GameState['player'];
  corp: CorpView;
  empire: EmpireView;
}

export type Command =
  | { kind: 'buyNew'; typeId: string; count: number }
  | { kind: 'lease'; typeId: string; count: number }
  | { kind: 'buyUsed'; listingId: string }
  | { kind: 'sell'; aircraftId: string }
  | { kind: 'returnLease'; aircraftId: string }
  | { kind: 'createRoute'; a: string; b: string; aircraftIds: string[]; weeklyFreq: number; fareY: number; fareJ: number; fareW?: number }
  | { kind: 'editRoute'; routeId: string; aircraftIds?: string[]; weeklyFreq?: number; fareY?: number; fareJ?: number; fareW?: number }
  | { kind: 'deleteRoute'; routeId: string }
  | { kind: 'buySlots'; icao: string; count: number }
  | { kind: 'setCurrency'; currency: Currency }
  | { kind: 'setStaff'; dept: Dept; pay?: number; staffing?: number }
  | { kind: 'playerFlight'; from: string; to: string; typeId: string; touchdownFpm: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'setLivery'; livery: Livery }
  | { kind: 'setBrand'; name: string; code: string; primary: string; accent: string }
  | { kind: 'setCabin'; aircraftIds: string[]; cabin: CabinLayout }
  | { kind: 'designType'; type: AircraftType; devCostUSD: number }
  | { kind: 'setCharacter'; look: CharacterLook }
  // M6 corporate
  | { kind: 'takeLoan'; amountUSD: number; termMonths: number }
  | { kind: 'repayLoan'; loanId: string; amountUSD: number }
  | { kind: 'drawCredit'; amountUSD: number }
  | { kind: 'repayCredit'; amountUSD: number }
  | { kind: 'setAutoDraw'; on: boolean }
  | { kind: 'saleLeaseback'; aircraftId: string }
  | { kind: 'ipo'; float: number }
  | { kind: 'setPayout'; payout: number }
  | { kind: 'buyback'; share: number }
  | { kind: 'secondary'; share: number }
  | { kind: 'sellPersonalShares'; share: number }
  | { kind: 'buyPersonalShares'; share: number }
  | { kind: 'buyStake'; rivalId: string; pct: number }
  | { kind: 'sellStake'; rivalId: string; pct: number }
  | { kind: 'bid'; rivalId: string; premium: number; mode: 'merge' | 'brand' }
  | { kind: 'foundAlliance'; name: string }
  | { kind: 'inviteAlliance'; rivalId: string }
  | { kind: 'leaveAlliance' }
  | { kind: 'buildLounge'; icao: string }
  | { kind: 'buildHotel'; icao: string; size: number }
  | { kind: 'sellHotel'; icao: string }
  | { kind: 'buyAirportStake'; icao: string; pct: number }
  | { kind: 'sellAirportStake'; icao: string; pct: number }
  | { kind: 'acceptCharter'; offerId: string; aircraftId: string; selfFly: boolean }
  | { kind: 'declineCharter'; offerId: string }
  | { kind: 'settleStrike'; dept: Dept }
  // M7 personal empire & HQ
  | { kind: 'setSalary'; usdPerYear: number }
  | { kind: 'buyCar'; model: string; color: string }
  | { kind: 'sellCar'; id: string }
  | { kind: 'paintCar'; id: string; color: string }
  | { kind: 'setActiveCar'; id: string }
  | { kind: 'buyPersonalAircraft'; typeId: string }
  | { kind: 'sellPersonalAircraft'; id: string }
  | { kind: 'buyYacht'; model: string; name: string }
  | { kind: 'sellYacht'; id: string }
  | { kind: 'buyProperty'; id: string }
  | { kind: 'sellProperty'; id: string }
  | { kind: 'upgradeHome' }
  | { kind: 'upgradeHqTier' }
  | { kind: 'upgradeDept'; dept: HqDept }
  | { kind: 'travel'; icao: string; aircraftId: string }
  | { kind: 'opportunities' }
  | { kind: 'arriveHome' }
  | { kind: 'arrivePersonal'; icao: string; aircraftId: string; fromIcao: string }
  | { kind: 'incident'; severity: 'damage' | 'crash'; cause: string; costUSD: number }
  | { kind: 'suggestFares'; a: string; b: string; typeId: string; aircraftCount: number; weeklyFreq: number; aircraftId?: string }
  | { kind: 'quote'; a: string; b: string; typeId: string; aircraftCount: number; weeklyFreq: number; fareY: number; fareJ: number; routeId?: string; aircraftId?: string; fareW?: number };

export interface RouteQuote {
  ok: boolean;
  reason?: string;
  distanceKm: number;
  blockHours: number;
  maxWeeklyFreq: number;
  marketWeekly: number;
  refFareY: number;
  refFareJ: number;
  expectedLoadFactor: number;
  weeklyRevenue: number;
  weeklyCost: number;
  weeklyProfit: number;
  slotsNeeded: Record<string, number>;
  competitors: Competitor[];
  playerShare: number;
  seats?: { j: number; w: number; y: number };
  refFareW?: number;
  paxW?: number;
  cargo?: { tonnesWeek: number; ratePerKg: number; refRatePerKg: number; fill: number };
}

export type ToWorker =
  | { type: 'new'; params: NewGameParams }
  | { type: 'load'; state: GameState }
  | { type: 'speed'; value: number }
  | { type: 'cmd'; id: number; cmd: Command }
  | { type: 'getState'; id: number };

export type FromWorker =
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'result'; id: number; ok: boolean; msg: string; data?: unknown }
  | { type: 'state'; id: number; state: GameState }
  | { type: 'event'; text: string; level: 'info' | 'good' | 'warn' | 'bad' | 'achievement' };
