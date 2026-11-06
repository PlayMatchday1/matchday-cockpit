// HEROKU HTTPS LOG DRAIN — parse a Logplex POST body into our request-log lines.
//
// FORMAT (devcenter.heroku.com/articles/log-drains, read 2026-11-06):
//   · POST, Content-Type application/logplex-1, headers Logplex-Msg-Count, Logplex-Frame-Id (reused on
//     a resend), Logplex-Drain-Token.
//   · Body = syslog frames with RFC 6587 octet counting: `<len> <syslog message>`, where len is the
//     BYTE length of the message. Split by that count, never by newline.
//   · Each message is RFC 5424 with STRUCTURED-DATA omitted entirely (not a "-"):
//       <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID MSG
//     App stdout arrives as APP-NAME "app", PROCID "web.N". Anything else (the router, Heroku's own
//     lines) is dropped as not_app.
//   · Answer 2xx with Content-Length 0 and no body; a non-2xx makes Heroku resend the batch.
//
// THE LINE (backend core/request-logger/request-log.ts): JSON with EXACTLY these ten fields —
// ts, reqId, method, path, route, status, durationMs, userId, errorCode, ip — plus an optional
// matchId the backend is adding. A line missing any of the ten, or with a wrong type, is dropped.

export type DropReason = "bad_frame" | "not_app" | "not_json" | "wrong_shape";

export type LogLine = {
  ts: string; reqId: string; method: string; path: string; route: string | null; status: number;
  durationMs: number; userId: number | null; errorCode: string | null; ip: string | null; matchId: number | null;
};

const FIELDS = ["ts", "reqId", "method", "path", "route", "status", "durationMs", "userId", "errorCode", "ip"] as const;

// Split an octet-counted body into messages. A frame whose count is not a number, or runs past the
// end of the body, ends the parse: everything after it is unrecoverable and counted as bad_frame.
export function splitFrames(body: Buffer): { messages: string[]; badFrames: number } {
  const messages: string[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && (body[i] === 0x0a || body[i] === 0x0d || body[i] === 0x20)) i++;
    if (i >= body.length) break;
    let j = i;
    while (j < body.length && body[j] >= 0x30 && body[j] <= 0x39 && j - i < 8) j++;
    if (j === i || body[j] !== 0x20) return { messages, badFrames: 1 };
    const len = Number(body.subarray(i, j).toString("ascii"));
    const start = j + 1, end = start + len;
    if (!Number.isFinite(len) || len <= 0 || end > body.length) return { messages, badFrames: 1 };
    messages.push(body.subarray(start, end).toString("utf8"));
    i = end;
  }
  return { messages, badFrames: 0 };
}

// <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP MSG
const SYSLOG = /^<\d{1,3}>\d{1,2} \S+ \S+ (\S+) (\S+) \S+ ?([\s\S]*)$/;

export function parseMessage(msg: string): { ok: true; line: LogLine } | { ok: false; reason: DropReason } {
  const m = SYSLOG.exec(msg);
  if (!m) return { ok: false, reason: "bad_frame" };
  const [, app, proc, text] = m;
  if (app !== "app" || !/^web\.\d+$/.test(proc)) return { ok: false, reason: "not_app" };
  const t = text.trim();
  if (!t.startsWith("{")) return { ok: false, reason: "not_json" };
  let o: unknown;
  try { o = JSON.parse(t); } catch { return { ok: false, reason: "not_json" }; }
  const line = toLine(o);
  return line ? { ok: true, line } : { ok: false, reason: "wrong_shape" };
}

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isNullStr = (v: unknown, max: number) => v === null || isStr(v, max);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export function toLine(o: unknown): LogLine | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  for (const f of FIELDS) if (!Object.prototype.hasOwnProperty.call(r, f)) return null;
  if (!isStr(r.ts, 40) || !Number.isFinite(Date.parse(r.ts))) return null;
  if (!isStr(r.reqId, 200) || !isStr(r.method, 10) || !isStr(r.path, 2048)) return null;
  if (!isNullStr(r.route, 512)) return null;
  if (!isInt(r.status) || r.status < 100 || r.status > 599) return null;
  if (typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs) || r.durationMs < 0) return null;
  if (!(r.userId === null || (isInt(r.userId) && r.userId > 0))) return null;
  if (!isNullStr(r.errorCode, 100) || !isNullStr(r.ip, 64)) return null;
  const matchId = r.matchId;
  if (!(matchId === undefined || matchId === null || (isInt(matchId) && matchId > 0))) return null;
  return {
    ts: new Date(r.ts).toISOString(), reqId: r.reqId, method: r.method, path: r.path,
    route: (r.route as string | null), status: r.status, durationMs: Math.round(r.durationMs),
    userId: r.userId as number | null, errorCode: r.errorCode as string | null, ip: r.ip as string | null,
    matchId: (matchId as number | null | undefined) ?? null,
  };
}

export function parseBody(body: Buffer): { lines: LogLine[]; parsed: number; dropped: Partial<Record<DropReason, number>> } {
  const { messages, badFrames } = splitFrames(body);
  const dropped: Partial<Record<DropReason, number>> = {};
  if (badFrames) dropped.bad_frame = badFrames;
  const lines: LogLine[] = [];
  for (const msg of messages) {
    const r = parseMessage(msg);
    if (r.ok) lines.push(r.line);
    else dropped[r.reason] = (dropped[r.reason] ?? 0) + 1;
  }
  return { lines, parsed: messages.length, dropped };
}
