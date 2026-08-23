// Authenticated screenshot + assertion runner. Node-only.
//
//   node scripts/e2e/shot.mjs                 # all routes
//   node scripts/e2e/shot.mjs /lifecycle /home   # specific routes
//
// Uses .auth/state.json (run auth.mjs first). Launches chromium at
// PW_CHROMIUM_PATH (default /opt/pw-browsers/chromium — set the env var to a
// local build to run outside the CI image). Never runs `playwright install`.
// For each route: navigate, wait for data to land (networkidle + a real content
// selector, never a bare timeout), screenshot full page at 1500px, then measure
// contrast (checks.mjs) and page overflow at 1600px. Prints a summary table.

import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { contrast, overflow, warmBg } from "./checks.mjs";

try { process.loadEnvFile(".env.local"); } catch { /* ok */ }

const BASE = process.env.E2E_BASE_URL || "https://matchday-clubhouse.vercel.app";
const EXEC = process.env.PW_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const OUT_DIR = ".e2e-out";

const ALL_ROUTES = [
  "/home", "/lifecycle", "/membership", "/data", "/docs", "/tech", "/tech/tech-roadmap",
  "/admin/finance", "/sms-log", "/inventory",
  "/growth/field-pipeline",
  "/match-ops", "/match-ops/field-ops", "/match-ops/inventory",
  "/match-ops/manager-pay", "/match-ops/master-schedule", "/match-ops/match-chats",
  "/match-ops/match-chats/automation", "/match-ops/partner-dashboards", "/match-ops/player-chats",
  "/match-ops/reviews", "/match-ops/slate-review",
];

const routes = process.argv.slice(2).length ? process.argv.slice(2) : ALL_ROUTES;

if (!existsSync(".auth/state.json")) {
  console.error("Missing .auth/state.json — run: node scripts/e2e/auth.mjs");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const CONTENT = 'h1, h2, table, [class*="card"], [class*="kpi"], [class*="funnel"], [class*="dash"], main';
const fileFor = (r) => (r.replace(/^\//, "").replace(/\//g, "_") || "root") + ".png";

const browser = await chromium.launch({ executablePath: EXEC, headless: true });
const context = await browser.newContext({ storageState: ".auth/state.json", viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();

const results = [];
for (const route of routes) {
  const res = { route, status: "", min: null, owner: "", failures: 0, pageLeak: null, scrollers: 0 };
  try {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    const path = new URL(page.url()).pathname;
    if (path.startsWith("/login")) { res.status = "AUTH-FAIL (login redirect)"; results.push(res); continue; }
    if (path.startsWith("/no-access")) { res.status = "NO-ACCESS"; results.push(res); continue; }
    await page.waitForSelector(CONTENT, { timeout: 15000 }).catch(() => {});

    await page.screenshot({ path: `${OUT_DIR}/${fileFor(route)}`, fullPage: true });

    const c = await contrast(page);
    res.min = c.min;
    res.owner = c.minNode ? `${c.minNode.tag}.${c.minNode.cls} “${c.minNode.text}”` : "";
    res.failures = c.failures.length;
    res._failures = c.failures.slice(0, 60);

    await page.setViewportSize({ width: 1600, height: 1000 });
    const o = await overflow(page);
    res.pageLeak = o.pageLeak;
    res.scrollers = o.offenders.length;
    res._offenders = o.offenders;
    res._warmBg = await warmBg(page);
    res.status = "ok";
  } catch (e) {
    res.status = "ERR: " + (e.message || "").slice(0, 60);
  }
  results.push(res);
  console.log(`  ${route}  →  ${res.status}  min ${res.min ?? "—"}  leak ${res.pageLeak ?? "—"}`);
}

await browser.close();

// summary table
console.log("\n=== SUMMARY ===");
console.log("route".padEnd(38), "min".padEnd(7), "leak".padEnd(6), "owner");
for (const r of results) {
  console.log(
    r.route.padEnd(38),
    String(r.min ?? r.status).padEnd(7),
    String(r.pageLeak ?? "").padEnd(6),
    (r.owner || r.status).slice(0, 80),
  );
}
// distinct warm backgrounds across all routes (should be only meaningful ones)
const warm = new Map();
for (const r of results) for (const w of r._warmBg || []) if (!warm.has(w.rgb)) warm.set(w.rgb, w.cls);
console.log("\n=== distinct warm computed backgrounds (expect only gold/city/error) ===");
for (const [rgb, cls] of warm) {
  const [r, g, b] = rgb.split(",").map(Number);
  const hex = "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
  console.log(`  rgb(${rgb}) ${hex}  ${cls}`);
}

// print detailed failures for /lifecycle if present
const g = results.find((r) => r.route === "/lifecycle");
if (g?._failures?.length) {
  console.log("\n/lifecycle contrast failures (<4.5):");
  for (const f of g._failures) console.log(`  ${f.ratio}  ${f.tag}.${f.cls}  “${f.text}”`);
} else if (g) {
  console.log(`\n/lifecycle: no contrast failures <4.5; page min ${g.min} owned by ${g.owner}`);
}
