"use client";

// THE PUSH THAT GOES WITH AN OFFER (backend docs/offer-push.md). Only drawn where the server says pushes may be
// seen (GET /api/offers `pushes`): everywhere but production, and on production only OFFERS_PUSH_ACCOUNTS. Every
// rule and string is src/lib/offersPush.ts. Nothing here can send to a player: saving is a write the panel asks
// about first when the offer is already live, and the test goes only to the signed-in person's own phones.

import { useCallback, useEffect, useState } from "react";
import {
  CAP_MAX, CAP_MIN, CUT_OFF_NOTE, FIRST_NAME, MATCH_TOKEN, PUSH_BODY_MAX, PUSH_BODY_SOFT, PUSH_TITLE_MAX, PUSH_TITLE_SOFT, STATUS_TEXT, capLine, fillPush, mayCutOff, pushAfterType, pushLocked,
  pushText, reachAddsUp, reachRows, sendTimeNote, sendsToLine, skippedRows, skippedTotal,
  type CampaignPush, type PushForm, type PushResults, type Reach,
} from "@/lib/offersPush";
import { wallLabel, type MatchOpt } from "@/lib/offersModel";
import { Btn, Chip, O, VerdictLine, authed, inputCls, inputStyle, outcomeOf, type WriteOutcome } from "./offersUi";

const n = (x: number) => x.toLocaleString("en-US");
const toInput = (s: string) => s.replace(" ", "T");
const fromInput = (s: string) => s.replace("T", " ").slice(0, 16);

export function PushSection({ pf, setPf, sugg, scope, match, campaignId, campaignStatus, stored, startsLocal, endsLocal, disabled, problem }: {
  pf: PushForm; setPf: (f: PushForm) => void; sugg: { title: string; body: string }; scope: "ANY" | "FIELD" | "MATCH"; match: MatchOpt | null;
  campaignId: number | null; campaignStatus: string | null; stored: CampaignPush | null | undefined; startsLocal: string; endsLocal: string | null;
  disabled: boolean; problem: string | null;
}) {
  const locked = pushLocked(stored, campaignStatus);
  const off = disabled || locked;
  const t = pushText(pf, sugg);
  const note = sendTimeNote(pf, startsLocal, endsLocal);
  const [test, setTest] = useState<WriteOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  async function sendTest() {
    if (campaignId === null || testing) return;
    setTesting(true);
    try {
      const r = await authed(`/api/offers/${campaignId}/push/test`, { method: "POST", body: JSON.stringify({ title: t.title, body: t.body }) });
      const sent = typeof r.json.sent === "number" ? r.json.sent : 0;
      setTest(outcomeOf(r, `Sent to ${sent} ${sent === 1 ? "phone" : "phones"} of yours${r.json.failed ? `, ${r.json.failed} failed` : ""}. Check your phone.`));
    } finally { setTesting(false); }
  }
  return (
    <div data-testid="offers-push" className="flex flex-col gap-2.5">
      <label className="flex items-center gap-2 text-[13px] font-medium" style={{ color: O.ink }}>
        <input data-testid="offers-push-on" type="checkbox" checked={pf.enabled} disabled={off} onChange={(e) => setPf({ ...pf, enabled: e.target.checked })} />
        Also send as a push
      </label>
      {stored && stored.status !== "OFF" && <div data-testid="offers-push-status" className="text-[12px]" style={{ color: O.muted }}>Push: {STATUS_TEXT[stored.status]}{locked && stored.status !== "NOT_SENT" ? ". It can't change now." : ""}</div>}
      {pf.enabled && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3.5">
            <div className="flex w-[180px] shrink-0 flex-col gap-1.5">
              <PhonePreview title={fillPush(t.title, match)} body={fillPush(t.body, match)} />
              {(t.title.includes(FIRST_NAME) || t.body.includes(FIRST_NAME)) && (
                <div data-testid="offers-push-preview-noname" className="text-[11px] leading-[14px]" style={{ color: O.muted }}>
                  With no first name: <span style={{ color: O.ink }}>{[t.title, t.body].filter((x) => x.includes(FIRST_NAME)).map((x) => fillPush(x, match, null)).join(" / ")}</span>
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <Field label="Title" value={t.title} max={PUSH_TITLE_MAX} long={mayCutOff(t.title, PUSH_TITLE_SOFT, PUSH_TITLE_MAX, match)} testId="offers-push-title" disabled={off}
                typed={pf.title !== undefined} onReset={() => { const x = { ...pf }; delete x.title; setPf(x); }}
                onChange={(v) => setPf(pushAfterType(pf, "title", v, sugg))} />
              <Field label="Body" value={t.body} max={PUSH_BODY_MAX} long={mayCutOff(t.body, PUSH_BODY_SOFT, PUSH_BODY_MAX, match)} rows={4} testId="offers-push-body" disabled={off}
                typed={pf.body !== undefined} onReset={() => { const x = { ...pf }; delete x.body; setPf(x); }}
                onChange={(v) => setPf(pushAfterType(pf, "body", v, sugg))} />
            </div>
          </div>
          <div data-testid="offers-push-hint" className="text-[11.5px] leading-[17px]" style={{ color: O.muted }}>
            <Token>{FIRST_NAME}</Token> becomes the player&apos;s first name, left out with its comma if they have none.{" "}
            <Token>{MATCH_TOKEN}</Token> becomes the match&apos;s name, day and time{scope === "MATCH" ? "" : " (on an offer for a specific match only)"}.
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-[12px] font-medium" style={{ color: O.ink }}>Sends</div>
            <div className="flex flex-nowrap gap-1.5">
              <Chip testId="offers-push-now" on={!pf.at} disabled={off} onClick={() => setPf({ ...pf, at: false })}>{campaignStatus === "LAUNCHED" ? "Now" : "When it launches"}</Chip>
              <Chip testId="offers-push-at" on={pf.at} disabled={off} onClick={() => setPf({ ...pf, at: true })}>At a time</Chip>
            </div>
            {pf.at && (
              <label className="relative flex max-w-[260px] rounded-[8px] border px-3 py-[9px]" style={{ borderColor: O.line, opacity: off ? 0.6 : 1 }}>
                <span data-testid="offers-push-at-label" className="text-[13px]" style={{ color: O.ink }}>{wallLabel(`${pf.sendLocal}:00`)}</span>
                <input data-testid="offers-push-at-input" type="datetime-local" disabled={off} value={toInput(pf.sendLocal)}
                  onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch { /* older browsers */ } }}
                  onChange={(e) => { if (e.target.value) setPf({ ...pf, sendLocal: fromInput(e.target.value) }); }}
                  className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
              </label>
            )}
            <div className="text-[11.5px]" style={{ color: O.muted }}>{pf.at ? "At this time in each player's own city." : campaignStatus === "LAUNCHED" ? "As soon as you save." : "As soon as the offer launches."}</div>
            {note && <div data-testid="offers-push-time-note" className="text-[12px]" style={{ color: O.warnInk }}>{note}</div>}
          </div>
          {problem && <div data-testid="offers-push-problem" className="text-[12px]" style={{ color: O.warnInk }}>{problem}</div>}
          <div className="flex flex-col items-start gap-1.5">
            {campaignId === null && <div data-testid="offers-push-save-first" className="text-[11.5px]" style={{ color: O.muted }}>Save it as a draft first.</div>}
            <Btn testId="offers-push-test" disabled={campaignId === null || testing || !!problem} onClick={sendTest}>Send test push to my phone</Btn>
            <div className="text-[11.5px]" style={{ color: O.muted }}>Goes only to phones signed in to your account. Not counted in results.</div>
            {test && <VerdictLine outcome={test} />}
          </div>
        </div>
      )}
    </div>
  );
}

