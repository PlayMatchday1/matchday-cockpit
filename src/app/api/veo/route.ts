// GET /api/veo — data for the admin Veo surface: the review queue plus recent
// auto-posts, with every referenced match id enriched to a human label
// (venue · date · time) server-side. Admin-only.

import { authenticateCrm } from "@/lib/crmAuth";
import { matchLocalStart } from "@/lib/veo";

export const runtime = "nodejs";
export const maxDuration = 15;

type VeoRow = {
  id: string;
  recording_id: string;
  match_path_slug: string | null;
  video_url: string;
  email_subject: string;
  email_from: string | null;
  received_at: string | null;
  parsed_code: string | null;
  parsed_match_date: string | null;
  parsed_time_label: string | null;
  status: string;
  queue_reason: string | null;
  matched_api_id: number | null;
  candidate_api_ids: number[] | null;
  posted_at: string | null;
  created_at: string;
};

function minutesTo12h(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const min = minutes % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  const { supabase } = auth;

  const queueRes = await supabase
    .from("veo_recordings")
    .select(
      "id, recording_id, match_path_slug, video_url, email_subject, email_from, received_at, parsed_code, parsed_match_date, parsed_time_label, status, queue_reason, matched_api_id, candidate_api_ids, posted_at, created_at",
    )
    .eq("status", "queued")
    .order("created_at", { ascending: false });
  if (queueRes.error) {
    console.error("[veo:list] queue query failed", queueRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  const recentRes = await supabase
    .from("veo_recordings")
    .select(
      "id, recording_id, match_path_slug, video_url, email_subject, email_from, received_at, parsed_code, parsed_match_date, parsed_time_label, status, queue_reason, matched_api_id, candidate_api_ids, posted_at, created_at",
    )
    .in("status", ["posted", "dismissed"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (recentRes.error) {
    console.error("[veo:list] recent query failed", recentRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  const queue = (queueRes.data ?? []) as VeoRow[];
  const recent = (recentRes.data ?? []) as VeoRow[];

  // Collect every api_id referenced (matched + candidates) and label them.
  const ids = new Set<number>();
  for (const r of [...queue, ...recent]) {
    if (r.matched_api_id) ids.add(r.matched_api_id);
    for (const c of r.candidate_api_ids ?? []) ids.add(c);
  }

  const labels: Record<number, string> = {};
  if (ids.size > 0) {
    const mRes = await supabase
      .from("mdapi_matches")
      .select("api_id, field_title, city_name, start_date")
      .in("api_id", [...ids]);
    if (mRes.error) {
      console.error("[veo:list] match labels query failed", mRes.error);
    } else {
      for (const m of mRes.data ?? []) {
        const s = matchLocalStart(m.start_date as string | null);
        const time = s ? ` ${minutesTo12h(s.minutes)}` : "";
        const date = s ? s.date : "";
        const venue = (m.field_title as string | null) ?? "?";
        const city = (m.city_name as string | null) ?? "";
        labels[m.api_id as number] = `${venue}${city ? ` (${city})` : ""} · ${date}${time}`;
      }
    }
  }

  return Response.json({ queue, recent, labels }, { status: 200 });
}
