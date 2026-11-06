"use client";

// MATCH OPS › PUSH NOTIFICATIONS (Figma 20834:76 the list, 20840:72 the weekly limit, 20828:72 the editor, 20829:156
// the results card). Backend contract: docs/push-notifications.md in the backend repo.
//
// The list: the weekly limit, + New push, tabs Live / Scheduled / Drafts / Ended with the backend's counts, one row per
// push (name and audience size, Kind, what the tap opens, results, status). Pushes sent with an offer are rows too
// ("With offer", opening that offer in Offers). The editor takes the page in the list's place, laid out like the Offers
// editor: the phone pinned on the left (Push tab only), the cards on the right, the summary bar with Send push. A sent
// push opens with its results card at the top, and only what the backend still lets change can be edited.
//
// A backend without these routes: the page says so, + New push is off, and nothing writes. A dev server can stand a
// fixture in for it (PUSHES_FIXTURE=1).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { audienceOf, canonicalAudience, capFlagLine, countLine, playersLine, removeToken, specProblem, tagText, type AudienceSpec, type ContractCount, type TokenLookup } from "@/lib/audienceModel";
import { CAP_MAX, CAP_MIN } from "@/lib/offersPush";
import { COUNT_DEBOUNCE_MS, chicagoWallNow, fillText, lockScreenDate, matchTitle, matchWhere, wallLabel, type City, type FieldOpt, type MatchOpt } from "@/lib/offersModel";
import { PUSH_BODY_MAX, PUSH_TITLE_MAX } from "@/lib/offersPush";
import {
  FOOTER, TABS, TAP_LABEL, TAP_NEEDS_APP, TAP_NOTE, WEEKLY_CAP_DEFAULT, editableKeys, extraBookingsLine, formProblem, fullBody, holdoutOf, newPushForm, patchBody, pct, previewText, pushFormOf,
  rowOf, sentByLine, skippedLine, summaryLine, tapOpensText, PUSH_HELP,
  type Chip as ChipLabel, type ListPage, type PushForm, type PushMessage, type PushReachable, type PushResultsData, type Row, type Tab, type TapTarget,
} from "@/lib/pushesModel";
import WhoGetsIt, { type SampleAnswer } from "@/components/audience/WhoGetsIt";
import SendTestBox, { type TestAnswer } from "@/components/audience/SendTestBox";
import MatchPicker from "@/components/offers/MatchPicker";
import { PushLockScreen } from "@/components/offers/OfferPush";
import { Banner, Btn, Card, Chip, ConfirmDialog, NotFound, O, VerdictLine, authed, inputCls, inputStyle, outcomeOf, type WriteOutcome } from "@/components/offers/offersUi";
import { useOffersAccessState } from "@/components/offers/useOffersAccess";

type Data = {
  list: ListPage | null; backend: "ready" | "missing"; backendError: string | null; fixture: boolean;
  cities: City[]; fields: FieldOpt[]; matches: MatchOpt[]; matchesComplete: boolean; matchesError: string | null; weeklyCap: number | null;
};
const n = (x: number) => x.toLocaleString("en-US");

