"use client";

// Cities → Fields sub-tab. Manage the venue roster that lives on the
// CANONICAL fin_venues record (the same row Finance bills from and
// scheduling resolves to via fin_venue_fields). Reads/writes fin_venues
// directly through the session supabase client, mirroring the other
// Cities admin sub-tabs (Master Schedule); admin gating is the page-level
// PagePermissionGuard + RLS.
//
// City Manager is DERIVED from each venue's city via the city_managers
// roster — never stored on the venue, so it can't drift. All the
// validation / payload / delete-safety logic is the pure, tested
// fieldsAdmin lib.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Trash2, Plus, ExternalLink, Search, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import CityChip from "@/components/CityChip";
import { CITIES } from "@/lib/types";
import {
  cityManagerFor,
  buildFieldPayload,
  resolveDeleteAction,
  UNASSIGNED_CITY_MANAGER,
  type CityManagerRoster,
  type FieldFormInput,
} from "@/lib/fieldsAdmin";

type FieldVenue = {
  id: number;
  venue_name: string;
  city: string;
  field_name: string | null;
  contact_name: string | null;
  contact_number: string | null;
  min_players: number | null;
  max_players: number | null;
  schedule_url: string | null;
  is_active: boolean;
};

const VENUE_COLS =
  "id, venue_name, city, field_name, contact_name, contact_number, min_players, max_players, schedule_url, is_active";

const EMPTY_FORM: FieldFormInput = {
  venue_name: "",
  city: CITIES[0],
  field_name: "",
  contact_name: "",
  contact_number: "",
  min_players: "",
  max_players: "",
  schedule_url: "",
};

