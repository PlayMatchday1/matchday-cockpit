// Shared e2e session helpers (Phase 22 cheap half). TWO distinct problems were conflated:
//   • the shared .auth/state.json single-use token → the deferred auth refactor (NOT here)
//   • ENOTFOUND / transient network failures resolving Supabase mid-run → THIS file
//
// netRetry() gives the READ-ONLY test-setup calls (magic-link generation, OTP verification — never
// a MatchDay write) a bounded retry with backoff: 3 attempts, then a clean give-up. installHarnessGuard()
// makes a suite never die on an unhandled rejection, and makes a network death print METHOD + URL PATH
// + STATUS only — never headers, never bodies (a prior crash dumped a Bearer token from the request
// headers). It also gives a network give-up a distinct exit code (3) so the gate can tell
// "network, retried 3×, gave up" from an assertion failure (1) or a Playwright timeout (2).

const NET_RE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EPIPE|socket hang up|network|fetch failed|Failed to fetch|und_err|getaddrinfo/i;

export function isNetworkError(e) {
  if (!e) return false;
  const code = e.code || e.errno || e.cause?.code || "";
  const msg = (e.message || String(e)) + " " + (e.cause?.message || "");
  return NET_RE.test(String(code)) || NET_RE.test(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e) => e?.code || e?.cause?.code || (e?.message || String(e)).split("\n")[0].slice(0, 80);

// Retry a READ-ONLY setup call on network failure only. `fn` may throw OR (Supabase style) resolve
// to { data, error } — a network `error` is treated as retryable. Non-network errors pass straight
// through (no retry). After `attempts`, throws a tagged give-up error.
export async function netRetry(fn, label, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fn();
      if (res && res.error && isNetworkError(res.error)) { last = res.error; }
      else return res; // success, or a non-network {error} the caller will handle
    } catch (e) {
      if (!isNetworkError(e)) throw e; // a real error is not a network flake — surface it
      last = e;
    }
    if (i < attempts) {
      console.log(`  ↻ network retry ${i}/${attempts} on ${label}: ${codeOf(last)}`);
      await sleep(300 * 3 ** (i - 1)); // 300ms, 900ms
    }
  }
  const err = new Error(`network, retried ${attempts}×, gave up on ${label}: ${codeOf(last)}`);
  err.isNetworkGiveUp = true;
  err.label = label;
  throw err;
}

// method + URL PATH + status ONLY — never headers, never bodies.
function sanitize(e) {
  if (!e) return "unknown";
  const parts = [];
  const method = e.method || e.config?.method || e.request?.method;
  if (method) parts.push(String(method).toUpperCase());
  const url = e.url || e.config?.url || e.request?.url;
  if (url) { try { parts.push(new URL(url).pathname); } catch { /* not a URL — omit */ } }
  const status = e.status ?? e.statusCode ?? e.config?.status;
  if (status != null) parts.push(`status ${status}`);
  const msg = (e.message || String(e)).split("\n")[0].slice(0, 200);
  return parts.length ? `${parts.join(" ")} — ${msg}` : msg;
}

// The single sanitized exit path. A network give-up (exit 3) is distinct from a network death
// mid-run (3), which is distinct from any other harness fault (2) — and none of them prints the raw
// error object (which for a Supabase fetch failure carries request headers, i.e. a Bearer token).
// The suite's own `main().catch(fatal)` routes here; installHarnessGuard() also routes here for any
// stray unhandled rejection so a suite never dies on one with an unsanitized default dump.
export function fatal(e) {
  if (e && e.isNetworkGiveUp) {
    console.error(`HARNESS ERROR — network, retried 3×, gave up: ${e.label} — ${(e.message || "").split("\n")[0]}`);
    process.exit(3); // distinct from assertion (1) / other harness fault (2)
  }
  if (isNetworkError(e)) {
    console.error(`HARNESS ERROR — network: ${sanitize(e)}`);
    process.exit(3);
  }
  console.error(`HARNESS ERROR: ${sanitize(e)}`);
  process.exit(2);
}

let installed = false;
export function installHarnessGuard() {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", fatal);
  process.on("uncaughtException", fatal);
}
