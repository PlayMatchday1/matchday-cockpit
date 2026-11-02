// WHICH FIELDS IN A CITY HAVE A CAMERA, for the draft. Pure.
//
// Read from the camera marker in the match name, the thing players see, and NOT from veo_codes: that
// table is wrong in both directions (Zipp 21 of 21 recorded with no code, Westlake coded with 0 of 14
// recorded; docs/matchday-api-facts.md). Counts show rotation: recorded_matches below matches means
// the camera is only there some nights.
//
// TIME MODEL: start_date is LOCAL WALL CLOCK wearing a "Z", formatted with timeZone "UTC" so it prints
// as written. start_date_utc is the instant and decides past from upcoming.

import { hasCameraEmoji } from "@/lib/veo";
import type { RecordedField } from "@/lib/aiDraftModel";

export const CAMERA_LOOKBACK_DAYS = 30;
export const CAMERA_LOOKAHEAD_DAYS = 14;

export type CameraRow = { field_id: number | null; field_title: string | null; name: string | null; start_date: string | null; start_date_utc: string | null; is_cancelled: boolean | null };

const when = (s: string | null) =>
  s ? new Date(s).toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

export function buildRecordedFields(rows: readonly CameraRow[], now: number): RecordedField[] {
  const by = new Map<number, { title: string; n: number; cam: number; last: CameraRow | null; next: CameraRow | null }>();
  const at = (r: CameraRow | null) => Date.parse(r?.start_date_utc ?? "");
  for (const r of rows) {
    if (r.field_id == null || r.is_cancelled === true) continue;
    const e = by.get(r.field_id) ?? { title: r.field_title?.trim() || "Unnamed field", n: 0, cam: 0, last: null, next: null };
    e.n++;
    if (hasCameraEmoji(r.name)) {
      e.cam++;
      const t = at(r);
      if (t <= now && !(at(e.last) >= t)) e.last = r;
      if (t > now && !(at(e.next) <= t)) e.next = r;
    }
    by.set(r.field_id, e);
  }
  return [...by.values()]
    .filter((e) => e.cam > 0)
    .sort((a, b) => b.cam - a.cam || a.title.localeCompare(b.title))
    .map((e) => ({ field: e.title, recorded_matches: e.cam, matches: e.n, last_recorded: when(e.last?.start_date ?? null), next_recorded: when(e.next?.start_date ?? null) }));
}
