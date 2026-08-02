"use client";

// Match Ops → Partner Dashboards. The index IS the dashboard: a switcher strip
// of every partner + the selected partner's full dashboard underneath, no click
// into a detail view. Admin controls sit ABOVE a labelled seam; below the seam
// is the identical PartnerDashboardView the public route renders (one component,
// two callers). "View as … sees it" zero-heights ALL Clubhouse chrome (not
// visibility:hidden) by portalling the preview to <body> and hiding every other
// body child — so the "no MatchDay navigation" promise is literally true.
//
// The switcher's owed amount is derived from deriveOwed(derivePeriodRows(...)) —
// the SAME rows the table below renders — so index and detail can't disagree.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { generateSlug } from "@/lib/partnerSlug";
import type { PartnerStats, PartnerPaymentInfo, PartnerPaymentCadence, PartnerRevenueModel } from "@/lib/partnerStats";
import { deriveOwed, derivePeriodRows, stateLine, headerLine, todayYmd, type PartnerOwed } from "@/lib/partnerDashboardView";
import PartnerDashboardView from "@/app/partners/[slug]/PartnerDashboardView";

type AdminPartner = {
  id: string; slug: string; partnerName: string; venue: string; city: string | null;
  launchDate: string | null; cadence: PartnerPaymentCadence; revenueModel: PartnerRevenueModel;
  revenueSharePct: number; enabled: boolean; createdAt: string; stats: PartnerStats; payment: PartnerPaymentInfo;
};

const C = {
  forestDeep: "#072a20", forest: "#0d3b2e", accent: "#35c77f", mint: "#e0f2e7", amount: "#e2502b",
  ink: "#12241d", muted: "#6d7b74", ok: "#12704a", chipBg: "#eef3f0", chipLine: "#e2eae5",
  line: "#e6ebe8", surface: "#ffffff", railB: "#f6f9f7", canvas: "#f4efe4",
};
const PARTNER_BASE = "matchday-clubhouse.vercel.app/partners/";

