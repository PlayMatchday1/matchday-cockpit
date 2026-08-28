/* FIELDS — the pure model behind /match-ops/fields.
 *
 * Every rule here was measured against the MatchDay API on 2026-08-28, on STAGING for writes and
 * production for reads. The evidence is in docs/matchday-api-facts.md; the short version is in the
 * comments, because a rule you cannot see is a rule someone re-derives wrongly.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────────────────────────
 *   CREATE   POST /admin/fields         requires title + cityId AND NOTHING ELSE
 *   UPDATE   PUT  /admin/fields/{id}    PATCH is 404. PUT has PATCH semantics.
 *   DELETE   DELETE /admin/fields/{id}  SOFT, and it does not check for matches.
 *   READ     GET  /admin/fields         THERE IS NO SINGLE-FIELD GET. Read-back re-fetches
 *                                       the list and finds the id.
 */

/* ── FORMAT ────────────────────────────────────────────────────────────────────────────────────
 * recommendedPlayerCount IS A TOTAL, NOT A PER-SIDE NUMBER. A 9v9 pitch stores 18. This is the
 * same trap as maxTeamSize2Team / maxTeamSize4Team, and the mockup fell into it: its dropdown
 * carried 6/7/8/9/11 and rendered 9 as "9 × 9", which would have stored 9 — a 4½-a-side pitch —
 * on every 9v9 field in the network.
 *
 * THE LABEL CARRIES BOTH READINGS so nobody has to remember which one is stored. The value after
 * the dot is the value that goes on the wire.
 *
 * These five are every value in production: 14×3 fields, 16×8, 18×23, 20×1, 22×9. The 10v10 is a
 * single field and the 7v7s are three; a dropdown offering only 8/9/11 would silently rewrite
 * four fields the first time anyone opened and saved them. */
export const FORMATS: readonly { total: number; perSide: number; label: string }[] = [
  { total: 14, perSide: 7, label: "7 v 7 · 14 players" },
  { total: 16, perSide: 8, label: "8 v 8 · 16 players" },
  { total: 18, perSide: 9, label: "9 v 9 · 18 players" },
  { total: 20, perSide: 10, label: "10 v 10 · 20 players" },
  { total: 22, perSide: 11, label: "11 v 11 · 22 players" },
];

/** The number that goes on the wire for a chosen option. TOTAL, never per side. */
export const formatTotal = (perSide: number): number | null =>
  FORMATS.find((f) => f.perSide === perSide)?.total ?? null;

/** How a stored total reads. An unrecognised total is shown as itself rather than guessed at —
 *  the API is an integer column and nothing stops a 17 arriving. */
export function formatLabel(total: number | null | undefined): string {
  if (total == null) return "—";
  const f = FORMATS.find((x) => x.total === Number(total));
  return f ? f.label : `${total} players`;
}

/** The compact form for the list column. */
export function formatShort(total: number | null | undefined): string {
  if (total == null) return "—";
  const f = FORMATS.find((x) => x.total === Number(total));
  return f ? `${f.perSide} v ${f.perSide}` : `${total} total`;
}

/* ── THE READOUT ───────────────────────────────────────────────────────────────────────────────
 * IT IS A RECOMMENDATION, NOT A CAP, and it must not read like one. Measured on this month's
 * matches: 6 fields run every match at their recommendedPlayerCount and 23 DO NOT — field 1486
 * has rpc 22 and runs matches at 18, 20, 22, 28, 32 and 36. The match record's own maxPlayerCount
 * is authoritative; this number is the default a new match starts from.
 *
 * The mockup said "<b>36 spots</b>", which reads as the field's capacity. It is not. */
export function recommendationReadout(total: number | null, pitches: number): string {
  if (total == null) return "Pick a format — this sets the field's default, not a limit.";
  const f = FORMATS.find((x) => x.total === Number(total));
  const per = f ? `${f.perSide} v ${f.perSide}` : `${total} total`;
  const across = pitches > 1 ? ` across ${pitches} pitches` : "";
  return `Default ${total} players · ${per}${across} — each match sets its own count`;
}

/* PITCHES IS DISPLAY-ONLY. It shades the readout above and reaches nothing else. The Soccer
 * Central two-pitch rule (SOCC_TWO_PITCH_FIELD_IDS + the capacity threshold in
 * soccerCentralTwoPitch.ts) is deliberately NOT driven from here: that merge is Soccer Central
 * only by explicit ruling, and wiring a per-field selector into it would generalise a scoped rule
 * to the whole network as a side effect of someone editing a field. resolveSoccerCentral is
 * untouched by this page. */
