// Shared e2e session helpers (Phase 22 cheap half). TWO distinct problems were conflated:
//   • the shared .auth/state.json single-use token → the deferred auth refactor (NOT here)
//   • ENOTFOUND / transient network failures resolving Supabase mid-run → THIS file
//
// closeContext()/closeBrowser() fix a THIRD, separate race — see the block above them.
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

// ── THE TEARDOWN RACE (Phase 22) — do not create the error, rather than catch it ─────────
//
// Many suites intercept a request, fetch it for real, mutate the body and fulfil — the
// `grantEdit` shape:  ctx.route(url, async (route) => { const res = await route.fetch(); … })
// When the context or browser closes while one of those `route.fetch()` calls is still in
// flight, it rejects with `route.fetch: Request context disposed.` Nothing awaits it, so it
// lands in installHarnessGuard's unhandledRejection handler and kills a suite that had
// already passed every assertion. Measured on verify-log-health: "6 passed, 0 failed",
// then exit 2.
//
// The fix is NOT to classify the error in OUR guard after the fact. We unroute first, so
// Playwright disposes the handlers at the route layer and the rejection never reaches this
// process. Proven in isolation (scripts/e2e/verify-teardown-guard.mjs): the same handler shape
// produces `route.fetch: Request context disposed.` without this and NOTHING with it.
//
// WHY `ignoreErrors` AND NOT `wait`. `wait` is the stronger-sounding option — it blocks until
// in-flight handlers finish — and it was tried first. It HANGS: verify-promos has a handler that
// sleeps 2.5s by design, and teardown sat on it indefinitely (killed at 2m31s, against a 28s
// normal runtime), which would surface as a suite TIMEOUT — a worse failure than the one being
// fixed. `wait` also PROPAGATES handler errors, so it turned a pre-existing unawaited
// `route.fulfill` in verify-promos into a fresh exit-2. `ignoreErrors` unroutes without blocking
// and lets Playwright swallow errors thrown by handlers after unrouting, which is exactly this
// class and nothing else.
//
// This matters because the alternative — swallowing disposal errors in OUR guard — would also
// swallow a real failure that happens during teardown, which is the silence this harness exists
// to prevent. The guard below stays STRICT: every unhandled rejection reaching this process is
// still fatal, including one whose text mentions disposal. verify-teardown-guard.mjs asserts
// both halves.
export async function closeContext(ctx) {
  try { await ctx.unrouteAll({ behavior: "ignoreErrors" }); } catch { /* already closing/closed */ }
  await ctx.close();
}

export async function closeBrowser(browser) {
  for (const ctx of browser.contexts()) {
    try { await ctx.unrouteAll({ behavior: "ignoreErrors" }); } catch { /* already closing/closed */ }
  }
  await browser.close();
}

