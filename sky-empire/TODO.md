# TODO

## Phase 0 — Design interview ✅
- [x] GAME_DESIGN.md, follow-up rounds 1–3 (answers in GAME_DESIGN.md §0)

## M1 — Heathrow, airliner, walking, presets
- [x] Vite + TypeScript + three.js r187 + Rapier 0.21 project, git
- [x] Folder structure per GAME_DESIGN §11.1
- [x] Graphics presets Low/Medium/High/Ultra (render scale, MSAA, shadows, LOD bias, bloom) + F3 stats + F4 cycle
- [x] Blender: A320neo, 3 LODs + collision hulls, cylindrical livery UV (parts reusable for A319neo/A321neo)
- [x] Runtime livery painter (windows, doors, cheatline, titles, registration, tail art)
- [x] Blender: airfield (runway 09R/27L with ICAO-style markings, taxiways, apron, stands, landside road)
- [x] Blender: terminal block with Cycles-baked 2048 lightmap (unlit + lightmap at runtime)
- [x] Blender: rigged pilot with Idle/Walk/Run
- [x] Player: Rapier character controller, 1st/3rd person, camera wall collision, animation blending
- [x] Instanced runway/taxiway lights, procedural ground textures with macro variation
- [x] Reversed-Z depth buffer (no z-fighting at long range)
- [x] Automated benchmark (?bench)
- [x] Performance report on Medium (PERFORMANCE.md: ~48–55 fps)

## M2 — Board, cockpit, fly
- [x] Jet bridge at stand 503 (Blender parts, stretched at runtime, walkable, retracts for pushback)
- [x] L1 door opening + hinged door, gear retraction, spinning fans
- [x] A320neo cabin (180 instanced seats, bins, galleys, window reveals) + cockpit, baked lightmap
- [x] Glass cockpit: PFD, ND (arc), E/WD, wheel SD, FCU drawn live; clickable gear/flaps/speed brake/park brake/AP/A-THR/FCU knobs
- [x] Flight model: 6-DOF aero + engines + gear contact; arcade, realistic normal law, realistic direct law (stalls)
- [x] Autopilot: HDG, ALT, V/S, autothrust SPD
- [x] Cameras: cockpit (free look), chase, orbit, tower; flight HUD; mouse yoke
- [x] Gate sequence: pushback with tug, engine start, taxi
- [x] Terrain streaming: AWS Terrarium elevation + EOX Sentinel-2 imagery (MapTiler when a key is set), airport flattening
- [x] Gamepad (Xbox/PlayStation standard mapping) + rebinding UI for keys and pad buttons
- [x] Flight starts: captain's seat, lined up 09R, 8 km final 27L
- [ ] Optional: MapTiler key in `.env.local` for sharper imagery

## M3 — Business core ✅
- [x] OurAirports import (npm run airports): 3,027 airline-capable airports + runway ends
- [x] Economy in a Web Worker: flights as timed events, gravity-model demand with fares and price sensitivity, itemised per-flight costs, monthly leases/overhead/insurance/depreciation, ledger
- [x] Aircraft market: 25 types; order new (deposit + delivery slots), lease, used market, sell, return lease
- [x] Routes: quote (market, max frequency, expected load, weekly profit), slots at coordinated airports (LHR, LGW, JFK…), buy slots
- [x] New game (name, code, colours, currency, difficulty incl. sandbox), main menu, IndexedDB saves + autosave, JSON export/import
- [x] Ops centre: overview, globe route map with live flights, routes, fleet, buy & lease, finances (P&L + cash chart), airline & saves
- [x] Time: pause/1x/10x/100x/1000x in the ops centre; real time while walking/flying; the business keeps running while you fly
- [x] Live exchange rates (frankfurter.dev) with offline fallback; GBP/USD/EUR/ZAR display
- [x] Gatwick as the detailed base airport (parameterised generators), Heathrow placed at its true offset; your livery on your aircraft

