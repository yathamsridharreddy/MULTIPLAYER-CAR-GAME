# Sridhar Rush

**A real-time, server-authoritative multiplayer 3D racing game for the browser — where a smartphone becomes the controller.**

Sridhar Rush is a full-stack web game in which any number of laptops render a perfectly synchronized race while each participant drives using their phone as a wireless, dual-axis gamepad. No installs, no app store: players open a URL, scan a QR code, and race in under a minute.

Built on **three.js** for rendering and a **Node.js WebSocket simulation server** for authoritative physics, the project demonstrates real game-networking techniques — deterministic world generation, fixed-timestep simulation, snapshot interpolation, and client-side prediction-free smoothing — packaged in a deployable Vercel + Render architecture.

[![three.js](https://img.shields.io/badge/rendering-three.js-049EF4?style=flat-square)](#)
[![Node.js](https://img.shields.io/badge/server-Node.js-339933?style=flat-square)](#)
[![Protocol](https://img.shields.io/badge/protocol-WebSocket-000?style=flat-square)](#)
[![Simulation](https://img.shields.io/badge/simulation-30%20Hz%20fixed--step-blue?style=flat-square)](#)
[![Frontend](https://img.shields.io/badge/hosting-Vercel-000?style=flat-square)](#)
[![Backend](https://img.shields.io/badge/hosting-Render-46E3B7?style=flat-square)](#)

---

## Overview

| Capability | Description |
|---|---|
| **Real-time multiplayer** | Authoritative 30 Hz server simulation; every client interpolates the same state, guaranteeing a consistent race across machines. |
| **Phone-as-controller** | A mobile web page with two virtual joysticks, gyro steering, nitro, handbrake and telemetry — connected over WebSocket by scanning a QR code. |
| **Room-based sessions** | Private 5-character room codes and shareable invite links; up to two drivers per room. |
| **Five environments** | Distinct circuits with independent geometry and art direction: *Highland Rush* (day), *Neon City* (night), *Island Motorfest* (sunset), *Canyon Chicane* (desert), *Hairpin GP* (snow). |
| **Five game modes** | Rival Rush (head-to-head), Solo Rush (co-op), Local Duel (split-screen), Elimination, and Drift Score. |
| **Solid collision world** | Guard-rail barriers, tire-stack obstacles and car-vs-car bumping that all physically stop the cars. |
| **Arcade handling model** | Nitro boost, drift/handbrake slip, lateral grip, off-road drag, and collision response. |
| **Race management** | Countdown start, lap validation, best-lap tracking, final-lap call, and an automated results podium. |

---

## How it works

The simulation is **server-authoritative**. The server advances car physics on a fixed timestep and broadcasts compact state snapshots; each browser renders a smooth view by interpolating between the two snapshots surrounding a short render-delay offset. Because clients never simulate gameplay locally, races cannot desynchronize.

```
Driver A phone ──input──▶                        ◀──input── Driver B phone
                          ┌──────────────────┐
Laptop A (viewer) ◀──────┤  Simulation       ├──────▶ Laptop B (viewer)
  interpolated render     │  Server (30 Hz)  │        interpolated render
                          └──────────────────┘
                          rooms · physics · laps
```

**Deterministic worlds.** Each map's scenery and collision layout are produced by a seeded generator, so the server and every client derive identical geometry from the same seed and track parameters.

---

## Environments

| Map | Theme | Lighting | Character |
|---|---|---|---|
| **Highland Rush** | Open countryside | Clear midday | Flowing ellipse, pine forest, mountain backdrop |
| **Neon City** | Dense metropolis | Night, neon signage | Wavy circuit through illuminated towers |
| **Island Motorfest** | Tropical coast | Golden-hour sunset | Wide, fast layout over a turquoise lagoon with an active volcano |

Each environment carries its own track dimensions, sky, fog, sun, and prop set, selected in the lobby before the race begins.

---

## Controls

**Mobile controller**
- Left stick — steering
- Right stick — throttle / brake
- Nitro — boost (meter regenerates)
- Drift — handbrake for controlled slides

**Keyboard fallback** (when no phone is attached)
- `W A S D` / arrows — drive · `Shift` — nitro · `Space` — drift · `C` — camera

---

## Getting started locally

**Prerequisites:** Node.js ≥ 18.

```bash
npm install
npm start            # serves game + relay on http://localhost:3000
```

Open `http://<lan-ip>:3000` on a laptop, then scan the on-screen QR code with one or two phones on the same network. Select a map and mode in the lobby and press **Start Race**.

---

## Deployment

The project separates a static frontend from a stateful backend.

1. **Backend (Render).** Deploy using the included `render.yaml` blueprint. Note the public URL of the service.
2. **Frontend (Vercel).** Import the repository and set the environment variable `SERVER_URL` to the Render URL so the browser clients can reach the relay.
3. Share the resulting Vercel URL; participants join via room code or invite link.

Vercel alone cannot host the relay because serverless functions do not maintain long-lived WebSocket sessions; Render provides the persistent process the simulation requires.

---

## Project structure

```
├── server.js              # Relay + authoritative simulation loop, room lifecycle
├── shared/game-core.js    # Isomorphic core: seeded worlds, physics, race state machine
├── public/
│   ├── index.html         # Spectator/driver screen: lobby, HUD, 3D scene
│   ├── controller.html    # Mobile gamepad UI
│   ├── js/game.js         # Client rendering, theming, interpolation, FX
│   ├── js/controller.js   # Touch input, telemetry, connection handling
│   └── css/               # HUD and controller styling
├── render.yaml            # Backend blueprint
└── vercel.json            # Frontend build configuration
```

---

## Technical notes

- **Netcode:** fixed-timestep simulation with 30 Hz snapshots; clients render ~120 ms in the past and interpolate for jitter-free motion.
- **Physics:** arcade model with engine/brake forces, speed-sensitive steering, lateral grip decay, nitro overdrive, off-road penalty, and radial barrier constraints.
- **Rendering:** ACES filmic tone mapping, sRGB output, PCF soft shadows, clearcoat car paint, per-map environment maps, and pooled particle systems (smoke, sparks, nitro, skid marks).

---

## Roadmap

- Additional circuits and a desert/volcano environment
- Persistent leaderboards and ghost replays
- Vehicle selection and cosmetic liveries
- Spectator mode and larger grids

---

## License & credits

Created by **Sridhar** as a study in realtime multiplayer game engineering. Rendering by [three.js](https://threejs.org); inspired by the *Forza Horizon*, *CarX* and *The Crew* franchises.

---

## What's new in v2.1

- **Real car-shaped collision** — the car is now simulated as a capsule matching its visible body (≈4.8 m long), not a tiny circle. The nose can no longer punch through tire stacks, walls or other cars, and there is no invisible cushion on the sides either — contact is exactly where you see it.
- **Whole-body barriers** — the nose, center and tail are all kept inside the guard rails/walls on every map, at every angle, so nothing ever clips through the fence.
- **Car-vs-car bumping** — Asphalt-style body contact with front/rear collision zones; two cars can no longer overlap or ghost through each other.
- **Stable cars** — server-side steering dead-zone plus adaptive client smoothing eliminate shaking on straight sections, even on bursty mobile-hotspot connections.
- **Express 5 fix** — `/js/game-core.js` served correctly again (it 404'd under Express 5, which could leave a blank screen on the Node server).

## What's new in v2

- **Driver identity** — choose your racer name, car colour and car class (Velocity / Accelerator / Grip) in the lobby; shown on the HUD, results and leaderboards.
- **Persistent leaderboards** — top lap times per circuit, stored server-side and shown in the lobby.
- **AI opponent** — race a bot when you're solo.
- **Race setup** — 1 / 3 / 5 lap formats.
- **Live quality-of-life** — ping/latency badge, FPS meter, graphics quality presets (Low/Med/High), audio mute + music, and a share-results button.
