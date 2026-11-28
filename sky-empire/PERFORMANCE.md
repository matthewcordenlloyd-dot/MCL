# Performance log

Target: 30–60 fps on **Medium** on a ThinkPad X1 with Intel Iris Xe (i7-1355U), Chrome/ANGLE D3D11, 150% display scaling.

Method: each preset rendered at a fullscreen-equivalent size (1280×720 CSS px × render scale), 40 frames per view, each frame fully synced to the GPU (`readPixels`). The numbers are therefore whole-frame costs; real frame rates with normal CPU/GPU pipelining are slightly higher. In-game: press F3, or open `/?bench` in a visible full window.

## M1 — Heathrow block (2026-11-24)

| Preset | Internal res | Apron | Terminal | Runway vista | Walking (3rd person) | Draw calls | Triangles |
|---|---|---|---|---|---|---|---|
| Low | 1280×720 | 9.8 ms (~102 fps) | 8.4 ms (~119) | 8.8 ms (~114) | 10.3 ms (~97) | 36–82 | 41–58k |
| **Medium** | 1536×864 | **20.7 ms (~48)** | **19.1 ms (~52)** | **18.1 ms (~55)** | **20.3 ms (~49)** | 69–106 | 52–105k |
| High | 1920×1080 | 32.5 ms (~31) | 29.8 ms (~34) | 28.0 ms (~36) | 32.8 ms (~30) | 77–122 | 52–126k |
| Ultra | 1920×1080 | 53.9 ms (~19) | 51.3 ms (~19) | 46.9 ms (~21) | 53.3 ms (~19) | 94–137 | 61–127k |

CPU per frame (game logic + physics + draw submission): ~3.5 ms. Download size: ~4 MB of models and lightmap.

Verdict
- **Medium hits the target** (~48–55 fps).
- High is playable at ~30 fps.
- **Ultra is too heavy for Iris Xe** (4096 shadow map + MSAA ×4 + bloom at 1080p). It is meant for machines with a dedicated GPU.
- The biggest costs on Medium are MSAA on a half-float target and the real-time shadow map. Headroom is reserved for M2's terrain streaming and cockpit instruments.

## M2 — Boarding, cockpit, flight over real terrain (2026-11-24)

Same method, but on a realistic timeline: 60 frames at simulated 60 fps, so cockpit displays and terrain streaming update exactly as in play. Terrain fully loaded around an 8 km final to 27L (~120 tiles visible).

| Preset | Internal res | Chase, on final | Cockpit, on final | Cabin | Walking, apron |
|---|---|---|---|---|---|
| Low | 1280×720 | 13.8 ms (~73 fps) | 12.1 ms (~83) | 13.5 ms (~74) | 9.2 ms (~109) |
| **Medium** | 1536×864 | **21.3 ms (~47)** | **22.8 ms (~44)** | **24.6 ms (~41)** | **19.6 ms (~51)** |
| High | 1920×1080 | 28.7 ms (~35) | 30.9 ms (~32) | 30.4 ms (~33) | 26.7 ms (~37) |

The slowest 10% of frames on Medium are ~30 ms. They come from cockpit display uploads and new terrain tiles being built.

What we found and fixed
- **Canvas uploads stall integrated GPUs.** Redrawing all five cockpit displays each frame cost ~25 ms on Medium. Now exactly one display is uploaded per 30 Hz tick (PFD 15 Hz, others ~4 Hz) with no mipmaps, and the cost dropped to ~2 ms on average.
- **Blender exports double-sided materials by default.** The aircraft skin is now single-sided, which was needed to see out of the cockpit and also saves fill rate.

Verdict
- Medium meets the 30–60 fps target in all M2 situations (~41–51 fps).
- Ultra remains too heavy for Iris Xe.
- Next optimisation candidates: merge terrain tiles into fewer draw calls (texture array), build tile meshes in a Web Worker to remove the 30 ms spikes, and cache tiles in IndexedDB.

## M3 — Business core, two airports (2026-11-24)

The world now holds Gatwick (base) and Heathrow (40 km away, placed with earth curvature). The economy runs in a Web Worker. Measured at Gatwick on the realistic timeline:

| Preset | Apron | Terminal | Runway vista |
|---|---|---|---|
| Low | ~121 fps | ~173 | ~142 |
| **Medium** | **~72** | **~69** | **~63** |
| High | ~55 | ~47 | ~41 |

The second airport is mostly frustum- and fog-culled, so it costs little. The economy worker runs off the main thread and doesn't affect frame time. While the ops centre is open, the 3D world is not rendered at all (the globe has the GPU).

## M4 — Rivals, generated destinations (2026-11-24)

Measured at a generated destination (Barcelona, 3 real runways, real terrain and coastline) on approach, realistic timeline:

| Preset | Chase | Cockpit |
|---|---|---|
| Low | ~167 fps | ~125 |
| Medium | ~130 | ~121 |
| High | ~88 | ~85 |

**Caveat:** this is much faster than the ~45 fps measured in M2 for a similar view. Iris Xe shares its power budget with the CPU, and the M2 runs happened right after long Blender bakes, so those numbers were probably throttled. Expect real play on Medium somewhere between the two; the in-game F3 counter is the judge. The economy now simulates 46 rivals (~2,750 routes) in the worker: 120 simulated days take ~110 ms, with no effect on frame time.

