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
