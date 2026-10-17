const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { containerEnv, CONTAINER_ENV_KEYS } = require('../cloudflare/worker-config.mjs');
const { rewriteForContainer } = require('../cloudflare/worker-proxy.mjs');

const ROOT = path.join(__dirname, '..');

test('Cloudflare container forwards only the existing server env contract and fixes PORT', () => {
  const env = containerEnv({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON: 'public-anon',
    SUPABASE_SERVICE_ROLE: 'private-role',
    ADMIN_KEY: 'private-admin',
    COMMUNITY_WA: 'https://example.test/community',
    PORT: '9999',
    SECRET_NOT_USED: 'must-not-leak'
  });
  assert.equal(env.PORT, '3000');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.SUPABASE_URL, 'https://example.supabase.co');
  assert.equal(env.SUPABASE_SERVICE_ROLE, 'private-role');
  assert.equal(env.ADMIN_KEY, 'private-admin');
  assert.equal(Object.hasOwn(env, 'SECRET_NOT_USED'), false);
  assert.equal(Object.hasOwn(env, 'PORT'), true);
  assert.deepEqual(Object.keys(env).sort(), ['ADMIN_KEY', 'COMMUNITY_WA', 'NODE_ENV', 'PORT', 'SUPABASE_ANON', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_URL'].sort());
  assert.ok(CONTAINER_ENV_KEYS.includes('SUPABASE_SERVICE_ROLE'));
});

test('container proxy retains the external path, query, method, headers and body but removes external host', async () => {
  const request = new Request('https://staging.example.workers.dev/api/player/streak?uid=u1&mode=weekly', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test': 'preserved', host: 'staging.example.workers.dev' },
    body: JSON.stringify({ claim: true })
  });
  const forwarded = rewriteForContainer(request);
  assert.equal(forwarded.url, 'http://container/api/player/streak?uid=u1&mode=weekly');
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.headers.get('content-type'), 'application/json');
  assert.equal(forwarded.headers.get('x-test'), 'preserved');
  assert.equal(forwarded.headers.has('host'), false);
  assert.equal(await forwarded.text(), '{"claim":true}');
});

test('Cloudflare config keeps one singleton container and uses the existing root Dockerfile', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.name, 'sridhar-rush-staging');
  assert.equal(config.main, 'cloudflare/worker.mjs');
  assert.equal(config.containers.length, 1);
  assert.equal(config.containers[0].image, './Dockerfile');
  assert.equal(config.containers[0].instance_type, 'basic');
  assert.equal(config.containers[0].max_instances, 1);
  assert.equal(config.durable_objects.bindings[0].name, 'GAME_SERVER');
  assert.equal(config.vars.CONTAINER_PORT, '3000');
});

test('Cloudflare Worker has no hardcoded service credentials or production hostname', () => {
  const source = fs.readFileSync(path.join(ROOT, 'cloudflare/worker.mjs'), 'utf8');
  assert.match(source, /getByName\('sridhar-rush-staging-singleton'\)/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE\s*[:=]\s*['"][^'"]+['"]/);
  assert.doesNotMatch(source, /https?:\/\/[^\s'"]+\.(?:com|net|org)/);
});
