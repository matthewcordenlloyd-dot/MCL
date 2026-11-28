# Sky Empire

A 3D open-world airline empire game in the browser: airline tycoon × flight game × billionaire life sim.
See [GAME_DESIGN.md](GAME_DESIGN.md) for the full design, [TODO.md](TODO.md) for progress and [IDEAS.md](IDEAS.md) for the parking lot.

## Run it

```powershell
npm install
npm run dev
```

Open http://localhost:5173 in Chrome or Edge, click **Click to play**, and walk around.

| Key | Action |
|---|---|
| W A S D | Walk (camera-relative) |
| Shift | Run |
| Space | Jump |
| Mouse / wheel | Look / zoom (3rd person) |
| V | First / third person |
| 1 2 3 4 | Teleport: apron, terminal, landside, runway |
| F3 | FPS and render stats |
| F4 | Cycle graphics preset |
| Esc | Menu (graphics presets, settings, teleports) |

### Running the airline (M3)

Start a new airline from the main menu (name, code, colours, currency, difficulty). Press **Tab** for the ops centre:
- open routes from the globe
- buy, lease or pick up used aircraft
- watch finances
- save and load

Use the speed buttons at the top (pause up to 1000×) in the ops centre; time runs in real time while you walk or fly. Rebuild the airport list from OurAirports with `npm run airports`.

### Rivals, staff and flying your routes (M4)

