// PostgREST (the layer Supabase puts in front of Postgres) caps every
// response at `max-rows` regardless of what the client asks for. On
// Supabase projects that ceiling defaults to 1000. A bare
// `supabase.from(t).select("*")` therefore silently truncates to the first
// 1000 rows, and even `.range(0, 99999)` returns at most 1000 — `.limit()`
// and `.range()` are bounded by `max-rows` server-side. The only
// portable workaround is to issue successive 1000-row windowed reads and
// concatenate them, which is what `selectAll` does.
//
// Use this helper for any table whose row count could plausibly exceed
// 1000 over the lifetime of the project. Single-row reads
// (`.limit(1).maybeSingle()`) and bounded admin tables (venues, aliases,
// org groups) can keep using a bare `.select(...)` — but err on the side
// of paginating; the cost when the table is small is one extra HTTP
// round-trip that returns 0 rows.
//
// REQUIRED: callers MUST include a stable `.order(<unique column>)` on
// the returned builder. Without ORDER BY, Postgres is free to return
// rows in any order across queries — pagination then silently drops or
// duplicates rows because `.range(0,999)` and `.range(1000,1999)` see
// inconsistent row positions. Use `.order("id")` for tables with an
// integer PK; use a (non-unique-col, "id") tiebreaker pair if a display
// order matters. The total returned count can match the true row count
// even when individual rows are missing — there's no silent failure
// signal, so this is an easy bug to ship.

type RangedResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

type RangeableBuilder<T> = {
  range: (from: number, to: number) => PromiseLike<RangedResult<T>>;
};

const PAGE = 1000;

export async function selectAll<T>(
  makeBuilder: () => RangeableBuilder<T>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeBuilder().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ── COUNT-THEN-FAN-OUT ─────────────────────────────────────────────────────
//
// selectAll above is SEQUENTIAL: it cannot know how many pages there are, so
// it walks until a short page tells it to stop. That is correct and it is
// fine for the windowed reads, but it does not scale to a whole-table pull —
// measured on mdapi_match_players (231,748 rows, 232 pages): 63.7s
// sequential, 15.0s fanned out eight at a time. The Match panel's
// load-all-history action is the caller that needs the second number.
//
// Ask for the count first, derive every page offset from it, then run them
// through a worker pool. Same PAGE size, same required stable ORDER BY —
// see the header above, and note the requirement is STRICTER here: sequential
// paging re-reads from a moving offset and merely skews, whereas fixed
// offsets computed up front assume the row positions hold for the whole run.
//
// WHAT A CONCURRENT WRITE DOES TO THIS, stated rather than hidden. Offsets
// are computed once. An INSERT during the run lands past the last offset on
// an ascending key, so it is simply not in the snapshot. A soft-delete
// (deleted_at, which every caller filters on) REMOVES a row from the filtered
// set mid-run and shifts every later offset down by one, so a row can be
// skipped. This is the same hazard the promocodes pager carries and it is
// acceptable for exactly the same reason: these are read-only browse
// surfaces, not a basis for a write. Do NOT use this helper to build a diff,
// a reconciliation, or anything a write is derived from.
export async function selectAllParallel<T>(
  makeBuilder: () => RangeableBuilder<T>,
  countRows: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
  concurrency = 8,
): Promise<T[]> {
  const { count, error } = await countRows();
  if (error) throw new Error(error.message);
  // No count means the head request was served but PostgREST declined to
  // count. Fall back rather than guessing a page list from nothing.
  if (count == null) return selectAll(makeBuilder);
  if (count === 0) return [];

  const offsets: number[] = [];
  for (let from = 0; from < count; from += PAGE) offsets.push(from);

  const pages: T[][] = new Array(offsets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= offsets.length) return;
      const { data, error: e } = await makeBuilder().range(offsets[i], offsets[i] + PAGE - 1);
      if (e) throw new Error(e.message);
      pages[i] = data ?? [];
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, offsets.length) }, () => worker()),
  );
  // Concatenate IN OFFSET ORDER, not completion order — the caller's
  // .order() is a promise about the sequence and the pool finishes ragged.
  return pages.flat();
}
