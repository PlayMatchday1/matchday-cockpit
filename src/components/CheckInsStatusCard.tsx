"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { ManagerStatus } from "@/lib/checkIns";
import { useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabase";

// THE PAY DAY, carried onto the card. It used to live only in the Payment Calendar and Next
// Payments panels, both of which have been removed — and it is the one fact those blocks showed
// that appears NOWHERE ELSE in the app. Manager Pay shows a single aggregate pay date for the
// period, not each manager's own day.
function ordinal(d: number): string {
  const s = ["th", "st", "nd", "rd"][(d % 100 - 20) % 10] ?? ["th", "st", "nd", "rd"][d % 100] ?? "th";
  return `${d}${s}`;
}

export default function CheckInsStatusCard({
  status,
  onDeleted,
}: {
  status: ManagerStatus;
  /* The page refetches after a delete. No local row surgery: buildCheckInsData rebuilds every
     status from MANAGERS, so removing a city's only row returns that card to No Response on its
     own — the same reason /api/inventory/[id] needs no "fall back" logic. */
  onDeleted?: () => void;
}) {
  const { manager, entry, submitted } = status;
  /* SAME GATE AS THE ROUTE, not merely the same as InventoryDashboard's. DELETE
     /api/city-check-ins/[id] uses authenticateAdmin, so this button is hidden from exactly the
     accounts the server refuses — it is a courtesy, and the refusal behind it is real. */
  const { appUser } = useAuth();
  const isAdmin = appUser?.is_admin === true;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!entry) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
        <div className="flex items-start justify-between gap-3 border-b border-cream-line pb-3">
          <div>
            <div className="text-base font-bold text-deep-green">
              {manager.name}
            </div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              {manager.city} · pays {ordinal(manager.payDay)}
            </div>
          </div>
          <span className="inline-flex shrink-0 rounded-full bg-muted-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted ring-1 ring-inset ring-cream-line">
            No Response
          </span>
        </div>
        <div className="mt-3 text-sm italic text-deep-green/45">
          Awaiting first monthly check-in.
        </div>
      </div>
    );
  }

  const ratingPct = Math.max(0, Math.min(100, (entry.rating / 5) * 100));
  const tsStr = entry.timestamp
    .toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex items-start justify-between gap-3 border-b border-cream-line pb-3">
        <div>
          <div className="text-base font-bold text-deep-green">
            {manager.name}
          </div>
          <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            {manager.city} · pays {ordinal(manager.payDay)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {submitted ? (
            <span className="inline-flex rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green ring-1 ring-inset ring-mint/40">
              Submitted
            </span>
          ) : (
            <span className="inline-flex rounded-full bg-coral-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-coral ring-1 ring-inset ring-coral/40">
              Overdue
            </span>
          )}
          {/* ONE BUTTON, THEN CONFIRM. No typing the city's name back, no explanatory paragraph —
              Ryan on the field delete: "just give me confirm keep very simple no explantory text." */}
          {isAdmin && (confirming ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                data-testid="ci-del-confirm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true); setErr(null);
                  try {
                    /* THE BEARER TOKEN IS REQUIRED. authenticateAdmin reads the Authorization
                       header and a bare fetch() is a 401 — same shape InventoryDashboard uses. */
                    const { data: sess } = await supabase.auth.getSession();
                    const token = sess.session?.access_token;
                    if (!token) throw new Error("No active session.");
                    const r = await fetch(`/api/city-check-ins/${entry.id}`, {
                      method: "DELETE",
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!r.ok) {
                      const j = await r.json().catch(() => ({}));
                      throw new Error(j.error || `HTTP ${r.status}`);
                    }
                    onDeleted?.();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                    setBusy(false); setConfirming(false);
                  }
                }}
                className="rounded-full bg-coral px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Confirm"}
              </button>
              <button
                type="button"
                data-testid="ci-del-cancel"
                onClick={() => setConfirming(false)}
                className="rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/50 hover:text-deep-green"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="ci-del"
              aria-label="Delete this check-in"
              onClick={() => setConfirming(true)}
              className="rounded-lg p-1 text-deep-green/35 transition hover:bg-coral-soft hover:text-coral"
            >
              <Trash2 aria-hidden size={14} />
            </button>
          ))}
        </div>
      </div>
      {err && (
        <p data-testid="ci-del-error" className="mt-2 text-[12px] font-medium text-coral-hover">{err}</p>
      )}

      {entry.rating > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
            Overall rating
          </div>
          <div className="mt-1.5 flex items-baseline gap-3">
            <div className="text-3xl font-extrabold tabular-nums text-deep-green">
              {entry.rating.toFixed(1)}
            </div>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream-soft ring-1 ring-inset ring-cream-line"
              role="img"
              aria-label={`Rating ${entry.rating.toFixed(1)} of 5`}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${ratingPct}%`,
                  background: "linear-gradient(90deg, #FF6955, #2CDB87)",
                }}
              />
            </div>
            <div className="text-[10px] font-bold tabular-nums uppercase tracking-wider text-deep-green/45">
              / 5
            </div>
          </div>
        </div>
      )}

      {entry.win && (
        <Section label="Biggest win">
          <Quote>{entry.win}</Quote>
        </Section>
      )}
      {entry.challenge && (
        <Section label="Biggest challenge">
          <Quote>{entry.challenge}</Quote>
        </Section>
      )}
      {entry.focus && (
        <Section label="Next month focus">
          <Body>{entry.focus}</Body>
        </Section>
      )}
      {(entry.fieldsContacted || entry.fieldsList) && (
        <Section
          label={
            entry.fieldsContacted
              ? `New fields contacted (${entry.fieldsContacted})`
              : "New fields contacted"
          }
        >
          {entry.fieldsList && <Body>{entry.fieldsList}</Body>}
        </Section>
      )}
      {entry.fieldProgress && (
        <Section label="Field progress">
          <Body>{entry.fieldProgress}</Body>
        </Section>
      )}
      {entry.matchManager && (
        <Section label="Match manager team">
          <Body>{entry.matchManager}</Body>
        </Section>
      )}
      {entry.marketingChannels && (
        <Section label="Marketing channels">
          <div className="mt-1 font-mono text-[11px] uppercase tracking-wider text-deep-green/65">
            {entry.marketingChannels}
          </div>
        </Section>
      )}
      {entry.marketingResults && (
        <Section label="Marketing results">
          <Body>{entry.marketingResults}</Body>
        </Section>
      )}

      <div className="mt-5 border-t border-cream-line/60 pt-3 text-[10px] font-bold uppercase tracking-wider text-deep-green/45">
        Submitted {tsStr}
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      {children}
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 text-sm leading-relaxed text-deep-green/85">
      {children}
    </div>
  );
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 border-l-2 border-cream-line pl-3 text-sm italic leading-relaxed text-deep-green/75">
      {children}
    </div>
  );
}
