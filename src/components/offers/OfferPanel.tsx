"use client";

// ONE OFFER, top to bottom (Figma 20571:334; the specific-match state is 20581:54): Name, The deal,
// Who gets it (with the live count), Popup (live preview, text written from the deal and editable
// behind Edit text), Runs, More options (holdout, use cap), the summary with the most it can cost,
// then Launch. After launch the deal, the audience and the dates are locked (the backend refuses
// them); the name, the popup text and the use cap can still change, and Pause and End appear.
//
// SEND TO MY PHONE is shown disabled: the backend has no endpoint that puts one offer on one phone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  amountText, audienceBody, chicagoWallNow, copyOf, createBody, defaultRun, endsTicket, formOf, formProblem, fromInput, matchInfo,
  matchShort, newForm, patchBody, pickedMatch, startLabel, STEPPER, summary, toInput, wallLabel,
  type Campaign, type City, type Count, type CopyKey, type DealType, type Form, type MatchOpt,
} from "@/lib/offersModel";
import OfferPopupPreview from "./OfferPopupPreview";
import {
  Btn, Chip, ConfirmDialog, Labeled, O, PanelSection, VerdictLine, authed, inputCls, inputStyle, outcomeOf, settled, type WriteOutcome,
} from "./offersUi";

type Data = { campaigns: Campaign[]; cities: City[]; matches: MatchOpt[] };
const DEALS: { type: DealType; label: string }[] = [
  { type: "PERCENT_OFF", label: "% off" }, { type: "AMOUNT_OFF", label: "$ off" }, { type: "SET_PRICE", label: "Set price" }, { type: "FREE_MATCH", label: "Free match" },
];
const NO_PHONE = "Not built yet: the backend has no endpoint that sends one offer to one phone.";

