"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  ExternalLink,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import { generateSlug } from "@/lib/partnerSlug";
import { supabase } from "@/lib/supabase";

// Production base URL hardcoded — the "Copy URL" action's job is to
// hand a URL to a partner, which is always prod regardless of where
// the admin is viewing the page from. Update here if the prod domain
// changes.
const PARTNER_BASE_URL = "https://matchday-clubhouse.vercel.app";

type Venue = {
  id: number;
  venue_name: string;
  city: string | null;
};

type PartnerRow = {
  id: string;
  slug: string;
  venue_id: number;
  partner_name: string;
  enabled: boolean;
  created_at: string;
  payment_start_date: string | null;
  revenue_share_pct: number;
  payment_cadence: "weekly" | "monthly";
};

type PaymentCounts = {
  pending: number;
  paid: number;
  disputed: number;
};

const FMT_DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function partnerUrl(slug: string): string {
  return `${PARTNER_BASE_URL}/partners/${slug}`;
}

// `inline` switches the heading from h1 (page-style) to h2 (section-
// style) so the same component renders cleanly inside another page's
// section flow. Used by /admin/finance to embed the partner list as
// a #partner-dashboards section without disrupting the existing
// section hierarchy on that page.
export default function PartnerDashboardsAdmin({
  inline = false,
}: { inline?: boolean } = {}) {
  const [rows, setRows] = useState<PartnerRow[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [paymentCounts, setPaymentCounts] = useState<
    Map<string, PaymentCounts>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [regenTarget, setRegenTarget] = useState<PartnerRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PartnerRow | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // partner_dashboards: try the Phase C shape first; fall back to
      // the legacy column set if migration 0003 hasn't been applied
      // yet. Same defensive pattern as fetchPartnerBySlug.
      let pdData: PartnerRow[] = [];
      const pdResp = await supabase
        .from("partner_dashboards")
        .select(
          "id, slug, venue_id, partner_name, enabled, created_at, payment_start_date, revenue_share_pct, payment_cadence",
        )
        .order("created_at", { ascending: false });
      if (pdResp.error && pdResp.error.code === "42703") {
        // Try the pre-0005 shape (no payment_cadence), then fall back
        // further to the pre-0003 shape (no payment columns at all).
        const noCadence = await supabase
          .from("partner_dashboards")
          .select(
            "id, slug, venue_id, partner_name, enabled, created_at, payment_start_date, revenue_share_pct",
          )
          .order("created_at", { ascending: false });
        if (noCadence.error && noCadence.error.code === "42703") {
          const legacy = await supabase
            .from("partner_dashboards")
            .select("id, slug, venue_id, partner_name, enabled, created_at")
            .order("created_at", { ascending: false });
          if (legacy.error) throw new Error(legacy.error.message);
          pdData = ((legacy.data ?? []) as Array<
            Omit<
              PartnerRow,
              "payment_start_date" | "revenue_share_pct" | "payment_cadence"
            >
          >).map((r) => ({
            ...r,
            payment_start_date: null,
            revenue_share_pct: 50,
            payment_cadence: "weekly" as const,
          }));
        } else if (noCadence.error) {
          throw new Error(noCadence.error.message);
        } else {
          pdData = ((noCadence.data ?? []) as Array<
            Omit<PartnerRow, "payment_cadence">
          >).map((r) => ({ ...r, payment_cadence: "weekly" as const }));
        }
      } else if (pdResp.error) {
        throw new Error(pdResp.error.message);
      } else {
        pdData = (pdResp.data ?? []) as PartnerRow[];
      }
      setRows(pdData);

      const { data: vn, error: vnErr } = await supabase
        .from("fin_venues")
        .select("id, venue_name, city")
        .order("venue_name");
      if (vnErr) throw new Error(vnErr.message);
      setVenues((vn ?? []) as Venue[]);

      // partner_weekly_payments: empty if table doesn't exist.
      const counts = new Map<string, PaymentCounts>();
      const wpResp = await supabase
        .from("partner_weekly_payments")
        .select("partner_dashboard_id, status");
      if (wpResp.error) {
        // 42P01 / PGRST205 = table missing — leave counts empty.
        if (
          wpResp.error.code !== "42P01" &&
          wpResp.error.code !== "PGRST205"
        ) {
          throw new Error(wpResp.error.message);
        }
      } else {
        for (const r of (wpResp.data ?? []) as Array<{
          partner_dashboard_id: string;
          status: string;
        }>) {
          const c = counts.get(r.partner_dashboard_id) ?? {
            pending: 0,
            paid: 0,
            disputed: 0,
          };
          if (r.status === "paid") c.paid += 1;
          else if (r.status === "disputed") c.disputed += 1;
          else c.pending += 1;
          counts.set(r.partner_dashboard_id, c);
        }
      }
      setPaymentCounts(counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const venueById = useMemo(() => {
    const m = new Map<number, Venue>();
    for (const v of venues) m.set(v.id, v);
    return m;
  }, [venues]);

  async function handleCopy(slug: string) {
    try {
      await navigator.clipboard.writeText(partnerUrl(slug));
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug((s) => (s === slug ? null : s)), 1500);
    } catch {
      // Clipboard API can fail under non-HTTPS or restricted contexts
      // — fall back to a temporary input + execCommand.
      const ta = document.createElement("textarea");
      ta.value = partnerUrl(slug);
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopiedSlug(slug);
        setTimeout(() => setCopiedSlug((s) => (s === slug ? null : s)), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  async function handleToggle(row: PartnerRow) {
    const { error } = await supabase
      .from("partner_dashboards")
      .update({ enabled: !row.enabled })
      .eq("id", row.id);
    if (error) {
      // 23505 = unique_violation on the partial index — surface a
      // friendly message instead of the raw constraint name.
      if (error.code === "23505") {
        alert(
          "Can't enable: another partner dashboard for the same venue is already active. Disable that one first.",
        );
      } else {
        alert(`Update failed: ${error.message}`);
      }
      return;
    }
    await load();
  }

  async function handleRegenerate(row: PartnerRow) {
    const newSlug = generateSlug(row.partner_name);
    const { error } = await supabase
      .from("partner_dashboards")
      .update({ slug: newSlug })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    await load();
  }

  async function handleDelete(row: PartnerRow) {
    const { error } = await supabase
      .from("partner_dashboards")
      .delete()
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    await load();
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          {inline ? (
            <h2 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green md:text-4xl">
              Partner Dashboards
            </h2>
          ) : (
            <h1 className="font-display text-4xl uppercase leading-none tracking-tight text-deep-green md:text-5xl">
              Partner Dashboards
            </h1>
          )}
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            Manage tokenized partner-facing dashboards. Each partner sees
            only their venue&apos;s data.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-mint px-3 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover"
        >
          <Plus size={16} aria-hidden /> Add Partner
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft px-4 py-3 text-sm text-coral">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <table className="w-full text-sm">
          <thead className="bg-cream-soft/60 text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
            <tr>
              <th className="px-4 py-3 text-left">Partner name</th>
              <th className="px-4 py-3 text-left">Venue</th>
              <th className="px-4 py-3 text-left">Slug</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-deep-green/50"
                >
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-deep-green/50"
                >
                  No partner dashboards yet. Click &ldquo;Add Partner&rdquo; to create one.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => {
                const v = venueById.get(r.venue_id);
                const venueLabel = v
                  ? `${v.city ? v.city + " · " : ""}${v.venue_name}`
                  : `(venue #${r.venue_id} — not found)`;
                const isCopied = copiedSlug === r.slug;
                return (
                  <tr
                    key={r.id}
                    className={i > 0 ? "border-t border-cream-line" : ""}
                  >
                    <td className="px-4 py-3 font-medium text-deep-green">
                      <div>{r.partner_name}</div>
                      <PaymentStatusSummary
                        startDate={r.payment_start_date}
                        cadence={r.payment_cadence}
                        counts={paymentCounts.get(r.id)}
                      />
                    </td>
                    <td className="px-4 py-3 text-deep-green/80">{venueLabel}</td>
                    <td className="px-4 py-3 font-mono text-xs text-deep-green/70">
                      {r.slug}
                    </td>
                    <td className="px-4 py-3">
                      {r.enabled ? (
                        <span className="inline-block rounded-full bg-mint-soft px-2.5 py-0.5 text-[11px] font-semibold text-mint-hover">
                          Enabled
                        </span>
                      ) : (
                        <span className="inline-block rounded-full bg-muted-soft px-2.5 py-0.5 text-[11px] font-semibold text-muted">
                          Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-deep-green/65">
                      {FMT_DATE.format(new Date(r.created_at))}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <IconBtn
                          title={isCopied ? "Copied!" : "Copy URL"}
                          onClick={() => handleCopy(r.slug)}
                        >
                          {isCopied ? (
                            <Check size={14} className="text-mint-hover" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </IconBtn>
                        <IconBtn
                          as="a"
                          href={partnerUrl(r.slug)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open partner dashboard in new tab"
                        >
                          <ExternalLink size={14} />
                        </IconBtn>
                        <button
                          type="button"
                          onClick={() => handleToggle(r)}
                          className="rounded-md border border-cream-line bg-white px-2 py-1 text-[11px] font-semibold text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
                        >
                          {r.enabled ? "Disable" : "Enable"}
                        </button>
                        <Link
                          href={`/admin/finance/partners/${r.id}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green"
                          title="Manage settings + weekly payments"
                        >
                          <Settings size={14} />
                        </Link>
                        <IconBtn
                          title="Regenerate slug"
                          onClick={() => setRegenTarget(r)}
                        >
                          <RefreshCw size={14} />
                        </IconBtn>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(r)}
                          title="Delete permanently"
                          className="rounded-md p-1.5 text-coral/60 transition hover:bg-coral-soft hover:text-coral"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-deep-green/50">
        Disabling a partner dashboard returns 404 immediately — the
        partner&apos;s URL stops working. Regenerating a slug invalidates
        the previous URL the same way.
      </p>

      {addOpen && (
        <PartnerAddDialog
          venues={venues}
          existingEnabledVenueIds={
            new Set(rows.filter((r) => r.enabled).map((r) => r.venue_id))
          }
          onCancel={() => setAddOpen(false)}
          onCreated={async () => {
            setAddOpen(false);
            await load();
          }}
        />
      )}

      {regenTarget && (
        <ConfirmDeleteDialog
          open={true}
          title="Regenerate slug?"
          summary={
            <>
              The current URL for <b>{regenTarget.partner_name}</b> will
              return 404 immediately. You&apos;ll need to re-share the new
              URL with the partner.
            </>
          }
          confirmLabel="Regenerate"
          onCancel={() => setRegenTarget(null)}
          onConfirm={async () => {
            const target = regenTarget;
            setRegenTarget(null);
            if (target) await handleRegenerate(target);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteDialog
          open={true}
          title="Delete permanently?"
          summary={
            <>
              This permanently removes the <b>{deleteTarget.partner_name}</b>{" "}
              partner_dashboards row. The slug is freed for reuse. To keep
              history, use Disable instead.
            </>
          }
          confirmLabel="Delete permanently"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const target = deleteTarget;
            setDeleteTarget(null);
            if (target) await handleDelete(target);
          }}
        />
      )}
    </>
  );
}

// Small icon-button (≈ 28×28 hit target). Polymorphic so the "View" row
// action can render as <a target="_blank"> while the others are <button>.
function IconBtn({
  as = "button",
  children,
  title,
  onClick,
  href,
  target,
  rel,
}: {
  as?: "button" | "a";
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  href?: string;
  target?: string;
  rel?: string;
}) {
  const cls =
    "inline-flex h-7 w-7 items-center justify-center rounded-md text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green";
  if (as === "a") {
    return (
      <a className={cls} title={title} href={href} target={target} rel={rel}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={cls} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function PartnerAddDialog({
  venues,
  existingEnabledVenueIds,
  onCancel,
  onCreated,
}: {
  venues: Venue[];
  existingEnabledVenueIds: Set<number>;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [venueId, setVenueId] = useState<number | null>(null);
  const [partnerName, setPartnerName] = useState("");
  const [cadence, setCadence] = useState<"weekly" | "monthly">("weekly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectVenue(id: number | null) {
    setVenueId(id);
    if (id != null) {
      const v = venues.find((x) => x.id === id);
      if (v) setPartnerName(v.venue_name);
    }
    setError(null);
  }

  async function handleSave() {
    setError(null);
    if (venueId == null) {
      setError("Pick a venue.");
      return;
    }
    if (!partnerName.trim()) {
      setError("Partner name can't be empty.");
      return;
    }
    if (existingEnabledVenueIds.has(venueId)) {
      const v = venues.find((x) => x.id === venueId);
      setError(
        `${v?.venue_name ?? "This venue"} already has an active partner dashboard. Disable that one first or pick a different venue.`,
      );
      return;
    }
    setBusy(true);
    try {
      const slug = generateSlug(partnerName.trim());
      const { error } = await supabase.from("partner_dashboards").insert({
        slug,
        venue_id: venueId,
        partner_name: partnerName.trim(),
        enabled: true,
        payment_cadence: cadence,
      });
      if (error) {
        // 42703 = payment_cadence column missing (pre-0005). Retry
        // without the field — the row is still created, just defaults
        // to weekly. Admin can flip cadence later in the detail view.
        if (error.code === "42703") {
          const retry = await supabase.from("partner_dashboards").insert({
            slug,
            venue_id: venueId,
            partner_name: partnerName.trim(),
            enabled: true,
          });
          if (retry.error) {
            setError(retry.error.message);
            return;
          }
        } else if (error.code === "23505") {
          setError(
            "A partner dashboard already exists for this venue (DB-level). Refresh and try again.",
          );
          return;
        } else {
          setError(error.message);
          return;
        }
      }
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border-l-4 border-mint border-y-[1.5px] border-r-[1.5px] border-y-cream-line border-r-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
          Add Partner
        </h2>

        <label className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
          Venue
        </label>
        <select
          value={venueId ?? ""}
          onChange={(e) =>
            selectVenue(e.target.value === "" ? null : Number(e.target.value))
          }
          className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
        >
          <option value="">— Select venue —</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.city ? `${v.city} · ` : ""}
              {v.venue_name}
              {existingEnabledVenueIds.has(v.id) ? " (active)" : ""}
            </option>
          ))}
        </select>

        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
          Partner name
        </label>
        <input
          type="text"
          value={partnerName}
          onChange={(e) => setPartnerName(e.target.value)}
          placeholder="Defaults to venue name; editable"
          className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
        />
        <p className="mt-1.5 text-xs text-deep-green/55">
          Shown to the partner as the dashboard header.
        </p>

        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
          Payment cadence
        </label>
        <select
          value={cadence}
          onChange={(e) =>
            setCadence(e.target.value === "monthly" ? "monthly" : "weekly")
          }
          className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
        >
          <option value="weekly">Weekly (Sun→Sat, paid Mondays)</option>
          <option value="monthly">Monthly (paid 5th of next month)</option>
        </select>
        <p className="mt-1.5 text-xs text-deep-green/55">
          Configure start date + revenue share % from the partner&apos;s
          detail page after creating.
        </p>

        {error && (
          <div className="mt-4 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-cream-line bg-white px-3 py-2 text-sm font-semibold text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="rounded-md bg-mint px-3 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaymentStatusSummary({
  startDate,
  cadence,
  counts,
}: {
  startDate: string | null;
  cadence: "weekly" | "monthly";
  counts: PaymentCounts | undefined;
}) {
  if (!startDate) {
    return (
      <p className="mt-0.5 text-[11px] italic text-deep-green/40">
        Payments off
      </p>
    );
  }
  const cadenceLabel = `(${cadence})`;
  const c = counts ?? { pending: 0, paid: 0, disputed: 0 };
  if (c.paid === 0 && c.pending === 0 && c.disputed === 0) {
    return (
      <p className="mt-0.5 text-[11px] text-deep-green/55">
        Payments on {cadenceLabel} · no records yet
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-[11px] text-deep-green/55">
      Payments on {cadenceLabel}
      {" · "}
      <span className="text-mint-hover">Paid {c.paid}</span>
      {" · "}
      <span className="text-deep-green/55">Pending {c.pending}</span>
      {c.disputed > 0 && (
        <>
          {" · "}
          <span className="font-semibold text-coral">
            Disputed {c.disputed}
          </span>
        </>
      )}
    </p>
  );
}
