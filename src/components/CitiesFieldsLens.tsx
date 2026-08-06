"use client";

// Fields — Match Ops → Field Ops. An operations page, not a directory: each row
// answers three questions — is anything playing here, is anyone reachable if it
// goes wrong, and is it filling to its own minimum. Rebuilt against the mockup
// docs/mockups/fields-v1_2.html.
//
// One query set for the whole page, no per-row queries: fin_venues (the CANONICAL
// record), city_managers, fin_venue_fields (the join to mdapi), and the match
// ledger (mdapi_matches + valid participation) for the trailing window. Every
// number is derived once via src/lib/fieldsOps.ts — the same module the
// reconciliation script checks against. A match "happened" iff is_cancelled=false
// (NEVER auto_canceled, a policy flag). Attendance counts valid play only
// (non-fake, non-cancelled, user_type=PLAYER). No money renders on this page.
//
// Add contact / Add link / edit / remove all go through the EXISTING fin_venues
// edit path (buildFieldPayload / resolveDeleteAction, admin-gated by RLS). No new
// mutation endpoints, no new permissions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useScheduleMarks, type ScheduleMark } from "@/lib/useScheduleMarks";
import { useScheduleEnds, type ScheduleEnd } from "@/lib/useScheduleEnds";
import { Pencil, Trash2, Plus, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { CITIES } from "@/lib/types";
import { normalizeCityName } from "@/lib/cityNormalization";
import {
  cityManagerFor,
  cityManagerPhoneFor,
  buildFieldPayload,
  resolveDeleteAction,
  contactLink,
  formatPhoneDisplay,
  formatE164UsPretty,
  UNASSIGNED_CITY_MANAGER,
  type CityManagerRoster,
  type FieldFormInput,
} from "@/lib/fieldsAdmin";
import {
  IDLE_DAYS,
  FILL_MIN_MATCH,
  TRAIL_WEEKS,
  UPCOMING_DAYS,
  DAY_MS,
  buildWeeks,
  deriveField,
  computeTiles,
  leadFlag,
  inView,
  FLAG_NOUN,
  type Venue,
  type VenueMatch,
  type FieldRow,
  type Flag,
} from "@/lib/fieldsOps";

const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", mint: "#e0f2e7",
  ink: "#12241d", muted: "#6d7b74", muted2: "#9aa8a1",
  warnBg: "#fdf1d0", warnInk: "#8a6300", warnLine: "#e3c369",
  critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9", ok: "#12704a",
  railA: "#fafbfa", railB: "#f6f9f7", board: "#f8faf9", chipBg: "#eef3f0", chipLine: "#e2eae5",
  line: "#e6ebe8", hair: "#eff3f1", surface: "#ffffff",
};

// Exact cell fills for the Schedule + Schedule-ends columns, ported from
// mockups/fieldsched-v1_1.html. Defined ONCE so the header legend swatches are
// literally the same values as the cells they explain (asserted in verify).
const SE = {
  linkedBg: "#E9FAF1", linkedBd: "#A8E7C9", linkedInk: "#046B45",
  amberBg: "#FFF6D6", amberBd: "#F0DC9B", amberInk: "#7A5200",
  greyBg: "#F7F9F6", greyBd: "#E3E8E0", greyInk: "#5C6B62",
  coralBg: "#FDE9E5", coralBd: "#F3C4BB", coralInk: "#A83120",
  forest: "#003326", line: "#E3E8E0", dash: "#C8D2CA", muted: "#5C6B62",
} as const;

const SOON_DAYS = 30;
const EMDASH = "—";
// "Schedule ends" is derived from the stored date/flag against today AT RENDER,
// never stored. NEVER prints a negative day count; ALWAYS prints the absolute date.
type EndsView =
  | { kind: "forever"; label: "Standing reservation"; value: "Indefinite"; rel: "Runs until cancelled"; cls: "forever"; edit: "Change"; days: null }
  | { kind: "unset"; label: "Not set"; value: string; rel: "No end date recorded"; cls: "unset"; edit: "Set end date"; days: null }
  | { kind: "dated"; label: string; value: string; rel: string; cls: "over" | "soon" | "ok"; edit: "Change"; days: number };
