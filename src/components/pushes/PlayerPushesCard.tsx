"use client";

// PLAYER LOOKUP › PUSHES (Figma 20877:72, the amber notes 20877:132): this week against the limit, whether a push can
// reach them, how many they opened in the last 30 days, then their pushes (5, then View all). Backend contract:
// docs/push-notifications.md "Player pushes". Every rule and string is src/lib/playerPushes.ts.
//
// The same Match Ops access as Push Notifications (offersGate): someone without it gets a 404 and the card isn't drawn.

import { useEffect, useState } from "react";
import { KIND_LABEL, canGetView, footerLine, olderAppNote, openedCell, sentLabel, type PlayerPushes, type PushKind } from "@/lib/playerPushes";
import { O, authed } from "@/components/offers/offersUi";

const PILL: Record<PushKind, { bg: string; ink: string }> = {
  MESSAGE: { bg: "#e8eefb", ink: "#2f55b5" }, OFFER: { bg: "#e8f8ef", ink: "#1b7a4e" }, AUTOMATIC: { bg: "#f3f3ef", ink: "#5e6b66" }, TEST: { bg: "#f3f3ef", ink: "#5e6b66" },
};
const GREEN_BG = "#e8f8ef", GREEN_INK = "#1b7a4e", AMBER_BG = "#fff7e6";

