# Security Policy for SRIDHAR RUSH

## Supported Versions

| Version | Supported          | Status             |
| ------- | ------------------ | ------------------ |
| v2.2.x  | :white_check_mark: | Active Production  |
| < v2.0  | :x:                | Deprecated         |

---

## Server-Authoritative Security Model

SRIDHAR RUSH is built with a server-authoritative architecture to ensure competitive integrity:

1. **Authoritative State Simulation**:
   - Vehicle positions, angular velocity, track checkpoints, and lap timers are simulated at 30 Hz by the Node.js server (`server.js`).
   - Clients only transmit raw control inputs (`steer`, `throttle`, `brake`, `handbrake`, `nitro`). Clients cannot submit modified position coordinates or self-reported lap times.

2. **Physical Lap-Time Anti-Cheat Checks**:
   - Finished race times are evaluated against physical, map-specific theoretical minimum thresholds derived from maximum engine velocity and track curvature. Any impossibly short lap time is flagged and discarded before leaderboard recording.

3. **Rate Limiting & Payload Defense**:
   - WebSocket messages are capped at 64 KB per payload to prevent denial-of-service (DoS) memory inflation.
   - Input packets are throttled through a sliding 1-second window per socket.

4. **Secret Key & Supabase RLS Isolation**:
   - The PostgreSQL database uses strict Row Level Security (RLS) policies.
   - Frontend client builds receive **only public anonymous keys** (`SUPABASE_ANON`). The backend `SUPABASE_SERVICE_ROLE` key is exclusively held on the server for authoritative operations.

---

## Reporting a Vulnerability

If you discover a security vulnerability or exploit in SRIDHAR RUSH:

1. **Do NOT open a public GitHub issue** detailing the vulnerability.
2. Please report the issue privately by contacting the maintainer via email at **yathamsridharreddy99@gmail.com** with:
   - A clear description of the vulnerability.
   - Step-by-step reproduction instructions or a minimal proof-of-concept.
   - The potential impact on gameplay or infrastructure.
3. You will receive an acknowledgment within 48 hours, and a patch will be prepared and deployed promptly.
