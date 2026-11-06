"use client";

// MATCH OPS › PUSH NOTIFICATIONS (Figma 20834:76 the list, 20828:72 the editor, 20829:156 the results card).
//
// The list: + New push, tabs Live / Scheduled / Drafts / Ended with counts, one row per push (name and audience size,
// Kind, what the tap opens, results, status). Pushes sent with an offer are rows too ("With offer", opening that
// offer in Offers). The editor takes the page in the list's place, laid out like the Offers editor: the phone pinned
// on the left (Push tab only), the cards on the right, the summary bar with Send push. A sent push opens read-only,
// with its results card at the top. Every rule and string is src/lib/pushesModel.ts and src/lib/audienceModel.ts.
//
// THE BACKEND isn't on staging yet (src/lib/pushesServer.ts): with backend "missing" the page says so, + New push is
// off, and only the offers' pushes are listed. A dev server can stand a fixture in for it (PUSHES_FIXTURE=1).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { audienceBodyOf, countLine, playersLine, removeToken, specProblem, tagText, type AudienceSpec, type FoundPlayer } from "@/lib/audienceModel";
import { COUNT_DEBOUNCE_MS, chicagoWallNow, fillText, lockScreenDate, matchTitle, matchWhere, wallLabel, type Campaign, type City, type FieldOpt, type MatchOpt } from "@/lib/offersModel";
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, testSendOutcome } from "@/lib/offersPush";
import {
  FOOTER, STATE_LABEL, TABS, TAP_LABEL, TAP_NEEDS_APP, TAP_NOTE, WEEKLY_CAP_DEFAULT, extraBookingsLine, formProblem, fullBody, newPushForm, patchBody, pct, previewText, pushFormOf,
  rowOf, rowOfOffer, rowsByTab, sentByLine, stateOf, summaryLine, tapOpensText, PUSH_HELP,
  type PushCampaign, type PushCount, type PushForm, type PushResultsData, type PushState, type Row, type Tab, type TapTarget,
} from "@/lib/pushesModel";
import WhoGetsIt, { type SampleAnswer } from "@/components/audience/WhoGetsIt";
import MatchPicker from "@/components/offers/MatchPicker";
import { PushLockScreen } from "@/components/offers/OfferPush";
import { Banner, Btn, Card, Chip, ConfirmDialog, NotFound, O, VerdictLine, authed, inputCls, inputStyle, outcomeOf, settled, type WriteOutcome } from "@/components/offers/offersUi";
import { useOffersAccessState } from "@/components/offers/useOffersAccess";