let installed = false;
export function installHarnessGuard() {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", fatal);
  process.on("uncaughtException", fatal);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE KEYED SESSION CACHE — 33 magic links per gate run down to 2 cold, 0 warm.
//
// THE PROBLEM. Every gated suite inlined its own admin.generateLink('magiclink') + verifyOtp — 33
// links per gate run, each a full round trip to GoTrue, to produce sessions for TWO identities.
//
// CORRECTION TO AN EARLIER NOTE HERE: this file previously said the ceiling was Supabase's
// built-in 2/hour/project. THAT LIMIT NEVER APPLIED — the project has had custom SMTP configured
// (SendGrid, smtp.sendgrid.net:587, sender info@playmatchday.com) all along, which supersedes it.
// The tail-of-run failures in push 18 ("Cannot read properties of null (reading 'hashed_token')")
// coincided with a GoTrue OUTAGE — /auth/v1/health returned 522 for ~20s on every sample while
// PostgREST answered in 90ms — so generateLink was failing because the auth service was
// unreachable, not because a quota was exhausted.
//
// 33 round trips to mint 2 sessions is still waste worth removing, and it makes the suite immune
// to exactly that kind of transient: one mint per identity, reused for 45 minutes.
//
// WHY NOT signInWithPassword. scripts/e2e/auth.mjs uses the password grant, which never touches
// the email quota — but it authenticates as E2E_EMAIL (clubhouse-e2e@playmatchday.com), and we
// hold a password for that account and no other. The 32 admin suites run as
// rmancuso@playmatchday.com because they need full admin, and the e2e service account is
// DELIBERATELY blocked at the database keyed on email. Repointing them would make them pass, or
// fail, as somebody else. So this takes the CACHING half of auth.mjs and leaves the password half.
//
// KEYED BY IDENTITY, NEVER SHARED. verify-city-confinement drives a real city manager, and every
// refusal probe needs a non-admin. One entry per email; the caller must NAME the identity, there
// is no default, and nothing inherits a session it did not ask for. A cached admin session
// reaching a refusal probe is how a pay-arrival probe once became a real production write.
//
// ON DISK: .auth/sessions/<email>.json, mode 0600, and .auth/ is already gitignored. These are
// bearer tokens — never logged, never printed; the filename is the only thing naming them.

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const SESSION_DIR = ".auth/sessions";
// Supabase access tokens live ~1h. 45 minutes leaves room for a long run to finish on a session it
// picked up near the end of the window.
const TTL_MS = 45 * 60 * 1000;

const cachePath = (email) => `${SESSION_DIR}/${email.replace(/[^a-z0-9]+/gi, "_")}.json`;

function readCached(email) {
  const p = cachePath(email);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    // The stored email must match: a mismatched file is a session for someone else, which is the
    // one failure this cache must never produce.
    if (!raw?.session?.access_token || raw.email !== email) return null;
    if (Date.now() - raw.mintedAt > TTL_MS) return null;
    // expires_at is seconds since epoch. A token expiring inside five minutes is no use to a suite
    // about to run for three.
    const exp = Number(raw.session.expires_at ?? 0) * 1000;
    if (exp && exp - Date.now() < 5 * 60 * 1000) return null;
    return raw.session;
  } catch {
    return null;
  }
}

// DOES THIS TOKEN STILL WORK? Age is not the question.
//
// THE BUG THIS ENDS. readCached() decided a session was good from the TTL and the token's own
// expires_at claim — both read off the local file. But minting a session for an identity REVOKES
// the previous one, so a token minted eight minutes ago and killed two minutes ago still looks
// perfect on disk. When the pre-push hook ran the gate straight after a local run, it picked up
// exactly such a token and every assertion came back 401 "Invalid session" instead of the 403 it
// was testing for — fifty assertions downstream of the real cause. That fired four times in one
// day, each costing a full nine-minute gate run.
//
// ONE CALL, PER IDENTITY, PER RUN. sessionFor() is called once per identity in a suite, so this
// adds one round trip to a run that lasts minutes. It is NOT a retry loop and NOT a poller: a
// monitor polling auth locked production out earlier today, and this must never become that.
async function stillValid(session) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) return false;
  try {
    // The cheapest authenticated call there is, and the same one the server gates read through:
    // adminAuth/resolveSessionUser both verify with getUser(token).
    const client = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(session.access_token);
    return !error && !!data?.user?.email;
  } catch {
    // A network blip is not proof the token is dead — but reusing it would risk the 401 cascade
    // this function exists to prevent, so treat it as unusable and mint.
    return false;
  }
}

