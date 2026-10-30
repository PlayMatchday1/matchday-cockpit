"use client";

// ONE OFFER, top to bottom (Figma 20571:334; the specific-match state is 20581:54): Name, The deal,
// Who gets it (with the live count), Popup (live preview, text written from the deal and editable
// behind Edit text), Runs, More options (holdout, use cap), the summary with the most it can cost,
// then Launch. After launch the deal, the audience and the dates are locked (the backend refuses
// them); the name, the popup text and the use cap can still change, and Pause and End appear.
//
// SEND TO MY PHONE (backend POST .../send-to-me): the popup on your own phone, next app open. It needs
// a saved offer (any status, drafts included). Reported as "Sent", never as arrived.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FIRST_NAME_TOKEN, MAX_USES_PER_PLAYER, PREVIEW_FIRST_NAME, amountText, limitLine, stepLimit, stepUses, usesLine, audienceBody, buttonMatchNote, buttonOf, matchDay, opensText, chicagoWallNow, copyOf, createBody, defaultRun, endsTicket, formOf, formProblem, fromInput, matchInfo,
  matchShort, newForm, patchBody, pickedMatch, startLabel, STEPPER, summary, toInput, wallLabel,
  type Campaign, type City, type Count, type FieldOpt, type CopyKey, type DealType, type Form, type MatchOpt,
} from "@/lib/offersModel";
import OfferPopupPreview from "./OfferPopupPreview";
import {
  Btn, Chip, ConfirmDialog, Labeled, O, PanelSection, VerdictLine, authed, inputCls, inputStyle, outcomeOf, settled, type WriteOutcome,
} from "./offersUi";