## M4 — Rivals, events, staff, flying your routes ✅
- [x] 46 AI rivals with real names, generic brand-ish colours (no logos), networks generated from real hubs + the demand model (renamable in data/economy/rivals.json)
- [x] Market share by seats × quality × fare; unmodelled smaller airlines share the rest
- [x] Rivals react: fare cuts, extra flights, launching routes against you, background growth
- [x] World ranking by weekly passengers (Competition tab)
- [x] Fuel price: mean-reverting random walk + shocks
- [x] Events at realistic rates: weather/fog at base, ATC strikes, fuel spikes/drops, downturns, tourism booms, awards, PR crises, IT outages, volcanic ash
- [x] Staff departments (pilots, cabin, engineers, ground, HQ): headcount from fleet & schedule, staffing and pay sliders, morale
- [x] Delays and cancellations (events, understaffing, morale), EU261-style compensation, on-time stats
- [x] Reputation from punctuality, service, comfort, value and safety; generated passenger reviews
- [x] Fly your own route flights: Ops → Routes → Fly; K skips to ~30 nm out (business time advances); landing books revenue + smooth-landing bonus; return leg
- [x] Destination airports generated from real runway data (all 3,027 airports), floating origin re-centres the world
- [x] Demand recalibrated: realistic loads (60-80%) and margins (6-11%)

## M5 — Customisers ✅
- [x] Ops centre "Customise" tab: brand (name, code, colours), livery, character, custom aircraft, cabins per aircraft
- [x] Livery editor on a live 3D A320neo: fuselage/belly/cheatline colours and sweep, titles (6 fonts, size, position, italic), registration colour, engines, window frames, 5 tail styles, quick-start presets
- [x] Livery layers: bands, stripes, text and logo decals; edit, reorder, hide, delete
- [x] Logo upload (PNG/SVG/JPG/WebP, shrunk to 512 px) for the tail and as fuselage decals; stored in the save
- [x] Livery applies to the player aircraft and the parked fleet at the base
- [x] Cabin editor, row mode: class zones (business / premium economy / economy), rows, seats abreast, pitch, galleys, lavatories; live seat count, comfort, length and exit-limit checks; presets; 3D seat map; refit cost
- [x] Cabin editor, VIP free mode: 10 furniture types placed in 3D, 10 cm grid, wall snapping, rotate, delete, starter layout
- [x] Cabins feed the economy: seats per aircraft, premium economy class with its own fare and demand split, comfort into reputation
- [x] Your own aircraft's cabin is rebuilt in the walkable 3D interior
- [x] Custom aircraft designer: 3 fuselage families, stretch, 3 wings, 3 engines, 2 fuel options (tunables in data/economy/designer.json); live performance and price; procedural 3D preview; certification cost; custom types appear in Buy & lease
- [x] Character creator: height, build, head size, skin, hair colour and style, pilot / CEO / casual outfits in airline colours, captain's cap; shows on your walking character
- [x] Saves keep liveries, logos, cabins, custom types and your look (export/import JSON included)

## M6 — Tycoon depth ✅
- [x] Corporate layer in its own module (src/economy/Corporate.ts), tunables in data/economy/corporate.json
- [x] Credit rating (AAA–CCC) from debt ÷ EBITDA, size and reputation; borrowing capacity from aircraft value and EBITDA
- [x] Term loans (1–10 years, monthly annuity), revolving credit line with automatic draw on negative cash, covenant breaches and penalty rates
- [x] Sale & leaseback of owned aircraft
- [x] Company valuation (EBITDA multiple × sentiment + cash + assets − debt), daily share price with noise and mean reversion
- [x] IPO (10–49% float, revenue and profit thresholds), dividends policy, buybacks, secondary offerings, selling/buying your personal shares
- [x] Board: demands every 6 months (profit, dividend, debt, growth), confidence, blocks large purchases when you lose trust without a majority
- [x] Personal cash and net worth (dividends and share sales; feeds M7)
- [x] Rival valuations from their networks; buy stakes (disclosure at 5/10/25%), stake dividends
- [x] Takeover bids with premium, board vote, competition regulator (remedies or block), merge (network, slots, morale hit) or keep the brand (subsidiary profit)
- [x] Found an alliance and invite full-service rivals: no fare wars, codeshare capacity, demand boost to member hubs, lounge sharing
- [x] Connecting traffic: demand boost on routes from your base that grows with the size of your hub
- [x] Lounges (3 levels): business demand boost, comfort, lounge-pass income
- [x] Hotels (2 sizes): occupancy from city size and your traffic, monthly profit, resale
- [x] Airport stakes: yield, control at 50% (fee discount, extra slots)
- [x] Belly cargo on every passenger flight; freighter cargo routes with a rate per kg and a freight market
- [x] Charter requests (sports, holiday, government, VIP) and ACMI wet leases; accept with a free aircraft, or fly the outbound leg yourself for a 10% bonus
- [x] Strikes: union warning, ballot, strike days with cancellations; settle with a pay rise or by raising pay in time
- [x] Ops centre: Finances & debt, Shares & board, Rivals & M&A, Lounges/hotels/airports, Charters & cargo tabs; overview KPIs; strikes in Staff
- [x] HQ upgrades: done in M7

