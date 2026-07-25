"use client";

// Cities → Fields sub-tab. Manage the venue roster that lives on the
// CANONICAL fin_venues record (the same row Finance bills from and
// scheduling resolves to via fin_venue_fields). Reads/writes fin_venues
// directly through the session supabase client, mirroring the other
// Cities admin sub-tabs; admin gating is the page-level
// PagePermissionGuard + RLS.
//
// City Manager is DERIVED from each venue's city via the city_managers
// roster — never stored on the venue, so it can't drift. All the
// validation / payload / delete-safety logic is the pure, tested
// fieldsAdmin lib. One name only: "Field" = venue_name (the retired
// field_name column is never referenced — see migration 0075).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pencil,
  Trash2,
  Plus,
  ExternalLink,
  Search,
  X,
  Phone,
  Mail,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import CityChip from "@/components/CityChip";
import { CITIES } from "@/lib/types";
import { normalizeCityName } from "@/lib/cityNormalization";
import {
  cityManagerFor,
  buildFieldPayload,
  resolveDeleteAction,
  contactLink,
  formatPhoneDisplay,
  UNASSIGNED_CITY_MANAGER,
  type CityManagerRoster,
  type FieldFormInput,
} from "@/lib/fieldsAdmin";

type FieldVenue = {
  id: number;
  venue_name: string;
  city: string;
  contact_name: string | null;
  contact_number: string | null;
  min_players: number | null;
  max_players: number | null;
  schedule_url: string | null;
  is_active: boolean;
};

const VENUE_COLS =
  "id, venue_name, city, contact_name, contact_number, min_players, max_players, schedule_url, is_active";

const EMPTY_FORM: FieldFormInput = {
  venue_name: "",
  city: CITIES[0],
  contact_name: "",
  contact_number: "",
  min_players: "",
  max_players: "",
  schedule_url: "",
};

type ModalState =
  | { mode: "add"; form: FieldFormInput }
  | { mode: "edit"; id: number; name: string; form: FieldFormInput }
  | null;

