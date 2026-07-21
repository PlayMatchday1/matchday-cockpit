// Reconciliation: enumerate every Dallas June 2026 FREE spot and show
// exactly which filter or membership decision each one lands in.
//
// Answers "manual count says 29, corrected denominator says 21 — which
// 8 rows differ and why". Walks the funnel one stage at a time against
// raw mdapi rows, then prints the surviving rows individually with the
// subscription evidence behind each MEMBER / FREE_NON_MEMBER call.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { selectAll } from "../src/lib/supabasePagination";
import { isFakePlayerRow } from "../src/lib/mdapiFakePlayer";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const rd = (n: string) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
};
const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const FROM = "2026-06-01";
const TO = "2026-07-01";

type Match = {
  api_id: number;
  city_identifier: string | null;
  field_id: number | null;
  field_title: string | null;
  start_date: string;
  is_cancelled: boolean | null;
};
type Player = {
  api_id: number;
  match_api_id: number;
  user_id: number | null;
  user_email: string | null;
  user_type: string | null;
  paid_status: string | null;
  user_is_fake_player: boolean | null;
  is_absent: boolean | null;
  canceled_at: string | null;
};
type Sub = {
  membership_id: number;
  user_id: number | null;
  member_email: string | null;
  status: string | null;
  activation_date: string | null;
  canceled_at: string | null;
};

const matches = await selectAll<Match>(() =>
  sb
    .from("mdapi_matches")
    .select("api_id, city_identifier, field_id, field_title, start_date, is_cancelled")
    .gte("start_date", FROM)
    .lt("start_date", TO)
    .order("api_id"),
);
const dfw = matches.filter((m) => m.city_identifier === "DFW");
const byMatch = new Map(dfw.map((m) => [m.api_id, m]));

const ids = dfw.map((m) => m.api_id);
const players: Player[] = [];
for (let i = 0; i < ids.length; i += 200) {
  const { data, error } = await sb
    .from("mdapi_match_players")
    .select(
      "api_id, match_api_id, user_id, user_email, user_type, paid_status, user_is_fake_player, is_absent, canceled_at",
    )
    .in("match_api_id", ids.slice(i, i + 200));
  if (error) throw new Error(error.message);
  players.push(...(data as Player[]));
}

const subs = await selectAll<Sub>(() =>
  sb
    .from("mdapi_subscriptions")
    .select("membership_id, user_id, member_email, status, activation_date, canceled_at")
    .order("membership_id"),
);
const subsByUser = new Map<string, Sub[]>();
for (const s of subs) {
  const k = String(s.user_id ?? "");
  if (!k) continue;
  const list = subsByUser.get(k) ?? [];
  list.push(s);
  subsByUser.set(k, list);
}

const vfRows = await selectAll<Record<string, unknown>>(() =>
  sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id").order("mdapi_field_id"),
);
const venueFields = new Map<number, number>();
for (const f of vfRows) venueFields.set(Number(f.mdapi_field_id), Number(f.fin_venue_id));

// ---- Funnel ----
const step: { label: string; n: number }[] = [];
let cur = players.filter((p) => p.paid_status === "FREE");
step.push({ label: "FREE rows, Dallas, June (raw)", n: cur.length });

cur = cur.filter((p) => !isFakePlayerRow({ user_is_fake_player: p.user_is_fake_player, user_email: p.user_email }));
step.push({ label: "  − fake players (isFakePlayerRow)", n: cur.length });

cur = cur.filter((p) => p.is_absent !== true);
step.push({ label: "  − is_absent", n: cur.length });

cur = cur.filter((p) => p.user_type !== "GUEST");
step.push({ label: "  − user_type GUEST", n: cur.length });

cur = cur.filter((p) => !byMatch.get(p.match_api_id)?.is_cancelled);
step.push({ label: "  − cancelled matches", n: cur.length });

const afterMatchCancel = cur;
cur = cur.filter((p) => !(p.canceled_at && p.canceled_at.trim() !== ""));
step.push({ label: "  − player canceled_at", n: cur.length });