## M7 — Personal empire ✅
- [x] Personal side in its own module (src/economy/Empire.ts); tunables in data/economy/empire.json, hq.json, achievements.json
- [x] CEO salary (paid by the airline, ~60% after tax), personal upkeep, asset depreciation and appreciation
- [x] Garage: 6 car classes with generic names, 8 colours, resprays; buy, sell, choose the car you drive
- [x] Drivable car: procedural body per style, arcade handling, Rapier collisions; E to get in/out, chase camera, gamepad triggers
- [x] Hangar: personal helicopters and business jets (real type names); fly anywhere in range: the airline clock moves on by the flight time, the world re-centres there
- [x] Marina (3 yachts, named by you) and 8 properties around the world
- [x] Home estate next to Gatwick: cottage → modern villa → country estate → mega-mansion (pool, garage showing your cars, tennis court, helipad, lake)
- [x] HQ: rented floor → own building → 32-storey landmark tower with your name on top; 10 departments × 3 levels with gameplay effects
- [x] Walkable HQ: lobby with logo wall, CEO office with trophy cabinet and fleet models, one room per department (live flight wall map in the ops room, fare dashboards, planning table, simulator, press room, boardroom...); locked rooms until upgraded
- [x] Revenue Management fare optimiser and Network Planning route ideas on the Routes tab
- [x] Rich list of 50 fictional billionaires; net worth = personal cash + your shares + possessions
- [x] 31 achievements with pop-ups and a trophy per achievement in the CEO office
- [x] Economy rebalance: narrowbodies lose passengers on long flights, quotes include belly cargo, 6% sales & distribution cost, flatter fare curve
- [x] Fixed: month-end summary counted investments and loans as operating costs

## M8 — Weather, night, damage, living airport, audio, more airports ✅
- [x] Sun position from the game clock and the real latitude/longitude; twilight, moonlight, stars, exposure that opens up at night
- [x] Night lighting: terminal windows glow, baked light dims, apron floodlights with light pools, aircraft nav/beacon/strobe lights, a landing light on your aircraft
- [x] Weather (data/weather.json): wind and gusts, cloud cover and ceiling, rain, mist and fog, storms with thunder and turbulence; drifts with game time and the season; fog/storm events at your base take over; METAR line in the flight HUD
- [x] Wind and turbulence act on the flight model (lighter near the ground)
- [x] Damage and crashes (data/damage.json, off switch in the menu): hard landings, tail and wingtip strikes, gear-up landings, runway excursions, overspeed, flaps and gear limits; crash report, repair bills after insurance, reputation, aircraft out of service
- [x] Living airport: AI rival airliners land, taxi on the real taxiway layout, turn around at a stand, push back and take off into the wind; they hold or go around while you are on the runway
- [x] People: 18 travellers and staff with random looks walking the terminal concourses and forecourts
- [x] Audio: synthesised engines, airflow, rain, wind, thunder, distant jets, car, chimes; spoken radio-altimeter callouts; optional CC0 files (AUDIO.md)
- [x] Generated airports everywhere: parallel taxiway with connectors, four stands with rival aircraft and jet bridges, control tower, floodlights; the apron avoids parallel runways
- [x] Settings: time of day (game clock / always day / always night), weather (live / clear), damage on/off, volume
- [x] Performance: character face/hair/cap merged into one mesh; people only drawn within 90 m