const Token = ({ children }: { children: React.ReactNode }) => <code className="rounded px-1" style={{ background: O.subtle, color: O.ink }}>{children}</code>;

// long: past the lock-screen length once filled in (mayCutOff), not the template's own length.
function Field({ label, value, max, long, rows, testId, disabled, typed, onReset, onChange }: {
  label: string; value: string; max: number; long: boolean; rows?: number; testId: string; disabled: boolean; typed: boolean; onReset: () => void; onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium" style={{ color: O.ink }}>{label}</span>
        <span className="text-[11px]" style={{ color: value.length > max ? O.critInk : long ? O.warnInk : O.label }}>{value.length}/{max}</span>
      </div>
      {rows
        ? <textarea data-testid={testId} rows={rows} disabled={disabled} className={inputCls} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} />
        : <input data-testid={testId} disabled={disabled} className={inputCls} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} />}
      {long && <div data-testid={`${testId}-long`} className="text-[11.5px]" style={{ color: O.warnInk }}>{CUT_OFF_NOTE}</div>}
      {typed && !disabled && <button type="button" data-testid={`${testId}-reset`} className="self-start text-[11.5px] font-medium" style={{ color: O.ok }} onClick={onReset}>Reset to suggested</button>}
    </div>
  );
}

// A lock-screen notification, at about the size a phone draws one. Production pushes carry no "[STAGE SERVER]".
function PhonePreview({ title, body }: { title: string; body: string }) {
  return (
    <div data-testid="offers-push-preview" className="flex w-[180px] shrink-0 flex-col gap-2 rounded-[22px] p-2.5" style={{ background: "linear-gradient(180deg,#2b3a35,#16211d)" }}>
      <div className="text-center text-[22px] font-light text-white">9:41</div>
      <div className="flex flex-col gap-0.5 rounded-[12px] px-2.5 py-2" style={{ background: "rgba(255,255,255,0.88)" }}>
        <div className="flex items-center justify-between text-[9px] font-semibold" style={{ color: "#555" }}>
          <span className="flex items-center gap-1">
            {/* The app's own icon (frontend ios AppIcon.appiconset/Icon-120.png), copied here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img data-testid="offers-push-preview-icon" alt="" src="/offers/app-icon.png" width={12} height={12} className="block rounded-[3px]" />MATCHDAY
          </span><span>now</span>
        </div>
        <div data-testid="offers-push-preview-title" className="text-[11px] font-semibold leading-[14px]" style={{ color: "#111" }}>{title}</div>
        <div data-testid="offers-push-preview-body" className="text-[10.5px] leading-[13px]" style={{ color: "#222" }}>{body}</div>
      </div>
    </div>
  );
}

// Beside the audience count: who the push reaches, for the SAVED audience, with the breakdown on tap.
export function PushReach({ campaignId, refreshKey }: { campaignId: number | null; refreshKey: string }) {
  const [reach, setReach] = useState<Reach | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    if (campaignId === null) return;
    setErr(null);
    const r = await authed(`/api/offers/${campaignId}/push/reachable`);
    if (r.ok) setReach(r.json as unknown as Reach); else { setReach(null); setErr(String(r.json.error)); }
  }, [campaignId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  if (campaignId === null) return <div data-testid="offers-push-reach" className="self-start text-[12px]" style={{ color: O.muted }}>Push reach shows once it&apos;s saved.</div>;
  if (err) return <div data-testid="offers-push-reach" className="flex flex-wrap gap-1.5 self-start rounded-[8px] px-2.5 py-1.5 text-[12px]" style={{ background: O.critBg, color: O.critInk }}><span>Push reach: {err}</span><button type="button" className="font-semibold underline" onClick={() => void load()}>Retry</button></div>;
  if (!reach) return <div data-testid="offers-push-reach" className="self-start text-[12px]" style={{ color: O.muted }}>Counting who the push reaches…</div>;
  return (
    <div className="flex flex-col gap-1 self-start">
      <button type="button" data-testid="offers-push-reach" onClick={() => setOpen((v) => !v)} className="flex gap-1.5 self-start rounded-[8px] px-2.5 py-1.5 text-left text-[12px]" style={{ background: O.subtle, color: O.ink }}>
        <b>≈ {n(reach.reachable)}</b><span>reachable by push</span><span style={{ color: O.muted }}>{open ? "‹" : "›"}</span>
      </button>
      {open && (
        <div data-testid="offers-push-reach-rows" className="flex flex-col gap-0.5 rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle }}>
          {reachRows(reach).map(([k, v]) => <div key={k} className="flex justify-between gap-4"><span style={{ color: O.muted }}>{k}</span><span style={{ color: O.ink }}>{v < 0 ? `− ${n(-v)}` : n(v)}</span></div>)}
          <div className="flex justify-between gap-4 border-t pt-0.5 font-semibold" style={{ borderColor: O.line, color: O.ink }}><span>Reachable</span><span>{n(reach.reachable)}</span></div>
          {!reachAddsUp(reach) && <div style={{ color: O.warnInk }}>These don&apos;t add up to the backend&apos;s total.</div>}
          <div style={{ color: O.muted }}>For the saved audience, if it went now.</div>
        </div>
      )}
    </div>
  );
}

// In the confirm before a push goes (launch with a push, or queueing one on a live offer): who it reaches, read
// fresh when the dialog opens. campaignId null: the audience isn't saved yet, so there is nothing to count.
export function SendsTo({ campaignId }: { campaignId: number | null }) {
  const [line, setLine] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => {
    if (campaignId === null) return;
    let cancelled = false;
    (async () => {
      const r = await authed(`/api/offers/${campaignId}/push/reachable`);
      if (cancelled) return;
      const reach = r.json as unknown as Reach;
      setLine(r.ok && typeof reach.reachable === "number" ? { text: sendsToLine(reach.reachable), bad: false } : { text: `Couldn't count who the push reaches: ${String(r.json.error ?? "no count came back")}`, bad: true });
    })();
    return () => { cancelled = true; };
  }, [campaignId]);
  const text = campaignId === null ? "How many players it sends to is counted once the offer is saved." : line?.text ?? "Counting who it sends to…";
  return <span data-testid="offers-confirm-sends-to" style={{ color: line?.bad ? O.critInk : line ? O.ink : O.muted, fontWeight: line && !line.bad ? 600 : 400 }}>{text}</span>;
}

// On the results card, beside the popup's numbers.
export function PushResultsRow({ campaignId }: { campaignId: number }) {
  const [res, setRes] = useState<PushResults | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await authed(`/api/offers/${campaignId}/push/results`);
      if (cancelled) return;
      if (r.ok) setRes(r.json as unknown as PushResults); else setErr(String(r.json.error));
    })();
    return () => { cancelled = true; };
  }, [campaignId]);
  if (err) return <div data-testid="offers-push-results" className="px-3 text-[12px]" style={{ color: O.critInk }}>Push results: {err}</div>;
  if (!res) return <div data-testid="offers-push-results" className="px-3 text-[12px]" style={{ color: O.muted }}>Loading push results…</div>;
  const skipped = skippedTotal(res.skipped);
  return (
    <div data-testid="offers-push-results" className="flex flex-col gap-1 rounded-[8px] px-3 py-2 text-[13px]" style={{ background: O.subtle }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5" style={{ color: O.ink }}>
        <b>Push</b>
        <span>{n(res.sent)} sent</span>
        <button type="button" data-testid="offers-push-skipped" className="underline decoration-dotted" onClick={() => setOpen((v) => !v)}>{n(skipped)} skipped</button>
        <span>{n(res.opened)} opened</span>
        <span>{n(res.bookedWithin72h)} booked within 72 hours</span>
        {res.failed > 0 && <span style={{ color: O.warnInk }}>{n(res.failed)} failed</span>}
        <span className="text-[12px]" style={{ color: O.muted }}>{STATUS_TEXT[res.status]}</span>
      </div>
      {open && (
        <div data-testid="offers-push-skipped-rows" className="flex flex-col gap-0.5 text-[12px]">
          {skippedRows(res.skipped).map(([k, v]) => <div key={k} className="flex justify-between gap-4"><span style={{ color: O.muted }}>{k}</span><span style={{ color: O.ink }}>{n(v)}</span></div>)}
        </div>
      )}
    </div>
  );
}

// THE SHARED WEEKLY LIMIT, one number for every marketing push.
export function PushSettingsCard({ onClose }: { onClose: () => void }) {
  const [cap, setCap] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      const r = await authed("/api/offers/push-settings");
      if (r.ok && typeof r.json.weeklyCap === "number") { setCap(r.json.weeklyCap); setSaved(r.json.weeklyCap); } else setErr(String(r.json.error ?? "Couldn't read the limit."));
    })();
  }, []);
  async function save() {
    if (cap === null || busy) return;
    setBusy(true);
    try {
      const r = await authed("/api/offers/push-settings", { method: "PUT", body: JSON.stringify({ weeklyCap: cap }) });
      const o = outcomeOf(r, `Saved: ${cap} per player in any 7 days.`);
      setOutcome(o);
      if (o.verdict === "LANDED") setSaved(cap);
    } finally { setBusy(false); }
  }
  return (
    <div data-testid="offers-push-settings" className="mb-5 flex flex-col gap-2.5 rounded-[12px] border p-4" style={{ background: O.surface, borderColor: O.line }}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-[15px] font-bold" style={{ color: O.ink }}>Marketing push limit</div>
        <button type="button" aria-label="Close" onClick={onClose} className="text-[14px] leading-none" style={{ color: O.muted }}>✕</button>
      </div>
      {err ? <div className="text-[12.5px]" style={{ color: O.critInk }}>{err}</div> : cap === null ? <div className="text-[12.5px]" style={{ color: O.muted }}>Loading…</div> : (
        <>
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-[18px] rounded-[8px] border px-2.5 py-[7px] text-[14px]" style={{ borderColor: O.line }}>
              <button type="button" data-testid="offers-cap-minus" disabled={cap <= CAP_MIN} onClick={() => setCap(Math.max(CAP_MIN, cap - 1))} className="font-medium disabled:opacity-40" style={{ color: O.muted }}>–</button>
              <span data-testid="offers-cap" className="min-w-[14px] text-center font-bold" style={{ color: O.ink }}>{cap}</span>
              <button type="button" data-testid="offers-cap-plus" disabled={cap >= CAP_MAX} onClick={() => setCap(Math.min(CAP_MAX, cap + 1))} className="font-medium disabled:opacity-40" style={{ color: O.muted }}>+</button>
            </div>
            <span className="text-[13px]" style={{ color: O.ink }}>per player in any 7 days</span>
            <Btn kind="primary" testId="offers-cap-save" disabled={busy || cap === saved} onClick={save}>Save</Btn>
          </div>
          <div data-testid="offers-cap-line" className="text-[12px]" style={{ color: O.muted }}>{capLine(cap)}</div>
          {outcome && <VerdictLine outcome={outcome} />}
        </>
      )}
    </div>
  );
}
