// FIELD COVER PHOTOS — the client-safe half (types, crop shapes, the name rules, the verdict sentences).
// The server half is src/lib/fieldCoversServer.ts.
//
// THE MODEL, AS DECIDED (Ryan, 2026-10-17). A field has a Default cover (fields.cover_s3_key: every match on
// Default, and the Field Partners card) plus any number of extra covers, each with a free-text name. A match uses
// the Default or ONE extra cover of its own field. Nothing else: covers are not tied to match category or type.
//
// WHERE IT RUNS TODAY. The backend half exists only on the local backend branch (feature/field-covers), so every
// /api/covers route answers 503 unless local mode is on, and the two components render nothing on a 503.

export type CoverView = {
  id: number; fieldId: number; name: string; url: string | null; upcomingMatches: number;
  createdAt: string; updatedAt: string; createdByStaffEmail: string | null; updatedByStaffEmail: string | null;
};
export type FieldCovers = {
  field: { id: number; title: string };
  default: { url: string | null; upcomingMatches: number };
  covers: CoverView[];
  upcomingMatchesTotal: number;
};
export type CoverOption = { id: number | null; name: string; url: string | null };
export type SlotMatch = { id: number; name: string; startDate: string; startDateUtc: string; cover: { id: number; name: string | null } | null };
export type MatchCover = {
  matchId: number; fieldId: number; fieldTitle: string; startDate: string; startDateUtc: string;
  /** `removed`: a removed cover on a match that has started (it keeps it; Ryan 2026-10-18). */
  cover: { id: number; name: string; removed?: boolean } | null; coverUrl: string | null;
  options: CoverOption[]; sameSlotUpcoming: SlotMatch[];
};

/** LANDED: the read-back shows it. NOT APPLIED: 2xx but the read-back does not. FAILED: refused, nothing changed.
 *  UNKNOWN: a timeout or a 5xx, it may or may not have happened. Never retried. */
export type CoverVerdict = "LANDED" | "NOT APPLIED" | "FAILED" | "UNKNOWN";

export const COVER_NAME_MAX = 60;
export const COVER_MAX_BYTES = 10 * 1024 * 1024;
export const COVER_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const COVERS_UNAVAILABLE = "Cover photos need the backend change that has not shipped. They work in local mode only for now.";

/** The backend's own rule (field-covers.service.ts cleanName), checked before anything is sent. Null = fine. */
export function coverNameProblem(raw: string, taken: string[] = []): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return "Give the cover a name.";
  if (name.length > COVER_NAME_MAX) return `Keep the name to ${COVER_NAME_MAX} characters (this one is ${name.length}).`;
  if (name.toLowerCase() === "default") return '"Default" is the field\'s own cover. Choose another name.';
  if (taken.some((t) => t.trim().toLowerCase() === name.toLowerCase())) return "This field already has a cover with that name.";
  return null;
}

export function coverFileProblem(f: { type: string; size: number }): string | null {
  if (!(COVER_TYPES as readonly string[]).includes(f.type)) return `${f.type || "That file type"} is not accepted. Use JPEG, PNG or WebP.`;
  if (f.size > COVER_MAX_BYTES) return `That file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 10 MB.`;
  return null;
}

/* WHERE THE IMAGE APPEARS, and the frame it is cropped to there. Every place is a centre crop with cover fit
 * (ImageWithSkeleton / objectFit: cover). Read from the code, 2026-10-17:
 *   match card            frontend MatchCard.tsx:66        full card width x 0.55 x screen width  -> ~1.67:1
 *                         (a 390-wide phone with 16-pt card margins: 358 x 214.5. The margin is an assumption.)
 *   match details header  frontend MatchDetails.tsx:593    screen width x 0.75 x screen width     -> 4:3
 *   Field Partners card   frontend FieldsCarousel.tsx:59,81  0.55w x 0.34w                         -> ~1.62:1
 *                         Default cover only: the card reads GET /fields, which keeps the field's Default.
 *   share preview         go-playmatchday opengraph-image.tsx:16,126  1200 x 630                  -> ~1.90:1 */
export type CropShape = { key: string; label: string; aspect: number; defaultOnly?: boolean; note: string };
export const CROP_SHAPES: CropShape[] = [
  { key: "card", label: "Match card", aspect: 358 / 214.5, note: "Match lists in the app" },
  { key: "header", label: "Match details header", aspect: 4 / 3, note: "Top of the match screen" },
  { key: "partners", label: "Field Partners card", aspect: 0.55 / 0.34, defaultOnly: true, note: "Default cover only" },
  { key: "share", label: "Share preview", aspect: 1200 / 630, note: "1200 × 630 link preview" },
];
export const shapesFor = (isDefault: boolean) => CROP_SHAPES.filter((s) => isDefault || !s.defaultOnly);

/** The part of an image (as fractions of its width and height) that a centre crop to `aspect` keeps. */
export function centreCrop(imageAspect: number, aspect: number): { x: number; y: number; w: number; h: number } {
  if (!(imageAspect > 0) || !(aspect > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  if (aspect >= imageAspect) { const h = imageAspect / aspect; return { x: 0, y: (1 - h) / 2, w: 1, h }; }
  const w = aspect / imageAspect; return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

/** "Keep text in the centre": the region every shape keeps, so text inside it survives in all of them. */
export function safeArea(imageAspect: number, shapes: CropShape[]): { x: number; y: number; w: number; h: number } {
  let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
  for (const s of shapes) {
    const c = centreCrop(imageAspect, s.aspect);
    x0 = Math.max(x0, c.x); y0 = Math.max(y0, c.y); x1 = Math.min(x1, c.x + c.w); y1 = Math.min(y1, c.y + c.h);
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export function verdictLine(v: CoverVerdict, what: string, detail?: string | null): string {
  switch (v) {
    case "LANDED": return `LANDED: ${what} (read back from the API).`;
    case "NOT APPLIED": return `NOT APPLIED: the API said yes but the read-back does not show ${what}. Refresh before trying again.`;
    case "FAILED": return `FAILED: nothing changed.${detail ? ` ${detail}` : ""}`;
    default: return `UNKNOWN: ${detail ?? "the outcome could not be read"}. Refresh before trying again; it may have happened.`;
  }
}

/** "Wed, Oct 21 · 7:30 PM" from a match startDate, which is the field's LOCAL WALL CLOCK stored with a Z. READ OFF
 *  THE STRING, never through a Date of it (CLAUDE.md, the wall-clock trap; copyMatch.ts wallClockLabel does the
 *  same). The weekday comes from the calendar date alone. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function wallClockLabel(wall: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(typeof wall === "string" ? wall : "");
  if (!m) return "date unknown";
  const [, y, mo, d, hh, mi] = m;
  const dow = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  const h = Number(hh);
  return `${DAYS[dow]}, ${MONTHS[Number(mo) - 1] ?? "?"} ${Number(d)} · ${h % 12 === 0 ? 12 : h % 12}:${mi} ${h >= 12 ? "PM" : "AM"}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