export default function PlayerPushesCard({ playerId, env }: { playerId: number; env: string }) {
  const [data, setData] = useState<PlayerPushes | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error" | "mismatch">("loading");
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (all) setBusyAll(true);
      const r = await authed(`/api/pushes/players/${playerId}?limit=${all ? "all" : "5"}&env=${encodeURIComponent(env)}`);
      if (cancelled) return;
      setBusyAll(false);
      // No Match Ops access (404 from the gate, no error text) or signed out: not drawn at all.
      if (r.status === 401 || (r.status === 404 && r.json.error === "Not found")) { setState("hidden"); return; }
      if (r.json.envMismatch === true) { setState("mismatch"); return; }
      if (!r.ok) { setErr(String(r.json.error)); setState("error"); return; }
      setData(r.json as unknown as PlayerPushes); setState("ready");
    })();
    return () => { cancelled = true; };
  }, [playerId, env, all]);

  if (state === "hidden") return null;
  const can = data ? canGetView(data) : null;
  const older = data ? olderAppNote(data) : null;
  return (
    <section data-testid="lookup-pushes" className="mb-3.5 flex flex-col gap-4 rounded-[14px] border px-6 py-[22px]" style={{ background: O.surface, borderColor: O.line }}>
      <div className="flex items-center gap-2.5">
        <h3 className="m-0 text-[15px] font-bold" style={{ color: O.ink }}>Pushes</h3>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: O.muted }}>Last 30 days</span>
      </div>
      {state === "loading" ? <div className="text-[13px]" style={{ color: O.muted }}>Loading pushes…</div>
        : state === "mismatch" ? <div data-testid="lookup-pushes-mismatch" className="text-[13px]" style={{ color: O.muted }}>Pushes are read from the {env === "production" ? "staging" : "production"} backend on this server, so they aren&apos;t shown for this {env} player.</div>
        : state === "error" || !data || !can ? <div data-testid="lookup-pushes-error" className="text-[13px]" style={{ color: O.critInk }}>Couldn&apos;t load pushes: {err}</div>
        : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Tile testId="lookup-pushes-week" label="This week" value={`${data.thisWeek.count} of ${data.thisWeek.limit}`} sub={data.thisWeek.atLimit ? "at the weekly limit" : "toward the weekly limit"} subInk={data.thisWeek.atLimit ? "#b7791f" : undefined} />
              {can.tone === "none" ? (
                <div data-testid="lookup-pushes-can" data-tone="none" className="flex flex-col gap-1 rounded-[10px] px-3.5 py-3" style={{ background: AMBER_BG }}>
                  <div className="text-[13px] font-bold" style={{ color: O.ink }}>{can.title}</div>
                  <div className="text-[12px]" style={{ color: O.ink }}>{can.note}</div>
                </div>
              ) : (
                <Tile testId="lookup-pushes-can" tone={can.tone} label="Can get pushes" value={can.value} sub={can.sub} bg={can.tone === "yes" ? GREEN_BG : undefined} subInk={can.tone === "yes" ? GREEN_INK : undefined} />
              )}
              <Tile testId="lookup-pushes-opened" label="Opened" value={`${data.opened.opened} of ${data.opened.trackable}`} sub="in the last 30 days"
                title={data.opened.trackable < data.opened.total ? `${data.opened.total - data.opened.trackable} automated pushes aren't counted: their opens aren't reported.` : undefined} />
            </div>
            {older && (
              <div data-testid="lookup-pushes-older" className="flex flex-col gap-1 rounded-[10px] px-3.5 py-3" style={{ background: AMBER_BG }}>
                <div className="text-[13px] font-bold" style={{ color: O.ink }}>{older.title}</div>
                <div className="text-[12px]" style={{ color: O.ink }}>{older.note}</div>
              </div>
            )}
            <div className="flex flex-col">
              {data.items.length === 0 && <div data-testid="lookup-pushes-empty" className="border-y py-3 text-[13px]" style={{ borderColor: O.line, color: O.muted }}>No pushes in the last 30 days.</div>}
              {data.items.map((p, i) => (
                <div key={p.pushId} data-testid="lookup-pushes-row" className={`flex items-center gap-3.5 border-b py-3 ${i === 0 ? "border-t" : ""}`} style={{ borderColor: O.line }}>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="truncate text-[13px] font-semibold" style={{ color: O.ink }} title={p.name ?? undefined}>{p.title}</div>
                    <div className="truncate text-[11px]" style={{ color: O.muted }}>{sentLabel(p.sentAt)}{p.match ? ` · ${p.match.name}${p.match.fieldName ? ` at ${p.match.fieldName}` : ""}` : ""}</div>
                  </div>
                  <span className="shrink-0 rounded-full px-2 py-[3px] text-[11px] font-semibold" style={{ background: PILL[p.kind]?.bg ?? O.page, color: PILL[p.kind]?.ink ?? O.muted }}>{KIND_LABEL[p.kind] ?? p.kind}</span>
                  <span className="w-[96px] shrink-0 text-[11px]" style={{ color: p.countsTowardLimit ? O.ink : O.muted }}>{p.countsTowardLimit ? "Counts" : "Doesn't count"}</span>
                  <span className="w-[72px] shrink-0 text-[11px]" style={{ color: p.opened ? GREEN_INK : O.muted }} title={p.opened === null ? "Opens of automated pushes aren't reported." : undefined}>{openedCell(p.opened)}</span>
                </div>
              ))}
            </div>
            <div className="text-[11px]" style={{ color: O.muted }}>
              {footerLine(data.items.length, data.total)}
              {data.total > data.items.length && <> {" "}<button type="button" data-testid="lookup-pushes-all" disabled={busyAll} className="underline" onClick={() => setAll(true)}>{busyAll ? "Loading…" : "View all"}</button></>}
              {all && data.items.length > 5 && <> {" "}<button type="button" className="underline" onClick={() => setAll(false)}>Show 5</button></>}
            </div>
          </>
        )}
    </section>
  );
}

function Tile({ label, value, sub, bg, subInk, testId, tone, title }: { label: string; value: string; sub: string; bg?: string; subInk?: string; testId: string; tone?: string; title?: string }) {
  return (
    <div data-testid={testId} data-tone={tone} title={title} className="flex min-w-0 flex-col gap-0.5 rounded-[10px] px-3.5 py-3" style={{ background: bg ?? O.page }}>
      <div className="text-[12px] font-semibold" style={{ color: O.muted }}>{label}</div>
      <div className="text-[22px] font-bold" style={{ color: O.ink }}>{value}</div>
      <div className="text-[11px]" style={{ color: subInk ?? O.muted }}>{sub}</div>
    </div>
  );
}