export default function PushesView() {
  const { isLoading } = useAuth();
  const accessState = useOffersAccessState();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const [open, setOpen] = useState<number | "new" | null>(null);
  const [newN, setNewN] = useState(0);
  const [tab, setTab] = useState<Tab>("live");
  const [banner, setBanner] = useState<WriteOutcome | null>(null);
  useEffect(() => {
    if (accessState !== "yes") return;
    let cancelled = false;
    (async () => {
      const r = await authed("/api/pushes");
      if (cancelled) return;
      if (!r.ok) { setErr(String(r.json.error ?? `HTTP ${r.status}`)); setData(null); return; }
      setErr(null); setData(r.json as unknown as Data);
    })();
    return () => { cancelled = true; };
  }, [accessState, key]);
  // After a landed write the list is read again (its counts and rows come from the backend), and the editor stays on
  // the push the write answered with.
  const landed = useCallback((o: WriteOutcome, after: PushMessage | null) => {
    setBanner(o);
    if (after) { setOpen(after.id); setPushes((m) => ({ ...m, [after.id]: after })); }
    setKey((k) => k + 1);
  }, []);
  // Each push the editor opens is read whole (the list row is a summary).
  const [pushes, setPushes] = useState<Record<number, PushMessage>>({});
  const [openErr, setOpenErr] = useState<string | null>(null);
  useEffect(() => {
    if (typeof open !== "number" || pushes[open]) return;
    let cancelled = false;
    setOpenErr(null);
    (async () => {
      const r = await authed(`/api/pushes/${open}`);
      if (cancelled) return;
      if (r.ok) setPushes((m) => ({ ...m, [open]: r.json as unknown as PushMessage })); else setOpenErr(String(r.json.error));
    })();
    return () => { cancelled = true; };
  }, [open, pushes]);

  const rows = useMemo<Row[]>(() => (data?.list ? data.list.items.map((i) => rowOf(i, data.cities, data.fields)) : []), [data]);
  const tabRows = rows.filter((r) => r.group === TABS.find((t) => t.key === tab)!.group);

  if (isLoading || accessState === null) return <div className="px-1 py-6 text-[13px]" style={{ color: O.muted }}>Loading…</div>;
  if (accessState !== "yes") return <NotFound />;

  const current = typeof open === "number" ? pushes[open] ?? null : null;
  const editing = !!data && (open === "new" || !!current);
  const missing = data?.backend === "missing";
  const counts = data?.list?.counts;

  return (
    <div className="min-w-0 px-1 pb-16" style={{ color: O.ink }}>
      {banner && <Banner outcome={banner} onDismiss={() => setBanner(null)} />}
      {err ? (
        <div data-testid="pushes-error" className="rounded-[10px] border px-3 py-2.5 text-[12.5px]" style={{ background: O.critBg, borderColor: O.critLine, color: O.critInk }}>Could not load: {err}</div>
      ) : !data ? <div className="py-6 text-[13px]" style={{ color: O.muted }}>Loading…</div> : editing ? (
        <PushEditor key={`${open}:${open === "new" ? newN : current?.updatedAt ?? ""}`} c={current} data={data} onClose={() => setOpen(null)} onLanded={landed} />
      ) : typeof open === "number" ? (
        <div className="py-6 text-[13px]" style={{ color: openErr ? O.critInk : O.muted }}>{openErr ? <>Couldn&apos;t open it: {openErr} <button type="button" className="underline" onClick={() => setOpen(null)}>Back</button></> : "Loading…"}</div>
      ) : (
        <div data-testid="pushes-list" className="flex flex-col gap-3.5 rounded-[16px] border px-4 py-5 sm:px-6" style={{ background: O.surface, borderColor: O.line }}>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 text-[18px] font-bold" style={{ color: O.ink }}>Push Notifications</h1>
            <div className="ml-auto" />
            <Btn testId="pushes-refresh" onClick={() => setKey((k) => k + 1)}>Refresh</Btn>
            <Btn kind="primary" testId="pushes-new" disabled={missing} title={missing ? "The Push Notifications backend isn't on this server yet" : undefined} onClick={() => { setOpen("new"); setNewN((x) => x + 1); }}>+ New push</Btn>
          </div>
          <WeeklyLimit cap={data.weeklyCap} onSaved={(cap) => setData((d) => (d ? { ...d, weeklyCap: cap } : d))} onOutcome={setBanner} />
          {missing && (
            <div data-testid="pushes-missing" className="rounded-[10px] px-3 py-2.5 text-[12.5px]" style={{ background: O.warnBg, color: O.warnInk }}>
              The Push Notifications backend isn&apos;t on this server yet, so pushes can&apos;t be listed or made here.{data.backendError ? ` (${data.backendError})` : ""} Offers and their pushes are in Offers.
            </div>
          )}
          {data.fixture && <div data-testid="pushes-fixture" className="rounded-[10px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Dev fixture: the pushes below are stand-in data in this dev server&apos;s memory, shaped as the backend contract says. Nothing here is real.</div>}
          <div className="flex flex-wrap gap-2">
            {TABS.map((t) => <Chip key={t.key} testId={`pushes-tab-${t.key}`} on={tab === t.key} onClick={() => setTab(t.key)}>{`${t.label} · ${counts ? counts[t.key] : 0}`}</Chip>)}
          </div>
          <div className="hidden grid-cols-[minmax(0,1.4fr)_96px_minmax(0,1fr)_minmax(0,1.05fr)_84px] gap-3 px-3 text-[11px] font-semibold md:grid" style={{ color: O.muted }}>
            <div>NAME</div><div>KIND</div><div>WHAT</div><div>RESULTS</div><div />
          </div>
          {tabRows.length === 0 ? (
            <div data-testid="pushes-empty" className="rounded-[10px] border px-3 py-6 text-center text-[13px]" style={{ borderColor: O.line, color: O.muted }}>Nothing {tab === "drafts" ? "in drafts" : tab === "ended" ? "has ended yet" : tab === "scheduled" ? "is scheduled" : "is live"}.</div>
          ) : tabRows.map((r) => <ListRow key={r.key} r={r} onOpen={() => setOpen(r.id)} />)}
          <div className="text-[12px]" style={{ color: O.muted }}>{FOOTER}</div>
        </div>
      )}
    </div>
  );
}

// MAX PUSHES PER PLAYER PER WEEK (20840:72): the one shared marketing limit (GET/PUT /admin/offers/push-settings, the
// same number Offers' Push limit sets). A change is a write for every player, so it waits for Save.
function WeeklyLimit({ cap, onSaved, onOutcome }: { cap: number | null; onSaved: (cap: number) => void; onOutcome: (o: WriteOutcome) => void }) {
  const [v, setV] = useState<number | null>(cap);
  useEffect(() => setV(cap), [cap]);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (v === null || busy) return;
    setBusy(true);
    try {
      const r = await authed("/api/offers/push-settings", { method: "PUT", body: JSON.stringify({ weeklyCap: v }) });
      const o = outcomeOf(r, `Max pushes per player per week is now ${v}.`);
      onOutcome(o);
      if (o.verdict === "LANDED") onSaved(v);
    } finally { setBusy(false); }
  }
  const step = "px-3 py-1.5 text-[14px] font-medium disabled:opacity-40";
  return (
    <div data-testid="pushes-limit" className="flex flex-wrap items-center gap-2.5 rounded-[10px] px-3.5 py-2.5" style={{ background: O.page }}>
      <span className="text-[13px] font-semibold" style={{ color: O.ink }}>Max pushes per player per week</span>
      {v === null ? <span className="text-[12px]" style={{ color: O.muted }}>Couldn&apos;t read it.</span> : (
        <span className="flex items-center rounded-[8px] border bg-white" style={{ borderColor: O.line }}>
          <button type="button" data-testid="pushes-limit-minus" aria-label="One fewer" disabled={busy || v <= CAP_MIN} className={step} style={{ color: O.ink }} onClick={() => setV(v - 1)}>−</button>
          <span data-testid="pushes-limit-value" className="px-3 py-1.5 text-[14px] font-bold" style={{ color: O.ink }}>{v}</span>
          <button type="button" data-testid="pushes-limit-plus" aria-label="One more" disabled={busy || v >= CAP_MAX} className={step} style={{ color: O.ink }} onClick={() => setV(v + 1)}>+</button>
        </span>
      )}
      {v !== null && v !== cap && <Btn kind="primary" testId="pushes-limit-save" disabled={busy} onClick={save}>{busy ? "Saving…" : `Save ${v} for every player`}</Btn>}
      <span className="text-[12px]" style={{ color: O.muted }}>Booking, reminder and cancellation messages never count.</span>
    </div>
  );
}

