"use client";

// In-app editor for the Veo code→field map (veo_codes). Admins can:
//   - inline toggle a code Queue-only ⇄ Confirmed (a confirm dialog guards
//     flipping to Confirmed, since that makes the code auto-post to player
//     chats),
//   - edit the code string / field mapping (multi-select of REAL fields grouped
//     by venue, so no bogus field_ids can be entered),
//   - add / delete a code.
// Reads GET /api/veo/codes (fresh); mutates via the admin-gated
// POST/PATCH/DELETE /api/veo/codes routes with the session bearer token.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Pencil, Plus, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";

type CodeRow = {
  id: string;
  code: string;
  fin_venue_id: number;
  field_ids: number[];
  field_label: string;
  city: string;
  confirmed: boolean;
};

type VenueFieldOption = {
  fin_venue_id: number;
  venue_name: string;
  city: string;
  fields: { mdapi_field_id: number; field_title: string }[];
};

type Stat = { code: string; posted: number; queued: number };

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export default function VeoCodesEditor({
  stats,
  onChanged,
}: {
  stats: Stat[];
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [venueFields, setVenueFields] = useState<VenueFieldOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: CodeRow | null } | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    { kind: "enable" | "delete"; row: CodeRow } | null
  >(null);

  const statByCode = useMemo(() => {
    const m = new Map<string, Stat>();
    for (const s of stats) m.set(s.code.toUpperCase(), s);
    return m;
  }, [stats]);

  const load = useCallback(async () => {
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("Not signed in.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/veo/codes", { headers });
      const json = (await res.json()) as {
        codes?: CodeRow[];
        venueFields?: VenueFieldOption[];
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? "Failed to load codes.");
      } else {
        setRows(json.codes ?? []);
        setVenueFields(json.venueFields ?? []);
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const setConfirmed = useCallback(
    async (row: CodeRow, confirmed: boolean) => {
      setBusyId(row.id);
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) return;
        const res = await fetch(`/api/veo/codes/${row.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ confirmed }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) setError(json.error ?? "Update failed.");
        else await afterMutation();
      } catch {
        setError("Network error.");
      } finally {
        setBusyId(null);
        setConfirmAction(null);
      }
    },
    [afterMutation],
  );

  const remove = useCallback(
    async (row: CodeRow) => {
      setBusyId(row.id);
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) return;
        const res = await fetch(`/api/veo/codes/${row.id}`, { method: "DELETE", headers });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) setError(json.error ?? "Delete failed.");
        else await afterMutation();
      } catch {
        setError("Network error.");
      } finally {
        setBusyId(null);
        setConfirmAction(null);
      }
    },
    [afterMutation],
  );

  const venueName = useCallback(
    (finVenueId: number) =>
      venueFields.find((v) => v.fin_venue_id === finVenueId)?.venue_name ??
      `venue ${finVenueId}`,
    [venueFields],
  );

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-deep-green/60">
          Codes &amp; per-code readiness
        </h2>
        <button
          type="button"
          onClick={() => setEditing({ row: null })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-deep-green px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-deep-green-hover"
        >
          <Plus className="h-3.5 w-3.5" />
          Add code
        </button>
      </div>
      <p className="mb-3 text-xs text-deep-green/50">
        A code posting cleanly is the signal it&apos;s ready to confirm. Confirmed codes
        auto-post film links to player chats; queue-only codes land in review.
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral-hover">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-cream-line">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="bg-cream-soft text-[11px] uppercase tracking-wide text-deep-green/50">
            <tr>
              <th className="px-3 py-2 font-semibold">Code</th>
              <th className="px-3 py-2 font-semibold">Field(s)</th>
              <th className="px-3 py-2 font-semibold">City</th>
              <th className="px-3 py-2 font-semibold">State</th>
              <th className="px-3 py-2 text-right font-semibold">Posted</th>
              <th className="px-3 py-2 text-right font-semibold">Queued</th>
              <th className="px-3 py-2 text-right font-semibold">Edit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-line">
            {rows.map((r) => {
              const s = statByCode.get(r.code.toUpperCase());
              return (
                <tr key={r.id} className="bg-white">
                  <td className="px-3 py-2">
                    <span className="font-mono font-bold text-deep-green">{r.code}</span>
                  </td>
                  <td className="px-3 py-2 text-deep-green/70">
                    {r.field_label}
                    <span className="text-deep-green/40">
                      {" "}
                      · {venueName(r.fin_venue_id)} · fields {r.field_ids.join(", ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-deep-green/60">{r.city}</td>
                  <td className="px-3 py-2">
                    {r.confirmed ? (
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => void setConfirmed(r, false)}
                        title="Confirmed — auto-posts. Click to make queue-only."
                        className="inline-flex items-center rounded-full border border-mint/50 bg-mint-soft px-2 py-0.5 text-[11px] font-semibold text-deep-green transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover disabled:opacity-50"
                      >
                        Confirmed
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => setConfirmAction({ kind: "enable", row: r })}
                        title="Queue-only. Click to confirm (enables auto-post)."
                        className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 transition hover:border-mint hover:bg-mint-soft hover:text-deep-green disabled:opacity-50"
                      >
                        Queue-only
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-deep-green">
                    {s?.posted ?? 0}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-deep-green/60">
                    {s?.queued ?? 0}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing({ row: r })}
                        className="rounded-lg border border-cream-line p-1.5 text-deep-green/50 transition hover:border-mint hover:text-deep-green"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmAction({ kind: "delete", row: r })}
                        className="rounded-lg border border-cream-line p-1.5 text-deep-green/50 transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-deep-green/45">
                  No codes yet. Add one to start matching recordings.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <CodeModal
          row={editing.row}
          venueFields={venueFields}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await afterMutation();
          }}
        />
      )}

      {confirmAction && (
        <ConfirmDialog
          action={confirmAction}
          busy={busyId === confirmAction.row.id}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() =>
            confirmAction.kind === "enable"
              ? void setConfirmed(confirmAction.row, true)
              : void remove(confirmAction.row)
          }
        />
      )}
    </section>
  );
}

// -------------------------- add / edit modal --------------------------

function CodeModal({
  row,
  venueFields,
  onClose,
  onSaved,
}: {
  row: CodeRow | null;
  venueFields: VenueFieldOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(row?.code ?? "");
  const [venueId, setVenueId] = useState<number | null>(row?.fin_venue_id ?? null);
  const [fieldIds, setFieldIds] = useState<number[]>(row?.field_ids ?? []);
  const [fieldLabel, setFieldLabel] = useState(row?.field_label ?? "");
  const [confirmed, setConfirmed] = useState(row?.confirmed ?? false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const venue = venueFields.find((v) => v.fin_venue_id === venueId) ?? null;

  const pickVenue = (id: number) => {
    setVenueId(id);
    setFieldIds([]); // fields belong to the venue — reset when venue changes
    const v = venueFields.find((x) => x.fin_venue_id === id);
    if (v && !fieldLabel.trim()) setFieldLabel(v.venue_name);
  };

  const toggleField = (fid: number) =>
    setFieldIds((prev) =>
      prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid],
    );

  const save = async () => {
    setErr(null);
    if (!venue) {
      setErr("Select a venue.");
      return;
    }
    setSaving(true);
    try {
      const headers = await bearerHeaders();
      if (!headers) {
        setErr("Not signed in.");
        return;
      }
      const payload = {
        code,
        finVenueId: venue.fin_venue_id,
        fieldIds,
        fieldLabel,
        city: venue.city,
        confirmed,
      };
      const res = await fetch(
        row ? `/api/veo/codes/${row.id}` : "/api/veo/codes",
        { method: row ? "PATCH" : "POST", headers, body: JSON.stringify(payload) },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) setErr(json.error ?? "Save failed.");
      else onSaved();
    } catch {
      setErr("Network error.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep-green/30 p-4 backdrop-blur-sm">
      <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-cream-line bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-deep-green">
            {row ? `Edit code “${row.code}”` : "Add code"}
          </h3>
          <button type="button" onClick={onClose} className="text-deep-green/40 hover:text-deep-green">
            <X className="h-5 w-5" />
          </button>
        </div>

        {err && (
          <div className="mb-3 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral-hover">
            {err}
          </div>
        )}

        <div className="space-y-4">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/50">
              Code (exact Veo title string)
            </span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. ATH P"
              className="mt-1 w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-[14px] text-deep-green outline-none focus:border-mint"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/50">
              Venue
            </span>
            <select
              value={venueId ?? ""}
              onChange={(e) => pickVenue(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-[14px] text-deep-green outline-none focus:border-mint"
            >
              <option value="" disabled>
                Select a venue…
              </option>
              {venueFields.map((v) => (
                <option key={v.fin_venue_id} value={v.fin_venue_id}>
                  {v.venue_name} · {v.city}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/50">
              Fields (this code&apos;s camera field(s))
            </span>
            {venue ? (
              <div className="mt-1 space-y-1 rounded-lg border border-cream-line p-2">
                {venue.fields.map((f) => (
                  <label
                    key={f.mdapi_field_id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] text-deep-green hover:bg-cream-soft"
                  >
                    <input
                      type="checkbox"
                      checked={fieldIds.includes(f.mdapi_field_id)}
                      onChange={() => toggleField(f.mdapi_field_id)}
                      className="h-4 w-4 accent-mint-hover"
                    />
                    <span className="font-mono text-deep-green/60">{f.mdapi_field_id}</span>
                    <span>{f.field_title}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-deep-green/45">Select a venue to choose fields.</p>
            )}
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/50">
              Field label (shown in the queue)
            </span>
            <input
              value={fieldLabel}
              onChange={(e) => setFieldLabel(e.target.value)}
              placeholder="e.g. ATH Pearland"
              className="mt-1 w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-[14px] text-deep-green outline-none focus:border-mint"
            />
            {venue && (
              <span className="mt-1 block text-xs text-deep-green/40">City: {venue.city} (from venue)</span>
            )}
          </label>

          <label className="flex items-start gap-2 rounded-lg border border-cream-line bg-cream-soft p-3">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-mint-hover"
            />
            <span className="text-[13px] text-deep-green">
              <span className="font-semibold">Confirmed (auto-post)</span>
              <span className="mt-0.5 flex items-center gap-1 text-xs text-coral-hover">
                <AlertTriangle className="h-3.5 w-3.5" />
                Confirmed codes post film links straight into player chats.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-cream-line px-4 py-2 text-[13px] font-medium text-deep-green/70 hover:bg-cream-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-lg bg-deep-green px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-deep-green-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : row ? "Save changes" : "Add code"}
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------- confirm dialog --------------------------

function ConfirmDialog({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: { kind: "enable" | "delete"; row: CodeRow };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isEnable = action.kind === "enable";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep-green/30 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-cream-line bg-white p-5 shadow-xl">
        <h3 className="text-lg font-bold text-deep-green">
          {isEnable ? `Confirm “${action.row.code}”?` : `Delete “${action.row.code}”?`}
        </h3>
        <p className="mt-2 text-sm text-deep-green/70">
          {isEnable ? (
            <>
              This makes <span className="font-mono font-semibold">{action.row.code}</span> auto-post
              film links into the <span className="font-semibold">{action.row.field_label}</span> player
              chats as soon as recordings arrive. Only confirm once you&apos;ve verified the exact Veo
              string and the camera.
            </>
          ) : (
            <>
              Removing <span className="font-mono font-semibold">{action.row.code}</span> means its
              recordings will queue as an unknown code until it&apos;s re-added.
            </>
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-cream-line px-4 py-2 text-[13px] font-medium text-deep-green/70 hover:bg-cream-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              isEnable
                ? "rounded-lg bg-mint-hover px-4 py-2 text-[13px] font-semibold text-deep-green transition hover:bg-mint disabled:opacity-50"
                : "rounded-lg bg-coral px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-coral-hover disabled:opacity-50"
            }
          >
            {busy ? "Working…" : isEnable ? "Confirm & enable auto-post" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
