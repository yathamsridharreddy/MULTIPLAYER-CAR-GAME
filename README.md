<div align="center">

<img src="delivery/img/logo.png" width="140" alt="Sridhar Rush logo"/>

# 🏎️ SRIDHAR RUSH
### *The browser racing game where your phone is the joystick.*

**Scan a QR code → your phone becomes a wireless gamepad → race a friend across the internet.**
No installs. No accounts required. Just a link and a laptop.

<a href="https://sridhar-drift.vercel.app"><img src="https://img.shields.io/badge/▶_PLAY_NOW-sridhar--drift.vercel.app-00F7FF?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Play now"/></a>
<br/>
<img src="https://img.shields.io/badge/release-v56-3ddc84?style=flat-square" alt="v56"/> <img src="https://img.shields.io/badge/sim-30_Hz_authoritative-ff2038?style=flat-square" alt="30Hz"/> <img src="https://img.shields.io/badge/engine-three.js_r128-35e0ff?style=flat-square" alt="three.js"/> <img src="https://img.shields.io/badge/backend-node_%2B_ws-ffd479?style=flat-square" alt="node"/> <img src="https://img.shields.io/badge/db-supabase_postgres-7b2ff7?style=flat-square" alt="supabase"/> <img src="https://img.shields.io/badge/PWA-installable-3ddc84?style=flat-square" alt="pwa"/>

<img src="delivery/img/poster.png" width="640" alt="Sridhar Rush — neon night race poster with QR code"/>

*Neon bloom · 5 circuits · 5 modes · phone haptics · ghost racing · global leaderboards · EN / తెలుగు / हिंदी*

</div>

---

## ⚡ 60-second quick start

| # | Do this | Happens |
|---|---|---|
| 1 | Open **https://sridhar-drift.vercel.app** on a laptop | 3D lobby with your room code + QR |
| 2 | Scan the QR with a phone (or two) | Phones become joysticks — sticks, nitro, haptics |
| 3 | Pick mode + circuit + car, press **🏁 START RACE** | 3‑2‑1‑GO — phones vibrate on GO |
| 4 | Win | Confetti, results, **📸 photo**, **👻 ghost link**, leaderboard |

No phone nearby? Drive with **WASD + Shift (nitro) + Space (drift)** against a **ROOKIE/PRO AI**.

---

## ✨ Feature tour (everything that ships)

### 🌍 Multiplayer that feels like a console
- **Phone-as-joystick** over WebSocket: dual analog sticks, nitro & drift buttons, optional **gyro steering**, **haptic feedback** (GO, impacts, nitro, finish) and a vibration toggle.
- **Cross-laptop rooms** via `/?room=CODE` links; ** Quick-Play matchmaking** pairs solo players.
- **Server-authoritative 30 Hz simulation** with 120 ms client interpolation — smooth on Wi‑Fi *and* 4G; **low-bandwidth mode** for weak networks.
- Split-screen **Local Duel**, co-op **Solo Rush** (two phones, one car).

### 🏁 Racing depth
- **5 circuits** (Highland, Neon City, Island, Canyon, Hairpin) × **5 modes** (Rival, Solo, Duel, Elimination, Drift Score).
- **Nitro meter** that charges from drifting; capsule-accurate car collisions; tire-stack obstacles **on the racing line**; analytic track-boundary barrier (see Architecture).
- **👻 Ghost replay** of your best lap + **shareable ghost links** (`/?g=ID`) so friends race *you* remotely, and a **🎥 spectator replay page** (`/replay?g=ID`) with pause/scrub/×2.
- **ROOKIE/PRO AI** — new players default to a winnable ROOKIE bot.

