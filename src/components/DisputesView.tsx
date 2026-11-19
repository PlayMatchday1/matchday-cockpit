"use client";

// Disputes: Match Ops › Daily Ops › Disputes (Ryan, 2026-11-18; Figma "Disputes · open dispute selected").
// Stripe chargebacks on the US account, matched to members, with the evidence we hold for the SELECTED
// dispute only. Read only: nothing here writes to Stripe. "Copy evidence" puts a plain-text packet on the
// clipboard and records the copy in the change log; "Open in Stripe" is where staff submit.
//
// THE EVIDENCE COLUMN IS FILLED ONLY FOR DISPUTES OPENED IN THIS VISIT. The design shows a verdict on
// every row, but a verdict needs the backend evidence read, and that read is made for the selected dispute
// alone (no fan-out per row). Rows not yet opened say "Open to check", not a guess.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  checklist, verdictOf, evidenceText, reasonLabel, money, centralDay, daysUntil, STATUS_LABEL,
  type DisputeRow, type DisputeEvidence, type DisputeBucket, type Verdict,
} from "@/lib/disputesModel";

type ListResp = {
  readAt: string;
  tabs: Record<DisputeBucket, DisputeRow[]>;
  cards: { needsResponse: number; nextDueBy: string | null; underReview: number; won90: { count: number; cents: number }; lost90: { count: number; cents: number } };
};
type Detail = { row: DisputeRow; evidence: DisputeEvidence | null; logged: boolean };

const C = { ink: "#0f2a22", muted: "#6b7d74", line: "#e3e9e5", dark: "#0f3d2e", green: "#1f7a4d", red: "#b42318", amber: "#9a6b00" };
const STRIPE = "https://dashboard.stripe.com";

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store" });
}

const TABS: { key: DisputeBucket; label: string }[] = [
  { key: "needs_response", label: "Needs response" },
  { key: "under_review", label: "Under review" },
  { key: "closed", label: "Closed" },
];

function dueText(r: DisputeRow): { main: string; sub: string; color: string } {
  if (r.bucket === "closed") return { main: STATUS_LABEL[r.status] ?? r.status, sub: centralDay(r.createdAt), color: r.status === "won" ? C.green : r.status === "lost" ? C.red : C.ink };
  if (!r.dueBy) return { main: r.bucket === "under_review" ? "Bank deciding" : "No due date", sub: "", color: C.ink };
  const n = daysUntil(r.dueBy);
  const main = r.bucket === "under_review" ? "Bank deciding" : n < 0 ? "Past due" : n === 0 ? "Due today" : n === 1 ? "Tomorrow" : `In ${n} days`;
  const color = r.bucket === "under_review" ? C.ink : n <= 3 ? C.red : n <= 7 ? C.amber : C.ink;
  return { main, sub: r.bucket === "under_review" ? `submitted · was due ${centralDay(r.dueBy)}` : centralDay(r.dueBy), color };
}

function Pill({ tone, children }: { tone: Verdict["tone"] | "muted"; children: React.ReactNode }) {
  const s = tone === "strong" ? { background: "#e3f4ea", color: C.green }
    : tone === "error" || tone === "weak" ? { background: "#fbe4e2", color: C.red }
    : { background: "#eef1ef", color: C.muted };
  return <span className="inline-block whitespace-nowrap rounded-full px-[8px] py-[2px] text-[11.5px] font-semibold" style={s}>{children}</span>;
}

