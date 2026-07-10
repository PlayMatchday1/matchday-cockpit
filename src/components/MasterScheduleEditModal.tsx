"use client";

// Edit / create modal for schedule_master rows. Opens from
// CitiesMasterScheduleLens — either from clicking a bubble (edit)
// or the "+ Add session" button (create).
//
// Validation matches the API (src/lib/scheduleMaster.ts) so a
// well-formed local form will always be accepted server-side.
// Errors from the API surface inline above the action buttons.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { CANONICAL_CITIES } from "@/lib/scheduleMaster";
import { isCityHidden } from "@/lib/types";

export type EditableRow = {
  id: string;
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: number;
  mdapi_field_id: number | null;
};

export type CreateDefaults = {
  city?: string;
  match_date?: string;
};

type Mode =
  | { kind: "edit"; row: EditableRow }
  | { kind: "create"; defaults?: CreateDefaults };

type FormState = {
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: string; // stored as string so the input doesn't fight the user
  mdapi_field_id: number | null;
};

// One option in the venue combobox — a (fin_venue, mdapi_field_id)
// pair sourced from fin_venues × fin_venue_fields. A fin_venues row
// with multiple fin_venue_fields surfaces as one option per field
// so the operator can pick "Round Rock — Round Rock Tournaments"
// vs "Round Rock — Round Rock Multipurpose Complex".
type VenueOption = {
  venue_name: string;
  city: string;
  mdapi_field_id: number;
  field_title: string | null;
};

function initialForm(mode: Mode): FormState {
  if (mode.kind === "edit") {
    return {
      city: mode.row.city,
      venue: mode.row.venue,
      detail: mode.row.detail,
      match_date: mode.row.match_date,
      match_time: mode.row.match_time,
      max_spots: String(mode.row.max_spots),
      mdapi_field_id: mode.row.mdapi_field_id,
    };
  }
  return {
    city: mode.defaults?.city ?? "",
    venue: "",
    detail: "",
    match_date: mode.defaults?.match_date ?? "",
    match_time: "",
    max_spots: "0",
    mdapi_field_id: null,
  };
}