export const PITCH_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: "1" },
  { value: 2, label: "2 — side by side" },
];

/* ── THE WRITE BODIES ──────────────────────────────────────────────────────────────────────────
 * THE CREATE DTO IS A STRICT WHITELIST. Sending a key outside it is a 400 naming the key
 * ("property orderPosition should not exist"), so an extra field does not get ignored — it kills
 * the whole create. Measured: orderPosition, images, cover, phoneNumbers, id, createdAt,
 * deletedAt and isEnabled are all refused. */
export const CREATE_KEYS = [
  "title", "cityId", "abbr", "address", "zipcode", "description", "parkingNote",
  "lat", "lng", "recommendedPlayerCount",
] as const;

/** UPDATE accepts the same set PLUS orderPosition, which create refuses. That asymmetry is the
 *  API's, not ours — it matches the two Retool modals exactly. */
export const UPDATE_KEYS = [...CREATE_KEYS, "orderPosition"] as const;

/** The server's own required set — TWO fields. Everything else is optional to the API; the extra
 *  requirements on the form are ours, for data quality, and are enforced separately. */
export const SERVER_REQUIRED = ["title", "cityId"] as const;

/** What the FORM insists on before it will let Save go. Broader than the server's two on purpose:
 *  a field with no address or format is a field somebody has to come back and fix. */
export const FORM_REQUIRED: readonly { key: string; label: string }[] = [
  { key: "title", label: "Field name" },
  { key: "cityId", label: "City" },
  { key: "abbr", label: "Abbreviation" },
  { key: "address", label: "Address" },
  { key: "recommendedPlayerCount", label: "Recommended player count" },
];

export type Draft = Record<string, unknown>;

/* ZIPCODE IS A NUMBER IN THE API, not a string. Warsaw 1684 stores 1452 for the postcode 01-452 —
 * the leading zero was gone before we saw it, and re-padding it here would be inventing data. We
 * send what was typed, as a number, and show what is stored. */
export function coerceZip(v: unknown): number | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  const digits = s.replace(/[^0-9]/g, "");
  if (!digits) return undefined;
  return Number(digits);
}

const isBlank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

/** NEVER SENDS "". A cleared input is not a value; it is the absence of one, and "" on the wire is
 *  a string where the API wants a number or a real name. Blank keys are simply omitted. */
export function createBody(draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CREATE_KEYS) {
    const v = k === "zipcode" ? coerceZip(draft[k]) : draft[k];
    if (isBlank(v)) continue;
    out[k] = k === "cityId" || k === "recommendedPlayerCount" ? Number(v)
      : k === "lat" || k === "lng" ? Number(v)
      : v;
  }
  return out;
}

/** THE DIFF IS THE BODY. Only changed keys travel. A key cleared to blank is NOT a change — the
 *  API has no "unset" for these and "" would be a 400 or, worse, a stored empty string. */
export function updateBody(orig: Draft, draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of UPDATE_KEYS) {
    const nextRaw = k === "zipcode" ? coerceZip(draft[k]) : draft[k];
    if (isBlank(nextRaw)) continue;                       // clearing is not a change
    const next = k === "cityId" || k === "recommendedPlayerCount" || k === "orderPosition"
      ? Number(nextRaw)
      : k === "lat" || k === "lng" ? Number(nextRaw) : nextRaw;
    const prev = k === "zipcode" ? coerceZip(orig[k]) : orig[k];
    const prevNorm = typeof next === "number" ? Number(prev) : prev;
    if (String(prevNorm ?? "") === String(next ?? "")) continue;
    out[k] = next;
  }
  return out;
}

/** Which FORM-required fields are still empty. Drives the create footer's count. */
export function missingRequired(draft: Draft): string[] {
  return FORM_REQUIRED.filter(({ key }) => isBlank(key === "zipcode" ? coerceZip(draft[key]) : draft[key]))
    .map(({ label }) => label);
}

/* ── DELETE ────────────────────────────────────────────────────────────────────────────────────
 * CLUBHOUSE REFUSES WHAT THE API ALLOWS. Proven on staging: a field with a live match on it
 * deletes with a 2xx, disappears from /admin/fields, and leaves the match pointing at a field
 * nothing will render. The API does not check. So we do.
 *
 * ANY match, ever — not just future ones. A past match still has to render its field on a report,
 * a receipt and a manager-pay row. */
