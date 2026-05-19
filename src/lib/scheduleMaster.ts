// Shared types + helpers for the schedule_master CRUD API routes
// (GET / POST / PATCH / DELETE under /api/schedule-master/*).
//
// Keeps validation and audit-log writes in one place so all three
// mutation routes enforce the same shape and leave the same audit
// trail.

import type { SupabaseClient } from "@supabase/supabase-js";

// Display names accepted on writes. The 8 canonical cockpit cities.
// schedule_master.city stores these full strings (the legacy HTML
// used display names, not the ATX/HOU/... short codes that
// mdapi_matches.city_identifier carries).
export const CANONICAL_CITIES = [
  "Austin",
  "Houston",
  "San Antonio",
  "Dallas",
  "Atlanta",
  "St. Louis",
  "OKC",
  "El Paso",
] as const;
export type CanonicalCity = (typeof CANONICAL_CITIES)[number];

export type ScheduleMasterRow = {
  id: string;
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: number;
  // PR-D: nullable during the transition. Populated by the
  // venue combobox in MasterScheduleEditModal or by the one-time
  // backfill script. Future writers should always supply it.
  mdapi_field_id: number | null;
};

export type ScheduleMasterInput = {
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: number;
  mdapi_field_id: number | null;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Validates a payload for create (isPartial=false) or update
// (isPartial=true). On update, every field is optional but each
// present field must pass its individual check.
export function validateScheduleMasterPayload(
  body: unknown,
  opts: { isPartial: boolean },
): ValidationResult<Partial<ScheduleMasterInput>> {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  const out: Partial<ScheduleMasterInput> = {};

  function required<K extends keyof ScheduleMasterInput>(
    key: K,
    check: () => string | null,
  ): string | null {
    if (b[key] === undefined) {
      return opts.isPartial ? null : `${String(key)} is required`;
    }
    return check();
  }

  let err: string | null;

  err = required("city", () => {
    const v = b.city;
    if (typeof v !== "string" || !v.trim()) return "city must be a string";
    if (!(CANONICAL_CITIES as readonly string[]).includes(v)) {
      return `city must be one of: ${CANONICAL_CITIES.join(", ")}`;
    }
    out.city = v;
    return null;
  });
  if (err) return { ok: false, error: err };

  err = required("venue", () => {
    const v = b.venue;
    if (typeof v !== "string" || !v.trim()) return "venue must be a non-empty string";
    out.venue = v.trim();
    return null;
  });
  if (err) return { ok: false, error: err };

  err = required("detail", () => {
    const v = b.detail;
    if (typeof v !== "string" || !v.trim()) return "detail must be a non-empty string";
    out.detail = v.trim();
    return null;
  });
  if (err) return { ok: false, error: err };

  err = required("match_date", () => {
    const v = b.match_date;
    if (typeof v !== "string" || !ISO_DATE.test(v)) {
      return "match_date must be YYYY-MM-DD";
    }
    const t = Date.parse(`${v}T00:00:00Z`);
    if (Number.isNaN(t)) return "match_date must be a valid calendar date";
    out.match_date = v;
    return null;
  });
  if (err) return { ok: false, error: err };

  err = required("match_time", () => {
    const v = b.match_time;
    if (typeof v !== "string" || !v.trim()) return "match_time must be a non-empty string";
    out.match_time = v.trim();
    return null;
  });
  if (err) return { ok: false, error: err };

  err = required("max_spots", () => {
    const v = b.max_spots;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return "max_spots must be a non-negative integer";
    }
    out.max_spots = v;
    return null;
  });
  if (err) return { ok: false, error: err };

  // mdapi_field_id is optional on both create and update (older
  // clients don't send it; the column is nullable). If present it
  // must be either null (explicit unlink) or a positive integer.
  if (b.mdapi_field_id !== undefined) {
    const v = b.mdapi_field_id;
    if (v === null) {
      out.mdapi_field_id = null;
    } else if (typeof v === "number" && Number.isInteger(v) && v > 0) {
      out.mdapi_field_id = v;
    } else {
      return {
        ok: false,
        error: "mdapi_field_id must be a positive integer or null",
      };
    }
  }

  if (opts.isPartial && Object.keys(out).length === 0) {
    return { ok: false, error: "Body must include at least one field" };
  }
  return { ok: true, value: out };
}

// Append-only audit ledger write. Never throws — the caller's
// user-visible operation already succeeded, and a missing audit row
// is logged loudly (AUDIT GAP) so we can reconstruct from logs.
export async function writeScheduleMasterAudit(
  sb: SupabaseClient,
  args: {
    action: "create" | "update" | "delete";
    userEmail: string;
    rowId: string | null;
    oldValues: ScheduleMasterRow | null;
    newValues: ScheduleMasterRow | null;
  },
): Promise<void> {
  const { error } = await sb.from("schedule_master_audit").insert({
    row_id: args.rowId,
    action: args.action,
    user_email: args.userEmail,
    old_values: args.oldValues,
    new_values: args.newValues,
  });
  if (error) {
    console.error(
      `[schedule-master:audit] AUDIT GAP action=${args.action} row_id=${args.rowId ?? "-"} user=${args.userEmail} — ${error.code} ${error.message}`,
    );
  }
}