cur = cur.filter((p) => {
  const fid = byMatch.get(p.match_api_id)?.field_id;
  return fid != null && venueFields.has(fid);
});
step.push({ label: "  − unresolvable field_id → venue", n: cur.length });

console.log("Dallas June 2026 funnel\n");
for (const s of step) console.log(`${s.label.padEnd(42)} ${String(s.n).padStart(5)}`);

// ---- Membership decision on survivors ----
function coveringSub(userId: number | null, matchIso: string): Sub | null {
  const list = subsByUser.get(String(userId ?? ""));
  if (!list) return null;
  const ms = Date.parse(matchIso);
  for (const s of list) {
    if (!s.activation_date) continue;
    const act = Date.parse(s.activation_date);
    if (!Number.isFinite(act) || act > ms) continue;
    if (s.canceled_at) {
      const can = Date.parse(s.canceled_at);
      if (Number.isFinite(can) && can <= ms) continue;
    }
    return s;
  }
  return null;
}

const members: Player[] = [];
const nonMembers: Player[] = [];
for (const p of cur) {
  const m = byMatch.get(p.match_api_id)!;
  (coveringSub(p.user_id, m.start_date) ? members : nonMembers).push(p);
}

console.log(
  `\nmembership split of the ${cur.length} survivors: MEMBER ${members.length} / FREE_NON_MEMBER ${nonMembers.length}\n`,
);

const fmt = (iso: string) => iso.slice(0, 16).replace("T", " ");
console.log("--- counted as MEMBER spots (the denominator) ---");
for (const p of members) {
  const m = byMatch.get(p.match_api_id)!;
  const s = coveringSub(p.user_id, m.start_date)!;
  console.log(
    `${fmt(m.start_date)}  ${(m.field_title ?? "").slice(0, 22).padEnd(22)} uid=${String(p.user_id).padEnd(6)} ${(p.user_email ?? "").slice(0, 30).padEnd(30)} sub#${String(s.membership_id).padEnd(6)} ${s.status} act=${(s.activation_date ?? "").slice(0, 10)} can=${(s.canceled_at ?? "—").slice(0, 10)}`,
  );
}

console.log("\n--- FREE but NOT a member at match time (excluded) ---");
for (const p of nonMembers) {
  const m = byMatch.get(p.match_api_id)!;
  const list = subsByUser.get(String(p.user_id ?? "")) ?? [];
  let why: string;
  if (list.length === 0) {
    why = "no subscription record at all";
  } else {
    const ms = Date.parse(m.start_date);
    const parts = list.map((s) => {
      const act = Date.parse(s.activation_date ?? "");
      if (Number.isFinite(act) && act > ms) return `sub#${s.membership_id} activated AFTER match (${(s.activation_date ?? "").slice(0, 10)})`;
      const can = s.canceled_at ? Date.parse(s.canceled_at) : NaN;
      if (Number.isFinite(can) && can <= ms) return `sub#${s.membership_id} canceled BEFORE match (${(s.canceled_at ?? "").slice(0, 10)})`;
      return `sub#${s.membership_id} ${s.status} (unclassified)`;
    });
    why = parts.join("; ");
  }
  console.log(
    `${fmt(m.start_date)}  ${(m.field_title ?? "").slice(0, 22).padEnd(22)} uid=${String(p.user_id).padEnd(6)} ${(p.user_email ?? "").slice(0, 30).padEnd(30)} → ${why}`,
  );
}

// Rows dropped only by the player-cancel / venue steps, for completeness.
const droppedLate = afterMatchCancel.filter((p) => !cur.includes(p));
if (droppedLate.length > 0) {
  console.log("\n--- dropped after the match-cancel step (player cancel / no venue link) ---");
  for (const p of droppedLate) {
    const m = byMatch.get(p.match_api_id)!;
    const fid = m.field_id;
    const reason =
      p.canceled_at && p.canceled_at.trim() !== ""
        ? `player canceled_at ${p.canceled_at.slice(0, 10)}`
        : `field_id ${fid} not in fin_venue_fields`;
    console.log(
      `${fmt(m.start_date)}  ${(m.field_title ?? "").slice(0, 22).padEnd(22)} uid=${String(p.user_id).padEnd(6)} → ${reason}`,
    );
  }
}
