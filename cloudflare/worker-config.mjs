const CONTAINER_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON',
  'SUPABASE_SERVICE_ROLE',
  'ADMIN_KEY',
  'COMMUNITY_WA',
  'COMMUNITY_DC',
  'CSP',
  'FRAME_DENY',
  'LOW_BANDWIDTH',
  'MEM_CAP',
  'AN_USER_CAP'
];

// Copy only the environment values the existing Node service consumes. In
// particular, secrets stay in Worker secret bindings and are never returned to
// the browser by this Worker.
export function containerEnv(bindings = {}) {
  const out = {
    PORT: String(bindings.CONTAINER_PORT || '3000'),
    NODE_ENV: 'production'
  };
  for (const key of CONTAINER_ENV_KEYS) {
    const value = bindings[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

export { CONTAINER_ENV_KEYS };