## M9 — Polish ✅
- [x] ILS on every runway (real geometry): localiser and glideslope diamonds on the PFD and the flight HUD, ident, course and distance
- [x] Approach lights (900 m with a crossbar) and PAPIs (white/red by your angle) at all airports, including generated ones
- [x] ATC with your call sign: push and start, taxi, take-off clearance with the live wind, handoff, ILS approach clearance with QNH, landing clearance, vacate; AI traffic calls on frequency; spoken with a squelch click, shown in a radio box
- [x] Auto resolution: render scale drops a little when frames are slow and recovers when there is headroom (setting, on by default)
- [x] Career balance pass with a scripted two-year player on every difficulty: thinner long-haul demand, a 7% overhead for head office, sales and marketing, cheaper turboprop leases, Hard now starts with an A320 (the ATR could never pay its way at Gatwick)
- [x] First-steps checklist for new players on the Overview
- [x] Fixed: the METAR line and radio box never appeared (display style fell back to "none")

## Known limitations / tech debt
- The baked lightmaps are daytime bakes: at night they are dimmed, not re-lit, so interiors look evenly lit.
- AI traffic is visual only (no collisions) and only at your base; other airports have parked aircraft.
- Pedestrians follow simple random walks inside clear zones; they don't avoid each other or you.
- No icing, no wet-runway braking, no lightning flashes yet.
- Personal jets have no 3D model yet: trips are a jump with the clock moving on; you can't fly them from the cockpit.
- Yachts and overseas properties are owned and valued but not visitable in 3D yet.
- Cars drive on the flat airport ground around Gatwick (about ±5 km); away from the flattened area the terrain may not match the ground plane.
- Interiors use emissive surfaces instead of real lights (cheap on Iris Xe), so they look evenly lit rather than dramatic.
- Rival airlines' finances are estimated from their networks (no full rival P&L); rivals don't buy stakes in you yet.
- Charter jobs are booked as a block of aircraft time; only the outbound leg can be flown by hand.
- Rolling "last 30 days" route stats reset every 30 days, so weekly cargo and passenger figures dip right after a reset.
- Custom aircraft types have no own 3D model yet: flying one yourself uses the A320neo.
- The walkable A320 cabin keeps its factory galleys, lavatories and seat colliders; custom layouts are fitted between them (VIP furniture is shown as simple blocks).
- Uploaded logos are stored in the save as images (~50-200 KB each).
- Lightmaps are baked for one fixed sun (day). Night lightmaps come with time of day in M8.
- Airport layout is approximate; cross-check with OurAirports runways.csv in M3.
- Terminal lightmap atlas packing leaves ~20% unused; split large islands later.
- Floating origin switches at skip time; flying very long distances by hand without skipping drifts from the origin (fine up to ~150 km).
- Terrain imagery is cached by the browser only; IndexedDB tile cache later.
- Walking is only supported on the airport's flat ground (no terrain colliders away from airports).
- Gear retraction is a simple slide into the bays; flaps/slats/control surfaces are not animated yet.
- No landing aids (ILS/PAPI) yet: approach lights, PAPI and an ILS needle come with M8 airport detail.
- KTX2 compression not set up yet (assets are small: ~4 MB). Do it when terrain caching/large textures arrive.
- build_a320neo.py still has its own copy of the fuselage profile (the interior + runtime read it from data).
- Economy: no loans yet (M6). Cash negative for 30 days sets a bankrupt flag (no bailout flow yet).
- Routes need all aircraft of one type; no connecting traffic or hubs yet (M6).
- The 3D world does not yet mirror the fleet (parked aircraft are static stand-ins).
- Route flights you fly yourself start from your base; the outbound/return legs are booked as extra flights on the route.
- At generated airports you land and taxi on runways; there are no taxiways or gates yet (stands come with detailed airports).
- Strikes (low morale) arrive in M6; morale warnings already appear.