// Two-letter initials for the CM avatar ("Priya Nair" → "PN").
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function CitiesFieldsLens() {
  const [venues, setVenues] = useState<FieldVenue[]>([]);
  const [roster, setRoster] = useState<CityManagerRoster>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState<string>("all");

  const [modal, setModal] = useState<ModalState>(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FieldVenue | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vRes, cmRes] = await Promise.all([
        supabase
          .from("fin_venues")
          .select(VENUE_COLS)
          .eq("is_active", true)
          .order("city", { ascending: true })
          .order("venue_name", { ascending: true }),
        supabase.from("city_managers").select("city, manager_name"),
      ]);
      if (vRes.error) throw vRes.error;
      if (cmRes.error) throw cmRes.error;
      setVenues((vRes.data ?? []) as FieldVenue[]);
      const map: CityManagerRoster = new Map();
      for (const r of (cmRes.data ?? []) as {
        city: string;
        manager_name: string;
      }[]) {
        map.set(r.city, r.manager_name);
      }
      setRoster(map);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Failed to load fields. (Has migration 0074 been applied?)",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Search (field OR contact name) + city filter.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return venues.filter((v) => {
      if (cityFilter !== "all" && v.city !== cityFilter) return false;
      if (!q) return true;
      return (
        v.venue_name.toLowerCase().includes(q) ||
        (v.contact_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [venues, search, cityFilter]);

  // Group by city, canonical CITIES order, only cities with rows.
  const groups = useMemo(() => {
    const byCity = new Map<string, FieldVenue[]>();
    for (const v of filtered) {
      const arr = byCity.get(v.city);
      if (arr) arr.push(v);
      else byCity.set(v.city, [v]);
    }
    return CITIES.filter((c) => byCity.has(c)).map((city) => ({
      city,
      code: normalizeCityName(city) ?? city,
      manager: cityManagerFor(city, roster),
      rows: byCity.get(city)!,
    }));
  }, [filtered, roster]);

  const totalCities = useMemo(
    () => new Set(venues.map((v) => v.city)).size,
    [venues],
  );

  const openAdd = useCallback((city?: string) => {
    setModalError(null);
    setModal({ mode: "add", form: { ...EMPTY_FORM, city: city ?? CITIES[0] } });
  }, []);

  const openEdit = useCallback((v: FieldVenue) => {
    setModalError(null);
    setModal({
      mode: "edit",
      id: v.id,
      name: v.venue_name,
      form: {
        venue_name: v.venue_name,
        city: v.city,
        contact_name: v.contact_name ?? "",
        contact_number: v.contact_number ?? "",
        min_players: v.min_players?.toString() ?? "",
        max_players: v.max_players?.toString() ?? "",
        schedule_url: v.schedule_url ?? "",
      },
    });
  }, []);

  const save = useCallback(async () => {
    if (!modal) return;
    const result = buildFieldPayload(modal.form);
    if (!result.ok) {
      setModalError(result.error);
      return;
    }
    setSaving(true);
    setModalError(null);
    try {
      if (modal.mode === "add") {
        const { error: e } = await supabase
          .from("fin_venues")
          .insert(result.payload);
        if (e) throw e;
      } else {
        const { error: e } = await supabase
          .from("fin_venues")
          .update(result.payload)
          .eq("id", modal.id);
        if (e) throw e;
      }
      setModal(null);
      await load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [modal, load]);

  // Soft-deactivate — never a hard delete (would orphan match/cost rows).
  const doDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const { patch } = resolveDeleteAction();
    setSaving(true);
    try {
      const { error: e } = await supabase
        .from("fin_venues")
        .update(patch)
        .eq("id", confirmDelete.id);
      if (e) throw e;
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [confirmDelete, load]);

  return (
    <section>
      {/* Title + controls bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="text-[17px] font-extrabold text-deep-green">
          Fields
          <span className="ml-2 text-[13px] font-semibold text-deep-green/45">
            {venues.length} venue{venues.length === 1 ? "" : "s"} ·{" "}
            {totalCities} cit{totalCities === 1 ? "y" : "ies"}
          </span>
        </div>
        <div className="flex-1" />
        <div className="relative">
          <Search
            aria-hidden
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-deep-green/35"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search field or contact…"
            className="w-60 rounded-xl border border-cream-line bg-white py-2 pl-9 pr-3 text-sm text-deep-green placeholder:text-deep-green/35 focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint-soft/60"
          />
        </div>
        <select
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value)}
          className="rounded-xl border border-cream-line bg-white px-3 py-2 text-sm font-semibold text-deep-green focus:border-mint focus:outline-none"
        >
          <option value="all">All cities</option>
          {CITIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => openAdd()}
          className="inline-flex items-center gap-1.5 rounded-xl bg-mint px-4 py-2 text-[13px] font-extrabold text-deep-green transition hover:bg-mint-hover"
        >
          <Plus aria-hidden size={15} strokeWidth={2.5} /> Add field
        </button>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-cream-line bg-white py-16 text-center text-sm text-deep-green/50">
          Loading fields…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-coral/30 bg-coral-soft/40 px-4 py-3 text-sm text-coral-hover">
          {error}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-cream-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                <tr className="bg-cream-soft/70 text-[10.5px] uppercase tracking-wider text-deep-green/45">
                  <th className="border-b border-cream-line px-4 py-3 text-left font-extrabold">
                    Field
                  </th>
                  <th className="border-b border-cream-line px-4 py-3 text-left font-extrabold">
                    Field Contact Name
                  </th>
                  <th className="border-b border-cream-line px-4 py-3 text-left font-extrabold">
                    Field Contact
                  </th>
                  <th className="border-b border-cream-line px-4 py-3 text-center font-extrabold">
                    Min Players
                  </th>
                  <th className="border-b border-cream-line px-4 py-3 text-center font-extrabold">
                    Max Players
                  </th>
                  <th className="border-b border-cream-line px-4 py-3 text-left font-extrabold">
                    Schedule
                  </th>
                  <th className="border-b border-cream-line px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {groups.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-16 text-center text-sm text-deep-green/45"
                    >
                      {venues.length === 0
                        ? "No fields yet. Add the first one."
                        : "No fields match your search."}
                    </td>
                  </tr>
                ) : (
                  groups.map((g) => (
                    <FieldGroup
                      key={g.city}
                      city={g.city}
                      code={g.code}
                      manager={g.manager}
                      rows={g.rows}
                      onAdd={() => openAdd(g.city)}
                      onEdit={openEdit}
                      onDelete={setConfirmDelete}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          {groups.length > 0 && (
            <div className="border-t border-cream-line bg-cream-soft/50 px-4 py-3 text-[12.5px] text-deep-green/50">
              Showing {filtered.length} of {venues.length} venue
              {venues.length === 1 ? "" : "s"} · grouped by city, then field
            </div>
          )}
        </div>
      )}

      {modal && (
        <FieldModal
          state={modal}
          roster={roster}
          saving={saving}
          error={modalError}
          onChange={(form) => setModal((m) => (m ? { ...m, form } : m))}
          onClose={() => setModal(null)}
          onSave={save}
        />
      )}

      {confirmDelete && (
        <ConfirmDelete
          venue={confirmDelete}
          saving={saving}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={doDelete}
        />
      )}
    </section>
  );
}

// Field Contact — a clickable tel:/mailto: link (phone → call, email →
// email) with a matching icon. Falls back to plain text if the value has
// nothing dialable/emailable, and "—" when empty.
function ContactCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-deep-green/25">—</span>;
  const link = contactLink(value);
  if (!link) return <span>{value}</span>;
  // Phones display as dashed groups (XXX-XXX-XXXX); the tel: href keeps
  // raw digits so it still dials correctly. Emails show verbatim.
  const display =
    link.kind === "phone" ? formatPhoneDisplay(value) : value;
  return (
    <a
      href={link.href}
      className="inline-flex items-center gap-1.5 text-deep-green/80 underline decoration-cream-line decoration-1 underline-offset-2 transition hover:text-mint-hover hover:decoration-mint"
    >
      {link.kind === "email" ? (
        <Mail aria-hidden size={13} className="shrink-0 text-deep-green/40" />
      ) : (
        <Phone aria-hidden size={13} className="shrink-0 text-deep-green/40" />
      )}
      <span className={link.kind === "phone" ? "tabular-nums" : ""}>
        {display}
      </span>
    </a>
  );
}

// ============================================================
// One city group: a header row + its field rows
// ============================================================
function FieldGroup({
  city,
  code,
  manager,
  rows,
  onAdd,
  onEdit,
  onDelete,
}: {
  city: string;
  code: string;
  manager: string;
  rows: FieldVenue[];
  onAdd: () => void;
  onEdit: (v: FieldVenue) => void;
  onDelete: (v: FieldVenue) => void;
}) {
  const unassigned = manager === UNASSIGNED_CITY_MANAGER;
  return (
    <>
      <tr>
        <td
          colSpan={7}
          className="border-y border-mint-soft bg-mint-soft/30 px-4 py-2.5"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-sm font-extrabold text-deep-green">
              <CityChip code={code} size="sm" />
              {city}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-deep-green/35">
                CM
              </span>
              {unassigned ? (
                <span className="text-[12.5px] font-semibold text-deep-green/35">
                  Unassigned
                </span>
              ) : (
                <>
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-deep-green text-[10px] font-extrabold text-mint-soft">
                    {initials(manager)}
                  </span>
                  <span className="text-[12.5px] font-semibold text-deep-green">
                    {manager}
                  </span>
                </>
              )}
            </span>
            <span className="text-xs font-semibold text-deep-green/40">
              · {rows.length} field{rows.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={onAdd}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-mint-soft bg-white px-2.5 py-1.5 text-[12px] font-extrabold text-deep-green/70 transition hover:border-mint hover:text-deep-green"
            >
              <Plus aria-hidden size={13} strokeWidth={2.5} /> Add field
            </button>
          </div>
        </td>
      </tr>
      {rows.map((v) => (
        <tr key={v.id} className="group transition hover:bg-cream-soft/40">
          <td className="border-b border-cream-line/60 px-4 py-3 font-extrabold text-deep-green">
            {v.venue_name}
          </td>
          <td className="border-b border-cream-line/60 px-4 py-3 font-semibold text-deep-green/80">
            {v.contact_name ?? <span className="text-deep-green/25">—</span>}
          </td>
          <td className="border-b border-cream-line/60 px-4 py-3 font-semibold text-deep-green/70">
            <ContactCell value={v.contact_number} />
          </td>
          <td className="border-b border-cream-line/60 px-4 py-3 text-center tabular-nums font-bold text-deep-green/45">
            {v.min_players ?? <span className="text-deep-green/25">—</span>}
          </td>
          <td className="border-b border-cream-line/60 px-4 py-3 text-center tabular-nums font-extrabold text-deep-green">
            {v.max_players ?? <span className="text-deep-green/25">—</span>}
          </td>
          <td className="border-b border-cream-line/60 px-4 py-3">
            {v.schedule_url ? (
              <a
                href={v.schedule_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-mint-soft bg-mint-soft/40 px-2.5 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-soft"
              >
                Open <ExternalLink aria-hidden size={12} />
              </a>
            ) : (
              <span className="text-deep-green/25">—</span>
            )}
          </td>
          <td className="border-b border-cream-line/60 px-4 py-3">
            <div className="flex items-center justify-end gap-1.5 opacity-0 transition group-hover:opacity-100">
              <button
                type="button"
                onClick={() => onEdit(v)}
                aria-label={`Edit ${v.venue_name}`}
                className="rounded-lg border border-cream-line bg-white p-1.5 text-deep-green/50 transition hover:border-mint hover:text-deep-green"
              >
                <Pencil aria-hidden size={15} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(v)}
                aria-label={`Deactivate ${v.venue_name}`}
                className="rounded-lg border border-cream-line bg-white p-1.5 text-deep-green/50 transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover"
              >
                <Trash2 aria-hidden size={15} />
              </button>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

// ============================================================
// Add / Edit modal
// ============================================================
function FieldModal({
  state,
  roster,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  state: NonNullable<ModalState>;
  roster: CityManagerRoster;
  saving: boolean;
  error: string | null;
  onChange: (form: FieldFormInput) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const f = state.form;
  const set = (patch: Partial<FieldFormInput>) => onChange({ ...f, ...patch });
  // Derived, read-only — updates the instant City changes.
  const derivedCM = cityManagerFor(f.city, roster);
  const cmUnassigned = derivedCM === UNASSIGNED_CITY_MANAGER;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-cream-line bg-white shadow-xl shadow-deep-green/25"
      >
        <div className="flex items-center justify-between border-b border-cream-line/70 px-6 py-4">
          <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
            {state.mode === "add" ? "Add field" : `Edit field · ${state.name}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-cream-line text-deep-green/45 transition hover:bg-cream-soft hover:text-deep-green"
          >
            <X aria-hidden size={17} />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-2">
          <Labeled label="Field" required hint="Short name you use internally">
            <input
              value={f.venue_name}
              onChange={(e) => set({ venue_name: e.target.value })}
              placeholder="ATH Pearland"
              className={inputCls}
            />
          </Labeled>
          <Labeled label="City" required>
            <select
              value={f.city}
              onChange={(e) => set({ city: e.target.value })}
              className={inputCls}
            >
              {CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Labeled>

          <Labeled label="Field Contact Name" hint="Person at the venue">
            <input
              value={f.contact_name}
              onChange={(e) => set({ contact_name: e.target.value })}
              className={inputCls}
            />
          </Labeled>
          <Labeled label="Field Contact" hint="Phone or email — click to call/email">
            <input
              value={f.contact_number}
              onChange={(e) => set({ contact_number: e.target.value })}
              placeholder="Phone or email"
              className={inputCls}
            />
          </Labeled>

          <Labeled label="Min Players">
            <input
              inputMode="numeric"
              value={f.min_players}
              onChange={(e) => set({ min_players: e.target.value })}
              placeholder="—"
              className={inputCls}
            />
          </Labeled>
          <Labeled label="Max Players">
            <input
              inputMode="numeric"
              value={f.max_players}
              onChange={(e) => set({ max_players: e.target.value })}
              placeholder="—"
              className={inputCls}
            />
          </Labeled>

          {/* City Manager — read-only derived chip, updates on City change */}
          <div className="sm:col-span-2">
            <Labeled label="City Manager" hint="Auto-filled from City">
              <div
                className="flex items-center gap-2 rounded-lg border border-dashed border-cream-line bg-cream-soft/50 px-3 py-2.5 text-sm"
                title="Derived from the city roster — not editable here."
              >
                {cmUnassigned ? (
                  <span className="font-semibold text-deep-green/35">
                    Unassigned
                  </span>
                ) : (
                  <>
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-deep-green text-[9.5px] font-extrabold text-mint-soft">
                      {initials(derivedCM)}
                    </span>
                    <span className="font-bold text-deep-green">{derivedCM}</span>
                  </>
                )}
                <span className="ml-auto text-[11px] font-semibold text-deep-green/35">
                  from {f.city}
                </span>
              </div>
            </Labeled>
          </div>

          <div className="sm:col-span-2">
            <Labeled
              label="Schedule link (Google Drive)"
              hint="Opens in a new tab from the Schedule column"
            >
              <input
                value={f.schedule_url}
                onChange={(e) => set({ schedule_url: e.target.value })}
                placeholder="https://drive.google.com/…"
                className={inputCls}
              />
            </Labeled>
          </div>
        </div>

        {error && (
          <p className="mx-6 rounded-lg bg-coral-soft/50 px-3 py-2 text-xs font-medium text-coral-hover">
            {error}
          </p>
        )}

        <div className="mt-1 flex justify-end gap-2 border-t border-cream-line/70 bg-cream-soft/40 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-cream-line bg-white px-4 py-2 text-sm font-bold text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-xl bg-mint px-5 py-2 text-sm font-extrabold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save field"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-cream-line bg-white px-3 py-2.5 text-sm font-semibold text-deep-green placeholder:text-deep-green/30 focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint-soft/60";

function Labeled({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-extrabold uppercase tracking-wide text-deep-green/50">
        {label}
        {required && <span className="text-mint-hover"> *</span>}
      </span>
      {children}
      {hint && <span className="text-[11px] text-deep-green/35">{hint}</span>}
    </label>
  );
}

// ============================================================
// Delete confirmation (soft-deactivate)
// ============================================================
function ConfirmDelete({
  venue,
  saving,
  onCancel,
  onConfirm,
}: {
  venue: FieldVenue;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep-green/30 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-cream-line bg-white p-6 shadow-xl shadow-deep-green/25"
      >
        <h2 className="font-display text-xl uppercase tracking-tight text-deep-green">
          Deactivate field
        </h2>
        <p className="mt-3 text-sm text-deep-green/75">
          Remove <span className="font-bold">{venue.venue_name}</span> (
          {venue.city}) from active fields? Its match and cost history is
          preserved — the field is deactivated, not deleted, so nothing is
          orphaned. You can re-add it later.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-cream-line bg-white px-4 py-2 text-sm font-bold text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="rounded-xl bg-coral px-5 py-2 text-sm font-extrabold text-white transition hover:bg-coral-hover disabled:opacity-50"
          >
            {saving ? "Deactivating…" : "Deactivate"}
          </button>
        </div>
      </div>
    </div>
  );
}