type Data = { campaigns: Campaign[]; cities: City[]; fields: FieldOpt[]; matches: MatchOpt[] };
const DEALS: { type: DealType; label: string }[] = [
  { type: "PERCENT_OFF", label: "% off" }, { type: "AMOUNT_OFF", label: "$ off" }, { type: "SET_PRICE", label: "Set price" }, { type: "FREE_MATCH", label: "Free match" },
];
const SENT_TEXT = "Sent. Open the app on your phone to see it.";

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
  const [confirm, setConfirm] = useState<null | "launch" | "pause" | "end" | "delete">(null);
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
  async function discard(): Promise<WriteOutcome> {
    const r = await authed(`/api/offers/${c!.id}`, { method: "DELETE" });
    const o = outcomeOf(r, `Deleted the draft "${c!.name}".`);
    if (o.verdict === "LANDED") { onLanded(o); onClose(); }
    return o;
  }
  async function sendToPhone() {
    const r = await once(async () => outcomeOf(await authed(`/api/offers/${c!.id}/send-to-me`, { method: "POST" }), SENT_TEXT));
    if (r) setOutcome(r);
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
  // ── Button opens (Figma 20612:47 / 92 / 142). Editable after launch like the rest of the text;
  // forced and locked to the deal's match when the offer is for a specific match.
  const photoName = (url: string | null) => {
    if (!url) return "MatchDay photo";
    const fx = data.fields.find((x) => x.cover === url);
    return fx ? `${fx.title} cover` : "Custom photo";
  };
  const btn = buttonOf(f, data.matches);
  const btnMatch = data.matches.find((x) => x.id === btn.matchId) ?? null;
  const btnChoices = btnMatch && !upcoming.some((x) => x.id === btnMatch.id) ? [btnMatch, ...upcoming] : upcoming;
  // ── Photo (no mock): field cover photos for fields in the offer's cities, name and city under each.
  // Picking one stores its URL as the photo; MatchDay photo is the app's default. No uploads in v1.
  // A specific match's own field cover is the default for that offer. Editable after launch.
  const coverFields = data.fields.filter((x) => x.cover && (f.cityIds.length === 0 || (x.cityId !== null && f.cityIds.includes(x.cityId))));
  const cityName = (id: number | null) => data.cities.find((x) => x.id === id)?.name ?? "";
  const photoPicker = () => (
    <div data-testid="offers-photo" className="flex flex-col gap-1.5">
      <div className="text-[12px] font-medium" style={{ color: O.ink }}>Photo</div>
      <div className="grid grid-cols-2 gap-2">
        {[{ id: 0, title: "MatchDay photo", cityId: null, cover: null as string | null }, ...coverFields].map((x) => {
          const on = (copy.photoUrl ?? null) === x.cover;
          return (
            <button key={x.id} type="button" data-testid={`offers-photo-${x.id}`} data-on={on ? "1" : "0"} disabled={ended}
              onClick={() => setF((v) => ({ ...v, copy: { ...v.copy, photoUrl: x.cover } }))}
              className="flex flex-col overflow-hidden rounded-[8px] border-2 text-left" style={{ borderColor: on ? O.chipOn : O.line }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" src={x.cover ?? "/offers/popup-photo.png"} className="h-[48px] w-full object-cover" />
              <span className="truncate px-1.5 pt-1 text-[11px] font-medium" style={{ color: O.ink }}>{x.title}</span>
              <span className="truncate px-1.5 pb-1 text-[10.5px]" style={{ color: O.muted }}>{x.cover ? cityName(x.cityId) : "Default"}</span>
            </button>
          );
        })}
      </div>
      {coverFields.length === 0 && <div data-testid="offers-nophoto" className="text-[11.5px]" style={{ color: O.muted }}>No field in {f.cityIds.length ? "these cities" : "any city"} has a cover photo yet.</div>}
    </div>
  );
  const buttonOpens = () => {
    const off = btn.locked || ended;
    const chip = (on: boolean) => btn.locked
      ? (on ? { background: O.muted, borderColor: O.muted, color: "#fff" } : { background: "#eef0ee", borderColor: O.line, color: O.label })
      : undefined;
    return (
      <div data-testid="offers-button-opens" data-locked={btn.locked ? "1" : "0"} className="flex flex-col gap-2">
        <div className="text-[12px] font-medium" style={{ color: O.ink }}>Button opens</div>
        <div className="flex flex-wrap gap-1.5">
          {([["FIND_MATCH", "Find a match"], ["MATCH", "A specific match"]] as const).map(([t, label]) => (
            btn.locked
              ? <span key={t} data-testid={`offers-btn-${t}`} data-on={btn.target === t ? "1" : "0"} className="inline-flex items-center rounded-full border px-3 py-[6px] text-[12px] font-medium" style={chip(btn.target === t)}>{label}</span>
              : <Chip key={t} testId={`offers-btn-${t}`} on={btn.target === t} disabled={off} onClick={() => set(t === "MATCH" ? { buttonTarget: "MATCH" } : { buttonTarget: "FIND_MATCH", buttonMatchId: null })}>{label}</Chip>
          ))}
        </div>
        {btn.target === "MATCH" && (
          <>
            <div className="relative">
              <select data-testid="offers-btn-match" className={`${inputCls} appearance-none pr-8 font-medium`} disabled={off}
                style={btn.locked ? { ...inputStyle, background: "#eef0ee", color: O.muted, opacity: 1 } : inputStyle}
                value={btn.matchId ?? ""} onChange={(e) => set({ buttonMatchId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{btnChoices.length ? "Pick a match" : "No upcoming matches in these cities"}</option>
                {btnChoices.map((x) => <option key={x.id} value={x.id}>{matchDay(x)}</option>)}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px]" style={{ color: O.muted }}>{btn.locked ? "🔒" : "⌄"}</span>
            </div>
            {btn.locked
              ? <div data-testid="offers-btn-note" className="rounded-[8px] px-2.5 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Opens the match this offer is for.</div>
              : btnMatch && <div data-testid="offers-btn-note" className="rounded-[8px] px-2.5 py-2 text-[12px]" style={{ background: O.mint, color: O.ok }}>{buttonMatchNote(btnMatch)}</div>}
          </>
        )}
      </div>
    );
  };
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
        {STEPPER[f.dealType] && (
          <div className="flex flex-wrap items-center gap-2.5">
            {(
              <>
                <div className="flex items-center gap-[18px] rounded-[8px] border px-2.5 py-[7px] text-[14px]" style={{ borderColor: O.line, opacity: dl ? 0.6 : 1 }}>
                  <button type="button" data-testid="offers-minus" disabled={dl} onClick={() => step(-1)} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>–</button>
                  <span data-testid="offers-amount" className="min-w-[34px] text-center font-bold" style={{ color: O.ink }}>{amountText(f.dealType, f.dealAmount)}</span>
                  <button type="button" data-testid="offers-plus" disabled={dl} onClick={() => step(1)} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>+</button>
                </div>
                <span className="text-[13px]" style={{ color: O.ink }}>{f.dealType === "SET_PRICE" ? "for their spot" : "off"}</span>
              </>
            )}
          </div>
        )}
        {/* USES (Figma 20620:46): how many matches each player can use it on. A specific match is one. */}
        {!m && (
          <div data-testid="offers-uses" className="flex flex-col gap-1.5">
            <div className="text-[12px] font-medium" style={{ color: O.ink }}>Uses</div>
            <div className="flex items-center gap-2.5">
              <Stepper testId="offers-uses-n" value={String(f.usesPerPlayer)} disabled={dl}
                minus={() => set({ usesPerPlayer: stepUses(f.usesPerPlayer, -1) })} plus={() => set({ usesPerPlayer: stepUses(f.usesPerPlayer, 1) })}
                atMin={f.usesPerPlayer <= 1} atMax={f.usesPerPlayer >= MAX_USES_PER_PLAYER} />
              <span className="text-[13px]" style={{ color: O.ink }}>matches per player</span>
            </div>
            <div data-testid="offers-uses-line" className="text-[12px]" style={{ color: O.muted }}>{usesLine(f.usesPerPlayer)}</div>
          </div>
        )}
        {/* TOTAL LIMIT (maxRedemptions): no mock; same grammar as Uses. Editable after launch. */}
        <div data-testid="offers-limit" className="flex flex-col gap-1.5">
          <div className="text-[12px] font-medium" style={{ color: O.ink }}>Total limit</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip testId="offers-limit-none" on={f.maxRedemptions === null} disabled={ended} onClick={() => set({ maxRedemptions: null })}>No limit</Chip>
            {f.maxRedemptions === null
              ? <Chip testId="offers-limit-set" on={false} disabled={ended} onClick={() => set({ maxRedemptions: 50 })}>Set a limit</Chip>
              : (
                <div className="flex items-center gap-2.5">
                  <Stepper testId="offers-limit-n" value={f.maxRedemptions} disabled={ended} atMin={f.maxRedemptions <= 1}
                    minus={() => set({ maxRedemptions: stepLimit(f.maxRedemptions, -1) })} plus={() => set({ maxRedemptions: stepLimit(f.maxRedemptions, 1) })}
                    onType={(n) => set({ maxRedemptions: n })} />
                  <span className="text-[13px]" style={{ color: O.ink }}>uses in total</span>
                </div>
              )}
          </div>
          {f.maxRedemptions !== null && <div data-testid="offers-limit-line" className="text-[12px]" style={{ color: O.muted }}>{limitLine(f.maxRedemptions)}</div>}
        </div>
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
      <PanelSection title={editText && !ended ? "Popup · Edit text" : "Popup"} testId="offers-popup">
        {/* Figma 20612:47: with Edit text open the fields take the summary's place beside the preview. */}
        <div className="flex items-start gap-3.5">
          <div className="flex shrink-0 flex-col gap-2">
            <OfferPopupPreview copy={copy} ends={ends} />
            <div data-testid="offers-opens" className="max-w-[156px] text-[11px] font-medium" style={{ color: O.muted }}>{opensText(f, data.matches)}</div>
          </div>
          {editText && !ended ? (
            <div data-testid="offers-text-fields" className="flex min-w-0 flex-1 flex-col gap-3">
              {([["buttonLabel", "Button label", 64], ["eyebrow", "Tag on the photo", 64], ["caption", "Line on the photo", 64], ["headline", "Headline (last word in green)", 64], ["line", "Line", 64], ["body", "Body", 300], ["dismissLabel", "Dismiss link", 64]] as const).map(([k, label, max]) => {
                const auto = copyOf({ ...f, copy: {} }, data.matches, data.cities)[k] ?? "";
                return (
                  <div key={k} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] font-medium" style={{ color: O.ink }}>{label}</span>
                      {k === "body"
                        ? <textarea data-testid={`offers-copy-${k}`} rows={3} maxLength={max} className={inputCls} style={inputStyle} placeholder={auto} value={f.copy[k] ?? ""} onChange={(e) => setCopy(k, e.target.value)} />
                        : <input data-testid={`offers-copy-${k}`} maxLength={max} className={inputCls} style={inputStyle} placeholder={auto} value={f.copy[k] ?? ""} onChange={(e) => setCopy(k, e.target.value)} />}
                    </label>
                    {k === "buttonLabel" && buttonOpens()}
                    {k === "buttonLabel" && photoPicker()}
                  </div>
                );
              })}
              <div className="text-[11.5px]" style={{ color: O.muted }}>An empty line goes back to the text written from the deal.</div>
              <div data-testid="offers-firstname-hint" className="text-[11.5px]" style={{ color: O.muted }}>
                <code className="rounded px-1" style={{ background: O.subtle, color: O.ink }}>{FIRST_NAME_TOKEN}</code> becomes the player&apos;s first name (shown here as {PREVIEW_FIRST_NAME}). With no first name on file it is left out.
              </div>
              <button type="button" data-testid="offers-edit-text" onClick={() => setEditText(false)} className="self-start text-[12px] font-semibold" style={{ color: O.ok }}>Done ‹</button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="text-[12px] leading-[17px]" style={{ color: O.muted }}>Written for you from the deal. Change any line if you want.</div>
              {([["Headline", copy.headline], ["Line", copy.line], ["Photo", photoName(copy.photoUrl)], ["Button", copy.buttonLabel]] as const).map(([k, v]) => (
                <div key={k} className="flex flex-col gap-[3px] font-medium">
                  <div className="text-[11px]" style={{ color: O.label }}>{k}</div>
                  <div className="break-words text-[13px]" style={{ color: O.ink }}>{v || "None"}</div>
                </div>
              ))}
              {!ended && (
                <button type="button" data-testid="offers-edit-text" onClick={() => setEditText(true)} className="self-start text-[12px] font-semibold" style={{ color: O.ok }}>Edit text ›</button>
              )}
            </div>
          )}
        </div>
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
          <span style={{ color: O.muted }}>{f.holdoutPercent > 0 ? `${f.holdoutPercent}% held back to measure` : "Nobody held back"} {more ? "‹" : "›"}</span>
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
            {c?.status === "DRAFT" && <Btn kind="danger" testId="offers-delete" disabled={busy} onClick={() => setConfirm("delete")}>Delete</Btn>}
            <Btn testId="offers-phone" disabled={busy || outcome?.verdict === "SENT" || c === null || (c.status === "DRAFT" && dirty)} title={c === null ? "Save it as a draft first" : c.status === "DRAFT" && dirty ? "Save your changes first, so the phone shows what you see" : undefined} onClick={sendToPhone}>Send to my phone</Btn>
          </div>
        )}
        {!ended && c === null && <div data-testid="offers-phone-note" className="text-[11.5px]" style={{ color: O.muted }}>Save it as a draft to send it to your phone.</div>}
      </section>

      {confirm === "launch" && (
        <ConfirmDialog title={c?.status === "PAUSED" ? `Resume ${f.name.trim()}?` : `Launch ${f.name.trim()}?`}
          note={c?.status === "PAUSED" ? "Players who match start getting it again the next time they open the app." : `${summary(f, count, data.matches, data.cities, nowWall)} After launch the deal, who gets it and when it runs can't change.`}
          action={c?.status === "PAUSED" ? "Resume" : "Launch"} onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(launch); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
      {confirm === "delete" && (
        <ConfirmDialog title={`Delete the draft ${c!.name}?`} kind="dangerSolid" note="It was never launched, so no player has it. This can't be undone."
          action="Delete" onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(discard); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
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

// A stepper in the mock's shape (– value +). onType makes the value a number box as well.
function Stepper({ value, minus, plus, disabled, atMin, atMax, onType, testId }: {
  value: string | number; minus: () => void; plus: () => void; disabled?: boolean; atMin?: boolean; atMax?: boolean; onType?: (n: number) => void; testId: string;
}) {
  return (
    <div className="flex items-center gap-[18px] rounded-[8px] border px-2.5 py-[7px] text-[14px]" style={{ borderColor: O.line, opacity: disabled ? 0.6 : 1 }}>
      <button type="button" data-testid={`${testId}-minus`} disabled={disabled || atMin} onClick={minus} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>–</button>
      {onType
        ? <input data-testid={testId} inputMode="numeric" disabled={disabled} value={value} onChange={(e) => { const n = Math.floor(Number(e.target.value.replace(/\D/g, ""))); if (n >= 1) onType(n); }}
            className="w-[48px] bg-transparent text-center font-bold outline-none" style={{ color: O.ink }} />
        : <span data-testid={testId} className="min-w-[14px] text-center font-bold" style={{ color: O.ink }}>{value}</span>}
      <button type="button" data-testid={`${testId}-plus`} disabled={disabled || atMax} onClick={plus} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>+</button>
    </div>
  );
}
