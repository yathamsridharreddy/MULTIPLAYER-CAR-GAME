# Cloudflare migration assessment — SRIDHAR RUSH

**Assessment date:** 17 October 2026  
**Question:** Can the whole backend currently on Render move to Cloudflare because the Render free allowance is ending?

## Executive answer

**Updated follow-up (17 October 2026):** Cloudflare's current **Containers (beta)** can run this existing Node/Docker server behind a Worker and Durable Object, including a proxied WebSocket. That gives this repository a smaller first trial than a full Workers rewrite. The pilot has now been prepared in `CLOUDFLARE-STAGING.md` and `wrangler.jsonc`; it uses one singleton backend so the existing process-owned rooms are not sharded. It requires **Workers Paid** (current Cloudflare docs: minimum US$5/month plus Container/DO/Worker/egress usage), not Workers Free. I could not deploy from this sandbox: Cloudflare is not connected here, and there is no Docker CLI/engine for the required image build. Keep Render live until the staging gates below pass.

**Yes, it is technically possible, but not as a hosting switch or a lift-and-shift.** The current Render service is a single-process Node.js application that combines a large REST API with an authoritative multiplayer WebSocket server. It relies on Node's `http`, Express, `ws`, `fs`, process environment, process timers, and mutable process memory. Cloudflare Workers do not run this application as-is.

The recommended end state is:

- **Cloudflare Pages** for the existing static game/controller files (or keep Vercel for static hosting; this is not currently Render-hosted).
- **Cloudflare Workers** for HTTP API routes and configuration/health endpoints.
- **Cloudflare Durable Objects (DOs)** for authoritative live race rooms and WebSocket connections, with a separate matchmaking coordinator if quick-play requires one global queue.
- **Supabase retained** for Auth and the existing durable player/game data. Keep its service-role key in a server-side Worker secret only.
- Replace the two Node-local JSON stores (`analytics.json` and `leaderboard.json`) with durable storage (prefer Supabase if its schema/API fits; otherwise D1), after checking and importing any data that matters.

This is a **meaningful backend port and architecture change**, especially for networking and room lifecycle. It should be staged and tested before Render is turned off. Do not cancel/delete the current Render service until the replacement passes the gates below.

## What is actually hosted where

The repository describes the game pages as Vercel-hosted and the Node game server as Render-hosted (`README.md`, `render.yaml`, `server.js`). The Render manifest declares one free Node web service, `node server.js`, health check `/health`, Node 22, and no attached persistent disk.

The Render Node process currently serves:

1. **Static files and runtime config** — `express.static(public)`, plus `/js/config.js` which injects build-time environment values.
2. **46 declared HTTP route registrations** — analytics, health/version, leaderboards, daily/weekly competition data, ghosts, progression/missions/bounties, crews, revenge/social flows, account purge/admin operations, and related APIs.
3. **WebSocket `/ws`** — one `ws` server attached to the same HTTP server. It creates/joins rooms, pairs quick-play clients, seats phone controllers, validates messages and drives the game.
4. **One global 30 Hz authoritative simulation loop** — `server.js` iterates an in-process `rooms` Map and advances `shared/game-core.js`. Other process timers handle heartbeat, memory sweeping, purge refresh and pruning.
5. **In-process stores** — rooms, quick-play queue, numerous player/crew/progression caches and analytics maps.
6. **Node filesystem JSON stores** — `analytics.json` and `leaderboard.json`. `render.yaml` does not declare a persistent disk, so these files should not be treated as safely durable across restarts/redeploys.
7. **Supabase integration** — the service-role key is used by the Node server for durable data and admin operations. Supabase Auth/DB are already separate services; moving compute to Cloudflare does not mean moving those databases.

The front end's `SERVER_URL` determines where it opens WebSockets and sends API requests (`public/js/net.js`, `controller.js`). The Vercel build script creates `config.js` from environment variables. The one Vercel-only function in the repo is `api/og.js`, for social preview cards; if the whole site leaves Vercel too, that function needs a Pages Function equivalent. The code's fallback Open Graph base URL is currently Vercel-specific.

## Why Render → Workers is not a direct redeploy

- The app imports `http`, `express`, `ws`, `fs`, `path` and Node `crypto`; it starts a Node listener and uses `process.on`, `process.memoryUsage`, local filesystem reads/writes, and long-lived Node timers. These are not a drop-in Worker runtime contract.
- `ws` expects Node's HTTP upgrade/server APIs. A Worker WebSocket endpoint uses the Cloudflare request/upgrade model; moving it means adapting the protocol handling, not just changing the server start command.
- Global `Map`s and `setInterval` state are attached to a single Node process today. Worker instances can be distributed, recycled and run in parallel. A global Worker variable cannot be the authority for a room. A room needs a stable coordinator/owner: a Durable Object is the natural Cloudflare primitive.
- 30 Hz is an active simulation cadence, not a casual request/response workload. DO scheduling, WebSocket lifetime/reconnect behavior, CPU limits, room distribution and the cost/usage envelope must be load-tested with representative concurrent rooms. A Worker/DO implementation must preserve server authority, seat ownership, matchmaking, message ordering, ping/reconnect behavior and the current 30 Hz physics semantics.
- `fs.writeFileSync` has no valid equivalent as durable Worker local storage. Analytics and leaderboard data need an explicit durable destination; merely putting them in a Worker global loses data on isolate recycling.
- Hundreds of kilobytes in one 5,800+ line server file make an all-at-once port harder to verify. The current server API is tied to many shared maps and helpers, so the HTTP migration is not simply 46 independent route copies.

## Migration designs considered

### A. Workers + Durable Objects — recommended Cloudflare-native destination