function endsView(end: ScheduleEnd | undefined, nowMs: number): EndsView {
  if (end?.indefinite) return { kind: "forever", label: "Standing reservation", value: "Indefinite", rel: "Runs until cancelled", cls: "forever", edit: "Change", days: null };
  if (!end?.endDate) return { kind: "unset", label: "Not set", value: EMDASH, rel: "No end date recorded", cls: "unset", edit: "Set end date", days: null };
  // days remaining computed every render from the date; midday anchor avoids DST edges.
  const at = Date.parse(`${end.endDate}T12:00:00Z`);
  const todayUTC = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate(), 12);
  const d = Math.round((at - todayUTC) / DAY_MS);
  const cls = d < 0 ? "over" : d <= SOON_DAYS ? "soon" : "ok";
  const label = d < 0 ? "Reservation expired" : d <= SOON_DAYS ? "Ends soon" : "Reserved through";
  const rel = d < 0 ? `${Math.abs(d)} days ago` : d === 0 ? "today" : `in ${d} days`; // never a negative count
  const [y, m, dd] = end.endDate.split("-").map(Number);
  const value = `${MON[m - 1]} ${dd}, ${y}`; // absolute date, always
  return { kind: "dated", label, value, rel, cls, edit: "Change", days: d };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dshort = (ms: number) => `${MON[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;

// display code derived from the venue name (fin_venues has no code column).
function fieldCode(name: string): string {
  const cleaned = name.replace(/\(.*?\)/g, " ").replace(/[^A-Za-z0-9 ]/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words.map((w) => w[0]).join("") + words[0].slice(1)).slice(0, 4).toUpperCase();
  return (words[0] ?? name).slice(0, 4).toUpperCase();
}
// time-of-day from an mdapi start_date wall-clock string ("...T21:00:00...")
function timeOf(startLocal: string | null): string {
  if (!startLocal) return "";
  const m = /T(\d{2}):(\d{2})/.exec(startLocal);
  if (!m) return "";
  let h = +m[1];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

type ModalState =
  | { mode: "add"; form: FieldFormInput }
  | { mode: "edit"; id: number; name: string; form: FieldFormInput }
  | null;

const EMPTY_FORM: FieldFormInput = {
  venue_name: "", city: CITIES[0], contact_name: "", contact_number: "",
  min_players: "", max_players: "", schedule_url: "",
};

type RawVenue = {
  id: number; venue_name: string; city: string;
  contact_name: string | null; contact_number: string | null;
  min_players: number | null; max_players: number | null; schedule_url: string | null;
};
// NOTE: no money column is selected — none renders on this page.
const VENUE_COLS = "id, venue_name, city, contact_name, contact_number, min_players, max_players, schedule_url";

export default function CitiesFieldsLens() {
  const [rows, setRows] = useState<FieldRow[]>([]);
  const [roster, setRoster] = useState<CityManagerRoster>(new Map());
  const [rawById, setRawById] = useState<Map<number, RawVenue>>(new Map());
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState("all");
  const [view, setView] = useState("all");

  const [modal, setModal] = useState<ModalState>(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RawVenue | null>(null);
  const { marks: scheduleMarks, enabled: marksEnabled, setNoDocument } = useScheduleMarks();
  const { ends: scheduleEnds, enabled: endsEnabled, setEnds } = useScheduleEnds();
  const [editingEnds, setEditingEnds] = useState<number | null>(null); // only one row edits at a time

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = Date.now();
      const weeks = buildWeeks(now);
      const windowStart = weeks[0].aMs;
      const windowEnd = now + UPCOMING_DAYS * DAY_MS;

      const [vRes, cmRes, linkRes] = await Promise.all([
        supabase.from("fin_venues").select(VENUE_COLS).eq("is_active", true),
        supabase.from("city_managers").select("city, manager_name, manager_phone"),
        supabase.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
      ]);
      if (vRes.error) throw vRes.error;
      if (cmRes.error) throw cmRes.error;
      if (linkRes.error) throw linkRes.error;

      const venuesRaw = (vRes.data ?? []) as RawVenue[];
      const roster: CityManagerRoster = new Map();
      for (const r of (cmRes.data ?? []) as { city: string; manager_name: string; manager_phone: string | null }[])
        roster.set(r.city, { name: r.manager_name, phone: r.manager_phone ?? null });

      // field_id → venue_id
      const links = (linkRes.data ?? []) as { fin_venue_id: number; mdapi_field_id: number }[];
      const fieldToVenue = new Map<number, number>();
      for (const l of links) fieldToVenue.set(l.mdapi_field_id, l.fin_venue_id);
      const allFieldIds = [...new Set(links.map((l) => l.mdapi_field_id))];

      // ── matches in the window (include cancelled — needed for address; the
      // played/upcoming counts use is_cancelled=false only). Paginated. ──
      type M = { api_id: number; field_id: number; start_date_utc: string | null; start_date: string | null; field_address: string | null; is_cancelled: boolean };
      const matches: M[] = [];
      for (let from = 0; ; from += 1000) {
        const r = await supabase
          .from("mdapi_matches")
          .select("api_id, field_id, start_date_utc, start_date, field_address, is_cancelled")
          .in("field_id", allFieldIds)
          .gte("start_date_utc", new Date(windowStart).toISOString())
          .lte("start_date_utc", new Date(windowEnd).toISOString())
          .is("deleted_at", null)
          .range(from, from + 999);
        if (r.error) throw r.error;
        const page = (r.data ?? []) as M[];
        matches.push(...page);
        if (page.length < 1000) break;
      }

      // ── valid participation per match (non-fake, non-cancelled, PLAYER) for
      // the non-cancelled matches only. Chunk the match ids, paginate each. ──
      const liveMatchIds = matches.filter((m) => !m.is_cancelled).map((m) => m.api_id);
      const countByMatch = new Map<number, number>();
      for (let i = 0; i < liveMatchIds.length; i += 120) {
        const chunk = liveMatchIds.slice(i, i + 120);
        for (let from = 0; ; from += 1000) {
          const r = await supabase
            .from("mdapi_match_players")
            .select("match_api_id")
            .in("match_api_id", chunk)
            .eq("user_type", "PLAYER")
            .eq("is_cancelled", false)
            .eq("user_is_fake_player", false) // the fake-player filter — is_fake_player = false
            .range(from, from + 999);
          if (r.error) throw r.error;
          const page = (r.data ?? []) as { match_api_id: number }[];
          for (const p of page) countByMatch.set(p.match_api_id, (countByMatch.get(p.match_api_id) ?? 0) + 1);
          if (page.length < 1000) break;
        }
      }

      // group matches per venue; capture address from any (latest) match
      const perVenue = new Map<number, VenueMatch[]>();
      const addrByVenue = new Map<number, { ms: number; addr: string }>();
      for (const m of matches) {
        const vid = fieldToVenue.get(m.field_id);
        if (vid == null || !m.start_date_utc) continue;
        const ms = Date.parse(m.start_date_utc);
        if (m.field_address) {
          const cur = addrByVenue.get(vid);
          if (!cur || ms > cur.ms) addrByVenue.set(vid, { ms, addr: m.field_address });
        }
        if (m.is_cancelled) continue;
        const arr = perVenue.get(vid) ?? [];
        arr.push({ startMs: ms, played: ms < now, time: timeOf(m.start_date), count: countByMatch.get(m.api_id) ?? 0 });
        perVenue.set(vid, arr);
      }

      const venues: Venue[] = venuesRaw.map((v) => ({
        id: v.id, name: v.venue_name, city: v.city, code: fieldCode(v.venue_name),
        contactName: v.contact_name, contactPhone: v.contact_number,
        minPlayers: v.min_players, maxPlayers: v.max_players, scheduleUrl: v.schedule_url,
        address: addrByVenue.get(v.id)?.addr ?? null,
      }));
      const derived = venues.map((v) => deriveField(v, perVenue.get(v.id) ?? [], now, weeks));

      setRawById(new Map(venuesRaw.map((v) => [v.id, v])));
      setRoster(roster);
      setRows(derived);
      setNowMs(now);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load fields.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const weeks = useMemo(() => buildWeeks(nowMs), [nowMs]);

  // ── filter predicates ──
  const q = search.trim().toLowerCase();
  const matchesCity = (r: FieldRow) => cityFilter === "all" || r.venue.city === cityFilter;
  const matchesQ = (r: FieldRow) => {
    if (!q) return true;
    const hay = `${r.venue.name} ${r.venue.code} ${r.venue.address ?? ""} ${r.venue.contactName ?? ""} ${r.venue.contactPhone ?? ""}`.toLowerCase();
    return hay.includes(q);
  };
  const base = useMemo(() => rows.filter((r) => matchesCity(r) && matchesQ(r)), [rows, cityFilter, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => base.filter((r) => inView(r, view)), [base, view]);
  const tiles = useMemo(() => computeTiles(rows), [rows]);

  const cityCount = useMemo(() => new Set(rows.map((r) => r.venue.city)).size, [rows]);
  const filtering = cityFilter !== "all" || !!q || view !== "all";

  // ── the reused edit path ──
  const openEdit = useCallback((raw: RawVenue, focus?: "contact" | "schedule") => {
    setModalError(null);
    setModal({
      mode: "edit", id: raw.id, name: raw.venue_name,
      form: {
        venue_name: raw.venue_name, city: raw.city,
        contact_name: raw.contact_name ?? "", contact_number: raw.contact_number ?? "",
        min_players: raw.min_players?.toString() ?? "", max_players: raw.max_players?.toString() ?? "",
        schedule_url: raw.schedule_url ?? "",
      },
    });
    void focus;
  }, []);
  const openAdd = useCallback((city?: string) => {
    setModalError(null);
    setModal({ mode: "add", form: { ...EMPTY_FORM, city: city ?? CITIES[0] } });
  }, []);
  const save = useCallback(async () => {
    if (!modal) return;
    const result = buildFieldPayload(modal.form);
    if (!result.ok) { setModalError(result.error); return; }
    setSaving(true); setModalError(null);
    try {
      if (modal.mode === "add") {
        const { error: e } = await supabase.from("fin_venues").insert(result.payload);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from("fin_venues").update(result.payload).eq("id", modal.id);
        if (e) throw e;
      }
      setModal(null);
      await load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }, [modal, load]);
  const doDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const { patch } = resolveDeleteAction();
    setSaving(true);
    try {
      const { error: e } = await supabase.from("fin_venues").update(patch).eq("id", confirmDelete.id);
      if (e) throw e;
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }, [confirmDelete, load]);

  const VIEWS = [
    { k: "all", lbl: "All" }, { k: "week", lbl: "Playing this week" },
    { k: "attn", lbl: "Needs a look" }, { k: "idle", lbl: "Idle" },
  ];

  if (loading && rows.length === 0)
    return <div className="p-8 text-sm" style={{ color: C.muted }}>Loading fields…</div>;
  if (error)
    return <div className="m-4 rounded-xl border p-4 text-sm" style={{ borderColor: C.critLine, background: C.critBg, color: C.critInk }}>{error}</div>;

  const wLast = weeks[TRAIL_WEEKS - 1];

  return (
    <div className="min-w-0" style={{ color: C.ink }}>
      <style>{`
        .fo-grid{display:grid;align-items:center;grid-template-columns:minmax(200px,1fr) 148px 164px 150px 206px 236px 66px;gap:0 14px;padding:0 16px}
        @media(max-width:1480px){
          .fo-grid{grid-template-columns:minmax(176px,1fr) 128px 144px 126px 192px 216px 64px;gap:0 10px;padding:0 12px}
        }
        /* ── Schedule + Schedule-ends cells: one fixed 88px slot each. State
           changes COLOUR and WORDS, never position, order, or height. ── */
        .se-sc,.se-ec,.se-edit{border:1px solid ${SE.line};border-radius:11px;padding:9px 11px;min-height:88px;display:flex;flex-direction:column;background:#fff}
        .se-sc{gap:7px}
        .se-ec,.se-edit{gap:6px}
        .se-sl,.se-el{font-size:8.5px;font-weight:900;letter-spacing:.9px;text-transform:uppercase;display:flex;align-items:center;gap:6px;color:${SE.muted}}
        .se-sl i,.se-el i{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
        .se-sc.linked{background:${SE.linkedBg};border-color:${SE.linkedBd}}
        .se-sc.linked .se-sl{color:${SE.linkedInk}}
        .se-open{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;background:${SE.linkedBg};border:1px solid ${SE.linkedBd};color:${SE.forest};font-family:inherit;font-size:12px;font-weight:900;border-radius:8px;padding:7px 11px;cursor:pointer;text-decoration:none;width:100%}
        .se-open:hover{background:#DCF6E8;border-color:#8DDCB6}
        .se-sc.linked .se-open{background:#fff}
        .se-sc.missing{background:${SE.amberBg};border-color:${SE.amberBd}}
        .se-sc.missing .se-sl{color:${SE.amberInk}}
        .se-addlink{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:${SE.forest};border:1px solid ${SE.forest};color:#fff;font-family:inherit;font-size:12px;font-weight:900;border-radius:8px;padding:7px 11px;cursor:pointer;width:100%}
        .se-addlink:hover{background:#014C39}
        .se-sc.nodoc{background:${SE.greyBg};border-color:${SE.greyBd}}
        .se-sc.nodoc .se-sl{color:${SE.greyInk}}
        .se-who{font-size:10.5px;color:${SE.muted};line-height:1.4}
        .se-link{background:none;border:0;padding:0;font-family:inherit;font-size:11px;font-weight:850;color:${SE.linkedInk};cursor:pointer;text-decoration:underline;text-underline-offset:2px;align-self:flex-start;text-align:left}
        .se-ec{cursor:pointer;text-align:left;font-family:inherit;width:100%}
        .se-ec:hover{border-color:#BCC9C0}
        .se-ev{font-size:13px;font-weight:900;color:${SE.forest};white-space:nowrap}
        .se-er{font-size:11px;font-weight:850;color:${SE.muted};white-space:nowrap}
        .se-eedit{font-size:10.5px;font-weight:850;color:${SE.linkedInk};text-decoration:underline;text-underline-offset:2px;margin-top:auto}
        .se-ec.soon{background:${SE.amberBg};border-color:${SE.amberBd}}
        .se-ec.soon .se-el,.se-ec.soon .se-er{color:${SE.amberInk}}
        .se-ec.over{background:${SE.coralBg};border-color:${SE.coralBd}}
        .se-ec.over .se-el,.se-ec.over .se-er,.se-ec.over .se-ev{color:${SE.coralInk}}
        .se-ec.forever{background:${SE.linkedBg};border-color:${SE.linkedBd}}
        .se-ec.forever .se-el{color:${SE.linkedInk}}
        .se-ec.unset{background:#fff;border-style:dashed;border-color:${SE.dash}}
        .se-ec.unset .se-ev{color:${SE.muted};font-weight:800}
        .se-edit{border-color:${SE.forest}}
        .se-edit input[type=date]{font-family:inherit;font-size:12px;font-weight:800;color:#0d1f18;border:1px solid ${SE.line};border-radius:7px;padding:5px 7px;width:100%}
        .se-erow{display:flex;gap:6px}
        .se-eb{flex:1;font-family:inherit;font-size:10.5px;font-weight:900;border-radius:7px;padding:5px 8px;cursor:pointer;border:1px solid ${SE.line};background:#fff;color:${SE.muted}}
        .se-eb.pri{background:${SE.forest};border-color:${SE.forest};color:#fff}
        .se-eb.inf{border-color:${SE.linkedBd};background:${SE.linkedBg};color:${SE.linkedInk}}
        .se-legend{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
        .se-legend span{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:800;color:${SE.muted};white-space:nowrap}
        .se-legend i{width:10px;height:10px;border-radius:3px;flex:none;border:1px solid rgba(0,51,38,.14)}
      `}</style>

      {/* header */}
      <div className="mb-4 flex flex-wrap items-start gap-4">
        <div>
          <h1 className="m-0 text-[28px] font-[800] tracking-[-0.4px]" style={{ color: C.forestDeep }}>Fields</h1>
          <p className="mt-0.5 text-[13.5px]" style={{ color: C.muted }}>
            {rows.length} fields across {cityCount} cities · usage, fill and cover for the last {TRAIL_WEEKS} weeks
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={() => openAdd()}
            className="inline-flex h-9 items-center gap-2 rounded-[9px] border px-[14px] text-[13px] font-bold"
            style={{ background: C.accent, borderColor: C.accent, color: "#06281d" }}>
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M12 5v14M5 12h14" /></svg>
            Add field
          </button>
        </div>
      </div>

      {/* filters */}
      <div className="mb-3.5 flex flex-wrap items-end gap-2.5 rounded-[12px] border p-3" style={{ background: C.surface, borderColor: C.line }}>
        <div className="flex flex-col gap-1.5">
          <label className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>SEARCH</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} type="search"
            placeholder="Field, code, contact or address…"
            className="h-9 w-[250px] rounded-[9px] border px-[11px] text-[13.5px] font-semibold outline-none focus:border-[#35c77f]"
            style={{ background: C.railB, borderColor: C.line, color: C.ink }} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>CITY</label>
          <select value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}
            className="h-9 rounded-[9px] border pl-[11px] pr-8 text-[13.5px] font-semibold" style={{ background: C.railB, borderColor: C.line, color: C.ink }}>
            <option value="all">All cities</option>
            {CITIES.filter((c) => rows.some((r) => r.venue.city === c)).map((c) => (
              <option key={c} value={c}>{c} ({rows.filter((r) => r.venue.city === c).length})</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>SHOW</label>
          <div className="inline-flex gap-0.5 rounded-[9px] border p-0.5" style={{ background: C.chipBg, borderColor: C.chipLine }}>
            {VIEWS.map((v) => {
              const on = view === v.k;
              const n = base.filter((r) => inView(r, v.k)).length;
              return (
                <button key={v.k} type="button" onClick={() => setView(v.k)}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] px-[11px] text-[12px] font-bold"
                  style={on ? { background: C.surface, color: C.forestDeep, boxShadow: "0 1px 2px rgba(9,40,30,.08)" } : { background: "transparent", color: C.muted }}>
                  {v.lbl} <em className="text-[10.5px] font-[800] not-italic" style={{ color: on ? C.accent : C.muted2 }}>{n}</em>
                </button>
              );
            })}
          </div>
        </div>
        {filtering && (
          <button type="button" onClick={() => { setSearch(""); setCityFilter("all"); setView("all"); }}
            className="h-9 rounded-[9px] border px-[14px] text-[13px] font-bold" style={{ background: C.surface, borderColor: C.line, color: C.forest }}>
            Clear filters
          </button>
        )}
        <div className="ml-auto self-center text-right text-[12px]" style={{ color: C.muted }}>
          Showing <b style={{ color: C.forest }}>{visible.length}</b> of <b style={{ color: C.forest }}>{rows.length}</b> fields{filtering ? " · filtered" : ""}
        </div>
      </div>

      {/* tiles */}
      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Tile dataFo="playing" label="PLAYING THIS WEEK" big={`${tiles.playingThisWeek}`} small={`of ${tiles.total}`}
          note={(() => { const n = tiles.total - tiles.playingThisWeek; return <>{n} field{n === 1 ? " has" : "s have"} nothing on the calendar this week <span className="whitespace-nowrap">({dshort(wLast.aMs)} – {dshort(wLast.bMs)})</span></>; })()} />
        <Tile dataFo="upcoming" label="MATCHES, NEXT 7 DAYS" big={`${tiles.upcomingMatches}`}
          note={<>at {tiles.upcomingFields} fields · <span className="whitespace-nowrap">{dshort(nowMs)} – {dshort(nowMs + (UPCOMING_DAYS - 1) * DAY_MS)}</span> · <span className="whitespace-nowrap">{tiles.upcomingSignups} players signed up so far</span></>} />
        <div className="rounded-[12px] border p-4" style={{ background: C.surface, borderColor: C.line }}>
          <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>NEEDS A LOOK</div>
          <div data-fo="needslook" className="mt-1.5 text-[30px] font-[800] leading-none tracking-[-1px]" style={{ color: tiles.needsLook ? C.warnInk : C.ok }}>
            {tiles.needsLook} <small className="text-[15px] font-bold" style={{ color: C.muted }}>of {tiles.total}</small>
          </div>
          <div className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>
            {tiles.needsLook ? tiles.breakdown.map((b) => `${b.n} ${FLAG_NOUN[b.k]}`).join(", ") : "no field is missing a contact, idle or under its minimum"}
          </div>
          {tiles.needsLook > 0 && (
            <button type="button" onClick={() => setView(view === "attn" ? "all" : "attn")}
              className="mt-[7px] inline-block rounded-[8px] border px-2.5 py-1.5 text-[11.5px] font-[800]"
              style={{ background: C.railA, borderColor: C.line, color: C.ok }}>
              {view === "attn" ? `Showing only these — show all ${tiles.total}` : `Show only these ${tiles.needsLook}`}
            </button>
          )}
        </div>
      </div>

      {/* directory */}
      <div className="rounded-[12px] border" style={{ background: C.surface, borderColor: C.line }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3" style={{ borderColor: C.hair }}>
          <h2 className="m-0 text-[14.5px] font-[800] tracking-[-0.2px]" style={{ color: C.forestDeep }}>All fields</h2>
          <span className="text-[11.5px]" style={{ color: C.muted }}>{visible.length} shown, grouped by city</span>
          {/* legend for the Schedule ends + Schedule columns — swatches are the SE fills verbatim */}
          <div className="se-legend ml-auto" data-fo="legend">
            <span><i data-swatch="linked" style={{ background: SE.linkedBg, borderColor: SE.linkedBd }} />Schedule linked</span>
            <span><i data-swatch="amber" style={{ background: SE.amberBg, borderColor: SE.amberBd }} />Needs a link · ends soon</span>
            <span><i data-swatch="grey" style={{ background: SE.greyBg, borderColor: SE.greyBd }} />Marked: no document</span>
            <span><i data-swatch="coral" style={{ background: SE.coralBg, borderColor: SE.coralBd }} />Reservation expired</span>
          </div>
        </div>

        <div className="fo-grid sticky top-16 z-[12] h-[34px] border-b text-[10px] font-[800] tracking-[0.08em]" style={{ background: C.railB, borderColor: C.line, color: C.muted }}>
          <div>FIELD</div><div>CAPACITY &amp; TYPICAL FILL</div><div>FIELD CONTACT</div>
          <div>LAST 8 WEEKS</div><div>SCHEDULE ENDS</div><div>SCHEDULE</div><div />
        </div>

        {visible.length === 0 ? (
          <div className="px-4 py-9 text-center text-[13px]" style={{ color: C.muted }}>
            No field matches {q ? `“${q}”` : "this selection"}{cityFilter !== "all" ? ` in ${cityFilter}` : ""}
            {view !== "all" ? <> under <b style={{ color: C.forest }}>{VIEWS.find((v) => v.k === view)?.lbl}</b></> : null}. Clear a filter to widen it.
          </div>
        ) : (
          CITIES.filter((c) => rows.some((r) => r.venue.city === c)).map((city) => {
            const rs = visible.filter((r) => r.venue.city === city);
            if (!rs.length) return null;
            const code = normalizeCityName(city) ?? city;
            const cm = cityManagerFor(city, roster);
            const cmPhone = cityManagerPhoneFor(city, roster);
            const wkN = rs.filter((r) => r.playingThisWeek).length;
            return (
              <div key={city}>
                <div className="flex items-center gap-2.5 border-t border-b px-4 py-2.5" style={{ background: C.board, borderTopColor: C.line, borderBottomColor: C.hair }}>
                  <span className="rounded-[6px] px-[7px] py-[3px] text-[10.5px] font-[800] tracking-[0.06em]" style={{ background: C.forest, color: "#dff3e9" }}>{code}</span>
                  <span className="text-[13.5px] font-[800]" style={{ color: C.forestDeep }}>{city}</span>
                  <span className="text-[11.5px]" style={{ color: C.muted }}>{rs.length} field{rs.length === 1 ? "" : "s"} · {wkN} playing this week</span>
                  <span className="ml-auto flex items-center gap-2 text-[11.5px]" style={{ color: C.muted }}>
                    {cm !== UNASSIGNED_CITY_MANAGER && (
                      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border text-[10.5px] font-[800]" style={{ background: C.mint, color: C.forestDeep, borderColor: "#bfe4cf" }}>{cm.charAt(0)}</span>
                    )}
                    City manager <b style={{ color: C.forest }}>{cm}</b>
                    {cmPhone && <Tel value={cmPhone} pretty />}
                  </span>
                </div>
                {rs.map((r) => (
                  <Row key={r.venue.id} r={r} nowMs={nowMs}
                    mark={scheduleMarks.get(r.venue.id)} marksEnabled={marksEnabled}
                    end={scheduleEnds.get(r.venue.id)} endsEnabled={endsEnabled}
                    editingEnds={editingEnds === r.venue.id}
                    onEditEnds={() => setEditingEnds(r.venue.id)}
                    onCancelEnds={() => setEditingEnds(null)}
                    onSaveEnds={(date, indefinite) => { setEditingEnds(null); void setEnds(r.venue.id, { date, indefinite }); }}
                    onEdit={() => { const raw = rawById.get(r.venue.id); if (raw) openEdit(raw); }}
                    onAddContact={() => { const raw = rawById.get(r.venue.id); if (raw) openEdit(raw, "contact"); }}
                    onAddLink={() => { const raw = rawById.get(r.venue.id); if (raw) openEdit(raw, "schedule"); }}
                    onNoDocument={() => setNoDocument(r.venue.id)}
                    onRemove={() => { const raw = rawById.get(r.venue.id); if (raw) setConfirmDelete(raw); }} />
                ))}
              </div>
            );
          })
        )}

        <div className="border-t border-dashed px-4 py-3 text-[11px] leading-[1.5]" style={{ borderColor: C.hair, color: C.muted }}>
          A field needs a look when any of three things is true: it has no contact on file, which shows as an Add contact button;
          its last match was {IDLE_DAYS}+ days ago with nothing booked, which shows as an Idle chip beside the name; or its typical
          fill sits under its own minimum, which shows as an amber tick and note (measured only where there are at least {FILL_MIN_MATCH} matches
          to average). The Needs a look tile counts each field once, under its most urgent flag, so those numbers add up to the fields and
          not to the flags. On each capacity bar the shaded band is that field&apos;s own minimum-to-maximum and the tick is the average number
          of players who actually turn up; a tick left of the band is a field running under its own minimum. Usage and fill cover the {TRAIL_WEEKS} weeks
          from {dshort(weeks[0].aMs)} to {dshort(nowMs)}; the last bar is this week to date. Schedule ends shows when each field&apos;s reservation runs
          out; the days-remaining figure is computed from the stored date on every load, so an expired reservation reads “N days ago”, never a stale
          countdown. Click a cell to set a date or mark it a standing reservation.
        </div>
      </div>

      {modal && (
        <FieldModal state={modal} roster={roster} saving={saving} error={modalError}
          onChange={(form) => setModal((m) => (m ? { ...m, form } : m))} onClose={() => setModal(null)} onSave={save} />
      )}
      {confirmDelete && (
        <ConfirmDelete venue={confirmDelete} saving={saving} onCancel={() => setConfirmDelete(null)} onConfirm={doDelete} />
      )}
    </div>
  );
}

// ── row ──
function Row({ r, nowMs, mark, marksEnabled, end, endsEnabled, editingEnds, onEditEnds, onCancelEnds, onSaveEnds, onEdit, onAddContact, onAddLink, onNoDocument, onRemove }: {
  r: FieldRow; nowMs: number; mark: ScheduleMark | undefined; marksEnabled: boolean;
  end: ScheduleEnd | undefined; endsEnabled: boolean; editingEnds: boolean;
  onEditEnds: () => void; onCancelEnds: () => void; onSaveEnds: (date: string | null, indefinite: boolean) => void;
  onEdit: () => void; onAddContact: () => void; onAddLink: () => void; onNoDocument: () => void; onRemove: () => void;
}) {
  const f = r.venue;
  const nameFlags = r.flags.filter((x) => x.k === "idle" || x.k === "never");
  const street = f.address ? f.address.split(",")[0] : null;
  return (
    <div className="fo-grid border-b" style={{ borderColor: C.hair, minHeight: 88 }}>
      {/* FIELD — two lines: name(+code+chip) and meta(street). No third line. */}
      <div className="py-[11px]">
        <div className="flex min-w-0 items-center gap-[7px] text-[13.5px] font-bold">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{f.name}</span>
          <span className="flex-none rounded-[5px] border px-[5px] py-[2px] text-[9.5px] font-[800] tracking-[0.05em]" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>{f.code}</span>
          {nameFlags.map((x, i) => <FlagChip key={i} f={x} />)}
        </div>
        {street && (
          <div className="mt-[3px] flex items-center gap-1.5 overflow-hidden text-[11px]" style={{ color: C.muted }} title={f.address ?? undefined}>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{street}</span>
          </div>
        )}
      </div>

      {/* CAPACITY & TYPICAL FILL */}
      <div className="py-[11px]"><Capacity r={r} /></div>

      {/* FIELD CONTACT */}
      <div className="py-[11px]">
        {f.contactPhone ? (
          <>
            {f.contactName && <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-bold">{f.contactName}</div>}
            <Tel value={f.contactPhone} />
          </>
        ) : (
          <button type="button" onClick={onAddContact}
            className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] border px-2.5 text-[12px] font-bold"
            style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M12 5v14M5 12h14" /></svg>Add contact
          </button>
        )}
      </div>

      {/* LAST 8 WEEKS */}
      <div className="py-[11px]"><Spark r={r} /></div>

      {/* SCHEDULE ENDS — one fixed 88px slot; five states derived at render. */}
      <div><EndsCell f={f} end={end} endsEnabled={endsEnabled} nowMs={nowMs} editing={editingEnds} onEdit={onEditEnds} onCancel={onCancelEnds} onSave={onSaveEnds} /></div>

      {/* SCHEDULE — one fixed 88px slot; three states, same order, same footprint. */}
      <div><SchedCell f={f} mark={mark} marksEnabled={marksEnabled} onAddLink={onAddLink} onNoDocument={onNoDocument} /></div>

      {/* actions */}
      <div className="flex gap-1 py-[11px]">
        <button type="button" onClick={onEdit} aria-label={`Edit ${f.name}`} className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border" style={{ borderColor: C.line, color: C.muted }}>
          <Pencil aria-hidden size={15} />
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${f.name}`} className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border" style={{ borderColor: C.line, color: C.muted }}>
          <Trash2 aria-hidden size={15} />
        </button>
      </div>
    </div>
  );
}

// ── SCHEDULE cell — one fixed slot, three states, same three things in the same
// order (status label, primary control, secondary link). State changes only
// colour + words. Precedence: a link wins → linked; else a mark → no document;
// else → needs a link (the one amber, loud state, because it is the only work). ──
function SchedCell({ f, mark, marksEnabled, onAddLink, onNoDocument }: {
  f: Venue; mark: ScheduleMark | undefined; marksEnabled: boolean; onAddLink: () => void; onNoDocument: () => void;
}) {
  if (f.scheduleUrl) {
    return (
      <div className="se-sc linked" data-sched="linked">
        <div className="se-sl"><i />Schedule linked</div>
        <a className="se-open" href={f.scheduleUrl} target="_blank" rel="noopener noreferrer" data-primary="open">Open schedule <span aria-hidden>↗</span></a>
        <button type="button" className="se-link" onClick={onAddLink}>Replace link</button>
      </div>
    );
  }
  if (mark) {
    return (
      <div className="se-sc nodoc" data-sched="nodoc">
        <div className="se-sl"><i />No document</div>
        <div className="se-who">Marked by {mark.by} · {mark.on}</div>
        <button type="button" className="se-link" onClick={onAddLink}>Add a link instead</button>
      </div>
    );
  }
  return (
    <div className="se-sc missing" data-sched="missing">
      <div className="se-sl"><i />Needs a link</div>
      <button type="button" className="se-addlink" onClick={onAddLink} data-primary="addlink">+ Add link</button>
      {marksEnabled
        ? <button type="button" className="se-link" onClick={onNoDocument}>Mark as no document</button>
        : <span className="se-who" style={{ visibility: "hidden" }}>{EMDASH}</span>}
    </div>
  );
}

// ── SCHEDULE ENDS cell — same one-slot discipline. Five states derived at render
// (never stored): standing / reserved-through / ends-soon / expired / not-set.
// Clicking opens the inline editor in the same slot. Attribution rides on the
// cell's title (who last set it + when), so the fixed footprint is preserved. ──
function EndsCell({ f, end, endsEnabled, nowMs, editing, onEdit, onCancel, onSave }: {
  f: Venue; end: ScheduleEnd | undefined; endsEnabled: boolean; nowMs: number;
  editing: boolean; onEdit: () => void; onCancel: () => void; onSave: (date: string | null, indefinite: boolean) => void;
}) {
  if (editing) return <EndsEditor end={end} onCancel={onCancel} onSave={onSave} />;
  const v = endsView(end, nowMs);
  const attribution = end?.by ? `Set by ${end.by}${end.on ? ` · ${end.on}` : ""}` : undefined;
  return (
    <button type="button" className={`se-ec ${v.cls}`} data-ends={v.cls} data-days={v.days ?? ""} data-venue={f.id}
      onClick={endsEnabled ? onEdit : undefined} disabled={!endsEnabled} title={attribution}
      style={endsEnabled ? undefined : { cursor: "default" }}>
      <div className="se-el"><i />{v.label}</div>
      <div className="se-ev">{v.value}</div>
      <div className="se-er">{v.rel}</div>
      <span className="se-eedit">{endsEnabled ? v.edit : ""}</span>
    </button>
  );
}

// Inline reservation-end editor — a real date input, plus Indefinite as a
// first-class choice beside Save (a standing reservation is one click, not a
// tucked-away checkbox). Saving an empty date returns the row to Not set.
// indefinite XOR dated is guaranteed by the three exits below (never both).
function EndsEditor({ end, onCancel, onSave }: {
  end: ScheduleEnd | undefined; onCancel: () => void; onSave: (date: string | null, indefinite: boolean) => void;
}) {
  const [date, setDate] = useState<string>(end?.indefinite ? "" : end?.endDate ?? "");
  return (
    <div className="se-edit" data-ends="editing">
      <div className="se-el"><i />When does it run out?</div>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Reservation end date" />
      <div className="se-erow">
        <button type="button" className="se-eb inf" onClick={() => onSave(null, true)}>Indefinite</button>
        <button type="button" className="se-eb pri" onClick={() => onSave(date || null, false)}>Save</button>
      </div>
      <button type="button" className="se-eb" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function FlagChip({ f }: { f: Flag }) {
  const st = f.level === "c"
    ? { background: C.critBg, borderColor: C.critLine, color: C.critInk }
    : { background: C.warnBg, borderColor: C.warnLine, color: C.warnInk };
  return <span className="flex-none rounded-full border px-[7px] py-[2px] text-[9.5px] font-[800] tracking-[0.03em]" style={st}>{f.label}</span>;
}

function Capacity({ r }: { r: FieldRow }) {
  const f = r.venue;
  const span = f.maxPlayers || 1;
  const mn = f.minPlayers ?? 0;
  const zl = (mn / span) * 100;
  const zw = ((span - mn) / span) * 100;
  const low = r.fill != null && f.minPlayers != null && r.fill < f.minPlayers;
  return (
    <>
      <div className="text-[12px] font-bold">{f.minPlayers ?? "?"}–{f.maxPlayers ?? "?"} <small className="font-semibold" style={{ color: C.muted }}>players</small></div>
      <div className="relative mt-1.5 h-2 rounded-[5px] border" style={{ background: C.chipBg, borderColor: C.chipLine }}>
        <div className="absolute -top-px -bottom-px rounded-[5px] border" style={{ left: `${zl.toFixed(1)}%`, width: `${zw.toFixed(1)}%`, background: C.mint, borderColor: "#bfe4cf" }} />
        {r.fill != null && (
          <div className="absolute -top-1 h-3.5 w-[3px] rounded-[2px]" style={{ left: `calc(${Math.min(100, (r.fill / span) * 100).toFixed(1)}% - 1.5px)`, background: low ? C.warnInk : C.forest }} />
        )}
      </div>
      <div className="mt-[5px] text-[10.5px]" style={low ? { color: C.warnInk, fontWeight: 700 } : { color: C.muted }}>
        {r.fill == null
          ? (r.matches ? `only ${r.matches} match${r.matches === 1 ? "" : "es"} — too few to call a typical fill` : "no matches to average")
          : `typically ${r.fill.toFixed(1)}${low ? " — under the minimum" : ""}`}
      </div>
    </>
  );
}

function Spark({ r }: { r: FieldRow }) {
  if (!r.matches) return <div className="text-[11.5px]" style={{ color: C.muted }}>No matches in {TRAIL_WEEKS} weeks</div>;
  const mx = Math.max(...r.wk.map((x) => x.m));
  return (
    <>
      <div className="flex h-[26px] items-end gap-[2px]" title={r.wk.map((x, i) => `wk ${i + 1}: ${x.m} match${x.m === 1 ? "" : "es"}`).join(" · ")}>
        {r.wk.map((x, i) => {
          const h = x.m ? Math.max(4, Math.round((x.m / mx) * 26)) : 2;
          return <i key={i} className="block w-[6px] rounded-t-[2px]" style={{ height: h, background: x.m ? C.accent : C.chipLine, opacity: x.m ? 0.85 : 1 }} />;
        })}
      </div>
      <div className="mt-[5px] text-[10.5px]" style={{ color: C.muted }}><b>{r.matches}</b> match{r.matches === 1 ? "" : "es"} · peak <b>{mx}</b> a week</div>
    </>
  );
}

function Tel({ value, pretty }: { value: string; pretty?: boolean }) {
  const link = contactLink(value);
  const display = pretty ? formatE164UsPretty(value) : (link?.kind === "phone" ? formatPhoneDisplay(value) : value);
  if (!link) return <span className="text-[12px]" style={{ color: C.muted }}>{value}</span>;
  return (
    <a href={link.href} className="inline-block min-w-[44px] py-[3px] text-[12px] font-bold tabular-nums" style={{ color: C.ok }}>{display}</a>
  );
}

function Tile({ label, big, small, note, dataFo }: { label: string; big: string; small?: string; note: React.ReactNode; dataFo?: string }) {
  return (
    <div className="rounded-[12px] border p-4" style={{ background: C.surface, borderColor: C.line }}>
      <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>{label}</div>
      <div data-fo={dataFo} className="mt-1.5 text-[30px] font-[800] leading-none tracking-[-1px]" style={{ color: C.ink }}>
        {big}{small && <small className="ml-1 text-[15px] font-bold" style={{ color: C.muted }}>{small}</small>}
      </div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>{note}</div>
    </div>
  );
}

// ============================================================
// Add / Edit modal + delete — the EXISTING fin_venues edit path, unchanged.
// ============================================================
const inputCls =
  "w-full rounded-lg border border-cream-line bg-white px-3 py-2.5 text-sm font-semibold text-deep-green placeholder:text-deep-green/30 focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint-soft/60";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function CmPhoneLink({ phone }: { phone: string | null }) {
  if (!phone) return null;
  const link = contactLink(phone);
  if (!link) return null;
  return <a href={link.href} className="inline-flex items-center gap-1 tabular-nums text-deep-green/70 underline decoration-cream-line underline-offset-2">{formatE164UsPretty(phone)}</a>;
}

function FieldModal({ state, roster, saving, error, onChange, onClose, onSave }: {
  state: NonNullable<ModalState>; roster: CityManagerRoster; saving: boolean; error: string | null;
  onChange: (form: FieldFormInput) => void; onClose: () => void; onSave: () => void;
}) {
  const f = state.form;
  const set = (patch: Partial<FieldFormInput>) => onChange({ ...f, ...patch });
  const derivedCM = cityManagerFor(f.city, roster);
  const derivedCMPhone = cityManagerPhoneFor(f.city, roster);
  const cmUnassigned = derivedCM === UNASSIGNED_CITY_MANAGER;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="w-full max-w-xl overflow-hidden rounded-2xl border border-cream-line bg-white shadow-xl shadow-deep-green/25">
        <div className="flex items-center justify-between border-b border-cream-line/70 px-6 py-4">
          <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">{state.mode === "add" ? "Add field" : `Edit field · ${state.name}`}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg border border-cream-line text-deep-green/45 transition hover:bg-cream-soft"><X aria-hidden size={17} /></button>
        </div>
        <div className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-2">
          <Labeled label="Field" required><input value={f.venue_name} onChange={(e) => set({ venue_name: e.target.value })} placeholder="ATH Pearland" className={inputCls} /></Labeled>
          <Labeled label="City" required>
            <select value={f.city} onChange={(e) => set({ city: e.target.value })} className={inputCls}>
              {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Labeled>
          <Labeled label="Field Contact Name"><input value={f.contact_name} onChange={(e) => set({ contact_name: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label="Field Contact" hint="Phone or email"><input value={f.contact_number} onChange={(e) => set({ contact_number: e.target.value })} placeholder="Phone or email" className={inputCls} /></Labeled>
          <Labeled label="Min Players"><input inputMode="numeric" value={f.min_players} onChange={(e) => set({ min_players: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label="Max Players"><input inputMode="numeric" value={f.max_players} onChange={(e) => set({ max_players: e.target.value })} className={inputCls} /></Labeled>
          <div className="sm:col-span-2">
            <Labeled label="City Manager" hint="Auto-filled from City">
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-cream-line bg-cream-soft/50 px-3 py-2.5 text-sm">
                {cmUnassigned ? <span className="font-semibold text-deep-green/35">Unassigned</span> : (
                  <><span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-deep-green text-[9.5px] font-extrabold text-mint-soft">{initials(derivedCM)}</span><span className="font-bold text-deep-green">{derivedCM}</span>{derivedCMPhone && <span className="ml-2 text-[12px]"><CmPhoneLink phone={derivedCMPhone} /></span>}</>
                )}
                <span className="ml-auto text-[11px] font-semibold text-deep-green/35">from {f.city}</span>
              </div>
            </Labeled>
          </div>
          <div className="sm:col-span-2">
            <Labeled label="Schedule link (Google Drive)" hint="Opens in a new tab from the Schedule column"><input value={f.schedule_url} onChange={(e) => set({ schedule_url: e.target.value })} placeholder="https://drive.google.com/…" className={inputCls} /></Labeled>
          </div>
        </div>
        {error && <p className="mx-6 rounded-lg bg-coral-soft/50 px-3 py-2 text-xs font-medium text-coral-hover">{error}</p>}
        <div className="mt-1 flex justify-end gap-2 border-t border-cream-line/70 bg-cream-soft/40 px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-xl border border-cream-line bg-white px-4 py-2 text-sm font-bold text-deep-green/70 transition hover:bg-cream-soft">Cancel</button>
          <button type="button" onClick={onSave} disabled={saving} className="rounded-xl bg-mint px-5 py-2 text-sm font-extrabold text-deep-green transition hover:bg-mint-hover disabled:opacity-50">{saving ? "Saving…" : "Save field"}</button>
        </div>
      </div>
    </div>
  );
}
function Labeled({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-extrabold uppercase tracking-wide text-deep-green/50">{label}{required && <span className="text-mint-hover"> *</span>}</span>
      {children}
      {hint && <span className="text-[11px] text-deep-green/35">{hint}</span>}
    </label>
  );
}
function ConfirmDelete({ venue, saving, onCancel, onConfirm }: { venue: RawVenue; saving: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep-green/30 px-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-cream-line bg-white p-6 shadow-xl shadow-deep-green/25">
        <h2 className="font-display text-xl uppercase tracking-tight text-deep-green">Deactivate field</h2>
        <p className="mt-3 text-sm text-deep-green/75">Remove <span className="font-bold">{venue.venue_name}</span> ({venue.city}) from active fields? Its match history is preserved — the field is deactivated, not deleted, so nothing is orphaned. You can re-add it later.</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-xl border border-cream-line bg-white px-4 py-2 text-sm font-bold text-deep-green/70 transition hover:bg-cream-soft">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={saving} className="rounded-xl bg-coral px-5 py-2 text-sm font-extrabold text-white transition hover:bg-coral-hover disabled:opacity-50">{saving ? "Deactivating…" : "Deactivate"}</button>
        </div>
      </div>
    </div>
  );
}
