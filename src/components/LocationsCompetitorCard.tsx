"use client";

// ONE COMPETITOR VENUE — the card on the Map tab's right when a square is clicked. What it sells comes
// from the Competitors page's capture (spots per week, price per player, formats), with a link to each
// listing's row there. Admins can correct the address or move the pin; the tab saves, this only asks.

import { useState } from "react";
import { SOURCE_FILL, SOURCE_NAME, priceText, type CompetitorVenue, type SharedVenue } from "@/lib/competitorVenues";

const TEXT = [["street_address", "Street"], ["city", "City"], ["state", "State"], ["zip", "Zip"]] as const;
type TextKey = (typeof TEXT)[number][0];

export default function LocationsCompetitorCard({ venue: v, canEdit, moving, msg, onClose, onMove, onSave }: {
  venue: CompetitorVenue;
  canEdit: boolean;
  moving: boolean;
  msg: { text: string; bad: boolean } | null;
  onClose: () => void;
  onMove: (on: boolean) => void;
  onSave: (set: Record<string, string | null>) => Promise<boolean>;
}) {
  const current: Record<TextKey, string> = { street_address: v.street ?? "", city: v.city ?? "", state: v.state ?? "", zip: v.zip ?? "" };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  // THE DIFF IS THE REQUEST: only the fields that differ from what is stored.
  const diff = Object.fromEntries(TEXT.filter(([k]) => draft[k].trim() !== current[k]).map(([k]) => [k, draft[k].trim() || null]));
  const address = [v.street, [v.city, [v.state, v.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  // An admin-set location supersedes the address file's confidence note.
  const unsure = !v.updatedAt && v.confidence && v.confidence !== "high";

  return (
    <div className="lm-pcard lm-detail lc" data-testid="comp-card">
      <style>{CSS}</style>
      <div className="lm-ptitle-row">
        <div className="lm-ptitle">{v.name}</div>
        <button type="button" className="loc-btn lm-clear" onClick={onClose}>Close</button>
      </div>
      <div className="lc-srcs">
        {v.sources.map((s) => <span key={s} className="lc-src" style={{ background: SOURCE_FILL[s] }}>{SOURCE_NAME[s]}</span>)}
        {v.partnerBrand && <span className="lc-src lc-pb" data-testid="comp-partner">Partner brand</span>}
      </div>
      {v.partnerBrand && <div className="lc-mut lc-note" data-testid="comp-partner-note">{v.partnerBrand} is a field partner of ours. This is their own facility, not one of our fields.</div>}
      <dl className="lc-dl">
        <dt>Address</dt><dd data-testid="comp-address">{address || "—"}</dd>
        <dt>Spots per week</dt><dd data-testid="comp-spots">{v.spots.toLocaleString("en-US")}</dd>
        <dt>Price per player</dt><dd data-testid="comp-price">{priceText(v.lowCents, v.highCents)}</dd>
        <dt>Formats</dt><dd>{v.formats.length ? v.formats.join(", ") : "—"}</dd>
      </dl>
      {unsure && (
        <div className="lc-warn" data-testid="comp-confidence">
          Location confidence: {v.confidence}. {[...new Set(v.listings.map((l) => l.notes).filter(Boolean))].join(" ")}
        </div>
      )}
      <div className="lw-title lm-within-title">On the Competitors page</div>
      <ul className="lc-list">
        {v.listings.map((l) => (
          <li key={`${l.source}|${l.facility}`}>
            <span className="lc-dot" style={{ background: SOURCE_FILL[l.source] }} />
            {l.supplyId != null
              ? <a href={`/growth/competitors?open=${l.supplyId}`} data-testid="comp-link">{l.facility}</a>
              : <span>{l.facility}</span>}
            <span className="lc-mut">
              {SOURCE_NAME[l.source]}{l.spots != null ? `, ${l.spots.toLocaleString("en-US")} spots/wk, ${priceText(l.lowCents, l.highCents)}` : ", not in the current capture"}
            </span>
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="lc-edit">
          {editing ? (
            <>
              <div className="lc-form">
                {TEXT.map(([k, label]) => (
                  <label key={k} className={k === "street_address" ? "lc-wide" : ""}>
                    <span>{label}</span>
                    <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} data-testid={`comp-edit-${k}`} />
                  </label>
                ))}
              </div>
              <div className="lc-btns">
                <button type="button" className="loc-btn" disabled={busy || Object.keys(diff).length === 0} data-testid="comp-save"
                  title={Object.keys(diff).length === 0 ? "Nothing has changed" : undefined}
                  onClick={async () => { setBusy(true); const ok = await onSave(diff); setBusy(false); if (ok) setEditing(false); }}>
                  {busy ? "Saving…" : "Save address"}
                </button>
                <button type="button" className="loc-btn lc-plain" onClick={() => { setDraft(current); setEditing(false); }}>Cancel</button>
              </div>
              <div className="lc-mut lc-note">Changes the text only. To move the square, use Move pin.</div>
            </>
          ) : moving ? (
            <>
              <div className="lc-move" data-testid="comp-moving">Drag the square to where the venue is. It saves when you drop it.</div>
              <button type="button" className="loc-btn lc-plain" onClick={() => onMove(false)}>Cancel</button>
            </>
          ) : (
            <div className="lc-btns">
              <button type="button" className="loc-btn" data-testid="comp-edit" onClick={() => { setDraft(current); setEditing(true); onMove(false); }}>Edit address</button>
              <button type="button" className="loc-btn" data-testid="comp-move" onClick={() => onMove(true)}>Move pin</button>
            </div>
          )}
          {msg && <div className={"lc-msg" + (msg.bad ? " lc-bad" : "")} data-testid="comp-msg">{msg.text}</div>}
          {v.updatedAt && <div className="lc-mut lc-note">Last corrected {new Date(v.updatedAt).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} by {v.updatedBy ?? "an admin"}.</div>}
        </div>
      )}
    </div>
  );
}

const CSS = `
.lc-srcs{display:flex;gap:6px;margin-top:6px}
.lc-pb{background:#fff7dd !important;color:#7a5a00 !important;border:1px solid #e2c46b}
.lc-src{color:#fff;font-size:10.5px;font-weight:800;letter-spacing:.3px;padding:2px 8px;border-radius:99px}
.lc-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:10px 0 0;font-size:12.5px}
.lc-dl dt{color:var(--muted)}
.lc-dl dd{margin:0;color:var(--ink);font-variant-numeric:tabular-nums}
.lc-warn{margin-top:8px;font-size:11.5px;color:#8A5300;background:#FFF6E5;border:1px solid #F2D9A6;border-radius:8px;padding:6px 8px}
.lc-list{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}
.lc-list li{padding:4px 0;border-bottom:1px solid #EEF2EC;display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}
.lc-list a{color:var(--forest);font-weight:700}
.lc-dot{display:inline-block;width:9px;height:9px;border-radius:2px}
.lc-mut{color:var(--muted);font-size:11.5px}
.lc-edit{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)}
.lc-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.lc-plain{background:transparent}
.lc-form{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}
.lc-form label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--muted);font-weight:700}
.lc-form input{font:inherit;font-size:15px;padding:5px 7px;border:1px solid var(--line);border-radius:7px;color:var(--ink);min-width:0}
@media (min-width:901px){ .lc-form input{font-size:13px} }
.lc-wide{grid-column:1 / -1}
.lc-move{font-size:12px;color:var(--forest);font-weight:700;margin-bottom:6px}
.lc-msg{margin-top:8px;font-size:12px;color:var(--forest);font-weight:700}
.lc-bad{color:#B42318}
.lc-note{margin-top:6px}
`;

/* ── A SHARED VENUE: a competitor also runs at one of OUR fields ─────────────────────────────── */
export function SharedVenueCard({ x, onClose }: { x: SharedVenue; onClose: () => void }) {
  const day = x.firstCapturedAt ? new Date(x.firstCapturedAt).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" }) : "—";
  return (
    <div className="lm-pcard lm-detail lc" data-testid="shared-card">
      <style>{CSS}</style>
      <div className="lm-ptitle-row">
        <div className="lm-ptitle">{x.field?.title ?? x.ourVenueName}</div>
        <button type="button" className="loc-btn lm-clear" onClick={onClose}>Close</button>
      </div>
      <div className="lc-srcs">
        <span className="lc-src" style={{ background: "#0b7d55" }}>Shared</span>
        <span className="lc-src" style={{ background: SOURCE_FILL[x.source] }}>{SOURCE_NAME[x.source]}</span>
      </div>
      <dl className="lc-dl">
        <dt>Our field</dt><dd data-testid="shared-ours">{x.field?.title ?? "—"}{x.ourVenueName !== x.field?.title ? ` (${x.ourVenueName})` : ""}</dd>
        <dt>Competitor</dt><dd>{SOURCE_NAME[x.source]}</dd>
        <dt>Their listing</dt><dd><a href={`/growth/competitors?open=${x.supplyId}`} data-testid="shared-link">{x.facility}</a></dd>
        <dt>Their spots per week</dt><dd data-testid="shared-spots">{x.spots.toLocaleString("en-US")}</dd>
        <dt>Their price per player</dt><dd data-testid="shared-price">{priceText(x.lowCents, x.highCents)}</dd>
        <dt>Formats</dt><dd>{x.formats.length ? x.formats.join(", ") : "—"}</dd>
        <dt>Captured</dt><dd>{day}</dd>
      </dl>
      <div className={x.status === "confirmed" ? "lc-mut lc-note" : "lc-warn"} data-testid="shared-status">
        {x.status === "confirmed" ? "Confirmed as our field on the Competitors page."
          : "Proposed by a name match on the Competitors page; nobody has confirmed it yet."}
      </div>
    </div>
  );
}

/* ── PLACING AN UNPLACED VENUE (admin) ─────────────────────────────────────────────────────────
 * Its square starts at its city's centre. The admin drags it to the venue and fills the address;
 * ONE save sends the pin and only the address fields that changed. Save stays off until the square
 * has been moved, so a venue cannot be saved sitting on the city centre by accident. */
export type Placing = {
  venueId: number; name: string; market: string; sources: ("plei" | "goodrec")[];
  lat: number; lng: number; moved: boolean;
  street: string | null; city: string | null; state: string | null; zip: string | null;
};
export function PlaceVenueCard({ p, msg, onCancel, onSave }: {
  p: Placing; msg: { text: string; bad: boolean } | null;
  onCancel: () => void; onSave: (set: Record<string, string | null>) => Promise<boolean>;
}) {
  const current: Record<TextKey, string> = { street_address: p.street ?? "", city: p.city ?? "", state: p.state ?? "", zip: p.zip ?? "" };
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const diff = Object.fromEntries(TEXT.filter(([k]) => draft[k].trim() !== current[k]).map(([k]) => [k, draft[k].trim() || null]));
  return (
    <div className="lm-pcard lm-detail lc" data-testid="place-card">
      <style>{CSS}</style>
      <div className="lm-ptitle-row">
        <div className="lm-ptitle">Place {p.name}</div>
        <button type="button" className="loc-btn lm-clear" onClick={onCancel}>Cancel</button>
      </div>
      <div className="lc-srcs">{p.sources.map((s) => <span key={s} className="lc-src" style={{ background: SOURCE_FILL[s] }}>{SOURCE_NAME[s]}</span>)}</div>
      <div className="lc-move" style={{ marginTop: 10 }}>
        {p.moved ? `Pin set at ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}. Drag again to adjust.` : `Drag the dashed square from the centre of ${p.market} to the venue.`}
      </div>
      <div className="lc-form">
        {TEXT.map(([k, label]) => (
          <label key={k} className={k === "street_address" ? "lc-wide" : ""}>
            <span>{label}</span>
            <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} data-testid={`place-${k}`} />
          </label>
        ))}
      </div>
      <div className="lc-btns">
        <button type="button" className="loc-btn" data-testid="place-save" disabled={busy || !p.moved}
          title={p.moved ? undefined : "Move the square first"}
          onClick={async () => { setBusy(true); await onSave(diff); setBusy(false); }}>
          {busy ? "Saving…" : "Save pin and address"}
        </button>
      </div>
      <div className="lc-mut lc-note">No address lookup: the pin is where you drop it, and the address is the text you type.</div>
      {msg && <div className={"lc-msg" + (msg.bad ? " lc-bad" : "")} data-testid="comp-msg">{msg.text}</div>}
    </div>
  );
}