## M5 — Customisers (2026-11-24)

Measured with synced frames at 1280×760 on Medium (render scale 1.2 → 1536×912):

| View | Frame time | FPS | Slowest 10% |
|---|---|---|---|
| Gatwick apron | 22.7 ms | ~44 | 28 ms |
| Gatwick terminal | 17.1 ms | ~59 | 19 ms |
| Runway vista | 17.3 ms | ~58 | 19 ms |
| Inside the cabin (custom 3-class layout) | 18.6 ms | ~54 | 24 ms |
| Livery editor (its own 3D view) | 5.9 ms | ~170 | 6 ms |

- Each livery repaint (fuselage + tail canvases) costs ~9 ms at 2048 px (Medium) and ~24 ms at 4096 px (High/Ultra). It only runs when you change something and is debounced, so you won't see it as stutter.
- Editors open over the ops centre, and the 3D world is not drawn while they are open.
- Custom cabins reuse the instanced seat mesh (one draw call per seat part), so a 180-seat layout costs the same as the factory cabin.
- These numbers are lower than M3's (63–72 fps). That fits the thermal variation already noted in M4: this run came after a long browser test session. Medium still holds the 30–60 fps target.

## M6 — Tycoon depth (2026-11-25)

M6 adds no rendering: everything new runs in the economy worker and the ops centre.

| Measurement | Result |
|---|---|
| One simulated year, 20 routes, lounge + hotel, 46 rivals (worker) | 0.36 s |
| Snapshot sent to the UI (4 times a second) | 0.7 ms |
| Gatwick apron, Medium, 1536×912 | 11.9 ms (~84 fps), slowest 10% 16.5 ms |
| Gatwick terminal, Medium | 9.7 ms (~103 fps) |
| Runway vista, Medium | 10.0 ms (~100 fps) |

The same views gave 44–59 fps at the end of M5. Nothing in the 3D world changed since then, so the difference is the laptop's thermal state (M5 was measured after a long, hot test session). Treat **~45–100 fps** as the real range on Medium, depending on how warm the machine is. The in-game F3 counter is the judge.

## M7 — Personal empire (2026-11-25)

Medium, 1536×912, synced frames. Measured with a 32-storey HQ tower, every HQ department open and a mega-mansion:

| View | Frame time | FPS | Draw calls |
|---|---|---|---|
| Gatwick apron | 12.4 ms | ~80 | 317 |
| Gatwick terminal | 9.0 ms | ~111 | 210 |
| Runway vista | 10.5 ms | ~95 | 259 |
| HQ forecourt (tower in view) | 9.4 ms | ~107 | 240 |
| HQ corridor (inside) | 10.7 ms | ~93 | 144 |
| Home estate | 10.0 ms | ~100 | 183 |

- HQ and home geometry is merged per material, so a whole building costs a few draw calls. Signs, screens and cars are separate meshes.
- The ops-room wall map redraws once a second, and only while you are near the HQ.
- The worker's new monthly work (rich list, achievements, upkeep) is negligible.
- These runs were on the same cool machine as the M6 runs. Expect lower numbers when the laptop is hot (see M5).

## M8 — Weather, night, living airport (2026-11-25)

Medium, 1536×912, synced frames, with 2 AI aircraft moving and 18 pedestrians:

| View | Day, clear | Night | Storm (rain, fog) |
|---|---|---|---|
| Gatwick apron | ~47 fps* | ~64 | ~55 |
| Gatwick terminal | ~92 | ~100 | ~80 |
| Terminal concourse with people | ~71 | ~72 | ~68 |
| Runway vista | ~86 | ~102 | ~91 |

\* The first view measured each time includes warm-up. Expect it to sit with the night and storm numbers in play.

What I measured and fixed
- The first M8 build cost ~140 extra draw calls on the apron (459 vs 317). Each person was 8 skinned meshes plus ~12 face, hair and cap pieces, drawn up to 260 m away. I merged the face, hair and cap into one mesh per person and only draw people within 90 m. Apron draw calls dropped to ~240.
- People cost about 2–3 ms in the terminal (animation and skinning). AI traffic and the landing light cost well under 1 ms.
- Rain is one line-segment mesh (6,000 drops) and costs about 1–3 ms when it is pouring.
- Night is cheap: there are no real lights apart from your landing light. Floodlights, windows and aircraft lights are glows and emissive surfaces.
- The image-based lighting is rebuilt at most every 2 seconds, and only when the sun or the cloud cover changes noticeably.

## M9 — Polish (2026-11-25)

Medium, 1536×912, auto resolution off, every view warmed up first:

| View | FPS |
|---|---|
| Gatwick apron | ~71 |
| Gatwick terminal | ~97 |
| Terminal concourse with people | ~86 |
| Runway vista | ~98 |
| Final approach, cockpit (ILS, ATC, approach lights) | ~69 |

- With a proper warm-up, the M8 apron figure (~47) turned out to be shader-compile time, not steady state.
- ILS maths, ATC and the PAPIs cost almost nothing. The approach lights are one instanced mesh.
- **Auto resolution** (on by default) checks frame time every 1.5 s. Above 22 ms it lowers the render scale by 8% (down to 60%); below 14.5 ms it raises it by 5%. That keeps a hot laptop near 45+ fps instead of sliding to the low 30s.