Port HTTP routes to Worker modules/route handlers. Port each authoritative race room to a DO, with sockets attached to that room. Add a dedicated matchmaking DO only if the current global quick-play queue must match users across rooms. Use Supabase over HTTPS for existing relational persistence; use D1 only for data that has a deliberate schema/import plan. Serve static assets on Pages.

**Pros:** removes Render dependency; stateful room ownership fits the DO model; keeps Supabase; deploy can be Cloudflare-native.  
**Costs/risks:** real port; concurrency and tick scheduling need proof; DO usage/limits and pricing must be checked against the actual Cloudflare account and expected room traffic; request routing and quick-play architecture change.

### B. Cloudflare front/proxy in front of Render — temporary only

Cloudflare can sit in front of a still-running Render origin, but it **does not remove Render usage** and cannot solve the ending Render free allowance by itself. WebSocket proxying also does not transfer in-memory rooms or the 30 Hz simulation to Cloudflare.

### C. Move to another Node host — lowest-risk immediate escape hatch

If the deadline is near, moving the existing Node process to a compatible Node host is much less risky than porting it to Workers under pressure. This is not a Cloudflare-only solution, and its price/free quota must be assessed separately. It can be a temporary bridge while the Cloudflare DO port is built.

## Data and secret handling

- Keep `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE` server-side. In Cloudflare these must be Worker secrets/bindings, never part of Pages client variables or generated `public/js/config.js`.
- The client may continue to receive only the existing public Supabase URL/anon key and public community URLs.
- Inventory the live `analytics.json` and `leaderboard.json` on the current host before cutover. Because the current Render manifest has no persistent disk, first verify whether any file data currently exists or has already been lost. Do not overwrite an existing Supabase leaderboard with an empty import.
- The repository has Supabase SQL migrations and many `sb*` functions; those should remain the record of existing durable progression/social data unless there is a separately approved database move. No database move is necessary just to move the Node compute.
- Recheck RLS and server-side authorization while porting. Do not expose the service role in a Worker request, client response, build output, or logs.

## Safe migration sequence and acceptance gates

1. **Cloudflare account/plan check (before coding):** confirm the account can create Pages, Workers, Durable Objects and their storage; check today's exact free/paid quotas and billing in the user's Cloudflare dashboard. I cannot see the user's account or verify its current quota/pricing from this repository. Do not assume “Cloudflare free” covers continuous active 30 Hz rooms.
2. **Baseline inventory:** capture current Render env-variable *names* (not secret values), production `/health`, `/version`, active route behavior, Supabase persistence verdict, and representative WebSocket traffic. Export/inspect JSON data if the current host still has it. Never paste secrets into chat.
3. **Extract boundaries without behavior changes:** isolate API/domain logic and room protocol from Express/Node startup so existing Node tests can keep running. Record every client endpoint and every WebSocket message type.
4. **Port stateless HTTP first:** Cloudflare Worker endpoints use the existing schemas and auth behavior. Run the same HTTP contract tests against both backends. Keep `SERVER_URL` pointed at Render during this phase.
5. **Port a single room to a DO:** use the existing shared game core and existing WebSocket protocol. Prove two screens/two controllers, all seat-ownership rules, Local Duel cap=2/no bots, Fighter-only authority, reconnect/heartbeat, idle cleanup and simultaneous room isolation. Do not rewrite physics to fit the host.
6. **Port matchmaking and remaining state:** implement global quick-play coordination explicitly; route all relevant APIs to the correct DO/Worker; replace RAM and filesystem dependencies with durable stores. Test restarts, object re-instantiation, concurrent claims and DB outages.
7. **Staging/load test:** compare old/new snapshots and simulation results for fixed input traces; test mobile reconnect and bad network; exercise multiple simultaneous rooms at the target load and record latency, CPU/runtime usage, bandwidth and billed usage. Confirm the Cloudflare account's costs/limits under that measured workload.
8. **Canary cutover:** deploy a staging host/domain first; then change the build-time `SERVER_URL` for a small controlled group. Monitor `/health` equivalent, errors, WebSocket close/retry rates, Supabase writes and spend. Preserve a rollback path to Render.
9. **Only after acceptance:** change production `SERVER_URL`, verify fresh clients and service-worker cache behavior, then stop Render. Keep exports/backups and a rollback window.

### Minimum “done” criteria

- Existing automated suite still passes; add Worker/DO adapter and integration suites, not weaker substitutes.
- Every API route and WebSocket message has a parity check.
- No cross-room or cross-player input/state leakage; server remains authoritative for all game modes.
- Room state survives intended DO lifecycle behavior; persistence claims verified against Supabase/D1, not assumed from RAM.
- Operational checks demonstrate target tick cadence and latency under representative rooms.
- No secrets in built static files; public config and Worker secrets are separated.
- Dashboard usage/cost is measured and acceptable for the user's actual quota.
- Render remains available until these criteria pass.

## Recommendation for the current situation

**Do not point the production game directly at a new Worker and do not turn off Render yet.** First verify the Cloudflare plan/quotas in the account dashboard and whether there is enough time for the DO conversion. If the Render allowance ends immediately, use a compatible Node host as a short-term bridge while preserving the same server contract; do the Cloudflare-native port as a staged project. If there is time and the measured Cloudflare limits fit, proceed with Workers + Durable Objects and keep Supabase.

I did not change hosting configuration or application code for this assessment. This repository review cannot determine the user's real Render remaining quota, Cloudflare plan/billing, production environment variables, live room load, or the data currently on the Render filesystem; those are required inputs before a safe cutover. Exact Cloudflare plan pricing/limits must be checked in the account dashboard because they are account/plan-specific and were not verified here.
