import "server-only"; // no-op under --conditions=react-server
// STAFF APP OPS · REVIEWS (Ryan, 2026-11-02). VIEW ONLY. The desktop Reviews page's own data and rules:
//
//   ROWS      GET /api/reviews, called in process with the caller's token, so its city scope (SQL,
//             from the session) applies unchanged; then the desktop's own row shaping and fake filter
//             (reviewsData: parseLocal, canonCity, isRealReview on mdapi_users.is_fake_player or a
//             fake email).
//   FIGURES   reviewsDerive.derivePeriod over the period's rows: average, reviews, matches, the
//             manager ranking (10 or more reviews, MIN_RANK_REVIEWS), the managers under it, the
//             reviews with no manager, Needs attention (a match under 3.5 with 3 or more reviews).
//             Month is exactly derivePage's month; a week is the same body over Monday to Sunday.
//   COMMENTS  isCommentRow: written comments plus 1-star ratings without words. Reply due:
//             needsReply (3 stars or less) and not marked in review_replies.
//   MATCHES   reviews carry no match id; a match is its field and kickoff (matchKeyOf), looked up in
//             mdapi_matches by field_title and start_date to open the Match screen (none: not tappable).
//   PLAYERS   first name and last initial only; never an email.

import type { SupabaseClient } from "@supabase/supabase-js";
import { callDesktop } from "./appCall";
import { GET as reviewsGet } from "@/app/api/reviews/route";
import { canonCity, derivePeriod, isCommentRow, matchKeyOf, needsReply, reviewManagerName } from "./reviewsDerive";
import { isFakePlayerEmail } from "./mdapiFakePlayer";
import { cityIdentifierForLabel } from "./cityScope";
import type { ReviewRow } from "./useReviewData";

type Raw = Record<string, unknown>;

/* The desktop's wall-clock parse (reviewsData.parseLocal): component by component, never new Date(str). */
function parseLocal(s: unknown): Date | null {
  if (typeof s !== "string" || !s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const clock = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const playerName = (r: ReviewRow) => {
  const f = (r.userFirstName ?? "").trim(), l = (r.userLastName ?? "").trim();
  return f ? (l ? `${f} ${l[0]!.toUpperCase()}.` : f) : l ? `${l[0]!.toUpperCase()}.` : "Player";
};

export type ScopedRows = { rows: ReviewRow[]; raw: Map<number, string>; scope: string | null; replied: Set<number> };

/** Every review the caller may see, shaped and cleaned as the desktop does, plus the reply marks. */
export async function loadReviewRows(req: Request, sb: SupabaseClient): Promise<ScopedRows | { error: string; status: number }> {
  const c = await callDesktop(req, reviewsGet, "/api/reviews");
  if (!c.ok || !c.json) return { error: String(c.json?.error ?? `HTTP ${c.status}`), status: c.status };
  const fakes = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("mdapi_users").select("id").eq("is_fake_player", true).range(from, from + 999);
    if (error || !data) break;   // as the desktop: fall toward the email signal, never throw
    for (const r of data) fakes.add(String(r.id));
    if (data.length < 1000) break;
  }
  const rows: ReviewRow[] = [];
  const raw = new Map<number, string>();
  for (const r of (c.json.rows as Raw[]) ?? []) {
    const startDate = parseLocal(r.start_date);
    if (!startDate || r.star_rating == null) continue;
    const city = canonCity(r.city_name as string | null);
    if (!city) continue;
    const row: ReviewRow = {
      apiId: Number(r.api_id), city, fieldTitle: (r.field_title as string) ?? "",
      managerFirstName: (r.manager_first_name as string | null) ?? null, managerLastName: (r.manager_last_name as string | null) ?? null,
      starRating: Number(r.star_rating), startDate, userId: r.user_id == null ? null : String(r.user_id),
      ratingAt: parseLocal(r.updated_at_rating), comment: (r.comment as string | null) ?? null,
      userFirstName: (r.user_first_name as string | null) ?? null, userLastName: (r.user_last_name as string | null) ?? null,
      userEmail: (r.user_email as string | null) ?? null, tags: Array.isArray(r.tags_rating) ? (r.tags_rating as string[]) : [],
    };
    if ((row.userId && fakes.has(row.userId)) || isFakePlayerEmail(row.userEmail)) continue;   // isRealReview
    rows.push(row);
    raw.set(row.apiId, String(r.start_date).slice(0, 16));
  }
  const replied = new Set<number>();
  const ids = rows.filter(needsReply).map((r) => r.apiId);
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await sb.from("review_replies").select("review_id").in("review_id", ids.slice(i, i + 500));
    if (error) break;   // reply tracking unreadable: everything owed reads as due, as the desktop pre-0089
    for (const x of data ?? []) replied.add(Number(x.review_id));
  }
  return { rows, raw, scope: (c.json.scope as string | null) ?? null, replied };
}