export default function DisputesView() {
  const [list, setList] = useState<ListResp | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [tab, setTab] = useState<DisputeBucket>("needs_response");
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [copyState, setCopyState] = useState<string | null>(null);

  const load = useCallback(async (fresh = false) => {
    setListErr(null);
    try {
      const r = await authFetch(`/api/disputes${fresh ? "?fresh=1" : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setList(j as ListResp);
    } catch (e) { setListErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // ?d=dp_… (the Change Log's link) selects that dispute and its tab once the list is in.
  useEffect(() => {
    if (!list) return;
    const want = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("d") : null;
    const all = [...list.tabs.needs_response, ...list.tabs.under_review, ...list.tabs.closed];
    const hit = want ? all.find((r) => r.id === want) : null;
    if (hit) { setTab(hit.bucket); setSelected(hit.id); return; }
    if (!selected) {
      const first = list.tabs.needs_response[0] ?? list.tabs.under_review[0] ?? null;
      if (first) { setTab(first.bucket); setSelected(first.id); }
    }
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected || details[selected]) return;
    let gone = false;
    setLoadingDetail(true); setDetailErr(null); setCopyState(null);
    (async () => {
      try {
        const r = await authFetch(`/api/disputes/${encodeURIComponent(selected)}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (!gone) setDetails((d) => ({ ...d, [selected]: j as Detail }));
      } catch (e) { if (!gone) setDetailErr(e instanceof Error ? e.message : String(e)); }
      finally { if (!gone) setLoadingDetail(false); }
    })();
    return () => { gone = true; };
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = list?.tabs[tab] ?? [];
  const detail = selected ? details[selected] : undefined;
  const selRow = detail?.row ?? (selected && list ? [...list.tabs.needs_response, ...list.tabs.under_review, ...list.tabs.closed].find((r) => r.id === selected) : undefined);

  const copy = async () => {
    if (!detail?.evidence) return;
    const text = evidenceText(detail.row, detail.evidence);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setCopyState("The browser would not copy. Nothing was logged."); return;
    }
    setCopyState("Copied. Paste each section into its field in Stripe.");
    try {
      const r = await authFetch(`/api/disputes/${encodeURIComponent(detail.row.id)}/copy`, { method: "POST" });
      if (!r.ok) setCopyState("Copied, but the copy was NOT recorded in the change log.");
    } catch { setCopyState("Copied, but the copy was NOT recorded in the change log."); }
  };

  return (
    <div className="flex flex-col gap-[18px] p-[16px] lg:flex-row lg:items-start lg:p-[24px]" style={{ color: C.ink }}>
      <div className="min-w-0 flex-1">
        <div className="mb-[16px] flex flex-wrap items-center gap-[14px]">
          <h1 className="text-[24px] font-bold" style={{ color: C.dark }}>Disputes</h1>
          <a href={`${STRIPE}/disputes`} target="_blank" rel="noreferrer" className="rounded-[9px] border bg-white px-[14px] py-[7px] text-[13.5px] font-semibold" style={{ borderColor: C.line }}>Open in Stripe ↗</a>
          <button onClick={() => void load(true)} className="ml-auto text-[12.5px] underline" style={{ color: C.muted }}>
            {list ? `Read ${new Date(list.readAt).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} · refresh` : "Refresh"}
          </button>
        </div>

        {listErr && <div className="mb-[14px] rounded-[10px] border px-[14px] py-[10px] text-[13px]" style={{ borderColor: "#f3c1bc", background: "#fdf1f0", color: C.red }}>Could not read disputes from Stripe: {listErr}</div>}

        <div className="mb-[16px] grid grid-cols-2 gap-[16px] rounded-[12px] border bg-white px-[16px] py-[14px] sm:grid-cols-4" style={{ borderColor: C.line }}>
          {[
            { k: "Needs a response", v: list?.cards.needsResponse, s: list?.cards.nextDueBy ? `next due ${(() => { const n = daysUntil(list.cards.nextDueBy); return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`; })()}` : list ? "none due" : "", c: C.red },
            { k: "Under review", v: list?.cards.underReview, s: "bank deciding", c: C.ink },
            { k: "Won · 90 days", v: list?.cards.won90.count, s: list ? money(list.cards.won90.cents) : "", c: C.green },
            { k: "Lost · 90 days", v: list?.cards.lost90.count, s: list ? money(list.cards.lost90.cents) : "", c: C.muted },
          ].map((x) => (
            <div key={x.k}>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: C.muted }}>{x.k}</div>
              <div className="text-[20px] font-bold tabular-nums" style={{ color: x.c }}>{x.v ?? "–"}</div>
              <div className="text-[12px]" style={{ color: C.muted }}>{x.s}</div>
            </div>
          ))}
        </div>

        <div className="mb-[12px] flex flex-wrap gap-[8px]">
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)} className="rounded-full border px-[13px] py-[6px] text-[13.5px] font-semibold"
                style={on ? { background: C.dark, color: "#fff", borderColor: C.dark } : { background: "#fff", borderColor: C.line }}>
                {t.label} <span className="ml-[4px] font-medium" style={{ color: on ? "#7fe0ab" : C.muted }}>{list ? list.tabs[t.key].length : ""}</span>
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto rounded-[12px] border bg-white" style={{ borderColor: C.line }}>
          <table className="w-full min-w-[640px] text-left text-[13.5px]">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-[0.08em]" style={{ color: C.muted, background: "#eef2ef" }}>
                <th className="px-[16px] py-[10px] font-semibold">{tab === "closed" ? "Outcome" : "Due"}</th>
                <th className="px-[12px] py-[10px] font-semibold">Member</th>
                <th className="px-[12px] py-[10px] font-semibold">Charge</th>
                <th className="px-[12px] py-[10px] font-semibold">Reason</th>
                <th className="px-[12px] py-[10px] font-semibold">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {!list && !listErr && <tr><td colSpan={5} className="px-[16px] py-[18px]" style={{ color: C.muted }}>Reading Stripe…</td></tr>}
              {list && rows.length === 0 && <tr><td colSpan={5} className="px-[16px] py-[18px]" style={{ color: C.muted }}>Nothing here.</td></tr>}
              {rows.map((r) => {
                const on = r.id === selected;
                const d = dueText(r);
                const seen = details[r.id];
                const v = seen ? verdictOf(seen.row, seen.evidence) : null;
                return (
                  <tr key={r.id} onClick={() => setSelected(r.id)} className="cursor-pointer border-t" style={{ borderColor: C.line, background: on ? "#eef8f1" : undefined, boxShadow: on ? "inset 3px 0 0 #35c77f" : undefined }}>
                    <td className="px-[16px] py-[10px]"><div className="font-semibold" style={{ color: d.color }}>{d.main}</div><div className="text-[12px]" style={{ color: C.muted }}>{d.sub}</div></td>
                    <td className="px-[12px] py-[10px]">
                      {r.member
                        ? <><div className="font-semibold">{r.member.name ?? `Player ${r.member.userId}`}</div><div className="text-[12px]" style={{ color: C.muted }}>{r.member.city ?? ""}</div></>
                        : <><div style={{ color: C.muted }}>Not matched to a member</div><a onClick={(e) => e.stopPropagation()} href={`${STRIPE}/disputes/${r.id}`} target="_blank" rel="noreferrer" className="text-[12px] underline" style={{ color: C.muted }}>Open in Stripe ↗</a></>}
                    </td>
                    <td className="px-[12px] py-[10px]"><div className="tabular-nums">{money(r.amountCents)}</div><div className="text-[12px]" style={{ color: C.muted }}>{r.chargedAt ? `charged ${centralDay(r.chargedAt)}` : ""}</div></td>
                    <td className="px-[12px] py-[10px]">{reasonLabel(r.reason)}</td>
                    <td className="px-[12px] py-[10px]">{v ? <Pill tone={v.tone}>{v.label}</Pill> : <span className="text-[12px]" style={{ color: C.muted }}>Open to check</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <aside className="w-full rounded-[14px] border bg-white lg:sticky lg:top-[16px] lg:w-[400px] lg:flex-none" style={{ borderColor: C.line }}>
        {!selRow ? (
          <div className="p-[20px] text-[13.5px]" style={{ color: C.muted }}>{list ? "Pick a dispute." : "…"}</div>
        ) : (
          <DetailPanel row={selRow} detail={detail} loading={loadingDetail && !detail} err={detail ? null : detailErr} onCopy={copy} copyState={copyState} />
        )}
      </aside>
    </div>
  );
}

function DetailPanel({ row, detail, loading, err, onCopy, copyState }: {
  row: DisputeRow; detail: Detail | undefined; loading: boolean; err: string | null; onCopy: () => void; copyState: string | null;
}) {
  const ev = detail?.evidence ?? null;
  const r = detail?.row ?? row;
  const verdict = detail ? verdictOf(r, ev) : null;
  const items = useMemo(() => (ev ? checklist(ev) : []), [ev]);
  const found = items.filter((i) => i.found).length;
  const due = r.dueBy && r.bucket === "needs_response" ? `Due ${centralDay(r.dueBy)}` : STATUS_LABEL[r.status] ?? r.status;
  const vStyle = verdict?.tone === "strong" ? { background: "#e3f4ea", color: C.green }
    : verdict?.tone === "error" || verdict?.tone === "weak" ? { background: "#fdf1f0", color: C.red }
    : { background: "#f1f4f2", color: C.muted };

  return (
    <div>
      <div className="border-b p-[20px]" style={{ borderColor: C.line }}>
        <div className="flex flex-wrap items-center gap-[10px]">
          <h2 className="text-[20px] font-bold" style={{ color: C.dark }}>{r.member ? r.member.name ?? `Player ${r.member.userId}` : "Not matched to a member"}</h2>
          <Pill tone={r.bucket === "needs_response" ? "error" : "muted"}>{due}</Pill>
        </div>
        <div className="mt-[4px] text-[13px]" style={{ color: C.muted }}>
          {money(r.amountCents)}{r.chargedAt ? ` charged ${centralDay(r.chargedAt)}` : ""} · Reason: {reasonLabel(r.reason).toLowerCase()}
        </div>
        {loading && <div className="mt-[12px] text-[13px]" style={{ color: C.muted }}>Reading the evidence…</div>}
        {err && <div className="mt-[12px] text-[13px]" style={{ color: C.red }}>{err}</div>}
        {verdict && (
          <div className="mt-[12px] rounded-[10px] px-[12px] py-[10px]" style={vStyle}>
            <div className="text-[14px] font-bold">{verdict.title}</div>
            <div className="text-[12.5px]">{verdict.body}</div>
          </div>
        )}
        {ev?.backendNote && <div className="mt-[8px] text-[12px]" style={{ color: C.amber }}>{ev.backendNote}</div>}
      </div>

      {ev && (
        <div className="border-b p-[20px]" style={{ borderColor: C.line }}>
          <div className="mb-[10px] text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: C.muted }}>Evidence <span className="ml-[10px] normal-case tracking-normal">{found} of {items.length} found</span></div>
          <div className="flex flex-col gap-[8px]">
            {items.map((i) => (
              <div key={i.key} className="flex gap-[10px] rounded-[10px] px-[12px] py-[10px]" style={i.found ? { background: "#f3f6f4" } : { border: `1px solid ${C.line}` }}>
                <span className="w-[12px] flex-none font-bold" style={{ color: i.found ? (i.partial ? C.amber : C.green) : C.muted }}>{i.found ? "✓" : "—"}</span>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold">{i.title}</div>
                  <div className="break-words text-[12.5px]" style={{ color: C.muted }}>{i.detail}</div>
                  {i.key === "terms" && ev.terms && (ev.terms.ipAddress || ev.terms.userAgent) && (
                    <div className="mt-[2px] break-all text-[11.5px]" style={{ color: C.muted }}>{[ev.terms.ipAddress && `IP ${ev.terms.ipAddress}`, ev.terms.userAgent].filter(Boolean).join(" · ")}</div>
                  )}
                  {i.key === "cancel" && ev.cancel && (ev.cancel.ipAddress || ev.cancel.userAgent) && (
                    <div className="mt-[2px] break-all text-[11.5px]" style={{ color: C.muted }}>{[ev.cancel.ipAddress && `IP ${ev.cancel.ipAddress}`, ev.cancel.userAgent].filter(Boolean).join(" · ")}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="p-[20px]">
        <div className="mb-[6px] text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: C.muted }}>Respond</div>
        <div className="mb-[12px] text-[12.5px]" style={{ color: C.muted }}>
          {ev ? "Builds the packet with each piece in its Stripe evidence field. You review it in Stripe and submit there."
            : "No membership evidence to copy for this dispute. Respond from Stripe."}
        </div>
        <div className="flex gap-[10px]">
          <button onClick={onCopy} disabled={!ev} title={ev ? undefined : "Copy evidence needs a matched membership charge"}
            className="flex-1 rounded-[9px] border bg-white px-[12px] py-[9px] text-[13.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-45" style={{ borderColor: C.line }}>
            Copy evidence
          </button>
          <a href={`${STRIPE}/disputes/${r.id}`} target="_blank" rel="noreferrer" className="flex-1 rounded-[9px] px-[12px] py-[9px] text-center text-[13.5px] font-semibold text-white" style={{ background: C.dark }}>Open in Stripe ↗</a>
        </div>
        {copyState && <div className="mt-[8px] text-[12px]" style={{ color: copyState.startsWith("Copied.") ? C.green : C.red }}>{copyState}</div>}
      </div>
    </div>
  );
}