### 🏆 Progression & community
- **Email accounts** (Supabase) keep your identity & times across devices.
- **Leaderboards:** per-map TOP‑5 · **📅 Daily Challenge** (rotates at UTC midnight) · **🏆 Founders Cup** (weekly, resets Mondays) with WhatsApp challenge share.
- **🔥 Streak badge**, **5 achievements** (First Win, 3‑Day Streak, Sub‑0:30 Lap, Ghost Beaten, All 5 Circuits).
- **🟢 WhatsApp / ✈️ Telegram** one-tap invites; **📸 photo-finish** branded result cards.

### 📱 Product polish
- **Installable PWA** (home-screen app, offline lobby) + iOS “Add to Home Screen” hint.
- **🌐 i18n lobby:** English · Telugu · Hindi.
- **Accessibility:** reduced motion, colorblind palette, 10+ settings toggles, ARIA live regions.
- **Graphics:** lazy UnrealBloom (HIGH only), ACES tone mapping, vignette, speed-lines, per-theme skies, shadows, adaptive resolution + **auto smoothness ladder** (sheds glow < 52 FPS, resolution < 48 FPS).

---

## 🕹️ Controls

| 📱 Phone pad | | ⌨️ Keyboard | |
|---|---|---|---|
| Left stick / arrows | Steer | W/↑ · S/↓ | Gas · brake/reverse |
| Right stick | Gas / brake | A D / ← → | Steer |
| NITRO / DRIFT buttons | Boost / handbrake | Shift / Space | Nitro / drift |
| 🔄 gyro · 📳 haptics | Tilt steer · rumble | C | Camera |

---

## 🧠 Realistic architecture

```
                        ┌───────────────────────────────┐
   📱 phones ──wss──▶   │  Node relay (Railway/Render)  │  30 Hz authoritative sim
   💻 laptops ──wss──▶  │  rooms · physics · standings  │  (shared/game-core.js —
                        │  leaderboards · ghosts · /a   │   same code in browser+server)
                        └───────────┬───────────────────┘
                                    │ PostgREST / GoTrue (service role, server-only)
                        ┌───────────▼───────────────────┐
                        │  Supabase Postgres (optional) │  accounts · global boards · ghosts
                        └───────────────────────────────┘
   💻 laptops ◀──https── Vercel edge: static client (three.js r128, no framework),
                         CSP + immutable caching, SW offline lobby, og cards
```

**Design rules (enforced in code, not hope):**

1. **Authority** — clients send *inputs only*; the relay integrates physics and broadcasts snapshots. A hacked client can’t teleport: server positions win, and the render layer re-clamps to the track corridor anyway.
2. **Determinism** — `shared/game-core.js` is UMD-isomorphic and seeded (`mulberry32`), so server and every client build identical worlds/colliders from one source file.
3. **Boundary = analytic constraint** — no tiled fence colliders to gap or tunnel. Each tick, center + nose + tail probes are projected perpendicular onto the *same polyline segments the road is drawn with*; over-limit probes are re-projected inside and outward velocity is killed with restitution. Works at any speed/angle/drift/reverse; curved sections have continuous coverage by construction. Measured: 0 escapes across 10 exploit classes × 4 maps × 30 s; clamp cost **0.009 ms/frame**.
4. **Smoothness budget** — 120 ms interpolation absorbs jitter (measured cadence 33.2 ms ± 0.5 ms, zero >100 ms gaps); adaptive pixel-ratio + auto glow/shed ladder keep weak GPUs in the smooth band; bloom scripts lazy-load only on HIGH.
5. **Graceful degradation** — every optional backend (Supabase, community links) is env-gated; the game is fully playable with zero env vars.
6. **Privacy-first ops** — `/stats` aggregates beacons only (no IPs, no cookies); crash reports remote; CSP + `nosniff` + frame guards; RLS: public **read**, writes only via server service role.

**Bandwidth profile:** lobby snapshots 5 Hz · racing 20–30 Hz · phone telemetry ~7 Hz (halved in `LOW_BANDWIDTH=1`).

---

## 📊 Ops endpoints (relay)

`/version` · `/health` · `/stats` · `/lb?map=N[&daily=1]` · `/daily` · `/cup` · `/recent` · `GET/POST /ghost` · `POST /a` (beacons)

