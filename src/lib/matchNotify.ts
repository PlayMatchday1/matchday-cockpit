// Shared (client + server) helpers for the "Notify players" feature:
// template bodies, token handling, SMS segment math, phone masking.
//
// All template copy is strict ASCII on purpose. A single non-GSM-7
// character (em-dash, smart quote, emoji) flips the whole SMS to UCS-2
// encoding, which drops the per-segment limit from 160 to 70 chars and
// multiplies cost. smsSegments() surfaces that so the composer can warn.
//
// Token model:
//   {first_name}  - substituted PER RECIPIENT at send time (server).
//                   Left as a literal token in the editable body.
//   {new_field} / {new_time} - operator fills these inline before send.
//                   unfilledTokens() blocks a send while any remain.
//   {date} / {original_time} / {field} / {original_field} - substituted
//                   from match data when the template body is built.

export type NotifyTemplateId =
  | "field_change"
  | "time_change"
  | "weather_policy"
  | "free_form";

export const NOTIFY_TEMPLATE_IDS: NotifyTemplateId[] = [
  "field_change",
  "time_change",
  "weather_policy",
  "free_form",
];

export const TEMPLATE_LABELS: Record<NotifyTemplateId, string> = {
  field_change: "Field change",
  time_change: "Time change",
  weather_policy: "Weather policy",
  free_form: "Free-form",
};

export type MatchMergeValues = {
  date: string; // city-local date, e.g. "Sat, Jun 21"
  time: string; // city-local start time, e.g. "7:00 PM"
  field: string; // field_title
};

// Build the initial composer body. Match-derived fields are filled in;
// {first_name} (per-recipient) and {new_field}/{new_time} (operator)
// are left as literal tokens. Free-form starts empty.
export function buildTemplateBody(
  id: NotifyTemplateId,
  m: MatchMergeValues,
): string {
  switch (id) {
    case "field_change":
      return `Hi {first_name}, heads up, your MatchDay match on ${m.date} at ${m.time} has been moved from ${m.field} to {new_field}. Same time. Reply if you have questions.`;
    case "time_change":
      return `Hi {first_name}, your MatchDay match on ${m.date} at ${m.field} has been moved from ${m.time} to {new_time}. Reply if you have questions.`;
    case "weather_policy":
      return `Hi {first_name}, weather update for your MatchDay match on ${m.date} at ${m.field}: match is still on! We will let you know if the facility closes or conditions become unsafe due to lightning. See you there.`;
    case "free_form":
      return "";
  }
}

// Replace {first_name} with the recipient's first name; "there" when
// absent (some rows have no first name). Case-insensitive on the token.
export function personalize(body: string, firstName: string | null): string {
  const name = (firstName ?? "").trim() || "there";
  return body.replace(/\{first_name\}/gi, name);
}

// Any {token} still in the body that is NOT {first_name}. A non-empty
// result blocks the send (e.g. the operator never filled {new_field}).
export function unfilledTokens(body: string): string[] {
  const found = body.match(/\{[a-z_]+\}/gi) ?? [];
  return found.filter((t) => t.toLowerCase() !== "{first_name}");
}

export type SegmentInfo = {
  chars: number;
  segments: number;
  encoding: "GSM-7" | "UCS-2";
};

// GSM-7 extension chars cost 2 septets each. Backtick and anything
// outside 7-bit ASCII force UCS-2 (70/67 char segments).
const GSM7_EXT = new Set(["^", "{", "}", "\\", "[", "]", "~", "|"]);

export function smsSegments(text: string): SegmentInfo {
  let gsm = true;
  let septets = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 127 || ch === "`") {
      gsm = false;
      break;
    }
    septets += GSM7_EXT.has(ch) ? 2 : 1;
  }
  if (!text) return { chars: 0, segments: 0, encoding: "GSM-7" };
  if (gsm) {
    const segments = septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { chars: text.length, segments, encoding: "GSM-7" };
  }
  const units = text.length; // UTF-16 code units
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { chars: units, segments, encoding: "UCS-2" };
}

// "+15125550123" -> "***-***-0123". Falls back to a generic mask if the
// number is too short to slice.
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 4) return "***-***-****";
  return `***-***-${digits.slice(-4)}`;
}

// "Sarah", "Kim" -> "Sarah K." ; missing last name -> just the first.
export function displayName(
  firstName: string | null,
  lastName: string | null,
): string {
  const first = (firstName ?? "").trim() || "Player";
  const last = (lastName ?? "").trim();
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}
