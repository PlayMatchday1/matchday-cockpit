// Phase 0.5 probe — read-only investigation of MatchDay's GET /admin/players.
// Confirms whether totalItems exceeds the ~4,144 played-1+ cohort
// (the "registered but never played" delta is the whole point), and
// reports preferableCity shape so we know what to map before any
// sync writes a city column.
//
// Run with: npx tsx scripts/probe-admin-players.ts
// Reads MATCHDAY_API_* + SUPABASE_* from .env.local. No commit if
// the script ever hardcodes creds. Process.env only.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Load .env.local manually — tsx outside of Next doesn't read it.
const envText = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const API_EMAIL = process.env.MATCHDAY_API_EMAIL;
const API_PASSWORD = process.env.MATCHDAY_API_PASSWORD;
const API_BASE = process.env.MATCHDAY_API_BASE_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!API_EMAIL || !API_PASSWORD || !API_BASE) {
  console.error("Missing MATCHDAY_API_* env vars.");
  process.exit(1);
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_* env vars.");
  process.exit(1);
}

type Player = {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: string | null;
  completedSignUpAt: string | null;
  isFakePlayer: boolean | null;
  isMember: boolean | null;
  preferableCity: { name?: string | null } | null;
};

type AdminPlayersResp = {
  page: number;
  limit: number;
  totalItems: number;
  data: Player[];
};

async function signIn(path: string): Promise<string> {
  const url = new URL(path, API_BASE).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: API_EMAIL, password: API_PASSWORD }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Sign-in via ${path} failed: HTTP ${res.status} — ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const token =
    (typeof json.accessToken === "string" && json.accessToken) ||
    (typeof json.access_token === "string" && json.access_token) ||
    (json.data &&
      typeof (json.data as Record<string, unknown>).accessToken ===
        "string" &&
      ((json.data as Record<string, unknown>).accessToken as string)) ||
    null;
  if (!token) {
    throw new Error(
      `Sign-in succeeded but no accessToken in response. Top-level keys: ${Object.keys(json).join(", ")}`,
    );
  }
  return token;
}

// Try /auth/signin first (matches existing matchdayApi.ts). If that
// token gets rejected by /admin/players, fall back to /auth/signin/admin.
async function getToken(): Promise<{ token: string; via: string }> {
  try {
    const t = await signIn("/auth/signin");
    return { token: t, via: "/auth/signin" };
  } catch (e) {
    console.log(`  /auth/signin failed: ${(e as Error).message}`);
    const t = await signIn("/auth/signin/admin");
    return { token: t, via: "/auth/signin/admin" };
  }
}

