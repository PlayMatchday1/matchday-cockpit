"use client";

// GROWTH › COMPETITORS — what Plei and GoodRec are selling, next to what we sell.
//
// Ryan: "I want to add a competitor page to the growth tab that shows all the goodrec and plei data
// so we can review it. You see bookable matches fields spots price size (7v7 etc)."
// And on the first cut: "theres no data for each facility the page looks bland."
//
// ══ IT IS A CSS GRID, NOT A TABLE, AND THAT IS NOT A STYLE CHOICE ════════════════════════════
// The mock's first cut was a <table>. One bad cell — a totals row that summed the facility NAME
// column — concatenated 26 names into a single cell with an intrinsic width of 3,596px, which gave
// the whole column that width and pushed every numeric column off screen. The page rendered, 51
// assertions passed, and nothing was visible but facility names. A grid with FIXED TRACK SIZES
// cannot do that: a cell that overflows clips or wraps inside its own track and the columns beside
// it do not move.
//
// ══ AND THE ASSERTION THAT LET IT SHIP ═══════════════════════════════════════════════════════
// The only width check was scrollWidth >= clientWidth, which is true of every element ever laid
// out. The suite now measures scrollWidth > clientWidth + 2 per panel and carries a control that
// forces an over-wide cell to prove the check can fail.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  fmtMdStandard, fmtPrice, fmtWindow, medianFloorCents, mdStandard,
  sortFormats, undercutsUs, windowsAlign, type WindowSpec,
} from "@/lib/competitorSupply";

type Capture = {
  id: number; source: string; city_label: string; city_identifier: string | null;
  window_start: string; window_end: string; window_note: string | null;
  captured_at: string; captured_by: string;
};
type Supply = {
  id: number; capture_id: number; facility: string; matches_per_week: number | null;
  bookable_spots_per_week: number; price_low_cents: number | null; price_high_cents: number | null;
  formats: string[]; our_venue_id: number | null; not_ours?: boolean;
};
type CMatch = {
  id: number; supply_id: number; match_date: string; kickoff_local: string | null;
  format: string; spots: number; price_cents: number | null; note?: string | null;
};
type OurSide = { spots: number; matches: number; priceFloorCents: number | null };
type Payload = {
  tableReady: boolean;
  captures: Capture[]; supply: Supply[]; matches: CMatch[];
  venues: { id: number; venue_name: string; city: string }[];
  ours: Record<string, Record<string, OurSide>>;
  ourCities: string[]; capturedOurCities: string[];
  cityLabelToOurs: Record<string, string>;
  /* PROPOSED shared-field links. our_venue_id is still NULL on these; a person accepts. */
  proposals: { supplyId: number; facility: string; venueId: number | null; venueName: string | null; via: string | null; score: number; why: string }[];
};
type Proposal = Payload["proposals"][number];

const SOURCE_LABEL: Record<string, string> = { plei: "Plei", goodrec: "GoodRec", us: "MatchDay" };
/* THE OPERATOR TAG. Every row says whose supply it is, in the mock's own three-way vocabulary:
 * MATCHDAY, PLEI, GOODREC. Without it a tinted row is the only signal that a line is ours, and a
 * tint is not a label. */
const srcLabel = (s: string): string => (s === "plei" ? "PLEI" : s === "goodrec" ? "GOODREC" : "MATCHDAY");
const srcClass = (s: string): string => (s === "plei" ? "plei" : s === "goodrec" ? "gr" : "us");
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Weekday of a plain calendar date. Parsed as UTC so no zone can shift the day. */
const dowOf = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : DOW[(d.getUTCDay() + 6) % 7];
};
const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const commas = (n: number): string => n.toLocaleString("en-US");

/* A ROW ON SCREEN, whether it is theirs or ours. Ours carry no capture and no match log. */
type Row = {
  key: string; facility: string; source: "us" | string; spots: number;
  lowCents: number | null; highCents: number | null; formats: string[];
  ourVenueId: number | null; supplyId: number | null; isOurs: boolean;
  /* THE COMPETITOR'S OWN COUNT. Off the row on purpose; see the panel header. */
  theirMatchCount: number | null;
  proposal: Proposal | null;
  /* A PERSON RULED THIS IS NOT OURS. Different from "nobody has looked", which is null. */
  notOurs: boolean;
};