type Data = {
  pushes: PushCampaign[]; backend: "ready" | "missing"; backendError: string | null; fixture: boolean;
  offers: Campaign[]; cities: City[]; fields: FieldOpt[]; matches: MatchOpt[]; matchesComplete: boolean; matchesError: string | null; weeklyCap: number | null;
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
  const landed = useCallback((o: WriteOutcome, after: PushCampaign | null, gone?: number) => {
    setBanner(o);
    setData((d) => {
      if (!d) return d;
      if (gone !== undefined) return { ...d, pushes: d.pushes.filter((p) => p.id !== gone) };
      if (!after) return d;
      const has = d.pushes.some((p) => p.id === after.id);
      return { ...d, pushes: has ? d.pushes.map((p) => (p.id === after.id ? after : p)) : [after, ...d.pushes] };
    });
    if (after) setOpen(after.id);
    if (gone !== undefined) setOpen(null);
  }, []);

  const nowMs = Date.now();
  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const mine = data.pushes.map((p) => rowOf(p, data.cities, data.fields, data.matches, nowMs));
    const withOffer = data.offers.map((c) => rowOfOffer(c, data.cities, data.fields, data.matches, nowMs)).filter((r): r is Row => r !== null);
    return [...mine, ...withOffer];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const byTab = useMemo(() => rowsByTab(rows), [rows]);

  if (isLoading || accessState === null) return <div className="px-1 py-6 text-[13px]" style={{ color: O.muted }}>Loading…</div>;
  if (accessState !== "yes") return <NotFound />;

  const current = typeof open === "number" ? data?.pushes.find((p) => p.id === open) ?? null : null;
  const editing = !!data && (open === "new" || !!current);
  const missing = data?.backend === "missing";

  return (
    <div className="min-w-0 px-1 pb-16" style={{ color: O.ink }}>
      {banner && <Banner outcome={banner} onDismiss={() => setBanner(null)} />}
      {err ? (
        <div data-testid="pushes-error" className="rounded-[10px] border px-3 py-2.5 text-[12.5px]" style={{ background: O.critBg, borderColor: O.critLine, color: O.critInk }}>Could not load: {err}</div>
      ) : !data ? <div className="py-6 text-[13px]" style={{ color: O.muted }}>Loading…</div> : editing ? (
        <PushEditor key={`${open}:${open === "new" ? newN : ""}`} c={current} data={data} onClose={() => setOpen(null)} onLanded={landed} />
      ) : (
        <div data-testid="pushes-list" className="flex flex-col gap-3.5 rounded-[16px] border px-4 py-5 sm:px-6" style={{ background: O.surface, borderColor: O.line }}>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 text-[18px] font-bold" style={{ color: O.ink }}>Push Notifications</h1>
            <div className="ml-auto" />
            <Btn testId="pushes-refresh" onClick={() => setKey((k) => k + 1)}>Refresh</Btn>
            <Btn kind="primary" testId="pushes-new" disabled={missing} title={missing ? "The Push Notifications backend isn't on this server yet" : undefined} onClick={() => { setOpen("new"); setNewN((x) => x + 1); }}>+ New push</Btn>
          </div>
          {missing && (
            <div data-testid="pushes-missing" className="rounded-[10px] px-3 py-2.5 text-[12.5px]" style={{ background: O.warnBg, color: O.warnInk }}>
              The Push Notifications backend isn&apos;t on this server yet, so new pushes can&apos;t be made here. Pushes sent with offers are listed below.{data.backendError ? ` (${data.backendError})` : ""}
            </div>
          )}
          {data.fixture && <div data-testid="pushes-fixture" className="rounded-[10px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Dev fixture: the pushes below are stand-in data in this dev server&apos;s memory. Offers and their pushes are real (staging).</div>}
          <div className="flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Chip key={t.key} testId={`pushes-tab-${t.key}`} on={tab === t.key} onClick={() => setTab(t.key)}>{`${t.label} · ${byTab[t.key].length}`}</Chip>
            ))}
          </div>
          <div className="hidden grid-cols-[minmax(0,1.4fr)_96px_minmax(0,1fr)_minmax(0,1.05fr)_84px] gap-3 px-3 text-[11px] font-semibold md:grid" style={{ color: O.muted }}>
            <div>NAME</div><div>KIND</div><div>WHAT</div><div>RESULTS</div><div />
          </div>
          {byTab[tab].length === 0 ? (
            <div data-testid="pushes-empty" className="rounded-[10px] border px-3 py-6 text-center text-[13px]" style={{ borderColor: O.line, color: O.muted }}>Nothing {tab === "drafts" ? "in drafts" : tab === "ended" ? "has ended yet" : tab === "scheduled" ? "is scheduled" : "is live"}.</div>
          ) : byTab[tab].map((r) => (
            <ListRow key={r.key} r={r} onOpen={() => (r.kind === "MESSAGE" ? setOpen(r.id) : undefined)} />
          ))}
          <div className="text-[12px]" style={{ color: O.muted }}>{FOOTER}</div>
        </div>
      )}
    </div>
  );
}

const STATE_STYLE: Record<PushState, { bg: string; ink: string; border?: string }> = {
  LIVE: { bg: O.mint, ink: O.chipOn }, SCHEDULED: { bg: "#edede8", ink: O.muted }, DRAFT: { bg: O.surface, ink: O.muted, border: O.line }, ENDED: { bg: "#eef0ee", ink: O.muted },
};
function StatusChip({ state }: { state: PushState }) {
  const s = STATE_STYLE[state];
  return <span data-testid="pushes-state" data-state={state} className="inline-flex whitespace-nowrap rounded-full px-2 py-[3px] text-[11px] font-semibold" style={{ background: s.bg, color: s.ink, border: s.border ? `1px solid ${s.border}` : undefined }}>{STATE_LABEL[state]}</span>;
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
      <div className="flex md:justify-end"><StatusChip state={r.state} /></div>
    </>
  );
  const cls = "grid grid-cols-1 items-center gap-1.5 rounded-[10px] border p-3 text-left md:grid-cols-[minmax(0,1.4fr)_96px_minmax(0,1fr)_minmax(0,1.05fr)_84px] md:gap-3";
  return r.kind === "MESSAGE"
    ? <div role="button" tabIndex={0} data-testid="pushes-row" data-kind={r.kind} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }} className={`${cls} cursor-pointer hover:brightness-[0.98]`} style={{ borderColor: O.line, background: O.surface }}>{body}</div>
    : <Link data-testid="pushes-row" data-kind={r.kind} href={`/match-ops/offers?open=${r.offerId}`} className={`${cls} hover:brightness-[0.98]`} style={{ borderColor: O.line, background: O.surface }}>{body}</Link>;
}

