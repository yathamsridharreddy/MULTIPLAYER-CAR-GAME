# 🏎️ Velocity Rush — Online Multiplayer

A 3D street-racing game where **phones become wireless joysticks** — and two
players can race **from two different houses**. You run the game on your
laptop, your friend runs it on theirs; both screens stay perfectly in sync
because the race is simulated on a shared server, and each phone is a
dual-stick controller.

Built with [three.js](https://threejs.org/) (WebGL), a server-authoritative
Node.js simulation (30 Hz), WebSocket state streaming with client-side
interpolation, and WebAudio engine/skid/nitro sounds synthesized in code.

## How it works

```
Your house                                   Friend's house
┌──────────────┐                            ┌──────────────┐
│ Laptop       │◀──── state snapshots ─────▶│ Laptop       │
│ (3D screen)  │        (30 Hz, WS)         │ (3D screen)  │
└──────┬───────┘             ▲              └──────▲───────┘
       │ input (WS)          │                     │ input (WS)
┌──────┴───────┐      ┌──────┴──────────┐   ┌──────┴───────┐
│ Your phone   │─────▶│  Race server    │◀──│ Friend's     │
│ (joystick)   │      │  (authoritative │   │ phone        │
└──────────────┘      │  physics+rooms) │   └──────────────┘
                      └─────────────────┘
```

- The **server runs the physics** (`shared/game-core.js`) so both laptops
  simulate the *exact same* race — no drift between screens.
- Laptops interpolate snapshots (~120 ms buffer) for buttery rendering.
- The track world is **deterministic** (seeded), so every client renders the
  identical city, trees, and mountains.

## Playing

### Online (two houses) — deployed setup
1. You open the game URL → a **room** is created and a 5-letter **ROOM CODE**
   appears, with an invite link + QR code.
2. Your friend opens the **invite link** on their laptop → their screen joins
   your room and syncs live.
3. Each of you scans the QR with your phone (or opens the controller link) →
   the phones join as **Player 1 / Player 2 joysticks**.
4. Hit **START RACE** → 3-2-1-GO → first to **3 laps** wins 🏁

### Local / LAN
```bash
cd car-game
npm install
npm start        # → http://localhost:3000
```
Open `http://<your-LAN-IP>:3000` (not localhost!) so phones can reach it,
then scan the QR.

### Controls

| Who | Input |
|-----|-------|
| Phone (per player) | **Left stick** steer · **Right stick** gas/brake · **🔥 NITRO** · **DRIFT** handbrake · **CAM / RST / HORN** |
| Laptop keyboard | `W A S D` drives your car if your phone isn't connected · `Shift` nitro · `Space` drift · `C` camera |

### Race features
- Server-synced 3‑2‑1‑GO countdown, finish gantry, final-lap alert
- Winner banner + confetti + podium results + instant **REMATCH**
- Nitro boost (regenerating meter) with exhaust flames + FOV kick
- Broadcast camera keeps **both cars in frame** + off-screen rival arrow
- Drift smoke, persistent skid marks, crash sparks, camera shake, speed lines

## Deploying (Vercel + Render)

The frontend is static (→ **Vercel**), the real-time server needs a persistent
process (→ **Render**; Vercel can't run long-lived WebSocket servers).

### 1. Deploy the server to Render
1. [render.com](https://render.com) → **New ▸ Blueprint** → pick this repo.
   The `render.yaml` blueprint configures everything (root `car-game/`,
   `npm install`, `node server.js`, health check `/health`).
2. When it's live, copy the URL, e.g. `https://velocity-rush-server.onrender.com`.

### 2. Deploy the frontend to Vercel
1. [vercel.com](https://vercel.com) → **Add New ▸ Project** → import this repo.
2. Set **Root Directory** = `car-game` (Vercel auto-detects `vercel.json`).
3. Add a build **Environment Variable**:
   - Name: `SERVER_URL`
   - Value: your Render URL from step 1 (e.g. `https://velocity-rush-server.onrender.com`)
4. Deploy. The build copies `shared/game-core.js` into the static bundle and
   writes `config.js` pointing the game at your Render server.

That's it — share your Vercel URL with your friend and race. 🏁

> **Note:** Render's free tier sleeps after ~15 min idle; the first join after
> a sleep takes ~30–60 s to wake the server. A paid instance stays always-on.

## Repo layout

```
car-game/
├── server.js                 # room server: WS relay + authoritative 30 Hz sim
├── shared/game-core.js       # deterministic world + car physics + race room
│                             #   (used by the server and mirrored to clients)
├── public/
│   ├── index.html            # laptop screen (lobby + 3D race + HUD)
│   ├── controller.html       # phone joystick page
│   ├── js/game.js            # screen client: interpolation + rendering + FX
│   ├── js/controller.js      # phone client: sticks, buttons, telemetry
│   ├── js/net.js             # WebSocket client with auto-reconnect
│   └── css/                  # Asphalt-style HUD & animations
├── vercel.json               # frontend deploy config
└── render.yaml               # server deploy blueprint
```

## Tests (run during development)
- `game-core` unit tests: deterministic world, physics, full autopilot-driven
  3-lap race, winner/results, co-op merge.
- Server integration tests: rooms, slot assignment, 2 laptops + 2 phones
  racing over real WebSockets, authoritative sync between screens.
- Full-stack browser tests (jsdom): lobby → start → keyboard driving through
  server physics → HUD, friend screen + phone joining live.
