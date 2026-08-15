<div align="center">

# 🏎️ SRIDHAR RUSH

### *Real-time Online Multiplayer 3D Racing — your phone is the joystick*

**Race a friend across the internet.** Two laptops stay perfectly in sync while each
player drives with their **phone as a wireless dual-stick controller** — just scan a QR code.

<br/>

![three.js](https://img.shields.io/badge/Engine-three.js%20r128-049EF4?style=for-the-badge&logo=threedotjs&logoColor=white)
![Node](https://img.shields.io/badge/Server-Node.js%20%7C%20WebSocket-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Multiplayer](https://img.shields.io/badge/Mode-Real--time%20Multiplayer-FF4D4D?style=for-the-badge)
![Maps](https://img.shields.io/badge/Maps-3%20Worlds-FFB800?style=for-the-badge)
![Vercel](https://img.shields.io/badge/Frontend-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)
![Render](https://img.shields.io/badge/Physics-Render-46E3B7?style=for-the-badge&logo=render&logoColor=white)

<br/>

🏁 **3 Laps** &nbsp;·&nbsp; 🔥 **Nitro** &nbsp;·&nbsp; 💨 **Drift** &nbsp;·&nbsp; 🗺️ **3 Maps** &nbsp;·&nbsp; 📱 **Phone Joysticks**

</div>

---

## 🎮 What is this?

**Sridhar Rush** is a browser-based arcade racer inspired by *Forza Horizon*, *CarX Street* and
*The Crew*. The race is simulated on an **authoritative server (30 Hz)** and streamed to every
laptop, which renders it with smooth client-side **interpolation** — so all players see the
*exact same race*, live.

> No apps, no installs. Open a link, scan a QR, and race. 🏁

---

## 🗺️ Three Worlds, One Game

| | Map | Inspired by | Vibe |
|:---:|---|---|---|
| 🏞️ | **HIGHLAND RUSH** | *Forza Horizon* | Blue-sky midday · pine forests · mountains |
| 🌆 | **NEON CITY** | *CarX Street* | Night · neon skyscrapers · glowing signs & floodlights |
| 🏝️ | **ISLAND MOTORFEST** | *The Crew* | Golden sunset · turquoise ocean · palms · volcano |

Each map has its **own track shape** *and* its own atmosphere, lighting and props.
Pick your circuit in the lobby, then hit **START RACE**.

---

## ✨ Features

- 📱 **Phone-as-joystick** — left stick steers, right stick gas/brake, plus **NITRO**, **DRIFT**, camera, reset & horn
- 🖥️ **Synced laptops** — server-authoritative physics + client interpolation = zero desync
- 🔗 **Room codes & invite links** — create a room, share the code/QR, race
- 🤝 **2 modes** — *2 Cars (head-to-head)* or *1 Car co-op* (both phones share one car)
- 🏁 **Real race flow** — 3-2-1-GO countdown, START & FINISH lines, final-lap call, winner podium + confetti
- 🔥 **Arcade feel** — nitro flames, drift smoke & skid marks, crash sparks, camera shake, speed-reactive FOV
- 🎨 **Asphalt-grade visuals** — clearcoat car paint, ACES tone mapping, soft shadows, themed lighting per map
- ️ **Laptop fallback** — no phone? Drive with `WASD` / arrows

---

## 🕹️ Controls

| Who | Input |
|---|---|
| 📱 Phone (per player) | **Left stick** steer · **Right stick** gas/brake · **🔥 NITRO** · **DRIFT** handbrake · **CAM / RST / HORN** |
| 🖥️ Laptop | `W A S D` / arrows drive · `Shift` nitro · `Space` drift · `C` camera |

---

## 🚀 Quick Start (local)

```bash
npm install
npm start          # → http://localhost:3000
```

Open `http://<your-LAN-IP>:3000` on the laptop, scan the QR with your phones, and go.

---

## ☁️ Deploy (Vercel + Render)

The **frontend** (static) lives on **Vercel**; the **real-time physics server** lives on **Render**
(Vercel can't hold long-lived WebSockets).

1. **Render** → *New ▸ Blueprint* → pick this repo (`render.yaml`) → copy the service URL.
2. **Vercel** → *Add New ▸ Project* → import repo → set env `SERVER_URL` = your Render URL → Deploy.
3. Share your Vercel URL and race! 🏁

---

## 🏗️ Architecture

```
Your house                                  Friend's house
┌──────────────┐                           ┌──────────────┐
│ Laptop (3D)  │◀── state snapshots 30Hz ──▶│ Laptop (3D)  │
└─────────────┘            ▲              └──────▲───────┘
       │ input (WS)         │                     │ input (WS)
┌──────┴───────┐    ┌───────┴────────┐    ┌──────┴───────┐
│ Your phone   │───▶│  Race Server   │◀───│ Friend's     │
│ (joystick)   │    │ (authoritative │    │ phone        │
└──────────────┘    │  physics+rooms)│    └──────────────┘
                    ────────────────┘
```

---

## 📁 Repo Layout

```
├── server.js            # room server: WS relay + authoritative 30Hz sim
├── shared/game-core.js  # deterministic worlds + pure physics + race state machine
├── public/
│   ├── index.html       # laptop screen (lobby + 3D race + HUD)
│   ├── controller.html  # phone joystick page
│   ├── js/game.js       # screen client: interpolation, theming, FX
│   ├── js/controller.js # phone client: sticks, buttons, telemetry
│   └── css/             # Asphalt-style HUD & animations
├── vercel.json          # frontend deploy config
└── render.yaml          # server deploy blueprint
```

---

<div align="center">

**Built with ❤️ by Sridhar** &nbsp;·&nbsp; *Powered by three.js + Node WebSockets*

🏁 **See you on the track!**

</div>