// A SESSION FOR A NAMED IDENTITY. Reuses the cached one while it is good; mints exactly one magic
// link when it is not.
export async function sessionFor(email) {
  if (!email || typeof email !== "string") {
    throw new Error("sessionFor(email): name the identity explicitly — there is no default");
  }
  const cached = readCached(email);
  // VALIDATED, NOT ASSUMED. If the server no longer honours it, fall through and mint.
  if (cached && await stillValid(cached)) return cached;
  if (cached) console.log(`  ↻ cached session for ${email} was rejected by the server — minting a fresh one`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email }), `generateLink ${email}`);
  const hashed = link?.data?.properties?.hashed_token;
  if (!hashed) {
    // NAME THE QUOTA. This used to surface as "Cannot read properties of null", which sent an
    // investigation through the dev server, a clean .next and three unrelated commits before
    // anyone counted links.
    // NAME WHAT IT USUALLY IS. This surfaced as "Cannot read properties of null", which sent an
    // investigation through the dev server, a clean .next and three unrelated commits. Check
    // /auth/v1/health first: a 522 there means GoTrue is unreachable and nothing is wrong here.
    throw new Error(
      `Supabase returned no magic link for ${email}. Check GET /auth/v1/health — a 522 means the ` +
      `auth service is down, which is the usual cause and is not a code failure. A rate limit ` +
      `would return 429 with a JSON body instead.`,
    );
  }
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: hashed }), `verifyOtp ${email}`);
  const session = vv?.data?.session;
  // FAIL LOUDLY, HERE, NAMING THE IDENTITY. The alternative is what used to happen: a null session
  // handed to a suite, which then reports 401 on an assertion fifty lines away that has nothing to
  // do with auth. The identity and the status are the two facts needed to act on this.
  if (!session) {
    const st = vv?.error?.status ?? "no status";
    const msg = vv?.error?.message ?? "no session and no error";
    throw new Error(
      `Could not mint a session for ${email} — verifyOtp returned ${st}: ${msg}. ` +
      `The magic link was issued, so this is the exchange failing, not the link. ` +
      `If the account was deleted, that is the cause: its auth record can outlive its app_users row.`,
    );
  }

  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(cachePath(email), JSON.stringify({ email, mintedAt: Date.now(), session }), { mode: 0o600 });
  } catch { /* a cache we cannot write is a slower run, not a broken one */ }
  return session;
}

// The Playwright storageState for a NAMED identity — the shape every suite was building by hand.
// Returns the session and token too, so a suite that also calls routes directly does not re-mint.
export async function storageStateFor(email, base) {
  const session = await sessionFor(email);
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  return {
    storageState: {
      cookies: [],
      origins: [{ origin: base, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }],
    },
    session,
    token: session.access_token,
  };
}

/* ── D2. THE EMPTINESS GUARD ───────────────────────────────────────────────────────────────────
 * ANY ASSERTION OVER A FILTERED COLLECTION PASSES TRIVIALLY WHEN THE COLLECTION IS EMPTY.
 * `is("no row overlaps", rows.filter(bad).map(id), [])` is green when `rows` is empty, when the
 * selector changed, when the page failed to render, and when the field being filtered on is
 * undefined. All four look identical to a passing test.
 *
 * MEASURED 2026-09-02: 27 assertion sites across 10 browser suites were in that shape. One of them
 * had been green for a round while testing nothing, because `r.hasMin` was never set and
 * `undefined && x` is always false.
 *
 * Route the collection through this before asserting on it. It throws on empty with a message
 * naming what was expected to be there, so an empty set fails LOUDLY.
 *
 *     is("no row overlaps", nonEmpty(rows, "rows on the board").filter(bad).map(id), []);
 */
export function nonEmpty(coll, label) {
  const n = Array.isArray(coll) ? coll.length : (coll?.length ?? (coll?.size ?? -1));
  if (n === -1) throw new Error(`nonEmpty(${label}): not a collection — got ${typeof coll}`);
  if (n === 0) {
    throw new Error(
      `EMPTY COLLECTION: expected at least one ${label}, found none. ` +
      `An assertion over an empty set passes without testing anything, so this fails instead. ` +
      `Either the page did not render, the selector is wrong, or the field being filtered on is undefined.`,
    );
  }
  return coll;
}