export default function PartnerDashboardsIndex() {
  const [partners, setPartners] = useState<AdminPartner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [viewAs, setViewAs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const load = useCallback(async () => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("Sign in to view partner dashboards."); return; }
    const res = await fetch("/api/partner-dashboards", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setError(json?.error ?? `HTTP ${res.status}`); return; }
    setPartners(json.partners as AdminPartner[]);
    setError(null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const today = todayYmd();
  const owedByPartner = useMemo<Record<string, PartnerOwed>>(() => {
    const m: Record<string, PartnerOwed> = {};
    for (const p of partners ?? []) m[p.slug] = deriveOwed(derivePeriodRows(p.payment, today));
    return m;
  }, [partners, today]);

  // View-as: hide every OTHER <body> child so only the portalled preview has
  // height. Enumerated by walking the DOM, not a hardcoded id list — the nav bar
  // that survived the mockup's first pass was exactly the one nobody listed.
  useEffect(() => {
    if (!viewAs) return;
    const kids = Array.from(document.body.children) as HTMLElement[];
    const prev = kids.map((el) => el.style.display);
    kids.forEach((el) => { if (!el.hasAttribute("data-partner-preview")) el.style.display = "none"; });
    return () => { kids.forEach((el, i) => { el.style.display = prev[i]; }); };
  }, [viewAs]);

  if (error) return <div className="m-4 rounded-xl border p-4 text-sm" style={{ borderColor: "#f0bda9", background: "#fdeae4", color: "#a8391a" }}>{error}</div>;
  if (!partners) return <div className="p-8 text-sm" style={{ color: C.muted }}>Loading partner dashboards…</div>;
  if (partners.length === 0) return <div className="p-8 text-sm" style={{ color: C.muted }}>No partner dashboards yet.</div>;

  const selected = partners.find((p) => p.slug === sel) ?? partners[0];

  const refresh = async () => { setBusy(true); await load(); setBusy(false); };
  const doUpdate = async (id: string, patch: Record<string, unknown>) => {
    setBusy(true);
    const { error: e } = await supabase.from("partner_dashboards").update(patch).eq("id", id);
    if (e) { alert(`Update failed: ${e.message}`); setBusy(false); return; }
    await load(); setBusy(false);
  };
  const doDelete = async (p: AdminPartner) => {
    if (!confirm(`Delete ${p.partnerName}? Their link will 404 immediately.`)) return;
    setBusy(true);
    const { error: e } = await supabase.from("partner_dashboards").delete().eq("id", p.id);
    if (e) { alert(`Delete failed: ${e.message}`); setBusy(false); return; }
    setSel(null); await load(); setBusy(false);
  };
  const addPartner = async () => {
    const name = prompt("Partner name?"); if (!name?.trim()) return;
    const venueIdStr = prompt("Venue id (fin_venues.id)?"); const venueId = Number(venueIdStr);
    if (!Number.isFinite(venueId)) { alert("Invalid venue id"); return; }
    setBusy(true);
    const { error: e } = await supabase.from("partner_dashboards").insert({ slug: generateSlug(name.trim()), venue_id: venueId, partner_name: name.trim(), enabled: true, payment_cadence: "monthly" });
    if (e) { alert(`Add failed: ${e.message}`); setBusy(false); return; }
    await load(); setBusy(false);
  };

  const preview = (
    <div data-partner-preview data-testid="viewas-root" style={{ position: "fixed", inset: 0, overflowY: "auto", background: C.canvas, zIndex: 9999 }}>
      <div data-testid="preview-bar" style={{ background: C.mint, borderBottom: "1px solid #bfe0cd", padding: "10px 16px", display: "flex", alignItems: "center", gap: 11, fontSize: 12.5, fontWeight: 700, color: C.forestDeep }}>
        <span>This is {selected.partnerName}&rsquo;s page as they see it — no admin panel, no other partner, no MatchDay navigation. Their link opens straight to this.</span>
        <span style={{ marginLeft: "auto" }} />
        <button type="button" onClick={() => setViewAs(false)} style={btnDark}>Back to admin view</button>
      </div>
      <div style={{ maxWidth: 1220, margin: "0 auto", padding: "18px 22px 40px" }}>
        <PartnerDashboardView partnerName={selected.partnerName} venue={selected.venue} city={selected.city} launchDate={selected.launchDate} stats={selected.stats} payment={selected.payment} isPublic />
      </div>
    </div>
  );

  return (
    <div className="min-w-0" style={{ color: C.ink }} data-testid="partner-page">
      <style>{`.pd-tiles{grid-template-columns:repeat(5,1fr)}@media(max-width:1420px){.pd-tiles{grid-template-columns:repeat(3,1fr)}}`}</style>

      {/* page header */}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-[27px] font-[900] tracking-[-0.4px]" style={{ color: C.forestDeep }}>Partner Dashboards</h1>
          <p className="mt-1.5 max-w-[760px] text-[13px] font-semibold" style={{ color: C.muted }} data-testid="header-line">
            {plural(partners.length, "venue partner")} {partners.length === 1 ? "has" : "have"} a live dashboard. {headerLine(Object.values(owedByPartner), partners.length)}
          </p>
        </div>
        <button type="button" onClick={addPartner} disabled={busy} style={btnDark}>+ Add partner</button>
      </div>

      {/* ── admin layer (stripped from the partner's page) ── */}
      <div className="mb-3.5 rounded-[13px] p-[13px_14px_12px]" style={{ background: C.forestDeep, color: "#dceade" }}>
        <div className="mb-2.5 flex items-center gap-2.5">
          <span className="rounded-[5px] px-2 py-[3px] text-[9.5px] font-[900] tracking-[1.1px]" style={{ background: C.accent, color: "#04281d" }}>ADMIN</span>
          <span className="text-[11.5px] font-bold" style={{ color: "#9fbfae" }}>Everything in this panel is stripped out of the partner&rsquo;s page. They see only what is below the line.</span>
          <span className="ml-auto" />
          <button type="button" onClick={() => setViewAs(true)} style={btnQuiet}>View as {selected.partnerName} sees it</button>
        </div>

        {/* switcher */}
        <div className="grid grid-cols-1 gap-2.5 min-[1180px]:grid-cols-3">
          {partners.map((p) => {
            const o = owedByPartner[p.slug];
            const on = p.slug === selected.slug;
            return (
              <button key={p.slug} type="button" data-testid="switcher-card" data-slug={p.slug} onClick={() => setSel(p.slug)}
                className="min-h-[74px] rounded-[10px] border p-[9px_11px_10px] text-left"
                style={on ? { background: C.surface, borderColor: C.surface, color: C.ink } : { background: "rgba(255,255,255,.055)", borderColor: "rgba(255,255,255,.14)", color: "#eaf5ec" }}>
                <div className="flex items-center gap-[7px] text-[14px] font-[800]">
                  <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: p.enabled ? C.accent : "#7f8f88" }} />
                  {p.partnerName}
                </div>
                <div className="mt-0.5 text-[11.5px] font-semibold" style={{ color: on ? C.muted : "#9fbfae" }}>{p.city ? `${p.city} · ` : ""}{p.venue} · paid {p.cadence}</div>
                <div data-testid="switcher-state" className="mt-[7px] text-[11.5px] font-[800]" style={{ color: o.owed > 0 ? (on ? C.amount : "#ffc79a") : (on ? C.ok : "#8fd9b4") }}>{stateLine(o)}</div>
              </button>
            );
          })}
        </div>

        {/* controls for the selected partner */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t pt-2.5" style={{ borderTopColor: "rgba(255,255,255,.13)" }}>
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-[8px] border px-2.5 py-1.5 font-mono text-[12px]" style={{ background: "rgba(0,0,0,.28)", borderColor: "rgba(255,255,255,.14)", color: "#bfe0cd" }} data-testid="partner-url">{PARTNER_BASE}{selected.slug}</span>
          <button type="button" style={btnQuiet} onClick={() => navigator.clipboard?.writeText(`https://${PARTNER_BASE}${selected.slug}`)}>Copy link</button>
          <a href={`/partners/${selected.slug}`} target="_blank" rel="noreferrer" style={{ ...btnQuiet, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Open ↗</a>
          <select value={selected.cadence} disabled={busy} onChange={(e) => doUpdate(selected.id, { payment_cadence: e.target.value })} style={{ ...btnQuiet, cursor: "pointer" }} aria-label="Payment cadence">
            <option value="weekly">Cadence: weekly</option>
            <option value="monthly">Cadence: monthly</option>
          </select>
          <button type="button" style={btnWarn} disabled={busy} onClick={() => { if (confirm("Regenerate the link? The old link 404s immediately.")) doUpdate(selected.id, { slug: generateSlug(selected.partnerName) }); }}>Regenerate link</button>
          <button type="button" style={btnWarn} disabled={busy} onClick={() => doUpdate(selected.id, { enabled: !selected.enabled })}>{selected.enabled ? "Disable" : "Enable"}</button>
          <button type="button" style={btnWarn} disabled={busy} onClick={() => doDelete(selected)}>Delete</button>
        </div>
        <div className="mt-2.5 text-[11.5px] font-semibold leading-[1.5]" style={{ color: "#9fbfae" }}>
          Anyone holding the link can open this page — it is the only key, there is no login on it, and it shows this venue and no other. Disabling returns 404 immediately and regenerating does the same to the old link, so both break whatever the partner has bookmarked. The link has been live since {new Date(selected.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}.
        </div>
      </div>

      {/* seam */}
      <div className="mb-3 flex items-center gap-3" data-testid="seam">
        <div className="text-[10.5px] font-[800] tracking-[1.1px]" style={{ color: C.muted }}>BELOW THIS LINE IS EXACTLY WHAT {selected.partnerName.toUpperCase()} SEES AT THEIR LINK</div>
        <div className="h-px flex-1" style={{ background: C.line }} />
      </div>

      {/* the identical partner-facing component */}
      <div data-testid="dashboard-below-seam">
        <PartnerDashboardView partnerName={selected.partnerName} venue={selected.venue} city={selected.city} launchDate={selected.launchDate} stats={selected.stats} payment={selected.payment} isPublic={false} />
      </div>

      {viewAs && mounted && createPortal(preview, document.body)}
    </div>
  );
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${Math.abs(n) === 1 ? one : many ?? one + "s"}`;
}

const btnDark: React.CSSProperties = { background: C.forest, color: "#fff", border: 0, borderRadius: 8, fontWeight: 700, fontSize: 12.5, padding: "7px 12px", cursor: "pointer", minHeight: 30 };
const btnQuiet: React.CSSProperties = { background: "rgba(255,255,255,.09)", color: "#eaf5ec", border: "1px solid rgba(255,255,255,.19)", borderRadius: 8, fontWeight: 700, fontSize: 12.5, padding: "7px 12px", cursor: "pointer", minHeight: 30 };
const btnWarn: React.CSSProperties = { ...btnQuiet, borderColor: "rgba(240,189,169,.5)", color: "#ffd9cb" };
