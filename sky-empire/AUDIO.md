# Audio

Sky Empire plays sound without any downloaded files. Everything is synthesised live with the Web Audio API (`src/audio/AudioSystem.ts`):

| Sound | How it is made |
|---|---|
| Your engines (rumble + fan whine) | Filtered brown noise + a sawtooth tone that follow N1; muffled in the cockpit |
| Airflow | Band-passed noise rising with airspeed |
| Rain, wind, thunder | Filtered noise; thunder bursts in storms |
| Other jets at the airport | Low rumble from the loudest nearby AI aircraft (distance and thrust) |
| Your car | A sawtooth "engine" whose pitch follows speed and throttle |
| Achievement / bad news / clicks | Short sine chimes |
| Cockpit callouts | The browser's built-in speech: radio-altimeter callouts (1000, 500, 100, 50 … 10) and "retard" |

Volume: Esc → Game → World → Volume.

## Swapping in real recordings (optional)

1. Put audio files (OGG or MP3) in `public/audio/`.
2. Create `public/audio/manifest.json` that maps loop names to files, for example:

```json
{ "engine": "cfm-leap-idle.ogg", "rain": "rain-loop.ogg", "jets": "distant-jet.ogg", "wind": "wind.ogg", "airflow": "airflow.ogg" }
```

Loop names: `engine`, `whine`, `airflow`, `rain`, `wind`, `jets`, `car`. A file replaces the synthesised source but keeps the same filters and volume automation. Missing files fall back to the synth.

## Where to find free sounds

Check each file's licence before you add it. These are good places to look:

- **Freesound.org**: filter by *Licence: Creative Commons 0*. Search "jet engine idle", "airliner cabin", "airport ambience", "rain loop", "wind loop".
- **Kenney.nl** audio packs (CC0): UI clicks, impacts.
- **OpenGameArt.org**: filter by CC0.
- **Pixabay Sound Effects**: free under the Pixabay licence (not CC0, but free for this use).
- **Sonniss GDC Game Audio Bundles**: royalty-free professional libraries (their own licence, not CC0).

I have not downloaded any of these. Adding files is your choice.