export default function OfferPanel({ c, data, onClose, onLanded }: {
  c: Campaign | null; data: Data; onClose: () => void; onLanded: (o: WriteOutcome, selectId?: number) => void;
}) {
  const nowWall = useMemo(() => chicagoWallNow(), []);
  const start = useMemo(() => (c ? formOf(c, data.matches, data.cities) : newForm(nowWall)), [c, data, nowWall]);
  const [f, setF] = useState<Form>(start);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const locked = c !== null && c.status !== "DRAFT";
  const ended = c?.status === "ENDED";
  const m = pickedMatch(f, data.matches);
  const copy = copyOf(f, data.matches, data.cities);
  const problem = formProblem(f, data.matches);
  const diff = c ? patchBody(c, f, data.matches, data.cities) : null;
  const dirty = c === null || Object.keys(diff ?? {}).length > 0;

  // ── the live count, debounced, for the audience and deal as they stand ──
  const [count, setCount] = useState<Count | null>(null);
  const [countErr, setCountErr] = useState<string | null>(null);
  const audKey = JSON.stringify(audienceBody(f, data.matches, data.cities));
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/offers/audience", { method: "POST", body: audKey });
      if (cancelled) return;
      if (!r.ok) { setCountErr(String(r.json.error)); setCount(null); return; }
      setCountErr(null); setCount(r.json as unknown as Count);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [audKey]);

  // ── writes ──
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [confirm, setConfirm] = useState<null | "launch" | "pause" | "end">(null);
  const inFlight = useRef(false);
  const send = useCallback(async (path: string, method: "POST" | "PATCH", body: unknown, landed: string) => {
    const r = await authed(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { o: outcomeOf(r, landed), after: (r.json.after ?? null) as Campaign | null };
  }, []);
  async function once<T>(fn: () => Promise<T>): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current = true; setBusy(true);
    try { return await fn(); } finally { inFlight.current = false; setBusy(false); }
  }

  // Save: create a draft, or send only what changed.
  async function save(): Promise<{ o: WriteOutcome; id: number | null }> {
    if (c === null) {
      const { o, after } = await send("/api/offers", "POST", createBody(f, data.matches, data.cities), `Saved "${f.name.trim()}" as a draft.`);
      return { o, id: after?.id ?? null };
    }
    if (!dirty) return { o: { verdict: "LANDED", text: "Nothing to save." }, id: c.id };
    const { o } = await send(`/api/offers/${c.id}`, "PATCH", diff, `Saved changes to "${f.name.trim()}".`);
    return { o, id: c.id };
  }
  async function onSave() {
    const r = await once(save);
    if (!r) return;
    setOutcome(r.o);
    if (r.o.verdict === "LANDED") onLanded(r.o, r.id ?? undefined);
  }
  // Launch (or resume): save first when there is anything to save, then launch. Two writes, in order;
  // the second goes only if the first LANDED. Neither is retried.
  async function launch(): Promise<WriteOutcome> {
    let id = c?.id ?? null;
    if (c === null || (c.status === "DRAFT" && dirty)) {
      const s = await save();
      if (s.o.verdict !== "LANDED" || s.id === null) return c === null && s.o.verdict === "LANDED" ? { verdict: "UNKNOWN", text: "Saved, but the new offer's id did not come back. Refresh before launching." } : s.o;
      id = s.id;
    }
    const resume = c?.status === "PAUSED";
    const { o } = await send(`/api/offers/${id}/launch`, "POST", undefined, resume ? `Resumed "${f.name.trim()}".` : `Launched "${f.name.trim()}".`);
    if (o.verdict !== "LANDED" && c === null) return { ...o, text: `Saved as a draft, but the launch did not land: ${o.text}` };
    if (o.verdict === "LANDED") onLanded(o, id ?? undefined);
    return o;
  }
  async function move(action: "pause" | "end"): Promise<WriteOutcome> {
    const { o } = await send(`/api/offers/${c!.id}/${action}`, "POST", undefined, action === "pause" ? `Paused "${c!.name}".` : `Ended "${c!.name}".`);
    if (o.verdict === "LANDED") onLanded(o, c!.id);
    return o;
  }

  // ── deal controls ──
  const pickDeal = (type: DealType) => set({ dealType: type, dealAmount: STEPPER[type]?.start ?? 0 });
  const step = (dir: 1 | -1) => {
    const s = STEPPER[f.dealType];
    if (!s) return;
    set({ dealAmount: Math.min(s.max, Math.max(s.min, f.dealAmount + dir * s.step)) });
  };
  const pickScope = (scope: "ANY" | "MATCH") => {
    if (scope === f.scope) return;
    if (scope === "ANY") set({ scope, matchId: null, playedAtMatchField: false, endsLocal: defaultRun(nowWall).endsLocal });
    else set({ scope, usesPerPlayer: 1 });
  };
  const pickMatch = (id: number | null) => {
    const mm = data.matches.find((x) => x.id === id) ?? null;
    // A specific match's offer ends at its kickoff unless someone moves it.
    set({ matchId: id, ...(mm ? { endsLocal: mm.startLocal } : {}) });
  };
  const upcoming = data.matches.filter((x) => x.upcoming && (f.cityIds.length === 0 || (x.cityId !== null && f.cityIds.includes(x.cityId))));
  const matchChoices = m && !upcoming.some((x) => x.id === m.id) ? [m, ...upcoming] : upcoming;

  // ── who gets it ──
  const [addingCity, setAddingCity] = useState(false);
  const otherCities = data.cities.filter((x) => !f.cityIds.includes(x.id));
  const lastPlayedOn = (lp: Form["lastPlayed"], days: number | null) => f.lastPlayed === lp && (lp !== "LAPSED" || f.lastPlayedDays === days);
  const oddLapse = f.lastPlayed === "LAPSED" && f.lastPlayedDays !== 30 && f.lastPlayedDays !== 60;

  // ── popup text ──
  const [editText, setEditText] = useState(false);
  const setCopy = (k: CopyKey, v: string) => setF((x) => ({ ...x, copy: { ...x.copy, [k]: v } }));
  const [more, setMore] = useState(false);
  const ends = endsTicket(f.endsLocal, nowWall);
  const dl = locked || ended; // deal, audience and run locked

  const title = c ? c.name || "Untitled offer" : f.name.trim() || "New offer";
  return (
    <div data-testid="offers-panel" data-status={c?.status ?? "NEW"} className="overflow-hidden rounded-[12px] shadow-[0_4px_16px_rgba(0,51,38,0.08)]" style={{ background: O.surface }}>
      {/* HEAD */}
      <div className="flex flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 truncate text-[20px] font-bold" style={{ color: O.ink }}>{title}</div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-[16px] leading-none" style={{ color: O.muted }}>✕</button>
        </div>
        <Labeled label="Name">
          <input data-testid="offers-name" className={inputCls} style={inputStyle} value={f.name} disabled={ended} placeholder="Austin win-back"
            onChange={(e) => set({ name: e.target.value })} />
        </Labeled>
        {locked && !ended && (
          <div data-testid="offers-locked-note" className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>
            Launched, so the deal, who gets it and when it runs are locked. The name, the popup text and the use cap can still change.
          </div>
        )}
        {ended && <div className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Ended. Nothing about it can change.</div>}
      </div>

      {/* THE DEAL */}
      <PanelSection title="The deal" testId="offers-deal">
        <div className="flex flex-wrap gap-1.5">
          {DEALS.map((d) => <Chip key={d.type} testId={`offers-deal-${d.type}`} on={f.dealType === d.type} disabled={dl} onClick={() => pickDeal(d.type)}>{d.label}</Chip>)}
        </div>
        {(STEPPER[f.dealType] || (!m && f.dealType === "FREE_MATCH")) && (
          <div className="flex flex-wrap items-center gap-2.5">
            {STEPPER[f.dealType] && (
              <>
                <div className="flex items-center gap-[18px] rounded-[8px] border px-2.5 py-[7px] text-[14px]" style={{ borderColor: O.line, opacity: dl ? 0.6 : 1 }}>
                  <button type="button" data-testid="offers-minus" disabled={dl} onClick={() => step(-1)} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>–</button>
                  <span data-testid="offers-amount" className="min-w-[34px] text-center font-bold" style={{ color: O.ink }}>{amountText(f.dealType, f.dealAmount)}</span>
                  <button type="button" data-testid="offers-plus" disabled={dl} onClick={() => step(1)} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>+</button>
                </div>
                <span className="text-[13px]" style={{ color: O.ink }}>{f.dealType === "SET_PRICE" ? "for their spot" : "off"}</span>
              </>
            )}
            {!m && (
              <div className="flex gap-1.5">
                {[1, 3].map((n) => <Chip key={n} testId={`offers-uses-${n}`} on={f.usesPerPlayer === n} disabled={dl} onClick={() => set({ usesPerPlayer: n })}>{n === 1 ? "1 match" : "3 matches"}</Chip>)}
                {f.usesPerPlayer !== 1 && f.usesPerPlayer !== 3 && <Chip on>{`${f.usesPerPlayer} matches`}</Chip>}
              </div>
            )}
          </div>
        )}
        {m && f.dealType === "SET_PRICE" && f.dealAmount >= m.price && (
          <div className="text-[12px]" style={{ color: O.warnInk }}>That is not less than its normal {amountText("SET_PRICE", m.price)}, so nobody saves anything.</div>
        )}
        <Labeled label="Applies to">
          <div className="flex flex-wrap gap-1.5">
            <Chip testId="offers-scope-ANY" on={f.scope === "ANY"} disabled={dl} onClick={() => pickScope("ANY")}>Any match</Chip>
            <Chip testId="offers-scope-MATCH" on={f.scope === "MATCH"} disabled={dl} onClick={() => pickScope("MATCH")}>A specific match</Chip>
          </div>
        </Labeled>
        {f.scope === "MATCH" && (
          <>
            <Labeled label="Match">
              <div className="relative">
                <select data-testid="offers-match" className={`${inputCls} appearance-none pr-8 font-medium`} style={inputStyle} disabled={dl}
                  value={f.matchId ?? ""} onChange={(e) => pickMatch(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{matchChoices.length ? "Pick a match" : "No upcoming matches in these cities"}</option>
                  {matchChoices.map((x) => <option key={x.id} value={x.id}>{matchShort(x)}</option>)}
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px]" style={{ color: O.muted }}>⌄</span>
              </div>
            </Labeled>
            {m && <div data-testid="offers-match-info" className="rounded-[8px] px-3 py-[9px] text-[12px]" style={{ background: O.subtle, color: O.muted }}>{matchInfo(m)}</div>}
          </>
        )}
      </PanelSection>

      {/* WHO GETS IT */}
      <PanelSection title="Who gets it" testId="offers-who">
        <Labeled label="City">
          <div className="flex flex-wrap gap-1.5">
            {f.cityIds.map((id) => (
              <Chip key={id} on disabled={dl} title={dl ? undefined : "Remove"} onClick={() => set({ cityIds: f.cityIds.filter((x) => x !== id) })}>
                {`${data.cities.find((x) => x.id === id)?.name ?? `City ${id}`}  ×`}
              </Chip>
            ))}
            {f.cityIds.length === 0 && <span className="self-center text-[12px]" style={{ color: O.muted }}>All cities</span>}
            {!dl && otherCities.length > 0 && <Chip testId="offers-add-city" on={false} onClick={() => setAddingCity((v) => !v)}>+ City</Chip>}
          </div>
          {addingCity && !dl && (
            <div className="flex flex-wrap gap-1.5 rounded-[8px] p-2" style={{ background: O.subtle }}>
              {otherCities.map((x) => <Chip key={x.id} testId={`offers-city-${x.id}`} on={false} onClick={() => { set({ cityIds: [...f.cityIds, x.id] }); setAddingCity(false); }}>{x.name}</Chip>)}
            </div>
          )}
        </Labeled>
        <Labeled label="Last played">
          <div className="flex flex-wrap gap-1.5">
            <Chip testId="offers-lp-any" on={lastPlayedOn("ANY", null)} disabled={dl} onClick={() => set({ lastPlayed: "ANY", lastPlayedDays: null })}>Any time</Chip>
            <Chip testId="offers-lp-30" on={lastPlayedOn("LAPSED", 30)} disabled={dl} onClick={() => set({ lastPlayed: "LAPSED", lastPlayedDays: 30 })}>30+ days ago</Chip>
            <Chip testId="offers-lp-60" on={lastPlayedOn("LAPSED", 60)} disabled={dl} onClick={() => set({ lastPlayed: "LAPSED", lastPlayedDays: 60 })}>60+ days ago</Chip>
            {oddLapse && <Chip on>{`${f.lastPlayedDays}+ days ago`}</Chip>}
            <Chip testId="offers-lp-never" on={lastPlayedOn("NEVER", null)} disabled={dl} onClick={() => set({ lastPlayed: "NEVER", lastPlayedDays: null })}>Never</Chip>
          </div>
        </Labeled>
        {m && (
          <Labeled label="Played here before">
            <div className="flex flex-wrap gap-1.5">
              <Chip testId="offers-field-any" on={!f.playedAtMatchField} disabled={dl} onClick={() => set({ playedAtMatchField: false })}>{f.cityIds.length ? "Anyone in the city" : "Anyone"}</Chip>
              <Chip testId="offers-field-yes" on={f.playedAtMatchField} disabled={dl} onClick={() => set({ playedAtMatchField: true })}>{`Played at ${m.fieldTitle ?? "this field"} before`}</Chip>
            </div>
          </Labeled>
        )}
        <Labeled label="Membership">
          <div className="flex flex-wrap gap-1.5">
            <Chip testId="offers-mem-ANYONE" on={f.membership === "ANYONE"} disabled={dl} onClick={() => set({ membership: "ANYONE" })}>Anyone</Chip>
            <Chip testId="offers-mem-MEMBERS" on={f.membership === "MEMBERS"} disabled={dl} onClick={() => set({ membership: "MEMBERS" })}>Members</Chip>
            <Chip testId="offers-mem-NON_MEMBERS" on={f.membership === "NON_MEMBERS"} disabled={dl} onClick={() => set({ membership: "NON_MEMBERS" })}>Not members</Chip>
          </div>
        </Labeled>
        {(f.minMatches > 0 || f.maxMatches !== null) && (
          <div className="text-[12px]" style={{ color: O.muted }}>Also: {f.maxMatches === f.minMatches ? `played exactly ${f.minMatches}` : f.maxMatches !== null ? `played ${f.minMatches} to ${f.maxMatches}` : `played ${f.minMatches}+`} matches (set outside this page).</div>
        )}
        <div data-testid="offers-count" className="flex gap-1.5 self-start rounded-[8px] px-2.5 py-1.5 text-[12px]" style={{ background: countErr ? O.critBg : O.mint, color: countErr ? O.critInk : O.ok }}>
          {countErr ? <span>Couldn&apos;t count: {countErr}</span>
            : count ? <><b>≈ {count.count.toLocaleString("en-US")} {count.count === 1 ? "player" : "players"}</b><span>match right now</span></>
            : <span>Counting…</span>}
        </div>
      </PanelSection>

      {/* POPUP */}
      <PanelSection title="Popup" testId="offers-popup">
        <div className="flex items-start gap-3.5">
          <OfferPopupPreview copy={copy} ends={ends} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="text-[12px] leading-[17px]" style={{ color: O.muted }}>Written for you from the deal. Change any line if you want.</div>
            {([["Headline", copy.headline], ["Line", copy.line], ["Photo", copy.photoUrl ? "Custom photo" : "MatchDay field photo"], ["Button", copy.buttonLabel]] as const).map(([k, v]) => (
              <div key={k} className="flex flex-col gap-[3px] font-medium">
                <div className="text-[11px]" style={{ color: O.label }}>{k}</div>
                <div className="break-words text-[13px]" style={{ color: O.ink }}>{v || "None"}</div>
              </div>
            ))}
            {!ended && (
              <button type="button" data-testid="offers-edit-text" onClick={() => setEditText((v) => !v)} className="self-start text-[12px] font-semibold" style={{ color: O.ok }}>
                {editText ? "Done ‹" : "Edit text ›"}
              </button>
            )}
          </div>
        </div>
        {editText && !ended && (
          <div data-testid="offers-text-fields" className="flex flex-col gap-2 rounded-[8px] p-3" style={{ background: O.subtle }}>
            <div className="text-[11.5px]" style={{ color: O.muted }}>An empty line goes back to the text written from the deal.</div>
            {([["eyebrow", "Tag on the photo", 64], ["headline", "Headline (last word in green)", 64], ["line", "Line", 64], ["body", "Body", 300], ["buttonLabel", "Button", 64], ["dismissLabel", "Dismiss link", 64]] as const).map(([k, label, max]) => {
              const auto = copyOf({ ...f, copy: {} }, data.matches, data.cities)[k] ?? "";
              return (
                <label key={k} className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium" style={{ color: O.label }}>{label}</span>
                  {k === "body"
                    ? <textarea data-testid={`offers-copy-${k}`} rows={2} maxLength={max} className={inputCls} style={inputStyle} placeholder={auto} value={f.copy[k] ?? ""} onChange={(e) => setCopy(k, e.target.value)} />
                    : <input data-testid={`offers-copy-${k}`} maxLength={max} className={inputCls} style={inputStyle} placeholder={auto} value={f.copy[k] ?? ""} onChange={(e) => setCopy(k, e.target.value)} />}
                </label>
              );
            })}
          </div>
        )}
      </PanelSection>

      {/* RUNS */}
      <PanelSection title="Runs" testId="offers-runs">
        <div className="flex items-center gap-2">
          <WallInput testId="offers-starts" label={startLabel(f.startsLocal, nowWall)} value={f.startsLocal} disabled={dl} onChange={(v) => set({ startsLocal: v })} />
          <span className="text-[13px]" style={{ color: O.muted }}>to</span>
          <WallInput testId="offers-ends" label={m && f.endsLocal === m.startLocal ? `Kickoff · ${wallLabel(f.endsLocal)}` : wallLabel(f.endsLocal)} value={f.endsLocal} disabled={dl} onChange={(v) => set({ endsLocal: v })} />
        </div>
        <div className="text-[11.5px]" style={{ color: O.muted }}>Times are each player&apos;s own city time.</div>
        <button type="button" data-testid="offers-more" onClick={() => setMore((v) => !v)} className="flex w-full items-center justify-between gap-2 rounded-[8px] px-3 py-[9px] text-left text-[12px]" style={{ background: O.subtle }}>
          <span className="font-medium" style={{ color: O.ink }}>More options</span>
          <span style={{ color: O.muted }}>{f.holdoutPercent > 0 ? `${f.holdoutPercent}% held back to measure` : "Nobody held back"} · {f.maxRedemptions ? `Cap of ${f.maxRedemptions.toLocaleString("en-US")} uses` : "No use cap"} {more ? "‹" : "›"}</span>
        </button>
        {more && (
          <div data-testid="offers-more-fields" className="flex flex-col gap-3 rounded-[8px] border p-3" style={{ borderColor: O.line }}>
            <Labeled label="Held back to measure">
              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-[18px] rounded-[8px] border px-2.5 py-[7px] text-[14px]" style={{ borderColor: O.line, opacity: dl ? 0.6 : 1 }}>
                  <button type="button" disabled={dl} onClick={() => set({ holdoutPercent: Math.max(0, f.holdoutPercent - 5) })} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>–</button>
                  <span data-testid="offers-holdout" className="min-w-[34px] text-center font-bold" style={{ color: O.ink }}>{f.holdoutPercent}%</span>
                  <button type="button" disabled={dl} onClick={() => set({ holdoutPercent: Math.min(50, f.holdoutPercent + 5) })} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>+</button>
                </div>
              </div>
              <div className="text-[11.5px]" style={{ color: O.muted }}>These players get no offer and no popup, so their bookings show what the offer changed.</div>
            </Labeled>
            <Labeled label="Use cap">
              <input data-testid="offers-cap" type="number" min={1} inputMode="numeric" className={inputCls} style={inputStyle} disabled={ended} placeholder="No cap"
                value={f.maxRedemptions ?? ""} onChange={(e) => set({ maxRedemptions: e.target.value === "" ? null : Math.floor(Number(e.target.value)) })} />
              <div className="text-[11.5px]" style={{ color: O.muted }}>The most uses in total, across every player. Empty means no cap.</div>
            </Labeled>
          </div>
        )}
      </PanelSection>

      {/* LAUNCH */}
      <section className="flex flex-col gap-2.5 border-t p-4" style={{ borderColor: O.line }}>
        <p data-testid="offers-summary" className="text-[13px] font-medium leading-[19px]" style={{ color: O.ink }}>
          {summary(f, count, data.matches, data.cities, nowWall)}
        </p>
        {outcome && <VerdictLine outcome={outcome} />}
        {problem && !ended && dirty && <div data-testid="offers-problem" className="text-[12px]" style={{ color: O.warnInk }}>{problem}</div>}
        {!ended && (
          <div className="flex flex-wrap gap-2">
            {(c === null || c.status === "DRAFT") && (
              <Btn kind="primary" testId="offers-launch" disabled={busy || !!problem} onClick={() => setConfirm("launch")}>Launch</Btn>
            )}
            {c?.status === "PAUSED" && <Btn kind="primary" testId="offers-resume" disabled={busy || dirty} title={dirty ? "Save or undo your changes first" : undefined} onClick={() => setConfirm("launch")}>Resume</Btn>}
            {(c === null || dirty) && (
              <Btn testId="offers-save" disabled={busy || !!problem || (c !== null && settled(outcome) && !dirty)} onClick={onSave}>{c === null ? "Save draft" : "Save changes"}</Btn>
            )}
            {c?.status === "LAUNCHED" && <Btn testId="offers-pause" disabled={busy} onClick={() => setConfirm("pause")}>Pause</Btn>}
            {(c?.status === "LAUNCHED" || c?.status === "PAUSED") && <Btn kind="danger" testId="offers-end" disabled={busy} onClick={() => setConfirm("end")}>End</Btn>}
            <Btn testId="offers-phone" disabled title={NO_PHONE}>Send to my phone</Btn>
          </div>
        )}
        {!ended && <div data-testid="offers-phone-note" className="text-[11.5px]" style={{ color: O.muted }}>{NO_PHONE}</div>}
      </section>

      {confirm === "launch" && (
        <ConfirmDialog title={c?.status === "PAUSED" ? `Resume ${f.name.trim()}?` : `Launch ${f.name.trim()}?`}
          note={c?.status === "PAUSED" ? "Players who match start getting it again the next time they open the app." : `${summary(f, count, data.matches, data.cities, nowWall)} After launch the deal, who gets it and when it runs can't change.`}
          action={c?.status === "PAUSED" ? "Resume" : "Launch"} onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(launch); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
      {confirm === "pause" && (
        <ConfirmDialog title={`Pause ${c!.name}?`} note="Nobody new gets it and no popup shows. Players who already have it can still use it until it expires. You can resume it."
          action="Pause" onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(() => move("pause")); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
      {confirm === "end" && (
        <ConfirmDialog title={`End ${c!.name} for good?`} kind="dangerSolid" note="Nobody new gets it and no popup shows. Players who already have it can still use it until it expires. It can't be launched again."
          action="End" onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(() => move("end")); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
    </div>
  );
}

// A wall-clock time that reads like the mock ("Today", "Sun, Nov 2 · 11:59 PM") and opens the
// browser's own picker. The value stays wall-clock text end to end; no Date is built from it.
function WallInput({ label, value, onChange, disabled, testId }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; testId: string }) {
  return (
    <label className="relative flex min-w-0 flex-1 rounded-[8px] border px-3 py-[9px]" style={{ borderColor: O.line, background: O.surface, opacity: disabled ? 0.6 : 1 }}>
      <span data-testid={`${testId}-label`} className="truncate text-[13px]" style={{ color: O.ink }}>{label}</span>
      <input data-testid={testId} type="datetime-local" disabled={disabled} value={toInput(value)}
        onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch { /* older browsers open it themselves */ } }}
        onChange={(e) => { const v = fromInput(e.target.value); if (v) onChange(v); }}
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
    </label>
  );
}