export function reviewsView(s: ScopedRows, from: string, to: string, city: string | null, matchIdOf: Map<string, number>) {
  const inPeriod = s.rows.filter((r) => { const d = ymd(r.startDate); return d >= from && d <= to; });
  const cityPills = new Map<string, Set<string>>();
  for (const r of inPeriod) (cityPills.get(r.city) ?? cityPills.set(r.city, new Set()).get(r.city)!).add(matchKeyOf(r));
  const rows = city ? inPeriod.filter((r) => canonCity(r.city) === canonCity(city)) : inPeriod;
  const d = derivePeriod(rows);
  const commentOf = (r: ReviewRow) => ({
    apiId: r.apiId, stars: r.starRating, name: playerName(r), userId: r.userId,
    text: r.comment && r.comment.trim() ? r.comment.trim() : null, tags: r.tags,
    replyDue: needsReply(r) && !s.replied.has(r.apiId),
  });
  const matchIdFor = (r: ReviewRow) => matchIdOf.get(`${r.fieldTitle}@@${s.raw.get(r.apiId) ?? ""}`) ?? null;
  const comments = rows.filter(isCommentRow);

  // BY DAY: each day's average and comment count, and its matches lowest rated first.
  const days: { date: string; avg: number | null; reviews: number; comments: number; matches: unknown[] }[] = [];
  for (let x = new Date(`${from}T12:00:00`); ymd(x) <= to; x.setDate(x.getDate() + 1)) {
    const day = ymd(x);
    const dr = rows.filter((r) => ymd(r.startDate) === day);
    const byMatch = new Map<string, ReviewRow[]>();
    for (const r of dr) (byMatch.get(matchKeyOf(r)) ?? byMatch.set(matchKeyOf(r), []).get(matchKeyOf(r))!).push(r);
    const matches = [...byMatch.values()].map((ms) => {
      const a = ms[0]!, mgr = reviewManagerName(a);
      return {
        key: matchKeyOf(a), matchId: matchIdFor(a), time: clock(a.startDate), field: a.fieldTitle, city: a.city,
        manager: mgr ? { name: mgr, initials: initials(mgr) } : null,
        avg: ms.reduce((t, r) => t + r.starRating, 0) / ms.length, reviews: ms.length,
        comments: ms.filter(isCommentRow).sort((p, q) => p.starRating - q.starRating).map(commentOf),
      };
    }).sort((p, q) => p.avg - q.avg || q.reviews - p.reviews);
    days.push({ date: day, avg: dr.length ? dr.reduce((t, r) => t + r.starRating, 0) / dr.length : null, reviews: dr.length, comments: dr.filter(isCommentRow).length, matches });
  }

  // BY MANAGER: the desktop's ranked (10+) and too-few lists, each with tags and comments.
  const detail = (name: string | null) => {
    const mine = rows.filter((r) => reviewManagerName(r) === name);
    const tags = new Map<string, number>();
    // COMPLAINT TAGS: only from reviews owed a reply (3 stars or less); praise tags are not complaints.
    for (const r of mine) if (needsReply(r)) for (const t of r.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    const cs = mine.filter(isCommentRow).sort((p, q) => q.startDate.getTime() - p.startDate.getTime());
    return {
      tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count })),
      comments: cs.map((r) => ({ ...commentOf(r), match: { field: r.fieldTitle, day: r.startDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }), time: clock(r.startDate), matchId: matchIdFor(r) } })),
    };
  };
  const mgr = (m: { key: string; name: string; city: string; avg: number; reviews: number; matches: number }) => {
    const dt = detail(m.name);
    return { ...m, initials: initials(m.name), commentCount: dt.comments.length, ...dt };
  };
  const none = d.unattributed ? { ...d.unattributed, ...detail(null), commentCount: detail(null).comments.length } : null;

  return {
    tiles: { avg: d.avg, reviews: d.reviews, matches: d.matches, needLook: d.attn.length, replyDue: comments.filter((r) => needsReply(r) && !s.replied.has(r.apiId)).length },
    attention: d.attn.map((m) => ({ key: m.key, avg: m.avg, reviews: m.reviews })),
    cities: [...cityPills].map(([name, ms]) => ({ name, code: cityIdentifierForLabel(name) ?? name, matches: ms.size })).sort((a, b) => a.code.localeCompare(b.code)),
    allMatches: new Set(inPeriod.map(matchKeyOf)).size,
    days,
    managers: { ranked: d.ranked.map(mgr), tooFew: d.unranked.map(mgr), none },
  };
}

/** mdapi_matches api ids by "field_title@@YYYY-MM-DDTHH:MM" for the period's days. */
export async function matchIds(sb: SupabaseClient, from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let p = 0; ; p += 1000) {
    const { data, error } = await sb.from("mdapi_matches").select("api_id, field_title, start_date")
      .gte("start_date", `${from}T00:00:00`).lte("start_date", `${to}T23:59:59`).order("api_id").range(p, p + 999);
    if (error || !data) break;
    for (const m of data) out.set(`${m.field_title ?? ""}@@${String(m.start_date).slice(0, 16)}`, Number(m.api_id));
    if (data.length < 1000) break;
  }
  return out;
}