- **Competition** tab: the world ranking against 46 real-named rivals.
- **Staff** tab: pay and staffing per department.
- **Overview**: reputation, events and reviews.
- **Fly a route yourself:** Ops centre → Routes → **Fly**. Push back, take off, climb above 2,500 ft and press **K** to skip to about 30 nm from the destination (the airline's clock moves on too). Land, stop, and the flight is booked with a bonus for a smooth landing. The world re-centres on the destination, which is generated from real runway data.

### Flying with ATC and the ILS (M9)

- When a runway is ahead of you, the **ILS** shows on the PFD (cockpit) and the flight HUD. Keep the magenta diamonds centred: the bottom one is the localiser, the side one the 3° glideslope.
- **PAPI** lights beside the touchdown zone: two white and two red means you are on the glide path. All white is too high, all red is too low. **Approach lights** lead in for 900 m.
- **ATC** talks to you by your call sign: push and start, taxi, take-off clearance, handoff, ILS approach and landing clearance, then vacate. Other traffic is on frequency too. The last calls show top left.
- **Auto resolution** (Esc → Game) keeps the frame rate steady on a hot laptop by lowering the render scale a little, and raises it again when there is headroom.
- New players get a **First steps** checklist on the ops centre Overview.

### Weather, night and a living airport (M8)

- **Time of day** follows the game clock at your location: sunrise and sunset, twilight, stars and moonlight, glowing terminal windows, apron floodlights and aircraft lights. Esc → Game → World can force always day or always night.
- **Weather** changes over time: wind, gusts, cloud, rain, mist, fog and storms. Fog and storm events at your base show up in the world. While flying, the METAR line under the top bar shows the current weather. Wind and turbulence act on your aircraft.
- **Damage and crashes** are on by default (switch them off in the World settings). Hard landings, tail and wingtip strikes, overspeed and flying too fast with flaps or gear out cost repair money and reputation. A crash shows an accident report and puts you back at the gate.
- **AI traffic:** rival airliners land, taxi, turn around at stand 101 and take off using the runway the wind favours. If you sit on the runway they hold short or go around.
- **People** walk the terminal and forecourts.
- **Sound** is synthesised in the browser (no downloads), with spoken callouts on landing. See [AUDIO.md](AUDIO.md) to add real recordings.
- **Other airports** now get a taxiway, stands with parked aircraft and jet bridges, a control tower and night lighting.

### Personal empire (M7)

- **Personal empire** tab (ops centre):
  - Set your CEO salary.
  - Buy cars (pick a colour first), private jets and helicopters, yachts and properties; upgrade your home.
  - See the rich list and your achievements.
  - **Go home**, **Go to HQ** and **Drive your car** take you straight there.
- **Driving:** walk up to your car and press **E**. W/S accelerate and brake, A/D steer, Space is the handbrake, the mouse swings the camera, and **E** gets you out. With a gamepad: right trigger accelerates, left trigger brakes, left stick steers.
- **Jet trips:** in the Hangar pick a destination and press **Fly there**. The airline clock moves on by the flight time, fuel comes out of your personal cash, and you arrive on the apron of a generated airport. Fly back the same way, or press a teleport key.
- **Headquarters** tab: upgrade the building and 10 departments. Each level is a real effect (fewer delays, better yields, route ideas, cheaper maintenance...) and opens a room in your HQ beside the Gatwick car park. Revenue Management adds **Optimise fares** and Network Planning adds **Route ideas** on the Routes tab.

### Running the company (M6)

New ops centre tabs:
- **Finances & debt:** a full P&L, your credit rating and interest rate, term loans and a credit line. The credit line covers negative cash automatically unless you switch that off. **Fleet** has **Sale & leaseback** to raise cash from an owned aircraft.
- **Shares & board:** company value and your stake, dividend payout (paid to your personal cash), and the **IPO** once annual revenue passes about $150M. After listing you can buy back shares, issue new ones and sell or buy your own. The board sets targets.
- **Rivals & M&A:** buy stakes (+5%), bid for a whole airline (pick a premium and merge or keep the brand), found an alliance and invite full-service airlines.
- **Lounges, hotels, airports:** build lounges and hotels where you fly, and buy into airports (50% gives you control).
- **Charters & cargo:** accept charter requests and wet leases with a free aircraft. Tick **I'll fly it** to fly the outbound leg from the cockpit for a 10% bonus. Lease a freighter (Buy & lease → Freighters) and open a cargo route on **Routes** with a rate per kg.
- **Staff:** strike warnings appear here. Settle with a pay rise, or raise pay before the deadline.

Quick test: start a **Sandbox** game, open two routes, set speed to 1000× for a minute, then try each tab. In Sandbox the IPO is available straight away.

### Customising (M5)

Ops centre (**Tab**) → **Customise**:
- **Brand:** rename the airline, change the code and colours.
- **Livery editor:** paint the fleet on a live 3D A320neo (drag to spin, scroll to zoom). Pick a quick-start preset, change colours, titles and tail art, upload a PNG or SVG logo, and add bands, stripes, text or logo layers. **Apply to fleet** repaints your aircraft and the parked fleet.
- **Character creator:** body, skin, hair and outfit (captain, CEO or casual, in your airline colours). **Save look** updates your walking character.
- **Aircraft designer:** choose a fuselage family, stretch, wing, engines and fuel tanks and watch range, burn and price change. **Certify design** pays development (free in Sandbox) and puts the type in Buy & lease.
- **Cabins:** **Edit cabin** on any aircraft. Row mode sets business, premium economy and economy zones (rows, seats abreast, pitch) plus galleys and lavs, with live checks. VIP mode lets you drag furniture around a floor plan (R rotates, Delete removes). **Refit cabin** costs $150k per aircraft. Seat counts drive revenue; legroom and premium cabins raise comfort and reviews. Board your own aircraft to see the new seats.
- Routes now have a **premium economy fare**; it only sells if the aircraft has premium seats.

### Boarding and flying (M2)

Walk from the terminal (press 2) out through the middle airside door to the jet bridge at Gatwick stand 103, up into the A320neo, forward to the cockpit, and press **E** at the captain's seat. Or press Esc and pick a start under **Fly**: captain's seat, lined up on 09R, or an 8 km final to 27L.

| Key | Flying |
|---|---|
| W / S (or ↑ / ↓) | Pitch down / up |
| A / D (or ← / →) | Roll (also steers on the ground) |
| Q / E | Rudder / nosewheel |
| Shift / Ctrl (or PgUp / PgDn) | Thrust up / down · T full · X idle · R reverse (hold, on the ground) |
| Space or B | Brakes (hold) · N parking brake |
| G | Landing gear · [ and ] flaps up / down · / speed brake |
| Z / U | Autopilot / autothrust · , . selected heading · ; ' selected altitude |
| P | Pushback (at the gate) |
| C | Camera: cockpit, chase, orbit, tower · H flight HUD · M mouse yoke |
| F | Leave the seat (when stopped) |
| Mouse | Look around; in the cockpit, click levers, knobs and buttons (right-click to decrease, wheel to adjust) |

Xbox / PlayStation controllers work too: left stick pitch/roll, triggers thrust, bumpers rudder, B brakes, X gear, Y camera, D-pad flaps, L3 autopilot, A leave seat. Every key and button can be rebound in Esc → Controls.

Flight model: **Arcade** (forgiving, holds attitude, stall protection) or **Realistic** (Airbus-style normal law; switch protections off for direct law and real stalls). Set this in Esc → Game.

### Terrain and imagery

Real-world elevation (AWS Terrain Tiles) and Sentinel-2 cloudless satellite imagery (EOX) stream in around you, with no key needed. For sharper imagery, create a free MapTiler key and put `VITE_MAPTILER_KEY=yourkey` in a `.env.local` file in the project root, then restart `npm run dev`. The game switches to MapTiler imagery automatically.

### Benchmark

Open http://localhost:5173/?bench to test every preset at three fixed views (apron, terminal interior, runway vista).
Use `?bench=medium` to test one preset, or `?preset=low` to start on a preset.
Browsers cap the frame rate at the display refresh rate, so "60" means "60 or more".

## Rebuild the 3D assets (Blender 5.x)

All models are generated by Python scripts in `/blender` and exported to `/public/models`:

```powershell
npm run assets
```

```powershell
npm run assets -- a320neo
```

The terminal lightmap bake takes around 10 minutes on the CPU. For a quick low-quality bake while iterating, set `$env:SE_BAKE_SAMPLES=32` first.
Set `$env:BLENDER` if Blender is not in the default install folder.

## Project layout

```
/src/core        renderer, loop, presets, assets, geo maths, benchmark
/src/world       Heathrow, environment (sky/sun/fog), physics, procedural textures
/src/flight      aircraft models (flight model from M2)
/src/player      walking character controller, cameras, input
/src/customiser  livery painter, livery editor, cabin editor, aircraft designer, character creator
/src/ui          HTML/CSS overlay
/src/terrain, /src/vehicles, /src/economy, /src/ai   (later milestones)
/blender         Blender generator scripts (bpy)
/public/models   generated .glb + lightmaps
/data            all tunable values: aircraft, airports, graphics presets, controls, brand, world
```