const CHIP_STYLE: Record<ChipLabel, { bg: string; ink: string; border?: string }> = {
  Live: { bg: O.mint, ink: O.chipOn }, Scheduled: { bg: "#edede8", ink: O.muted }, Paused: { bg: "#e6effc", ink: "#2456a6" }, Draft: { bg: O.surface, ink: O.muted, border: O.line }, Ended: { bg: "#eef0ee", ink: O.muted },
};
function StatusChip({ label }: { label: ChipLabel }) {
  const s = CHIP_STYLE[label];
  return <span data-testid="pushes-state" data-state={label} className="inline-flex whitespace-nowrap rounded-full px-2 py-[3px] text-[11px] font-semibold" style={{ background: s.bg, color: s.ink, border: s.border ? `1px solid ${s.border}` : undefined }}>{label}</span>;
}
// The whole "With offer" row is the link to that offer, so the chip itself is not a second one inside it.
function KindChip({ r }: { r: Row }) {
  return r.kind === "MESSAGE"
    ? <span className="inline-flex whitespace-nowrap rounded-full px-2 py-[3px] text-[11px] font-semibold" style={{ background: "#e3edff", color: "#264da6" }}>Message</span>
    : <span data-testid="pushes-with-offer" title="Opens this offer in Offers" className="inline-flex whitespace-nowrap rounded-full px-2 py-[3px] text-[11px] font-semibold" style={{ background: O.mint, color: O.chipOn }}>With offer ›</span>;
}
function ListRow({ r, onOpen }: { r: Row; onOpen: () => void }) {
  const body = (
    <>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-[14px] font-semibold" style={{ color: O.ink }}>{r.name}</div>
        <div data-testid="pushes-row-who" className="truncate text-[12px]" style={{ color: O.muted }}>{r.who}</div>
      </div>
      <div><KindChip r={r} /></div>
      <div data-testid="pushes-row-what" className="truncate text-[13px]" style={{ color: O.ink }}>{r.what}</div>
      <div data-testid="pushes-row-results" className="truncate text-[13px]" style={{ color: O.ink }}>{r.results}</div>
      <div className="flex md:justify-end"><StatusChip label={r.chip} /></div>
    </>
  );
  const cls = "grid grid-cols-1 items-center gap-1.5 rounded-[10px] border p-3 text-left md:grid-cols-[minmax(0,1.4fr)_96px_minmax(0,1fr)_minmax(0,1.05fr)_84px] md:gap-3";
  return r.kind === "MESSAGE"
    ? <div role="button" tabIndex={0} data-testid="pushes-row" data-kind={r.kind} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }} className={`${cls} cursor-pointer hover:brightness-[0.98]`} style={{ borderColor: O.line, background: O.surface }}>{body}</div>
    : <Link data-testid="pushes-row" data-kind={r.kind} href={`/match-ops/offers?open=${r.offerId}`} className={`${cls} hover:brightness-[0.98]`} style={{ borderColor: O.line, background: O.surface }}>{body}</Link>;
}

