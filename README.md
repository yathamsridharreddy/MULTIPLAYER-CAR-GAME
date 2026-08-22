# 🏁 SRIDHAR RUSH

**A real-time, server-authoritative multiplayer 3D racing game for the browser — where your smartphone becomes the steering wheel.**

Sridhar Rush is a full-stack web racing game in the spirit of *Asphalt* / *Forza*: any number of laptops render a perfectly synchronized race while each driver controls their car with a phone held as a wireless, dual-stick gamepad. No installs, no app store — open a URL, scan a QR code, and race in under a minute.

[![three.js](https://img.shields.io/badge/rendering-three.js-049EF4?style=flat-square)](#)
[![Node.js](https://img.shields.io/badge/server-Node.js-339933?style=flat-square)](#)
[![Protocol](https://img.shields.io/badge/protocol-WebSocket-000?style=flat-square)](#)
[![Simulation](https://img.shields.io/badge/simulation-30%20Hz%20fixed--step-blue?style=flat-square)](#)
[![Frontend](https://img.shields.io/badge/frontend-Vercel-000?style=flat-square)](#)
[![Backend](https://img.shields.io/badge/backend-Render-46E3B7?style=flat-square)](#)

---

## 🎯 Overview

| Capability | Description |
|---|---|
| **Real-time multiplayer** | Authoritative 30 Hz server simulation; every client interpolates the same state, so all screens stay in lock-step. |
| **Phone-as-controller** | A mobile web page with two virtual joysticks, gyro steering, nitro, handbrake and haptics — joined by scanning a QR code. |
| **Room-based sessions** | Private 5-character room codes and shareable invite links; up to two drivers per room. |
| **Five circuits** | Distinct track geometry + art direction per map (day / night / sunset / desert / snow). |
| **Five game modes** | Rival Rush (1v1 online), Solo Rush (co-op), Local Duel (split-screen), Elimination, Drift Score. |
| **Arcade handling** | Nitro boost, drift/handbrake slip, lateral grip, off-road drag, capsule collision, solid track barriers. |
| **Race management** | 3-2-1-GO countdown, lap validation, best-lap tracking, final-lap call, results podium, per-map leaderboards. |

---

## 🏗️ Architecture

Sridhar Rush follows the classic **server-authoritative, client-interpolated** model used by commercial multiplayer games. The server is the single source of truth for physics; browsers are pure renderers that smooth between authoritative snapshots.

```
                    ┌───────────────────────────────┐
   Phone A ──input─►│                               │
   (joystick/gyro)  │      NODE.JS GAME SERVER      │──state──► Laptop A
                    │  ─ 30 Hz fixed-step physics   │           (three.js renderer,
   Phone B ──input─►│  ─ room + lap state machine   │           interpolates ~120 ms
   (joystick/gyro)  │  ─ deterministic world gen    │──state──► Laptop B
                    │  ─ collision + barriers       │           (three.js renderer)
                    └───────────────┬───────────────┘
                                    │  /version, /health, leaderboards
                                    ▼
                              Render (hosting)

   Frontend (index.html / controller.html / game.js)  ──hosted on──►  Vercel
```

### Data flow

1. **Input (60→30 Hz):** phones and keyboards send `{steer, throttle, brake, handbrake, nitro}` over WebSocket.
2. **Simulation (30 Hz):** the server integrates arcade car physics, resolves capsule collisions and track barriers, advances laps, and emits a compact snapshot per tick.
3. **Interpolation (60 fps):** each laptop renders ~120 ms in the past, blending between the two snapshots that bracket the render clock, plus an exponential smoother and a render-time clamp so the displayed car can never leave the track.
4. **Telemetry (≈6 Hz):** speed / lap / rank stream back to phones for the HUD.

### Why this model?

- **No desync:** clients never simulate gameplay; they only render, so two laptops can't diverge.
- **Cheat-resistant:** inputs are clamped server-side; position, laps and results are server-computed.
- **Graceful on bad networks:** snapshot interpolation + adaptive jitter buffer absorb bursty delivery (mobile hotspots) without visible shaking.

---

## 📦 Project Structure

```
├── server.js              # Express + WebSocket relay; 30 Hz authoritative sim; rooms; leaderboards
├── shared/
│   └── game-core.js       # Isomorphic core: seeded world gen, car physics, barriers, race state machine
├── public/
│   ├── index.html         # Driver / spectator screen (lobby wizard + 3D stage)
│   ├── controller.html    # Mobile controller UI
│   ├── js/
│   │   ├── game.js        # Client renderer (three.js): theming, interpolation, smoothing, HUD, FX
│   │   ├── controller.js  # Phone gamepad: joysticks, gyro, haptics, telemetry
│   │   ├── net.js         # RoomLink WebSocket client (auto-reconnect, backoff)
│   │   └── vendor/        # bundled three.js + qrcode
│   ├── css/               # style.css (screen) + controller.css (phone)
│   └── img/               # Map thumbnails for the lobby
├── vercel.json            # Frontend build config (static output + controller rewrites)
├── render.yaml            # Backend blueprint (Node, health check)
└── package.json           # express + ws
```

`game-core.js` is deliberately **isomorphic**: the identical file runs on the server (Node) and in the browser, guaranteeing both sides agree on track geometry and physics constants.

---

## 🗺️ Worlds & Physics

### Deterministic world generation
Every map is produced by a seeded PRNG (`mulberry32`), so the server and every client build **byte-identical** geometry from the same seed — buildings, trees, mountains and obstacles all line up across machines with zero network transfer.

### Tracks
| # | Circuit | Theme | Geometry |
|---|---|---|---|
| 0 | Highland Rush | Day · forests & mountains | Ellipse + visible tire-stack obstacles |
| 1 | Neon City | Night · neon downtown | Radial spline |
| 2 | Island Motorfest | Sunset · volcano & ocean | Radial spline |
| 3 | Canyon Chicane | Desert · S-curves | Radial spline |
| 4 | Hairpin GP | Snow · alpine hairpins | Radial spline |

### Collision model
- **Car = capsule** (segment ±1.6 u along heading, radius 0.95 u) matching the visible body from every angle — the nose can't punch through obstacles and the sides don't stop on an invisible cushion.
- **Track barriers** clamp the whole car body (nose/center/tail probes) inside the circuit, killing outward speed on both sides so the car scrapes the fence instead of tunnelling.
- **Map 0** keeps its on-track tire stacks as intended obstacles; **maps 1–4** keep the racing surface fully clean (no mid-track colliders) with solid side fences.

---

## 🕹️ Controls

**Phone controller** — left stick steers · right stick gas/brake · NITRO · DRIFT · optional gyro steering · haptic feedback.
**Keyboard fallback** — `WASD`/arrows drive · `Shift` nitro · `Space` drift · `C` camera.

---

## 🚀 Getting Started (local)

```bash
npm install
npm start          # serves game + relay on http://localhost:3000
```

Open `http://<lan-ip>:3000` on a laptop, scan the on-screen QR with one or two phones on the same network, pick a map & mode, press **START RACE**.

---

## ☁️ Deployment

The project separates a **static frontend** from a **stateful backend**.

1. **Backend (Render):** deploy with the included `render.yaml`; note the public URL.
2. **Frontend (Vercel):** import the repo and set `SERVER_URL` to the Render URL so browsers can reach the relay. Vercel's build copies `game-core.js` into `public/js/`.
3. Share the Vercel URL; players join by room code or invite link.

> Vercel alone can't host the relay — serverless functions can't hold long-lived WebSocket sessions; Render provides the persistent process the 30 Hz sim needs.

---

## ⚡ Performance & Bandwidth

- **Fixed-timestep 30 Hz** simulation, decoupled from 60 fps rendering.
- **Adaptive interpolation delay** (120–260 ms) absorbs network jitter.
- **Lobby snapshots at 5 Hz** and **leaderboards at 1 Hz** (clients cache the last one); races keep full 30 Hz — gameplay quality is untouched while idle bandwidth drops ~80%.
- **Pooled particles**, instanced scenery, capped pixel ratio and an adaptive-resolution preset keep low-end laptops at 60 fps.

---

## 🛡️ Reliability & Versioning

- **`/health`** and **`/version`** endpoints expose build + a **geometry fingerprint (GEOM_ID)**.
- On load the client compares its `GEOM_ID`/build against the server; a mismatch triggers a cache-busted reload (or a warning banner) so a stale client can never render a car "off-track".
- HTML is served `no-store` so browsers can't keep stale script references.

---

## ✅ Testing

Headless suites drive every map with bot/human-like input and assert: cars stop **at** fences (never through, never early), no invisible mid-track colliders, hazards behave, races finish, and snapshots stay finite. Run locally with Node against `game-core.js`.

---

## 🧭 Roadmap

Persistent accounts & global leaderboards · ghost replays · cosmetic liveries shop · spectator mode & larger grids · more circuits.

---

## 📄 Credits

Created by **Sridhar** as a study in realtime multiplayer game engineering. Rendering by [three.js](https://threejs.org); inspired by the *Forza Horizon*, *CarX* and *The Crew* franchises.
