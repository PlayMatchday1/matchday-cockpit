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
import {
  FORMATS, PITCH_OPTIONS, formatShort, recommendationReadout, missingRequired,
  updateBody, deleteBlock, deleteConfirmed, validPhone, orphanLinks, unmappedSummary,
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

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [cur, setCur] = useState<Field | null>(null);
  const [orig, setOrig] = useState<Draft>(blank());
  const [draft, setDraft] = useState<Draft>(blank());
  const [pitches, setPitches] = useState(1);
  const [phones, setPhones] = useState<Phone[]>([]);
  const [phoneIn, setPhoneIn] = useState("");
  const [staged, setStaged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ lines: string[]; bad: boolean } | null>(null);
  const [delText, setDelText] = useState("");
  const drawerRef = useRef<HTMLDivElement | null>(null);

  const headers = useCallback(async () => {
    const { data: s } = await supabase.auth.getSession();
    const t = s.session?.access_token;
    return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : null;
  }, []);

  const load = useCallback(async () => {
    const h = await headers(); if (!h) return;
    const r = await fetch("/api/fields", { headers: h });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "load failed"); return; }
    setErr(null); setData(j as Payload);
  }, [headers]);
  useEffect(() => { void load(); }, [load]);

  const linkList: Link[] = useMemo(
    () => (data?.links ?? []).map((l) => ({ mdapi_field_id: l.fieldId, fin_venue_id: l.venueId })),
    [data]);
  const mappedIds = useMemo(() => new Set(linkList.map((l) => Number(l.mdapi_field_id))), [linkList]);
  const liveIds = useMemo(() => new Set((data?.fields ?? []).map((f) => f.id)), [data]);
  const activeIds = useMemo(() => new Set(data?.activeFieldIds ?? []), [data]);

  /* THE BANNER IS TWO NUMBERS because they answer different questions. "No venue mapping" is a
   * data gap; "and running matches this month" is the part that is costing money right now. The
   * mockup showed only the second and labelled it the first. Both are counted from the real rows,
   * never from a constant. */
  const summary = useMemo(
    () => unmappedSummary(data?.fields ?? [], linkList, activeIds),
    [data, linkList, activeIds]);
  /* THE ORPHAN IN THE OTHER DIRECTION — our link row points at a field the API no longer lists.
   * That is what a SOFT delete leaves behind, and it is invisible everywhere else. */
  const orphans = useMemo(() => orphanLinks(linkList, liveIds), [linkList, liveIds]);

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const f of data?.fields ?? []) if (f.cityId != null) m.set(f.cityId, (m.get(f.cityId) ?? 0) + 1);
    return m;
  }, [data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.fields ?? [])
      .filter((f) => (city == null || f.cityId === city)
        && (!needle || `${f.title} ${f.abbr} ${f.address} ${f.id}`.toLowerCase().includes(needle)))
      .sort((a, b) => (a.cityName ?? "").localeCompare(b.cityName ?? "") || a.title.localeCompare(b.title));
  }, [data, q, city]);

  const loadPhones = useCallback(async (fieldId: number) => {
    const h = await headers(); if (!h) return;
    const r = await fetch(`/api/fields/phones?fieldId=${fieldId}`, { headers: h });
    const j = await r.json();
    setPhones(r.ok ? (j.phones ?? []) : []);
  }, [headers]);

  const openNew = () => {
    setMode("new"); setCur(null); setOrig(blank()); setDraft(blank());
    setPitches(1); setPhones([]); setStaged([]); setPhoneIn(""); setResult(null); setDelText("");
    setOpen(true);
  };
  const openEdit = (f: Field) => {
    setMode("edit"); setCur(f); setOrig(draftOf(f)); setDraft(draftOf(f));
    setPitches(1); setStaged([]); setPhoneIn(""); setResult(null); setDelText("");
    setPhones([]); void loadPhones(f.id);
    setOpen(true);
  };
  const close = () => { setOpen(false); setCur(null); setResult(null); };

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));

  const missing = useMemo(() => missingRequired(draft), [draft]);
  const diff = useMemo(() => (mode === "edit" ? updateBody(orig, draft) : {}), [mode, orig, draft]);
  const diffN = Object.keys(diff).length;
  const canSave = mode === "new" ? missing.length === 0 : diffN > 0 || staged.length > 0;

  /* ── SAVE ──────────────────────────────────────────────────────────────────────────────────
   * CREATE IS TWO STEPS AND THE SECOND CAN FAIL ON ITS OWN. Phone numbers attach to a field id,
   * which does not exist until step 1 returns, so they stage client-side and flush after.
   *
   * WHEN STEP 2 FAILS THE FIELD STILL EXISTS. We do not roll back, do not retry, and never
   * re-POST the field — a second POST is a second field. The drawer flips to EDIT on the new id
   * and says, per item, what landed and what did not. Failed numbers stay staged so pressing Save
   * again retries only those. */
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
        setMode("edit"); setCur(row); setOrig(draftOf(row)); setDraft(draftOf(row));
      } else if (diffN > 0) {
        const r = await fetch(`/api/fields?id=${cur!.id}`, {
          method: "PUT", headers: h, body: JSON.stringify({ orig, draft }),
        });
        const j = await r.json();
        if (j.verdict === "LANDED") lines.push(`Saved ${Object.keys(diff).length} change${diffN === 1 ? "" : "s"}.`);
        else if (j.verdict === "NOT APPLIED") lines.push("Nothing changed — nothing was sent.");
        else { lines.push(`Changes ${j.verdict}${j.error ? `: ${j.error}` : ""}.`); bad = true; }
      }

      // FLUSH THE STAGED NUMBERS, one at a time, reporting each. No retries inside a save.
      if (fieldId != null && staged.length) {
        const stillStaged: string[] = [];
        for (const num of staged) {
          const r = await fetch(`/api/fields/phones?fieldId=${fieldId}`, {
            method: "POST", headers: h, body: JSON.stringify({ phoneNumber: num }),
          });
          const j = await r.json();
          if (j.verdict === "LANDED") lines.push(`Phone ${num} added.`);
          else { lines.push(`Phone ${num} NOT added — ${j.verdict ?? "FAILED"}.`); bad = true; stillStaged.push(num); }
        }
        setStaged(stillStaged);
        await loadPhones(fieldId);
      }

      if (mode === "new" || bad) {
        // Photos are read-only; say it here too so a create does not look like it dropped them.
        lines.push(PHOTOS_READ_ONLY_NOTE);
      }
      setResult({ lines, bad });
      await load();
      if (mode === "edit" && !bad) { const f = (data?.fields ?? []).find((x) => x.id === cur?.id); if (f) setOrig(draftOf(f)); }
    } finally { setBusy(false); }
  };

  const addPhone = async () => {
    const v = phoneIn.trim();
    if (!validPhone(v)) return;
    if (mode === "new" || !cur) { setStaged((s) => [...s, v]); setPhoneIn(""); return; }
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
      const r = await fetch(`/api/fields?id=${cur.id}&confirm=${encodeURIComponent(delText)}`, { method: "DELETE", headers: h });
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
          <button className="fv-add" data-testid="fv-new" onClick={openNew}>+ New field</button>
        </div>

        {/* BOTH NUMBERS, from the real rows. */}
        {data && summary.unmapped.length > 0 && (
          <div className="fv-note" data-testid="fv-unmapped"
            data-unmapped={summary.unmapped.length} data-running={summary.running.length}>
            <span>⚠</span>
            <div><b>{summary.unmapped.length} field{summary.unmapped.length === 1 ? "" : "s"} ha{summary.unmapped.length === 1 ? "s" : "ve"} no venue mapping</b>
              {" · "}{summary.running.length} {summary.running.length === 1 ? "is" : "are"} running matches this month.
              {" "}Without a <code>fin_venue_fields</code> row no cost or revenue path can attribute a field’s matches.
              {" "}<span className="fv-ids">{summary.unmapped.join(", ")}</span></div>
          </div>
        )}
        {data && orphans.length > 0 && (
          <div className="fv-note blue" data-testid="fv-orphans" data-n={orphans.length}>
            <span>ℹ</span>
            <div>{orphans.length} venue mapping{orphans.length === 1 ? "" : "s"} point{orphans.length === 1 ? "s" : ""} at a field the API no longer lists
              {" — "}<span className="fv-ids">{orphans.map((o) => o.fieldId).join(", ")}</span>.
              {" "}Deleting a field is a SOFT delete: the row keeps existing, the list stops showing it, and our link keeps pointing at it.</div>
          </div>
        )}

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
              <F label="Abbreviation" req hint="Shown on Gameday Ops and Slate Review. Keep it short.">
                <input data-testid="fv-abbr" maxLength={12} value={String(draft.abbr ?? "")} onChange={(e) => set("abbr", e.target.value)} placeholder="PARMER" />
              </F>
              {/* ORDER POSITION IS UPDATE-ONLY. The create DTO refuses it by name — "property
                  orderPosition should not exist" — and the server assigns it as the new id. */}
              <F label="Order position" hint={mode === "new"
                ? "Set after the field exists — the API refuses it on create and assigns one."
                : "Where it sits in the player app's field list."}>
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
              <F label="Zipcode" hint="Stored as a number by the API."><input data-testid="fv-zip" value={String(draft.zipcode ?? "")} onChange={(e) => set("zipcode", e.target.value)} placeholder="78753" /></F>
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
              <F label="Pitches at this field" hint="Display only — shades the line below. It does not change any cost rule.">
                <select data-testid="fv-pitches" value={String(pitches)} onChange={(e) => setPitches(Number(e.target.value))}>
                  {PITCH_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </F>
            </div>
            {/* A RECOMMENDATION, NOT A CAP. 23 fields run matches at counts other than their own
                rpc; 1486 has 22 and runs 18 through 36. */}
            <div className="fv-derived" data-testid="fv-recommendation">{recommendationReadout(fmtTotal, pitches)}</div>
          </Sect>

          <Sect title="Venue mapping" tag="Clubhouse only">
            <div className="fv-note blue" style={{ marginBottom: 12 }}>
              <span>ℹ</span>
              <div>Not part of the MatchDay field record. Without a <code>fin_venue_fields</code> row a field runs matches that no cost or revenue path can see.</div>
            </div>
            <div className="fv-g2">
              <F label="Venue">
                {/* THE EMPTY STATE IS NEVER BLANK. "Unmapped" is a state with a consequence; an
                    empty select looks like a control nobody has got to yet. */}
                <select data-testid="fv-venue" disabled value={cur && mappedIds.has(cur.id) ? "mapped" : ""}>
                  <option value="">Unmapped — no cost or revenue</option>
                  <option value="mapped">Mapped to a venue</option>
                </select>
              </F>
              <F label="Per-match rate" hint="Comes from the venue. Change it on the Field Cost page.">
                <input data-testid="fv-rate" value="" placeholder="—" disabled />
              </F>
            </div>
            <div className="fv-locked" data-testid="fv-venue-readonly">
              <span>🔒</span>
              <div><b>Read-only in this pass</b>Mapping a field to a venue writes <code>fin_venue_fields</code>, which is a finance decision with its own audit. It is shown here so the gap is visible from the field, and edited on Field Cost.</div>
            </div>
          </Sect>

          <Sect title="Description">
            <F label="Description"><textarea data-testid="fv-desc" value={String(draft.description ?? "")} onChange={(e) => set("description", e.target.value)} /></F>
            <div style={{ marginTop: 12 }}>
              <F label="Parking note"><input data-testid="fv-parking" value={String(draft.parkingNote ?? "")} onChange={(e) => set("parkingNote", e.target.value)} /></F>
            </div>
          </Sect>

          {/* LIVE ON CREATE. Numbers attach to a field id, so before there is one they stage here
              and flush after the field is created — no locked panel. */}
          <Sect title="Cancellation texts">
            <div className="fv-phones" data-testid="fv-phones">
              {phones.map((p) => (
                <div className="fv-ph" key={p.id} data-testid="fv-phone">
                  <span className="fv-num">{p.phoneNumber}</span>
                  <span className={"fv-en " + (p.isEnabled ? "on" : "off")}>{p.isEnabled ? "enabled" : "disabled"}</span>
                  <button className="fv-rm" disabled={busy} onClick={() => void removePhone(p)}>Remove</button>
                </div>
              ))}
              {staged.map((s, i) => (
                <div className="fv-ph staged" key={`s${i}`} data-testid="fv-phone-staged">
                  <span className="fv-num">{s}</span>
                  <span className="fv-en pend">sends on save</span>
                  <button className="fv-rm" onClick={() => setStaged((x) => x.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              {phones.length === 0 && staged.length === 0 && (
                <div className="fv-ph empty"><span className="fv-num2">No numbers — nobody is texted when a match here is cancelled.</span></div>
              )}
            </div>
            <div className="fv-addrow">
              <input data-testid="fv-phone-in" value={phoneIn} onChange={(e) => setPhoneIn(e.target.value)} placeholder="+1 512 555 0147" />
              <button className="fv-add" data-testid="fv-phone-add" disabled={!validPhone(phoneIn)} onClick={() => void addPhone()}>Add number</button>
            </div>
            <p className="fv-hint">These numbers get a text when a match at this field is cancelled. What triggers the send is MatchDay-side and not visible from Clubhouse.</p>
          </Sect>

          {/* READ-ONLY, AND IT SAYS SO. Not a locked panel pretending it will unlock. */}
          <Sect title="Photos">
            <div className="fv-imgs" data-testid="fv-photos">
              {(cur?.images ?? []).length === 0 && <span className="fv-hint">No photos on this field.</span>}
              {(cur?.images ?? []).map((im) => (
                <div key={im.id} className={"fv-thumb" + (cur?.cover === im.url ? " cover" : "")} data-testid="fv-photo">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={im.url} alt="" loading="lazy" />
                </div>
              ))}
            </div>
            <p className="fv-hint" data-testid="fv-photos-note">{PHOTOS_READ_ONLY_NOTE}</p>
          </Sect>

          {mode === "edit" && (
            <Sect title="Danger zone">
              <div className="fv-locked" data-testid="fv-delete-block">
                <span>⚠</span>
                <div>
                  <b>{delBlock.ok ? "This field has never hosted a match" : delBlock.reason}</b>
                  Deleting is a SOFT delete upstream and the API does not check for matches — it would leave them pointing at a field nothing renders. Clubhouse refuses that.
                  {!data?.deleteEnabled && <> Deletion is switched off for production in this pass.</>}
                </div>
              </div>
              {delBlock.ok && (
                <div className="fv-addrow" style={{ marginTop: 10 }}>
                  <input data-testid="fv-del-confirm" value={delText} onChange={(e) => setDelText(e.target.value)}
                    placeholder={`Type “${cur?.title}” to confirm`} />
                  <button className="fv-danger" data-testid="fv-delete"
                    disabled={!data?.deleteEnabled || busy || !deleteConfirmed(delText, cur?.title ?? "")}
                    onClick={() => void del()}>Delete field</button>
                </div>
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
              : (diffN === 0 && staged.length === 0 ? "Nothing changed yet"
                : <><b>{diffN + staged.length}</b> change{diffN + staged.length === 1 ? "" : "s"} pending</>)}
          </span>
        </div>

        {result && (
          <div className={"fv-result" + (result.bad ? " bad" : "")} data-testid="fv-result">
            {result.lines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </aside>

      <style jsx>{CSS}</style>
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
.fv-chip{border:1px solid #E4EAE5;background:#fff;border-radius:999px;padding:6px 13px;font:inherit;font-size:13px;font-weight:600;color:#3C4F44;cursor:pointer}
.fv-chip .n{color:#6E8076;font-weight:700;font-size:12px;margin-left:6px}
.fv-chip.on{background:#0F3323;border-color:#0F3323;color:#fff}
.fv-chip.on .n{color:#9FE0BB}
.fv-add{background:#4FE07E;border:0;border-radius:999px;padding:8px 17px;font:inherit;font-weight:700;color:#08281A;cursor:pointer}
.fv-add:disabled{background:#DCE5DF;color:#A9B8AF;cursor:not-allowed}
.fv-note{display:flex;gap:9px;margin:12px 18px 0;padding:9px 13px;border-radius:9px;background:#FFF6E3;border:1px solid #F0DFB8;color:#7A4E06;font-size:12.5px}
.fv-note.blue{background:#EFF6FF;border-color:#BBD6F6;color:#12406F}
.fv-ids{font-variant-numeric:tabular-nums;font-weight:700}
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
.fv-dr :global(input),.fv-dr :global(select),.fv-dr :global(textarea){border:1px solid #E4EAE5;border-radius:8px;padding:9px 11px;font:inherit;font-size:14px;background:#fff;color:#10231A;width:100%}
.fv-dr :global(textarea){resize:vertical;min-height:74px}
.fv-dr :global(input:disabled),.fv-dr :global(select:disabled){background:#F7F9F7;color:#A9B8AF;cursor:not-allowed}
.fv-derived{background:#F7FAF8;border:1px solid #E4EAE5;border-radius:8px;padding:9px 12px;font-size:13px;color:#3C4F44;font-weight:600;margin-top:12px}
.fv-locked{display:flex;gap:10px;align-items:flex-start;background:#F7F9F7;border:1px dashed #D3DDD7;border-radius:9px;padding:13px 15px;color:#6E8076;font-size:13px}
.fv-locked b{color:#3C4F44;display:block;font-size:13.5px;margin-bottom:2px}
.fv-phones{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.fv-ph{display:flex;align-items:center;gap:10px;border:1px solid #E4EAE5;border-radius:8px;padding:9px 12px}
.fv-ph.staged{border-style:dashed;background:#FFF6E3}
.fv-ph.empty{border-style:dashed}
.fv-num{font-variant-numeric:tabular-nums;font-weight:700;font-size:14px}
.fv-num2{font-size:12.5px;color:#9FB0A5}
.fv-en{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.fv-en.on{color:#0B7A3E}
.fv-en.off{color:#B8730B}
.fv-en.pend{color:#7A4E06}
.fv-rm{margin-left:auto;border:1px solid #E4EAE5;background:#fff;color:#E8492A;border-radius:7px;padding:4px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}
.fv-addrow{display:flex;gap:9px}
.fv-addrow :global(input){flex:1}
.fv-hint{font-size:11.5px;color:#6E8076;margin:8px 0 0}
.fv-imgs{display:flex;gap:12px;flex-wrap:wrap}
.fv-thumb{width:132px;height:88px;border-radius:8px;border:1px solid #E4EAE5;position:relative;overflow:hidden;background:#0F3323}
.fv-thumb :global(img){width:100%;height:100%;object-fit:cover;display:block}
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
