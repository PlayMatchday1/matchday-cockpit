// IMPORT THE VC OUTREACH BOARD — 90 firms from vc-outreach-import.json into kanban_cards.
//
//   npx tsx --conditions=react-server scripts/import-vc-outreach.ts          # dry run, writes nothing
//   npx tsx --conditions=react-server scripts/import-vc-outreach.ts --apply  # writes
//
// ── DO NOT RUN THIS BEFORE 0166 IS APPLIED AND VERIFIED ───────────────────────────────────────
// kanban_cards shipped with `FOR ALL TO authenticated USING (true)`: every signed-in account can
// read every card off PostgREST regardless of page permission. Loading 90 firms with target round,
// check sizes and named partners under that policy makes MatchDay's fundraising position readable
// by every city manager. Securing it afterwards leaves a window, and the window is exactly when the
// data is there and the lock is not. The script refuses to write unless the policy is in place —
// see the preflight below.
//
// IDEMPOTENT. Keyed on data.source_id, the id the file already carries. Re-running updates the
// matching row rather than inserting a second, so 90 stays 90.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { vcWaveLabel, vcFitGrade, vcIsWarm } from "../src/lib/kanban";

const ENV_PATH = "/Users/ryanmancuso/Code/matchday-cockpit/.env.local";
const SRC = "/Users/ryanmancuso/Downloads/vc-outreach-import.json";
const env = readFileSync(ENV_PATH, "utf8");
const rd = (n: string) => { const m = env.match(new RegExp(`^${n}=(.+)$`, "m")); return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null; };
const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL")!, rd("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");

type Row = {
  id: string; firm: string; stage: string; fundFocus: string;
  contacts: { name?: string; title?: string; email?: string }[];
  owners: string[]; warmLead: unknown; relationship?: string; warmRationale?: string;
  fitPriority?: string; outreachPriority?: string; lastTouchpoint?: string;
  nextSteps?: string; nextStepDue?: string; notes?: string; sourceRows?: unknown; sort_order: number;
};

async function main() {
  const rows = JSON.parse(readFileSync(SRC, "utf8")) as Row[];
  console.log(`  source records: ${rows.length}`);

  /* ── PREFLIGHT: IS THE POLICY IN? ───────────────────────────────────────────────────────────
   * The board_type CHECK and the policy land in the same migration, so if 'vc_outreach' is not an
   * accepted board_type then 0166 has not been applied and neither has the RLS. Probing the CHECK
   * is a cheap proxy for the thing that actually matters and it cannot be faked by a stale client. */
  const probe = await sb.from("kanban_cards")
    .insert({ board_type: "vc_outreach", title: "__preflight__", stage: "not_contacted", sort_order: -1 })
    .select("id").maybeSingle();
  if (probe.error) {
    console.log(`\n  REFUSING TO WRITE: ${probe.error.message}`);
    console.log("  0166 is not applied — it carries BOTH the board_type/stage CHECKs and the RLS");
    console.log("  policy that stops every authenticated account reading this board. Apply it first.");
    process.exit(1);
  }
  await sb.from("kanban_cards").delete().eq("id", probe.data!.id);
  console.log("  preflight: 0166 is applied (board_type accepted, probe row removed)");

  const { count: before } = await sb.from("kanban_cards").select("id", { count: "exact", head: true }).eq("board_type", "vc_outreach");
  console.log(`  vc_outreach rows before: ${before ?? 0}`);

  /* OWNERS STAY LABELS. owner_user_id is a single uuid FK and cannot carry seven names, some firms
   * carrying two, and at least one person who is not an app_users row at all. Field Pipeline
   * already solved this with data.owner_label. owner_user_id is set ONLY where exactly one owner
   * resolves to exactly one app_users row — no guessing, no inventing users. */
  const { data: appUsers } = await sb.from("app_users").select("id, email, full_name");
  const resolve = (name: string): string | null => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const hits = (appUsers ?? []).filter((u) => {
      const full = String(u.full_name ?? "").toLowerCase();
      const local = String(u.email ?? "").split("@")[0].toLowerCase();
      return full === n || full.startsWith(`${n} `) || local === n;
    });
    return hits.length === 1 ? (hits[0].id as string) : null;
  };

  let resolved = 0, unresolved = 0;
  const payload = rows.map((r) => {
    const os = Array.isArray(r.owners) ? r.owners.filter(Boolean) : [];
    const uid = os.length === 1 ? resolve(os[0]) : null;
    if (os.length) { if (uid) resolved++; else unresolved++; }
    return {
      board_type: "vc_outreach" as const,
      title: r.firm,
      stage: "not_contacted",
      owner_user_id: uid,
      sort_order: r.sort_order,
      data: {
        source_id: r.id,
        fund_focus: r.fundFocus ?? "",
        contacts: r.contacts ?? [],
        owners: os,
        warm_raw: r.warmLead ?? null,
        warm: vcIsWarm(r.warmLead),
        relationship: r.relationship ?? "",
        warm_rationale: r.warmRationale ?? "",
        fit_raw: r.fitPriority ?? "",
        fit: vcFitGrade(r.fitPriority),
        // THE RAW STRING TRAVELS. The display label is High/Medium/Low; "Wave 1 - Low priority"
        // and the "prioritiy" typo stay here so nothing has to be re-read from a misspelling.
        wave_raw: r.outreachPriority ?? "",
        wave: vcWaveLabel(r.outreachPriority),
        last_touchpoint: r.lastTouchpoint ?? "",
        // TEXT, NOT CHECKLIST ITEMS. Mapping nextSteps to kanban_checklist_items is a second build.
        next_steps: r.nextSteps ?? "",
        next_step_due: r.nextStepDue ?? "",
        notes: r.notes ?? "",
      },
    };
  });

  console.log(`  owners: ${resolved} resolved to an app_users row · ${unresolved} stayed labels · ${rows.length - resolved - unresolved} unowned`);
  const waves = payload.reduce<Record<string, number>>((a, p) => { const w = String(p.data.wave || "(none)"); a[w] = (a[w] ?? 0) + 1; return a; }, {});
  console.log(`  wave labels: ${JSON.stringify(waves)}`);

  if (!APPLY) { console.log("\n  DRY RUN — nothing written. Re-run with --apply."); return; }

  const { data: existing } = await sb.from("kanban_cards").select("id, data").eq("board_type", "vc_outreach");
  const bySource = new Map((existing ?? []).map((e) => [String((e.data as Record<string, unknown>)?.source_id ?? ""), e.id as string]));
  let ins = 0, upd = 0;
  for (const p of payload) {
    const id = bySource.get(String(p.data.source_id));
    if (id) { const r = await sb.from("kanban_cards").update(p).eq("id", id); if (r.error) throw new Error(r.error.message); upd++; }
    else { const r = await sb.from("kanban_cards").insert(p); if (r.error) throw new Error(r.error.message); ins++; }
  }
  const { count: after } = await sb.from("kanban_cards").select("id", { count: "exact", head: true }).eq("board_type", "vc_outreach");
  console.log(`  inserted ${ins} · updated ${upd} · vc_outreach rows after: ${after ?? 0}`);
}
void main();
