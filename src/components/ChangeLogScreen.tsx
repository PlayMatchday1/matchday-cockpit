"use client";

// CHANGE LOG 2.0 (Figma 9TgSk4sYqq4nNoTH73wRRs, "Clubhouse · Change Log 2.0", 20860:45).
//
// Every write the Clubhouse has made, as one table: Time, Who, What happened, Area, Result, grouped by
// day. The server does the work (GET /api/changelog → src/lib/changeLogQuery.ts): search, Person, Area,
// outcome and date are applied there over every row in the range, with "Load older" paging. This
// screen only reads, and records a person's finding on a write that needs checking (POST, unchanged:
// it fires NO write to MatchDay and never changes the recorded outcome — there is no retry anywhere).
//
// TEST rows (writes to the staging API, from local test runs) are listed with a tag and left out of
// every count. Syncs are hidden unless "Show syncs" is on.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Copy, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import LogHealthBanner from "@/components/LogHealthBanner";
import { AREAS, engineeringText, matchdaySaid, type Item } from "@/lib/changeLogPresent";
import type { ChangeLogPage } from "@/lib/changeLogQuery";

const INK = "#13241d", MUTED = "#5e6b66", FAINT = "#7c8782", LINE = "#e3e3db", DEEP = "#0e3b2c";

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

type Range = "today" | "7d" | "30d" | "90d" | "all";
const RANGE_LABEL: Record<Range, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", all: "All time" };
function fromFor(r: Range): string | null {
  if (r === "all") return null;
  const d = new Date();
  if (r === "today") { d.setHours(0, 0, 0, 0); return d.toISOString(); }
  return new Date(Date.now() - (r === "7d" ? 7 : r === "30d" ? 30 : 90) * 86_400_000).toISOString();
}
const TZ = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "America/Chicago";
const ymd = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
function dayLabel(key: string): string {
  const today = ymd(new Date().toISOString()), yest = ymd(new Date(Date.now() - 86_400_000).toISOString());
  const noon = new Date(`${key}T12:00:00Z`);
  const long = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(noon);
  return key === today ? `Today · ${long}` : key === yest ? `Yesterday · ${long}` : long;
}

type Outcome = "all" | "needs" | "failed";