// ── THE EDITOR ───────────────────────────────────────────────────────────────────────────────────
type Lookup = { players: FoundPlayer[]; notFound: string[]; note?: string };
function PushEditor({ c, data, onClose, onLanded }: { c: PushCampaign | null; data: Data; onClose: () => void; onLanded: (o: WriteOutcome, after: PushCampaign | null, gone?: number) => void }) {
  const nowWall = chicagoWallNow();
  const [f, setF] = useState<PushForm>(() => (c ? pushFormOf(c, nowWall) : newPushForm(nowWall)));
  const set = (p: Partial<PushForm>) => setF((x) => ({ ...x, ...p }));
  const locked = c !== null && c.status !== "DRAFT";
  const missing = data.backend === "missing";
  const off = locked || missing;
  const cap = data.weeklyCap ?? WEEKLY_CAP_DEFAULT;

  // ── exact players: looked up as typed ──
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupFor, setLookupFor] = useState<string | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const playersMode = f.audience.mode === "PLAYERS";
  const text = f.audience.playersText;
  useEffect(() => {
    if (!playersMode || !text.trim()) { setLookup(null); setLookupFor(text); setLookupErr(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/pushes/players", { method: "POST", body: JSON.stringify({ text }) });
      if (cancelled) return;
      setLookupFor(text);
      if (r.ok) { setLookup(r.json as unknown as Lookup); setLookupErr(null); } else { setLookup(null); setLookupErr(String(r.json.error)); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [playersMode, text]);
  const playerIds = useMemo(() => [...new Set((lookup?.players ?? []).map((p) => p.id))], [lookup]);
  const lookupReady = !playersMode || (lookupFor === text && !lookupErr);

  // ── the live count, debounced ──
  const audBody = JSON.stringify(audienceBodyOf(f.audience, playerIds));
  const audOk = specProblem(f.audience) === null && (!playersMode || playerIds.length > 0);
  const [count, setCount] = useState<PushCount | null>(null);
  const [countFor, setCountFor] = useState<string | null>(null);
  const [countErr, setCountErr] = useState<string | null>(null);
  const [countTry, setCountTry] = useState(0);
  useEffect(() => {
    if (locked || missing || !audOk) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/pushes/audience", { method: "POST", body: audBody });
      if (cancelled) return;
      setCountFor(audBody);
      if (r.ok) { setCount(r.json as unknown as PushCount); setCountErr(null); } else { setCount(null); setCountErr(String(r.json.error)); }
    }, COUNT_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [audBody, audOk, locked, missing, countTry]);
  const countNow = countFor === audBody ? count : null;

  // ── tap target ──
  const m = f.tapTarget === "MATCH" && f.tapMatchId !== null ? data.matches.find((x) => x.id === f.tapMatchId) ?? null : null;
  const field = f.tapTarget === "FIELD" && f.tapFieldId !== null ? data.fields.find((x) => x.id === f.tapFieldId) ?? null : null;
  const [changingMatch, setChangingMatch] = useState(false);
  const preview = previewText(f, m);

  // ── writes ──
  const problem = formProblem(f, playerIds, data.matches, nowWall) ?? (lookupReady ? null : lookupErr ? `Couldn't look the players up: ${lookupErr}` : "Looking the players up…");
  const dirty = c === null || Object.keys(patchBody(c, f, playerIds)).length > 0;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [confirm, setConfirm] = useState<null | "send" | "delete">(null);
  const [test, setTest] = useState<WriteOutcome | null>(null);
  async function once<T>(fn: () => Promise<T>): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current = true; setBusy(true);
    try { return await fn(); } finally { inFlight.current = false; setBusy(false); }
  }
  async function save(): Promise<{ o: WriteOutcome; after: PushCampaign | null }> {
    if (c !== null && !dirty) return { o: { verdict: "LANDED", text: "Nothing to save." }, after: c };
    const r = c === null
      ? await authed("/api/pushes", { method: "POST", body: JSON.stringify(fullBody(f, playerIds)) })
      : await authed(`/api/pushes/${c.id}`, { method: "PATCH", body: JSON.stringify(patchBody(c, f, playerIds)) });
    return { o: outcomeOf(r, c === null ? `Saved "${f.name.trim()}" as a draft.` : `Saved changes to "${f.name.trim()}".`), after: (r.json.after ?? null) as PushCampaign | null };
  }
  async function onSave() {
    const r = await once(save);
    if (!r) return;
    setOutcome(r.o);
    if (r.o.verdict === "LANDED" && r.after) onLanded(r.o, r.after);
  }
  async function sendNow(): Promise<WriteOutcome> {
    let id = c?.id ?? null;
    if (c === null || dirty) {
      const s = await save();
      if (s.o.verdict !== "LANDED" || !s.after) return s.o;
      id = s.after.id;
      onLanded(s.o, s.after);
    }
    const r = await authed(`/api/pushes/${id}/send`, { method: "POST" });
    const o = outcomeOf(r, f.at ? `Scheduled "${f.name.trim()}" for ${wallLabel(`${f.sendLocal}:00`)}.` : `Sent "${f.name.trim()}". It's queued now.`);
    if (o.verdict === "LANDED") onLanded(o, (r.json.after ?? null) as PushCampaign | null);
    return o;
  }
  async function sendTest() {
    if (c === null) return;
    const r = await once(() => authed(`/api/pushes/${c.id}/test`, { method: "POST", body: JSON.stringify({ title: f.title, body: f.body }) }));
    if (!r) return;
    setTest(r.json.verdict === "SENT" || r.json.verdict === "PARTIAL" ? testSendOutcome(r.json) : outcomeOf(r, ""));
  }
  async function discard(): Promise<WriteOutcome> {
    const r = await authed(`/api/pushes/${c!.id}`, { method: "DELETE" });
    const o = outcomeOf(r, `Deleted the draft "${c!.name}".`);
    if (o.verdict === "LANDED") onLanded(o, null, c!.id);
    return o;
  }

  const summary = summaryLine(f, countNow, cap, playerIds.length);
  const sendWhy = missing ? "The Push Notifications backend isn't on this server yet." : problem;
  const tags = (lookup?.players ?? []).map((p) => ({ key: p.token ?? String(p.id), label: tagText(p) }));
  const onSample = async (): Promise<SampleAnswer> => {
    const r = await authed("/api/pushes/audience", { method: "POST", body: JSON.stringify({ ...JSON.parse(audBody), sample: true }) });
    return r.ok ? (r.json as unknown as SampleAnswer) : { error: String(r.json.error) };
  };

  return (
    <div data-testid="pushes-editor" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button type="button" data-testid="pushes-back" onClick={onClose} className="self-start whitespace-nowrap text-[13px] font-semibold" style={{ color: O.muted }}>← Back to push notifications</button>
          <h1 className="m-0 truncate text-[26px] font-bold" style={{ color: O.ink }}>{c ? c.name || "Untitled push" : "New push"}</h1>
        </div>
        {!locked && (
          <div className="flex flex-wrap gap-2">
            <Btn testId="pushes-save" disabled={busy || off || !f.name.trim() || (c !== null && !dirty && settled(outcome))} onClick={onSave}>{c === null ? "Save draft" : "Save changes"}</Btn>
            <Btn testId="pushes-test" disabled={busy || off || c === null || !f.title.trim() || !f.body.trim()} title={c === null ? "Save it as a draft first" : undefined} onClick={sendTest}>Send test</Btn>
            <Btn kind="primary" testId="pushes-send" disabled={busy || !!sendWhy} title={sendWhy ?? undefined} onClick={() => setConfirm("send")}>Send push</Btn>
          </div>
        )}
      </div>
      {outcome && <VerdictLine outcome={outcome} />}
      {test && <div data-testid="pushes-test-outcome"><VerdictLine outcome={test} /></div>}

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
            <div data-testid="pushes-opens" className="text-center text-[12px] font-medium" style={{ color: O.muted }}>↳ Tapping opens {tapOpensText(f.tapTarget, m, field)}</div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {c && c.status !== "DRAFT" && <ResultsCard c={c} />}

          <Card title="Push" sub={`A message, no discount. Counts toward each player's ${cap} marketing pushes a week. For a discount, use Offers.`} testId="pushes-card-push">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold" style={{ color: O.ink }}>Name (only staff see this)</span>
              <input data-testid="pushes-name" disabled={off} className={inputCls} style={inputStyle} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Austin · Saturday NEMP fill" />
            </label>
          </Card>

          <WhoGetsIt spec={f.audience} onChange={(a: AudienceSpec) => set({ audience: a })} allowed={null} cities={data.cities} fields={data.fields} nowWall={nowWall} disabled={off} testId="pushes-who"
            count={locked || missing ? { state: "off" } : !audOk ? { state: "off" } : countErr && countFor === audBody ? { state: "error", error: countErr, onRetry: () => setCountTry((x) => x + 1) } : countNow ? { state: "ready", text: countLine({ count: countNow.count, allowPush: countNow.allowPush, holdoutPercent: countNow.holdoutPercent, heldBack: countNow.heldBack }) } : { state: "counting" }}
            onSample={onSample}
            players={{
              hint: "Paste player IDs, emails or phone numbers, separated by commas or new lines.", placeholder: "78, 1481, 3193\nluis@example.com\n(512) 555-0142",
              tags, notFound: lookup?.notFound ?? [],
              line: lookup ? playersLine(lookup.players) : lookupErr ? null : text.trim() ? "Looking them up…" : null,
              extra: (
                <>
                  {lookupErr && <div className="text-[12px]" style={{ color: O.critInk }}>Couldn&apos;t look them up: {lookupErr}</div>}
                  {lookup?.note && <div className="text-[12px]" style={{ color: O.muted }}>{lookup.note}</div>}
                </>
              ),
              onRemove: (k) => set({ audience: { ...f.audience, playersText: removeToken(text, k) } }),
            }} />

          <Card title="Message" testId="pushes-card-message">
            <TextField label="Title" value={f.title} max={PUSH_TITLE_MAX} disabled={off} testId="pushes-title" onChange={(v) => set({ title: v })} placeholder="6 spots left Saturday at NEMP" />
            <TextField label="Body" value={f.body} max={PUSH_BODY_MAX} disabled={off} testId="pushes-body" onChange={(v) => set({ body: v })} placeholder="{first_name}, Sat 7:00 PM in Austin. Grab one before it fills." rows={2} />
            <div data-testid="pushes-help" className="text-[12px]" style={{ color: O.muted }}>{PUSH_HELP}</div>
          </Card>

          <Card title="Tap opens" testId="pushes-card-tap">
            <div className="flex flex-wrap gap-2">
              {(["MATCH", "HOME", "FIND_MATCH", "FIELD"] as TapTarget[]).map((t) => {
                const needsApp = TAP_NEEDS_APP.includes(t);
                return <Chip key={t} testId={`pushes-tap-${t}`} on={f.tapTarget === t} disabled={off || needsApp} title={needsApp ? "Needs the next app update" : undefined}
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
                    {!off && <Btn testId="pushes-match-change" onClick={() => setChangingMatch(true)}>Change</Btn>}
                  </div>
                )}
                {(!m || changingMatch) && !off && (
                  <MatchPicker matches={data.matches} cities={data.cities} cityIds={[]} selected={m} nowWall={nowWall} startOpen={changingMatch}
                    onPick={(id) => { set({ tapMatchId: id }); setChangingMatch(false); }} onOpen={() => undefined} onRetry={() => undefined}
                    listState={data.matchesError ? "failed" : "ready"} listError={data.matchesError} partial={!data.matchesComplete} testId="pushes-match-picker" />
                )}
                {!m && f.tapMatchId !== null && <div className="text-[12px]" style={{ color: O.warnInk }}>Match {f.tapMatchId} isn&apos;t in the upcoming list any more. Pick another.</div>}
              </>
            )}
          </Card>

          <Card title="Sends" testId="pushes-card-sends">
            <div className="flex flex-wrap gap-2"><Chip testId="pushes-once" on>Once</Chip></div>
            <div className="flex flex-wrap gap-2">
              <Chip testId="pushes-now" on={!f.at} disabled={off} onClick={() => set({ at: false })}>Now</Chip>
              <Chip testId="pushes-at" on={f.at} disabled={off} onClick={() => set({ at: true })}>At a time</Chip>
            </div>
            {f.at && (
              <label className="relative flex max-w-[260px] rounded-[8px] border px-3 py-[9px]" style={{ borderColor: O.line, opacity: off ? 0.6 : 1 }}>
                <span data-testid="pushes-at-label" className="text-[13px]" style={{ color: O.ink }}>{wallLabel(`${f.sendLocal}:00`)}</span>
                <input data-testid="pushes-at-input" type="datetime-local" disabled={off} value={f.sendLocal.replace(" ", "T")}
                  onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch { /* older browsers */ } }}
                  onChange={(e) => { if (e.target.value) set({ sendLocal: e.target.value.replace("T", " ").slice(0, 16) }); }}
                  className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
              </label>
            )}
            <div className="text-[12px]" style={{ color: O.muted }}>{f.at ? "Once, at this time in each player's own city." : "Once, as soon as you press Send push."}</div>
          </Card>

          {!locked && (
            <div data-testid="pushes-summary-bar" className="flex flex-col gap-3 rounded-[14px] px-5 py-4 sm:flex-row sm:items-center sm:gap-4" style={{ background: O.mint }}>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div data-testid="pushes-summary" className="text-[13px] font-semibold" style={{ color: O.chipOn }}>{summary}</div>
                {sendWhy && <div data-testid="pushes-why" className="text-[12px]" style={{ color: O.warnInk }}>{sendWhy}</div>}
              </div>
              <div className="flex gap-2">
                {c && <Btn kind="danger" testId="pushes-delete" disabled={busy || missing} onClick={() => setConfirm("delete")}>Delete draft</Btn>}
                <Btn kind="primary" testId="pushes-send-bar" disabled={busy || !!sendWhy} title={sendWhy ?? undefined} onClick={() => setConfirm("send")}>Send push</Btn>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirm === "send" && (
        <ConfirmDialog title={f.at ? "Schedule this push?" : "Send this push now?"} note={summary} action={f.at ? "Schedule push" : "Send push"}
          extra={<span style={{ color: O.muted }}>It goes once and can&apos;t be called back. {c === null || dirty ? "Your changes are saved first." : ""}</span>}
          onConfirm={async () => { const o = await sendNow(); if (o.verdict === "LANDED") setConfirm(null); return o; }} onCancel={() => setConfirm(null)} />
      )}
      {confirm === "delete" && c && (
        <ConfirmDialog title="Delete this draft?" note="It was never sent. This can't be undone." action="Delete draft" kind="dangerSolid"
          onConfirm={async () => { const o = await discard(); if (o.verdict === "LANDED") setConfirm(null); return o; }} onCancel={() => setConfirm(null)} />
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
function ResultsCard({ c }: { c: PushCampaign }) {
  const [r, setR] = useState<PushResultsData | null>(c.results);
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
  const state = stateOf(c, Date.now());
  return (
    <section data-testid="pushes-results" className="flex flex-col gap-3.5 rounded-[14px] border px-[22px] pb-5 pt-[18px]" style={{ background: O.surface, borderColor: O.line }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="m-0 text-[15px] font-bold" style={{ color: O.ink }}>Results · {c.name}</h2>
        <div className="flex-1" />
        <span data-testid="pushes-sent-by" className="text-[12px]" style={{ color: O.muted }}>{c.status === "SCHEDULED" && c.sendLocal ? `Scheduled for ${wallLabel(`${c.sendLocal}:00`)}` : sentByLine(c)}</span>
        <StatusChip state={state} />
      </div>
      {err && <div className="text-[12px]" style={{ color: O.critInk }}>Couldn&apos;t read the results: {err}</div>}
      {!r ? (c.status === "SENT" && !err ? <div className="text-[12px]" style={{ color: O.muted }}>Loading results…</div> : <div className="text-[12px]" style={{ color: O.muted }}>{c.status === "NOT_SENT" ? "It didn't go: nobody was left to reach once the filters, consent and the weekly limit were applied." : "Nothing sent yet."}</div>) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat testId="pushes-stat-sent" label="Sent" value={n(r.sent)} sub={`of ${n(r.targeted)} targeted`} />
            <Stat testId="pushes-stat-opened" label="Opened" value={n(r.opened)} sub={`${pct(r.opened, r.sent)} of sent`} />
            <Stat testId="pushes-stat-booked" label="Booked within 3 days" value={n(r.bookedWithin3Days)} sub="from players who got it" />
            <Stat testId="pushes-stat-held" label="Held back booked" value={n(r.heldBackBooked)} sub={`of ${n(r.heldBack)} held back`} />
          </div>
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
