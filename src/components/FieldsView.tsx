"use client";

/* FIELDS — /match-ops/fields. Clubhouse's first field admin.
 *
 * A list plus a right-hand DRAWER, matching Gameday Ops rather than a centred modal: the list
 * stays on screen, which is what lets you check one field against another while editing.
 *
 * CREATE AND EDIT ARE THE SAME FORM. They differ in exactly two ways — create has no ID chip
 * until it has one, and no Delete. There are no locked panels: a panel that says "available once
 * the field is created" is a form telling the operator to come back later.
 *
 * WHAT IS NOT HERE, and why, stated on the page as well as in the report:
 *   PHOTOS ARE READ-ONLY. `images` and `cover` are refused by the create DTO by name, and no
 *   upload endpoint exists that four targeted probes could find. The existing photos render with
 *   the cover marked and one line of fact. Not a locked panel pretending it will unlock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth, canAccess } from "@/lib/useAuth";
import {
  FORMATS, PITCH_OPTIONS, formatShort, recommendationReadout, missingRequired,
  updateBody, deleteBlock, validPhone,
  PHOTOS_READ_ONLY_NOTE, type Link,
} from "@/lib/fieldsModel";

type Field = {
  id: number; title: string; abbr: string; address: string; zipcode: number | null;
  description: string; parkingNote: string; lat: number | null; lng: number | null;
  cityId: number | null; cityName: string | null; recommendedPlayerCount: number | null;
  orderPosition: number | null; cover: string | null;
  images: { id: number; url: string }[]; matchCount: number;
};
type Payload = {
  fields: Field[]; links: { fieldId: number; venueId: number | null }[];
  activeFieldIds: number[]; cities: { id: number; name: string }[]; deleteEnabled: boolean;
};
type Phone = { id: number; phoneNumber: string; isEnabled: boolean };
type Draft = Record<string, unknown>;

const blank = (): Draft => ({
  title: "", cityId: "", abbr: "", address: "", zipcode: "", description: "",
  parkingNote: "", lat: "", lng: "", recommendedPlayerCount: "", orderPosition: "",
});
const draftOf = (f: Field): Draft => ({
  title: f.title, cityId: f.cityId ?? "", abbr: f.abbr, address: f.address,
  zipcode: f.zipcode ?? "", description: f.description, parkingNote: f.parkingNote,
  lat: f.lat ?? "", lng: f.lng ?? "", recommendedPlayerCount: f.recommendedPlayerCount ?? "",
  orderPosition: f.orderPosition ?? "",
});

export default function FieldsView() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [city, setCity] = useState<number | null>(null);
  /* REPLACES THE AMBER BANNER. The VENUE column already said Mapped/Unmapped per row, but the
   * column is neither sortable nor filterable — the header is plain divs and the sort is fixed at
   * city-then-name — so on 46 fields the only way to find the unmapped ones was to read a banner
   * listing their ids and then hunt for them. This narrows the table to them instead. */
  const [unmappedOnly, setUnmappedOnly] = useState(false);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "edit">("new");
  /* THE OPEN FIELD IS AN ID, AND THE ROW IS DERIVED FROM IT — corrected 2026-09-10.
   *
   * `cur` used to be useState<Field> holding a COPY taken when the row was clicked, and load()
   * only ever called setData(). So a cover upload finished, load() refetched, data.fields got the
   * new URL, and the panel went on rendering the object captured when the drawer opened: "LANDED —
   * cover uploaded and attached (read-back confirmed)" printed directly under "No cover on this
   * field". The upload worked; the read-back confirmed it; the component was looking at a snapshot.
   * Reproduced before the fix with the upload intercepted and the payload mutated: the response
   * carried a new cover and a second image, and the panel kept the old src and one thumbnail.
   *
   * DERIVING IT FIXES EVERY CALLER AT ONCE rather than patching the two upload handlers, and no
   * future one has to remember to re-sync. CREATE IS UNAFFECTED: curId stays null there and `mode`
   * is separate state, which is what keeps a new field's blank draft from being overwritten. */
  const [curId, setCurId] = useState<number | null>(null);
  /* See the note on curId. Null in create, and null if the open field vanishes from a refetch —
   * which closes the drawer's edit-only sections rather than rendering a stale one. */
  const cur = useMemo<Field | null>(
    () => (curId == null ? null : (data?.fields ?? []).find((f) => f.id === curId) ?? null),
    [data, curId],
  );

  const [orig, setOrig] = useState<Draft>(blank());
  const [draft, setDraft] = useState<Draft>(blank());
  const [pitches, setPitches] = useState(1);
  const [phones, setPhones] = useState<Phone[]>([]);
  const [phoneIn, setPhoneIn] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ lines: string[]; bad: boolean } | null>(null);
  /* WHICH REPLACED delText. The confirmation is a yes/no now, not a typing exercise. */
  const [confirming, setConfirming] = useState(false);

  /* ── THE VENUE HALF OF THE DRAWER ───────────────────────────────────────────────────────────
   * fin_venues is ONE row behind two sections. canFinance only disables the controls; the refusal
   * that matters is /api/venues, which checks can_access_finance server-side and refuses a
   * confined account before the is_admin term. */
  const { appUser } = useAuth();
  const canFinance = canAccess(appUser, "finance");
  type VenueRow = { id: number; venue_name: string; city: string } & Record<string, unknown>;
  const [venueList, setVenueList] = useState<VenueRow[]>([]);
  const [venueCounts, setVenueCounts] = useState<Record<number, number>>({});
  const [venueCur, setVenueCur] = useState<number | null>(null);
  const [siblings, setSiblings] = useState<{ fieldId: number; title: string | null }[]>([]);
  const [venueMode, setVenueMode] = useState<"new" | "existing">("new");
  const [venuePick, setVenuePick] = useState<number | null>(null);
  const [vd, setVd] = useState<Record<string, unknown>>({});
  const [vdOrig, setVdOrig] = useState<Record<string, unknown>>({});
  const [venueBusy, setVenueBusy] = useState(false);
  const [venueMsg, setVenueMsg] = useState<{ text: string; bad: boolean } | null>(null);
  /* ASKED ONLY WHEN THE VENUE IS SHARED. A 1:1 venue saves straight through — a prompt there would
   * be a prompt about nothing, and the one that matters would start being clicked past. */
  const [venueAsk, setVenueAsk] = useState(false);

  /* SHARED NO LONGER MEANS READ-ONLY (2026-09-10). It did for a day, on the reasoning that editing
   * one pitch's drawer would silently move the others — but the silence was the problem, not the
   * write. The warning above still names them, and saving a SHARED venue now asks once, listing
   * the fields, so the operator says yes to that specific set. Locked only without finance, while
   * a save is in flight, or before a venue has been picked. */
  const venueLocked = !canFinance || venueBusy
    || (venueCur == null && venueMode === "existing" && venuePick == null);
  const venueDirty = useMemo(
    () => JSON.stringify(vd) !== JSON.stringify(vdOrig), [vd, vdOrig]);
  /* PHOTO WRITES ARE THEIR OWN BUSY AND THEIR OWN MESSAGE, separate from Save's. They do not
   * stage and they do not ride the field PUT — an upload is a different endpoint with a different
   * verdict, and mixing it into the save bar would make one message stand for two writes. */
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const removePhoto = async (fieldId: number, imageId: number) => {
    if (photoBusy) return;
    const h = await headers(); if (!h) { setPhotoMsg({ text: "No active session — sign in again.", bad: true }); return; }
    setPhotoBusy(true); setPhotoMsg(null);
    try {
      const r = await fetch(`/api/fields/photos?id=${fieldId}&imageId=${imageId}`, { method: "DELETE", headers: h });
      const j = await r.json().catch(() => ({}));
      // THE VERDICT IS THE ROUTE'S, from its read-back — never the status code.
      if (!r.ok) { setPhotoMsg({ text: j.error ?? `HTTP ${r.status}`, bad: true }); return; }
      setPhotoMsg(j.verdict === "LANDED"
        ? { text: `LANDED — photo ${imageId} removed (read-back confirmed).`, bad: false }
        : { text: `${j.verdict} — the read-back still shows photo ${imageId}. Refresh before trying again.`, bad: true });
      await load();
    } catch (e) {
      setPhotoMsg({ text: `UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Refresh before acting.`, bad: true });
    } finally { setPhotoBusy(false); }
  };
  const drawerRef = useRef<HTMLDivElement | null>(null);

  const headers = useCallback(async () => {
    const { data: s } = await supabase.auth.getSession();
    const t = s.session?.access_token;
    return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : null;
  }, []);

  /* IT RETURNS THE PAYLOAD, and that is not decoration. The post-save re-seed below used to do
   *   await load(); const f = (data?.fields ?? []).find(...)
   * where `data` is the value captured when that handler was created — i.e. from BEFORE the load
   * it had just awaited. It re-seeded `orig` from the pre-save copy, so the dirty diff was measured
   * against stale values. Returning the fetched payload gives the caller the rows it actually just
   * read; `cur` itself no longer needs re-syncing at all, because it is derived. */
  const load = useCallback(async (): Promise<Payload | null> => {
    const h = await headers(); if (!h) return null;
    const r = await fetch("/api/fields", { headers: h });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "load failed"); return null; }
    setErr(null); setData(j as Payload); return j as Payload;
  }, [headers]);
  useEffect(() => { void load(); }, [load]);

  const linkList: Link[] = useMemo(
    () => (data?.links ?? []).map((l) => ({ mdapi_field_id: l.fieldId, fin_venue_id: l.venueId })),
    [data]);
  const mappedIds = useMemo(() => new Set(linkList.map((l) => Number(l.mdapi_field_id))), [linkList]);
  const unmappedCount = useMemo(
    () => (data?.fields ?? []).filter((f) => !mappedIds.has(f.id)).length, [data, mappedIds]);

  /* summary (unmappedSummary) AND orphans (orphanLinks) WERE COMPUTED HERE, for the two banners
   * that came off on 2026-09-10. liveIds and activeIds went with them — they existed only to feed
   * those two calls. data.activeFieldIds is still sent by the route and nothing reads it now.
   * orphanLinks itself is KEPT and unused; the note on it in fieldsModel.ts says why and where it
   * should go. unmappedSummary is deleted — the Unmapped chip above counts the same fields from
   * mappedIds, which the VENUE column already uses. */

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const f of data?.fields ?? []) if (f.cityId != null) m.set(f.cityId, (m.get(f.cityId) ?? 0) + 1);
    return m;
  }, [data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.fields ?? [])
      .filter((f) => (city == null || f.cityId === city)
        && (!unmappedOnly || !mappedIds.has(f.id))
        && (!needle || `${f.title} ${f.abbr} ${f.address} ${f.id}`.toLowerCase().includes(needle)))
      .sort((a, b) => (a.cityName ?? "").localeCompare(b.cityName ?? "") || a.title.localeCompare(b.title));
    // unmappedOnly AND mappedIds BOTH BELONG HERE. Without them the clause above is inert: the chip
    // flipped aria-pressed and the table stayed at 46 rows, because the memo never recomputed.
  }, [data, q, city, unmappedOnly, mappedIds]);

  const loadPhones = useCallback(async (fieldId: number) => {
    const h = await headers(); if (!h) return;
    const r = await fetch(`/api/fields/phones?fieldId=${fieldId}`, { headers: h });
    const j = await r.json();
    setPhones(r.ok ? (j.phones ?? []) : []);
  }, [headers]);

  const openNew = () => {
    setMode("new"); setCurId(null); setOrig(blank()); setDraft(blank());
    setPitches(1); setPhones([]); setPhoneIn(""); setResult(null); setConfirming(false); void loadVenue(null);
    setOpen(true);
  };
  const openEdit = (f: Field) => {
    setMode("edit"); setCurId(f.id ?? null); setOrig(draftOf(f)); setDraft(draftOf(f));
    setPitches(1); setPhoneIn(""); setResult(null); setConfirming(false);
    setPhones([]); void loadPhones(f.id); void loadVenue(f.id ?? null);
    setOpen(true);
  };
  const close = () => { setOpen(false); setCurId(null); setResult(null); };

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));

  const missing = useMemo(() => missingRequired(draft), [draft]);
  const diff = useMemo(() => (mode === "edit" ? updateBody(orig, draft) : {}), [mode, orig, draft]);
  const diffN = Object.keys(diff).length;
  const canSave = mode === "new" ? missing.length === 0 : diffN > 0;

  /* ── SAVE ──────────────────────────────────────────────────────────────────────────────────
   * CREATE IS ONE STEP NOW. It used to be two: the field, then a flush of phone numbers that had
   * been staged client-side because they attach to a field id that does not exist until the create
   * returns. Cancellation texts became edit-only on 2026-09-10, so nothing can stage a number and
   * the second step had nothing to do.
   *
   * WHEN A SAVE FAILS THE FIELD STILL EXISTS. We do not roll back, do not retry, and never re-POST
   * the field — a second POST is a second field. The drawer flips to EDIT on the new id and says,
   * per item, what landed and what did not. */
  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true); setResult(null);
    const h = await headers();
    if (!h) { setBusy(false); return; }
    const lines: string[] = []; let bad = false;

    try {
      let fieldId = cur?.id ?? null;

      if (mode === "new") {
        const r = await fetch("/api/fields", { method: "POST", headers: h, body: JSON.stringify(draft) });
        const j = await r.json();
        if (j.verdict !== "LANDED" || !j.id) {
          setResult({ lines: [`Field NOT created — ${j.verdict ?? "FAILED"}${j.error ? `: ${j.error}` : ""}`], bad: true });
          setBusy(false); return;
        }
        fieldId = Number(j.id);
        lines.push(`Field created — ID ${fieldId}.`);
        // THE DRAWER IS NOW IN EDIT MODE ON A REAL ID, whatever happens next.
        const row: Field = { ...(j.row as Field), matchCount: 0, images: (j.row?.images ?? []) };
        setMode("edit"); setCurId(row.id ?? null); setOrig(draftOf(row)); setDraft(draftOf(row));
        void loadVenue(row.id ?? null);
      } else if (diffN > 0) {
        const r = await fetch(`/api/fields?id=${cur!.id}`, {
          method: "PUT", headers: h, body: JSON.stringify({ orig, draft }),
        });
        const j = await r.json();
        if (j.verdict === "LANDED") lines.push(`Saved ${Object.keys(diff).length} change${diffN === 1 ? "" : "s"}.`);
        else if (j.verdict === "NOT APPLIED") lines.push("Nothing changed — nothing was sent.");
        else { lines.push(`Changes ${j.verdict}${j.error ? `: ${j.error}` : ""}.`); bad = true; }
      }

      /* THE STAGED-NUMBER FLUSH STOOD HERE and is gone with the create-mode section (2026-09-10).
       * It walked an array that only the create panel could fill, POSTing each number once the new
       * field had an id. Cancellation texts are edit-only now, addPhone's single caller lives in
       * that section, and in edit `cur` is always set — so nothing could ever reach the array and a
       * loop over it would always be a loop over nothing. */

      if (mode === "new" || bad) {
        // Photos are read-only; say it here too so a create does not look like it dropped them.
        lines.push(PHOTOS_READ_ONLY_NOTE);
      }
      setResult({ lines, bad });
      const fresh = await load();
      // FROM WHAT load JUST READ, not from the closure's older `data`. See the note on load().
      if (mode === "edit" && !bad) { const f = (fresh?.fields ?? []).find((x) => x.id === curId); if (f) setOrig(draftOf(f)); }
    } finally { setBusy(false); }
  };

  /* LOAD THE VENUE PICTURE FOR THE OPEN FIELD. One GET, matchops-gated, so the section renders
   * with real values for a city manager who cannot change them. */
  const loadVenue = useCallback(async (fieldId: number | null) => {
    const h = await headers(); if (!h) return;
    setVenueMsg(null); setVenuePick(null); setVenueMode("new");
    const r = await fetch(`/api/venues${fieldId ? `?fieldId=${fieldId}` : ""}`, { headers: h, cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setVenueList([]); setVenueCur(null); setSiblings([]); return; }
    setVenueList(j.venues ?? []); setVenueCounts(j.counts ?? {});
    const curVenueId: number | null = j.current?.venueId ?? null;
    setVenueCur(curVenueId);
    setSiblings(j.current?.siblings ?? []);
    const row = (j.venues ?? []).find((v: { id: number }) => v.id === curVenueId) ?? {};
    // THE SAME SHAPE EITHER WAY, so the form does not branch on whether a venue exists yet.
    const seed = {
      venue_name: row.venue_name ?? "", city: row.city ?? "", billing_type: row.billing_type ?? "per_match",
      per_match_rate: row.per_match_rate ?? "", cost_per_match: row.cost_per_match ?? "",
      charge_on_cancel: row.charge_on_cancel === true,
      min_players: row.min_players ?? "", max_players: row.max_players ?? "",
      contact_name: row.contact_name ?? "", contact_number: row.contact_number ?? "",
      schedule_url: row.schedule_url ?? "",
    };
    setVd(seed); setVdOrig(seed);
  }, [headers]);

  /* THREE WRITES CAN FAIL INDEPENDENTLY and this owns two of them. The route reports its own
   * partial — venue created, link failed — and this never turns that into a success line. */
  const saveVenue = async () => {
    if (venueBusy || !cur?.id) return;
    setVenueAsk(false);
    const h = await headers(); if (!h) { setVenueMsg({ text: "No active session.", bad: true }); return; }
    setVenueBusy(true); setVenueMsg(null);
    try {
      const num = (v: unknown) => (v === "" || v == null ? null : Number(v));
      const payload = { ...vd,
        per_match_rate: num(vd.per_match_rate), cost_per_match: num(vd.cost_per_match),
        min_players: num(vd.min_players), max_players: num(vd.max_players),
        field_title_at_link: cur.title ?? null };
      const linkTo = venueCur ?? (venueMode === "existing" ? venuePick : null);
      const r = linkTo != null && venueCur != null
        ? await fetch("/api/venues", { method: "PATCH", headers: { ...h, "Content-Type": "application/json" },
            body: JSON.stringify({ id: venueCur, patch: payload }) })
        : await fetch("/api/venues", { method: "POST", headers: { ...h, "Content-Type": "application/json" },
            body: JSON.stringify({ venue: payload, fieldId: cur.id }) });
      const j = await r.json();
      if (!r.ok) { setVenueMsg({ text: j.error ?? `HTTP ${r.status}`, bad: true }); return; }
      // NEVER "SAVED" FOR A HALF-DONE JOB. The route's own note names what did not happen.
      const said = j.partial
        ? { text: j.note as string, bad: true }
        : { text: venueCur ? "Venue saved." : `Venue created and linked to field ${cur.id}.`, bad: false };
      await load();
      await loadVenue(cur.id);
      /* SET AFTER THE RELOAD, NOT BEFORE. loadVenue clears venueMsg — it has to, or a stale error
       * from the last field follows you to the next one — so setting it first meant a confirmed
       * save reported nothing at all. Measured: the shared-venue path showed "(none)" while the
       * PATCH had landed. */
      setVenueMsg(said);
    } catch (e) {
      setVenueMsg({ text: `UNKNOWN: ${e instanceof Error ? e.message : String(e)}. Reload before acting.`, bad: true });
    } finally { setVenueBusy(false); }
  };

  const addPhone = async () => {
    const v = phoneIn.trim();
    if (!validPhone(v)) return;
    /* EDIT ONLY, AND THE GUARD IS REAL RATHER THAN A FALLBACK. This used to stage the number when
     * there was no field id yet; the section it lives in no longer renders in create, so the only
     * way here is with a field selected. Returning on a missing one beats reaching for cur.id. */
    if (!cur) return;
    setBusy(true);
    const h = await headers();
    if (h) {
      const r = await fetch(`/api/fields/phones?fieldId=${cur.id}`, {
        method: "POST", headers: h, body: JSON.stringify({ phoneNumber: v }),
      });
      const j = await r.json();
      setResult({ lines: [j.verdict === "LANDED" ? `Phone ${v} added.` : `Phone ${v} NOT added — ${j.verdict}.`], bad: j.verdict !== "LANDED" });
      if (j.phones) setPhones(j.phones);
      setPhoneIn("");
    }
    setBusy(false);
  };

  const removePhone = async (p: Phone) => {
    if (!cur || busy) return;
    setBusy(true);
    const h = await headers();
    if (h) {
      const r = await fetch(`/api/fields/phones?fieldId=${cur.id}&phoneId=${p.id}`, { method: "DELETE", headers: h });
      const j = await r.json();
      setResult({ lines: [j.verdict === "LANDED" ? "Number removed." : `Number NOT removed — ${j.verdict}.`], bad: j.verdict !== "LANDED" });
      if (j.phones) setPhones(j.phones);
    }
    setBusy(false);
  };

  const del = async () => {
    if (!cur || busy) return;
    setBusy(true);
    const h = await headers();
    if (h) {
      const r = await fetch(`/api/fields?id=${cur.id}&confirm=${encodeURIComponent(cur.title ?? "")}`, { method: "DELETE", headers: h });
      const j = await r.json();
      setResult({ lines: [j.verdict === "LANDED" ? "Field deleted." : (j.error ?? `Delete ${j.verdict}.`)], bad: j.verdict !== "LANDED" });
      if (j.verdict === "LANDED") { await load(); close(); }
    }
    setBusy(false);
  };

  const delBlock = cur ? deleteBlock(cur.matchCount) : { ok: false, reason: "Delete field" };
  const fmtTotal = Number(draft.recommendedPlayerCount) || null;

  return (
    <div className="fv">
      <div className="fv-head">
        <div>
          <h1>Fields</h1>
          <p className="fv-sub">Every pitch MatchDay plays on. Create one, edit one, or map it to a venue so its cost and revenue land somewhere.</p>
        </div>
        <span className="fv-live"><i />PRODUCTION · LIVE EDITS</span>
      </div>

      {err && <div className="fv-err" data-testid="fv-error">Couldn’t load fields: {err}</div>}

      <div className="fv-card">
        <div className="fv-bar">
          <input className="fv-q" data-testid="fv-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Field name, abbreviation, address or ID" />
          <span className="fv-lbl">City</span>
          <button className={"fv-chip" + (city === null ? " on" : "")} data-testid="fv-city-all"
            onClick={() => setCity(null)}>All <span className="n">{data?.fields.length ?? 0}</span></button>
          {(data?.cities ?? []).filter((c) => (counts.get(c.id) ?? 0) > 0).map((c) => (
            <button key={c.id} className={"fv-chip" + (city === c.id ? " on" : "")} data-testid={`fv-city-${c.id}`}
              onClick={() => setCity(c.id)}>{c.name} <span className="n">{counts.get(c.id) ?? 0}</span></button>
          ))}
          {/* THE UNMAPPED FILTER. Offered only when there ARE unmapped fields, and it carries the
              count — so on a clean estate the control is absent rather than a chip reading 0. */}
          {unmappedCount > 0 && (
            <button className={"fv-chip" + (unmappedOnly ? " on" : "")} data-testid="fv-unmapped-filter"
              aria-pressed={unmappedOnly} title="Fields with no fin_venue_fields row — no cost or revenue path can attribute their matches"
              onClick={() => setUnmappedOnly((v) => !v)}>Unmapped <span className="n">{unmappedCount}</span></button>
          )}
          <button className="fv-add" data-testid="fv-new" onClick={openNew}>+ New field</button>
        </div>

        {/* TWO BANNERS STOOD HERE and came off on 2026-09-10.
            The amber one counted fields with no fin_venue_fields row; the VENUE column says
            Mapped/Unmapped per row and the chip beside the city filter now narrows to them, which
            is the same signal where you can act on it. WHAT THE BANNER ALSO SAID AND THIS DOES
            NOT: how many of those are running matches THIS MONTH — unmappedSummary's second
            number. Nothing surfaces that now; it needs a home on Field Cost if it matters.
            The blue one is discussed at orphanLinks in fieldsModel.ts. */}

        <div className="fv-thead">
          <div>ID</div><div>Field</div><div>Abbr</div><div>City</div><div>Address</div><div>Format</div><div>Venue</div>
        </div>
        <div data-testid="fv-rows">
          {!data ? <div className="fv-empty" data-testid="fv-loading">Loading fields…</div>
            : rows.length === 0 ? <div className="fv-empty">No field matches that.</div>
              : rows.map((f) => (
                <div key={f.id} className={"fv-row" + (cur?.id === f.id ? " sel" : "")} data-testid="fv-row" data-id={f.id}
                  onClick={() => openEdit(f)}>
                  <div className="fv-id">{f.id}</div>
                  <div className="fv-nm" title={f.title}>{f.title}</div>
                  <div><span className="fv-abbr">{f.abbr || "—"}</span></div>
                  <div className="fv-addr">{f.cityName ?? "—"}</div>
                  <div className="fv-addr" title={f.address}>{f.address || "—"}</div>
                  <div className="fv-fmt">{formatShort(f.recommendedPlayerCount)}</div>
                  <div className={"fv-map " + (mappedIds.has(f.id) ? "ok" : "no")}
                    data-testid={mappedIds.has(f.id) ? "fv-mapped" : "fv-unmapped-cell"}>
                    {mappedIds.has(f.id) ? "Mapped" : "Unmapped"}</div>
                </div>
              ))}
        </div>
        <div className="fv-foot">
          <span data-testid="fv-count">{rows.length} field{rows.length === 1 ? "" : "s"}{data && rows.length !== data.fields.length ? ` of ${data.fields.length}` : ""}</span>
          <span>Sorted by city, then name</span>
        </div>
      </div>

      {open && <div className="fv-scrim" onClick={close} />}
      <aside className={"fv-dr" + (open ? " on" : "")} ref={drawerRef} data-testid="fv-drawer" aria-hidden={!open}>
        <div className="fv-drtop">
          <h2>{mode === "new" ? "New field" : cur?.title}</h2>
          {cur && <span className="fv-idc" data-testid="fv-drawer-id">ID {cur.id}</span>}
          <button className="fv-x" data-testid="fv-close" onClick={close}>✕ Close</button>
        </div>

        <div className="fv-drbody">
          <Sect title="Identity">
            <div className="fv-g2">
              <F label="Field name" req>
                <input data-testid="fv-title" value={String(draft.title ?? "")} onChange={(e) => set("title", e.target.value)} placeholder="PARMER Stadium" />
              </F>
              <F label="City" req>
                <select data-testid="fv-city" value={String(draft.cityId ?? "")} onChange={(e) => set("cityId", e.target.value)}>
                  <option value="">Select a city</option>
                  {(data?.cities ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </F>
              <F label="Abbreviation" req>
                <input data-testid="fv-abbr" maxLength={12} value={String(draft.abbr ?? "")} onChange={(e) => set("abbr", e.target.value)} placeholder="PARMER" />
              </F>
              {/* ORDER POSITION IS UPDATE-ONLY. The create DTO refuses it by name — "property
                  orderPosition should not exist" — and the server assigns it as the new id. */}
              {/* THE HINT IS EDIT-ONLY NOW. The create branch explained why the control is
                  disabled — the DTO refuses orderPosition by name — and that reason is above, on
                  the code, where it belongs. The edit branch says what the number DOES and stays. */}
              <F label="Order position" hint={mode === "new" ? undefined : "Where it sits in the player app's field list."}>
                <input data-testid="fv-order" type="number" disabled={mode === "new"}
                  value={String(draft.orderPosition ?? "")} onChange={(e) => set("orderPosition", e.target.value)} />
              </F>
            </div>
          </Sect>

          <Sect title="Where it is">
            <F label="Address" req>
              <input data-testid="fv-address" value={String(draft.address ?? "")} onChange={(e) => set("address", e.target.value)} placeholder="13000 Harris Ridge Blvd" />
            </F>
            <div className="fv-g3" style={{ marginTop: 12 }}>
              {/* ZIPCODE IS A NUMBER IN THE API. We send digits and show what is stored — Warsaw's
                  01-452 is already 1452 upstream and we do not re-pad it back into something the
                  API never held. */}
              <F label="Zipcode"><input data-testid="fv-zip" value={String(draft.zipcode ?? "")} onChange={(e) => set("zipcode", e.target.value)} placeholder="78753" /></F>
              <F label="Latitude"><input data-testid="fv-lat" value={String(draft.lat ?? "")} onChange={(e) => set("lat", e.target.value)} placeholder="30.406969" /></F>
              <F label="Longitude"><input data-testid="fv-lng" value={String(draft.lng ?? "")} onChange={(e) => set("lng", e.target.value)} placeholder="-97.651949" /></F>
            </div>
            <div className="fv-derived" data-testid="fv-geo">
              {draft.lat && draft.lng ? <>Pin drops at <b>{String(draft.lat)}, {String(draft.lng)}</b></>
                : "The player app maps from lat/long, not from the address text."}
            </div>
          </Sect>

          <Sect title="Play">
            <div className="fv-g2">
              {/* THE VALUE ON THE WIRE IS THE TOTAL. The label carries both readings so nobody has
                  to remember which one is stored — a 9 v 9 pitch stores 18. */}
              <F label="Recommended player count" req>
                <select data-testid="fv-format" value={String(draft.recommendedPlayerCount ?? "")}
                  onChange={(e) => set("recommendedPlayerCount", e.target.value)}>
                  <option value="">Select a format</option>
                  {FORMATS.map((f) => <option key={f.total} value={f.total}>{f.label}</option>)}
                </select>
              </F>
              {/* DISPLAY-ONLY. It shades the readout and reaches nothing else — resolveSoccerCentral
                  is untouched by this page. */}
              <F label="Pitches at this field">
                <select data-testid="fv-pitches" value={String(pitches)} onChange={(e) => setPitches(Number(e.target.value))}>
                  {PITCH_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </F>
            </div>
            {/* A RECOMMENDATION, NOT A CAP. 23 fields run matches at counts other than their own
                rpc; 1486 has 22 and runs 18 through 36. */}
            <div className="fv-derived" data-testid="fv-recommendation">{recommendationReadout(fmtTotal, pitches)}</div>
          </Sect>

          {/* ── VENUE & COST, AND ON THE DAY ──────────────────────────────────────────────────
              Ryan: "I dont think you should have to go to finance page to add field, you should be
              able to put field cost etc whatever you need for mapping here".

              BOTH SECTIONS WRITE ONE fin_venues ROW. Field Ops' dialog and Field Costs' dialog are
              two editors over the same table with different column subsets — min_players,
              max_players, contact_name, contact_number and schedule_url are fin_venues columns
              (0074), not a separate "field ops" store. That is why visiting both was necessary and
              why this does not need a sync: it is the same row.

              VISIBLE TO MATCHOPS, EDITABLE WITH FINANCE. A city manager seeing that a field has no
              cost mapping is useful; a city manager setting a rate is a privilege escalation. The
              control renders and says why it is locked, the way PlayerLookup does for EDIT CREDITS.
              THE REAL GATE IS THE ROUTE: /api/venues refuses POST and PATCH without
              can_access_finance, and capabilities.can() refuses a confined account before the
              is_admin term. A disabled input is a courtesy. */}
          <Sect title="Venue & cost" tag="Clubhouse only">
            {!canFinance && (
              <p className="fv-lock" data-testid="fv-venue-locked">
                Editing a venue needs <b>Finance</b>. You can see the mapping; changing a rate or a
                player limit is done on Field Costs.
              </p>
            )}

            {mode === "new" ? (
              <p className="fv-lock" data-testid="fv-venue-new">Save the field first — a venue links to a field id, and there is not one yet.</p>
            ) : (
              <>
                {/* THE TWO MODES, as approved. Create is the Bob Jones case and is 1:1; Use existing
                    is the second-pitch case and is where the sharing warning lives. */}
                {!venueCur && (
                  <div className="fv-vmode" data-testid="fv-venue-mode">
                    <button type="button" className={"fv-chip" + (venueMode === "new" ? " on" : "")}
                      disabled={!canFinance} onClick={() => setVenueMode("new")}>Create a new venue</button>
                    <button type="button" className={"fv-chip" + (venueMode === "existing" ? " on" : "")}
                      disabled={!canFinance} onClick={() => setVenueMode("existing")}>Use an existing venue</button>
                  </div>
                )}

                {/* THE PICKER SITS ABOVE THE WARNING, AND THE WARNING ABOVE THE VALUES IT GOVERNS.
                    You choose, then you are told, then you see what you cannot change. */}
                {!venueCur && venueMode === "existing" && (
                  <F label="Venue">
                    <select data-testid="fv-venue" disabled={!canFinance} value={venuePick ?? ""}
                      onChange={(e) => setVenuePick(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">Select a venue</option>
                      {venueList.map((v) => (
                        <option key={v.id} value={v.id}>{v.venue_name} · {v.city}{(venueCounts[v.id] ?? 0) > 0 ? ` — ${venueCounts[v.id]} field${venueCounts[v.id] === 1 ? "" : "s"}` : ""}</option>
                      ))}
                    </select>
                  </F>
                )}

                {/* SHARED: NAME THE OTHERS, WITH THEIR IDS. fin_venue_fields is many-to-one, so a
                    rate changed here can move three other pitches. This is the failure the mock's
                    option C illustrates and the reason the values below go read-only. */}
                {siblings.length > 0 && (
                  <div className="fv-share" data-testid="fv-venue-shared" data-n={siblings.length}>
                    <span>⚠</span>
                    <div>
                      <b>{siblings.length} other field{siblings.length === 1 ? "" : "s"} already use{siblings.length === 1 ? "s" : ""} this venue</b>
                      Cost, rates, player limits and the field contact are set per VENUE. Changing them here changes them for:
                      <ul>{siblings.map((sb) => <li key={sb.fieldId}>{sb.title ?? "Field"} · {sb.fieldId}</li>)}</ul>
                    </div>
                  </div>
                )}
                {venueCur && siblings.length === 0 && (
                  <p className="fv-only" data-testid="fv-venue-only">✓ This venue covers this field only.</p>
                )}
                {!venueCur && venueMode === "new" && (
                  <p className="fv-only" data-testid="fv-venue-only">✓ This venue will cover this field only.</p>
                )}

                <div className="fv-g2" style={{ marginTop: 12 }}>
                  <F label="Venue name" req={venueMode === "new" && !venueCur}>
                    <input data-testid="fv-venue-name" value={String(vd.venue_name ?? "")} disabled={venueLocked}
                      onChange={(e) => setVd({ ...vd, venue_name: e.target.value })} placeholder="Bob Jones Park" /></F>
                  <F label="City" req={venueMode === "new" && !venueCur}>
                    <input data-testid="fv-venue-city" value={String(vd.city ?? "")} disabled={venueLocked}
                      onChange={(e) => setVd({ ...vd, city: e.target.value })} placeholder="Austin" /></F>
                </div>
                <div className="fv-g3" style={{ marginTop: 12 }}>
                  <F label="Billing type">
                    <select data-testid="fv-billing" value={String(vd.billing_type ?? "per_match")} disabled={venueLocked}
                      onChange={(e) => setVd({ ...vd, billing_type: e.target.value })}>
                      <option value="per_match">per_match</option>
                      <option value="monthly_flat">monthly_flat</option>
                      <option value="profit_share">profit_share</option>
                    </select></F>
                  <F label="Per-match rate">
                    <input data-testid="fv-rate" inputMode="decimal" value={String(vd.per_match_rate ?? "")} disabled={venueLocked}
                      onChange={(e) => setVd({ ...vd, per_match_rate: e.target.value })} placeholder="160" /></F>
                  <F label="Cost / match">
                    <input data-testid="fv-cost" inputMode="decimal" value={String(vd.cost_per_match ?? "")} disabled={venueLocked}
                      onChange={(e) => setVd({ ...vd, cost_per_match: e.target.value })} placeholder="160" /></F>
                </div>
                <div style={{ marginTop: 12 }}>
                  {/* EXPOSED. A per-venue yes/no the person setting the field up knows.
                      billing_cadence and bills_per_reservation are NOT here — see /api/venues. */}
                  <F label="Charge on cancel">
                    <select data-testid="fv-cancel" value={vd.charge_on_cancel ? "yes" : "no"} disabled={venueLocked}
                      onChange={(e) => setVd({ ...vd, charge_on_cancel: e.target.value === "yes" })}>
                      <option value="no">No</option><option value="yes">Yes</option>
                    </select></F>
                </div>
              </>
            )}
          </Sect>

          {mode === "edit" && (
          <Sect title="On the day">
            <div className="fv-g2">
              <F label="Min players"><input data-testid="fv-minp" inputMode="numeric" value={String(vd.min_players ?? "")} disabled={venueLocked}
                onChange={(e) => setVd({ ...vd, min_players: e.target.value })} /></F>
              <F label="Max players"><input data-testid="fv-maxp" inputMode="numeric" value={String(vd.max_players ?? "")} disabled={venueLocked}
                onChange={(e) => setVd({ ...vd, max_players: e.target.value })} /></F>
            </div>
            <div className="fv-g2" style={{ marginTop: 12 }}>
              <F label="Field contact name"><input data-testid="fv-cname" value={String(vd.contact_name ?? "")} disabled={venueLocked}
                onChange={(e) => setVd({ ...vd, contact_name: e.target.value })} /></F>
              <F label="Field contact"><input data-testid="fv-cnum" value={String(vd.contact_number ?? "")} disabled={venueLocked}
                onChange={(e) => setVd({ ...vd, contact_number: e.target.value })} /></F>
            </div>
            <div style={{ marginTop: 12 }}>
              <F label="Schedule link"><input data-testid="fv-sched" value={String(vd.schedule_url ?? "")} disabled={venueLocked}
                onChange={(e) => setVd({ ...vd, schedule_url: e.target.value })} placeholder="https://" /></F>
            </div>
            {venueDirty && canFinance && !venueLocked && (
              venueAsk ? (
                /* ONE LINE, THE FIELDS NAMED, TWO BUTTONS — the reduce-to-2-teams shape from
                   1301b20. NAMED, not counted: "3 fields" cannot tell you whether you meant it. */
                <div className="fv-confirm" data-testid="fv-venue-ask">
                  <b>Change the rate for {siblings.length + 1} fields?</b>
                  <span className="fv-asknames">{[cur?.title ?? `Field ${cur?.id}`, ...siblings.map((sb) => sb.title ?? `Field ${sb.fieldId}`)].join(" · ")}</span>
                  <div className="fv-cacts">
                    <button className="fv-chip" data-testid="fv-venue-cancel" onClick={() => setVenueAsk(false)}>Cancel</button>
                    <button className="fv-add" data-testid="fv-venue-go" disabled={venueBusy} onClick={() => void saveVenue()}>Change it</button>
                  </div>
                </div>
              ) : (
                <div className="fv-addrow" style={{ marginTop: 12 }}>
                  <button className="fv-add" data-testid="fv-venue-save" disabled={venueBusy}
                    onClick={() => (siblings.length > 0 ? setVenueAsk(true) : void saveVenue())}>
                    {venueBusy ? "Saving…" : venueCur ? "Save venue" : "Create venue and link it"}
                  </button>
                </div>
              )
            )}
            {venueMsg && <p className={"fv-hint" + (venueMsg.bad ? " fv-bad" : "")} data-testid="fv-venue-msg">{venueMsg.text}</p>}
          </Sect>
          )}

          {/* "NOTES", NOT "DESCRIPTION". The section held Description AND Parking note, so naming
              it after one of its two fields was wrong on its own — and it stacked the same word
              twice, heading above label, which is what read as broken. Renaming fixes both; dropping
              the inner label instead would leave the textarea unlabelled and make Parking note look
              like a sub-part of Description. */}
          <Sect title="Notes">
            <F label="Description"><textarea data-testid="fv-desc" value={String(draft.description ?? "")} onChange={(e) => set("description", e.target.value)} /></F>
            <div style={{ marginTop: 12 }}>
              <F label="Parking note"><input data-testid="fv-parking" value={String(draft.parkingNote ?? "")} onChange={(e) => set("parkingNote", e.target.value)} /></F>
            </div>
          </Sect>

          {/* EDIT ONLY (2026-09-10). Ryan: "can do it for editing messages not adding." Numbers
              attach to a field id, and this used to STAGE them in create and flush after the field
              landed. With the section gone from create nothing can stage one — addPhone's only
              caller lives in here, and in edit `cur` is always set — so the staging array, its
              dashed pending rows, the post-create flush and their share of the pending count all
              went with it. See addPhone and the save handler. */}
          {mode === "edit" && (
          <Sect title="Cancellation texts">
            <div className="fv-phones" data-testid="fv-phones">
              {phones.map((p) => (
                <div className="fv-ph" key={p.id} data-testid="fv-phone">
                  <span className="fv-num">{p.phoneNumber}</span>
                  <span className={"fv-en " + (p.isEnabled ? "on" : "off")}>{p.isEnabled ? "enabled" : "disabled"}</span>
                  <button className="fv-rm" disabled={busy} onClick={() => void removePhone(p)}>Remove</button>
                </div>
              ))}
              {phones.length === 0 && (
                <div className="fv-ph empty"><span className="fv-num2">No numbers — nobody is texted when a match here is cancelled.</span></div>
              )}
            </div>
            <div className="fv-addrow">
              <input data-testid="fv-phone-in" value={phoneIn} onChange={(e) => setPhoneIn(e.target.value)} placeholder="+1 512 555 0147" />
              <button className="fv-add" data-testid="fv-phone-add" disabled={!validPhone(phoneIn)} onClick={() => void addPhone()}>Add number</button>
            </div>
          </Sect>
          )}

          {/* TWO CONTROLS, NOT ONE GRID. Cover and gallery are separate in the API — the only
              difference between the two uploads is entityContent — and a single grid with a
              "cover" badge would imply promoting an existing photo, which the API cannot do:
              PUT /admin/fields/{id} has no cover key. Measured on all 44 production fields, the
              two sets do not overlap (44 covers, 33 with gallery photos, 0 covers appearing in
              images[]), so nothing on screen has to explain an overlap. */}
          {mode === "edit" && cur?.id ? (
            <>
              <Sect title="Cover image">
                <div className="fv-cover" data-testid="fv-cover">
                  {cur.cover
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={cur.cover} alt="" loading="lazy" />
                    : <span className="fv-hint">No cover on this field.</span>}
                </div>
                {/* REPLACE-ONLY, AND THERE IS NO WAY BACK — API behaviour, not a scope cut, and it
                    was a paragraph on screen until 2026-09-10. Kept here because somebody will
                    otherwise rediscover it as a bug:
                      · A COVER CAN ONLY BE REPLACED, never removed. Every query in the Retool
                        export was searched; the only image delete is deleteImageFromField, which
                        acts on GALLERY rows. There is no delete-cover, so uploading one to a field
                        that has none cannot be undone from anywhere.
                      · A GALLERY PHOTO CANNOT BE PROMOTED TO COVER. PUT /admin/fields/{id} has no
                        cover key; the two sets are written by different uploads and, measured over
                        all 44 production fields, do not overlap. */}
                <PhotoUpload fieldId={cur.id} kind="cover" label={cur.cover ? "Replace cover" : "Add cover"}
                  headers={headers} onDone={() => void load()} />
              </Sect>

              <Sect title="Photos">
                <div className="fv-imgs" data-testid="fv-photos">
                  {(cur.images ?? []).length === 0 && <span className="fv-hint">No photos on this field.</span>}
                  {(cur.images ?? []).map((im) => (
                    <div key={im.id} className="fv-thumb" data-testid="fv-photo">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={im.url} alt="" loading="lazy" />
                      <button className="fv-rm" data-testid="fv-photo-rm" title={`Remove photo ${im.id}`}
                        onClick={() => void removePhoto(cur.id!, im.id)} disabled={photoBusy}>×</button>
                    </div>
                  ))}
                </div>
                <PhotoUpload fieldId={cur.id} kind="gallery" label="Add photo"
                  headers={headers} onDone={() => void load()} />
                {photoMsg && <p className={"fv-hint" + (photoMsg.bad ? " fv-bad" : "")} data-testid="fv-photo-msg">{photoMsg.text}</p>}
              </Sect>
            </>
          ) : (
            <Sect title="Photos">
              <p className="fv-hint" data-testid="fv-photos-note">{PHOTOS_READ_ONLY_NOTE}</p>
            </Sect>
          )}

          {mode === "edit" && (
            <Sect title="Danger zone">
              {/* THE REFUSAL IS A FACT ABOUT THIS FIELD and stays. delBlock.reason carries the
                  count — "Cannot delete — 412 matches" — and that is the only thing standing
                  between a click and a soft-deleted row that live matches still point at, because
                  the API does not check. The paragraph explaining it came off on 2026-09-10. */}
              <div className="fv-locked" data-testid="fv-delete-block">
                <span>⚠</span>
                <div><b>{delBlock.ok ? "This field has never hosted a match" : delBlock.reason}</b></div>
              </div>
              {delBlock.ok && (
                /* ONE QUESTION AND TWO BUTTONS, the shape approved for reduce-to-2-teams in
                   1301b20. The typed-name box is gone: Ryan overruled it — "just give me confirm
                   keep very simple no explantory text".
                   THE ROUTE STILL REQUIRES THE NAME. /api/fields DELETE compares ?confirm= to the
                   field's exact title and 400s otherwise, deliberately, because a client-side
                   confirmation is a courtesy. The client supplies it from the open row now instead
                   of making somebody type it. */
                confirming ? (
                  <div className="fv-confirm" data-testid="fv-del-ask">
                    <b>Delete {cur?.title}?</b>
                    <div className="fv-cacts">
                      <button className="fv-chip" data-testid="fv-del-cancel" onClick={() => setConfirming(false)}>Cancel</button>
                      <button className="fv-danger" data-testid="fv-delete"
                        disabled={!data?.deleteEnabled || busy}
                        onClick={() => void del()}>Delete</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 10 }}>
                    <button className="fv-danger" data-testid="fv-del-open"
                      disabled={!data?.deleteEnabled || busy} onClick={() => setConfirming(true)}>Delete field</button>
                  </div>
                )
              )}
            </Sect>
          )}
        </div>

        <div className="fv-drfoot">
          <button className="fv-primary" data-testid="fv-save" disabled={!canSave || busy} onClick={() => void save()}>
            {busy ? "Saving…" : mode === "new" ? "Create field" : "Save changes"}
          </button>
          <button className="fv-secondary" onClick={close}>Cancel</button>
          <span className="fv-dirty" data-testid="fv-dirty">
            {mode === "new"
              ? (missing.length === 0 ? "Ready to create" : <><b>{missing.length}</b> required field{missing.length === 1 ? "" : "s"} left</>)
              : (diffN === 0 ? "Nothing changed yet"
                : <><b>{diffN}</b> change{diffN === 1 ? "" : "s"} pending</>)}
          </span>
        </div>

        {result && (
          <div className={"fv-result" + (result.bad ? " bad" : "")} data-testid="fv-result">
            {result.lines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </aside>

      <style jsx>{CSS}</style>
      {/* ── THE DRAWER'S FORM CONTROLS, GLOBAL ON PURPOSE ────────────────────────────────────────
          MEASURED 2026-09-10, and it is not the contrast problem it looks like: the border was
          never drawing. Both a text input and a textarea in this drawer computed
          border-width: 0px, border-style: solid, and a transparent background — which is Tailwind
          preflight's reset winning, because the `.fv-dr :global(input)` rule in CSS above never
          reached them. WHY it never reached them is written out in full above that block — the
          short version is that a :global() rule in the variable-fed CSS is DISCARDED, not scoped
          and not emitted broken. Same class of bug as PlayerLookup's undefined --line2: a
          declaration that reads correctly and applies to nothing.
          SO THESE GO IN A GLOBAL BLOCK, scoped under .fv-dr so they cannot escape the drawer.
          The pair is MatchPanel's, shipped in 3c30656b: #cbd8d1 on a #fbfdfc fill. That measures
          1.47:1 against the drawer's white and STILL FAILS WCAG's 3:1 floor for a control boundary
          — it is consistency with a panel that works, not an accessibility fix, and the fill does
          as much of the work as the line. Reaching 3:1 needs a #7f8f86 border, darker than this
          panel's own field labels, which is a system-wide decision and not a Fields change. */}
      <style jsx global>{`
        .fv-dr input, .fv-dr select, .fv-dr textarea {
          border: 1px solid #cbd8d1; border-radius: 8px; padding: 9px 11px;
          font: inherit; font-size: 14px; background: #fbfdfc; color: #10231A; width: 100%;
        }
        .fv-dr textarea { min-height: 76px; resize: vertical; }
        /* AND A FOCUS STATE, of which there was none at all. */
        .fv-dr input:focus, .fv-dr select:focus, .fv-dr textarea:focus {
          outline: 2px solid #146c43; outline-offset: 1px; border-color: #146c43; background: #fff;
        }
        .fv-dr input:disabled, .fv-dr select:disabled {
          background: #F4F7F5; color: #6E8076; cursor: not-allowed;
        }
        /* ── THE FOUR THAT CAME OUT OF THE VARIABLE-FED BLOCK ON 2026-09-10 ─────────────────────
           All five were :global() rules in CSS above and all five were being discarded. RYAN'S
           SYMPTOM IS THE COVER: with no object-fit the img rendered at its natural size inside a
           340x191 overflow:hidden box, so a 1080x1080 photo was stretched to 340x340 and the panel
           showed its top half. The gallery thumbnail beside it LOOKED right and was equally dead —
           its box is square, so a square photo happened to fit, which is why it read as a control
           when it was not one. */
        .fv-dr textarea { resize: vertical; min-height: 74px; }
        .fv-addrow input { flex: 1; }
        .fv-thumb img, .fv-cover img {
          width: 100%; height: 100%; object-fit: cover; display: block;
        }
        /* object-fit ALONE WAS NOT ENOUGH, and the second half took two attempts to see.
           .fv-cover is display:grid with aspect-ratio:16/9, so the BOX is 340x191 — but the grid
           ROW is auto-sized and grew to the image's natural height instead. height:100% then
           resolved against the 340px ROW, not the 191px box, and overflow:hidden merely clipped
           the excess. Measured: align-self:stretch applied, object-fit:cover applied, and the img
           still computed height:340px inside a parent computing height:191.25px. Stretching a grid
           item cannot help when the track itself is what grew.
           TAKING IT OUT OF FLOW IS THE FIX. Absolute + inset:0 resolves against the padding box,
           which aspect-ratio has already made definite, so the row cannot grow. The "No cover on
           this field" placeholder is untouched and still centred by place-items. */
        .fv-cover { position: relative; }
        .fv-cover img, .fv-thumb img { position: absolute; inset: 0; }
      `}</style>
    </div>
  );
}

/* ONE UPLOAD CONTROL, USED TWICE. Cover and gallery differ ONLY by `kind`, which is the same
 * thing that is true of the API — entityContent is the only difference between the two POSTs — so
 * one component with a prop is the honest shape rather than two near-copies.
 *
 * FOUR STATES, AND PENDING IS NOT RED. The attach is asynchronous (~1.5s measured); past the
 * route's window the bytes ARE in S3 and the record has not caught up. That reads as a plain note
 * telling the operator to refresh, never as a failure and never as a success.
 *
 * NO RETRY. `busy` is set before the request and the input is cleared on completion; a second
 * upload is a second deliberate file choice, not a second click on the same one. */
function PhotoUpload({ fieldId, kind, label, headers, onDone }: {
  fieldId: number; kind: "cover" | "gallery"; label: string;
  headers: () => Promise<Record<string, string> | null>; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "wait" | "bad" } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const send = async (file: File) => {
    if (busy) return;
    const h = await headers();
    if (!h) { setMsg({ text: "No active session — sign in again.", tone: "bad" }); return; }
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // The multipart boundary must be the browser's, so Content-Type is deliberately NOT set.
      const auth: Record<string, string> = { Authorization: h.Authorization };
      const r = await fetch(`/api/fields/photos?id=${fieldId}&kind=${kind}`, { method: "POST", headers: auth, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ text: j.error ?? `HTTP ${r.status}`, tone: "bad" }); return; }
      if (j.verdict === "LANDED") {
        setMsg({ text: `LANDED — ${kind === "cover" ? "cover" : "photo"} uploaded and attached (read-back confirmed).`, tone: "ok" });
        onDone();
      } else if (j.verdict === "PENDING") {
        /* THE HONEST THIRD STATE. Nothing is lost and nothing is claimed. */
        setMsg({ text: "Uploaded. Not attached yet — refresh in a moment. The image is stored; the field record has not caught up.", tone: "wait" });
      } else {
        setMsg({ text: `${j.verdict ?? "UNKNOWN"} — ${j.error ?? "the outcome could not be read"}. Refresh before trying again.`, tone: "bad" });
      }
    } catch (e) {
      setMsg({ text: `UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Refresh before acting.`, tone: "bad" });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="fv-up">
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy}
        data-testid={`fv-up-${kind}`} id={`fv-up-${kind}-${fieldId}`} className="fv-upin"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f); }} />
      <label htmlFor={`fv-up-${kind}-${fieldId}`} className={"fv-add" + (busy ? " fv-add-off" : "")}>
        {busy ? "Uploading…" : label}
      </label>
      <span className="fv-hint">JPEG, PNG or WebP · up to 10 MB</span>
      {msg && <p className={"fv-hint fv-up-msg fv-up-" + msg.tone} data-testid={`fv-up-msg-${kind}`}>{msg.text}</p>}
    </div>
  );
}

function Sect({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <div className="fv-sect">
      <div className="fv-shrow"><h3 className="fv-sh">{title}</h3>{tag && <span className="fv-tag">{tag}</span>}</div>
      {children}
      <style jsx>{`
        .fv-sect{border-bottom:1px solid #EFF3EF;padding:18px 22px}
        .fv-sect:last-child{border-bottom:0}
        .fv-shrow{display:flex;align-items:center;margin:0 0 12px}
        .fv-sh{font-size:10.5px;font-weight:700;letter-spacing:.11em;color:#8C9E93;text-transform:uppercase;margin:0}
        .fv-tag{margin-left:auto;font-size:11px;font-weight:700;letter-spacing:.06em;color:#93A49A;text-transform:uppercase}
      `}</style>
    </div>
  );
}

function F({ label, req, hint, children }: { label: string; req?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="fv-f">
      <span className="fv-flabel">{label}{req && <i>*</i>}</span>
      {children}
      {hint && <span className="fv-fhint">{hint}</span>}
      <style jsx>{`
        .fv-f{display:flex;flex-direction:column;gap:5px;min-width:0}
        .fv-flabel{font-size:11px;font-weight:700;letter-spacing:.06em;color:#8C9E93;text-transform:uppercase}
        .fv-flabel i{color:#E8492A;font-style:normal;margin-left:3px}
        .fv-fhint{font-size:11.5px;color:#6E8076}
      `}</style>
    </label>
  );
}

const CSS = `
.fv{padding:24px 28px 80px;max-width:1500px}
.fv-head{display:flex;align-items:flex-start;gap:16px;background:#fff;border:1px solid #E4EAE5;border-radius:10px;padding:20px 22px;margin-bottom:14px}
.fv h1{font-family:"Archivo Black","Arial Black",sans-serif;font-size:34px;letter-spacing:-1px;margin:0 0 5px;line-height:1}
.fv-sub{color:#6E8076;margin:0}
.fv-live{margin-left:auto;background:#0F3323;color:#fff;border-radius:999px;padding:7px 15px;font-size:12px;font-weight:700;white-space:nowrap}
.fv-live i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#4FE07E;margin-right:8px}
.fv-err{background:#FDECE8;border:1px solid #F2C6BC;color:#A5321B;border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:13px}
.fv-card{background:#fff;border:1px solid #E4EAE5;border-radius:10px;overflow:hidden}
.fv-bar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid #EFF3EF}
.fv-q{flex:1;min-width:220px;border:1px solid #E4EAE5;border-radius:999px;padding:7px 14px;font:inherit;font-size:13px}
.fv-lbl{font-size:10.5px;font-weight:700;letter-spacing:.09em;color:#93A49A;text-transform:uppercase}
.fv-lock{margin:0 0 10px;font-size:12px;color:#6E8076;background:#F7F9F7;border:1px dashed #D3DDD7;border-radius:9px;padding:9px 12px}
.fv-lock b{color:#3C4F44}
.fv-vmode{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.fv-share{display:flex;gap:10px;align-items:flex-start;background:#FFF6E3;border:1px solid #F0DFB8;border-radius:9px;padding:11px 13px;margin:12px 0 0;color:#7A4E06;font-size:12.5px}
.fv-share b{display:block;color:#5C3A00;font-size:13px;margin-bottom:3px}
.fv-share ul{margin:6px 0 0;padding-left:16px}
.fv-share li{font-variant-numeric:tabular-nums}
.fv-only{margin:12px 0 0;font-size:12.5px;color:#0B7A3E;font-weight:600}
.fv-asknames{display:block;font-size:12px;color:#6A5320;margin-top:3px}
/* THE DELETE CONFIRM — one question, two buttons, no prose. */
.fv-confirm{margin-top:10px;border:1px solid #E6C4BC;background:#FDF4F2;border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.fv-confirm b{font-size:13.5px;color:#7A2B1C}
.fv-cacts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.fv-chip{border:1px solid #E4EAE5;background:#fff;border-radius:999px;padding:6px 13px;font:inherit;font-size:13px;font-weight:600;color:#3C4F44;cursor:pointer}
.fv-chip .n{color:#6E8076;font-weight:700;font-size:12px;margin-left:6px}
.fv-chip.on{background:#0F3323;border-color:#0F3323;color:#fff}
.fv-chip.on .n{color:#9FE0BB}
.fv-add{background:#4FE07E;border:0;border-radius:999px;padding:8px 17px;font:inherit;font-weight:700;color:#08281A;cursor:pointer}
.fv-add:disabled{background:#DCE5DF;color:#A9B8AF;cursor:not-allowed}
.fv-thead,.fv-row{display:grid;grid-template-columns:64px minmax(190px,1.6fr) 92px 128px minmax(170px,1.3fr) 96px 108px;align-items:center;padding:0 18px}
.fv-thead{background:#F7FAF8;border-bottom:1px solid #E4EAE5;margin-top:12px}
.fv-thead div{font-size:10.5px;font-weight:700;letter-spacing:.09em;color:#8C9E93;text-transform:uppercase;padding:10px 8px}
.fv-row{border-bottom:1px solid #EFF3EF;cursor:pointer}
.fv-row:hover{background:#FBFDFB}
.fv-row.sel{background:#E4FBEC}
.fv-row>div{padding:11px 8px;min-width:0}
.fv-id{font-variant-numeric:tabular-nums;color:#6E8076;font-weight:700;font-size:13px}
.fv-nm{font-weight:700;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fv-abbr{font-size:12px;font-weight:700;color:#3C4F44;background:#F1F4F1;border-radius:999px;padding:3px 9px;display:inline-block}
.fv-addr{font-size:12.5px;color:#6E8076;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fv-fmt{font-size:13px;font-weight:700;color:#3C4F44;font-variant-numeric:tabular-nums}
.fv-map{font-size:12px;font-weight:700}
.fv-map.ok{color:#0B7A3E}
.fv-map.no{color:#E8492A}
.fv-foot{display:flex;justify-content:space-between;gap:14px;color:#6E8076;font-size:12.5px;padding:12px 18px}
.fv-empty{padding:40px;text-align:center;color:#6E8076}
.fv-scrim{position:fixed;inset:0;background:rgba(10,26,18,.42);z-index:80}
.fv-dr{position:fixed;top:0;right:0;bottom:0;width:min(760px,96vw);background:#fff;z-index:90;display:none;flex-direction:column;box-shadow:-14px 0 42px rgba(10,26,18,.2)}
.fv-dr.on{display:flex}
.fv-drtop{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:1px solid #E4EAE5;flex:0 0 auto}
.fv-drtop h2{font-family:"Archivo Black","Arial Black",sans-serif;font-size:19px;margin:0;letter-spacing:-.3px}
.fv-idc{font-size:11.5px;font-weight:700;color:#3C4F44;background:#F1F4F1;border-radius:999px;padding:3px 10px;font-variant-numeric:tabular-nums}
.fv-x{margin-left:auto;border:1px solid #E4EAE5;background:#fff;border-radius:8px;padding:7px 14px;font:inherit;font-weight:700;color:#3C4F44;cursor:pointer}
.fv-drbody{flex:1;overflow:auto;padding:0 0 24px}
.fv-g2{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
.fv-g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px 16px}
/* ── NO :global() IN THIS BLOCK. EVER. THE RULE, AND WHY — MEASURED 2026-09-10 ────────────────
   This CSS is a VARIABLE handed to <style jsx>{CSS}</style>, so the babel plugin cannot analyse
   the template at build time. What it does then is the thing to understand, because the obvious
   guess is wrong in both directions:

     · PLAIN SELECTORS ARE EMITTED VERBATIM AND UNSCOPED. Read off the live stylesheet, the rule
       for the page header is literally ".fv-head" — no jsx-hash appended. So it is an ordinary
       global rule and it works. That is why the page is not unstyled, and why "a variable breaks
       scoping" never explained anything: nothing here IS scoped.

     · :global() SELECTORS ARE DISCARDED ENTIRELY. Not emitted broken — GONE. Of 119 rules in the
       document, zero contain the text ":global", and zero set object-fit at all, though two rules
       in this file asked for it. :global() is a scoping escape hatch; with no scoping applied
       there is nothing for it to escape, and the transform drops the rule rather than emitting a
       selector no browser can parse.

   SO A :global() RULE HERE IS SILENTLY DEAD, and it fails in the worst way: it reads correct, it
   survives review, and it applies to nothing. Five of them sat here for months. What they cost:
   every text input in the drawer had border-width 0 (fixed in 7341f2d), and the cover image had
   no object-fit — a 1080x1080 photo stretched to 340x340 inside a 340x191 overflow:hidden box,
   so the panel showed its top half and nothing else. The gallery thumbnail LOOKED fine and was
   equally broken; its box is square, so a square photo happened to fit.

   ANYTHING THAT MUST REACH A CHILD ELEMENT GOES IN THE <style jsx global> BLOCK at the foot of
   this component, scoped under .fv-dr or .fv-card so it cannot leak. */
.fv-derived{background:#F7FAF8;border:1px solid #E4EAE5;border-radius:8px;padding:9px 12px;font-size:13px;color:#3C4F44;font-weight:600;margin-top:12px}
.fv-locked{display:flex;gap:10px;align-items:flex-start;background:#F7F9F7;border:1px dashed #D3DDD7;border-radius:9px;padding:13px 15px;color:#6E8076;font-size:13px}
.fv-locked b{color:#3C4F44;display:block;font-size:13.5px;margin-bottom:2px}
.fv-phones{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.fv-ph{display:flex;align-items:center;gap:10px;border:1px solid #E4EAE5;border-radius:8px;padding:9px 12px}
.fv-ph.empty{border-style:dashed}
.fv-num{font-variant-numeric:tabular-nums;font-weight:700;font-size:14px}
.fv-num2{font-size:12.5px;color:#9FB0A5}
.fv-en{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.fv-en.on{color:#0B7A3E}
.fv-en.off{color:#B8730B}
.fv-rm{margin-left:auto;border:1px solid #E4EAE5;background:#fff;color:#E8492A;border-radius:7px;padding:4px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}
.fv-addrow{display:flex;gap:9px}
.fv-hint{font-size:11.5px;color:#6E8076;margin:8px 0 0}
.fv-imgs{display:flex;gap:12px;flex-wrap:wrap}
.fv-thumb{width:132px;height:88px;border-radius:8px;border:1px solid #E4EAE5;position:relative;overflow:hidden;background:#0F3323}
/* THE COVER IS ONE SLOT, not a grid of one — it is a different thing from the gallery and it
   should not look like a photo that happens to be first. */
.fv-cover{width:100%;max-width:340px;aspect-ratio:16/9;border:1px solid var(--line);border-radius:10px;
  overflow:hidden;background:var(--slot);display:grid;place-items:center;margin-bottom:10px}
.fv-thumb{position:relative}
/* Remove sits ON the thumbnail, so it is unambiguous which photo it acts on. */
.fv-rm{position:absolute;right:5px;top:5px;width:22px;height:22px;border-radius:50%;border:0;
  background:rgba(16,35,26,.72);color:#fff;font-size:14px;line-height:1;cursor:pointer;display:grid;place-items:center}
.fv-rm:hover{background:#A5321B}
.fv-rm:disabled{opacity:.4;cursor:default}
.fv-up{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
/* The real input is hidden but still the control — the label is its trigger, so keyboard and
   screen readers reach it the ordinary way rather than through a click handler on a div. */
.fv-upin{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.fv-upin:focus-visible + label{outline:2px solid #4FE07E;outline-offset:2px}
.fv-add-off{opacity:.6;cursor:default}
.fv-up-msg{flex-basis:100%;margin:2px 0 0}
.fv-up-ok{color:#0B7A3E;font-weight:700}
/* PENDING IS AMBER, NEVER RED. The bytes are safe; only the record has not caught up. */
.fv-up-wait{color:#8A5A08;font-weight:700}
.fv-up-bad{color:#A5321B;font-weight:700}
.fv-bad{color:#A5321B;font-weight:700}
.fv-thumb.cover::after{content:"COVER";position:absolute;left:7px;top:7px;background:#4FE07E;color:#08281A;font-size:9.5px;font-weight:700;letter-spacing:.08em;border-radius:999px;padding:2px 8px}
.fv-drfoot{flex:0 0 auto;border-top:1px solid #E4EAE5;padding:14px 22px;display:flex;align-items:center;gap:10px;background:#FBFDFB}
.fv-primary{background:#4FE07E;border:0;border-radius:9px;padding:11px 22px;font:inherit;font-weight:700;font-size:14.5px;color:#08281A;cursor:pointer}
.fv-primary:disabled{background:#DCE5DF;color:#A9B8AF;cursor:not-allowed}
.fv-secondary{border:1px solid #E4EAE5;background:#fff;border-radius:9px;padding:11px 18px;font:inherit;font-weight:700;color:#3C4F44;cursor:pointer}
.fv-danger{border:1px solid #F2C6BC;background:#FDECE8;color:#A5321B;border-radius:9px;padding:9px 16px;font:inherit;font-weight:700;cursor:pointer}
.fv-danger:disabled{opacity:.5;cursor:not-allowed}
.fv-dirty{font-size:12.5px;color:#6E8076}
.fv-result{flex:0 0 auto;border-top:1px solid #E4EAE5;padding:12px 22px;font-size:13px;background:#E4FBEC;color:#0B3D24}
.fv-result.bad{background:#FDECE8;color:#A5321B}
@media(max-width:1220px){
  .fv-thead,.fv-row{grid-template-columns:56px minmax(150px,1.6fr) 84px 118px 96px}
  .fv-thead div:nth-child(5),.fv-row>div:nth-child(5),.fv-thead div:nth-child(7),.fv-row>div:nth-child(7){display:none}}
@media(max-width:700px){.fv-g2,.fv-g3{grid-template-columns:1fr}}
`;