type ModalState =
  | { mode: "add"; form: FieldFormInput }
  | { mode: "edit"; id: number; form: FieldFormInput }
  | null;

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
        (v.field_name ?? "").toLowerCase().includes(q) ||
        (v.contact_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [venues, search, cityFilter]);

  // Group by city, in canonical CITIES order, only cities with rows.
  const groups = useMemo(() => {
    const byCity = new Map<string, FieldVenue[]>();
    for (const v of filtered) {
      const arr = byCity.get(v.city);
      if (arr) arr.push(v);
      else byCity.set(v.city, [v]);
    }
    return CITIES.filter((c) => byCity.has(c)).map((city) => ({
      city,
      manager: cityManagerFor(city, roster),
      rows: byCity.get(city)!,
    }));
  }, [filtered, roster]);

  const openAdd = useCallback((city?: string) => {
    setModalError(null);
    setModal({
      mode: "add",
      form: { ...EMPTY_FORM, city: city ?? CITIES[0] },
    });
  }, []);

  const openEdit = useCallback((v: FieldVenue) => {
    setModalError(null);
    setModal({
      mode: "edit",
      id: v.id,
      form: {
        venue_name: v.venue_name,
        city: v.city,
        field_name: v.field_name ?? "",
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
      {/* Controls */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              aria-hidden
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-deep-green/40"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search field or contact…"
              className="w-56 rounded-full border border-cream-line bg-white py-1.5 pl-8 pr-3 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-mint focus:outline-none"
            />
          </div>
          <select
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
            className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-sm font-medium text-deep-green focus:border-mint focus:outline-none"
          >
            <option value="all">All cities</option>
            {CITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => openAdd()}
          className="inline-flex items-center gap-1.5 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
        >
          <Plus aria-hidden size={15} /> Add field
        </button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-deep-green/50">
          Loading fields…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-coral/30 bg-coral-soft/40 px-4 py-3 text-sm text-coral-hover">
          {error}
        </div>
      ) : groups.length === 0 ? (
        <div className="py-16 text-center text-sm text-deep-green/50">
          {venues.length === 0
            ? "No fields yet. Add the first one."
            : "No fields match your search."}
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <div key={g.city}>
              {/* City group header — badge + derived City Manager + add */}
              <div className="mb-2 flex items-center justify-between gap-3 border-b border-cream-line pb-2">
                <div className="flex items-center gap-3">
                  <CityChip code={g.city} size="sm" />
                  <span className="text-xs text-deep-green/55">
                    City Manager:{" "}
                    <span
                      className={
                        g.manager === UNASSIGNED_CITY_MANAGER
                          ? "font-semibold text-deep-green/35"
                          : "font-semibold text-deep-green"
                      }
                    >
                      {g.manager}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => openAdd(g.city)}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green"
                >
                  <Plus aria-hidden size={13} /> Add field
                </button>
              </div>

              {/* Rows */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-deep-green/45">
                      <th className="px-3 py-1.5 font-semibold">Field</th>
                      <th className="px-3 py-1.5 font-semibold">Field Name</th>
                      <th className="px-3 py-1.5 font-semibold">Contact</th>
                      <th className="px-3 py-1.5 font-semibold">Number</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Min</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Max</th>
                      <th className="px-3 py-1.5 font-semibold">Schedule</th>
                      <th className="px-3 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((v) => (
                      <tr
                        key={v.id}
                        className="group border-t border-cream-line/60 hover:bg-cream-soft/40"
                      >
                        <td className="px-3 py-2.5 font-semibold text-deep-green">
                          {v.venue_name}
                        </td>
                        <td className="px-3 py-2.5 text-deep-green/75">
                          {v.field_name ?? (
                            <span className="text-deep-green/30">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-deep-green/75">
                          {v.contact_name ?? (
                            <span className="text-deep-green/30">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-deep-green/75">
                          {v.contact_number ?? (
                            <span className="text-deep-green/30">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-deep-green/75">
                          {v.min_players ?? (
                            <span className="text-deep-green/30">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-deep-green/75">
                          {v.max_players ?? (
                            <span className="text-deep-green/30">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {v.schedule_url ? (
                            <a
                              href={v.schedule_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-md bg-cream-soft px-2 py-0.5 text-xs font-semibold text-deep-green transition hover:bg-mint-soft"
                            >
                              Open <ExternalLink aria-hidden size={12} />
                            </a>
                          ) : (
                            <span className="text-deep-green/30">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1 opacity-0 transition group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => openEdit(v)}
                              aria-label={`Edit ${v.venue_name}`}
                              className="rounded-md p-1.5 text-deep-green/50 transition hover:bg-cream-line/60 hover:text-deep-green"
                            >
                              <Pencil aria-hidden size={15} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(v)}
                              aria-label={`Delete ${v.venue_name}`}
                              className="rounded-md p-1.5 text-deep-green/50 transition hover:bg-coral-soft hover:text-coral-hover"
                            >
                              <Trash2 aria-hidden size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <FieldModal
          state={modal}
          roster={roster}
          saving={saving}
          error={modalError}
          onChange={(form) =>
            setModal((m) => (m ? { ...m, form } : m))
          }
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-xl rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <div className="flex items-start justify-between">
          <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
            {state.mode === "add" ? "Add field" : "Edit field"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-deep-green/50 hover:bg-cream-soft hover:text-deep-green"
          >
            <X aria-hidden size={18} />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Labeled label="Field (short name)" required>
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

          <Labeled label="Field Name (full facility)">
            <input
              value={f.field_name}
              onChange={(e) => set({ field_name: e.target.value })}
              placeholder="Pearland Recreation Center"
              className={inputCls}
            />
          </Labeled>
          <Labeled label="City Manager (auto)">
            {/* Read-only derived chip — never an input, never saved. */}
            <div
              className={`flex h-[38px] items-center rounded-lg border border-dashed border-cream-line bg-cream-soft/50 px-3 text-sm ${
                derivedCM === UNASSIGNED_CITY_MANAGER
                  ? "font-medium text-deep-green/35"
                  : "font-semibold text-deep-green"
              }`}
              title="Derived from the city roster — not editable here."
            >
              {derivedCM}
            </div>
          </Labeled>

          <Labeled label="Contact Name">
            <input
              value={f.contact_name}
              onChange={(e) => set({ contact_name: e.target.value })}
              className={inputCls}
            />
          </Labeled>
          <Labeled label="Contact Number">
            <input
              value={f.contact_number}
              onChange={(e) => set({ contact_number: e.target.value })}
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

          <div className="sm:col-span-2">
            <Labeled label="Schedule link (Google Drive URL)">
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
          <p className="mt-4 rounded-lg bg-coral-soft/50 px-3 py-2 text-xs font-medium text-coral-hover">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm font-semibold text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/35 focus:border-mint focus:outline-none";

function Labeled({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-deep-green/50">
        {label}
        {required && <span className="text-coral"> *</span>}
      </span>
      {children}
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
        className="w-full max-w-md rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
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
            className="rounded-full px-4 py-2 text-sm font-semibold text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="rounded-full bg-coral px-5 py-2 text-sm font-bold text-white transition hover:bg-coral-hover disabled:opacity-50"
          >
            {saving ? "Deactivating…" : "Deactivate"}
          </button>
        </div>
      </div>
    </div>
  );
}
