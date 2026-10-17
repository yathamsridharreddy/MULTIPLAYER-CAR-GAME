import { DurableObject } from 'cloudflare:workers';
import { containerEnv } from './worker-config.mjs';
import { rewriteForContainer } from './worker-proxy.mjs';

const PORT = 3000;
const READY_ATTEMPTS = 80;
const READY_INTERVAL_MS = 250;

export class GameServerContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.starting = null;
  }

  async fetch(request) {
    try {
      await this.ensureReady();
      const forwarded = rewriteForContainer(request);
      return await this.ctx.container.getTcpPort(PORT).fetch(forwarded);
    } catch (error) {
      console.error('[cloudflare-staging] backend unavailable:', error?.message || String(error));
      return Response.json(
        { ok: false, error: 'backend_starting', message: 'The game server is starting. Please retry shortly.' },
        { status: 503, headers: { 'Retry-After': '3', 'Cache-Control': 'no-store' } }
      );
    }
  }

  async ensureReady() {
    const container = this.ctx.container;
    if (!container) throw new Error('Container binding is missing');
    if (this.starting) return this.starting;

    this.starting = this.startAndWait(container).finally(() => { this.starting = null; });
    return this.starting;
  }

  async startAndWait(container) {
    const idleMs = Math.max(60_000, Number(this.env.CONTAINER_IDLE_MS) || 600_000);
    await container.setInactivityTimeout(idleMs);

    if (!container.running) {
      container.start({ env: containerEnv(this.env), enableInternet: true });
    }

    const port = container.getTcpPort(PORT);
    let lastError;
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
      try {
        const response = await port.fetch('http://container/health', {
          signal: AbortSignal.timeout(1500)
        });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`health check returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await scheduler.wait(READY_INTERVAL_MS);
    }
    throw new Error(`Node container did not become ready on port ${PORT}: ${lastError?.message || 'timeout'}`);
  }
}

export default {
  async fetch(request, env) {
    // Keep one globally named DO/container on purpose: the current Node service
    // owns all rooms and matchmaking in process memory. Do not shard this name
    // until the game state has been deliberately migrated to shared room owners.
    const backend = env.GAME_SERVER.getByName('sridhar-rush-staging-singleton');
    return backend.fetch(request);
  }
};
