"use client";

// Admin · Fields — one row per MatchDay FIELD ID, and the mapping onto
// fin_venues that Finance keys every attribution off.
//
// The page SURFACES; a human decides. There is no auto-grouping and no name
// matching anywhere in this file: the rows are sorted by what is unattributed
// and how big it is, the evidence (address, zip, counts, dates, money) is put
// on screen, and nothing is ever preselected.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { CITIES } from "@/lib/types";
import {
  addressPeers,
  NEW_VENUE_BILLING_TYPES,
  previewAssignment,
  RECENT_MONTHS,
  visibleFieldRows,
  type AssignPreview,
  type FieldIdRow,
  type FieldsPayload,
  type VenueOption,
} from "@/lib/fieldIdAdmin";

// THE WRITE PATH IS NOT WIRED YET. The design and the field-ID list go to Ryan
// first (that was the brief), so the dialog computes and shows the whole
// consequence and the commit button is DISABLED with the reason on it. A
// control that looks live and does nothing is the thing we do not ship; a
// control that is visibly off and says why is the thing we do.
const WRITE_ENABLED = false;
const WRITE_DISABLED_REASON =
  "Assignment writes are not enabled yet — the design and the field-ID list go for review first. Everything above is the real consequence, computed from live data.";

const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export default function FieldIdAdminView() {
  const [data, setData] = useState<FieldsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const res = await fetch(`/api/admin/fields${refresh ? "?refresh=1" : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = (await res.json()) as FieldsPayload & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // ONE `now` for the whole render. Deriving it per row would let the 12-month
  // cut fall on different sides of midnight inside a single table.
  const nowMs = useMemo(() => Date.now(), [data]);

  const rows = data?.fields ?? [];
  const visible = useMemo(() => visibleFieldRows(rows, showAll, nowMs), [rows, showAll, nowMs]);
  const unmapped = rows.filter((r) => r.mapping == null);
  const openRow = open == null ? null : rows.find((r) => r.fieldId === open) ?? null;

  return (
    <div className="space-y-4">
      <Summary
        total={rows.length}
        shown={visible.length}
        unmapped={unmapped}
        aggregateAt={data?.aggregateAt ?? null}
        matchRows={data?.matchRows ?? 0}
        playerRows={data?.playerRows ?? 0}
        showAll={showAll}
        onToggle={() => setShowAll((v) => !v)}
        onRefresh={() => void load(true)}
        loading={loading}
      />

      {err && (
        <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">{err}</div>
      )}

      <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-cream-line bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                <th className="px-3 py-3 text-right">Field ID</th>
                <th className="px-3 py-3 text-left">Title (as MatchDay sends it)</th>
                <th className="px-3 py-3 text-left">City</th>
                <th className="px-3 py-3 text-left">Address &amp; zip</th>
                <th className="px-3 py-3 text-right" title="Matches with is_cancelled = false">Live</th>
                <th className="px-3 py-3 text-left">Date range</th>
                <th className="px-3 py-3 text-right" title="DAILY PAID revenue: paid, no promo, non-fake, on a match that was not cancelled">
                  Revenue
                </th>
                <th className="px-3 py-3 text-left">Mapped to</th>
                <th className="px-3 py-3 text-right" />
              </tr>
            </thead>
            <tbody data-testid="fields-tbody">
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-deep-green/50">
                    Reading every match and every paid registration — this takes a few seconds on a cold start.
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-deep-green/50">
                    No field IDs in this window.
                  </td>
                </tr>
              ) : (
                visible.map((r) => <Row key={r.fieldId} r={r} onAssign={() => setOpen(r.fieldId)} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-deep-green/55">
        One row per <strong>field ID</strong>, never per venue — several field IDs pointing at one venue is
        the grouping, and that is already what <code className="text-[11px]">fin_venue_fields</code> holds.
        Unmapped first, then by live match count. Revenue is <strong>DAILY PAID</strong> only (paid, no
        promocode, non-fake, on a match that was not cancelled), summed over the field&apos;s whole history —
        the same definition the partner payouts use. Membership revenue is allocated at city grain and has no
        field to belong to, so it is not here.
      </p>

      {openRow && data && (
        <AssignDialog
          row={openRow}
          all={rows}
          venues={data.venues}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Summary({
  total, shown, unmapped, aggregateAt, matchRows, playerRows, showAll, onToggle, onRefresh, loading,
}: {
  total: number; shown: number; unmapped: FieldIdRow[];
  aggregateAt: string | null; matchRows: number; playerRows: number;
  showAll: boolean; onToggle: () => void; onRefresh: () => void; loading: boolean;
}) {
  const unmappedLive = unmapped.reduce((s, r) => s + r.liveMatches, 0);
  const unmappedRev = unmapped.reduce((s, r) => s + r.dppRevenue, 0);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="text-sm text-deep-green/70">
        <div data-testid="fields-counts">
          <strong className="text-deep-green">{total.toLocaleString()}</strong> field IDs ·{" "}
          <strong className="text-coral" data-testid="unmapped-count">{unmapped.length}</strong> unmapped, carrying{" "}
          <strong className="text-deep-green">{unmappedLive.toLocaleString()}</strong> live matches and{" "}
          <strong className="text-deep-green">{money(unmappedRev)}</strong> that reaches Finance attributed to nothing.
        </div>
        <div className="mt-1 text-xs text-deep-green/50">
          Showing {shown.toLocaleString()} of {total.toLocaleString()}
          {aggregateAt && (
            <>
              {" "}· counts from {matchRows.toLocaleString()} matches and {playerRows.toLocaleString()} paid
              registrations, read {new Date(aggregateAt).toLocaleTimeString()}
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          data-testid="toggle-show-all"
          className="rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
        >
          {showAll ? `Last ${RECENT_MONTHS} months only` : `Show all ${total.toLocaleString()}`}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Re-read every match and registration"
          className="flex items-center gap-1.5 rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-cream-soft disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function Row({ r, onAssign }: { r: FieldIdRow; onAssign: () => void }) {
  const unmappedRow = r.mapping == null;
  return (
    <tr
      data-testid={`field-row-${r.fieldId}`}
      data-mapped={unmappedRow ? "no" : "yes"}
      className={`border-t border-cream-line/40 align-middle ${unmappedRow ? "bg-coral-soft/25" : ""}`}
    >
      <td className="px-3 py-2 text-right font-mono text-[13px] font-bold text-deep-green">{r.fieldId}</td>
      <td className="px-3 py-2 text-deep-green">
        {r.title ?? <span className="text-deep-green/35">—</span>}
        {r.titleVariants > 1 && (
          <span
            className="ml-2 rounded bg-cream-soft px-1.5 py-0.5 text-[10px] font-bold text-deep-green/60"
            title="MatchDay has renamed this field at least once. The title shown is the one on its most recent match."
          >
            renamed
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-deep-green/75">{r.city ?? "—"}</td>
      <td className="px-3 py-2 text-xs leading-tight text-deep-green/65">
        <div>{r.address ?? "—"}</div>
        <div className="text-deep-green/45">{r.zip ?? ""}</div>
      </td>
      <td className="px-3 py-2 text-right text-deep-green" data-testid={`live-${r.fieldId}`}>
        {r.liveMatches.toLocaleString()}
        <div className="text-[10px] leading-tight text-deep-green/45">
          {r.upcomingMatches > 0 && <>{r.upcomingMatches} upcoming · </>}
          {r.cancelledMatches} cancelled
        </div>
      </td>
      <td className="px-3 py-2 text-xs text-deep-green/70">
        {r.firstMatch ? `${r.firstMatch} → ${r.lastMatch}` : <span className="text-deep-green/35">no live match</span>}
      </td>
      <td className="px-3 py-2 text-right text-deep-green" data-testid={`rev-${r.fieldId}`}>
        {money(r.dppRevenue)}
        <div className="text-[10px] leading-tight text-deep-green/45">{r.dppSpots.toLocaleString()} spots</div>
      </td>
      <td className="px-3 py-2 text-sm">
        {r.mapping ? (
          <span className="text-deep-green/80">
            {r.mapping.venueName}{" "}
            <span className="text-deep-green/40">#{r.mapping.venueId}</span>
            {!r.mapping.venueIsActive && <span className="ml-1 text-[10px] text-deep-green/45">(inactive)</span>}
            {r.mapping.countsAsRegularPlay && (
              <span
                className="ml-1 rounded bg-mint/40 px-1.5 py-0.5 text-[10px] font-bold text-deep-green/70"
                title="counts_as_regular_play — this link is exempt from the event marker and its matches DO carry venue cost"
              >
                counts
              </span>
            )}
          </span>
        ) : (
          <span className="font-bold text-coral" data-testid={`unmapped-${r.fieldId}`}>UNMAPPED</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {r.mapping == null && (
          <button
            type="button"
            onClick={onAssign}
            data-testid={`assign-${r.fieldId}`}
            className="rounded-full bg-mint px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
          >
            Assign
          </button>
        )}
      </td>
    </tr>
  );
}

// ── the assignment dialog ───────────────────────────────────────────────────

function AssignDialog({
  row, all, venues, onClose,
}: {
  row: FieldIdRow; all: FieldIdRow[]; venues: VenueOption[]; onClose: () => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  // NOTHING IS PRESELECTED. An empty select is the honest starting state for a
  // page whose whole point is that the mapping is a human decision.
  const [venueId, setVenueId] = useState<string>("");
  const [newName, setNewName] = useState<string>(row.title ?? "");
  const [newCity, setNewCity] = useState<string>("");
  const [newBilling, setNewBilling] = useState<string>("per_match");

  const peers = useMemo(() => addressPeers(row, all), [row, all]);
  const chosen = venues.find((v) => String(v.id) === venueId) ?? null;

  // The new venue is previewed against ITSELF: a venue that does not exist yet
  // has no matches, no revenue and — deliberately — no rate.
  const draft: VenueOption | null =
    mode === "new" && newName.trim() && newCity
      ? {
          id: -1, venueName: newName.trim(), city: newCity, isActive: true,
          billingType: newBilling, perMatchRate: null, costPerMatch: null,
          chargeOnCancel: false, billsPerReservation: false,
          fieldCount: 0, liveMatches: 0, dppRevenue: 0, split: null,
        }
      : null;
  const target = mode === "existing" ? chosen : draft;
  const preview = target ? previewAssignment(row, target) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-deep-green/40 p-6">
      <div className="my-8 w-full max-w-3xl rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight text-deep-green">
              Field {row.fieldId} · {row.title ?? "untitled"}
            </h2>
            <p className="mt-1 text-xs text-deep-green/60">
              {row.city ?? "—"} · {row.address ?? "no address"} {row.zip ?? ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-cream-line px-3 py-1 text-xs font-bold text-deep-green/70 hover:bg-cream-soft"
          >
            Close
          </button>
        </div>

        <dl className="mt-4 grid grid-cols-4 gap-3 rounded-xl border border-cream-line bg-cream-soft/60 p-3 text-sm">
          <Fact label="Live matches" value={row.liveMatches.toLocaleString()} sub={`${row.cancelledMatches} cancelled`} />
          <Fact label="Upcoming" value={row.upcomingMatches.toLocaleString()} sub="already booked" />
          <Fact
            label="Date range"
            value={row.firstMatch ? row.firstMatch : "—"}
            sub={row.lastMatch ? `→ ${row.lastMatch}` : "no live match"}
          />
          <Fact label="Revenue" value={money2(row.dppRevenue)} sub={`${row.dppSpots.toLocaleString()} DAILY PAID spots`} />
        </dl>

        {peers.length > 0 && (
          <div className="mt-4 rounded-xl border border-cream-line p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              Evidence — other field IDs at this address or zip
            </div>
            <ul className="mt-2 space-y-1 text-sm text-deep-green/80">
              {peers.map((p) => (
                <li key={p.fieldId} data-testid={`peer-${p.fieldId}`}>
                  <span className="font-mono text-[12px] font-bold">{p.fieldId}</span> {p.title} ·{" "}
                  {p.mapping ? (
                    <span className="text-deep-green/60">{p.mapping.venueName} #{p.mapping.venueId}</span>
                  ) : (
                    <span className="text-coral">UNMAPPED</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-deep-green/50">
              This is what proved the Lou Fusz and ATH Katy pairs. It is evidence for you to read, not a
              suggestion — nothing below is preselected from it, and no name is matched against anything.
            </p>
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <ModeButton on={mode === "existing"} onClick={() => setMode("existing")} label="Point at an existing venue" />
          <ModeButton on={mode === "new"} onClick={() => setMode("new")} label="Create a new venue from this field" />
        </div>

        {mode === "existing" ? (
          <div className="mt-3">
            <label className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">Venue</label>
            <select
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
              data-testid="venue-select"
              className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green"
            >
              <option value="">— pick a venue —</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.venueName} · {v.city ?? "no city"} · {v.fieldCount} field
                  {v.fieldCount === 1 ? "" : "s"}
                  {v.isActive ? "" : " · inactive"}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">Venue name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                data-testid="new-venue-name"
                className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green"
              />
              <p className="mt-1 text-[10px] leading-tight text-deep-green/45">
                Pre-filled from the field title as a text default. Edit it — this is a name you are choosing,
                not a mapping anything inferred.
              </p>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">City</label>
              <select
                value={newCity}
                onChange={(e) => setNewCity(e.target.value)}
                data-testid="new-venue-city"
                className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green"
              >
                <option value="">— pick a city —</option>
                {CITIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {row.city && !CITIES.includes(row.city as (typeof CITIES)[number]) && (
                <p className="mt-1 text-[10px] leading-tight text-coral" data-testid="city-not-cockpit">
                  MatchDay reports this field in &ldquo;{row.city}&rdquo;, which is not a cockpit city. A partner
                  market put into a cockpit city appears in our reports.
                </p>
              )}
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">Billing type</label>
              <select
                value={newBilling}
                onChange={(e) => setNewBilling(e.target.value)}
                data-testid="new-venue-billing"
                className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green"
              >
                {NEW_VENUE_BILLING_TYPES.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <p className="mt-1 text-[10px] leading-tight text-deep-green/45">
                No rate is set here, deliberately. <code>per_match_rate</code> stays NULL so the pitch reports as
                UNTRACKED rather than free — a $0 rate claims the field costs nothing.
              </p>
            </div>
          </div>
        )}

        {preview ? <PreviewPanel p={preview} /> : (
          <p className="mt-5 rounded-xl border border-dashed border-cream-line px-3 py-6 text-center text-sm text-deep-green/45">
            Pick a venue to see what this assignment will move.
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-3">
          <span className="max-w-xl text-right text-[11px] leading-tight text-deep-green/55" data-testid="write-disabled-reason">
            {WRITE_DISABLED_REASON}
          </span>
          <button
            type="button"
            disabled={!WRITE_ENABLED || !preview}
            title={WRITE_DISABLED_REASON}
            data-testid="commit-assignment"
            className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Commit assignment
          </button>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-deep-green/50">{label}</dt>
      <dd className="text-base font-bold text-deep-green">{value}</dd>
      {sub && <dd className="text-[11px] text-deep-green/50">{sub}</dd>}
    </div>
  );
}

function ModeButton({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? "rounded-full bg-deep-green px-4 py-1.5 text-xs font-bold text-white"
          : "rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green/70 hover:bg-cream-soft"
      }
    >
      {label}
    </button>
  );
}

function PreviewPanel({ p }: { p: AssignPreview }) {
  return (
    <div className="mt-5 rounded-xl border-[1.5px] border-deep-green/15 bg-cream-soft/60 p-4" data-testid="assign-preview">
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
        What this will move — {p.venueName}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-4">
        <div>
          <div className="text-[11px] text-deep-green/55">Matches gained</div>
          <div className="text-xl font-extrabold text-deep-green" data-testid="preview-matches">
            +{p.matchesGained.toLocaleString()}
          </div>
          <div className="text-[11px] text-deep-green/50">
            {p.venueMatchesBefore.toLocaleString()} → {p.venueMatchesAfter.toLocaleString()}
            {p.upcomingGained > 0 && <> · {p.upcomingGained} of them upcoming</>}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-deep-green/55">Revenue that stops being unattributed</div>
          <div className="text-xl font-extrabold text-deep-green" data-testid="preview-revenue">
            +{money2(p.revenueAttributed)}
          </div>
          <div className="text-[11px] text-deep-green/50">
            {money(p.venueRevenueBefore)} → {money(p.venueRevenueAfter)}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-deep-green/55">Cost added at this venue&apos;s current rate</div>
          <div
            className={`text-xl font-extrabold ${p.cost.amount == null ? "text-deep-green/40" : "text-deep-green"}`}
            data-testid="preview-cost"
          >
            {p.cost.amount == null ? "—" : `+${money2(p.cost.amount)}`}
          </div>
          <div className="text-[11px] text-deep-green/50">
            {p.span.first ? `${p.span.first} → ${p.span.last}` : "no live match"}
          </div>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-deep-green/65" data-testid="preview-cost-note">
        {p.cost.note}
      </p>

      {p.eventExclusion && (
        <div className="mt-3 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-[11px] leading-relaxed text-coral" data-testid="preview-event-exclusion">
          <strong>
            {p.eventExclusion.excludedLive} live
            {p.eventExclusion.excludedCancelled > 0 && ` and ${p.eventExclusion.excludedCancelled} cancelled`} match
            {p.eventExclusion.excludedLive + p.eventExclusion.excludedCancelled === 1 ? "" : "es"} carry NO venue cost
          </strong>{" "}
          because this field&apos;s own title fires the event marker (Tourney / Combine / Cup / …). Cost is excluded
          because of the NAME, not because of a fact about the match.
          {p.eventExclusion.wouldHaveBeen != null && (
            <> At this venue&apos;s rate that is <strong>{money2(p.eventExclusion.wouldHaveBeen)}</strong> of cost that will
            not be counted.</>
          )}{" "}
          This is exactly how ATH Pearland&apos;s field 22 sat at $0 for 26 months. The per-link exception is{" "}
          <code>counts_as_regular_play</code> on Finance → Field Costs; assigning here leaves it OFF.
        </div>
      )}

      {p.splitNote && (
        <p className="mt-3 rounded-lg border border-cream-line bg-white px-3 py-2 text-[11px] leading-relaxed text-deep-green/70" data-testid="preview-split">
          {p.splitNote}
        </p>
      )}

      {p.warnings.map((w) => (
        <p key={w} className="mt-2 text-[11px] leading-relaxed text-coral" data-testid="preview-warning">
          {w}
        </p>
      ))}
    </div>
  );
}
