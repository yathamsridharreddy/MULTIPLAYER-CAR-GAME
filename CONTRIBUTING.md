# Contributing to SRIDHAR RUSH

Thank you for your interest in contributing to **SRIDHAR RUSH**! We welcome bug reports, performance enhancements, physics refinements, accessibility improvements, and documentation polish.

---

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free environment for all contributors. Please treat everyone with respect and constructive feedback.

---

## Local Development Workflow

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher (v22 LTS recommended)
- **npm**: v9.0.0 or higher
- **Modern Web Browser**: Chrome, Edge, Safari, or Firefox with WebGL and WebSockets enabled

### 2. Setup
```bash
# 1. Clone the repository
git clone https://github.com/yathamsridharreddy/MULTIPLAYER-CAR-GAME.git
cd MULTIPLAYER-CAR-GAME

# 2. Install dependencies
npm install

# 3. Build client bundles and copy shared modules
npm run build

# 4. Start local development server
npm start
```
The game will be available locally at `http://localhost:3000`.

---

## Engineering Guidelines & Architectural Principles

1. **Server Authority is Strict**:
   - Game state, lap times, checkpoint crossings, race finishes, Elo ratings, XP, coins, and leaderboard submissions are calculated **strictly on the server** in `server.js` and `shared/game-core.js`.
   - Client-side code (`public/js/game.js`, `public/js/net.js`) must never dictate official scores or award currency.

2. **Shared Physics Simulation**:
   - Physics calculation logic in `shared/game-core.js` runs identically on both Node.js (server tick) and client (prediction/replay).
   - Any modifications to vehicle dynamics, grip curves, or collision logic must maintain exact parity between Node.js and browser environments.

3. **Zero-Allocation Render Loops**:
   - The Three.js animation loop (`requestAnimationFrame`) in `public/js/game.js` must avoid allocating new objects (`new THREE.Vector3()`, array splices) per frame to prevent GC micro-stutters.
   - Use reusable module-level scratch vectors and object pools.

4. **Internationalization (i18n)**:
   - All user-facing strings must be tokenized through `tI18n(key, params)` and defined in `public/js/i18n.js` across all supported locales (`en`, `te`, `hi`, `es`).

---

## Testing & Quality Assurance

Before opening a pull request, verify that the complete automated test suite passes:

```bash
# Run the complete test suite (94 tests across 21 suites)
npm test

# Verify client bundle build succeeds cleanly
npm run build
```

If you add a new system or fix a bug:
1. Include a focused unit or integration test in `test/`.
2. Ensure existing tests remain green (0 failures, 0 skipped).
3. Test touch and keyboard controls across desktop and mobile viewports.

---

## Pull Request Process

1. **Fork and Branch**: Create a feature branch from `main` (`feature/your-feature-name` or `fix/your-bug-fix`).
2. **Atomic Commits**: Write clear, descriptive commit messages.
3. **Verify Tests**: Confirm `npm test` and `npm run build` pass cleanly.
4. **Open PR**: Submit your pull request against `main` with:
   - A concise summary of the change.
   - Why the change is necessary.
   - Any manual testing performed (browser, OS, device).

---

## Reporting Issues

- **Bug Reports**: Open an issue describing the expected vs actual behavior, steps to reproduce, browser/OS version, and any relevant console logs.
- **Feature Proposals**: Open a discussion issue detailing the motivation, architectural design, and scope before writing large pull requests.
- **Security Vulnerabilities**: Please review [SECURITY.md](SECURITY.md) for confidential disclosure instructions.