export function deleteBlock(matchCount: number): { ok: boolean; reason: string } {
  if (matchCount > 0) {
    return { ok: false, reason: `Cannot delete — ${matchCount.toLocaleString("en-US")} match${matchCount === 1 ? "" : "es"}` };
  }
  return { ok: true, reason: "Delete field" };
}

/** TYPE THE NAME. A destructive, irreversible-from-here action does not happen on one click, and
 *  the thing typed is the thing being destroyed rather than the word DELETE — so the confirmation
 *  cannot be satisfied without looking at which field is open. */
export const deleteConfirmed = (typed: string, name: string) =>
  typed.trim().length > 0 && typed.trim() === String(name ?? "").trim();

/* ── VENUE MAPPING ─────────────────────────────────────────────────────────────────────────────
 * fin_venue_fields is OURS: fin_venue_id, mdapi_field_id, field_title_at_link, created_at,
 * counts_as_regular_play. A row can be written independently of the MatchDay record — there is no
 * foreign key across the boundary, which is exactly why both kinds of orphan below exist. */
export type Link = { mdapi_field_id: number | null; fin_venue_id: number | null };

export const isMapped = (fieldId: number, links: readonly Link[]) =>
  links.some((l) => Number(l.mdapi_field_id) === Number(fieldId));

/** BOTH NUMBERS, because they answer different questions. "How many fields can no cost or revenue
 *  path see" and "how many of those are costing us money right now" are not the same, and the
 *  mockup showed only the second while labelling it the first. */
export function unmappedSummary(
  fields: readonly { id: number }[], links: readonly Link[], activeFieldIds: ReadonlySet<number>,
): { unmapped: number[]; running: number[] } {
  const unmapped = fields.filter((f) => !isMapped(f.id, links)).map((f) => f.id);
  return { unmapped, running: unmapped.filter((id) => activeFieldIds.has(id)) };
}

/** THE ORPHAN IN THE OTHER DIRECTION — a fin_venue_fields row pointing at a field that no longer
 *  appears in /admin/fields. This is the soft-delete consequence made visible: the API hides the
 *  field, our link row keeps pointing at it, and its cost silently attaches to nothing. */
export const orphanLinks = (links: readonly Link[], liveFieldIds: ReadonlySet<number>) =>
  links.filter((l) => l.mdapi_field_id != null && !liveFieldIds.has(Number(l.mdapi_field_id)))
    .map((l) => ({ fieldId: Number(l.mdapi_field_id), venueId: l.fin_venue_id }));

/* ── PHOTOS ────────────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND THE PAGE SAYS SO. images and cover are both refused by the create DTO, and no
 * upload endpoint could be found: /admin/fields/{id}/images, /admin/images, /admin/fields/images
 * and /admin/upload all 404 on GET and POST. Four guesses was the limit — guessing endpoint names
 * is how createCityManager cost a session.
 *
 * THE ONE TARGETED READ INSTEAD: every images[].url and cover on production — 79 of them — points
 * at playmatchday.s3.us-west-1.amazonaws.com, a raw S3 bucket rather than the API host. That is
 * the shape of a presigned direct-to-storage upload, which would explain why no upload route
 * exists under /admin. Reported, not acted on. */
export const PHOTOS_READ_ONLY_NOTE =
  "Photos are read-only here. Uploading is not available from Clubhouse.";
export const IMAGE_HOST = "playmatchday.s3.us-west-1.amazonaws.com";

/* ── PHONE NUMBERS ─────────────────────────────────────────────────────────────────────────────
 * GET/POST /admin/fields/{id}/phone-numbers -> { id, fieldId, phoneNumber, isEnabled, ... }
 * MANY per field. THERE IS NO LABEL FIELD — the mockup's "Field contact" and "Groundskeeper" were
 * invented and are gone. isEnabled is real and the mockup did not have it.
 * Requires an existing field id, so on create these stage client-side and flush after the POST. */
export type PhoneRow = { id: number; phoneNumber: string; isEnabled: boolean };

/** Digits and a leading +, nothing else. Rejects the empty string so a stray Add cannot fire. */
export const validPhone = (v: string) => /^\+?[0-9][0-9 ()\-.]{6,}$/.test(v.trim());

/** WHAT GOES IN change_log: that a number was added or removed, NEVER the number. A phone number
 *  is player-adjacent PII with different access rules from the audit trail, and change_log is
 *  readable by more people than the field record is. */
export const phoneAuditNote = (action: "added" | "removed", fieldId: number) =>
  `phone number ${action} on field ${fieldId}`;
