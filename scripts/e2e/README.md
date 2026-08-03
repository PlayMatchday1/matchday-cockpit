# E2E auth harness (test infra only — not imported by the app)

Drives authenticated Clubhouse routes headlessly. One-time: `node scripts/e2e/setup-user.mjs` creates a read-only automation identity and writes `E2E_EMAIL`/`E2E_PASSWORD` to `.env.local` (gitignored).

Run: `node scripts/e2e/auth.mjs` (mints `.auth/state.json`), then `node scripts/e2e/shot.mjs [routes…]` — screenshots to `.e2e-out/` and prints per-route lowest contrast (`checks.mjs`) + overflow at 1600px. Chromium path defaults to `/opt/pw-browsers/chromium`; override with `PW_CHROMIUM_PATH` and target with `E2E_BASE_URL`. Never run `playwright install`.