export default function MasterScheduleEditModal({
  mode,
  onClose,
  onSaved,
}: {
  mode: Mode;
  onClose: () => void;
  // Called after a successful create / update / delete. Parent uses
  // this to refetch and toast. Receives a coarse kind so the parent
  // can show the right confirmation copy.
  onSaved: (kind: "create" | "update" | "delete") => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(mode));
  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [venueOptions, setVenueOptions] = useState<VenueOption[]>([]);
  const [venueOptionsLoaded, setVenueOptionsLoaded] = useState(false);
  // Free-text fallback. Set when the operator picks "Other" or
  // when an existing row's (venue, mdapi_field_id) doesn't match
  // any loaded option (legacy rows pre-PR-D may have a venue
  // string with no field_id link). Both write venue as-is and
  // leave mdapi_field_id NULL.
  const [freeTextVenue, setFreeTextVenue] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // ESC closes; focus the first form field on open so keyboard
  // users land on a useful target.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    firstFieldRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Load fin_venues × fin_venue_fields once. Two small queries
  // (~25 + ~35 rows). Filtering and matching happen in JS below.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [vRes, fRes] = await Promise.all([
        supabase.from("fin_venues").select("id, venue_name, city"),
        supabase
          .from("fin_venue_fields")
          .select("fin_venue_id, mdapi_field_id, field_title_at_link"),
      ]);
      if (cancelled) return;
      if (vRes.error || fRes.error) {
        setVenueOptionsLoaded(true);
        return;
      }
      const venues = (vRes.data ?? []) as Array<{
        id: number;
        venue_name: string;
        city: string;
      }>;
      const links = (fRes.data ?? []) as Array<{
        fin_venue_id: number;
        mdapi_field_id: number;
        field_title_at_link: string | null;
      }>;
      const venueById = new Map(venues.map((v) => [v.id, v]));
      const options: VenueOption[] = [];
      for (const l of links) {
        const v = venueById.get(l.fin_venue_id);
        if (!v) continue;
        options.push({
          venue_name: v.venue_name,
          city: v.city,
          mdapi_field_id: l.mdapi_field_id,
          field_title: l.field_title_at_link,
        });
      }
      // Stable sort: by venue_name then field_title for predictable dropdown order.
      options.sort(
        (a, b) =>
          a.venue_name.localeCompare(b.venue_name) ||
          (a.field_title ?? "").localeCompare(b.field_title ?? ""),
      );
      setVenueOptions(options);
      setVenueOptionsLoaded(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Options filtered to the selected city. Empty city → empty list.
  const cityOptions = form.city
    ? venueOptions.filter((o) => o.city === form.city)
    : [];

  // Selected option key — uniquely identifies a (venue_name, field_id)
  // pick. Used by the <select> to track its current value.
  const selectedKey =
    freeTextVenue || form.mdapi_field_id == null
      ? ""
      : `${form.venue}|${form.mdapi_field_id}`;

  // On mount of an edit-mode row whose (venue, field_id) doesn't
  // match any loaded option, fall back to free-text so the user
  // sees the value they have and can re-pick from the dropdown.
  useEffect(() => {
    if (!venueOptionsLoaded || mode.kind !== "edit") return;
    if (form.mdapi_field_id == null) {
      setFreeTextVenue(true);
      return;
    }
    const match = cityOptions.some(
      (o) =>
        o.venue_name === form.venue && o.mdapi_field_id === form.mdapi_field_id,
    );
    if (!match) setFreeTextVenue(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueOptionsLoaded]);

  async function authHeader(): Promise<HeadersInit | null> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  function payloadFromForm(): {
    ok: true;
    value: {
      city: string;
      venue: string;
      detail: string;
      match_date: string;
      match_time: string;
      max_spots: number;
      mdapi_field_id: number | null;
    };
  } | { ok: false; error: string } {
    const trimmedVenue = form.venue.trim();
    const trimmedDetail = form.detail.trim();
    const trimmedTime = form.match_time.trim();
    if (!form.city) return { ok: false, error: "City is required" };
    if (!(CANONICAL_CITIES as readonly string[]).includes(form.city)) {
      return { ok: false, error: "Pick one of the 8 cockpit cities" };
    }
    if (!trimmedVenue) return { ok: false, error: "Venue is required" };
    if (!trimmedDetail) return { ok: false, error: "Detail is required" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.match_date)) {
      return { ok: false, error: "Match date must be a valid calendar date" };
    }
    if (!trimmedTime) return { ok: false, error: "Match time is required" };
    const n = Number(form.max_spots);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: "Max spots must be a non-negative integer" };
    }
    return {
      ok: true,
      value: {
        city: form.city,
        venue: trimmedVenue,
        detail: trimmedDetail,
        match_date: form.match_date,
        match_time: trimmedTime,
        max_spots: n,
        mdapi_field_id: freeTextVenue ? null : form.mdapi_field_id,
      },
    };
  }

  async function onSave() {
    const v = payloadFromForm();
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setBusy("save");
    try {
      const headers = await authHeader();
      if (!headers) {
        setError("No active session. Sign in again.");
        setBusy(null);
        return;
      }
      let res: Response;
      if (mode.kind === "edit") {
        res = await fetch(`/api/schedule-master/${mode.row.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(v.value),
        });
      } else {
        res = await fetch("/api/schedule-master", {
          method: "POST",
          headers,
          body: JSON.stringify(v.value),
        });
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onSaved(mode.kind === "edit" ? "update" : "create");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (mode.kind !== "edit") return;
    setError(null);
    setBusy("delete");
    try {
      const headers = await authHeader();
      if (!headers) {
        setError("No active session. Sign in again.");
        setBusy(null);
        return;
      }
      const res = await fetch(`/api/schedule-master/${mode.row.id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onSaved("delete");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const isEdit = mode.kind === "edit";
  const titleText = isEdit ? "Edit session" : "Add session";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-deep-green/40"
        onClick={busy ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titleText}
        className="relative z-10 w-[min(540px,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-cream-soft p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-extrabold tracking-tight text-deep-green">
            {titleText}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy != null}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-deep-green/65 transition hover:bg-cream-line hover:text-deep-green disabled:opacity-40"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="City">
            <select
              ref={firstFieldRef}
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
              className="block w-full rounded-md border border-cream-line bg-white px-2 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
            >
              <option value="">Select a city</option>
              {CANONICAL_CITIES.filter((c) => !isCityHidden(c)).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Match date">
            <input
              type="date"
              value={form.match_date}
              onChange={(e) => setForm({ ...form, match_date: e.target.value })}
              className="block w-full rounded-md border border-cream-line bg-white px-2 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
            />
          </Field>
          <Field label="Venue">
            {freeTextVenue ? (
              <>
                <input
                  type="text"
                  value={form.venue}
                  onChange={(e) =>
                    setForm({ ...form, venue: e.target.value, mdapi_field_id: null })
                  }
                  placeholder="NEMP"
                  className="block w-full rounded-md border border-cream-line bg-white px-2 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
                />
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-deep-green/55">
                  <span>
                    Not linked to mdapi — saves venue text only, no field_id.
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setFreeTextVenue(false);
                      setForm({ ...form, venue: "", mdapi_field_id: null });
                    }}
                    className="font-bold text-deep-green/70 underline-offset-2 hover:underline"
                  >
                    Pick from list
                  </button>
                </div>
              </>
            ) : (
              <select
                value={selectedKey}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__OTHER__") {
                    setFreeTextVenue(true);
                    setForm({ ...form, venue: "", mdapi_field_id: null });
                    return;
                  }
                  if (!v) {
                    setForm({ ...form, venue: "", mdapi_field_id: null });
                    return;
                  }
                  const opt = cityOptions.find(
                    (o) => `${o.venue_name}|${o.mdapi_field_id}` === v,
                  );
                  if (!opt) return;
                  setForm({
                    ...form,
                    venue: opt.venue_name,
                    mdapi_field_id: opt.mdapi_field_id,
                  });
                }}
                disabled={!form.city || !venueOptionsLoaded}
                className="block w-full rounded-md border border-cream-line bg-white px-2 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
              >
                <option value="">
                  {form.city
                    ? venueOptionsLoaded
                      ? "Select a venue"
                      : "Loading…"
                    : "Select a city first"}
                </option>
                {cityOptions.map((o) => {
                  const key = `${o.venue_name}|${o.mdapi_field_id}`;
                  // Show field_title sub-label only when the venue
                  // has multiple field options — otherwise it's
                  // visual noise.
                  const dupes = cityOptions.filter(
                    (x) => x.venue_name === o.venue_name,
                  ).length;
                  const label =
                    dupes > 1 && o.field_title
                      ? `${o.venue_name} — ${o.field_title}`
                      : o.venue_name;
                  return (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  );
                })}
                <option value="__OTHER__">Other (not in list)…</option>
              </select>
            )}
          </Field>
          <Field label="Detail">
            <input
              type="text"
              value={form.detail}
              onChange={(e) => setForm({ ...form, detail: e.target.value })}
              placeholder="NEMP Field 12"
              className="block w-full rounded-md border border-cream-line bg-white px-2 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
            />
          </Field>
          <Field label="Match time">
            <input
              type="text"
              value={form.match_time}
              onChange={(e) => setForm({ ...form, match_time: e.target.value })}
              placeholder="7:00 PM - 8:00 PM"
              className="block w-full rounded-md border border-cream-line bg-white px-2 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
            />
          </Field>
          <Field label="Max spots">
            <input
              type="number"
              min={0}
              step={1}
              value={form.max_spots}
              onChange={(e) => setForm({ ...form, max_spots: e.target.value })}
              className="block w-full rounded-md border border-cream-line bg-white px-2 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
            />
          </Field>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
            {error}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            {isEdit &&
              (confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-deep-green/70">
                    Confirm delete?
                  </span>
                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={busy != null}
                    className="rounded-full bg-coral px-3 py-1 text-xs font-bold text-white transition hover:bg-coral-hover disabled:opacity-60"
                  >
                    {busy === "delete" ? "Deleting…" : "Yes, delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy != null}
                    className="text-[11px] font-medium text-deep-green/60 underline-offset-2 hover:underline disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy != null}
                  className="rounded-full border border-coral/40 bg-white px-3 py-1 text-xs font-bold text-coral-hover transition hover:bg-coral-soft disabled:opacity-50"
                >
                  Delete
                </button>
              ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy != null}
              className="rounded-full border border-cream-line bg-white px-3 py-1 text-xs font-bold text-deep-green/70 transition hover:bg-cream-line/40 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={busy != null}
              className="rounded-full bg-mint px-4 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-60"
            >
              {busy === "save"
                ? isEdit
                  ? "Saving…"
                  : "Creating…"
                : isEdit
                  ? "Save"
                  : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </span>
      {children}
    </label>
  );
}