// ── THE EDITOR ───────────────────────────────────────────────────────────────────────────────────
function PushEditor({ c, data, onClose, onLanded }: { c: PushMessage | null; data: Data; onClose: () => void; onLanded: (o: WriteOutcome, after: PushMessage | null) => void }) {
  const nowWall = chicagoWallNow();
  const loaded = useMemo(() => (c ? pushFormOf(c, nowWall) : { form: newPushForm(nowWall), unknown: 0 }), [c, nowWall]);
  const [f, setF] = useState<PushForm>(loaded.form);
  const set = (p: Partial<PushForm>) => setF((x) => ({ ...x, ...p }));
  const missing = data.backend === "missing";
  const may = editableKeys(c);
  const can = (k: string) => !missing && may.has(k);
  const draft = c === null || c.status === "DRAFT";
  const cap = data.weeklyCap ?? WEEKLY_CAP_DEFAULT;

  // ── exact players: looked up as typed (POST /admin/audiences/players/lookup) ──
  const [lookup, setLookup] = useState<(TokenLookup & { note?: string }) | null>(null);
  const [lookupFor, setLookupFor] = useState<string | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const playersMode = f.audience.mode === "PLAYERS";
  const text = f.audience.playersText;
  useEffect(() => {
    if (!playersMode || !text.trim()) { setLookup(null); setLookupFor(text); setLookupErr(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/audiences/lookup", { method: "POST", body: JSON.stringify({ text }) });
      if (cancelled) return;
      setLookupFor(text);
      if (r.ok) { setLookup(r.json as unknown as TokenLookup); setLookupErr(null); } else { setLookup(null); setLookupErr(String(r.json.error)); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [playersMode, text]);
  const playerIds = useMemo(() => [...new Set((lookup?.players ?? []).map((p) => p.id))], [lookup]);
  const lookupReady = !playersMode || (lookupFor === text && !lookupErr);

  // ── the live count, debounced (POST /admin/audiences/count) ──
  const audience = audienceOf(f.audience, playerIds);
  const holdout = holdoutOf(f, playerIds);
  const countBody = JSON.stringify({ audience, holdoutPercent: holdout });
  const audOk = specProblem(f.audience) === null && (!playersMode || playerIds.length > 0) && lookupReady;
  const [count, setCount] = useState<ContractCount | null>(null);
  const [countFor, setCountFor] = useState<string | null>(null);
  const [countErr, setCountErr] = useState<string | null>(null);
  const [countTry, setCountTry] = useState(0);
  const countWanted = !missing && can("audience") && audOk;
  useEffect(() => {
    if (!countWanted) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/audiences/count", { method: "POST", body: countBody });
      if (cancelled) return;
      setCountFor(countBody);
      if (r.ok) { setCount(r.json as unknown as ContractCount); setCountErr(null); } else { setCount(null); setCountErr(String(r.json.error)); }
    }, COUNT_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [countBody, countWanted, countTry]);
  const countNow = countFor === countBody ? count : null;

  // ── the cap flag (Figma 20842:72): how many of these players are already at the weekly cap, from the live count's
  // atCap (backend e9e90a7), so it shows while the audience is still being edited. A backend from before it has no
  // atCap; then the saved push's reachable read (GET .../reachable, capped) stands in, for the saved audience only. ──
  const savedAudience = c !== null && canonicalAudience(c.audience) === canonicalAudience(audience);
  const [reach, setReach] = useState<PushReachable | null>(null);
  const countHasCap = typeof countNow?.atCap === "number";
  useEffect(() => {
    if (!c || missing || c.status === "ENDED" || countHasCap) return;
    let cancelled = false;
    (async () => {
      const r = await authed(`/api/pushes/${c.id}/reachable`);
      if (!cancelled && r.ok) setReach(r.json as unknown as PushReachable);
    })();
    return () => { cancelled = true; };
  }, [c, missing, countHasCap]);
  const capFlag = countHasCap ? (countNow!.atCap! > 0 ? capFlagLine(countNow!.atCap!, countNow!.weeklyCap ?? cap) : null)
    : savedAudience && reach && reach.capped > 0 ? capFlagLine(reach.capped, cap) : null;

  // ── tap target ──
  const m = f.tapTarget === "MATCH" && f.tapMatchId !== null ? data.matches.find((x) => x.id === f.tapMatchId) ?? null : null;
  const [changingMatch, setChangingMatch] = useState(false);
  const preview = previewText(f, m);

  // ── writes ──
  const unknownWhy = loaded.unknown > 0 ? `This push has ${loaded.unknown} ${loaded.unknown === 1 ? "filter" : "filters"} this page can't show yet, so its audience can't be changed here.` : null;
  const problem = unknownWhy ?? formProblem(f, playerIds, data.matches, nowWall) ?? (lookupReady ? null : lookupErr ? `Couldn't look the players up: ${lookupErr}` : "Looking the players up…");
  const diff = c ? patchBody(c, f, playerIds) : null;
  const dirty = c === null || Object.keys(diff ?? {}).length > 0;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [confirm, setConfirm] = useState<null | "send" | "pause" | "end">(null);
  async function once<T>(fn: () => Promise<T>): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current = true; setBusy(true);
    try { return await fn(); } finally { inFlight.current = false; setBusy(false); }
  }
  async function save(): Promise<{ o: WriteOutcome; after: PushMessage | null }> {
    if (c !== null && !dirty) return { o: { verdict: "LANDED", text: "Nothing to save." }, after: c };
    const r = c === null
      ? await authed("/api/pushes", { method: "POST", body: JSON.stringify(fullBody(f, playerIds)) })
      : await authed(`/api/pushes/${c.id}`, { method: "PATCH", body: JSON.stringify(diff) });
    return { o: outcomeOf(r, c === null ? `Saved "${f.name.trim()}" as a draft.` : `Saved changes to "${f.name.trim()}".`), after: (r.json.after ?? null) as PushMessage | null };
  }
  async function onSave() {
    const r = await once(save);
    if (!r) return;
    setOutcome(r.o);
    if (r.o.verdict === "LANDED" && r.after && r.o.text !== "Nothing to save.") onLanded(r.o, r.after);
  }
  async function move(action: "send" | "pause" | "end"): Promise<WriteOutcome> {
    let id = c?.id ?? null;
    if (action === "send" && (c === null || dirty)) {
      const s = await save();
      if (s.o.verdict !== "LANDED" || !s.after) return s.o;
      id = s.after.id;
    }
    const r = await authed(`/api/pushes/${id}/${action}`, { method: "POST" });
    const name = f.name.trim();
    const o = outcomeOf(r, action === "pause" ? `Paused "${name}".` : action === "end" ? `Ended "${name}".` : f.at ? `Scheduled "${name}" for ${wallLabel(`${f.sendLocal}:00`)} in each player's city.` : `Sent "${name}". It's going out now.`);
    if (o.verdict === "LANDED") onLanded(o, (r.json.after ?? null) as PushMessage | null);
    return o;
  }
  // SEND TEST: the text on screen, saved or not, to the player in the Send to box.
  const testBox = useRef<HTMLDivElement>(null);
  const sendTest = async (to: string): Promise<TestAnswer> => {
    const r = await authed(`/api/pushes/${c!.id}/test`, { method: "POST", body: JSON.stringify({ title: f.title, body: f.body, to }) });
    return r.json.verdict === "SENT" || r.json.verdict === "PARTIAL" ? { ok: true, sent: Number(r.json.sent ?? 0), failed: Number(r.json.failed ?? 0), devices: Number(r.json.devices ?? 0) } : { ok: false, error: String(r.json.error ?? "the backend refused it") };
  };
  const testWhy = missing ? "The Push Notifications backend isn't on this server yet." : c === null ? "Save it as a draft first." : !f.title.trim() || !f.body.trim() ? "Write a title and a message first." : null;

  const summary = summaryLine(f, countNow, cap);
  const sendWhy = missing ? "The Push Notifications backend isn't on this server yet." : problem;
  const canSend = c === null || c.status === "DRAFT" || c.status === "PAUSED";
  const tags = (lookup?.players ?? []).map((p) => ({ key: p.entry ?? String(p.id), label: tagText(p) }));
  const onSample = async (): Promise<SampleAnswer> => {
    const r = await authed("/api/audiences/sample", { method: "POST", body: JSON.stringify({ audience }) });
    return r.ok ? (r.json as unknown as SampleAnswer) : { error: String(r.json.error) };
  };
  const lockNote = !draft && c ? (may.has("audience") ? "Sent with a time and nobody has it yet: everything but the send time can still change." : "It has gone out: only the name can change now.") : null;

  return (
    <div data-testid="pushes-editor" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button type="button" data-testid="pushes-back" onClick={onClose} className="self-start whitespace-nowrap text-[13px] font-semibold" style={{ color: O.muted }}>← Back to push notifications</button>
          <h1 className="m-0 truncate text-[26px] font-bold" style={{ color: O.ink }}>{c ? c.name || "Untitled push" : "New push"}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn testId="pushes-save" disabled={busy || missing || !f.name.trim() || !dirty || (draft ? false : !!problem && may.has("audience"))} onClick={onSave}>{c === null ? "Save draft" : "Save changes"}</Btn>
          {draft && <Btn testId="pushes-test" disabled={busy || !!testWhy} title={testWhy ?? undefined} onClick={() => { testBox.current?.scrollIntoView({ behavior: "smooth", block: "center" }); testBox.current?.querySelector("input")?.focus(); }}>Send test</Btn>}
          {canSend && <Btn kind="primary" testId="pushes-send" disabled={busy || !!sendWhy} title={sendWhy ?? undefined} onClick={() => setConfirm("send")}>{c?.status === "PAUSED" ? "Resume" : "Send push"}</Btn>}
        </div>
      </div>
      {outcome && <VerdictLine outcome={outcome} />}
      {lockNote && <div data-testid="pushes-lock-note" className="rounded-[10px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>{lockNote}</div>}

      <div className="grid gap-7 min-[1100px]:grid-cols-[430px_minmax(0,1fr)]">
        {/* THE PREVIEW (20828:114): Push only. Sticky beside the form above 1100px; on top below that. */}
        <div className="min-[1100px]:sticky min-[1100px]:top-[calc(var(--nav-h,64px)+16px)] min-[1100px]:self-start">
          <div data-testid="pushes-preview" className="flex flex-col items-center gap-3.5">
            <div className="flex w-full items-center gap-2">
              <span className="text-[11px] font-bold tracking-[0.5px]" style={{ color: O.muted }}>LIVE PREVIEW</span>
              <span className="rounded-full px-2 py-[3px] text-[11px] font-semibold" style={{ background: O.mint, color: O.chipOn }}>Pinned while you scroll</span>
            </div>
            <div className="flex rounded-full border p-1" style={{ background: O.surface, borderColor: O.line }}>
              <span className="rounded-full px-4 py-[7px] text-[13px] font-semibold" style={{ background: O.chipOn, color: "#fff" }}>Push</span>
            </div>
            <div data-testid="pushes-phone" className="w-full max-w-[380px] rounded-[54px] p-3" style={{ background: "#141717", height: "min(780px, max(560px, calc(100dvh - 230px)))" }}>
              <div className="relative h-full w-full overflow-hidden rounded-[44px]">
                <PushLockScreen title={preview.title} body={preview.body} photoUrl={m?.fieldCover ?? null} dateLine={lockScreenDate(nowWall)} />
              </div>
            </div>
            <div data-testid="pushes-opens" className="text-center text-[12px] font-medium" style={{ color: O.muted }}>↳ Tapping opens {tapOpensText(f.tapTarget, m)}</div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {c && !draft && <ResultsCard c={c} cap={cap} />}

          <Card title="Push" sub={`A message, no discount. Counts toward each player's ${cap} marketing ${cap === 1 ? "push" : "pushes"} a week. For a discount, use Offers.`} testId="pushes-card-push">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold" style={{ color: O.ink }}>Name (only staff see this)</span>
              <input data-testid="pushes-name" disabled={!can("name")} className={inputCls} style={inputStyle} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Austin · Saturday NEMP fill" />
            </label>
          </Card>

          <WhoGetsIt spec={f.audience} onChange={(a: AudienceSpec) => set({ audience: a })} allowed={null} cities={data.cities} fields={data.fields} nowWall={nowWall} disabled={!can("audience") || loaded.unknown > 0} testId="pushes-who"
            count={!countWanted ? { state: "off" } : countErr && countFor === countBody ? { state: "error", error: countErr, onRetry: () => setCountTry((x) => x + 1) }
              : countNow ? { state: "ready", text: countLine({ matching: countNow.matching, allowPushes: countNow.allowPushes, holdoutPercent: countNow.heldBack > 0 ? countNow.holdoutPercent : 0 }), capFlag } : { state: "counting" }}
            onSample={onSample}
            players={{
              hint: "Paste player IDs, emails or phone numbers, separated by commas or new lines.", placeholder: "78, 1481, 3193\nluis@example.com\n(512) 555-0142",
              tags, notFound: lookup?.notFound ?? [],
              line: lookup ? playersLine(lookup.players) : lookupErr ? null : text.trim() ? "Looking them up…" : null,
              extra: (
                <>
                  {lookupErr && <div className="text-[12px]" style={{ color: O.critInk }}>Couldn&apos;t look them up: {lookupErr}</div>}
                  {lookup?.note && <div className="text-[12px]" style={{ color: O.muted }}>{lookup.note}</div>}
                  {playersMode && capFlag && <div data-testid="pushes-who-cap-flag" className="rounded-[10px] px-3.5 py-[9px] text-[13px] font-semibold" style={{ background: "#fff2d9", color: "#8c590d" }}>{capFlag}</div>}
                </>
              ),
              onRemove: (k) => set({ audience: { ...f.audience, playersText: removeToken(text, k) } }),
            }} />

          <Card title="Message" testId="pushes-card-message">
            <TextField label="Title" value={f.title} max={PUSH_TITLE_MAX} disabled={!can("title")} testId="pushes-title" onChange={(v) => set({ title: v })} placeholder="6 spots left Saturday at NEMP" />
            <TextField label="Body" value={f.body} max={PUSH_BODY_MAX} disabled={!can("body")} testId="pushes-body" onChange={(v) => set({ body: v })} placeholder="{first_name}, Sat 7:00 PM in Austin. Grab one before it fills." rows={2} />
            <div data-testid="pushes-help" className="text-[12px]" style={{ color: O.muted }}>{PUSH_HELP}</div>
            {draft && <div ref={testBox}><SendTestBox testId="pushes-send-test" send={sendTest} blockedWhy={testWhy} /></div>}
          </Card>

          <Card title="Tap opens" testId="pushes-card-tap">
            <div className="flex flex-wrap gap-2">
              {(["MATCH", "HOME", "FIND_MATCH", "FIELD"] as TapTarget[]).map((t) => {
                const needsApp = TAP_NEEDS_APP.includes(t);
                return <Chip key={t} testId={`pushes-tap-${t}`} on={f.tapTarget === t} disabled={!can("tapTarget") || needsApp} title={needsApp ? "Needs the next app update" : undefined}
                  onClick={() => { set({ tapTarget: t }); if (t === "MATCH" && f.tapMatchId === null) setChangingMatch(true); }}>{TAP_LABEL[t]}</Chip>;
              })}
            </div>
            <div className="text-[12px]" style={{ color: O.muted }}>{TAP_NOTE}</div>
            {f.tapTarget === "MATCH" && (
              <>
                {m && !changingMatch && (
                  <div data-testid="pushes-match" className="flex items-center gap-3 rounded-[10px] border px-3 py-2.5" style={{ borderColor: O.line }}>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="truncate text-[13px] font-semibold" style={{ color: O.ink }}>{matchTitle(m)} · {wallLabel(m.startLocal)}</div>
                      <div className="truncate text-[12px]" style={{ color: O.muted }}>{[matchWhere(m, data.cities), fillText(m)].filter(Boolean).join(" · ")}</div>
                    </div>
                    {can("tapMatchId") && <Btn testId="pushes-match-change" onClick={() => setChangingMatch(true)}>Change</Btn>}
                  </div>
                )}
                {(!m || changingMatch) && can("tapMatchId") && (
                  <MatchPicker matches={data.matches} cities={data.cities} cityIds={[]} selected={m} nowWall={nowWall} startOpen={changingMatch}
                    onPick={(id) => { set({ tapMatchId: id }); setChangingMatch(false); }} onOpen={() => undefined} onRetry={() => undefined}
                    listState={data.matchesError ? "failed" : "ready"} listError={data.matchesError} partial={!data.matchesComplete} testId="pushes-match-picker" />
                )}
                {!m && f.tapMatchId !== null && <div className="text-[12px]" style={{ color: O.warnInk }}>{c?.tap.match ? `${c.tap.match.name} isn't in the upcoming list any more.` : `Match ${f.tapMatchId} isn't in the upcoming list any more.`}{can("tapMatchId") ? " Pick another." : ""}</div>}
              </>
            )}
          </Card>

          <Card title="Sends" testId="pushes-card-sends">
            <div className="flex flex-wrap gap-2"><Chip testId="pushes-once" on>Once</Chip></div>
            <div className="flex flex-wrap gap-2">
              <Chip testId="pushes-now" on={!f.at} disabled={!can("sendLocal")} onClick={() => set({ at: false })}>Now</Chip>
              <Chip testId="pushes-at" on={f.at} disabled={!can("sendLocal")} onClick={() => set({ at: true })}>At a time</Chip>
            </div>
            {f.at && (
              <label className="relative flex max-w-[260px] rounded-[8px] border px-3 py-[9px]" style={{ borderColor: O.line, opacity: can("sendLocal") ? 1 : 0.6 }}>
                <span data-testid="pushes-at-label" className="text-[13px]" style={{ color: O.ink }}>{wallLabel(`${f.sendLocal}:00`)}</span>
                <input data-testid="pushes-at-input" type="datetime-local" disabled={!can("sendLocal")} value={f.sendLocal.replace(" ", "T")}
                  onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch { /* older browsers */ } }}
                  onChange={(e) => { if (e.target.value) set({ sendLocal: e.target.value.replace("T", " ").slice(0, 16) }); }}
                  className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
              </label>
            )}
            <div className="text-[12px]" style={{ color: O.muted }}>{f.at ? "Once, at this time in each player's own city." : "Once, as soon as you press Send push."}</div>
          </Card>

          <div data-testid="pushes-summary-bar" className="flex flex-col gap-3 rounded-[14px] px-5 py-4 sm:flex-row sm:items-center sm:gap-4" style={{ background: O.mint }}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div data-testid="pushes-summary" className="text-[13px] font-semibold" style={{ color: O.chipOn }}>{draft || c?.status === "PAUSED" ? summary : `${c?.state === "SCHEDULED" ? "Scheduled" : "Sent"}. ${c?.state === "SCHEDULED" ? "Pause it to stop it going; end it to stop it for good." : "End it once you're done with it; it stays in the list."}`}</div>
              {canSend && sendWhy && <div data-testid="pushes-why" className="text-[12px]" style={{ color: O.warnInk }}>{sendWhy}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              {c && c.status === "LAUNCHED" && <Btn testId="pushes-pause" disabled={busy || missing} onClick={() => setConfirm("pause")}>Pause</Btn>}
              {c && c.status !== "ENDED" && <Btn kind="danger" testId="pushes-end" disabled={busy || missing} onClick={() => setConfirm("end")}>{draft ? "Discard draft" : "End"}</Btn>}
              {canSend && <Btn kind="primary" testId="pushes-send-bar" disabled={busy || !!sendWhy} title={sendWhy ?? undefined} onClick={() => setConfirm("send")}>{c?.status === "PAUSED" ? "Resume" : "Send push"}</Btn>}
            </div>
          </div>
        </div>
      </div>

      {confirm === "send" && (
        <ConfirmDialog title={c?.status === "PAUSED" ? "Resume this push?" : f.at ? "Schedule this push?" : "Send this push now?"} note={summary} action={c?.status === "PAUSED" ? "Resume" : f.at ? "Schedule push" : "Send push"}
          extra={<span style={{ color: O.muted }}>It goes once and can&apos;t be called back.{c === null || dirty ? " Your changes are saved first." : ""}</span>}
          onConfirm={async () => { const o = await move("send"); if (o.verdict === "LANDED") setConfirm(null); return o; }} onCancel={() => setConfirm(null)} />
      )}
      {confirm === "pause" && c && (
        <ConfirmDialog title="Pause this push?" note="Nobody else gets it while it's paused. A send that comes due does nothing. Resume sends it again." action="Pause"
          onConfirm={async () => { const o = await move("pause"); if (o.verdict === "LANDED") setConfirm(null); return o; }} onCancel={() => setConfirm(null)} />
      )}
      {confirm === "end" && c && (
        <ConfirmDialog title={draft ? "Discard this draft?" : "End this push?"} note={draft ? "It was never sent. It moves to Ended and stays there; nothing is deleted." : "Nobody else gets it. It moves to Ended with its results; this can't be undone."} action={draft ? "Discard draft" : "End push"} kind="dangerSolid"
          onConfirm={async () => { const o = await move("end"); if (o.verdict === "LANDED") setConfirm(null); return o; }} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}

function TextField({ label, value, max, disabled, testId, onChange, placeholder, rows }: { label: string; value: string; max: number; disabled: boolean; testId: string; onChange: (v: string) => void; placeholder: string; rows?: number }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold" style={{ color: O.ink }}>{label}</span>
        <span className="text-[11px]" style={{ color: value.length > max ? O.critInk : O.label }}>{value.length}/{max}</span>
      </span>
      {rows
        ? <textarea data-testid={testId} rows={rows} disabled={disabled} className={inputCls} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        : <input data-testid={testId} disabled={disabled} className={inputCls} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}
    </label>
  );
}

// THE RESULTS CARD (20829:156): sent of targeted, opened, booked within 3 days, the held-back group's bookings, who
// sent it and when, and the extra-bookings line once 30 or more are held back.
function ResultsCard({ c, cap }: { c: PushMessage; cap: number }) {
  const [r, setR] = useState<PushResultsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const a = await authed(`/api/pushes/${c.id}/results`);
      if (cancelled) return;
      if (a.ok) setR(a.json as unknown as PushResultsData); else setErr(String(a.json.error));
    })();
    return () => { cancelled = true; };
  }, [c.id]);
  const label: ChipLabel = c.state === "PAUSED" ? "Paused" : c.group === "LIVE" ? "Live" : c.group === "SCHEDULED" ? "Scheduled" : c.group === "DRAFTS" ? "Draft" : "Ended";
  return (
    <section data-testid="pushes-results" className="flex flex-col gap-3.5 rounded-[14px] border px-[22px] pb-5 pt-[18px]" style={{ background: O.surface, borderColor: O.line }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="m-0 text-[15px] font-bold" style={{ color: O.ink }}>Results · {c.name}</h2>
        <div className="flex-1" />
        <span data-testid="pushes-sent-by" className="text-[12px]" style={{ color: O.muted }}>{c.state === "SCHEDULED" && c.sendLocal ? `Scheduled for ${wallLabel(`${c.sendLocal}:00`)} by ${c.launchedByStaffEmail ?? "staff"}` : r ? sentByLine(r) : ""}</span>
        <StatusChip label={label} />
      </div>
      {err && <div className="text-[12px]" style={{ color: O.critInk }}>Couldn&apos;t read the results: {err}</div>}
      {!r ? (!err && <div className="text-[12px]" style={{ color: O.muted }}>Loading results…</div>) : r.targeted === 0 && r.sent === 0 ? (
        <div className="text-[12px]" style={{ color: O.muted }}>{c.state === "SCHEDULED" ? "Nobody has it yet." : "Nobody was sent it."}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat testId="pushes-stat-sent" label="Sent" value={n(r.sent)} sub={`of ${n(r.targeted)} targeted`} />
            <Stat testId="pushes-stat-opened" label="Opened" value={n(r.opened)} sub={`${pct(r.openRate)} of sent`} />
            <Stat testId="pushes-stat-booked" label="Booked within 3 days" value={n(r.bookedWithin3Days)} sub="from players who got it" />
            <Stat testId="pushes-stat-held" label="Held back booked" value={n(r.heldBackBooked)} sub={`of ${n(r.heldBack)} held back`} />
          </div>
          {skippedLine(r, cap) && <div data-testid="pushes-skipped" className="text-[12px]" style={{ color: O.muted }}>{skippedLine(r, cap)}</div>}
          <div data-testid="pushes-extra" className="text-[12px]" style={{ color: O.muted }}>{extraBookingsLine(r)}</div>
        </>
      )}
    </section>
  );
}
function Stat({ label, value, sub, testId }: { label: string; value: string; sub: string; testId: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-0.5 rounded-[10px] px-3.5 py-3" style={{ background: O.page }}>
      <div className="text-[12px] font-semibold" style={{ color: O.muted }}>{label}</div>
      <div className="text-[24px] font-bold" style={{ color: O.ink }}>{value}</div>
      <div className="text-[11px]" style={{ color: O.muted }}>{sub}</div>
    </div>
  );
}
