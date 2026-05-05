#!/usr/bin/env bash
# Smoke test for /api/sync/cron. Hits the orchestrator with the
# CRON_SECRET, prints per-source result, exits.
#
# Usage:
#   CRON_SECRET=<from-vercel-env> ./scripts/test-cron-orchestrator.sh https://your-app.vercel.app
# Or for local dev (after `npm run dev`):
#   CRON_SECRET=<from-.env.local> ./scripts/test-cron-orchestrator.sh http://localhost:3000

set -euo pipefail

BASE="${1:?usage: $0 <base-url>}"
: "${CRON_SECRET:?CRON_SECRET env var required}"

curl -sS -X POST "$BASE/api/sync/cron" \
  -H "Authorization: Bearer $CRON_SECRET" \
  --max-time 300 \
  --write-out "\nHTTP %{http_code} (%{time_total}s)\n"
