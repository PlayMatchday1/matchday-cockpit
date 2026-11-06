"use client";

// SEND TEST (Figma 20842:74), in Push Notifications' Message card and in the Offers push section: a Send to box (a
// player ID or an email, remembered in this browser), who that is, Send test, and what happened.
//
// It goes to the player in the box, any player (backend e9e90a7: targetUserId / targetEmail on both test routes; the
// backend logs every attempt). Empty sends to the signed-in person. A refusal comes back in plain words ("Not sent:
// #28 has no phone signed in.").

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import type { TokenLookup } from "@/lib/audienceModel";
import { Btn, O, authed } from "@/components/offers/offersUi";

const KEY = "clubhouse.sendTestTo";
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const keep = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* private window: not remembered */ } };
// Your own player id, looked up once by your email.
const selfIds = new Map<string, Promise<number | null>>();
function selfIdOf(email: string): Promise<number | null> {
  let p = selfIds.get(email);
  if (!p) {
    p = authed("/api/audiences/lookup", { method: "POST", body: JSON.stringify({ text: email }) }).then((r) => (r.ok ? ((r.json as unknown as TokenLookup).players[0]?.id ?? null) : null));
    selfIds.set(email, p);
  }
  return p;
}

export type TestAnswer = { ok: true; sent: number; failed: number; devices?: number } | { ok: false; error: string };
export default function SendTestBox({ send, blockedWhy, testId, onOffers = false }: {
  send: (to: string) => Promise<TestAnswer>; blockedWhy?: string | null; testId: string; onOffers?: boolean;
}) {
  const { appUser } = useAuth();
  const me = (appUser?.email ?? "").toLowerCase();
  const [to, setTo] = useState<string>("");
  useEffect(() => { setTo((v) => v || read() || me); }, [me]);
  const [selfId, setSelfId] = useState<number | null>(null);
  useEffect(() => { if (me) void selfIdOf(me).then(setSelfId); }, [me]);
  const [who, setWho] = useState<{ for: string; player: TokenLookup["players"][number] | null; error?: string } | null>(null);
  useEffect(() => {
    const v = to.trim();
    if (!v) { setWho(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/audiences/lookup", { method: "POST", body: JSON.stringify({ text: v }) });
      if (cancelled) return;
      setWho(r.ok ? { for: v, player: (r.json as unknown as TokenLookup).players[0] ?? null } : { for: v, player: null, error: String(r.json.error) });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [to]);
  const v = to.trim();
  const current = who && who.for === v ? who : null;
  const isMe = v.toLowerCase() === me || (!!current?.player && selfId !== null && current.player.id === selfId);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ ok: boolean; text: string }[]>([]);
  async function go() {
    if (busy) return;
    setBusy(true);
    keep(v);
    try {
      const a = await send(v);
      const label = current?.player ? `#${current.player.id}` : v;
      const phones = (k: number) => `${k} ${k === 1 ? "phone" : "phones"}`;
      const line = !a.ok ? { ok: false, text: `Not sent: ${a.error}` }
        : a.sent === 0 ? { ok: false, text: `Not sent: ${label} has no phone signed in${a.failed ? ` (${phones(a.failed)} failed)` : ""}.` }
        : { ok: a.failed === 0, text: `Sent to ${phones(a.sent)}${a.failed ? `; ${phones(a.failed)} failed` : ""}. Doesn't count toward the weekly limit.` };
      setLines((xs) => [line, ...xs].slice(0, 3));
    } finally { setBusy(false); }
  }
  const why = blockedWhy ?? (!v ? "Type a player ID or email." : !/^#?\d+$/.test(v) && !v.includes("@") ? "Send to takes a player ID or an email." : null);
  return (
    <div data-testid={testId} className="flex flex-col gap-2 rounded-[10px] border px-3.5 py-3" style={{ borderColor: O.line }}>
      <div className="text-[12px] font-semibold" style={{ color: O.ink }}>Send test</div>
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex w-full items-center gap-1.5 rounded-[8px] border bg-white px-3 py-[9px] text-[13px] sm:w-[280px]" style={{ borderColor: O.line }}>
          <span className="font-medium" style={{ color: O.muted }}>Send to</span>
          <input data-testid={`${testId}-to`} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send to: player ID or email" className="min-w-0 flex-1 font-semibold outline-none" style={{ color: O.ink }} />
        </label>
        <span data-testid={`${testId}-who`} className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: current?.player ? O.ink : O.muted }}>
          {!v ? "" : !current ? "Looking…" : current.error ? `Couldn't look it up: ${current.error}` : current.player ? `${current.player.name ?? "No name"} (#${current.player.id})${isMe ? " · you" : ""}${current.player.allowPushes === false ? " · pushes off" : ""}` : `Nobody found for ${v}`}
        </span>
        <Btn testId={`${testId}-send`} disabled={busy || !!why} title={why ?? undefined} onClick={go}>{busy ? "Sending…" : "Send test"}</Btn>
      </div>
      {why && <div data-testid={`${testId}-why`} className="text-[12px]" style={{ color: O.muted }}>{why}</div>}
      {lines.map((l, i) => (
        <div key={i} data-testid={`${testId}-line`} data-ok={l.ok ? "1" : "0"} className="self-start rounded-[8px] px-2.5 py-1.5 text-[12px] font-semibold" style={l.ok ? { background: O.mint, color: O.chipOn } : { background: "#fff2d9", color: "#8c590d" }}>{l.text}</div>
      ))}
      <div className="text-[12px]" style={{ color: O.muted }}>Remembers the last player you used.{onOffers ? "" : " Same box on Offers."}</div>
    </div>
  );
}
