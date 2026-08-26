// GET /api/applications — the Applications page's one read.
//
// PII. Real names, emails and phones for 158 people who filled in a form on playmatchday.com.
// Handled like player data:
//   · CITY MANAGERS ARE REFUSED AT THIS ROUTE, on the identity from the database — never by
//     hiding a filter in the UI. A city code is a string; hiding a chip is a shorter menu, not a
//     boundary. A confined account asking for another city gets 403, and its default scope is its
//     own city rather than "everything".
//   · NOTHING GOES INTO change_log. That table is the audit of writes that reach the MatchDay API;
//     outreach state is Clubhouse's own scratch data and would bury the writes that reach players.
//   · NO EMAIL AND NO PHONE IN ANY LOG LINE, error message or thrown exception. The only
//     identifier that may appear in a diagnostic here is the submission id.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { assertScope } from "@/lib/cityConfinement";
import { makeServerClient } from "@/lib/supabaseServer";
import { buildPeople, buildTiles, CITY_NAMES, type SubmissionRow, type ContactRow } from "@/lib/applicationsModel";
import { PINNED_FORMS, type FormLabels, type Stream } from "@/lib/webSubmissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** PINNED_FORMS merged with whatever the CSV import stored. Pinned wins: those two are the pair
 *  whose collision is asserted in the suite, and a CSV row must not quietly redefine them. */
async function loadRegistry(sb: ReturnType<typeof makeServerClient>): Promise<Record<string, FormLabels>> {
  const { data, error } = await sb.from("web_form_labels").select("element_id,field_id,label,form_name,source");
  const out: Record<string, FormLabels> = {};
  if (!error) {
    for (const r of data ?? []) {
      const el = String(r.element_id);
      const cur = out[el] ?? {
        elementId: el, formName: String(r.form_name ?? ""), source: (r.source as "csv" | "forms-api") ?? "csv",
        labels: {} as Record<string, string>,
      };
      (cur.labels as Record<string, string>)[String(r.field_id)] = String(r.label);
      out[el] = cur;
    }
  }
  // Pre-migration or empty table simply yields the pinned pair — correct, not a crash.
  return { ...out, ...PINNED_FORMS };
}

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const streamRaw = url.searchParams.get("stream");
  const stream: Stream = streamRaw === "partner" ? "partner" : "team";

  /* THE BOUNDARY. assertScope REFUSES a confined account naming another city rather than silently
   * re-pointing it — the same rule the player finder learned the hard way. A confined account that
   * names nothing is scoped to its own city; it is not shown the estate. */
  const askedCity = url.searchParams.get("city");
  const scopeCheck = assertScope(auth.confinedCity, askedCity === "all" ? null : askedCity, auth.confinedCity !== null);
  if (!scopeCheck.ok) return Response.json({ error: scopeCheck.error }, { status: scopeCheck.status });
  const scopeCity = auth.confinedCity ?? (askedCity && askedCity !== "all" ? askedCity : null);

  const sb = makeServerClient();
  try {
    const registry = await loadRegistry(sb);

    const rows: SubmissionRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb
        .from("web_submissions")
        .select("submission_id,element_id,form_name,created_at,fields,stream,is_spam,city_code")
        .eq("stream", stream)
        .order("submission_id")
        .range(off, off + 999);
      if (error) throw new Error(`web_submissions read failed: ${error.message}`);
      rows.push(...((data ?? []) as unknown as SubmissionRow[]));
      if ((data ?? []).length < 1000) break;
    }

    const { data: cRows, error: cErr } = await sb.from("web_contacts").select("stream,email,status,owner,notes").eq("stream", stream);
    if (cErr) throw new Error(`web_contacts read failed: ${cErr.message}`);

    const all = buildPeople(rows, (cRows ?? []) as ContactRow[], registry);
    // SPAM IS QUARANTINED, NOT DELETED — hidden by default, counted, and viewable on request.
    const showSpam = url.searchParams.get("spam") === "1";
    const live = all.filter((p) => showSpam ? p.spam : !p.spam);
    const spamSenders = all.filter((p) => p.spam).length;
    // ROWS, not people — the tile counts submissions and says so. 437 rows from 24 addresses.
    const spamSubmissions = rows.filter((r) => (r as unknown as { is_spam?: boolean }).is_spam === true).length;

    /* CONFINEMENT APPLIES AFTER SHAPING AND BEFORE ANYTHING IS RETURNED. A person with NO city
     * cannot be proved in scope, so a confined account does not see them — the safe direction,
     * and the same deny-by-default assertMatchInScope takes. */
    const scoped = scopeCity ? live.filter((p) => p.cityCode === scopeCity) : live;

    return Response.json({
      stream,
      people: scoped,
      tiles: buildTiles(scoped, stream, Date.now(), { submissions: rows.length, spamSubmissions, spamSenders }),
      cityNames: CITY_NAMES,
      spamCount: spamSenders,
      spamSubmissions,
      showingSpam: showSpam,
      scope: scopeCity,
      confined: !!auth.confinedCity,
      // How many submissions are behind the list, so "115 people" and "172 rows" both appear and
      // neither has to be inferred from the other.
      rawSubmissions: rows.length,
      /* BY element_id, NOT JUST A COUNT — and it is on the page, not only in the sync log.
       * Editing an Elementor form can MINT A NEW FORM ID; that is how five Team Application forms
       * and four dead ones came to exist. When it happens, new submissions arrive under an unseen
       * id and resolve to nothing, and they keep arriving — which looks like a quiet week rather
       * than a broken pipe. Someone has to be able to see it without opening a log, and they have
       * to be able to name the form when they go and look. */
      unresolvedByElement: rows.reduce<Record<string, number>>((acc, r) => {
        const el = String(r.element_id);
        if (!registry[el]) acc[el] = (acc[el] ?? 0) + 1;
        return acc;
      }, {}),
      unresolvedSubmissions: rows.filter((r) => !registry[String(r.element_id)]).length,
    });
  } catch (e) {
    // NEVER the row's contents. A submission id is the most that may appear here.
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg.slice(0, 200) }, { status: 500 });
  }
}