---

## 🗂️ Repository & deploy mapping

Game source lives flat in [`delivery/`](delivery/); the deploy repo maps it as:

| `delivery/` | deploy repo | role |
|---|---|---|
| `game-core.js` | `shared/game-core.js` | deterministic physics/world (⚠️ Vercel build copies it to `public/js/` — keep it fresh!) |
| `game.js` `net.js` `account.js` `i18n.js` `replay.js` | `public/js/…` | render client · WS link · auth · i18n · spectator |
| `controller.js` | `public/js/controller.js` | phone pad |
| `index.html` `controller.html` `replay.html` | `public/…` | lobby · pad · spectator |
| `style.css` `controller.css` | `public/css/…` | UI |
| `sw.js` `*.webmanifest` `img/` | `public/…` | PWA · icons · brand kit |
| `server.js` `package.json` `vercel.json` `render.yaml` | root | relay + deploy config |
| `supabase-setup.sql` | run once in Supabase | `leaderboard` + `ghosts` tables & RLS |

**Run locally:** `cd delivery && npm i && node server.js` → `http://localhost:3000`.

**Env vars (all optional):** `SERVER_URL` (Vercel) · `SUPABASE_URL`+`SUPABASE_ANON` (Vercel) · `SUPABASE_URL`+`SUPABASE_SERVICE_ROLE` (relay) · `COMMUNITY_WA`/`COMMUNITY_DC` (Vercel) · `LOW_BANDWIDTH=1` (relay).

---

## 🧪 Quality gate (every release)

Node harnesses + live probes: escape-hunt (10 exploit classes), ghost replay 19, bloom pipeline 8, SW routing 15, haptics 7, analytics 7, alive-lobby 11, ghost-links 5, achievements 8, auto-tune 8, i18n parity, bot-difficulty differential, race smoke (maps 0/1/4), network cadence probe. Release history v1→v56 in commit log; highlights: collision rebuild (v33) → accounts+PWA (v34–v38) → growth pack (v39–v45) → brand+replay (v46–v50) → smoothness+core-sync tripwire (v49–v55) → corridor enforcement (v56).

---

## ❓ FAQ / troubleshooting

| Symptom | Fix |
|---|---|
| Red “OLD GAME CORE” screen | `shared/game-core.js` is stale in the deploy repo — re-curl it from the latest release and redeploy |
| “Connection lost — retrying” | Relay restarting; self-heals in seconds (`/health` to check) |
| ~50 FPS cap | 50 Hz display vsync — normal; auto-ladder sheds glow under 52 for smoothness |
| iPhone install | Share ⬆ → *Add to Home Screen* (hint shown on the pad) |
| Sign-in asks to confirm email | Supabase → Auth → Email provider → **Confirm email OFF** |

---

## 👤 About the author

**Yatham Sridhar Reddy** — Cloud & DevOps-focused CSE undergrad (B.Tech ’27) · AWS Certified Developer · OCI Architect · 400+ DSA problems.
This repo doubles as my GitHub profile; Sridhar Rush — physics to posters — is my favourite build.

<p>
  <a href="https://www.linkedin.com/in/yatham-sridhar-reddy-744177374/"><img src="https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"/></a>
  <a href="https://yathamsridharreddy.github.io/sridhar-portfolio"><img src="https://img.shields.io/badge/Portfolio-00E5FF?style=for-the-badge&logo=google-chrome&logoColor=black" alt="Portfolio"/></a>
  <a href="mailto:yathamsridharreddy99@gmail.com"><img src="https://img.shields.io/badge/Email-D14836?style=for-the-badge&logo=gmail&logoColor=white" alt="Email"/></a>
</p>

---

<div align="center">
  <b>🏁 See you on the track → <a href="https://sridhar-drift.vercel.app">sridhar-drift.vercel.app</a></b>
</div>
