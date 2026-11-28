# GAME DESIGN — Sky Empire

> A deep airline tycoon crossed with a flight game and a billionaire life sim.
> Start one airline in London. Grow it into the world's #1 airline while building a personal empire of supercars, jets, yachts and mansions. Walk around everything, and fly any plane you own.

- **Platform:** desktop browser (Chrome/Edge), single player, offline-capable except for map tiles and exchange rates
- **Target hardware:** Lenovo ThinkPad X1, Intel Iris Xe (integrated), 30–60 fps on **Medium**
- **Stack:** three.js + Vite + TypeScript, Rapier physics, a custom flight model, Blender (bpy) generated assets, HTML/CSS UI overlay, IndexedDB saves
- **Status:** M1–M9 complete (2026-11-25). Next: M10+ from IDEAS.md (business-jet cockpit, Heathrow traffic, night bakes).

## 0. Decisions log
| Round | # | Decision |
|---|---|---|
| 1 | 1 | Career start uses a **difficulty picker**: Easy = £100M + 3 A320neo + some LHR slots; Normal = £25M + 2 leased A320neo at LGW; Hard = £5M + 1 leased ATR 72-600 at LGW. |
| 1 | 2 | **Start at Gatwick.** Heathrow slots must be bought, won at auction or gained through a merger (on Easy you get a few from the start). |
| 1 | 3 | The first Blender airliner is the **Airbus A320neo**, built so the A319neo/A321neo reuse its parts. |
| 1 | 4 | **About 25 core types** at launch across every category, with more added each milestone. |
| 1 | 5 | Terrain: **AWS Terrarium elevation + MapTiler satellite** (free key), falling back to **EOX Sentinel-2 cloudless** with no key. |
| 1 | 6 | Renderer: **WebGL2**. |
| 1 | 7 | Demand: a **gravity model** with segments, seasonality, elasticity and market share. Connecting O&D flows are added in M6. |
| 1 | 8 | UI: a **dark "airline operations centre" style**, with glass panels, the brand colour as accent and a 3D globe route map. |
| 2 | 1 | The project lives in a folder called **`sky-empire`**. |
| 2 | 2 | Default flying controller layout is **flight-sim style**: left stick for pitch and roll, bumpers for rudder, triggers for throttle, right stick to look around. |
| 2 | 3 | HQ upgrades **combine all three**: departments with real gameplay effects, each a physical room in the HQ, plus cosmetic décor and building-size tiers, all also manageable from a menu (§8.11). |
| 2 | 4 | Buying a rival: **share stake, then a takeover bid, a board vote and a regulator review, then integration**. Hostile takeovers come in M6+. |
| 2 | 5 | Detailed airports: **Gatwick in M3**, then Cape Town, Johannesburg, Dubai and JFK from M8. |
| 2 | 6 | Cars, yachts and homes are **original designs with made-up brand names**, easy to rename. |
| 2 | 7 | Audio: **procedural WebAudio** for engines and wind, **CC0 sound files**, and **browser speech** for cabin announcements. |
| 2 | 8 | Characters: **stylised-realistic**. |
| 3 | 1 | Title: **Sky Empire**. |
| 3 | 2 | **About 40 AI rivals worldwide** from day one, with Europe in the most detail first. |
| 3 | 3 | Rival networks start **roughly as their real networks** (hand-made hub and route data), then grow on their own. |
| 3 | 4 | **About 60 achievements** (business, flying, lifestyle), with pop-ups and a trophy cabinet in the CEO office. |
| 3 | 5 | The game starts on **today's date (November 2026)** with current aircraft types. |
| 3 | 6 | **M1 as planned:** Heathrow block, A320neo, walking, graphics presets and FPS counter (no main menu yet). |
| M1 | 1 | The M1 look (lighting, materials, terminal) is approved. |
| M1 | 2 | Boarding is through a **jet bridge** at stand 503 into door L1. |
| M1 | 3 | The first flight **starts at the gate**: pushback, then taxi out. |
| M1 | 4 | Cockpit: a simplified **Airbus-style glass cockpit** (PFD, ND, engine display, FCU, clickable gear/flaps/thrust). |
| M1 | 5 | Imagery: **EOX Sentinel-2 cloudless (no key)** by default. A MapTiler key in `.env.local` switches to MapTiler automatically. |
| M2 | 1 | Both flight models stay as they are until you have flown them. |
| M2 | 2 | Main business screen: a **3D globe**. |
| M2 | 3 | The airline keeps running and earning while you fly. |
| M2 | 4 | Flights you fly yourself earn that flight's revenue, plus a smooth-landing bonus. |
| M2 | 5 | "Skip to destination" stops about **30 nm out** so you fly the landing. |
| M3 | 1 | About **40+ rivals worldwide** from day one (46 built). |
| M3 | 2 | Rivals **fight back** with fare cuts and extra flights, and launch routes against you. |
| M3 | 3 | Events at **realistic frequency**. |
| M3 | 4 | Staff: **headcount, pay and morale** per department in M4; strikes in M6. |
| M3 | 5 | Destination airports **generated from real runway data**. |
| M4 | 1 | Livery editor: **layers on a live 3D aircraft** you can spin around. |
| M4 | 2 | Cabin editor: **quick row mode first**, with real effects on seats, comfort and revenue; VIP free mode as well. |
| M4 | 3 | Custom aircraft: **choose from part families** (fuselage stretch, wing, engines, fuel) with performance trade-offs. |
| M4 | 4 | Character creator: **body sliders, skin, hair, outfits** (pilot and CEO uniforms in airline colours). |
| M4 | 5 | Logo upload: **PNG or SVG**, placed on the tail and fuselage. |
| M5 | 1 | Loans: **term loans and a credit line priced by a credit rating**, plus **sale & leaseback**. Bonds later. |
| M5 | 2 | IPO and shares: **float once big enough**; the price follows profit and reputation; a **board** sets targets and can push back when you lose your majority. |
| M5 | 3 | Buying rivals: **stakes and takeover bids**; choose **merge** (network and slots join yours) or **keep the brand** (subsidiary). Regulators can demand remedies or block. |
| M5 | 4 | Lounges, hotels, airports: **income and boosts** (business demand, comfort, fee discounts, slots). |
| M5 | 5 | Cargo: **belly cargo automatically plus freighter routes**; charters as one-off jobs you can also fly yourself, plus ACMI wet leases. HQ upgrades move to M7. |
| M6 | 1 | Cars: **one drivable car** you pick from your garage (arcade handling); jets and helicopters are **owned and used for trips** (no cockpit flying yet); yachts are status assets for now. |
| M6 | 2 | Mansion: **one walkable home next to your base** that you upgrade in 4 tiers, plus **8 properties** around the world as investments. |
| M6 | 3 | Rich list: **fictional people** (no real billionaires). |
| M6 | 4 | HQ: **one building at Gatwick** whose rooms unlock as departments level up; rented floor → own building → landmark tower. |
| M6 | 5 | Achievements: **pop-ups, a list, and a trophy cabinet** in the CEO office. |
| M7 | 1 | Weather: **changing conditions plus storms with turbulence** (no icing yet); it affects flying and the airline's delays. |
| M7 | 2 | Night: **full day-night cycle on the game clock** with runway, apron, building and aircraft lights. |
| M7 | 3 | Damage: **realistic, with an off switch**: damage, repair bills and crashes. |
| M7 | 4 | Living airport: **AI aircraft and people walking** around the terminal. |
| M7 | 5 | More airports: **improve the generated airports everywhere** (taxiways, stands, parked aircraft, tower, lights) rather than hand-building a few. |
| M8 | 1 | First polish: **ATC radio and approach aids** (ILS, PAPI, approach lights). The business-jet cockpit and Heathrow traffic come later. |
| M8 | 2 | Performance: **auto resolution** instead of a new preset. |
| M8 | 3 | Night lightmap bakes: **not yet** (build time and download size); dimmed day bakes stay. |
| M8 | 4 | Economy: **tuned with a scripted two-year player**. Best-route play on Normal ends year two at ~12–20% margins; Hard is tight but viable. |
| M8 | 5 | UX: a **first-steps checklist**; fixed the hidden weather and radio boxes. |