export default function ChangeLogScreen() {
  const [q, setQ] = useState(""), [qLive, setQLive] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [person, setPerson] = useState("all");
  const [area, setArea] = useState("all");
  const [range, setRange] = useState<Range>("7d");
  const [syncs, setSyncs] = useState(false);
  const [page, setPage] = useState<ChangeLogPage | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [older, setOlder] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQ(qLive.trim()), 300); return () => clearTimeout(t); }, [qLive]);

  const params = useCallback((before: string | null) => {
    const p = new URLSearchParams({ q, person, area, outcome, tz: TZ, syncs: syncs ? "1" : "0", limit: "60" });
    const from = fromFor(range);
    if (from) p.set("from", from);
    if (before) p.set("before", before);
    return p.toString();
  }, [q, person, area, outcome, range, syncs]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setErr(null);
    try {
      const res = await authFetch(`/api/changelog?${params(null)}`);
      const j = await res.json().catch(() => ({}));
      if (my !== seq.current) return;
      if (!res.ok) { setErr(j?.error ?? `HTTP ${res.status}`); setItems([]); setPage(null); return; }
      setPage(j as ChangeLogPage); setItems((j as ChangeLogPage).items);
    } catch (e) { if (my === seq.current) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (my === seq.current) setLoading(false); }
  }, [params]);
  useEffect(() => { void load(); }, [load]);

  const loadOlder = async () => {
    if (!page?.nextBefore) return;
    setOlder(true);
    try {
      const res = await authFetch(`/api/changelog?${params(page.nextBefore)}`);
      const j = (await res.json().catch(() => null)) as ChangeLogPage | null;
      if (res.ok && j) { setItems((prev) => [...prev, ...j.items]); setPage((p) => (p ? { ...p, nextBefore: j.nextBefore } : j)); }
      else setErr((j as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    } finally { setOlder(false); }
  };

  const resolve = async (it: Item, verdict: "yes" | "no") => {
    setBusy(it.id);
    try {
      for (const p of it.members) {
        const e = p.entry;
        if ((e.outcome === "unknown" || e.outcome === "notapplied") && !e.resolved) {
          await authFetch("/api/changelog", { method: "POST", body: JSON.stringify({ saveId: e.saveId, verdict }) });
        }
      }
      await load();
    } finally { setBusy(null); }
  };
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const days = useMemo(() => {
    const out: { key: string; items: Item[] }[] = [];
    for (const it of items) { const k = ymd(it.at); const d = out[out.length - 1]; if (d && d.key === k) d.items.push(it); else out.push({ key: k, items: [it] }); }
    return out;
  }, [items]);
  const counts = page?.counts ?? { all: 0, needs: 0, failed: 0 };
  const sel = "h-[34px] rounded-[8px] border bg-white pl-3 pr-8 text-[12px] font-medium text-[#13241d] appearance-none";

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pb-12 pt-3 min-[900px]:px-0 min-[900px]:pt-6" data-testid="changelog">
      <header className="flex flex-col gap-1">
        <h1 className="text-[24px] font-bold" style={{ color: INK }}>Change Log</h1>
        <p className="text-[13px]" style={{ color: MUTED }}>Every change the Clubhouse made to MatchDay: what changed, who did it, and whether it landed. Reads aren&apos;t logged.</p>
      </header>

      <div className="flex flex-wrap items-center gap-[10px] rounded-[12px] border bg-white px-3 py-[10px]" style={{ borderColor: LINE }} data-testid="cl-filters">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-[8px] bg-[#f7f7f3] px-3 py-2 min-[1200px]:max-w-[300px]">
          <Search aria-hidden className="h-[15px] w-[15px] text-[#9aa39f]" />
          <input data-testid="cl-search" value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder="Search player, match, code or person"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[#9aa39f] min-[900px]:text-[13px]" style={{ color: INK }} />
        </label>
        <div role="tablist" data-testid="f-out" className="flex gap-[2px] rounded-[9px] bg-[#f3f3ef] p-[3px]">
          {([["all", "All", counts.all, INK], ["needs", "Needs checking", counts.needs, "#a86a00"], ["failed", "Failed", counts.failed, "#b3261e"]] as const).map(([k, label, n, color]) => (
            <button key={k} role="tab" type="button" aria-selected={outcome === k} data-testid={`out-${k}`} onClick={() => setOutcome(k)}
              className="flex items-center gap-[6px] rounded-[7px] px-[10px] py-[6px] text-[12px]"
              style={outcome === k ? { background: "#fff", color, fontWeight: 600, boxShadow: "0 1px 2px rgba(9,30,20,.06)" } : { color, fontWeight: 500 }}>
              {label}<span className="text-[11px] font-semibold" style={{ color: k === "all" ? FAINT : color }} data-testid={`count-${k}`}>{n}</span>
            </button>
          ))}
        </div>
        <Select testId="f-person" value={person} onChange={setPerson} cls={sel}
          options={[["all", "Person: Everyone"], ...(page?.people ?? []).map((p) => [p.key, `${p.name} (${p.n})`] as [string, string]),
            ...(person !== "all" && !(page?.people ?? []).some((p) => p.key === person) ? [[person, person] as [string, string]] : [])]} />
        <Select testId="f-area" value={area} onChange={setArea} cls={sel}
          options={[["all", "Area: Everything"], ...AREAS.filter((a) => a !== "Syncs" || syncs).map((a) => {
            const n = page?.areas.find((x) => x.area === a)?.n ?? 0;
            return [a, `${a}${n ? ` (${n})` : ""}`] as [string, string];
          })]} />
        <Select testId="f-range" value={range} onChange={(v) => setRange(v as Range)} cls={sel}
          options={(Object.keys(RANGE_LABEL) as Range[]).map((r) => [r, RANGE_LABEL[r]] as [string, string])} />
        <label className="flex items-center gap-2 text-[12px] font-medium" style={{ color: MUTED }}>
          <input type="checkbox" data-testid="f-syncs" checked={syncs} onChange={(e) => { setSyncs(e.target.checked); if (!e.target.checked && area === "Syncs") setArea("all"); }} className="h-4 w-4 accent-[#0e3b2c]" />
          Show syncs
        </label>
      </div>

      <LogHealthBanner />

      {counts.needs > 0 && outcome !== "needs" && (
        <div data-testid="needs" className="flex flex-wrap items-center gap-3 rounded-[12px] border bg-[#fff7e0] py-3 pl-4 pr-3" style={{ borderColor: "#f1d690" }}>
          <AlertCircle aria-hidden className="h-[18px] w-[18px] shrink-0 text-[#a86a00]" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-[#5c3d00]" data-testid="needs-count">{counts.needs} change{counts.needs === 1 ? " needs" : "s need"} checking</div>
            <div className="text-[12px] text-[#7a5600]">MatchDay accepted {counts.needs === 1 ? "it" : "them"} but never confirmed. Open each, check what&apos;s there, and mark which way it went.</div>
          </div>
          <button type="button" data-testid="needs-go" onClick={() => setOutcome("needs")} className="shrink-0 rounded-[8px] border bg-white px-3 py-[7px] text-[12px] font-semibold text-[#5c3d00]" style={{ borderColor: "#f1d690" }}>Show these</button>
        </div>
      )}

      <div className="overflow-hidden rounded-[12px] border bg-white" style={{ borderColor: LINE }} data-testid="cl-table">
        <div className="hidden gap-4 bg-[#f7f7f3] px-5 py-[10px] text-[10px] font-semibold tracking-[0.08em] min-[1024px]:flex" style={{ color: FAINT }}>
          <span className="w-[90px] shrink-0">TIME</span><span className="w-[170px] shrink-0">WHO</span><span className="min-w-0 flex-1">WHAT HAPPENED</span>
          <span className="w-[170px] shrink-0">AREA</span><span className="w-[180px] shrink-0">RESULT</span>
        </div>
        {loading && !items.length && <p className="px-5 py-8 text-center text-[13px]" style={{ color: FAINT }} data-testid="loading">Loading the log…</p>}
        {err && <p className="px-5 py-6 text-center text-[13px] text-[#a83120]" data-testid="log-err">Couldn&apos;t load the log: {err}</p>}
        {!loading && !err && !items.length && <p className="px-5 py-8 text-center text-[13px]" style={{ color: FAINT }} data-testid="empty">Nothing matches those filters.</p>}
        <div data-testid="days" className={loading && items.length ? "opacity-60" : ""}>
          {days.map((d) => (
            <section key={d.key} data-testid="cl-day">
              <h2 className="border-t bg-[#fbfbf9] px-5 pb-2 pt-[10px] text-[12px] font-semibold" style={{ color: MUTED, borderColor: LINE }} data-testid="cl-day-label">
                {dayLabel(d.key)} · {(page?.dayCounts[d.key] ?? 0).toLocaleString()} change{(page?.dayCounts[d.key] ?? 0) === 1 ? "" : "s"}
              </h2>
              {d.items.map((it) => <Row key={it.id} it={it} open={open.has(it.id)} busy={busy === it.id} onToggle={() => toggle(it.id)} onResolve={(v) => void resolve(it, v)} />)}
            </section>
          ))}
        </div>
        {page?.nextBefore && (
          <div className="border-t px-5 py-4 text-center" style={{ borderColor: LINE }}>
            <button type="button" data-testid="load-older" disabled={older} onClick={() => void loadOlder()} className="text-[13px] font-semibold disabled:opacity-50" style={{ color: DEEP }}>
              {older ? "Loading…" : "Load older"}
            </button>
          </div>
        )}
      </div>
      <p className="text-[12px]" style={{ color: FAINT }} data-testid="foot">
        {page ? `${page.scannedRows.toLocaleString()} recorded requests in ${RANGE_LABEL[range].toLowerCase()}. ` : ""}Test writes to the staging API are tagged and left out of the counts. Stored in Supabase (change_log); retention is indefinite.
      </p>
    </div>
  );
}

function Select({ value, onChange, options, cls, testId }: { value: string; onChange: (v: string) => void; options: [string, string][]; cls: string; testId: string }) {
  return (
    <span className="relative inline-flex shrink-0">
      <select data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} className={cls} style={{ borderColor: LINE }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-[10px] top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-[#5e6b66]" />
    </span>
  );
}

const PILL: Record<string, { bg: string; fg: string; label: string }> = {
  landed: { bg: "#e3f7ed", fg: DEEP, label: "LANDED" },
  failed: { bg: "#fde8e6", fg: "#b3261e", label: "FAILED" },
  needs: { bg: "#fff1c9", fg: "#8a5a00", label: "NEEDS CHECKING" },
  checkedYes: { bg: "#e3f7ed", fg: DEEP, label: "CHECKED · LANDED" },
  checkedNo: { bg: "#f3f3ef", fg: MUTED, label: "CHECKED · DID NOT" },
};
function resultKey(it: Item): keyof typeof PILL {
  if (it.needs) return "needs";
  if (it.outcome === "failed") return "failed";
  if (it.outcome === "landed") return "landed";
  return it.members.some((p) => p.entry.resolved === "no") ? "checkedNo" : "checkedYes";
}

function Row({ it, open, busy, onToggle, onResolve }: { it: Item; open: boolean; busy: boolean; onToggle: () => void; onResolve: (v: "yes" | "no") => void }) {
  const rk = resultKey(it);
  const pill = PILL[rk];
  const failed = it.outcome === "failed";
  const credit = it.area === "Credits";
  const testLine = credit ? "Local test against the staging API. Not a real player balance." : "Local test against the staging API. Nothing real changed.";
  return (
    <div className="border-t" style={{ borderColor: "#efefe9", background: failed && !it.test ? "#fdf6f4" : undefined }}
      data-testid="entry" data-save={it.id} data-outcome={it.outcome} data-needs={it.needs ? 1 : 0} data-test={it.test ? 1 : 0} data-area={it.area} data-members={it.members.length}>
      <div role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }} aria-expanded={open}
        className="grid cursor-pointer grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-4 py-3 min-[1024px]:flex min-[1024px]:items-start min-[1024px]:gap-4 min-[1024px]:px-5">
        <span className="order-1 text-[12px] font-medium min-[1024px]:order-1 min-[1024px]:w-[90px] min-[1024px]:shrink-0 min-[1024px]:pt-[1px] min-[1024px]:text-[13px]" style={{ color: MUTED }}>
          {clock(it.at)}<span className="min-[1024px]:hidden"> · {it.actor.name}</span>
        </span>
        <span className="order-3 hidden items-center gap-2 min-[1024px]:order-2 min-[1024px]:flex min-[1024px]:w-[170px] min-[1024px]:shrink-0" data-testid="entry-who">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
            style={it.actor.system ? { background: "#eef0ee", color: MUTED } : { background: "#e3f7ed", color: DEEP }}>{it.actor.initials}</span>
          <span className="truncate text-[13px] font-medium" style={{ color: INK }}>{it.actor.name}</span>
        </span>
        <span className="order-4 col-span-2 flex min-w-0 flex-col gap-[3px] min-[1024px]:order-3 min-[1024px]:flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold" style={{ color: INK }} data-testid="entry-what">{it.what}</span>
            {it.pill && <span data-testid="entry-pill" className="rounded-full bg-[#eef0ee] px-2 py-[3px] text-[11px] font-semibold" style={{ color: MUTED }}>{it.pill}</span>}
            {it.test && <span data-testid="entry-test" className="rounded-full bg-[#e7f1fb] px-2 py-[2px] text-[10px] font-semibold tracking-[0.04em] text-[#264da6]">TEST</span>}
          </span>
          {it.test ? <span className="text-[12px]" style={{ color: MUTED }}>{testLine}</span> : (
            <>
              {it.sub && <span className="text-[12px]" style={{ color: MUTED }} data-testid="entry-sub">{it.sub}</span>}
              {it.failure && <span className="text-[12px] font-medium" style={{ color: failed ? "#b3261e" : "#8a5a00" }} data-testid="entry-failure">{it.failure}</span>}
            </>
          )}
        </span>
        <span className="order-5 col-span-2 flex flex-col gap-[2px] min-[1024px]:order-4 min-[1024px]:w-[170px] min-[1024px]:shrink-0">
          <span className="text-[13px] font-medium" style={{ color: INK }}>{it.area}<span className="min-[1024px]:hidden" style={{ color: FAINT }}> · {it.source}</span></span>
          <span className="hidden truncate text-[12px] min-[1024px]:block" style={{ color: FAINT }}>{it.source}</span>
        </span>
        <span className="order-2 flex items-center justify-end gap-2 min-[1024px]:order-5 min-[1024px]:w-[180px] min-[1024px]:shrink-0 min-[1024px]:justify-start">
          <span className="whitespace-nowrap rounded-full px-2 py-[3px] text-[10px] font-semibold tracking-[0.04em]" style={{ background: pill.bg, color: pill.fg }} data-testid="entry-state">{pill.label}</span>
          {it.needs && <button type="button" data-testid="entry-check" onClick={(e) => { e.stopPropagation(); if (!open) onToggle(); }} className="rounded-[6px] border bg-white px-2 py-[3px] text-[11px] font-semibold" style={{ borderColor: LINE, color: INK }}>Check</button>}
        </span>
      </div>
      {open && <Details it={it} busy={busy} onResolve={onResolve} />}
    </div>
  );
}

function Box({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 rounded-[10px] border bg-white px-3 py-[10px]" style={{ borderColor: LINE }} data-testid={testId}>
      <div className="mb-1 text-[10px] font-semibold tracking-[0.08em]" style={{ color: FAINT }}>{label}</div>
      <div className="break-words text-[13px]" style={{ color: INK }}>{children}</div>
    </div>
  );
}
const s = (v: unknown) => (v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

function Details({ it, busy, onResolve }: { it: Item; busy: boolean; onResolve: (v: "yes" | "no") => void }) {
  const [copied, setCopied] = useState(false);
  const first = it.members[0].entry;
  const hostLabel = (env: string, endpoint: string) => !endpoint.startsWith("/admin") ? "Clubhouse" : env === "staging" ? "MatchDay staging API" : "MatchDay API";
  const answer = (o: string, serverSaid: string | null | undefined) => {
    const x = matchdaySaid(serverSaid);
    if (o === "failed") return [x.status, x.code].filter(Boolean).join(" · ") || (serverSaid ?? "Failed").split("\n")[0].slice(0, 160);
    if (o === "unknown") return "No answer";
    if (o === "notapplied") return "Accepted · a re-read shows no change";
    return "Accepted · a re-read confirmed it";
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(engineeringText(it)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="flex flex-col gap-3 px-4 pb-4 pt-[2px] min-[1024px]:pl-[302px] min-[1024px]:pr-5" data-testid="details" onClick={(e) => e.stopPropagation()}>
      {it.members.length > 1 && (
        <div className="overflow-hidden rounded-[10px] border bg-white" style={{ borderColor: LINE }} data-testid="details-members">
          {it.members.map((p) => (
            <div key={p.entry.saveId} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-[12px] first:border-t-0" style={{ borderColor: "#efefe9" }} data-testid="details-member">
              <span style={{ color: MUTED }}>{clock(p.entry.at)}</span>
              <span className="min-w-0 flex-1 font-medium" style={{ color: INK }}>{p.described.what}{p.described.sub ? <span className="font-normal" style={{ color: MUTED }}> · {p.described.sub}</span> : null}</span>
              <span className="font-semibold" style={{ color: p.entry.outcome === "landed" ? DEEP : "#b3261e" }}>{answer(p.entry.outcome, p.entry.serverSaid)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 min-[600px]:grid-cols-2 min-[1280px]:grid-cols-4">
        <Box label="CHANGE" testId="details-change">
          {first.changes.length ? first.changes.slice(0, 6).map((c, i) => (
            <div key={i}>{c.field}: {s(c.before)} → {s(c.after)}</div>
          )) : <span style={{ color: MUTED }}>No field changes recorded.</span>}
          {first.changes.length > 6 && <div style={{ color: MUTED }}>and {first.changes.length - 6} more</div>}
        </Box>
        <Box label="SENT TO" testId="details-sent"><span className="font-mono text-[12px]">{first.method} {first.endpoint}</span><div className="text-[12px]" style={{ color: MUTED }}>{hostLabel(first.env, first.endpoint)}</div></Box>
        <Box label={first.endpoint.startsWith("/admin") ? "MATCHDAY SAID" : "RESULT"} testId="details-said"><span className="font-mono text-[12px]">{answer(it.outcome, it.members.find((p) => p.entry.serverSaid)?.entry.serverSaid ?? null)}</span></Box>
        <Box label="LOG ID" testId="details-id"><span className="font-mono text-[12px]" title={first.saveId}>{first.saveId.slice(0, 4)}…{first.saveId.slice(-4)}</span><div className="text-[11px]" style={{ color: MUTED }}>MatchDay sends no request id; this is the Clubhouse save id.</div></Box>
      </div>
      {it.needs && (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] border bg-[#fff7e0] px-3 py-[10px]" style={{ borderColor: "#f1d690" }} data-testid="resolve">
          <span className="min-w-[220px] flex-1 text-[12px] text-[#5c3d00]">
            {it.outcome === "unknown" ? "MatchDay never answered, so this may or may not have happened. Open it and look: did the change stick?" : "MatchDay accepted this and a re-read showed nothing changed. Open it and confirm what's actually there."}
          </span>
          <button type="button" data-testid="resolve-yes" disabled={busy} onClick={() => onResolve("yes")} className="rounded-[8px] border bg-white px-3 py-[6px] text-[12px] font-semibold disabled:opacity-50" style={{ borderColor: "#a9e3c6", color: DEEP }}>It landed</button>
          <button type="button" data-testid="resolve-no" disabled={busy} onClick={() => onResolve("no")} className="rounded-[8px] border bg-white px-3 py-[6px] text-[12px] font-semibold disabled:opacity-50" style={{ borderColor: "#e9b6ac", color: "#a83120" }}>It did not</button>
        </div>
      )}
      {it.members.some((p) => p.entry.resolved) && (
        <p className="text-[12px]" style={{ color: MUTED }} data-testid="resolved-note">
          {it.members.filter((p) => p.entry.resolved).map((p) => `Checked by ${p.entry.resolvedBy ?? "someone"}${p.entry.resolvedAt ? ` at ${clock(p.entry.resolvedAt)}` : ""}: ${p.entry.resolved === "yes" ? "it landed" : "it did not happen"}.`).join(" ")} The recorded outcome is unchanged.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {it.link && <a href={it.link.href} data-testid="details-link" className="rounded-[8px] px-[14px] py-2 text-[12px] font-semibold text-white" style={{ background: DEEP }}>{it.link.label}</a>}
        <button type="button" data-testid="details-copy" onClick={() => void copy()} className="inline-flex items-center gap-1.5 rounded-[8px] border bg-white px-[14px] py-2 text-[12px] font-semibold" style={{ borderColor: LINE, color: INK }}>
          {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}{copied ? "Copied" : "Copy details for engineering"}
        </button>
      </div>
    </div>
  );
}