async function fetchPlayers(
  token: string,
  query: Record<string, string | number>,
): Promise<{ status: number; body: AdminPlayersResp | unknown }> {
  const url = new URL("/admin/players", API_BASE);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function fmtRow(p: Player) {
  return {
    id: p.id,
    email: p.email,
    createdAt: p.createdAt?.slice(0, 19),
    completedSignUpAt: p.completedSignUpAt?.slice(0, 19) ?? null,
    isFakePlayer: p.isFakePlayer,
    isMember: p.isMember,
    preferableCity_name: p.preferableCity?.name ?? null,
  };
}

(async () => {
  console.log("=== Phase 0.5 probe — GET /admin/players ===\n");

  // --- 1. auth + smoke test (limit=1)
  console.log("1. Authenticate + smoke test (page=1, limit=1)");
  const { token, via } = await getToken();
  console.log(`   token via: ${via}`);

  const smoke = await fetchPlayers(token, { page: 1, limit: 1 });
  console.log(`   HTTP ${smoke.status}`);
  if (smoke.status !== 200) {
    console.error("   body:", JSON.stringify(smoke.body, null, 2).slice(0, 500));
    process.exit(1);
  }
  const smokeBody = smoke.body as AdminPlayersResp;
  const totalItems = smokeBody.totalItems;
  console.log(`   totalItems: ${totalItems}`);
  console.log(
    `   data[0] keys: ${Object.keys(smokeBody.data?.[0] ?? {}).join(", ")}`,
  );

  // --- 2. newest 10
  console.log(
    "\n2. Newest 10 — sortColumn=createdAt&sortDirection=desc",
  );
  const newest = await fetchPlayers(token, {
    page: 1,
    limit: 10,
    sortColumn: "createdAt",
    sortDirection: "desc",
  });
  console.log(`   HTTP ${newest.status}`);
  const newestRows = (newest.body as AdminPlayersResp).data ?? [];
  console.table(newestRows.map(fmtRow));
  // Sort sanity: each createdAt should be >= the next
  let descOK = true;
  for (let i = 1; i < newestRows.length; i++) {
    if (
      (newestRows[i - 1].createdAt ?? "") <
      (newestRows[i].createdAt ?? "")
    ) {
      descOK = false;
      break;
    }
  }
  console.log(`   sort desc honored: ${descOK ? "YES" : "NO"}`);

  // --- 3. oldest 10
  console.log("\n3. Oldest 10 — sortColumn=createdAt&sortDirection=asc");
  const oldest = await fetchPlayers(token, {
    page: 1,
    limit: 10,
    sortColumn: "createdAt",
    sortDirection: "asc",
  });
  console.log(`   HTTP ${oldest.status}`);
  const oldestRows = (oldest.body as AdminPlayersResp).data ?? [];
  console.table(oldestRows.map(fmtRow));
  let ascOK = true;
  for (let i = 1; i < oldestRows.length; i++) {
    if (
      (oldestRows[i - 1].createdAt ?? "") >
      (oldestRows[i].createdAt ?? "")
    ) {
      ascOK = false;
      break;
    }
  }
  console.log(`   sort asc honored: ${ascOK ? "YES" : "NO"}`);

  // --- 4. cohort comparison
  console.log("\n4. Compare totalItems vs distinct user_id in mdapi_match_players");
  const sb = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const PAGE = 1000;
  let offset = 0;
  const distinctNonFake = new Set<number>();
  const distinctNonCancelled = new Set<number>();
  while (true) {
    const { data, error } = await sb
      .from("mdapi_match_players")
      .select("user_id, user_is_fake_player, is_cancelled")
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.log(`   Supabase error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (!r.user_id) continue;
      if (!r.user_is_fake_player) distinctNonFake.add(r.user_id);
      if (!r.user_is_fake_player && !r.is_cancelled)
        distinctNonCancelled.add(r.user_id);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`   distinct non-fake user_ids in match_players: ${distinctNonFake.size}`);
  console.log(`   distinct non-fake non-cancelled: ${distinctNonCancelled.size}`);
  console.log(`   /admin/players totalItems: ${totalItems}`);
  const delta = totalItems - distinctNonFake.size;
  console.log(
    `   delta (registered but never played): ${delta} (~${((delta / totalItems) * 100).toFixed(1)}% of registered)`,
  );

  // --- 5. preferableCity distribution + null rates (page=1, limit=50)
  console.log(
    "\n5. preferableCity.name distribution + null rates (page=1, limit=50)",
  );
  const sample = await fetchPlayers(token, { page: 1, limit: 50 });
  console.log(`   HTTP ${sample.status}`);
  const sampleRows = (sample.body as AdminPlayersResp).data ?? [];
  console.log(`   sample size: ${sampleRows.length}`);

  const cityCounts = new Map<string, number>();
  let nullCity = 0;
  let nullCompletedSignUp = 0;
  let isFakeCount = 0;
  let isMemberCount = 0;
  for (const p of sampleRows) {
    const cityName = p.preferableCity?.name ?? null;
    if (cityName === null) nullCity += 1;
    else cityCounts.set(cityName, (cityCounts.get(cityName) ?? 0) + 1);
    if (p.completedSignUpAt === null || p.completedSignUpAt === undefined)
      nullCompletedSignUp += 1;
    if (p.isFakePlayer === true) isFakeCount += 1;
    if (p.isMember === true) isMemberCount += 1;
  }
  console.log("   preferableCity.name counts:");
  console.table(
    [...cityCounts.entries()]
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count),
  );
  console.log("   flag rates:");
  console.table([
    {
      metric: "preferableCity = null",
      count: nullCity,
      pct: `${((nullCity / sampleRows.length) * 100).toFixed(0)}%`,
    },
    {
      metric: "completedSignUpAt = null",
      count: nullCompletedSignUp,
      pct: `${((nullCompletedSignUp / sampleRows.length) * 100).toFixed(0)}%`,
    },
    {
      metric: "isFakePlayer = true",
      count: isFakeCount,
      pct: `${((isFakeCount / sampleRows.length) * 100).toFixed(0)}%`,
    },
    {
      metric: "isMember = true",
      count: isMemberCount,
      pct: `${((isMemberCount / sampleRows.length) * 100).toFixed(0)}%`,
    },
  ]);

  // --- 6. Markdown summary
  console.log("\n\n=== REPORT (markdown) ===\n");
  console.log(
    `## Total registered users: ${totalItems} (vs ${distinctNonFake.size} distinct match_players)\n`,
  );
  console.log(`Delta (registered but never played): **${delta}** (${((delta / Math.max(1, totalItems)) * 100).toFixed(1)}% of registered).\n`);

  console.log("## Newest 10 users\n");
  console.log("| id | email | createdAt | completedSignUpAt | isFakePlayer | isMember | preferableCity |");
  console.log("|---|---|---|---|---|---|---|");
  for (const p of newestRows) {
    const r = fmtRow(p);
    console.log(
      `| ${r.id} | ${r.email ?? ""} | ${r.createdAt ?? ""} | ${r.completedSignUpAt ?? ""} | ${r.isFakePlayer} | ${r.isMember} | ${r.preferableCity_name ?? ""} |`,
    );
  }

  console.log("\n## Oldest 10 users\n");
  console.log("| id | email | createdAt | completedSignUpAt | isFakePlayer | isMember | preferableCity |");
  console.log("|---|---|---|---|---|---|---|");
  for (const p of oldestRows) {
    const r = fmtRow(p);
    console.log(
      `| ${r.id} | ${r.email ?? ""} | ${r.createdAt ?? ""} | ${r.completedSignUpAt ?? ""} | ${r.isFakePlayer} | ${r.isMember} | ${r.preferableCity_name ?? ""} |`,
    );
  }

  console.log("\n## preferableCity.name distribution (50-row sample)\n");
  console.log("| city | count |");
  console.log("|---|---|");
  for (const [city, count] of [...cityCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`| ${city} | ${count} |`);
  }
  if (nullCity > 0) console.log(`| (null) | ${nullCity} |`);

  console.log("\n## Null/flag rates (50-row sample)\n");
  console.log("| metric | count | pct |");
  console.log("|---|---|---|");
  console.log(
    `| preferableCity = null | ${nullCity} | ${((nullCity / sampleRows.length) * 100).toFixed(0)}% |`,
  );
  console.log(
    `| completedSignUpAt = null | ${nullCompletedSignUp} | ${((nullCompletedSignUp / sampleRows.length) * 100).toFixed(0)}% |`,
  );
  console.log(
    `| isFakePlayer = true | ${isFakeCount} | ${((isFakeCount / sampleRows.length) * 100).toFixed(0)}% |`,
  );
  console.log(
    `| isMember = true | ${isMemberCount} | ${((isMemberCount / sampleRows.length) * 100).toFixed(0)}% |`,
  );

  console.log("\n## Recommended next step\n");
  if (totalItems <= distinctNonFake.size) {
    console.log(
      "**STOP** — totalItems is not larger than the played cohort. Investigate before designing a sync.",
    );
  } else if (descOK && ascOK) {
    console.log(
      "Proceed to full sync design. Pagination + sort honored, totalItems materially exceeds the played cohort, response shape is stable.",
    );
  } else {
    console.log(
      "Proceed cautiously — pagination works but sort honored only one direction. Sync design should not assume sortColumn=createdAt is reliable.",
    );
  }
})();