---

## 1. Design pillars

1. **The business is real.** Every number comes from a data file and a believable model: demand, fuel, slots, staff, loans, shares. Decisions have consequences you can trace.
2. **You can be there.** Any plane, terminal, hangar, office or home you own can be walked into, and any aircraft you own can be flown.
3. **Two ladders to climb.** The airline ladder (become #1) and the personal ladder (become a billionaire). They feed each other: share price builds net worth, and a lavish lifestyle costs cash the airline might need.
4. **It runs on a laptop.** Visual ambition is always weighed against an integrated-GPU budget. If something is too heavy, we say so and ship the closest thing that runs well.
5. **Everything is tunable.** Prices, speeds, demand values and event rates live in `/data` files, and as much as possible can be edited in-game.

---

## 2. Modes, goals and time

### 2.1 Modes
| Mode | Description |
|---|---|
| **Career** | Start small at **London Gatwick**, with the start package set by difficulty (see the table below), and goals and milestones that unlock features, aircraft types and lifestyle items. Winning Heathrow slots is the first big milestone. |
| **Sandbox** | Unlimited money, everything unlocked, events optional. Good for building, flying and customising. |

Career difficulty (picked at new game, values in `/data/difficulty.json`):

| | Easy | Normal | Hard |
|---|---|---|---|
| Starting cash | £100M | £25M | £5M |
| Starting fleet | 3 × A320neo (owned) | 2 × A320neo (leased) | 1 × A320neo (leased) (M9: was an ATR, which could not pay its way out of Gatwick) |
| Base | LGW + a few LHR slots | LGW | LGW |
| Loan interest | Low | Market | High |
| Rival aggression / events | Low | Normal | High |
| Bankruptcy | Bail-out offer | Game over (can reload) | Game over |

### 2.2 Goals (endless game)
- **Airline goal: become the #1 airline in the world.** Ranked on a weighted league table: passengers per year, revenue, fleet size, destinations, market cap, and reputation. The weights live in `/data/rankings.json`.
- **Personal goal: become a billionaire.** Net-worth milestones (e.g. £1M, £10M, £100M, £500M, £1B, £10B) unlock lifestyle items and titles.
- **Achievements** throughout, for example the first route, first widebody, first profitable year, first IPO, buying a rival, landing in a 30-knot crosswind, a full lap of the world, or owning a superyacht.

### 2.3 Time
- Speeds: **Pause, 1x, 10x, 100x, 1000x** (the top speed is set in data).
- When the player is **flying or walking**, the game drops to **1x real time** automatically. The business sim keeps running in the background at 1x.
- **"Skip to destination"** on long flights fast-forwards the sim and teleports the aircraft to the approach phase (about 30 nm out) or onto the stand, as the player chooses.
- The simulation clock uses UTC with local-time display per airport. Day and night follow the real sun position.

---

## 3. World

### 3.1 Business map
- **Every real airport** from the OurAirports open data (`airports.csv`, `runways.csv`, `countries.csv`, `regions.csv`), with ICAO/IATA codes, position, elevation, runways (length, surface, heading) and type.
- About 80,000 OurAirports entries include heliports, closed fields and seaplane bases. For gameplay:
  - **Airline-capable** airports are `large_airport` and `medium_airport` with a paved runway of 1,200 m or more (about 4,500 airports). These can hold routes.
  - **GA-capable** airports are `small_airport` entries plus heliports, for the personal jet and helicopter.
  - Closed airports are excluded.
- The data is preprocessed at build time into a compact binary/JSON pack in `/data/airports/`, so the game never parses an 11 MB CSV at runtime.
- Map views: a 3D globe (three.js) and a flat route map, switchable.

### 3.2 Flyable terrain
- **Elevation:** streamed terrain tiles (quadtree LOD), with high detail within about 20 km of airports and coarse detail between them.
- **Imagery:** MapTiler satellite tiles (free key), with EOX Sentinel-2 as the no-key fallback, draped on the terrain, streamed and cached in IndexedDB. See §12.2.
- **Sea level and ocean:** a water shader with wave normals and a horizon fog blend.
- **Airports without a detailed model** get a procedural version from runway data: runways with correct heading, length and markings, a generic apron, generic terminal blocks and approach lights.
- **Cities:** at night, light-point instancing driven by a population/night-lights layer. Optional OSM building extrusions near detailed airports only, because it is too heavy everywhere.

### 3.3 Detailed (walkable) airports
- **Launch: London Heathrow (EGLL/LHR).** M1 has one runway, the apron and a terminal block. It grows to both runways, terminals, gates, jet bridges, lounges, shops, hangars and ground vehicles.
- **Next:** **Gatwick in M3** (your starting base), then **Cape Town, Johannesburg O.R. Tambo, Dubai and New York JFK** from M8, and more later.
- Detailed airports are built from Blender-generated modular kits (terminal bays, piers, jet bridges, hangars, stands and signage) placed from data files, so each new airport is mostly a layout file plus a few unique landmark pieces.

### 3.4 Living world (M8)
- Passengers check in, queue at security, sit at gates and board. Crew walk to aircraft. Ground staff work the stands.
- Ground vehicles: pushback tugs, baggage tugs and carts, fuel bowsers, catering trucks, buses, airside cars and fire trucks.
- AI aircraft taxi, take off and land, using scheduled flights from the sim: your airline's and the rivals'.
- Crowds are instanced, animated low-poly characters with LOD and an impostor fallback at range.

---

## 4. Flying

### 4.1 Flight model (`/src/flight`)
A single custom model with two profiles, selectable per flight:

| | **Arcade** | **Realistic** |
|---|---|---|
| Handling | Auto-coordinated turns, forgiving | Full force-based handling |
| Stalls | Soft and recoverable, with a warning | Real stall at critical angle of attack, wing drop |
| Weight | Fixed | Fuel, passengers and cargo change weight and CG |
| Wind | Light effect | Full wind, gusts, crosswind on the runway |
| Ground | Assisted take-off and landing | Tyre friction, brakes, nosewheel steering, reverse thrust |
| Crashes | Off by default | Damage model (see §4.4) |

- Realistic forces: lift and drag from CL/CD curves against angle of attack per aircraft, flap and gear drag increments, thrust per engine with spool lag, weight, ground effect, and control surface moments. Integrated at a fixed 120 Hz.
- Per-type values live in `/data/aircraft/<type>.json` (wing area, MTOW, OEW, thrust, Vs0/Vs1, Vr, Vref, service ceiling, CL/CD tables and fuel burn).

### 4.2 Cockpit and HUD
- 3D cockpit with working main instruments: **airspeed, altitude, attitude (ADI), heading (HSI), VSI**, plus N1/EGT, flaps, gear and trim indicators.
- Clickable controls: **gear lever, flap lever, throttle quadrant, autopilot panel** (heading, altitude, speed, vertical speed, approach), parking brake and lights.
- Glass-cockpit screens are rendered to canvas textures and refreshed at about 20–30 Hz to save GPU time.
- A **simple HUD** option overlays the core instruments for external views.
- Views: cockpit, cabin window, external chase, orbit, tower and flyby.

### 4.3 Weather and night (M8)
- Wind layers, gusts, rain, thunderstorms, low cloud and fog, and crosswind landings.
- Optional live METAR weather, or simulated weather from climate tables.
- Night: sun/moon lighting, runway and approach lights, aircraft nav/strobe/beacon/landing lights, and city lights.

### 4.4 Damage and crashes (setting: on/off)
- Off: the aircraft bounces off hard landings and resets on terrain contact.
- On: hard landings, tail strikes, overspeed and over-G damage systems (gear, flaps, engines). A crash ends the flight, writes the aircraft off (insurance claim), damages reputation and fires a news event. There are **no graphic depictions of casualties**: the screen fades to an incident report.

### 4.5 Controls
- Keyboard and mouse, plus **Xbox and PlayStation controllers** via the Gamepad API.
- Everything is **fully rebindable**, with per-context maps (walking, driving, flying and menus) stored in settings and exportable.
- Mouse yoke option and mouse-look in the cockpit.
- **Default controller layout (flying, flight-sim style):**

| Input | Action |
|---|---|
| Left stick | Pitch and roll |
| LB / RB (L1 / R1) | Rudder left / right |
| RT / LT (R2 / L2) | Throttle up / down (reverse thrust when held at idle on the ground) |
| Right stick | Look around (click to recentre) |
| A / Cross | Toggle autopilot panel focus |
| B / Circle | Brakes (hold), parking brake (double tap) |
| X / Square | Gear |
| Y / Triangle | Cycle camera |
| D-pad up / down | Flaps up / down |
| D-pad left / right | Trim |
| Start / Options | Pause menu |
| View / Share | Toggle HUD |

---

## 5. Walking and exploring (`/src/player`)
- Switchable **first person / third person** at any time.
- A Rapier kinematic character controller: walk, run, crouch, stairs, ramps and jet bridges.
- **Enterable spaces:**
  - every plane's cabin and cockpit
  - airport terminals: check-in, security, gates, lounges and shops
  - hangars and the apron, with **drivable ground vehicles**
  - the airline HQ and a customisable CEO office
  - personal homes and mansions
- An interaction system with an "E to use" prompt for doors, seats, the cockpit seat, vehicles, laptops (they open the business UI), and so on.
- Seamless transitions where cheap, and short fades where a scene swap is needed (for example from the HQ to the airport).

### 5.1 Character creator (M5)
- A modular, rigged base character from Blender with morph targets for face and body shape, plus skin tone, hair styles and colours.
- Clothing slots: casual, business suit, **pilot uniform** (with rank stripes), **CEO outfit**, and the airline uniform designs from the brand editor.
- **Decided style: stylised-realistic.** Realistic proportions and clothing with slightly simplified faces, not photoreal digital humans. That is the closest look that runs on Iris Xe with crowds on screen.

---

## 6. Aircraft and fleet

### 6.1 Categories (real type names)
| Category | Examples |
|---|---|
| Turboprops | ATR 72-600, De Havilland Dash 8-400 |
| Regional jets | Embraer E175, E195-E2, Airbus A220-300 |
| Narrowbodies | A319neo, A320neo, A321neo/XLR, Boeing 737-800, 737 MAX 8/10 |
| Widebodies | A330-900, A350-900/1000, Boeing 787-8/9/10, 777-300ER, 777-9 |
| Jumbos | Boeing 747-8I, Airbus A380-800 |
| Freighters | ATR 72F, 737-800BCF, 767-300F, 777F, 747-8F, A350F |
| Private and business jets | Cessna Citation CJ4, Embraer Phenom 300, Bombardier Global 7500, Gulfstream G700, Dassault Falcon 10X |
| VIP airliners | ACJ320neo, BBJ 737 MAX, ACJ350, BBJ 787, BBJ 747-8 |
| Helicopters | Airbus H125, H145, H160, Leonardo AW139, AW169 |

**Launch catalogue (M3): about 25 core types.** Proposed first set: ATR 72-600, Dash 8-400, E175, E195-E2, A220-300, A319neo, A320neo, A321neo, A321XLR, 737-800, 737 MAX 8, A330-900, A350-900, 787-9, 777-300ER, A380-800, 747-8I, 737-800BCF, 777F, Citation CJ4, Phenom 300, Global 7500, ACJ320neo, H145 and AW139. More types are added each milestone.

The **A320neo** is the first fully modelled type (M1). Its fuselage, wing, cockpit and cabin parts are reused for the A319neo and A321neo.

### 6.2 Getting aircraft
- **New from the factory:** order, pay deposits (for example 1% at order, 30% before delivery and the balance on delivery), wait for a **delivery slot** from a per-manufacturer backlog, and choose options (engines, cabin and livery).
- **Lease:** dry lease with a monthly rate, term, return conditions and early-exit penalty.
- **Used market:** procedurally generated listings with age, hours, cycles and condition. Older aircraft are cheaper but need more maintenance and burn more fuel.
- **Custom aircraft builder (M5):** modular fuselage (stretch segments), wing (span, sweep, area), engine count and type, tail, gear, and fuel tanks. The builder calculates weight, range, cruise speed, runway need, fuel burn and price. Built models are assembled from Blender part kits at runtime.

### 6.3 Fleet management
- Each airframe tracks registration (G-xxxx by default), age, hours/cycles, condition, maintenance checks (A, C, D), cabin layout, livery and assigned routes.
- Maintenance: checks take the aircraft out of service. Skipping them raises the delay and incident risk.

### 6.4 Charter and VIP jets
- Free-placement interiors: lounges, bedrooms, showers, bars and meeting rooms (see §7.2).
- They earn money from charter and VIP jobs (§8.8) and raise demand from premium clients.

---

## 7. Customisation (M5)

### 7.1 Livery editor
- A layer stack (like a racing game's livery editor): base colour zones (fuselage top and bottom, belly, tail, engines and winglets), stripes and curves, decals, text (any font from a bundled set), **logo image upload**, and tail art.
- Projection: decals are projected onto the aircraft UV atlas. Each type has a consistent UV template generated by the Blender scripts, so one livery can adapt across the whole fleet.
- Output: a baked texture per type, cached in IndexedDB, with 2K and 4K options depending on the graphics preset.

### 7.2 Cabin editor
- **Quick row mode (airliners):** drag class zones (First, Business, Premium Economy, Economy), set seat pitch and width, seats per row and layout (3-3, 2-4-2 and so on), and place galleys, toilets, exits and bassinets. It validates exit limits and gives a live seat count and comfort score.
- **Free placement mode (VIP/charter):** a catalogue of furniture (seats, divans, beds, bars, showers, tables, screens and lounges) placed with grid and wall snapping, plus weight and power budgets.
- Cabins render as **instanced meshes**, so 400 seats cost about as much as one draw call.

### 7.3 Airline brand
- Name (typed at new game), IATA-style two-letter code and ICAO-style call sign, colours, logo, uniforms, slogan and HQ city.
- The brand flows into the livery defaults, uniforms, terminal signage, boarding passes and the UI accent colour.

### 7.4 Data-driven editing
- In-game editors for as much as possible. Everything else is a readable JSON file in `/data`, with hot-reload in development.

---

## 8. Tycoon / business (`/src/economy`, `/src/ai`)

### 8.1 Routes and network
- Create routes between airline-capable airports: aircraft, frequency per week, schedule (departure times), cabin configuration and prices per class.
- **Hubs:** declare bases to unlock connecting traffic, crew bases and maintenance bases.
- **Slots:** slot-coordinated airports (LHR, LGW, JFK, DXB and others, flagged in data) need slots per time band. Get them from the slot pool, from auctions, by buying them from rivals, or by inheriting them through mergers.
- Performance checks: range, runway length, ETOPS for long overwater routes, and noise and curfew rules.

### 8.2 Demand model
Decided: a **gravity model** for M3–M4, with connecting traffic added in M6.
- Base demand between two cities ∝ (population and GDP per capita of each catchment) ÷ distance^k, plus tourism and business attractiveness weights and diaspora/historic links from data.
- It splits into **business / leisure / VFR (visiting friends and relatives)** with different price sensitivity, plus seasonality and day-of-week curves.
- **Market share** between carriers on a route depends on price per class, frequency, departure times, aircraft comfort, reputation, alliance and lounge access, and on-time performance.
- Price elasticity per segment, so raising fares lowers load factor along a believable curve.
- **M6: connecting traffic** through hubs (O&D flows), the way real network airlines work.

### 8.3 Costs and operations
- **Fuel:** a global jet fuel price driven by a random-walk/mean-reverting model with shocks. Options to **hedge**.
- **Maintenance**, **airport and navigation fees**, **landing and parking fees**, catering, insurance, leasing and depreciation.
- **Delays:** a probability from weather, aircraft condition, staff shortages and airport congestion. They knock on through a day's rotation and trigger compensation (UK261/EU261-style rules).

### 8.4 Finance
- Cash, revenue and cost breakdowns, P&L, balance sheet and cash flow, by route, aircraft and month.
- **Loans:** a credit rating sets the interest rate, with term loans, a revolving credit line and covenants.
- **IPO:** available after a revenue or profit threshold. Choose the float percentage and raise cash.
- **Shares and stock price:** the price moves with earnings, growth, news, sentiment and noise. Shareholders and a board make demands (dividends, growth targets) and can push back.
- Share buybacks, dividends, secondary offerings, and personal share sales that feed personal cash.

### 8.5 Rivals, M&A and alliances
- AI rivals use **real airline names** (private build), with **generic liveries in their brand-ish colours** and **no real logos or official liveries**. Names and colours come from `/data/airlines.json`, so they are easy to rename.
- Rival AI personality: home hubs, business model (legacy / low-cost / ULCC / Gulf super-connector / regional / cargo), aggression, financial health and growth plan.
- **Buying a rival:**
  1. **Stake:** buy their shares on the market. Crossing 5%, 10% and 25% is announced and moves their share price up.
  2. **Takeover bid:** offer a price per share at a premium, in cash, shares or a mix.
  3. **Board vote:** the board accepts or rejects based on the premium, their finances, your reputation and market sentiment. You can raise the offer.
  4. **Regulator review:** competition regulators may approve, block, or demand remedies (giving up slots or routes where you'd dominate).
  5. **Integration:** merge fleets, slots and routes, keep or retire the brand, and absorb staff (temporary morale hit and a strike risk).
  - **M6+:** hostile takeovers and shareholder battles.
- **Alliances:** found or join one; it brings codeshares, lounge sharing and a demand boost on connecting routes.

### 8.6 Assets
- **Airports:** buy stakes in airports or whole airports. Earn fees from all airlines, set charges, and invest in terminals and runways.
- **Lounges:** build or rent lounges at airports, which raises premium share and gives an ancillary income line.
- **Hotels:** airport and city hotels, which earn from stopover and crew demand.

### 8.7 Staff (by department)
- **Pilots, cabin crew, engineers, ground staff, HQ.**
- Headcount needs come from the fleet and schedule (crew per aircraft per rotation). Pay vs market rate, training (type ratings take time and money), morale, and unions.
- Low morale or low pay can lead to **strikes**: warning, ballot, strike days, negotiations.

### 8.8 Cargo and charter
- **Cargo:** belly cargo on passenger flights plus dedicated freighter routes. Freight demand by region and commodity flows.
- **Charter:** contracts (sports teams, tour operators, government), VIP jobs (one-off high-value flights with special cabin needs), and ACMI wet-lease deals to rivals.

### 8.9 Events, reputation and PR
- Weather disruption, fuel price swings, strikes (yours and air traffic control's), demand shocks (economy, pandemics at a low rate, big sporting events), volcanic ash, IT outages, awards and PR crises.
- Event frequencies are tuned to feel like real life (most months are quiet). Rates live in `/data/events.json`.
- **Reputation:** an overall score plus per-segment scores from punctuality, comfort, service, safety and price. **Passenger reviews** are generated from real flight outcomes.

### 8.11 HQ upgrades
Every upgrade works three ways at once: it has a **gameplay effect**, it adds a **physical room** you can walk into at the HQ, and it can also be managed from the **HQ menu**.

| Department | Effect | Room |
|---|---|---|
| Operations Control Centre | More routes and aircraft manageable; faster delay recovery | Ops room with a live wall map of your flights |
| Revenue Management | Price suggestions, then auto-pricing per route | Analyst floor with fare dashboards |
| Network Planning | Demand forecasts and route-opportunity reports | Planning room with a route-map table |
| Training Centre | Faster, cheaper type ratings; better crew morale | Classrooms and a full-motion simulator (playable) |
| Maintenance Base | Shorter checks, lower maintenance cost | Engineering office linked to the hangar |
| PR & Communications | Softens PR crises; awards campaigns | Press room |
| Cargo Division | Unlocks freighter ops and cargo contracts | Cargo control desk |
| Charter & VIP Sales | Unlocks charter and VIP jobs | Client lounge |
| Investor Relations | Smaller share-price swings; required for the IPO | Boardroom |
| Legal & Regulatory | Better odds in regulator reviews and slot auctions | Legal office |

Each department has 3–5 levels (`/data/hq.json`). Separately, **cosmetic tiers** grow the HQ itself (rented office floor → own building → landmark tower) and unlock décor for the **CEO office** (desk, art, view, trophy cabinet, model aircraft of your fleet).

### 8.10 Currency
- Display in **ZAR / GBP / USD / EUR**, switchable at any time. The internal accounting currency is USD.
- Live rates come from **frankfurter.app** (free, no key, ECB data), refreshed daily and cached in IndexedDB. A bundled fallback table in `/data/fx_fallback.json` covers offline play.

---

## 9. Personal empire (M7)
- **Cars and supercars**, all drivable (Rapier vehicle controller): a garage, a showroom and a used market. Cars, yachts and homes are **original designs with made-up brand names** in the spirit of real classes (hypercar, GT, SUV, classic, superyacht, sport cruiser). Names live in `/data/brands.json` and are easy to rename.
- **A personal jet and helicopter**, owned personally and separate from the airline fleet, flown from GA airports and helipads.
- **Yachts and boats** in coastal cities (London/Thames, Cape Town, Dubai, Monaco, Miami and so on): drivable, walkable on deck, with a marina berth.
- **Homes and mansions**: walkable and decoratable, with the same free-placement editor as the VIP cabins. Locations include a London townhouse, a Cape Town villa, a Dubai penthouse and a Hamptons estate.
- **Net worth** = market value of the airline shares held + personal assets (with depreciation and appreciation) + personal cash − personal debt.
- **Rich list:** an in-game ranking against a fictional list of billionaires and the rival CEOs.

---

## 10. Audio (M8)
- **Flight:** engine spool-up and spool-down (turboprop, jet and helicopter loops cross-faded by N1), wind noise by airspeed, gear motor and thump, flap motor, touchdown chirp, reverse thrust, and cockpit callouts (altitude callouts and "retard" are generated with speech synthesis or recorded CC0 lines).
- **Cabin PA:** customisable announcements (text you write, read by the browser speech synthesiser or by pre-generated voice lines), seatbelt chimes.
- **Airport:** terminal ambience, boarding calls naming your airline, apron noise.
- **Music:** menu and background tracks (CC0/CC-BY, or generated).
- **Decided approach:** engines and wind are **synthesised procedurally** with the WebAudio API (no download size, adapts to any engine), other effects are **CC0 sound files** (Freesound CC0, Kenney, OpenGameArt), and cabin PA uses the **browser's speech synthesis**.
- Every source is listed in `AUDIO_SOURCES.md` with its licence and link.

---

## 11. Technical architecture

### 11.1 Folders
```
/src/world        scene graph, airport loader, day/night, sky, streaming
/src/terrain      elevation + imagery tile streaming, quadtree LOD, water
/src/flight       flight model, autopilot, instruments, aircraft systems
/src/player       character controller, cameras, interaction, character creator runtime
/src/vehicles     ground vehicles, cars, boats (Rapier vehicles)
/src/economy      business simulation (runs in a Web Worker)
/src/ai           rival airlines, AI traffic scheduling, NPC behaviour
/src/ui           HTML/CSS overlay (menus, fleet, map, finance, stocks): dark ops-centre style, glass panels, brand-colour accent, 3D globe route map
/src/customiser   livery, cabin, aircraft builder, character creator UIs
/blender          bpy scripts that generate every model and export .glb
/public/models    exported, compressed .glb assets
/data             JSON configs: aircraft, airports, airlines, prices, events, rates
```

### 11.2 Simulation and rendering are separate
- The **economy and AI simulation run in a Web Worker** on a fixed tick (for example one sim-minute per tick, batched at high speeds). They run headless, never touch three.js, and talk to the main thread through typed messages.
- The renderer only shows what is near the player. The business keeps running while you fly or walk.
- Deterministic seeded RNG, so saves replay consistently.

### 11.3 Rendering
- three.js on **WebGL2** (decided; WebGPU can be revisited in M9+), physically correct lighting, **ACES or AgX tone mapping**, an HDRI sky blended with a procedural atmospheric sky for time of day.
- **Baked lightmaps** (Blender Cycles) for static interiors and buildings. Light probes or a baked environment for dynamic objects.
- PBR materials. Textures as **KTX2/Basis**, meshes **Draco or meshopt** compressed.
- **LOD** on everything, **instancing** for seats, lights, people and ground clutter, frustum culling and distance culling, and streamed terrain.

### 11.4 Performance budget (Iris Xe, 1080p)
| Preset | Render scale | Shadows | Draw calls | Triangles | Target |
|---|---|---|---|---|---|
| Low | 0.67 | Off (baked only) | < 400 | < 1M | 60 fps |
| Medium | 0.8 | 1 cascade, 1024 | < 700 | < 2M | 45–60 fps |
| High | 1.0 | 2 cascades, 2048 | < 1,200 | < 4M | 30–45 fps |
| Ultra | 1.0 + SSAO/bloom | 3 cascades, 2048 | < 2,000 | < 6M | 30 fps (for stronger machines) |

- An on-screen **FPS counter** with frame time, draw calls, triangle count and memory (toggle with F3).
- A test at every milestone, reported honestly.

### 11.5 Save system
- IndexedDB with **multiple save slots**, autosave, and **export/import as JSON** (compressed).
- Saves are versioned with migrations, so old saves load after updates.

### 11.6 Asset pipeline (Blender 5.3 found on this machine)
- `blender --background --python blender/build_<asset>.py` generates each model procedurally from parameters, bakes lightmaps where useful, and exports `.glb` to `/public/models`.
- A post-process step (`gltf-transform`) applies Draco/meshopt and KTX2.
- An `npm run assets` script rebuilds everything, so models are reproducible and tweakable from code.
- If a Blender MCP connection becomes available, it is used for interactive checks. The script pipeline works without one.

---

## 12. Data sources and licences

### 12.1 Airports
- **OurAirports**: public domain. https://ourairports.com/data/

### 12.2 Terrain and imagery
**Decided:** AWS Terrarium elevation + MapTiler satellite imagery, with automatic fallback to EOX Sentinel-2 when no key is set or the monthly quota runs out.

**Key setup (needed from M2):** sign up free at maptiler.com, go to Account → API keys and copy the default key, then put it in a file called `.env.local` in the project root as `VITE_MAPTILER_KEY=yourkey`. That file is git-ignored, so the key is never committed.

Options that were considered:
| Source | Key? | Notes |
|---|---|---|
| **AWS Terrain Tiles (Terrarium/Mapzen)** elevation | No key | Global, free, good for flying |
| **EOX Sentinel-2 cloudless** imagery | No key | Global, about 10 m per pixel, CC BY 4.0 (2016 layer) |
| **MapTiler** satellite and terrain | Free key (100k tile requests/month) | Sharper imagery near airports. Sign up at maptiler.com, then Account → API keys |
| **Cesium ion** | Free key | World Terrain plus Bing imagery. Heavier client side |
| Google Photorealistic 3D Tiles | Key plus a billing account | The most realistic option, but **too heavy for Iris Xe** at flight speeds. Not recommended |

### 12.3 Other
- Exchange rates: **frankfurter.app** (no key)
- Population and GDP for demand: World Bank and GeoNames open data, pre-processed into `/data/cities.json`
- Weather (optional live): aviationweather.gov METAR API (no key)

---

## 13. Legal and naming (private build)
- Real **aircraft type names** are used.
- Real **airline names** are used for the AI rivals, but **never their logos or official liveries**. Rivals get generic liveries in their brand-ish colours. Everything sits in `/data/airlines.json` with a one-flag "fictional names" mode for renaming.
- Cars, yachts and homes are original designs.
- This build is for personal play only and is not distributed.

---

## 14. Milestones
| # | Scope |
|---|---|
| **M1** | Project setup and Heathrow (one runway, apron, a terminal block). One realistic airliner from Blender. The player character with 1st/3rd person walking. Graphics presets and an FPS counter. |
| **M2** | Board the plane, walk the cabin, sit in the cockpit. The flight model (arcade and realistic), working main instruments. Take off, fly over real terrain around London, land. Gamepad support. |
| **M3** | Business core: new-game setup (name, brand, currency), cash, buy/lease/used planes, routes on a world map, simulated flights earning money, a finances screen, time controls. **Gatwick as the second detailed airport** (your starting base). |
| **M4** | AI rivals with real names, demand, pricing, fuel prices, events, reputation, staff departments. |
| **M5** | Customisers: livery editor, both cabin editor modes, custom aircraft builder, character creator. |
| **M6** | Tycoon depth: loans, IPO/shares, buying rivals, owning airports/lounges/hotels, cargo and charter contracts. |
| **M7** | Personal empire: cars, a personal jet/heli, yachts, mansions, the rich list, net-worth goals and achievements. |
| **M8** | Weather, night, damage/crashes, a living airport (NPCs, AI traffic), full audio, more detailed airports. |
| **M9+** | Polish, performance, and ideas from IDEAS.md. |

At the end of each milestone: it runs locally, there are exact test steps, the FPS on Medium is reported, 3–5 follow-up questions are asked, and a git commit is made.

---

## 15. Known risks and honest notes
1. **Whole-world streamed terrain on an integrated GPU** is the heaviest system. The plan is a quadtree tile LOD with a tight tile budget, imagery at 256 px tiles away from airports, and aggressive fog at low settings. It is achievable at 30+ fps on Medium, but terrain will look like satellite photos on hills, not 3D cities.
2. **Photoreal visuals** come from baked lighting, good materials and tone mapping, not from real-time global illumination. Interiors can look very good. Large outdoor scenes will be "good modern browser game" quality.
3. **Procedurally scripted Blender models** are clean and consistent but less detailed than hand-modelled assets. Iteration in later milestones will raise the detail. Hand-made or CC0 models can be swapped in if wanted.
4. **Crowds** (M8) need instancing and simple animation. Expect dozens of detailed NPCs near the player and hundreds of simple ones further away, not thousands of detailed ones.
5. **The scope is huge.** Each milestone ships something playable, so the game is fun long before it is "finished".