export default function CompetitorsView() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [src, setSrc] = useState<"both" | "plei" | "goodrec">("both");
  const [fmts, setFmts] = useState<string[]>([]);
  /* OPEN ROWS SURVIVE A RE-RENDER. Filtering by format or switching source must not collapse
   * everything the reader just opened: Ryan is comparing, and losing his place is the whole cost. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/growth/competitors", {
        cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setData(j as Payload);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const acceptLink = useCallback(async (supplyId: number, venueId: number | null, notOurs = false) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const res = await fetch("/api/growth/competitors", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ acceptLink: { supplyId, venueId, notOurs } }),
    });
    if (res.ok) await load();
    else setErr((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
  }, [load]);

  const toggle = (k: string) =>
    setOpen((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  /** Every format anyone has captured, smallest first. Built from the data, never hardcoded. */
  const allFormats = useMemo(
    () => sortFormats((data?.supply ?? []).flatMap((s) => s.formats ?? [])),
    [data],
  );

  const cities = useMemo(() => {
    if (!data) return [];
    const byLabel = new Map<string, Capture[]>();
    for (const c of data.captures) {
      if (!byLabel.has(c.city_label)) byLabel.set(c.city_label, []);
      byLabel.get(c.city_label)!.push(c);
    }
    return [...byLabel.entries()]
      .map(([label, caps]) => ({ label, caps }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  if (loading && !data) return <div className="p-8 text-sm text-deep-green/60">Loading the captures…</div>;
  if (err) return <div className="m-4 rounded-xl border border-coral/40 bg-coral-soft/40 p-4 text-sm text-coral">{err}</div>;
  if (!data) return null;

  const uncaptured = data.ourCities.filter((c) => !data.capturedOurCities.includes(c));

  return (
    <div className="cmp">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* THE SOURCE BAR IS THE MOCK'S TOP BAR, full bleed above the content. */}
      <div className="sw" data-testid="srcbar">
        <b>Source</b>
        {(["both", "plei", "goodrec"] as const).map((s) => (
          <button key={s} type="button" data-s={s} aria-pressed={src === s} onClick={() => setSrc(s)}>
            {s === "both" ? "Both" : SOURCE_LABEL[s]}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" data-testid="import-open" onClick={() => setImportOpen((v) => !v)}>
          {importOpen ? "Close importer" : "Import a capture"}
        </button>
      </div>

      <div className="wrap">
        <h1>Competitors</h1>

        {!data.tableReady && (
          <div className="cov">
            <b>The competitor tables are not in the database yet.</b> Apply migration 0179.
          </div>
        )}

        {/* COVERAGE, BEFORE ANY ROW. A city that is not here has not been looked at. */}
        <div className="cov" data-testid="coverage">
          <b>{data.capturedOurCities.length} of {data.ourCities.length} cities captured.</b>
          {uncaptured.length > 0 && <> Missing: {uncaptured.join(", ")}.</>}
        </div>

        {allFormats.length > 0 && (
          <div className="ffilter" data-testid="fbar">
            <span className="lbl">Format</span>
            {allFormats.map((f) => (
              <button key={f} type="button" data-testid="fbtn" data-fmt={f} aria-pressed={fmts.includes(f)}
                onClick={() => setFmts((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]))}>
                {f}
              </button>
            ))}
            {fmts.length > 0 && (
              <button type="button" data-testid="fclear" onClick={() => setFmts([])}>Clear</button>
            )}
          </div>
        )}

        {/* THE FILTER NARROWS THE LIST AND NOTHING ELSE, and the page says so while it is on. */}
        {fmts.length > 0 && (
          <div className="fnote" data-testid="fnote">
            Showing facilities that offer {fmts.join(" or ")}. The city totals, the MD Standard and the share
            {" "}<b>still cover every format</b>, because the capture records <b>spots per facility, not per format</b>.
          </div>
        )}

        {importOpen && <Importer onDone={() => { setImportOpen(false); void load(); }} />}

        {cities.length === 0 && data.tableReady && (
          <div className="cov">Nothing has been captured yet. Use <b>Import a capture</b> above.</div>
        )}

      {cities.map(({ label, caps }) => (
        <CityPanel key={label} label={label} caps={caps} data={data} src={src} fmts={fmts}
          open={open} toggle={toggle} onLink={acceptLink} />
      ))}
      </div>
    </div>
  );
}

/* ── ONE CITY ─────────────────────────────────────────────────────────────────────────────────
 * A CITY WITH NO CAPTURE RENDERS NOTHING AT ALL, rather than an empty panel that reads as zero
 * supply. That is the whole point of the coverage line above. */
function CityPanel({ label, caps, data, src, fmts, open, toggle, onLink }: {
  label: string; caps: Capture[]; data: Payload;
  src: "both" | "plei" | "goodrec"; fmts: string[];
  open: Set<string>; toggle: (k: string) => void;
  onLink: (supplyId: number, venueId: number | null, notOurs?: boolean) => void | Promise<void>;
}) {
  const shown = caps.filter((c) => src === "both" || c.source === src);
  const ourCity = data.cityLabelToOurs[label] ?? null;

  /* OUR OWN ROWS. Spots over the capture's own window, from mdapi_matches, so they cannot go
   * stale. Which window? The one belonging to the sources on screen; if two sources carry two
   * different weeks we take the FIRST shown, and the heading names both so the reader can see it. */
  const primary = shown[0] ?? caps[0];
  const ourKey = primary ? `${primary.window_start}|${primary.window_end}` : "";
  const ourByVenue = data.ours[ourKey] ?? {};
  const ourVenues = data.venues.filter((v) => v.city === ourCity);

  const ourRows: Row[] = ourVenues
    .map((v) => ({ v, o: ourByVenue[String(v.id)] as OurSide | undefined }))
    .filter((x) => (x.o?.spots ?? 0) > 0)
    .map(({ v, o }) => ({
      key: `us-${v.id}`, facility: v.venue_name, source: "us" as const,
      spots: o!.spots, lowCents: o!.priceFloorCents, highCents: o!.priceFloorCents,
      formats: [], ourVenueId: v.id, supplyId: null, isOurs: true,
      theirMatchCount: null, proposal: null, notOurs: false,
    }));

  /** Our cheapest published price in this city, which is what "under us" is measured against. */
  const ourFloor = useMemo(() => {
    const xs = ourRows.map((r) => r.lowCents).filter((x): x is number => x != null);
    return xs.length ? Math.min(...xs) : null;
  }, [ourRows]);

  const theirRowsAll: Row[] = useMemo(() => {
    const capIds = new Set(shown.map((c) => c.id));
    return data.supply.filter((s) => capIds.has(s.capture_id)).map((s) => {
      const cap = shown.find((c) => c.id === s.capture_id)!;
      return {
        key: `s-${s.id}`, facility: s.facility, source: cap.source, spots: s.bookable_spots_per_week,
        lowCents: s.price_low_cents, highCents: s.price_high_cents,
        formats: sortFormats(s.formats ?? []), ourVenueId: s.our_venue_id, supplyId: s.id, isOurs: false,
        theirMatchCount: s.matches_per_week == null ? null : Number(s.matches_per_week),
        proposal: data.proposals?.find((p) => p.supplyId === s.id) ?? null,
        notOurs: s.not_ours === true,
      };
    });
  }, [data.supply, data.proposals, shown]);

  /* THE TOTALS ARE OVER EVERY FACILITY, NEVER THE FILTERED SET. */
  const totalSpots = theirRowsAll.reduce((a, b) => a + b.spots, 0);
  const median = medianFloorCents(theirRowsAll.map((r) => ({ lowCents: r.lowCents, highCents: r.highCents })));
  const under = theirRowsAll.filter((r) => undercutsUs({ lowCents: r.lowCents, highCents: r.highCents }, ourFloor)).length;

  const matched = (r: Row) => fmts.length === 0 || r.formats.some((f) => fmts.includes(f));
  const rows = [...ourRows, ...theirRowsAll.filter(matched)].sort((a, b) => b.spots - a.spots);
  /* THE BAR SCALE IS THE WHOLE CITY, not the filtered set, so bars do not resize under a filter. */
  const maxSpots = Math.max(1, ...ourRows.map((r) => r.spots), ...theirRowsAll.map((r) => r.spots));

  const ourSpots = ourRows.reduce((a, b) => a + b.spots, 0);
  const oursMd = mdStandard(ourSpots);
  const theirMd = mdStandard(totalSpots);
  const sharePct = oursMd + theirMd > 0 ? Math.round((oursMd / (oursMd + theirMd)) * 100) : 0;

  /* A PERCENTAGE WHERE THE WINDOWS ARE THE SAME LENGTH. An offset of a day or two does not make a
   * week incomparable to a week; a fortnight against a week does. The capture's own note is NOT an
   * input any more: one that read "not a clean 7 days" was mistaken, and it alone stopped this
   * page dividing two windows that were both seven days. */
  const align = useMemo(
    () => windowsAlign(
      { start: primary?.window_start ?? "", end: primary?.window_end ?? "" },
      shown.map((c): WindowSpec => ({
        source: SOURCE_LABEL[c.source] ?? c.source,
        start: c.window_start, end: c.window_end,
      })),
    ),
    [primary, shown],
  );

  /* ── THIS SOURCE WAS NOT CAPTURED HERE, WHICH IS NOT ZERO SUPPLY ──────────────────────────
   * Filtering Houston to GoodRec used to drop the whole panel, which took OUR OWN rows with it and
   * left the reader with no Houston at all. Dropping it is also the absence trap in miniature: a
   * city that disappears under a filter reads as "GoodRec sells nothing here", and nobody has
   * looked. So the panel stays, our rows stay, and the page says which of the two it is. */
  const notCaptured = shown.length === 0;

  return (
    <section className="city" data-testid="city" data-city={label}>
      <div className="chead">
        <h2>{label}</h2>
        <span className="win" data-testid="window">
          {(notCaptured ? [] : shown).map((c) => (
            <span key={c.id}>
              {SOURCE_LABEL[c.source] ?? c.source} {fmtWindow(c.window_start, c.window_end)}
              {c.window_note ? ` · ${c.window_note}` : ""}{" "}
            </span>
          ))}
        </span>
      </div>

      {notCaptured && (
        <div className="notcaptured" data-testid="notcaptured">
          <b>{SOURCE_LABEL[src] ?? src} not captured in {label}.</b>
        </div>
      )}

      {!notCaptured && (
        <div className="stats">
          <div className="stat"><div className="lbl">Facilities</div>
            <div className="v num" data-testid="s-fac">{theirRowsAll.length}</div>
            <div className="n">competing, plus our {ourRows.length}</div></div>
          <div className="stat"><div className="lbl">Their spots / wk</div>
            <div className="v num" data-testid="s-spots">{commas(totalSpots)}</div>
            <div className="n">{fmtMdStandard(totalSpots)} MD Standard</div></div>
          <div className="stat"><div className="lbl">Median price</div>
            <div className="v num" data-testid="s-median">{median == null ? "not shown" : money(median)}</div>
            <div className="n">{ourFloor == null ? "we publish no price this week" : `we charge from ${money(ourFloor)}`}</div></div>
          <div className="stat"><div className="lbl">Cheaper than us</div>
            <div className="v num" data-testid="s-under">{under}</div>
            <div className="n">of {theirRowsAll.length} competing facilities</div></div>
        </div>
      )}

      {!notCaptured && (
        <div className="share" data-testid="share">
          <div className="shareline">
            {align.aligned
              ? <>MatchDay holds <b data-testid="sharepct">{sharePct}%</b> of captured bookable supply</>
              /* STILL REACHABLE, and deliberately so: a capture of a different NUMBER of days is
                 not a week and dividing it against ours is the figure that ends up in a deck
                 without its caveat. Nothing in the September data reaches this. */
              : <b className="noshare" data-testid="nosharepct">
                  {align.reasons[0]}, so there is no percentage
                </b>}
            <i className="swin" data-testid="sharewindow">
              {primary ? fmtWindow(primary.window_start, primary.window_end) : ""}
            </i>
          </div>
          <div className="sbar">
            <span className="seg us" data-testid="seg-us"
              style={{ width: `${pct(oursMd, oursMd + theirMd)}%` }}>{oursMd >= 1 ? oursMd.toFixed(1) : ""}</span>
            {shown.map((c) => {
              const sp = data.supply.filter((x) => x.capture_id === c.id).reduce((a, b) => a + b.bookable_spots_per_week, 0);
              return <span key={c.id} className={`seg ${srcClass(c.source)}`} data-testid={`seg-${c.source}`}
                style={{ width: `${pct(mdStandard(sp), oursMd + theirMd)}%` }}>{fmtMdStandard(sp)}</span>;
            })}
          </div>
          <div className="skeys">
            <span><i className="dot" style={{ background: "var(--us)" }} /> MatchDay {oursMd.toFixed(1)}</span>
            {shown.map((c) => {
              const sp = data.supply.filter((x) => x.capture_id === c.id).reduce((a, b) => a + b.bookable_spots_per_week, 0);
              return <span key={c.id}><i className="dot" style={{ background: c.source === "plei" ? "var(--plei)" : "var(--gr)" }} /> {SOURCE_LABEL[c.source]} {fmtMdStandard(sp)}</span>;
            })}
          </div>
        </div>
      )}

      <div className="rhead">
        <div className="lbl">Facility</div>
        <div className="lbl">Spots / wk</div>
        <div className="lbl" style={{ textAlign: "right" }} title="Bookable spots ÷ 18, one MatchDay match">MD std</div>
        <div className="lbl" style={{ textAlign: "right" }}>Price per player</div>
        <div className="lbl">Formats</div>
      </div>
      {rows.map((r) => (
        <FacilityRow key={r.key} r={r} maxSpots={maxSpots} ourFloor={ourFloor} fmts={fmts}
          matches={r.supplyId == null ? [] : data.matches.filter((m) => m.supply_id === r.supplyId)}
          isOpen={open.has(r.key)} onToggle={() => toggle(r.key)} onLink={onLink} />
      ))}
    </section>
  );
}

const pct = (a: number, b: number): number => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);

/* ── ONE FACILITY, AND ITS WEEK ───────────────────────────────────────────────────────────────
 * THE ROW IS THE CONTROL. It is a <button> carrying aria-expanded. The format chips inside it are
 * LABELS, plain spans, because a button inside a button is invalid markup and the filter bubbles at
 * the top are the keyboard path to the same thing. */
function FacilityRow({ r, maxSpots, ourFloor, fmts, matches, isOpen, onToggle, onLink }: {
  r: Row; maxSpots: number; ourFloor: number | null; fmts: string[]; matches: CMatch[];
  isOpen: boolean; onToggle: () => void;
  onLink: (supplyId: number, venueId: number | null, notOurs?: boolean) => void | Promise<void>;
}) {
  const price = fmtPrice({ lowCents: r.lowCents, highCents: r.highCents });
  const cheaper = !r.isOurs && undercutsUs({ lowCents: r.lowCents, highCents: r.highCents }, ourFloor);
  /* ── THEY ARE BOOKING OUR FIELDS ──────────────────────────────────────────────────────────
   * Two states, and the difference is the whole point. CONFIRMED is our_venue_id, set by a person.
   * PROPOSED is a name match nobody has ruled on yet, and it says so, because "Athlete Training &
   * Health | Cypress" and "Athlete Training and Health | Katy" differ by one word and are
   * different places. Our own row never claims to also be our field. */
  const confirmed = !r.isOurs && r.ourVenueId != null;
  const proposed = !r.isOurs && r.ourVenueId == null && !r.notOurs && r.proposal?.venueId != null;

  const byDay = useMemo(() => {
    const m = new Map<string, CMatch[]>();
    for (const x of matches) {
      const d = dowOf(x.match_date);
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(x);
    }
    /* A LISTING WITH NO TIME SORTS LAST IN ITS DAY, never first. One Foro Sports Club row was
     * recorded with its time cut off; treating null as 00:00 would put an unknown hour at the top
     * of Friday as if it were a midnight kick-off. */
    for (const list of m.values()) {
      list.sort((a, b) => {
        if (a.kickoff_local == null && b.kickoff_local == null) return 0;
        if (a.kickoff_local == null) return 1;
        if (b.kickoff_local == null) return -1;
        return a.kickoff_local.localeCompare(b.kickoff_local);
      });
    }
    return DOW.filter((d) => m.has(d)).map((d) => ({ day: d, list: m.get(d)! }));
  }, [matches]);

  return (
    <div className="fwrap" data-testid="wrap" data-fac={r.facility}>
      <button type="button" className={`frow${r.isOurs ? " ours" : ""}`} data-testid="row"
        data-fac={r.facility} data-src={r.isOurs ? "us" : r.source} aria-expanded={isOpen} onClick={onToggle}>
        <div className="fname">
          <div className="n" title={r.facility}><span className="chev" aria-hidden>›</span>{r.facility}</div>
          <div className="m">
            {/* THE OPERATOR TAG. Whose supply this line is, said in words rather than left to a
                background tint. It was missing and a tinted row was the only signal. */}
            <span className={`src ${srcClass(r.isOurs ? "us" : r.source)}`} data-testid="src">
              {srcLabel(r.isOurs ? "us" : r.source)}
            </span>
            {confirmed && <span className="ourschip" data-testid="ours">ALSO OUR FIELD</span>}
            {proposed && <span className="ourschip" style={{ background: "var(--amb)" }} data-testid="maybe-ours">LOOKS LIKE OURS</span>}
          </div>
        </div>
        <div className="spots">
          <span className="track">
            <span className={`fill ${srcClass(r.isOurs ? "us" : r.source)}`}
              style={{ width: `${Math.max(2, (r.spots / maxSpots) * 100)}%` }} />
          </span>
          <span className="v num" data-testid="spots">{commas(r.spots)}</span>
        </div>
        <div className="md num" data-testid="mdstd">{fmtMdStandard(r.spots)}</div>
        <div className="price num">
          {price.shown
            ? <span data-testid="price">{price.text}</span>
            : <span className="pnone" data-testid="noprice">not shown</span>}
          {cheaper && <span className="u" data-testid="under">under us</span>}
        </div>
        <div className="fmts" data-testid="formats">
          {r.formats.map((f) => <span key={f} className={`fchip${fmts.includes(f) ? " hit" : ""}`}>{f}</span>)}
        </div>
      </button>

      {isOpen && (
        <div className="fdetail" data-testid="detail" data-fac={r.facility}>
          {r.notOurs && (
            <div className="linkbox ruled" data-testid="ruledout">
              <b>Ruled not ours.</b> A different facility, so the matcher will not ask again.
              <span className="lbtns">
                <button type="button" className="no" data-testid="unrule"
                  onClick={(e) => { e.stopPropagation(); void onLink(r.supplyId!, null, false); }}>Reopen the question</button>
              </span>
            </div>
          )}
          {(proposed || confirmed) && (
            <div className={`linkbox${confirmed ? " done" : ""}`} data-testid="linkbox">
              {confirmed ? (
                <>
                  <b>This is our field.</b> Confirmed link to venue {r.ourVenueId}.
                  <span className="lbtns">
                    <button type="button" className="no" data-testid="unlink"
                      onClick={(e) => { e.stopPropagation(); void onLink(r.supplyId!, null); }}>Not ours, clear it</button>
                  </span>
                </>
              ) : (
                <>
                  <b>This looks like our {r.proposal!.venueName}.</b> Matched on <i>{r.proposal!.via}</i> because
                  it {r.proposal!.why}. Nothing is linked until you say so.
                  <span className="lbtns">
                    <button type="button" data-testid="accept-link"
                      onClick={(e) => { e.stopPropagation(); void onLink(r.supplyId!, r.proposal!.venueId!); }}>Yes, this is our field</button>
                    <button type="button" className="no" data-testid="reject-link"
                      onClick={(e) => { e.stopPropagation(); void onLink(r.supplyId!, null, true); }}>No, different facility</button>
                  </span>
                </>
              )}
            </div>
          )}
          {r.theirMatchCount != null && (
            <div className="theircount" data-testid="theircount">
              <b>{SOURCE_LABEL[r.source] ?? r.source} lists {r.theirMatchCount} match{r.theirMatchCount === 1 ? "" : "es"} a week</b> here.
              That is their own count and it does not reconcile with the formats, so the page orders and
              totals on <b>spots</b> instead. {fmtMdStandard(r.spots)} MD Standard is the same supply in our unit.
            </div>
          )}

          {byDay.length === 0 ? (
            /* THE COMMON STATE for a capture that arrives without a log. It says "no match log"
               rather than "no matches", which are different facts. */
            <div className="nodetail" data-testid="nodetail">No match log in this capture.</div>
          ) : (
            <div className="dgrid">
              {byDay.map(({ day, list }) => {
                const spots = list.reduce((a, b) => a + b.spots, 0);
                const prices = list.map((m) => m.price_cents).filter((x): x is number => x != null);
                const lo = prices.length ? Math.min(...prices) : null;
                const hi = prices.length ? Math.max(...prices) : null;
                return (
                  <div className="dday" key={day} data-testid="day" data-day={day}>
                    <h4>{day}
                      <span data-testid="daysum">
                        {list.length} match{list.length === 1 ? "" : "es"} · {spots} spots
                        {lo != null ? ` · ${lo === hi ? money(lo) : `${money(lo)} to ${money(hi as number)}`}` : ""}
                      </span>
                    </h4>
                    {list.map((m) => (
                      <div className="dm" key={m.id} data-testid="match" data-notime={m.kickoff_local == null ? "1" : "0"}>
                        <span className={`t${m.kickoff_local == null ? " none" : ""}`} data-testid="mtime">
                          {m.kickoff_local == null ? "time not captured" : fmtTime(m.kickoff_local)}
                        </span>
                        <span className="fchip" style={{ cursor: "default" }}>{m.format}</span>
                        <span className="s">{m.spots} spots</span>
                        {/* NULL IS "not shown", 0 IS FREE. Collapsing them misprices a market. */}
                        <span className={`p num${m.price_cents == null ? " none" : ""}`} data-testid="mprice">
                          {m.price_cents == null ? "not shown" : m.price_cents === 0 ? "free" : money(m.price_cents)}
                        </span>
                        {m.note && <span className="note" data-testid="mnote">{m.note}</span>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "18:00:00" to "6:00 PM". Characters only: a listed local time has no zone to convert through. */
function fmtTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  if (!m) return String(t);
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

/* ── THE IMPORTER ─────────────────────────────────────────────────────────────────────────────
 * Paste or upload, same column shape as the capture file. It shows what WILL change before it is
 * written, and rejects the whole file on any bad row. */
function Importer({ onDone }: { onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ source: string; city_label: string; window_start: string; window_end: string; facilities: number; spots: number; replaces: number | null }[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad: boolean; problems?: string[] } | null>(null);

  const send = async (dryRun: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/growth/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ csv, dryRun }),
      });
      const j = await res.json();
      if (!res.ok) { setPlan(null); setMsg({ text: j?.error ?? `HTTP ${res.status}`, bad: true, problems: j?.problems }); return; }
      if (dryRun) { setPlan(j.plan); setMsg(null); }
      else { setMsg({ text: `Imported ${j.written?.length ?? 0} capture(s).`, bad: false }); onDone(); }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally { setBusy(false); }
  };

  return (
    <div className="importer" data-testid="importer">
      <div className="ihead">Import a capture</div>
      <p className="ihint">
        Same columns as the capture file: source, city_label, window_start, window_end, window_note,
        facility, matches_per_week, bookable_spots_per_week, price_low, price_high, formats
        (pipe separated). Re-importing the same source, city and window <b>replaces</b> that capture.
      </p>
      <input type="file" accept=".csv,text/csv" data-testid="import-file"
        onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setPlan(null); } }} />
      <textarea value={csv} data-testid="import-text" rows={6} spellCheck={false}
        placeholder="or paste the CSV here"
        onChange={(e) => { setCsv(e.target.value); setPlan(null); }} />
      <div className="ibtns">
        <button type="button" data-testid="import-check" disabled={busy || !csv.trim()} onClick={() => void send(true)}>
          {busy ? "Checking…" : "Check the file"}
        </button>
        <button type="button" className="go" data-testid="import-go" disabled={busy || !plan} onClick={() => void send(false)}>
          Import
        </button>
      </div>
      {msg && (
        <div className={`imsg${msg.bad ? " bad" : ""}`} data-testid="import-msg">
          {msg.text}
          {msg.problems?.length ? <ul>{msg.problems.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
        </div>
      )}
      {plan && (
        <div className="iplan" data-testid="import-plan">
          {plan.map((p, i) => (
            <div key={i}>
              <b>{SOURCE_LABEL[p.source] ?? p.source} · {p.city_label}</b> {p.window_start} to {p.window_end} ·{" "}
              {p.facilities} facilities · {commas(p.spots)} spots ·{" "}
              {p.replaces ? <i>this window already exists and will be replaced</i> : <i>new capture</i>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── THE STYLESHEET IS THE MOCK'S, VERBATIM ───────────────────────────────────────────────────
 * scripts/mocks/competitors.html is the spec and this is its <style> block: every token, every
 * grid track, the type scale, the padding, the chips, the bars. The ONLY change is that every
 * selector is scoped under .cmp, because the mock is a whole document and this is a page inside
 * the Cockpit shell. What that scoping forced is listed in the report; it is four rules.
 *
 * DO NOT RE-DERIVE THESE VALUES. They were arrived at against a real capture and a 3,596px bug. */
const CSS = [
  "  .cmp{ --ink:#12261c; --mut:#5d6b62; --faint:#8b9a91; --line:#dfe5e0; --hair:#eef2ef; --bg:#f4f6f4;",
  "         --grn:#12402a; --mint:#e6f6ee; --ok:#0d6b45;",
  "         --amb:#8a5a12; --ambbg:#fdf6e6; --ambline:#ecdcb4;",
  "         --us:#12402a; --us-bg:#e6f6ee;",
  "         --plei:#5b4b8a; --plei-bg:#efecf7;",
  "         --gr:#12657a; --gr-bg:#e5f2f5; }",
  "  .cmp * { box-sizing:border-box }",
  "  .cmp [hidden] { display:none !important }",
  "  .cmp { margin:0; font:14px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif; color:var(--ink); background:var(--bg) }",
  "  .cmp .num { font-variant-numeric:tabular-nums }",
  "",
  "  .cmp .sw { display:flex; gap:6px; padding:10px 12px; background:#fff; border-bottom:1px solid var(--line); flex-wrap:wrap; align-items:center }",
  "  .cmp .sw b { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--mut); margin-right:2px }",
  "  .cmp .sw button { font:inherit; font-size:12.5px; font-weight:650; padding:6px 11px; border:1px solid var(--line);",
  "              background:#fff; color:var(--ink); border-radius:999px; cursor:pointer; min-height:32px }",
  "  .cmp .sw button[aria-pressed=\"true\"] { background:var(--grn); color:#fff; border-color:var(--grn) }",
  "",
  "  .cmp .wrap { padding:16px; max-width:1060px; margin:0 auto }",
  "  .cmp h1 { margin:0; font-size:22px; font-weight:800; letter-spacing:-.01em }",
  "  .cmp .sub { margin-top:3px; font-size:12.5px; color:var(--mut) }",
  "  .cmp .lbl { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--mut); font-weight:800 }",
  "",
  "  .cmp .cov { margin-top:14px; border:1px solid var(--ambline); background:var(--ambbg); border-radius:9px;",
  "        padding:11px 13px; font-size:12.5px; color:var(--amb); line-height:1.5 }",
  "  .cmp .cov b { font-weight:800 }",
  "",
  "  .cmp .city { margin-top:20px; background:#fff; border:1px solid var(--line); border-radius:11px; overflow:hidden }",
  "  .cmp .chead { padding:12px 14px; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; border-bottom:1px solid var(--hair) }",
  "  .cmp .chead h2 { margin:0; font-size:16px; font-weight:800 }",
  "  .cmp .win { font-size:11.5px; color:var(--faint) }",
  "",
  "  /* ── the four numbers that describe the market, before any row ─────────── */",
  "  .cmp .stats { display:grid; grid-template-columns:repeat(4,1fr); border-bottom:1px solid var(--hair) }",
  "  .cmp .stat { padding:11px 14px; border-left:1px solid var(--hair) }",
  "  .cmp .stat:first-child { border-left:0 }",
  "  .cmp .stat .v { font-size:18px; font-weight:800; letter-spacing:-.01em; margin-top:3px }",
  "  .cmp .stat .n { font-size:11px; color:var(--faint); margin-top:1px }",
  "  @media (max-width:640px){ .stats{ grid-template-columns:repeat(2,1fr) }",
  "    .cmp .stat:nth-child(3) { border-left:0 } .stat:nth-child(n+3){ border-top:1px solid var(--hair) } }",
  "",
  "  .cmp .share { padding:12px 14px; border-bottom:1px solid var(--hair); background:#fbfdfb }",
  "  .cmp .shareline { font-size:12.5px; margin-bottom:9px }",
  "  .cmp .shareline b { font-size:15px; font-weight:800 }",
  "  .cmp .shareline b.noshare { font-size:13px; color:#8a6300 }",
  "  .cmp .shareline .swin { font-style:normal; font-size:11px; color:#8a9992; margin-left:8px }",
  "  .cmp .sbar { display:flex; height:22px; border-radius:5px; overflow:hidden; border:1px solid var(--line) }",
  "  .cmp .seg { display:flex; align-items:center; justify-content:center; font-size:10.5px; font-weight:800; color:#fff; min-width:2px }",
  "  .cmp .seg.us { background:var(--us) } .seg.plei{ background:var(--plei) } .seg.gr{ background:var(--gr) }",
  "  .cmp .skeys { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:var(--mut) }",
  "  .cmp .skeys span { display:flex; align-items:center; gap:6px }",
  "  .cmp .dot { width:9px; height:9px; border-radius:2px; flex:none }",
  "",
  "  /* ── the facility rows. A GRID, not a table: a table's auto layout is how",
  "       one bad cell pushed every number off screen. ─────────────────────────── */",
  "  .cmp .rhead, .cmp .frow {",
  "    display:grid;",
  "    grid-template-columns:minmax(0,1.6fr) 150px 64px 128px minmax(0,0.78fr);",
  "    gap:14px; align-items:center; padding:10px 14px;",
  "  }",
  "  .cmp .rhead { border-bottom:1px solid var(--hair); background:#fafbfa }",
  "  .cmp .frow { border-bottom:1px solid var(--hair) }",
  "  .cmp .frow:last-child { border-bottom:0 }",
  "  .cmp .frow.ours { background:var(--us-bg) }",
  "",
  "  .cmp .fname { min-width:0 }",
  "  .cmp .fname .n { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }",
  "  .cmp .fname .m { display:flex; gap:5px; align-items:center; margin-top:3px; flex-wrap:wrap }",
  "  .cmp .src { font-size:9px; font-weight:800; padding:1.5px 5px; border-radius:3px; letter-spacing:.04em }",
  "  .cmp .src.plei { background:var(--plei-bg); color:var(--plei) }",
  "  .cmp .src.gr { background:var(--gr-bg); color:var(--gr) }",
  "  .cmp .src.us { background:var(--us); color:#fff }",
  "  .cmp .ourschip { font-size:9px; font-weight:800; padding:1.5px 5px; border-radius:3px; background:var(--us); color:#fff }",
  "",
  "  /* spots: a bar, so size reads before the number does */",
  "  .cmp .spots { display:flex; align-items:center; gap:8px; min-width:0 }",
  "  .cmp .track { flex:1; height:8px; background:var(--hair); border-radius:2px; overflow:hidden; min-width:10px }",
  "  /* display:block, because width and height do not apply to a non-replaced INLINE element and a",
  "     bare <span> is inline. Without it every bar renders at 0px and the column looks empty. */",
  "  .cmp .fill { display:block; height:100%; border-radius:2px; min-width:2px }",
  "  .cmp .fill.plei { background:var(--plei) } .fill.gr{ background:var(--gr) } .fill.us{ background:var(--us) }",
  "  .cmp .spots .v { font-size:12.5px; font-weight:650; width:42px; text-align:right; flex:none }",
  "  .cmp .md { font-size:12.5px; color:var(--mut); text-align:right }",
  "",
  "  /* PRICE IS A NUMBER, NOT A POSITION. The first cut drew each facility as a segment on a shared",
  "     $6 to $16 axis with a marker at our own price. It needed a legend to read, the axis labels",
  "     floated with nothing under them, and Ryan's verdict was \"makes no sense\". A number needs no",
  "     legend. The comparison it was trying to make already lives in the CHEAPER THAN US tile. */",
  "  .cmp .price { text-align:right; font-size:12.5px; white-space:nowrap }",
  "  .cmp .price .u { display:block; font-size:10.5px; font-weight:700; color:var(--amb); margin-top:1px }",
  "  .cmp .pnone { color:var(--faint); font-style:italic; font-size:11.5px }",
  "",
  "  .cmp .fmts { display:flex; gap:4px; flex-wrap:wrap; min-width:0 }",
  "  /* A chip in a row is a LABEL, not a control: it sits inside the row's <button> and a button",
  "     inside a button is invalid markup. The filter bubbles at the top of the page are the control,",
  "     and they are keyboard reachable. */",
  "  .cmp .fchip { font-size:10.5px; font-weight:700; padding:3px 7px; border-radius:999px;",
  "          background:var(--hair); color:var(--mut) }",
  "  .cmp .fchip.hit { background:var(--grn); color:#fff }",
  "",
  "  /* ── the format filter, page level ─────────────────────────────────────── */",
  "  .cmp .ffilter { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:12px }",
  "  .cmp .ffilter .lbl { margin-right:2px }",
  "  .cmp .ffilter button { font:inherit; font-size:12px; font-weight:700; padding:5px 11px; min-height:32px;",
  "                   border-radius:999px; border:1px solid var(--line); background:#fff; color:var(--ink); cursor:pointer }",
  "  .cmp .ffilter button[aria-pressed=\"true\"] { background:var(--grn); color:#fff; border-color:var(--grn) }",
  "  .cmp .fnote { margin-top:8px; font-size:11.5px; color:var(--amb) }",
  "",
  "  /* ── expand / minimize ─────────────────────────────────────────────────── */",
  "  .cmp .fwrap { border-bottom:1px solid var(--hair) }",
  "  .cmp .fwrap:last-child { border-bottom:0 }",
  "  .cmp .frow { width:100%; font:inherit; color:inherit; background:none; border:0; text-align:left; cursor:pointer }",
  "  .cmp .frow:hover { background:#fafbfa }",
  "  .cmp .frow.ours:hover { background:#dcf0e5 }",
  "  .cmp .frow:focus-visible { outline:2px solid var(--grn); outline-offset:-2px }",
  "  .cmp .chev { display:inline-block; width:13px; color:var(--faint); font-weight:800;",
  "         transition:transform .14s ease-out; transform-origin:45% 50% }",
  "  .cmp .frow[aria-expanded=\"true\"] .chev { transform:rotate(90deg); color:var(--ink) }",
  "  @media (prefers-reduced-motion:reduce){ .chev{ transition:none } }",
  "",
  "  .cmp .fdetail { padding:2px 14px 14px 27px; background:#fafbfa }",
  "  .cmp .nodetail { font-size:12px; color:var(--mut); line-height:1.5; padding:10px 0; max-width:62ch }",
  "  .cmp .dgrid { display:grid; gap:10px }",
  "  .cmp .dday { border:1px solid var(--line); border-radius:8px; background:#fff; overflow:hidden }",
  "  .cmp .dday h4 { margin:0; padding:7px 11px; font-size:11px; letter-spacing:.06em; text-transform:uppercase;",
  "            color:var(--mut); background:#f7f9f7; border-bottom:1px solid var(--hair);",
  "            display:flex; justify-content:space-between; gap:10px }",
  "  .cmp .dday h4 span { font-weight:650; letter-spacing:0; text-transform:none; color:var(--faint) }",
  "  .cmp .dm { display:grid; grid-template-columns:78px 54px 1fr auto; gap:10px; align-items:center;",
  "       padding:6px 11px; border-top:1px solid var(--hair); font-size:12.5px }",
  "  .cmp .dm:first-of-type { border-top:0 }",
  "  .cmp .dm .t { color:var(--mut) }",
  "  .cmp .dm .s { color:var(--faint) }",
  "  .cmp .dm .p { font-weight:650; text-align:right }",
  "  @media (max-width:560px){",
  "    .cmp .fdetail { padding-left:14px }",
  "    .cmp .dm { grid-template-columns:70px 48px 1fr auto; gap:8px; font-size:12px }",
  "  }",
  "",
  "  .cmp .foot { margin-top:16px; font-size:11.5px; color:var(--mut); line-height:1.5 }",
  "",
  "  @media (max-width:760px){",
  "    .cmp .rhead { display:none }",
  "    .cmp .frow { grid-template-columns:minmax(0,1fr) 128px; gap:6px 12px; padding:11px 14px }",
  "    .cmp .frow .md { display:none }",
  "    .cmp .frow .price { text-align:left; grid-column:1 }",
  "    .cmp .frow .fmts { grid-column:2; justify-content:flex-end }",
  "  }",
  "",
  "  /* ── NOT IN THE MOCK ──────────────────────────────────────────────────────────────────────",
  "     Five things this page has that the mock does not, styled from the mock's own tokens so they",
  "     do not introduce a second palette: the importer, the proposed-link box, the competitor's own",
  "     match count, the \"source not captured here\" banner, and the per-listing note. */",
  "  .cmp .notcaptured { margin:11px 14px; border:1px solid var(--ambline); background:var(--ambbg);",
  "              border-radius:9px; padding:10px 12px; font-size:12.5px; color:var(--amb) }",
  "  .cmp .theircount { font-size:11.5px; color:var(--mut); background:#fff; border:1px solid var(--line);",
  "              border-radius:8px; padding:8px 10px; margin:10px 0 2px; line-height:1.5 }",
  "  .cmp .linkbox { font-size:11.5px; color:var(--amb); background:var(--ambbg); border:1px solid var(--ambline);",
  "              border-radius:8px; padding:9px 11px; margin:10px 0 2px; line-height:1.5 }",
  "  .cmp .linkbox.done { color:var(--ok); background:var(--mint); border-color:#bfe0cc }",
  "  .cmp .linkbox.ruled { color:var(--mut); background:#f7f9f7; border-color:var(--line) }",
  "  .cmp .lbtns { display:flex; gap:7px; flex-wrap:wrap; margin-top:7px }",
  "  .cmp .linkbox button { font:inherit; font-size:11.5px; font-weight:700; min-height:32px; padding:0 11px;",
  "              border-radius:999px; border:1px solid var(--grn); background:var(--grn); color:#fff; cursor:pointer }",
  "  .cmp .linkbox button.no { background:#fff; color:var(--ink); border-color:var(--line) }",
  "  .cmp .dm .note { grid-column:1 / -1; font-size:11px; color:var(--faint); margin-top:-2px }",
  "  .cmp .dm .t.none { font-style:italic; color:var(--faint) }",
  "  .cmp .dm .p.none { font-style:italic; font-weight:400; color:var(--faint) }",
  "  .cmp .importer { margin-top:14px; border:1px solid var(--line); background:#fff; border-radius:11px; padding:13px }",
  "  .cmp .ihead { font-size:13px; font-weight:800 }",
  "  .cmp .ihint { margin:4px 0 9px; font-size:11.5px; color:var(--mut); line-height:1.5 }",
  "  .cmp .importer textarea { width:100%; margin-top:8px; border:1px solid var(--line); border-radius:8px;",
  "              padding:8px; font:12px/1.5 ui-monospace,monospace; background:#fff; color:var(--ink) }",
  "  .cmp .ibtns { display:flex; gap:8px; margin-top:9px }",
  "  .cmp .ibtns button { font:inherit; font-size:12px; font-weight:700; min-height:32px; padding:0 13px;",
  "              border-radius:999px; border:1px solid var(--line); background:#fff; color:var(--ink); cursor:pointer }",
  "  .cmp .ibtns button.go { background:var(--grn); color:#fff; border-color:var(--grn) }",
  "  .cmp .ibtns button:disabled { opacity:.45 }",
  "  .cmp .imsg { margin-top:9px; font-size:12px; color:var(--ok) }",
  "  .cmp .imsg.bad { color:#a8391a }",
  "  .cmp .imsg ul { margin:5px 0 0; padding-left:18px }",
  "  .cmp .iplan { margin-top:9px; font-size:12px; color:var(--mut); line-height:1.6 }",
  "  .cmp .iplan i { font-style:normal; color:var(--amb) }",
  "",
].join("\n");
