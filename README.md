# Liberty Shores

An open-world GTA-style sandbox that runs in your browser, built entirely on the
[Polyfork NYC City Kit](https://polyfork.dev/kit/nyc-city-kit-fbca88) — 82 low-poly,
real-world-scale models (buildings, vehicles, rigged characters, street furniture)
hotlinked live from Polyfork's free CDN. No build step, no API key, no downloaded assets.

![Liberty Shores](https://polyfork.dev/kits/nyc-city-kit-fbca88/approved.png)

## Run it

```bash
cd gta-nyc
node serve.mjs        # serves on http://127.0.0.1:8123 (no-cache dev server)
# or: python -m http.server 8123
```

Open http://127.0.0.1:8123 and click **Enter the city**. Requires internet access
(game assets stream from `polyfork.dev` and `unpkg.com`) and a WebGL-capable browser.

## Controls

| Key | Action |
|-----|--------|
| `W A S D` | walk / drive |
| `Shift` | sprint |
| `Space` | jump (on foot) / handbrake (driving) |
| `F` | enter / exit / steal vehicle |
| `Left click` | fire (works as a drive-by too) |
| `Q` | switch weapon (Pistol / SMG) |
| `E` | answer a payphone (starts a courier job) |
| Mouse | look / aim (pointer lock) |

## Features

- **Open world** — a 292×236 m Manhattan-style grid: 20 blocks, ~160 buildings from
  the kit placed shoulder-to-shoulder with rooftop water towers/AC units/billboards,
  two parks, lamp-lit pavements, traffic lights, 260+ parked cars (per-type instanced,
  all stealable).
- **Day/night cycle** (4 min) using Polyfork's `stage.mjs` lighting rig; at night the
  buildings' windows and signs glow (night-zone vertices carved from each module's
  `night` export) and street lamps cast pooled light.
- **On foot** — third-person controller with Idle/Walk/Run clips from the kit's
  rigged characters (Mixamo skeleton in every GLB), sprint, jump, pistol + SMG
  hitscan combat with tracers, drive-bys.
- **Vehicles** — 9 kit vehicles (cab, town car, hatchback, delivery/garbage trucks,
  food truck, bus, fire engine, police cruiser) with arcade physics, spinning wheels
  from the kit's `wheel-*`/`steer-*` rig pivots, damage, smoke and explosions.
- **Traffic** — AI cars drive the street grid lane-correctly, obey traffic-light
  phases, turn at junctions on bezier paths, brake for you.
- **Pedestrians** — ambient walkers spawn on pavements, panic and flee from gunfire,
  get run over (which the police notice).
- **Police & wanted system** — 5 stars, escalating response: foot cops chase and
  arrest below 3 stars (BUSTED), shoot at 2+, cruisers with flashing lightbars ram
  and shoot from 2+, evade by keeping distance. Get wasted or busted → respawn,
  pay the penalty.
- **Missions** — taxi fares (drive any yellow cab, fares auto-start), payphone
  courier jobs with deadlines, 10 hidden packages ($150 each, $1500 for all),
  health/armor pickups.
- **HUD** — money, wanted stars, health/armor bars, weapon box, rotating minimap
  with road network, cop/mission/package blips, toasts, WASTED/BUSTED overlays.
- **Audio** — fully procedural WebAudio: engine pitch, gunshots, sirens,
  explosions, pickups. No audio files.

## Code layout

```
index.html        shell + HUD markup/CSS + import map (three 0.180 + addons)
serve.mjs         no-cache static dev server
js/
  main.js         boot, input, game loop, day/night driver
  world.js        city generator: painted ground, buildings, props, night carving,
                  collision grid, traffic lanes, parking spots
  assets.js       Polyfork CDN access (createAsset modules, character GLBs, night zones)
  vehicles.js     vehicle physics, traffic + police AI, explosions, parked instancing
  peds.js         pedestrian AI (walk / flee / die / passenger)
  police.js       wanted heat, cop + cruiser spawning and behaviour, arrest
  player.js       third-person controller, camera, shooting, enter/exit, wasted/busted
  missions.js     fares, deliveries, packages, pickups, markers
  hud.js          DOM HUD + prerendered rotating minimap
  fx.js           smoke, fire, tracers, explosions
  audio.js        procedural WebAudio
  utils.js        math, seeded RNG, spatial hash, 2D collision/ray helpers
```

## Credits

All 3D models are from the [Polyfork NYC City Kit](https://polyfork.dev/kit/nyc-city-kit-fbca88),
used live from their CDN under the Polyfork free licence (commercial use allowed,
attribution not required). Character mesh files are additionally CC BY 4.0:
character GLBs by [Polyfork](https://polyfork.dev). Lighting via Polyfork's
`stage.mjs`/`merge.mjs` helpers. Everything else (gameplay, city generation, HUD,
audio) is original code.
