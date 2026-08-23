<div align="center">
  <img src="delivery/img/logo.png" width="120" alt="Sridhar Rush logo"/>
  <h1>SRIDHAR RUSH 🏎️</h1>
  <p><b>Online 3D racing for the browser — your phone is the joystick.</b><br/>
  Scan a QR code, join from your phone, and race a friend across the internet. No installs, no accounts needed to play.</p>
  <p>
    <a href="https://sridhar-drift.vercel.app"><img src="https://img.shields.io/badge/PLAY-LIVE-00F7FF?style=for-the-badge" alt="Play live"/></a>
    <img src="https://img.shields.io/badge/build-v50-3ddc84?style=for-the-badge" alt="build v50"/>
    <img src="https://img.shields.io/badge/three.js-r128-35e0ff?style=for-the-badge" alt="three.js"/>
    <img src="https://img.shields.io/badge/server-30Hz%20authoritative-ff2038?style=for-the-badge" alt="server"/>
  </p>
  <img src="delivery/img/poster.png" width="520" alt="Sridhar Rush poster"/>
</div>

---

## ✨ What is this?

A **server-authoritative multiplayer racing game** that runs entirely in the browser:

- 💻 **Laptops** render the synced 3D race (three.js, neon bloom, 5 themed circuits)
- 📱 **1–2 phones** become wireless joysticks over WebSocket (scan a QR)
- 🌍 Race a friend across the internet, or a ROOKIE/PRO AI, split-screen, co-op, elimination & drift modes

## 🎮 Feature highlights

| Area | Ships with |
|---|---|
| **Racing** | 5 circuits × 5 modes · drift scoring · nitro · ghost replay · ROOKIE/PRO AI · matchmaking |
| **Multiplayer** | Phone-as-joystick (QR) · cross-laptop rooms · haptics on the phone pad · low-bandwidth mode |
| **Progression** | Email accounts (Supabase) · global + daily + weekly *Founders Cup* leaderboards · 🔥 streaks · 5 achievements |
| **Social** | WhatsApp/Telegram invites · *race-my-ghost* links · 🎥 watchable replay page · 📸 photo-finish share · QR poster kit |
| **Product** | Installable PWA (offline lobby) · EN / తెలుగు / हिंदी lobby · colorblind + reduced-motion modes · auto smoothness ladder |
| **Ops** | `/stats` analytics + remote crash beacons (no cookies, no IPs) · `/health` `/version` · CSP + security headers |

## 🕹️ Controls

| Input | How |
|---|---|
| 📱 Phone | Left stick = steer · right stick = gas/brake · NITRO button · gyro steer option |
| ⌨️ Keyboard | WASD drive · Shift nitro · Space drift · C camera |

## 🧠 Architecture

```
 phones (WebSocket input) ─┐
                           ├─▶ Node relay (30 Hz authoritative sim, interpolation hints)
 laptops (render clients) ─┘        │
      │                            ├─▶ in-memory + file leaderboards
      ├─ three.js scene, bloom, adaptive resolution
      └─ Supabase (optional): accounts, global leaderboard, shared ghosts
 Frontend: Vercel static · Relay: Railway/Render · DB: Supabase (free tier)
```

The sim is **server-authoritative**; laptops interpolate snapshots, so cheating a client only cheats yourself.

## 🗂️ Repository layout

Game source lives flat in [`delivery/`](delivery/) and maps to the deploy repo like this:

| `delivery/` | deploy target |
|---|---|
| `game-core.js` | `shared/game-core.js` (deterministic physics, copied to `public/js/` at build) |
| `game.js` / `net.js` / `account.js` / `i18n.js` / `replay.js` | `public/js/…` |
| `controller.js` | `public/js/controller.js` (phone pad) |
| `index.html` / `controller.html` / `replay.html` | `public/…` |
| `style.css` / `controller.css` | `public/css/…` |
| `sw.js`, manifests, `img/` | `public/…` |
| `server.js`, `vercel.json`, `render.yaml`, `package.json` | repo root |
| `supabase-setup.sql` | run once in the Supabase SQL editor |

## 🏃 Run locally

```bash
cd delivery
npm install
node server.js          # http://localhost:3000  (game + relay same origin)
```

Open `http://localhost:3000` on a laptop, scan the QR with a phone on the same network.

## ☁️ Deploy

1. **Vercel** → static frontend (`vercel.json` handles build + rewrites + headers)
2. **Railway/Render** → `node server.js` (`render.yaml` included)
3. Env vars (all optional — every feature degrades gracefully without them):

| Var | Where | Purpose |
|---|---|---|
| `SERVER_URL` | Vercel | public URL of the relay |
| `SUPABASE_URL`, `SUPABASE_ANON` | Vercel | accounts + global boards in browser |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` | Relay | server-side writes (boards, ghosts) |
| `COMMUNITY_WA`, `COMMUNITY_DC` | Vercel | lobby community buttons |
| `LOW_BANDWIDTH=1` | Relay | lean tick/telemetry rates for weak networks |

## 📊 Ops endpoints (relay)

`/version` · `/health` · `/lb?map=N[&daily=1]` · `/daily` · `/cup` · `/recent` · `/stats` · `POST /a` (beacons) · `GET/POST /ghost`

## 🧪 Quality & testing

Every release is gated by a node test harness: ghost replay (19), lazy-bloom pipeline (8), service worker routing (8+15), haptics (7), analytics/crash beacons (7), alive-lobby (11), ghost-links (5), bot difficulty differential, achievements (8), streaks, i18n parity, and live race smoke tests — plus a 15 s network-cadence probe (30 Hz, ±0.5 ms jitter).

## 🗺️ Built so far (v29 → v50)

Collision rebuild for splined tracks · matchmaking · accounts-lite → Supabase · a11y pass · ghost replay + share + spectator · PWA + offline · haptics · analytics + crash beacons · daily/cup/streaks · EN/TE/HI · ROOKIE bot · brand kit (logo, posters, og cards) · photo-finish · auto smoothness ladder.

---

## 👤 About the author

**Yatham Sridhar Reddy** — Cloud & DevOps focused CSE undergrad (B.Tech '27) · AWS Certified Developer · OCI Architect · 400+ DSA problems.
This repo doubles as my GitHub profile — the game above is my favourite build.

<p>
  <a href="https://www.linkedin.com/in/yatham-sridhar-reddy-744177374/"><img src="https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"/></a>
  <a href="https://yathamsridharreddy.github.io/sridhar-portfolio"><img src="https://img.shields.io/badge/Portfolio-00E5FF?style=for-the-badge&logo=google-chrome&logoColor=black" alt="Portfolio"/></a>
  <a href="mailto:yathamsridharreddy99@gmail.com"><img src="https://img.shields.io/badge/Email-D14836?style=for-the-badge&logo=gmail&logoColor=white" alt="Email"/></a>
</p>
