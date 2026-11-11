# Cloudflare staging trial for SRIDHAR RUSH

This deployment uses **Cloudflare Containers**, not a rewrite of the game's relay. The existing `Dockerfile` runs the existing Express + `ws` server, while a Worker/Durable Object forwards HTTP and `/ws` upgrades to it. All public paths go to one named singleton, deliberately preserving the current process-wide room map and 30 Hz simulation. This is a **staging trial**; it does not change Vercel, Render, Supabase, or production `SERVER_URL`.

## Plan and cost warning

Cloudflare Containers are **not available on Workers Free**. Cloudflare documents Containers under the Workers Paid plan (minimum **US$5/month**, plus measured Container, Durable Object, Worker, and egress usage). The trial selects a `basic` Container (1/4 vCPU, 1 GiB memory) and starts it on demand; a live websocket can keep it active. Set an account budget/alert before deployment and stop/delete the staging Worker/container after testing if you do not want continued use. Verify current account billing in the Cloudflare dashboard before proceeding.

The `basic` size is intentionally closer to Render's 512 MiB / 0.1 CPU than Cloudflare's `lite` size, but real race load must be measured. This is not a production uptime or free-tier promise.

## What is in this pilot

- `wrangler.jsonc`: Worker + one durable SQLite-backed Container binding, one Container instance, root `Dockerfile`, port 3000.
- `cloudflare/worker.mjs`: forwards every route through one singleton DO/container, waits for `/health`, returns WebSocket-upgrade responses unchanged, and returns a safe retry response when startup fails.
- `cloudflare/worker-config.mjs`: allowlisted process environment transfer (server secrets are not put in the Worker response or client bundle).
- `cloudflare/worker-proxy.mjs`: URL rewrite used by the HTTP/WebSocket proxy.
- `test/cloudflare-container-config.test.js`: guards the environment allowlist, forwarding contract, singleton and config.

No application gameplay, race simulation, existing API, or Supabase schema is changed.

## Deploy to a staging Worker

From the repository root, after installing dependencies:

```sh
npm ci
npx wrangler login
npx wrangler deploy --config wrangler.jsonc
```

The first deployment needs a Workers Paid account and a Docker-compatible engine for building the root `Dockerfile`. Cloudflare Containers are in beta and initial provisioning can take several minutes. The command outputs the staging `workers.dev` URL.

Set the server-side Supabase/auth settings as Worker secrets. Wrangler prompts for each value; enter it locally in the terminal, **never in chat and never in a committed file**:

```sh
npx wrangler secret put SUPABASE_URL --config wrangler.jsonc
npx wrangler secret put SUPABASE_ANON --config wrangler.jsonc
npx wrangler secret put SUPABASE_SERVICE_ROLE --config wrangler.jsonc
npx wrangler secret put ADMIN_KEY --config wrangler.jsonc
```

Optional community links can be set as Worker secrets too:

```sh
npx wrangler secret put COMMUNITY_WA --config wrangler.jsonc
npx wrangler secret put COMMUNITY_DC --config wrangler.jsonc
```

After changing secrets, the Node Container consumes the new values on its next cold start. To make that immediate, restart the Container from the Cloudflare dashboard, or remove the staging Worker and deploy again. Never expose `SUPABASE_SERVICE_ROLE` in Pages/Vercel build variables.

## Staging verification checklist

Use the URL Wrangler printed, not the production domain:

1. `GET <staging-url>/health` returns JSON and the persistence verdict matches the existing Render deployment.
2. `GET <staging-url>/version` returns the expected build and geometry fingerprint.
3. Open the staging game and a second screen; create/join a room and check `/ws` upgrades successfully.
4. Connect a phone controller, verify its inputs move only its assigned car, disconnect/reconnect, and test room cleanup.
5. Exercise Local Duel (two seats, no bots), one standard race, and Fighter Rush authority.
6. Test an account-backed API call and confirm data appears in the existing Supabase project; check that the service-role key never appears in the page source, `config.js`, or API response.
7. Keep at least one race connected for a measured session; record API requests, WebSocket message counts, Container running duration, memory/CPU, reconnects, and actual Cloudflare bill/usage dashboard. Test after the Container sleeps and cold-starts too.
8. Do not point production Vercel `SERVER_URL` to this staging URL until every check passes. Supabase Auth may require adding the staging `workers.dev` URL to the project's allowed redirect URLs for sign-in flows.

To remove only this staging deployment after the trial:

```sh
npx wrangler delete --config wrangler.jsonc
```

Deleting the Worker also removes its associated container application/instances. Confirm the dashboard shows the staging Worker/container removed; keep the Render service running throughout the test.
