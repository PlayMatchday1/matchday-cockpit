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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  formats: string[]; our_venue_id: number | null;
};
type CMatch = {
  id: number; supply_id: number; match_date: string; kickoff_local: string;
  format: string; spots: number; price_cents: number | null;
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

const SOURCE_LABEL: Record<string, string> = { plei: "Plei", goodrec: "GoodRec" };
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

  const acceptLink = useCallback(async (supplyId: number, venueId: number | null) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const res = await fetch("/api/growth/competitors", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ acceptLink: { supplyId, venueId } }),
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
    <div className="mx-auto max-w-[1180px] px-4 pb-16">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="mb-2 pt-4 text-[10.5px] font-extrabold uppercase tracking-[0.1em] text-deep-green/45">
        Growth · Competitors
      </div>
      <h1 className="m-0 text-[26px] font-black uppercase tracking-[-0.03em]">Competitors</h1>
      <p className="mt-1.5 max-w-[680px] text-[13px] text-deep-green/65">
        Bookable supply captured by hand from Plei and GoodRec, next to our own over the same week.
      </p>

      {!data.tableReady && (
        <div className="mt-3 rounded-[11px] border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
          <b>The competitor tables are not in the database yet.</b> Apply migration 0179. Nothing is shown
          until then, which is not the same as nothing having been captured.
        </div>
      )}

      {/* ── COVERAGE, BEFORE ANY ROW ──────────────────────────────────────────────────────────
          ABSENCE IS NOT EVIDENCE. A city missing from this page has not been looked at; it does
          not mean the competitor is absent there. This codebase has paid for that lesson twice in
          Warsaw and it is written up in docs/matchday-api-facts.md. */}
      <div className="coverage mt-3.5" data-testid="coverage">
        <b>{data.capturedOurCities.length} of {data.ourCities.length} MatchDay cities</b> have been captured.
        {uncaptured.length > 0 && (
          <> Not captured: <b>{uncaptured.join(", ")}</b>. A city that is not here <b>has not been looked at</b>,
          which is not the same as a competitor being absent from it.</>
        )}
      </div>

      {/* ── THE CONTROLS ──────────────────────────────────────────────────────────────────── */}
      <div className="sw mt-3.5" data-testid="srcbar">
        {(["both", "plei", "goodrec"] as const).map((s) => (
          <button key={s} type="button" data-s={s} aria-pressed={src === s} onClick={() => setSrc(s)}>
            {s === "both" ? "Both" : SOURCE_LABEL[s]}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="imp" data-testid="import-open" onClick={() => setImportOpen((v) => !v)}>
          {importOpen ? "Close importer" : "Import a capture"}
        </button>
      </div>

      {allFormats.length > 0 && (
        <div className="fbar" data-testid="fbar">
          <span className="flab">Format</span>
          {allFormats.map((f) => (
            <button key={f} type="button" data-testid="fbtn" data-fmt={f} aria-pressed={fmts.includes(f)}
              onClick={() => setFmts((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]))}>
              {f}
            </button>
          ))}
          {fmts.length > 0 && (
            <button type="button" className="fclear" data-testid="fclear" onClick={() => setFmts([])}>Clear</button>
          )}
        </div>
      )}

      {/* THE FILTER NARROWS THE LIST AND NOTHING ELSE, and the page says so while it is on. The
          capture records spots per FACILITY, not per format, so a total recomputed under a format
          filter would be a number the data cannot support. */}
      {fmts.length > 0 && (
        <div className="fnote" data-testid="fnote">
          Showing facilities that offer {fmts.join(" or ")}. The city totals, the MD Standard and the share
          <b> still cover every format</b>, because the capture records <b>spots per facility, not per format</b>.
        </div>
      )}

      {importOpen && <Importer onDone={() => { setImportOpen(false); void load(); }} />}

      {cities.length === 0 && data.tableReady && (
        <div className="mt-5 rounded-[11px] border border-cream-line bg-white p-4 text-[13px] text-deep-green/60">
          Nothing has been captured yet. Use <b>Import a capture</b> above.
        </div>
      )}

      {cities.map(({ label, caps }) => (
        <CityPanel key={label} label={label} caps={caps} data={data} src={src} fmts={fmts}
          open={open} toggle={toggle} onLink={acceptLink} />
      ))}
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
  onLink: (supplyId: number, venueId: number | null) => void | Promise<void>;
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
      theirMatchCount: null, proposal: null,
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

  /* A PERCENTAGE ONLY WHERE THE WINDOWS ACTUALLY ALIGN. Our side is measured over the primary
   * capture's window, so that is what each source's window is compared against. Decided by
   * comparison, never by city: a future capture that lines up starts showing a percentage on its
   * own and nothing here needs changing. */
  const align = useMemo(
    () => windowsAlign(
      { start: primary?.window_start ?? "", end: primary?.window_end ?? "" },
      shown.map((c): WindowSpec => ({
        source: SOURCE_LABEL[c.source] ?? c.source,
        start: c.window_start, end: c.window_end, note: c.window_note,
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
    <section className="city mt-5" data-testid="city" data-city={label}>
      <div className="chead">
        <h2 className="m-0 text-[17px] font-[850]">{label}</h2>
        <span className="window" data-testid="window">
          {(notCaptured ? [] : shown).map((c) => (
            <span key={c.id} className="wpill">
              <b>{SOURCE_LABEL[c.source] ?? c.source}</b> {fmtWindow(c.window_start, c.window_end)}
              {c.window_note ? <i> · {c.window_note}</i> : null}
            </span>
          ))}
        </span>
      </div>

      {notCaptured && (
        <div className="notcaptured" data-testid="notcaptured">
          <b>{SOURCE_LABEL[src] ?? src} has not been captured in {label}.</b> That is not the same as
          {" "}{SOURCE_LABEL[src] ?? src} selling nothing here. Our own fields are still listed below.
        </div>
      )}

      {!notCaptured && <div className="stats">
        <div className="stat"><span className="k">Competing facilities</span>
          <span className="n" data-testid="s-fac">{theirRowsAll.length}</span></div>
        <div className="stat"><span className="k">Their spots a week</span>
          <span className="n"><span data-testid="s-spots">{commas(totalSpots)}</span>
            <i> · {fmtMdStandard(totalSpots)} MD Standard</i></span></div>
        <div className="stat"><span className="k">Median price per player</span>
          <span className="n" data-testid="s-median">{median == null ? "not shown" : money(median)}</span></div>
        <div className="stat"><span className="k">Cheaper than us</span>
          <span className="n" data-testid="s-under">{under}</span>
          <i className="sub">{ourFloor == null ? "we publish no price this week" : `our floor is ${money(ourFloor)}`}</i></div>
      </div>}

      {/* ── THE SHARE ──────────────────────────────────────────────────────────────────────── */}
      {!notCaptured && <div className="share" data-testid="share">
        <div className="sharehead">
          <span>MatchDay share of bookable supply</span>
          {align.aligned
            ? <b data-testid="sharepct">MatchDay holds {sharePct}%</b>
            /* NO NUMBER WITH A FOOTNOTE. Where the windows do not line up the ratio is not printed
               at all, because a figure that needs its caveat to be true is a figure that will be
               screenshotted without it. The two sides' absolutes are still here and still true. */
            : <b className="noshare" data-testid="nosharepct">
                The windows do not line up, so there is no percentage to give
              </b>}
          <i data-testid="sharewindow">
            {primary ? `ours: ${fmtWindow(primary.window_start, primary.window_end)}` : ""}
          </i>
        </div>
        {!align.aligned && (
          <ul className="whynot" data-testid="sharewhy">
            {align.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        <div className="bar">
          <span className="seg us" data-testid="seg-us"
            style={{ width: `${pct(oursMd, oursMd + theirMd)}%` }} title={`MatchDay ${oursMd.toFixed(1)}`} />
          {shown.map((c) => {
            const s = data.supply.filter((x) => x.capture_id === c.id).reduce((a, b) => a + b.bookable_spots_per_week, 0);
            return <span key={c.id} className={`seg ${c.source}`} data-testid={`seg-${c.source}`}
              style={{ width: `${pct(mdStandard(s), oursMd + theirMd)}%` }}
              title={`${SOURCE_LABEL[c.source]} ${fmtMdStandard(s)}`} />;
          })}
        </div>
        <div className="legend">
          <span><i className="sw us" /> MatchDay {oursMd.toFixed(1)}</span>
          {shown.map((c) => {
            const s = data.supply.filter((x) => x.capture_id === c.id).reduce((a, b) => a + b.bookable_spots_per_week, 0);
            return <span key={c.id}><i className={`sw ${c.source}`} /> {SOURCE_LABEL[c.source]} {fmtMdStandard(s)}</span>;
          })}
          <span className="mdnote">MD Standard is bookable spots ÷ 18, one MatchDay match</span>
        </div>
      </div>}

      {/* ── THE ROWS ───────────────────────────────────────────────────────────────────────── */}
      <div className="rhead">
        <span>Facility</span><span>Spots a week</span><span className="r">MD Std</span><span className="r">Price per player</span>
      </div>
      {rows.map((r) => (
        <FacilityRow key={r.key} r={r} maxSpots={maxSpots} ourFloor={ourFloor}
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
function FacilityRow({ r, maxSpots, ourFloor, matches, isOpen, onToggle, onLink }: {
  r: Row; maxSpots: number; ourFloor: number | null; matches: CMatch[];
  isOpen: boolean; onToggle: () => void;
  onLink: (supplyId: number, venueId: number | null) => void | Promise<void>;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const price = fmtPrice({ lowCents: r.lowCents, highCents: r.highCents });
  const cheaper = !r.isOurs && undercutsUs({ lowCents: r.lowCents, highCents: r.highCents }, ourFloor);
  /* ── THEY ARE BOOKING OUR FIELDS ──────────────────────────────────────────────────────────
   * Two states, and the difference is the whole point. CONFIRMED is our_venue_id, set by a person.
   * PROPOSED is a name match nobody has ruled on yet, and it says so, because "Athlete Training &
   * Health | Cypress" and "Athlete Training and Health | Katy" differ by one word and are
   * different places. Our own row never claims to also be our field. */
  const confirmed = !r.isOurs && r.ourVenueId != null;
  const proposed = !r.isOurs && r.ourVenueId == null && r.proposal?.venueId != null;

  const byDay = useMemo(() => {
    const m = new Map<string, CMatch[]>();
    for (const x of matches) {
      const d = dowOf(x.match_date);
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(x);
    }
    for (const list of m.values()) list.sort((a, b) => a.kickoff_local.localeCompare(b.kickoff_local));
    return DOW.filter((d) => m.has(d)).map((d) => ({ day: d, list: m.get(d)! }));
  }, [matches]);

  return (
    <div className="wrap" data-testid="wrap" data-fac={r.facility}>
      <button ref={btn} type="button" className={`frow${r.isOurs ? " ours" : ""}`} data-testid="row"
        data-fac={r.facility} data-src={r.isOurs ? "us" : r.source} aria-expanded={isOpen} onClick={onToggle}>
        <span className="fname">
          <i className={`chev${isOpen ? " o" : ""}`} aria-hidden>›</i>
          <span className="n">{r.facility}</span>
          {r.isOurs && <span className="tag mine">ours</span>}
          {confirmed && <span className="tag theirs" data-testid="ours">on our field</span>}
          {proposed && <span className="tag maybe" data-testid="maybe-ours">looks like our field</span>}
          <span className="chips">
            {r.formats.map((f) => <span key={f} className="fchip">{f}</span>)}
          </span>
        </span>
        <span className="fspots">
          <span className="track"><span className="fill" style={{ width: `${Math.max(2, (r.spots / maxSpots) * 100)}%` }} /></span>
          <span className="sn" data-testid="spots">{commas(r.spots)}</span>
        </span>
        <span className="r mdstd" data-testid="mdstd">{fmtMdStandard(r.spots)}</span>
        <span className="r fprice">
          {price.shown
            ? <span data-testid="price">{price.text}</span>
            : <i data-testid="noprice" className="noprice">not shown</i>}
          {cheaper && <i className="under" data-testid="under">under us</i>}
        </span>
      </button>

      {isOpen && (
        <div className="detail" data-testid="detail" data-fac={r.facility}>
          {(proposed || confirmed) && (
            <div className={`linkbox${confirmed ? " done" : ""}`} data-testid="linkbox">
              {confirmed ? (
                <>
                  <b>This is our field.</b> Confirmed link to venue {r.ourVenueId}.
                  <button type="button" data-testid="unlink" onClick={(e) => { e.stopPropagation(); void onLink(r.supplyId!, null); }}>
                    Not ours, clear it
                  </button>
                </>
              ) : (
                <>
                  <b>This looks like our {r.proposal!.venueName}.</b>{" "}
                  Matched on <i>{r.proposal!.via}</i> because it {r.proposal!.why}.
                  Nothing is linked until you say so.
                  <button type="button" data-testid="accept-link" onClick={(e) => { e.stopPropagation(); void onLink(r.supplyId!, r.proposal!.venueId!); }}>
                    Yes, this is our field
                  </button>
                </>
              )}
            </div>
          )}
          {/* ── THEIR OWN MATCH COUNT, HERE AND NOT ON THE ROW ─────────────────────────────────
              It is what the competitor's app reported, and it does not reconcile with the formats:
              Memorial Indoor Soccer lists 2 matches against 70 spots at 5v5, which is 35 players a
              match where the format implies 10. Spots is what was actually counted, so spots orders
              the rows and MD Standard is the match figure on screen. This number is kept because it
              was captured, and it sits here because here it can carry its caveat. */}
          {r.theirMatchCount != null && (
            <div className="theircount" data-testid="theircount">
              <b>{SOURCE_LABEL[r.source] ?? r.source} lists {r.theirMatchCount} match{r.theirMatchCount === 1 ? "" : "es"} a week</b> here.
              That is their own count and it does not reconcile with the formats, so the page orders and
              totals on <b>spots</b> instead. {fmtMdStandard(r.spots)} MD Standard is the same supply in our unit.
            </div>
          )}
          {byDay.length === 0 ? (
            /* THE EMPTY STATE IS THE COMMON ONE AND IT MUST SAY WHY. The September capture recorded
               weekly totals only, so most facilities have no match log. An empty panel would read
               as "no matches this week", which is false. */
            <div className="nodetail" data-testid="nodetail">
              The match log was <b>not captured for this facility</b>. This capture recorded
              <b> weekly totals only</b>, so this is not a week with no matches. A capture that includes
              a match log fills this in.
            </div>
          ) : byDay.map(({ day, list }) => {
            const spots = list.reduce((a, b) => a + b.spots, 0);
            const prices = list.map((m) => m.price_cents).filter((x): x is number => x != null);
            const lo = prices.length ? Math.min(...prices) : null;
            const hi = prices.length ? Math.max(...prices) : null;
            return (
              <div className="day" key={day} data-testid="day" data-day={day}>
                <div className="dhead">
                  <b>{day}</b>
                  <span data-testid="daysum">
                    {list.length} match{list.length === 1 ? "" : "es"} · {spots} spots
                    {lo != null ? ` · ${lo === hi ? money(lo) : `${money(lo)} to ${money(hi as number)}`}` : ""}
                  </span>
                </div>
                {list.map((m) => (
                  <div className="match" key={m.id} data-testid="match">
                    <span>{fmtTime(m.kickoff_local)}</span>
                    <span>{m.format}</span>
                    <span>{m.spots} spots</span>
                    <span className="r">{m.price_cents == null ? "not shown" : money(m.price_cents)}</span>
                  </div>
                ))}
              </div>
            );
          })}
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

/* ── THE GRID ─────────────────────────────────────────────────────────────────────────────────
 * FIXED TRACKS. minmax(0,1fr) on the name column and fixed widths on the numbers, so a long
 * facility name wraps or ellipses inside its own track and cannot widen the row. This is the
 * whole reason the page is not a table. No backtick may appear in this string, comments included. */
const CSS = [
  ".coverage{border:1px solid #e6ebe8;background:#fbfdfc;border-radius:11px;padding:10px 13px;font-size:12.5px;color:#4d6359;line-height:1.5}",
  ".sw{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:2px}",
  ".sw .grow{flex:1}",
  ".sw button{min-height:32px;padding:0 12px;border:1px solid #e6ebe8;background:#fff;border-radius:8px;font:700 12px/1 inherit;color:#46584f;cursor:pointer}",
  ".sw button[aria-pressed=true]{background:#0E2A22;color:#fff;border-color:#0E2A22}",
  ".sw button.imp{border-style:dashed;color:#12704a}",
  ".fbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}",
  ".fbar .flab{font:800 10px/1 inherit;letter-spacing:.09em;text-transform:uppercase;color:#8a9992;margin-right:2px}",
  ".fbar button{min-height:32px;padding:0 11px;border:1px solid #e6ebe8;background:#fff;border-radius:999px;font:700 12px/1 inherit;color:#46584f;cursor:pointer}",
  ".fbar button[aria-pressed=true]{background:#E6F4EB;border-color:#bfe0cc;color:#12704a}",
  ".fbar .fclear{border-style:dashed;color:#a8391a}",
  ".fnote{margin-top:8px;border:1px solid #e3c369;background:#fdf1d0;color:#8a6300;border-radius:9px;padding:8px 11px;font-size:12px;line-height:1.5}",
  ".city{border:1px solid #e6ebe8;border-radius:14px;background:#fff;padding:14px;overflow:hidden}",
  ".chead{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-bottom:10px}",
  ".window{display:flex;flex-wrap:wrap;gap:6px;font-size:11.5px;color:#4d6359}",
  ".wpill{border:1px solid #e6ebe8;background:#f7faf8;border-radius:7px;padding:3px 8px}",
  ".wpill i{font-style:normal;color:#8a6300}",
  ".stats{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:10px}",
  ".stat{border:1px solid #e6ebe8;border-radius:10px;padding:8px 10px;min-width:0}",
  ".stat .k{display:block;font:800 9.5px/1.3 inherit;letter-spacing:.08em;text-transform:uppercase;color:#8a9992}",
  ".stat .n{display:block;margin-top:3px;font:800 17px/1.2 inherit;color:#0E2A22;overflow:hidden;text-overflow:ellipsis}",
  ".stat .n i{font-style:normal;font-size:11px;font-weight:700;color:#8a9992}",
  ".stat .sub{display:block;font-style:normal;font-size:10.5px;color:#8a9992;margin-top:1px}",
  ".share{border:1px solid #e6ebe8;border-radius:10px;padding:9px 11px;margin-bottom:12px;overflow:hidden}",
  ".sharehead{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:11.5px;color:#4d6359}",
  ".sharehead b{font-size:16px;color:#0E2A22}",
  ".sharehead i{font-style:normal;color:#8a9992;font-size:11px}",
  ".bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:#eef2f0;margin-top:7px}",
  ".seg{display:block;height:100%}",
  ".seg.us{background:#0d3b2e}.seg.plei{background:#e6a532}.seg.goodrec{background:#7aa6c2}",
  ".legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:11px;color:#4d6359}",
  ".legend .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}",
  ".legend .mdnote{color:#8a9992}",
  ".sharehead b.noshare{font:800 12px/1.4 inherit;color:#8a6300;max-width:100%}",
  ".whynot{margin:6px 0 0;padding-left:17px;font-size:11px;color:#8a6300;line-height:1.6}",
  ".notcaptured{font-size:12px;color:#8a6300;background:#fdf1d0;border:1px solid #e3c369;border-radius:9px;padding:9px 11px;margin-bottom:10px;line-height:1.5}",
  ".theircount{font-size:11.5px;color:#4d6359;background:#f7faf8;border:1px solid #e6ebe8;border-radius:8px;padding:7px 9px;margin-bottom:8px;line-height:1.5}",
  ".rhead,.frow{display:grid;grid-template-columns:minmax(0,1fr) 128px 62px 132px;gap:10px;align-items:center}",
  ".rhead{font:800 9.5px/1 inherit;letter-spacing:.08em;text-transform:uppercase;color:#8a9992;padding:0 8px 6px}",
  ".rhead .r,.frow .r{text-align:right}",
  ".wrap{border-top:1px solid #f1f5f3}",
  ".frow{width:100%;text-align:left;background:#fff;border:0;border-left:3px solid transparent;padding:8px;cursor:pointer;font:inherit;min-height:44px}",
  ".frow:hover{background:#fbfdfc}",
  ".frow.ours{background:#f4faf6;border-left-color:#2fb673}",
  ".fname{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}",
  ".fname .n{font:700 12.5px/1.3 inherit;color:#0E2A22;min-width:120px;overflow:hidden;text-overflow:ellipsis}",
  ".chev{font-style:normal;color:#8a9992;transition:transform .12s;display:inline-block;flex:none}",
  ".chev.o{transform:rotate(90deg)}",
  ".tag{border-radius:5px;padding:1px 5px;font:800 9px/1.6 inherit;white-space:nowrap}",
  ".tag.mine{background:#E6F4EB;color:#12704a}",
  ".tag.theirs{background:#fdeae4;color:#a8391a;border:1px solid #f0bda9}",
  ".tag.maybe{background:#fdf1d0;color:#8a6300;border:1px dashed #e3c369}",
  ".linkbox{font-size:11.5px;color:#8a6300;background:#fdf1d0;border:1px solid #e3c369;border-radius:8px;padding:8px 10px;margin-bottom:8px;line-height:1.5}",
  ".linkbox.done{color:#a8391a;background:#fdeae4;border-color:#f0bda9}",
  ".linkbox i{font-style:italic}",
  ".linkbox button{display:block;margin-top:6px;min-height:32px;padding:0 11px;border:1px solid #0d3b2e;background:#0d3b2e;color:#fff;border-radius:8px;font:700 11.5px/1 inherit;cursor:pointer}",
  ".chips{display:flex;gap:3px;flex-wrap:wrap;min-width:0}",
  ".fchip{border:1px solid #e6ebe8;background:#f7faf8;border-radius:4px;padding:0 4px;font:700 9px/1.7 inherit;color:#4d6359}",
  ".fspots{display:flex;align-items:center;gap:7px;min-width:0}",
  ".track{flex:1;min-width:0;height:8px;background:#eef2f0;border-radius:4px;overflow:hidden}",
  ".fill{display:block;height:100%;background:#9fcbb4;border-radius:4px}",
  ".frow.ours .fill{background:#2fb673}",
  ".sn{font:700 11.5px/1 inherit;color:#4d6359;width:42px;text-align:right;flex:none}",
  ".mdstd{font:700 11.5px/1 inherit;color:#4d6359}",
  ".fprice{font:700 12px/1.3 inherit;color:#0E2A22;min-width:0;overflow:hidden}",
  ".fprice .noprice{font-style:italic;font-weight:500;color:#8a9992}",
  ".fprice .under{display:block;font-style:normal;font-size:10px;font-weight:800;color:#a8391a}",
  ".detail{background:#fbfdfc;border-top:1px solid #f1f5f3;padding:8px 10px 10px 22px}",
  ".nodetail{font-size:11.5px;color:#8a6300;background:#fdf1d0;border:1px solid #e3c369;border-radius:8px;padding:8px 10px;line-height:1.5}",
  ".day{margin-bottom:8px}",
  ".dhead{display:flex;gap:8px;align-items:baseline;font-size:11px;color:#8a9992;border-bottom:1px solid #eef2f0;padding-bottom:3px}",
  ".dhead b{font-size:12px;color:#0E2A22}",
  ".match{display:grid;grid-template-columns:86px 56px 74px minmax(0,1fr);gap:8px;font-size:11.5px;color:#4d6359;padding:3px 0}",
  ".match .r{text-align:right}",
  ".importer{border:1px solid #bfe0cc;background:#f6fbf8;border-radius:12px;padding:12px;margin-top:10px}",
  ".ihead{font:800 13px/1 inherit;color:#0E2A22;margin-bottom:5px}",
  ".ihint{font-size:11.5px;color:#4d6359;line-height:1.5;margin:0 0 8px}",
  ".importer textarea{width:100%;margin-top:8px;border:1px solid #e6ebe8;border-radius:8px;padding:8px;font:12px/1.5 ui-monospace,monospace;background:#fff}",
  ".ibtns{display:flex;gap:8px;margin-top:8px}",
  ".ibtns button{min-height:32px;padding:0 13px;border:1px solid #e6ebe8;background:#fff;border-radius:8px;font:700 12px/1 inherit;cursor:pointer}",
  ".ibtns button.go{background:#0d3b2e;color:#fff;border-color:#0d3b2e}",
  ".ibtns button:disabled{opacity:.45}",
  ".imsg{margin-top:8px;font-size:12px;color:#12704a}",
  ".imsg.bad{color:#a8391a}",
  ".imsg ul{margin:5px 0 0;padding-left:18px}",
  ".iplan{margin-top:8px;font-size:12px;color:#4d6359;line-height:1.6}",
  ".iplan i{color:#8a6300;font-style:normal}",
  "@media (max-width:700px){",
  "  .rhead{display:none}",
  "  .frow{grid-template-columns:minmax(0,1fr) 62px;grid-auto-rows:auto;row-gap:4px}",
  "  .fname{grid-column:1 / -1}",
  "  .fspots{grid-column:1}",
  "  .frow .r.fprice{grid-column:1 / -1;text-align:left}",
  "  .match{grid-template-columns:76px 50px 64px minmax(0,1fr)}",
  "}",
].join("\n");
