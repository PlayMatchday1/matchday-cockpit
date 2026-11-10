"use client";

// ONE OFFER, the editor (Figma 20825:45; the photo picker is 20826:49 and the Push tab 20826:121). It takes the
// whole page in place of the list: ← Back to offers and the title, with Save draft, Send test and Launch top right;
// the live preview pinned on the left (a real-size phone with the popup, or the push as a lock screen); the form
// on the right as white cards: The deal, Applies to, Who gets it, Popup, Push notification, Runs, then the green
// summary bar with Launch. Every edit redraws the preview at once. Under 1100px wide the preview sits on top and
// the form under it. After launch the deal, the audience and the dates are locked (the backend refuses them); the
// name, the popup text and the total limit can still change, and Pause and End appear in the summary bar.
//
// SEND TEST (backend POST .../send-preview): the popup on up to 20 players' phones on their next app
// open, or on your own with Use my email. Needs a saved offer (any status, drafts included). Reported
// as "Sent to N", never as arrived. The last ids are remembered in this browser as a convenience.
//
// NOT HERE YET, on purpose: the "Show popup on app open" switch at the top of the Popup card and push access beyond
// OFFERS_PUSH_ACCOUNTS. Both wait on backend work; the Popup card leaves the switch's row open (see SHOW POPUP below).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FIRST_NAME_TOKEN, isAdminAccount, MAX_TEST_IDS, SECTION_ADD, addSection, autoCopy, canReset, copyAfterType, isRemovable, staleLines, staleSections, writtenForOnLoad, removeSection, resetCopy, sectionCollapsed, copyAfterHide, hideUpload, photoContentType, photoFileProblem, photoUrlOk, settableHeaders, MAX_USES_PER_PLAYER, notFoundLine, parsePlayerIds, playerLine, PREVIEW_FIRST_NAME, amountText, limitLine, stepLimit, stepUses, usesLine, audienceBody, buttonMatchNote, buttonOf, opensText, chicagoWallNow, copyOf, createBody, defaultRun, endsTicket, formOf, formProblem, fromInput, matchInfo,
  newForm, contractIncomplete, holdoutFor, isAnnouncement, announcementTicket, DEFAULT_HOLDOUT_PERCENT, on188Line, heldBackLine, playersHoldoutOn, PLAYERS_HOLDOUT_MIN, patchBody, playedAtSuggestions, mergeMatches, withCovers, endNote, pauseNote, ranUntil, COUNT_BLOCK, COUNT_DEBOUNCE_MS, countState, countWanted, lockedSummary, endHasPassed, launchProblem, offerWallNow, offerZones, setPriceAnyWarning, setPriceProblem, pickedMatch, startLabel, STEPPER, summary, toInput, wallLabel,
  photoTiles, photoTileOf, suggestedPhotoTiles, suggestedPhotoLabel, photoReason, photoRowName, lockScreenDate, popupOffBlock, pushOnlyPrefix,
  type Campaign, type City, type Count, type FieldOpt, type Lookup, type UploadedPhoto, type CopyKey, type ListChange, type DealType, type Form, type MatchOpt, type WrittenFor,
} from "@/lib/offersModel";
import MatchPicker from "./MatchPicker";
import WhoGetsIt, { type SampleAnswer } from "@/components/audience/WhoGetsIt";
import { WEEKLY_CAP_DEFAULT } from "@/lib/pushesModel";
import { OFFERS_FILTERS, OFFERS_HINTS, OFFERS_MEMBERSHIP, audienceOf, capFlagLine, countLine, entriesOf, newRow, offerOfSpec, removeToken, specOfAudience, specOfOffer, specProblem, tagText, toContract, todayWall, type AudienceSpec, type TokenLookup } from "@/lib/audienceModel";
import PhotoPicker from "./PhotoPicker";
import OfferPreview, { type PreviewTab } from "./OfferPreview";
import { PushReach, PushSection, SendsTo } from "./OfferPush";
import { defaultSendLocal, fillPush, pushBodyOf, pushDirty, pushFormOf, pushLocked, pushProblem, pushSuggestion, pushText, type PushForm } from "@/lib/offersPush";
import { lookupInBatches, MAX_OFFER_PLAYER_IDS, pastedLine, playerLookupBlock } from "@/lib/offersModel";
import { SHRINK_HINT, TOO_LONG_WARNING, isShrunk, isTooLong, popupHeadlineFit, popupHeadlineParts } from "@/lib/headlineFit";
import {
  Btn, Card, Chip, ConfirmDialog, Labeled, O, Toggle, VerdictLine, authed, inputCls, inputStyle, outcomeOf, settled, type WriteOutcome,
} from "./offersUi";

// Whether the matches this offer names are in hand. Until they are, what the form would work out from
// them (the match, its button, its text) is wrong, so nothing can be edited or launched. Pause, End and
// Delete still work, so an offer whose match can't be read can always be stopped.
export type MatchRead = "ok" | "loading" | "failed";
type Data = { campaigns: Campaign[]; cities: City[]; fields: FieldOpt[]; matches: MatchOpt[]; matchesComplete: boolean; matchesError: string | null; pushes?: boolean };
const DEALS: { type: DealType; label: string }[] = [
  { type: "PERCENT_OFF", label: "% off" }, { type: "AMOUNT_OFF", label: "$ off" }, { type: "SET_PRICE", label: "Set price" }, { type: "FREE_MATCH", label: "Free match" },
  { type: "NONE", label: "No discount" },
];
// An announcement's text (Figma 20892:20143): the headline is two inputs, its plain part here and its accent beside it.
const ANNOUNCEMENT_FIELDS: readonly (readonly [CopyKey, string, number])[] = [
  ["eyebrow", "Tag on the photo", 64], ["caption", "Line on the photo", 64], ["headline", "Headline", 64], ["line", "Line", 64],
  ["body", "Body", 300], ["buttonLabel", "Button text", 64], ["dismissLabel", "Dismiss link", 64],
];
// The popup's text, in the order the card shows them (two to a row on a wide form; the body takes a whole row).
const COPY_FIELDS: readonly (readonly [CopyKey, string, number])[] = [
  ["eyebrow", "Tag on the photo", 64], ["caption", "Line on the photo", 64], ["headline", "Headline (last word in green)", 64], ["line", "Line", 64],
  ["body", "Body", 300], ["buttonLabel", "Button label", 64], ["dismissLabel", "Dismiss link", 64],
];
const uploadsKey = (id: number) => `offers:uploaded-photos:${id}`;
function readUploads(id: number): UploadedPhoto[] {
  try { const v = JSON.parse(window.localStorage.getItem(uploadsKey(id)) ?? "[]"); return Array.isArray(v) ? v.filter((p) => typeof p?.url === "string" && photoUrlOk(p.url)) : []; } catch { return []; }
}
const keepUploads = (id: number, list: UploadedPhoto[]) => { try { window.localStorage.setItem(uploadsKey(id), JSON.stringify(list)); } catch { /* private mode */ } };
// The PUT, from the browser, so progress can be shown and a 5 MB file never passes through a route.
function putPhoto(url: string, headers: [string, string][], file: File, onProgress: (f: number) => void): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    for (const [k, v] of headers) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, text: x.responseText.slice(0, 200) });
    x.onerror = () => resolve({ ok: false, status: 0, text: "network or CORS" });
    x.onabort = () => resolve({ ok: false, status: 0, text: "stopped" });
    x.send(file);
  });
}
const writtenKey = (id: number) => `offers:written-for:${id}`;
const readWritten = (id: number): WrittenFor => { try { const v = JSON.parse(window.localStorage.getItem(writtenKey(id)) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const keepWritten = (id: number, w: WrittenFor) => { try { window.localStorage.setItem(writtenKey(id), JSON.stringify(w)); } catch { /* private mode */ } };
const TEST_IDS_KEY = "offers:last-test-ids";
const readTestIds = () => { try { return window.localStorage.getItem(TEST_IDS_KEY) ?? ""; } catch { return ""; } };
const keepTestIds = (text: string) => { try { window.localStorage.setItem(TEST_IDS_KEY, text); } catch { /* private mode */ } };

export default function OfferPanel({ c, data: loaded, matchRead, onRetryMatch, onClose, onLanded, results, seed }: {
  c: Campaign | null; data: Data; matchRead: MatchRead; onRetryMatch: () => void; onClose: () => void; onLanded: (o: WriteOutcome, selectId?: number, change?: ListChange) => void;
  // A new offer's starting point beyond the defaults (Match Promotion's link: a popup with no discount for one match).
  seed?: Partial<Form>;
  // The results card for a launched offer, drawn by the page; sits at the top of the form column.
  results?: React.ReactNode;
}) {
  const nowWall = useMemo(() => chicagoWallNow(), []);
  // THE PICKER'S LIST. The page's load holds one page of it. Only if that wasn't all of them (or it
  // failed) is this offer's own cities' list read, once per set of cities, and for an offer that has
  // launched only once someone opens a picker.
  const [pool, setPool] = useState<{ key: string; matches: MatchOpt[]; complete: boolean } | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [poolWanted, setPoolWanted] = useState(c === null || c.status === "DRAFT");
  const [poolRetry, setPoolRetry] = useState(0);
  const data = useMemo(() => (pool ? { ...loaded, matches: withCovers(mergeMatches(pool.matches, loaded.matches), loaded.fields) } : loaded), [loaded, pool]);
  // THE SHARED AUDIENCE (backend docs/push-notifications.md): a backend that has it answers every campaign with
  // `audience`. Then the full filter list, the email and phone lookup and the sample are on, and `audience` is what is
  // sent; on a backend from before it, the five old filters and ids only, exactly as before.
  const v2 = data.campaigns.some((x) => x.audience !== undefined);
  const start = useMemo(() => (c ? formOf(c, data.matches, data.cities, data.fields) : { ...newForm(nowWall), audienceFilters: v2 ? [] : null, ...(seed ?? {}) }), [c, data, nowWall, v2, seed]);
  const [f, setF] = useState<Form>(start);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const locked = c !== null && c.status !== "DRAFT";
  const ended = c?.status === "ENDED";
  const matchUnread = matchRead !== "ok";
  const frozen = ended || matchUnread;
  const m = pickedMatch(f, data.matches);
  const copy = copyOf(f, data.matches, data.cities, data.fields);
  // Now, as the wall clock furthest ahead among this offer's cities. Worked out when asked, not on mount.
  const offerWall = () => offerWallNow(offerZones(f, m?.cityId ?? null, data.cities));
  // A saved draft with a match or fields can't become a popup with no discount: the backend keeps its stored match and
  // refuses NONE with it ("an offer with no deal applies nowhere"), and the contract gives the Clubhouse no way to clear it.
  const savedWithScope = c !== null && f.dealType === "NONE" && c.dealType !== "NONE" && (c.matchIds.length > 0 || (c.appliesFieldIds?.length ?? 0) > 0);
  const problem = matchUnread ? null : savedWithScope ? "This draft was saved for a specific match or fields, which a popup with no discount can't have. Start a new offer for the popup instead." : formProblem(f, data.matches, c?.status ?? null);
  const diff = c && !matchUnread ? patchBody(c, f, data.matches, data.cities, data.fields) : null;
  // THE PUSH (src/components/offers/OfferPush.tsx). Only where the server allows the controls; saved after the
  // offer itself, with its own request (PUT .../push), and before a launch so the launch can queue it.
  const pushOn = !!data.pushes;
  // An announcement's push says what its popup says: the headline (both parts) and the body as typed.
  const annHead = [copyOf(f, data.matches, data.cities, data.fields).headline, f.headlineAccent].filter((x) => x && x.trim()).join(" ");
  const pushSugg = isAnnouncement(f) ? { title: annHead.slice(0, 64), body: copyOf(f, data.matches, data.cities, data.fields).body ?? "" } : pushSuggestion(f, m, data.fields);
  const [pf, setPf] = useState<PushForm>(() => pushFormOf(c?.push, pushSuggestion(start, pickedMatch(start, data.matches), data.fields), defaultSendLocal(nowWall)));
  const pushIsDirty = pushOn && !matchUnread && !pushLocked(c?.push, c?.status ?? null) && pushDirty(c?.push, pf, pushSugg);
  const pushProb = pushOn && !matchUnread ? pushProblem(pf, pushSugg, f.scope) : null;
  const offerDirty = c === null || Object.keys(diff ?? {}).length > 0;
  const dirty = offerDirty || pushIsDirty;
  const needPool = !loaded.matchesComplete && poolWanted && !ended;
  const poolKey = f.cityIds.join(",");
  useEffect(() => {
    if (!needPool || pool?.key === poolKey) return;
    let cancelled = false;
    setPoolErr(null);
    const t = setTimeout(async () => {
      const r = await authed(`/api/offers/matches${poolKey ? `?cityIds=${poolKey}` : ""}`);
      if (cancelled) return;
      if (!r.ok) { setPoolErr(String(r.json.error)); return; }
      setPool({ key: poolKey, matches: r.json.matches as MatchOpt[], complete: r.json.complete === true });
    }, COUNT_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [needPool, poolKey, poolRetry, pool?.key]);
  const pickerProps = {
    matches: data.matches, cities: data.cities, cityIds: f.cityIds, nowWall, onOpen: () => setPoolWanted(true), onRetry: () => setPoolRetry((n) => n + 1),
    listState: poolErr ? ("failed" as const) : needPool && pool?.key !== poolKey ? ("loading" as const) : ("ready" as const),
    listError: poolErr, partial: pool?.key === poolKey && !pool.complete,
  };

  // ── the live count, debounced, for the audience and deal as they stand ──
  // Fires COUNT_DEBOUNCE_MS after the last change, one request at a time: a change while one is out
  // waits for it, then asks about the form as it stands by then. The route paces it again.
  const wantCount = countWanted(c?.status ?? null);
  const [countAnswer, setCountAnswer] = useState<Count | null>(null);
  const [countErr, setCountErr] = useState<string | null>(null);
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const audKey = JSON.stringify(audienceBody(f, data.matches, data.cities));
  const latestKey = useRef(audKey);
  const counting = useRef(false);
  const askAgain = useRef(false);
  const mounted = useRef(true);
  const askCount = useCallback(async () => {
    if (counting.current) { askAgain.current = true; return; }
    counting.current = true;
    const key = latestKey.current;
    const r = await authed("/api/offers/audience", { method: "POST", body: key });
    counting.current = false;
    if (!mounted.current) return;
    if (r.ok) { setCountErr(null); setCountAnswer(r.json as unknown as Count); }
    else { setCountErr(String(r.json.error)); setCountAnswer(null); }
    setAnsweredKey(key);
    if (askAgain.current) { askAgain.current = false; void askCount(); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    latestKey.current = audKey;
    if (matchUnread || !wantCount || contractIncomplete(f.audienceFilters)) return;
    const t = setTimeout(() => { void askCount(); }, COUNT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [audKey, matchUnread, wantCount, askCount]);
  const countNow = countState(audKey, answeredKey, countErr !== null);
  // An answer for an older audience is never shown or launched on.
  const count = countNow === "ready" ? countAnswer : null;
  const retryCount = () => { setAnsweredKey(null); void askCount(); };

  // ── writes ──
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [confirm, setConfirm] = useState<null | "launch" | "pause" | "end" | "delete" | "push">(null);
  const inFlight = useRef(false);
  const send = useCallback(async (path: string, method: "POST" | "PUT" | "PATCH", body: unknown, landed: string) => {
    const r = await authed(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { o: outcomeOf(r, landed), after: (r.json.after ?? null) as Campaign | null };
  }, []);
  async function once<T>(fn: () => Promise<T>): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current = true; setBusy(true);
    try { return await fn(); } finally { inFlight.current = false; setBusy(false); }
  }

  // Save: create a draft, or send only what changed.
  const savedAs = (after: Campaign | null): ListChange | undefined => (after ? { kind: "saved", campaign: after } : undefined);
  // The push, once the offer it belongs to has landed. Its failure is said on its own: the offer is saved.
  async function savePush(id: number, offer: { o: WriteOutcome; after: Campaign | null }) {
    if (!pushIsDirty) return offer;
    const p = await send(`/api/offers/${id}/push`, "PUT", pushBodyOf(pf, pushSugg), pf.enabled ? "Saved the push." : "Turned the push off.");
    if (p.o.verdict === "LANDED") return { o: { ...p.o, text: `${offer.o.text === "Nothing to save." ? "" : `${offer.o.text} `}${p.o.text}` }, after: p.after ?? offer.after };
    return { o: { ...p.o, text: `${offer.o.text === "Nothing to save." ? "" : `${offer.o.text} But `}the push did not save: ${p.o.text}` }, after: offer.after };
  }
  async function save(): Promise<{ o: WriteOutcome; id: number | null; after: Campaign | null }> {
    if (c === null) {
      const { o, after } = await send("/api/offers", "POST", createBody(f, data.matches, data.cities, data.fields), `Saved "${f.name.trim()}" as a draft.`);
      // A new offer's uploads move to its id, so they are still tiles when it reopens.
      if (after?.id) { keepUploads(after.id, uploaded); keepWritten(after.id, writtenFor); }
      if (o.verdict !== "LANDED" || !after?.id) return { o, id: after?.id ?? null, after };
      return { ...(await savePush(after.id, { o, after })), id: after.id };
    }
    if (!dirty) return { o: { verdict: "LANDED", text: "Nothing to save." }, id: c.id, after: null };
    let offer: { o: WriteOutcome; after: Campaign | null } = { o: { verdict: "LANDED", text: "Nothing to save." }, after: null };
    if (offerDirty) {
      offer = await send(`/api/offers/${c.id}`, "PATCH", diff, `Saved changes to "${f.name.trim()}".`);
      if (offer.o.verdict !== "LANDED") return { ...offer, id: c.id };
      keepWritten(c.id, writtenFor);
    }
    return { ...(await savePush(c.id, offer)), id: c.id };
  }
  // On a live offer, saving a push queues it at once: ask first.
  const pushGoesNow = c?.status === "LAUNCHED" && pushIsDirty && pf.enabled;
  async function onSave() {
    if (pushGoesNow && confirm !== "push") { setConfirm("push"); return; }
    const r = await once(save);
    if (!r) return;
    setOutcome(r.o);
    if (r.o.verdict === "LANDED") onLanded(r.o, r.id ?? undefined, savedAs(r.after));
  }
  // Launch (or resume): save first when there is anything to save, then launch. Two writes, in order;
  // the second goes only if the first LANDED. Neither is retried.
  async function launch(): Promise<WriteOutcome> {
    const passed = launchProblem(f, offerWall());
    if (passed) return { verdict: "FAILED", text: `${passed} Nothing was sent.` };
    let id = c?.id ?? null;
    let saved: Campaign | null = null;
    if (c === null || (c.status === "DRAFT" && dirty)) {
      const s = await save();
      saved = s.after;
      if (s.o.verdict !== "LANDED" || s.id === null) return c === null && s.o.verdict === "LANDED" ? { verdict: "UNKNOWN", text: "Saved, but the new offer's id did not come back. Refresh before launching." } : s.o;
      id = s.id;
    }
    const resume = c?.status === "PAUSED";
    const { o, after } = await send(`/api/offers/${id}/launch`, "POST", undefined, resume ? `Resumed "${f.name.trim()}".` : `Launched "${f.name.trim()}".`);
    if (o.verdict === "LANDED") { onLanded(o, id ?? undefined, savedAs(after)); return o; }
    // The save landed and the launch didn't: the panel moves to the saved draft, so a second try can't make another.
    if (saved) {
      const told = c === null ? { ...o, text: `Saved as a draft, but the launch did not land: ${o.text}` } : o;
      onLanded(told, id ?? undefined, savedAs(saved));
      return told;
    }
    return o;
  }
  async function discard(): Promise<WriteOutcome> {
    const r = await authed(`/api/offers/${c!.id}`, { method: "DELETE" });
    const o = outcomeOf(r, `Deleted the draft "${c!.name}".`);
    if (o.verdict === "LANDED") { onLanded(o, undefined, { kind: "gone", id: c!.id }); onClose(); }
    return o;
  }
  // ── send test ──
  const [testOpen, setTestOpen] = useState(false);
  const [testText, setTestText] = useState("");
  const testParsed = useMemo(() => parsePlayerIds(testText), [testText]);
  const [testLookup, setTestLookup] = useState<Lookup | null>(null);
  const testKey = testParsed.ids.join(",");
  useEffect(() => {
    if (!testOpen || testParsed.ids.length === 0 || testParsed.ids.length > MAX_TEST_IDS) { setTestLookup(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/offers/players", { method: "POST", body: JSON.stringify({ ids: testParsed.ids }) });
      if (!cancelled) setTestLookup(r.ok ? (r.json as unknown as Lookup) : null);
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testOpen, testKey]);
  const testIds = testParsed.ids.filter((id) => !(testLookup?.notFound ?? []).includes(id));
  async function sendTest(toMe: boolean) {
    const userIds = toMe ? [] : testIds;
    const r = await once(async () => authed(`/api/offers/${c!.id}/send-preview`, { method: "POST", body: JSON.stringify({ userIds }) }));
    if (!r) return;
    const sent = Array.isArray(r.json.sent) ? (r.json.sent as number[]) : [];
    const skipped = Array.isArray(r.json.notFound) ? (r.json.notFound as number[]) : [];
    const o = outcomeOf(r, `Sent to ${sent.length}. Open the app to see it.${skipped.length ? ` ${notFoundLine(skipped)}` : ""}`);
    setOutcome(o);
    if (o.verdict === "SENT") { if (!toMe) keepTestIds(testText); setTestOpen(false); }
  }
  async function move(action: "pause" | "end"): Promise<WriteOutcome> {
    const { o, after } = await send(`/api/offers/${c!.id}/${action}`, "POST", undefined, action === "pause" ? `Paused "${c!.name}".` : `Ended "${c!.name}".`);
    if (o.verdict === "LANDED") onLanded(o, c!.id, savedAs(after));
    return o;
  }

  // ── deal controls ──
  // NO DISCOUNT (an announcement, backend announcements.md): applies nowhere, so the scope, match, fields, uses and total go;
  // its holdout starts at 0 (staff can raise it). Leaving it puts a 0 holdout back to the default and drops what only
  // an announcement has.
  const pickDeal = (type: DealType) => {
    if (type === "NONE") {
      set({ dealType: "NONE", dealAmount: 0, scope: "ANY", matchId: null, appliesFieldIds: [], usesPerPlayer: 1, maxRedemptions: null, holdoutPercent: 0,
        buttonTarget: f.buttonTarget === "MATCH" ? "MATCH" : "FIND_MATCH" });
      return;
    }
    set({ dealType: type, dealAmount: STEPPER[type]?.start ?? 0,
      ...(isAnnouncement(f) ? { holdoutPercent: f.holdoutPercent === 0 ? DEFAULT_HOLDOUT_PERCENT : f.holdoutPercent, headlineAccent: null, buttonFieldId: null, buttonTarget: f.buttonTarget === "FIELD" ? "FIND_MATCH" : f.buttonTarget } : {}) });
  };
  const ann = isAnnouncement(f);
  // THE APP'S AUTO-FIT (lib/headlineFit): past 48pt on one line the headline is drawn smaller, then on two lines. The hint
  // sits under the headline inputs, full width.
  const headParts = popupHeadlineParts(copy.headline, f.headlineAccent, ann);
  const headFit = popupHeadlineFit(headParts.lead, headParts.accent);
  // More than two lines: a warning to shorten it, in place of the hint.
  const headlineHint = isTooLong(headFit)
    ? [<div key="headlineHint" data-testid="offers-headline-too-long" className="-mt-2 text-[11.5px] font-semibold sm:col-span-2" style={{ color: O.warnInk }}>{TOO_LONG_WARNING}</div>]
    : isShrunk(headFit)
      ? [<div key="headlineHint" data-testid="offers-headline-shrunk" className="-mt-2 text-[11.5px] sm:col-span-2" style={{ color: O.muted }}>{SHRINK_HINT}</div>]
      : [];
  const step = (dir: 1 | -1) => {
    const s = STEPPER[f.dealType];
    if (!s) return;
    set({ dealAmount: Math.min(s.max, Math.max(s.min, f.dealAmount + dir * s.step)) });
  };
  const addScopeField = (id: number) => set({ appliesFieldIds: [...f.appliesFieldIds, id] });
  const removeScopeField = (id: number) => set({ appliesFieldIds: f.appliesFieldIds.filter((x) => x !== id) });
  const pickScope = (scope: Form["scope"]) => {
    if (scope === f.scope) return;
    const leftField = f.scope === "FIELD" ? { appliesFieldIds: [] } : {};
    if (scope === "MATCH") set({ scope, ...leftField, usesPerPlayer: 1, endsLocal: f.endsLocal ?? defaultRun(nowWall).endsLocal });
    // Leaving a specific match goes back to a run of its own instead of ending at that kickoff.
    else set({ scope, ...leftField, matchId: null, ...(f.scope === "MATCH" ? { endsLocal: defaultRun(nowWall).endsLocal } : {}) });
  };
  const pickMatch = (id: number) => {
    const mm = data.matches.find((x) => x.id === id) ?? null;
    // A specific match's offer ends at its kickoff unless someone moves it.
    set({ matchId: id, ...(mm ? { endsLocal: mm.startLocal } : {}) });
  };

  // ── who gets it ──
  // The builder's rows, kept here so a row still being filled in (a City with no city yet) isn't lost. Every change is
  // written back to the form: the rows as the backend takes them (audienceFilters, sent on a backend with the shared
  // audience), and the nearest old fields (sent on one without it, and used for the suggested copy either way).
  const allowed = v2 ? null : OFFERS_FILTERS;
  const [audLoad] = useState(() => (v2 && c?.audience ? specOfAudience(c.audience, c.playerIds.join(", ")) : { spec: specOfOffer(start), unknown: 0 }));
  const [aud, setAudState] = useState<AudienceSpec>(audLoad.spec);
  const setAud = (s: AudienceSpec) => { setAudState(s); set({ ...offerOfSpec(s), audienceFilters: v2 ? s.filters.map(toContract) : null }); };
  const addPlayedAt = (id: number) => {
    const has = aud.filters.find((r) => r.key === "playedAt");
    setAud({ ...aud, filters: has ? aud.filters.map((r) => (r.key === "playedAt" ? { ...r, ids: [...r.ids, id] } : r)) : [...aud.filters, { ...newRow("playedAt", allowed, todayWall(nowWall)), ids: [id] }] });
  };
  const audWhy = audLoad.unknown > 0 ? `This offer has ${audLoad.unknown} ${audLoad.unknown === 1 ? "filter" : "filters"} this page can't show yet, so it can't be saved here.` : f.audienceMode === "FILTERS" ? specProblem(aud) : null;
  const fieldsInCities = data.fields.filter((x) => f.cityIds.length === 0 || (x.cityId !== null && f.cityIds.includes(x.cityId)));
  const [addingScopeField, setAddingScopeField] = useState(false);
  const otherScopeFields = fieldsInCities.filter((x) => !f.appliesFieldIds.includes(x.id));
  const strayScopeFields = f.appliesFieldIds.filter((id) => !fieldsInCities.some((x) => x.id === id));
  const fieldTitle = (id: number) => data.fields.find((x) => x.id === id)?.title ?? `Field ${id}`;
  const cityName = (id: number | null) => data.cities.find((x) => x.id === id)?.name ?? "";
  const players = f.audienceMode === "PLAYERS";
  // A Specific players list of 200 or more has a holdout (offersModel holdoutFor); a shorter one doesn't.
  const holdoutOn = playersHoldoutOn(f);

  // ── specific players: look the ids up as they are typed (debounced) ──
  const parsed = useMemo(() => parsePlayerIds(f.playerIdsText), [f.playerIdsText]);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  // While a long list is looked up in batches: ids checked so far (null when no lookup is running).
  const [lookupDone, setLookupDone] = useState<number | null>(null);
  // The ids (joined) the last answer or error was for. Save and Launch wait until it is the list on screen.
  const [lookupFor, setLookupFor] = useState<string | null>(null);
  const idsKey = parsed.ids.join(",");
  // With the shared audience: ids, emails and phone numbers, one lookup (POST /admin/audiences/players/lookup).
  const entries = useMemo(() => (v2 ? entriesOf(f.playerIdsText) : []), [v2, f.playerIdsText]);
  const entriesKey = entries.join("\n");
  const [entryNotFound, setEntryNotFound] = useState<string[]>([]);
  // Which pasted entry found each player, so a tag's × takes that entry (an email, say) out of the box.
  const [lookupEntry, setLookupEntry] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!v2) return;
    if (!players || entries.length === 0) { setLookup(null); setLookupErr(null); setLookupFor(null); setEntryNotFound([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLookupDone(0);
      const r = await authed("/api/audiences/lookup", { method: "POST", body: JSON.stringify({ text: entriesKey }) });
      if (cancelled) return;
      setLookupDone(null); setLookupFor(entriesKey);
      if (!r.ok) { setLookupErr(String(r.json.error)); setLookup(null); setEntryNotFound([]); return; }
      const a = r.json as unknown as TokenLookup;
      setLookupErr(null); setEntryNotFound(a.notFound);
      setLookupEntry(Object.fromEntries(a.players.map((p) => [String(p.id), p.entry ?? String(p.id)])));
      setLookup({ players: a.players.map((p) => ({ id: p.id, name: p.name, city: p.city ?? null, matchesPlayed: 0 })), notFound: [] });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2, players, entriesKey]);
  useEffect(() => {
    if (v2) return;
    if (!players || parsed.ids.length === 0) { setLookup(null); setLookupErr(null); setLookupDone(null); setLookupFor(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLookup(null); setLookupErr(null); setLookupDone(0);
      const r = await lookupInBatches(parsed.ids, async (batch) => {
        const a = await authed("/api/offers/players", { method: "POST", body: JSON.stringify({ ids: batch }) });
        return a.ok ? { ok: true, lookup: a.json as unknown as Lookup } : { ok: false, error: String(a.json.error) };
      }, (done) => { if (!cancelled) setLookupDone(done); }, () => cancelled);
      if (cancelled || r === null) return;
      setLookupDone(null); setLookupFor(idsKey);
      if (!r.ok) { setLookupErr(r.error); setLookup(null); return; }
      setLookupErr(null); setLookup(r.lookup);
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2, players, idsKey]);
  // The ids sent are the ones typed, less any the lookup says are not players (the backend refuses those).
  useEffect(() => {
    const missing = new Set(lookup?.notFound ?? []);
    // With the shared audience the ids are the players the lookup found, whatever was pasted to find them.
    const keep = v2 ? [...new Set((lookup?.players ?? []).map((p) => p.id))] : parsed.ids.filter((id) => !missing.has(id));
    setF((x) => (x.playerIds.join(",") === keep.join(",") ? x : { ...x, playerIds: keep }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2, idsKey, lookup]);

  // ── popup text ──
  const suggested = autoCopy(f, data.matches, data.cities, data.fields);
  const setCopy = (k: CopyKey, v: string) => {
    setF((x) => ({ ...x, copy: copyAfterType(x.copy, k, v, suggested[k]) }));
    setWrittenFor((w) => ({ ...w, [k]: suggested[k] }));
  };
  const [writtenFor, setWrittenFor] = useState<WrittenFor>(() => (c ? writtenForOnLoad(start, readWritten(c.id), data.matches, data.cities, data.fields) : {}));
  const stale = staleSections(f, writtenFor, c?.status ?? null, data.matches, data.cities, data.fields);
  // What a section held when Remove was pressed, so + Add puts it back. Cleared by a save (the panel remounts).
  const [typedBefore, setTypedBefore] = useState<Partial<Record<CopyKey, string>>>({});
  const [more, setMore] = useState(false);
  const ends = endsTicket(f.endsLocal, offerWall());
  const [tab, setTab] = useState<PreviewTab>(start.popupEnabled ? "popup" : "push");
  // Push only (popupEnabled off): the preview can only show the push, and the Popup card keeps its text out of sight.
  const popupOff = !f.popupEnabled;
  const setPopupEnabled = (on: boolean) => { set({ popupEnabled: on }); setTab(on ? "popup" : "push"); };
  // ── Button opens (Figma 20612:47 / 92 / 142). Editable after launch like the rest of the text;
  // forced and locked to the deal's match when the offer is for a specific match.
  const btn = buttonOf(f, data.matches);
  const annTicket = announcementTicket(f, data.matches);
  const btnMatch = data.matches.find((x) => x.id === btn.matchId) ?? null;
  // ── Photo (Figma 20825:213 and the picker 20826:49): the row shows the photo the popup has right now and why; Change
  // opens the picker over every field's covers and this offer's uploads; None is the app's own default. Editable after launch.
  // UPLOAD: the file goes straight from this browser to the backend's link, with progress, then is registered and
  // picked. The backend keeps no list of an offer's uploads, so they are remembered per offer in this browser (a
  // convenience); the offer's saved photo always shows as a tile whatever this browser remembers.
  const [uploaded, setUploaded] = useState<UploadedPhoto[]>(() => (c ? readUploads(c.id) : []));
  const [upPct, setUpPct] = useState<number | null>(null);
  const [upErr, setUpErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const tiles = useMemo(() => photoTiles(data.fields, data.cities, uploaded, c?.photoUrl ?? null), [data.fields, data.cities, uploaded, c?.photoUrl]);
  const suggestedTiles = useMemo(() => suggestedPhotoTiles(tiles, f, data.matches), [tiles, f, data.matches]);
  const photoNow = photoTileOf(tiles, copy.photoUrl ?? null);
  const pickPhoto = (url: string | null) => setF((v) => ({ ...v, copy: { ...v.copy, photoUrl: url } }));
  async function uploadPhoto(file: File | undefined) {
    if (!file || upPct !== null) return;
    setUpErr(null);
    const problem = photoFileProblem(file);
    if (problem) { setUpErr(problem); return; }
    setUpPct(0);
    try {
      const contentType = photoContentType(file)!;
      const link = await authed("/api/offers/photos", { method: "POST", body: JSON.stringify({ contentType, sizeBytes: file.size }) });
      if (!link.ok) { setUpErr(String(link.json.error)); return; }
      const headers = settableHeaders(link.json.headers as Record<string, string> | undefined);
      if (!headers) { console.error("[offers] the photo upload link came without its headers"); setUpErr("The upload link came without its headers, so nothing was uploaded. Try again, and tell Ryan if it keeps happening."); return; }
      const put = await putPhoto(String(link.json.uploadURL), headers, file, setUpPct);
      if (!put.ok) { console.error(`[offers] photo PUT failed: HTTP ${put.status} ${put.text}`); setUpErr("The upload didn't finish. Try again."); return; }
      const reg = await authed("/api/offers/photos/register", { method: "POST", body: JSON.stringify({ fileKey: link.json.fileKey }) });
      if (reg.json.verdict !== "LANDED") { setUpErr(String(reg.json.error ?? reg.json.detail ?? "The upload didn't finish. Try again.")); return; }
      const url = String(reg.json.url);
      const next = [...uploaded, { url, name: file.name }];
      setUploaded(next);
      if (c) keepUploads(c.id, next);
      pickPhoto(url);
    } finally { setUpPct(null); }
  }
  // The × hides an upload from this offer's tiles in this browser. The file itself is not deleted.
  function hidePhoto(url: string) {
    const next = hideUpload(uploaded, url);
    setUploaded(next);
    if (c) keepUploads(c.id, next);
    setF((v) => ({ ...v, copy: copyAfterHide(v.copy, url, c?.photoUrl ?? (c ? null : undefined), copyOf({ ...v, copy: {} }, data.matches, data.cities, data.fields).photoUrl) }));
  }
  const photoRow = () => (
    <div data-testid="offers-photo" className="flex flex-col gap-1.5">
      <div className="text-[12px] font-semibold" style={{ color: O.ink }}>Photo</div>
      <div data-testid="offers-photo-row" className="flex flex-wrap items-center gap-3.5 rounded-[10px] border p-2.5"
        style={{ borderColor: dragging ? O.chipOn : O.line, background: dragging ? O.mint : O.surface }}
        onDragOver={(e) => { if (!frozen) { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!frozen) uploadPhoto(e.dataTransfer.files[0]); }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" src={photoNow.url ?? "/offers/offer-popup-photo.jpg"} className="h-[60px] w-[96px] shrink-0 rounded-[6px] object-cover" />
        <div className="flex min-w-[140px] flex-1 flex-col gap-0.5">
          <div data-testid="offers-photo-name" className="truncate text-[13px] font-semibold" style={{ color: O.ink }}>{photoRowName(photoNow)}</div>
          <div data-testid="offers-photo-reason" className="text-[12px]" style={{ color: O.muted }}>{photoReason(photoNow, f, data.matches, data.cities)}</div>
        </div>
        {!frozen && (
          <div className="flex flex-wrap items-center gap-2">
            <Btn testId="offers-photo-change" onClick={() => setPicking(true)}>Change</Btn>
            <Btn testId="offers-photo-upload" disabled={upPct !== null} onClick={() => fileInput.current?.click()}>
              {upPct === null ? "Upload" : upPct >= 1 ? "Finishing…" : `Uploading ${Math.round(upPct * 100)}%`}
            </Btn>
            <button type="button" data-testid="offers-photo-none" disabled={photoNow.kind === "default"} onClick={() => pickPhoto(null)}
              className="px-1 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-50" style={{ color: O.muted }}>None</button>
          </div>
        )}
      </div>
      <input ref={fileInput} id="offers-photo-file" data-testid="offers-photo-file" type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={(e) => { uploadPhoto(e.target.files?.[0]); e.target.value = ""; }} />
      {upPct !== null && !picking && (
        <div className="flex items-center gap-2">
          <span data-testid="offers-upload-pct" className="text-[11.5px] font-medium" style={{ color: O.ink }}>{upPct >= 1 ? "Finishing…" : `Uploading ${Math.round(upPct * 100)}%`}</span>
          <span className="h-1 w-[160px] overflow-hidden rounded-full" style={{ background: O.line }}><span className="block h-full" style={{ width: `${Math.round(upPct * 100)}%`, background: O.chipOn }} /></span>
        </div>
      )}
      {upErr && !picking && <div data-testid="offers-upload-error" className="text-[11.5px] font-medium" style={{ color: O.critInk }}>{upErr}</div>}
      <div className="text-[11.5px] leading-[16px]" style={{ color: O.muted }}>Best at 1200 × 650, landscape. Text on the image may be covered by the tag and line. Drop an image on the row to upload it.</div>
    </div>
  );
  const buttonOpens = () => {
    const off = btn.locked || frozen;
    const chip = (on: boolean) => btn.locked
      ? (on ? { background: O.muted, borderColor: O.muted, color: "#fff" } : { background: "#eef0ee", borderColor: O.line, color: O.label })
      : undefined;
    return (
      <div data-testid="offers-button-opens" data-locked={btn.locked ? "1" : "0"} className="flex flex-col gap-2">
        <div className="text-[12px] font-semibold" style={{ color: O.ink }}>Button opens</div>
        <div className="flex flex-wrap gap-2">
          {(ann ? ([["MATCH", "A match"], ["FIELD", "A field"], ["FIND_MATCH", "Find a match"]] as const) : ([["FIND_MATCH", "Find a match"], ["MATCH", "A specific match"]] as const)).map(([t, label]) => (
            btn.locked
              ? <span key={t} data-testid={`offers-btn-${t}`} data-on={btn.target === t ? "1" : "0"} className="inline-flex items-center rounded-full border px-3.5 py-[7px] text-[13px] font-medium" style={chip(btn.target === t)}>{label}</span>
              : <Chip key={t} testId={`offers-btn-${t}`} on={btn.target === t} disabled={off} onClick={() => set(t === "MATCH" ? { buttonTarget: "MATCH", buttonFieldId: null } : t === "FIELD" ? { buttonTarget: "FIELD", buttonMatchId: null } : { buttonTarget: "FIND_MATCH", buttonMatchId: null, buttonFieldId: null })}>{label}</Chip>
          ))}
        </div>
        {btn.target === "FIELD" && (
          <select data-testid="offers-btn-field" disabled={frozen} value={f.buttonFieldId ?? ""} onChange={(e) => set({ buttonFieldId: e.target.value ? Number(e.target.value) : null })} className={inputCls} style={inputStyle}>
            <option value="">Pick the field</option>
            {[...data.fields].sort((a, b) => a.title.localeCompare(b.title)).map((x) => <option key={x.id} value={x.id}>{x.title}{data.cities.find((c) => c.id === x.cityId) ? ` · ${data.cities.find((c) => c.id === x.cityId)!.name}` : ""}</option>)}
          </select>
        )}
        {btn.target === "MATCH" && (
          <>
            <MatchPicker {...pickerProps} testId="offers-btn-match" selected={btnMatch}
              disabled={frozen} locked={btn.locked} empty={matchUnread ? matchUnreadText(matchRead) : undefined} onPick={(id) => set({ buttonMatchId: id })} />
            {btn.locked
              ? <div data-testid="offers-btn-note" className="rounded-[8px] px-2.5 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Opens the match this offer is for.</div>
              : btnMatch && !ann && <div data-testid="offers-btn-note" className="rounded-[8px] px-2.5 py-2 text-[12px]" style={{ background: O.mint, color: O.ok }}>{buttonMatchNote(btnMatch)}</div>}
          </>
        )}
      </div>
    );
  };
  // One popup text field, or its + Add link while the section is removed.
  const copyField = (k: CopyKey, label: string, max: number) => {
    const auto = suggested[k];
    if (isRemovable(k) && sectionCollapsed(f.copy, k, auto)) {
      return frozen
        ? <div key={k} className="self-start text-[12px]" style={{ color: O.muted }}>{label}: none</div>
        : <button key={k} type="button" data-testid={`offers-add-${k}`} className="self-start py-1 text-[12px] font-semibold" style={{ color: O.ok }}
            onClick={() => setF((x) => ({ ...x, copy: addSection(x.copy, k, typedBefore[k], auto) }))}>{SECTION_ADD[k]}</button>;
    }
    const value = f.copy[k] ?? auto ?? "";
    return (
      <div key={k} className={`flex min-w-0 flex-col gap-1.5 ${k === "body" ? "sm:col-span-2" : ""}`}>
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`offers-copy-${k}`} className="text-[12px] font-semibold" style={{ color: O.ink }}>{label}</label>
          {isRemovable(k) && !frozen && (
            <button type="button" data-testid={`offers-remove-${k}`} className="text-[11.5px] font-medium" style={{ color: O.muted }}
              onClick={() => {
                const typed = f.copy[k];
                setTypedBefore((x) => { const n = { ...x }; if (typeof typed === "string") n[k] = typed; else delete n[k]; return n; });
                setF((x) => ({ ...x, copy: removeSection(x.copy, k) }));
              }}>Remove</button>
          )}
        </div>
        {k === "body"
          ? <textarea id={`offers-copy-${k}`} data-testid={`offers-copy-${k}`} rows={2} maxLength={max} disabled={frozen} className={inputCls} style={inputStyle} value={value} onChange={(e) => setCopy(k, e.target.value)} />
          : <input id={`offers-copy-${k}`} data-testid={`offers-copy-${k}`} maxLength={max} disabled={frozen} className={inputCls} style={inputStyle} value={value} onChange={(e) => setCopy(k, e.target.value)} />}
        {(stale.includes(k) || (!frozen && canReset(f.copy, k, auto) && !(ann && !auto))) && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {stale.includes(k) && <span data-testid={`offers-stale-${k}`} className="text-[11.5px] font-medium" style={{ color: O.warnInk }}>Written for the old deal</span>}
            {!frozen && canReset(f.copy, k, auto) && (
              <button type="button" data-testid={`offers-reset-${k}`} className="text-[11.5px] font-medium" style={{ color: O.ok }}
                onClick={() => setF((x) => ({ ...x, copy: resetCopy(x.copy, k) }))}>Reset to suggested</button>
            )}
          </div>
        )}
      </div>
    );
  };
  const dl = locked || frozen; // deal, audience and run locked
  const passed = endHasPassed(f.endsLocal, offerWall());
  const idsWhy = !v2 ? playerLookupBlock({ players, typed: parsed.ids, answeredFor: lookupFor, lookup, failed: lookupErr !== null, sending: f.playerIds })
    : !players || entries.length === 0 ? null : lookupFor === entriesKey && lookupErr ? "Couldn't look the players up. Change the list to try again."
    : lookupFor !== entriesKey || !lookup || f.playerIds.join(",") !== [...new Set(lookup.players.map((p) => p.id))].join(",") ? "Still looking the players up." : null;
  const nothingOn = popupOffBlock(f, pushOn && pf.enabled);
  const launchWhy = matchUnread ? matchUnreadText(matchRead) : problem ?? audWhy ?? pushProb ?? idsWhy ?? nothingOn ?? launchProblem(f, offerWall()) ?? COUNT_BLOCK[countNow];

  // ── THE CAP FLAG (Figma 20842:72), only while the offer's push is on: popups aren't limited, pushes are. Offers' own
  // count has no atCap, so the shared count (POST /admin/audiences/count, backend e9e90a7) is asked about the same
  // audience, debounced, one at a time behind the page's other reads. Any failure just leaves the flag off.
  const capWanted = pushOn && pf.enabled && !matchUnread && wantCount && !audWhy && !idsWhy && !contractIncomplete(f.audienceFilters) && (f.audienceMode !== "PLAYERS" || f.playerIds.length > 0);
  const capBody = JSON.stringify({ audience: audienceOf(aud, f.playerIds), holdoutPercent: holdoutFor(f) });
  const [capAnswer, setCapAnswer] = useState<{ for: string; atCap: number | null; weeklyCap: number | null } | null>(null);
  useEffect(() => {
    if (!capWanted) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/audiences/count", { method: "POST", body: capBody });
      if (cancelled) return;
      const j = r.json as { atCap?: unknown; weeklyCap?: unknown };
      if (!r.ok) console.error(`[offers] cap count: ${String(r.json.error)}`);
      setCapAnswer({ for: capBody, atCap: r.ok && typeof j.atCap === "number" ? j.atCap : null, weeklyCap: typeof j.weeklyCap === "number" ? j.weeklyCap : null });
    }, COUNT_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [capWanted, capBody]);
  const capFlag = capWanted && capAnswer?.for === capBody && capAnswer.atCap ? capFlagLine(capAnswer.atCap, capAnswer.weeklyCap ?? WEEKLY_CAP_DEFAULT) : null;
  const dealWarn = setPriceProblem(f, m);
  const anyWarn = setPriceAnyWarning(f, data.matches);
  const pushShown = pushOn && pf.enabled ? (() => { const t = pushText(pf, pushSugg); return { title: fillPush(t.title, m), body: fillPush(t.body, m) }; })() : null;
  const opens = matchUnread ? "↳ Opens a match" : opensText(f, data.matches, data.fields);

  const title = c ? c.name || "Untitled offer" : f.name.trim() || "New offer";
  const canLaunch = c === null || c.status === "DRAFT";
  const launchBtn = (testId: string) => (
    <Btn kind="primary" testId={testId} disabled={busy || !!launchWhy} title={launchWhy ?? undefined} onClick={() => setConfirm("launch")}>Launch</Btn>
  );
  const resumeBtn = (testId: string) => (
    <Btn kind="primary" testId={testId} disabled={busy || dirty || passed} title={passed ? "The end time has already passed." : dirty ? "Save or undo your changes first" : undefined} onClick={() => setConfirm("launch")}>Resume</Btn>
  );
  const saveBtn = (c === null || dirty) && (
    <Btn testId="offers-save" disabled={busy || !!problem || !!audWhy || !!pushProb || !!idsWhy || (c !== null && settled(outcome) && !dirty)} title={audWhy ?? idsWhy ?? undefined} onClick={onSave}>{c === null ? "Save draft" : "Save changes"}</Btn>
  );
  const testBtn = (
    <Btn testId="offers-test" disabled={busy || c === null || (c.status === "DRAFT" && dirty)} title={c === null ? "Save it as a draft first" : c.status === "DRAFT" && dirty ? "Save your changes first, so the phone shows what you see" : undefined}
      onClick={() => { if (!testOpen) setTestText(readTestIds()); setTestOpen((v) => !v); }}>Send test</Btn>
  );
  const summaryText = matchUnread ? matchUnreadText(matchRead) : `${pushOnlyPrefix(f)}${wantCount ? summary(f, count, data.matches, data.cities, offerWall(), data.fields) : lockedSummary(f, data.matches, data.cities, offerWall(), data.fields, c ? ranUntil(c) : null)}`;

  return (
    <div data-testid="offers-panel" data-status={c?.status ?? "NEW"} className="flex flex-col gap-5">
      {/* HEADER (Figma 20825:76) */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button type="button" data-testid="offers-back" onClick={onClose} className="self-start whitespace-nowrap text-[13px] font-semibold hover:underline" style={{ color: O.muted }}>← Back to offers</button>
          <h1 className="m-0 truncate text-[26px] font-bold leading-[32px]" style={{ color: O.ink }}>{title}</h1>
        </div>
        {!ended && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {saveBtn}
            {testBtn}
            {canLaunch && launchBtn("offers-launch")}
            {c?.status === "PAUSED" && resumeBtn("offers-resume")}
          </div>
        )}
      </div>
      {locked && !ended && (
        <div data-testid="offers-locked-note" className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>
          Launched, so the deal, who gets it and when it runs are locked. The name, the popup text and the total limit can still change.
        </div>
      )}
      {ended && <div className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Ended. Nothing about it can change.</div>}
      {matchUnread && (
        <div data-testid="offers-match-unread" data-read={matchRead} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] px-3 py-2 text-[12px] font-medium" style={matchRead === "failed" ? { background: O.critBg, color: O.critInk } : { background: O.subtle, color: O.muted }}>
          <span>{matchUnreadText(matchRead)}</span>
          {matchRead === "failed" && <button type="button" data-testid="offers-match-retry" className="font-semibold underline" onClick={onRetryMatch}>Retry</button>}
        </div>
      )}
      {outcome && <VerdictLine outcome={outcome} />}
      {problem && !ended && dirty && <div data-testid="offers-problem" className="text-[12px] font-medium" style={{ color: O.warnInk }}>{problem}</div>}
      {!ended && c === null && <div data-testid="offers-phone-note" className="text-[11.5px]" style={{ color: O.muted }}>Save it as a draft to send a test.</div>}
      {testOpen && c !== null && !ended && (
        <div data-testid="offers-test-pop" className="flex w-full max-w-[520px] flex-col gap-2 self-end rounded-[12px] border p-3.5 shadow-[0_6px_20px_rgba(0,51,38,0.10)]" style={{ borderColor: O.line, background: O.surface }}>
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold" style={{ color: O.ink }}>Player IDs</span>
            <span className="text-[11px]" style={{ color: O.label }}>up to {MAX_TEST_IDS} · commas, spaces or one per line</span>
          </div>
          <textarea data-testid="offers-test-ids" rows={2} className={inputCls} style={inputStyle} value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="10482, 10511" />
          {testParsed.ids.length > MAX_TEST_IDS && <div className="text-[12px] font-medium" style={{ color: O.warnInk }}>A test goes to {MAX_TEST_IDS} players at most ({testParsed.ids.length} here).</div>}
          {testLookup && (
            <div data-testid="offers-test-found" className="flex flex-col gap-1 rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle }}>
              {testLookup.players.map((p) => <PlayerRow key={p.id} p={p} />)}
              {testLookup.notFound.length > 0 && <div style={{ color: O.warnInk }}>{notFoundLine(testLookup.notFound)}</div>}
              {testLookup.players.length === 0 && <div style={{ color: O.muted }}>No players found.</div>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Btn kind="primary" testId="offers-test-send" disabled={busy || testIds.length === 0 || testParsed.ids.length > MAX_TEST_IDS || !testLookup}
              onClick={() => sendTest(false)}>{testIds.length ? `Send to ${testIds.length}` : "Send"}</Btn>
            <Btn testId="offers-test-me" disabled={busy} onClick={() => sendTest(true)}>Use my email</Btn>
          </div>
          <div className="text-[11.5px] leading-[16px]" style={{ color: O.muted }}>Test popups don&apos;t apply at checkout. Only send them to people who know it&apos;s a test.</div>
        </div>
      )}

      {/* COLUMNS (Figma 20825:86): the preview pinned on the left above 1100px, on top below it. */}
      <div className="grid items-start gap-7 min-[1100px]:grid-cols-[430px_minmax(0,1fr)]">
        <div className="min-w-0 min-[1100px]:sticky min-[1100px]:top-[calc(var(--nav-h)+16px)]">
          <OfferPreview tab={popupOff ? "push" : tab} setTab={setTab} copy={copy} ends={ends} showTicket={f.showTicket} opens={opens} push={pushShown} dateLine={lockScreenDate(nowWall)} popupOff={popupOff}
            announcement={ann ? { accent: f.headlineAccent, ticket: annTicket } : undefined} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {results}

          {/* THE DEAL */}
          <Card title="The deal" testId="offers-deal">
            <Labeled label="Name">
              <input data-testid="offers-name" className={inputCls} style={inputStyle} value={f.name} disabled={frozen} placeholder="Austin win-back"
                onChange={(e) => set({ name: e.target.value })} />
            </Labeled>
            <div className="flex flex-wrap gap-2">
              {DEALS.map((d) => <Chip key={d.type} testId={`offers-deal-${d.type}`} on={f.dealType === d.type} disabled={dl} onClick={() => pickDeal(d.type)}>{d.label}</Chip>)}
            </div>
            {ann && <div data-testid="offers-no-discount-note" className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>A popup with no discount, for news like a new field or new match times. It changes no price; write it below and pick where its button goes.</div>}
            {!ann && <div className="grid gap-3 sm:grid-cols-3">
              {STEPPER[f.dealType] && (
                <Labeled label="Amount">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <div className="flex items-center gap-[18px] rounded-[8px] border px-2.5 py-[7px] text-[14px]" style={{ borderColor: O.line, opacity: dl ? 0.6 : 1 }}>
                      <button type="button" data-testid="offers-minus" disabled={dl} onClick={() => step(-1)} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>–</button>
                      <span data-testid="offers-amount" className="min-w-[34px] text-center font-bold" style={{ color: O.ink }}>{amountText(f.dealType, f.dealAmount)}</span>
                      <button type="button" data-testid="offers-plus" disabled={dl} onClick={() => step(1)} className="font-medium disabled:cursor-not-allowed" style={{ color: O.muted }}>+</button>
                    </div>
                    <span className="text-[13px]" style={{ color: O.ink }}>{f.dealType === "SET_PRICE" ? "for their spot" : "off"}</span>
                  </div>
                </Labeled>
              )}
              {/* USES (Figma 20620:46): how many matches each player can use it on. A specific match is one. */}
              {!m && !matchUnread && (
                <div data-testid="offers-uses" className="flex flex-col gap-1.5">
                  <div className="text-[12px] font-semibold" style={{ color: O.ink }}>Uses per player</div>
                  <div className="flex items-center gap-2.5">
                    <Stepper testId="offers-uses-n" value={String(f.usesPerPlayer)} disabled={dl}
                      minus={() => set({ usesPerPlayer: stepUses(f.usesPerPlayer, -1) })} plus={() => set({ usesPerPlayer: stepUses(f.usesPerPlayer, 1) })}
                      atMin={f.usesPerPlayer <= 1} atMax={f.usesPerPlayer >= MAX_USES_PER_PLAYER} />
                    <span className="text-[13px]" style={{ color: O.ink }}>{f.usesPerPlayer === 1 ? "match" : "matches"}</span>
                  </div>
                  <div data-testid="offers-uses-line" className="text-[12px]" style={{ color: O.muted }}>{usesLine(f.usesPerPlayer)}</div>
                </div>
              )}
              {/* TOTAL CAP (maxRedemptions). Editable after launch. */}
              <div data-testid="offers-limit" className="flex flex-col gap-1.5">
                <div className="text-[12px] font-semibold" style={{ color: O.ink }}>Total cap (optional)</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip testId="offers-limit-none" on={f.maxRedemptions === null} disabled={frozen} onClick={() => set({ maxRedemptions: null })}>No cap</Chip>
                  {f.maxRedemptions === null
                    ? <Chip testId="offers-limit-set" on={false} disabled={frozen} onClick={() => set({ maxRedemptions: 50 })}>Set a cap</Chip>
                    : (
                      <div className="flex items-center gap-2.5">
                        <Stepper testId="offers-limit-n" value={f.maxRedemptions} disabled={frozen} atMin={f.maxRedemptions <= 1}
                          minus={() => set({ maxRedemptions: stepLimit(f.maxRedemptions, -1) })} plus={() => set({ maxRedemptions: stepLimit(f.maxRedemptions, 1) })}
                          onType={(n) => set({ maxRedemptions: n })} />
                        <span className="text-[13px]" style={{ color: O.ink }}>uses</span>
                      </div>
                    )}
                </div>
                {f.maxRedemptions !== null && <div data-testid="offers-limit-line" className="text-[12px]" style={{ color: O.muted }}>{limitLine(f.maxRedemptions)}</div>}
              </div>
            </div>}
            {!dl && dealWarn && <div data-testid="offers-setprice-block" className="text-[12px] font-medium" style={{ color: O.critInk }}>{dealWarn}</div>}
            {!dl && !dealWarn && m && f.dealType === "SET_PRICE" && f.dealAmount === m.price && (
              <div className="text-[12px]" style={{ color: O.warnInk }}>That is the same as its normal {amountText("SET_PRICE", m.price)}, so nobody saves anything.</div>
            )}
            {!dl && !dealWarn && anyWarn && <div data-testid="offers-setprice-warn" className="text-[12px]" style={{ color: O.warnInk }}>{anyWarn}</div>}
          </Card>

          {/* An announcement applies nowhere: no Applies to card. */}
          {!ann && (<>
          {/* APPLIES TO */}
          <Card title="Applies to" testId="offers-applies">
            <div className="flex flex-wrap gap-2">
              <Chip testId="offers-scope-ANY" on={f.scope === "ANY"} disabled={dl} onClick={() => pickScope("ANY")}>Any match</Chip>
              <Chip testId="offers-scope-FIELD" on={f.scope === "FIELD"} disabled={dl} onClick={() => pickScope("FIELD")}>A field</Chip>
              <Chip testId="offers-scope-MATCH" on={f.scope === "MATCH"} disabled={dl} onClick={() => pickScope("MATCH")}>One match</Chip>
            </div>
            {f.scope === "FIELD" && (
              <div data-testid="offers-scope-fields" className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold" style={{ color: O.ink }}>Fields</span>
                  <span className="text-[11px]" style={{ color: O.label }}>the offer only works at these</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {f.appliesFieldIds.map((id) => <Chip key={id} on testId={`offers-sf-${id}`} disabled={dl} title={dl ? undefined : "Remove"} onClick={() => removeScopeField(id)}>{`${fieldTitle(id)}  ×`}</Chip>)}
                  {!dl && otherScopeFields.length > 0 && <Chip testId="offers-add-scope-field" on={false} onClick={() => setAddingScopeField((v) => !v)}>+ Field</Chip>}
                </div>
                {addingScopeField && !dl && (
                  <div className="grid grid-cols-2 gap-2 rounded-[8px] p-2 sm:grid-cols-3" style={{ background: O.subtle }}>
                    {otherScopeFields.map((x) => (
                      <button key={x.id} type="button" data-testid={`offers-scope-field-${x.id}`} onClick={() => { addScopeField(x.id); setAddingScopeField(false); }}
                        className="flex flex-col overflow-hidden rounded-[8px] border text-left" style={{ borderColor: O.line, background: O.surface }}>
                        {x.cover
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img alt="" src={x.cover} className="h-[56px] w-full object-cover" />
                          : <span className="h-[56px] w-full" style={{ background: O.subtle }} />}
                        <span className="truncate px-2 pt-1 text-[12px] font-medium" style={{ color: O.ink }}>{x.title}</span>
                        <span className="truncate px-2 pb-1.5 text-[11px]" style={{ color: O.muted }}>{cityName(x.cityId)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!dl && strayScopeFields.length > 0 && <div data-testid="offers-scope-stray" className="text-[12px]" style={{ color: O.warnInk }}>{strayScopeFields.map(fieldTitle).join(", ")} {strayScopeFields.length === 1 ? "isn't" : "aren't"} in this offer&apos;s cities, so nobody could use it there.</div>}
              </div>
            )}
            {f.scope === "MATCH" && (
              <>
                <Labeled label="Match">
                  <MatchPicker {...pickerProps} testId="offers-match" selected={m}
                    disabled={dl} empty={matchUnread ? matchUnreadText(matchRead) : undefined} onPick={pickMatch} />
                </Labeled>
                {m && <div data-testid="offers-match-info" className="rounded-[8px] px-3 py-[9px] text-[12px]" style={{ background: O.subtle, color: O.muted }}>{matchInfo(m)}</div>}
              </>
            )}
          </Card>
          </>)}

          {/* WHO GETS IT: the shared builder (src/components/audience/WhoGetsIt.tsx, Figma 20828:192 / 20835:230). Every filter on
              a backend with the shared audience; the five old ones (OFFERS_FILTERS) on one without. The lookup, the count and
              the save gate stay here. */}
          <WhoGetsIt spec={aud} onChange={setAud} allowed={allowed} hints={v2 ? undefined : OFFERS_HINTS} choices={v2 ? undefined : { membership: OFFERS_MEMBERSHIP }} cities={data.cities} fields={data.fields} nowWall={nowWall} disabled={dl || audLoad.unknown > 0} testId="offers-who"
            playersSub={holdoutOn ? `Only these players get it. Filters don't apply. With ${PLAYERS_HOLDOUT_MIN} or more, some are held back to measure (More options, under Runs).` : "Only these players get it. Filters don't apply and nobody is held back."}
            count={players || matchUnread || !wantCount ? { state: "off" } : countNow === "error" ? { state: "error", error: countErr ?? undefined, onRetry: retryCount }
              : count ? { state: "ready", capFlag, text: countLine({ matching: count.count, holdoutPercent: f.holdoutPercent }), extra: ann ? (typeof count.onAnnouncementsApp === "number" ? <div data-testid="offers-count-on-announcements" className="self-start text-[12px]" style={{ color: O.muted }}>{count.onAnnouncementsApp.toLocaleString("en-US")} of these have the latest app and can see it.</div> : null)
                : on188Line(count) ? <div data-testid="offers-count-on188" className="self-start text-[12px]" style={{ color: O.muted }}>{on188Line(count)}</div> : null } : { state: "counting" }}
            onSample={async () => {
              const r = await authed("/api/audiences/sample", { method: "POST", body: JSON.stringify({ audience: audienceOf(aud, f.playerIds) }) });
              return r.ok ? (r.json as unknown as SampleAnswer) : { error: String(r.json.error) };
            }}
            players={{
              hint: v2 ? "Paste player IDs, emails or phone numbers, separated by commas or new lines." : "Paste player IDs, separated by commas, spaces or new lines.", placeholder: v2 ? "10482, 10511\nluis@example.com" : "10482, 10511, 9877",
              tags: (lookup?.players ?? []).map((p) => ({ key: String(p.id), label: tagText({ id: p.id, name: p.name }) })),
              notFound: v2 ? entryNotFound : [...(lookup?.notFound ?? []).map(String), ...parsed.bad],
              line: lookup ? (v2 ? pastedLine(entries.length, { players: lookup.players, notFound: entryNotFound.map(() => 0) }) : pastedLine(parsed.ids.length, lookup)) : v2 && lookupDone !== null ? "Looking them up…" : lookupDone !== null && parsed.ids.length > 0 ? `Looking up ${lookupDone.toLocaleString("en-US")} of ${parsed.ids.length.toLocaleString("en-US")} IDs…` : null,
              onRemove: (k) => {
                if (v2) { const entry = lookup?.players.find((p) => String(p.id) === k) ? (lookupEntry[k] ?? k) : k; setAud({ ...aud, playersText: removeToken(f.playerIdsText, entry) }); return; }
                const ids = parsePlayerIds(f.playerIdsText).ids.filter((id) => String(id) !== k); setAud({ ...aud, playersText: ids.join(", ") });
              },
              extra: (
                <>
                  {parsed.tooMany && <div data-testid="offers-ids-too-many" className="self-start rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium" style={{ background: O.warnBg, color: O.warnInk }}>One offer takes up to {MAX_OFFER_PLAYER_IDS.toLocaleString("en-US")} IDs. Only the first {MAX_OFFER_PLAYER_IDS.toLocaleString("en-US")} are used.</div>}
                  {lookupErr && <div className="self-start rounded-[8px] px-2.5 py-1.5 text-[12px]" style={{ background: O.critBg, color: O.critInk }}>Couldn&apos;t look them up: {lookupErr}</div>}
                  {capFlag && <div data-testid="offers-who-cap-flag" className="rounded-[10px] px-3.5 py-[9px] text-[13px] font-semibold" style={{ background: "#fff2d9", color: "#8c590d" }}>{capFlag}</div>}
                  {holdoutOn && f.holdoutPercent > 0 && wantCount && countNow !== "error" && count && <div data-testid="offers-players-held-back" className="self-start text-[12px] font-medium" style={{ color: O.ink }}>{heldBackLine(count.heldBack)}</div>}
                </>
              ),
            }} />
          {!players && !dl && playedAtSuggestions(f, data.fields, data.matches).map((x) => (
            <button key={x.id} type="button" data-testid={`offers-pf-suggest-${x.id}`} onClick={() => addPlayedAt(x.id)}
              className="-mt-2 self-start px-1 text-left text-[12px] font-semibold" style={{ color: O.ok }}>Only players who&apos;ve played at {x.title}?</button>
          ))}

          {/* POPUP (Figma 20825:181). Every line is written from the deal and editable here; the preview on the left redraws as you type. */}
          <Card title="Popup" sub={popupOff ? null : ann ? "Write what the popup says. The preview shows it as players will." : "Written for you from the deal. Change any line if you want."} testId="offers-popup">
            {/* SHOW POPUP ON APP OPEN (Figma 20825:184; backend popupEnabled, 08145ea). Off is push only: the text below is
                kept but hidden, the preview shows the push, and the discount still applies at checkout. */}
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="text-[13px] font-semibold" style={{ color: O.ink }}>Show popup on app open</div>
                <div className="text-[12px]" style={{ color: O.muted }}>{ann ? "Off = push only." : "Off = push only. The discount still auto-applies at checkout."}</div>
              </div>
              <Toggle testId="offers-popup-on" on={f.popupEnabled} disabled={frozen} label="Show popup on app open" onChange={setPopupEnabled} />
            </div>
            {popupOff && (
              <div data-testid="offers-popup-off-note" className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>
                {ann ? <>Push only. Nobody sees a popup; the push&apos;s tap lands where the button goes ({opens.replace(/^↳ Opens /, "")}).</>
                  : <>Push only. Nobody sees a popup; the push&apos;s tap lands on {f.scope === "MATCH" ? "the match" : f.scope === "FIELD" && f.appliesFieldIds.length === 1 ? "the field" : "Find a match"} and the offer is already applied there.</>}
                {!(pushOn && pf.enabled) && <span className="ml-1 font-medium" style={{ color: O.warnInk }}>There is no push either, so it can&apos;t launch like this.</span>}
              </div>
            )}
            {!popupOff && <div className="grid gap-3.5 sm:grid-cols-2">
              {(ann ? ANNOUNCEMENT_FIELDS : COPY_FIELDS).flatMap(([k, label, max]) => (ann && k === "headline" ? [copyField(k, label, max), (
                <div key="headlineAccent" className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor="offers-headline-accent" className="text-[12px] font-semibold" style={{ color: O.ink }}>Headline accent <span className="font-normal" style={{ color: O.label }}>in green</span></label>
                  <input id="offers-headline-accent" data-testid="offers-headline-accent" maxLength={64} disabled={frozen} className={inputCls} style={inputStyle} placeholder="OPEN"
                    value={f.headlineAccent ?? ""} onChange={(e) => set({ headlineAccent: e.target.value || null })} />
                </div>
              ), ...headlineHint] : k === "headline" ? [copyField(k, label, max), ...headlineHint] : [copyField(k, label, max)]))}
            </div>}
            {popupOff ? null : ann ? (
              <div data-testid="offers-ticket" data-kind="announcement" className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold" style={{ color: O.ink }}>Ticket</span>
                  {!frozen && f.buttonTarget === "MATCH" && <button type="button" data-testid={f.showTicket ? "offers-remove-ticket" : "offers-add-ticket"} className="text-[11.5px] font-medium" style={{ color: f.showTicket ? O.muted : O.ok }} onClick={() => set({ showTicket: !f.showTicket })}>{f.showTicket ? "Remove" : "+ Add ticket"}</button>}
                </div>
                <div className="text-[12px]" style={{ color: O.muted }}>
                  {f.buttonTarget !== "MATCH" ? "A ticket shows the match's date and time when the button opens a match." : !f.showTicket ? "No ticket." : annTicket ?? "Pick the match below; its date and time go on the ticket."}
                </div>
              </div>
            ) : f.showTicket ? (
              <div data-testid="offers-ticket" className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold" style={{ color: O.ink }}>Ticket</span>
                  {!frozen && <button type="button" data-testid="offers-remove-ticket" className="text-[11.5px] font-medium" style={{ color: O.muted }} onClick={() => set({ showTicket: false })}>Remove</button>}
                </div>
                <div className="text-[12px]" style={{ color: O.muted }}>{ends ?? "No end date"} · Auto-applied</div>
              </div>
            ) : !frozen && (
              <button type="button" data-testid="offers-add-ticket" className="self-start text-[12px] font-semibold" style={{ color: O.ok }} onClick={() => set({ showTicket: true })}>+ Add ticket</button>
            )}
            {!popupOff && buttonOpens()}
            {!popupOff && photoRow()}
            {!popupOff && <div data-testid="offers-firstname-hint" className="text-[11.5px]" style={{ color: O.muted }}>
              <code className="rounded px-1" style={{ background: O.subtle, color: O.ink }}>{FIRST_NAME_TOKEN}</code> becomes the player&apos;s first name (shown here as {PREVIEW_FIRST_NAME}). With no first name on file it is left out.
              {stale.length > 0 && <span data-testid="offers-stale-note" className="ml-1 font-medium" style={{ color: O.warnInk }}>Written for the old deal: {stale.length} {stale.length === 1 ? "section" : "sections"}.</span>}
            </div>}
          </Card>

          {/* PUSH NOTIFICATION (Figma 20825:223). Only where the server lets this account see pushes (OFFERS_PUSH_ACCOUNTS on production). */}
          {pushOn && (
            <Card title="Push notification" testId="offers-push-section">
              <PushSection pf={pf} setPf={setPf} sugg={pushSugg} scope={f.scope} match={m} campaignId={c?.id ?? null} campaignStatus={c?.status ?? null}
                stored={c?.push} startsLocal={f.startsLocal} endsLocal={f.endsLocal} disabled={matchUnread} problem={pushProb} />
              {pf.enabled && !matchUnread && <PushReach campaignId={c?.id ?? null} refreshKey={String(c?.id ?? "")} />}
            </Card>
          )}

          {/* RUNS (Figma 20825:241) */}
          <Card title="Runs" testId="offers-runs">
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Labeled label="Starts">
                <WallInput testId="offers-starts" label={startLabel(f.startsLocal, nowWall)} value={f.startsLocal} disabled={dl} onChange={(v) => set({ startsLocal: v })} />
              </Labeled>
              <Labeled label="Ends">
                {f.endsLocal !== null
                  ? <WallInput testId="offers-ends" label={m && f.endsLocal === m.startLocal ? `Kickoff · ${wallLabel(f.endsLocal)}` : wallLabel(f.endsLocal)} value={f.endsLocal} disabled={dl} onChange={(v) => set({ endsLocal: v })} />
                  : <div data-testid="offers-ends-none" className="rounded-[8px] border px-3 py-[9px] text-[13px]" style={{ borderColor: O.line, color: O.muted, background: O.subtle }}>Runs until someone ends it</div>}
              </Labeled>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {f.scope !== "MATCH" && !matchUnread && <Chip testId="offers-no-end" on={f.endsLocal === null} disabled={dl} onClick={() => set({ endsLocal: f.endsLocal === null ? defaultRun(nowWall).endsLocal : null })}>No end date</Chip>}
              <div className="text-[12px]" style={{ color: O.muted }}>Times are each player&apos;s own city time.</div>
            </div>
            {passed && !dl && <div data-testid="offers-end-passed" className="text-[12px] font-medium" style={{ color: O.critInk }}>That end time has already passed, so it can&apos;t launch.</div>}
            {(!players || holdoutOn) && <button type="button" data-testid="offers-more" onClick={() => setMore((v) => !v)} className="flex w-full items-center justify-between gap-2 rounded-[8px] px-3 py-[9px] text-left text-[12px]" style={{ background: O.subtle }}>
              <span className="font-medium" style={{ color: O.ink }}>More options</span>
              <span style={{ color: O.muted }}>{f.holdoutPercent > 0 ? `${f.holdoutPercent}% held back to measure` : "Nobody held back"} {more ? "‹" : "›"}</span>
            </button>}
            {more && (!players || holdoutOn) && (
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
          </Card>

          {/* SUMMARY BAR (Figma 20825:254): what it does, the most it can cost, and the one-way actions. */}
          <div data-testid="offers-summary-bar" className="flex flex-wrap items-center gap-4 rounded-[14px] px-5 py-4" style={{ background: O.mint }}>
            <p data-testid="offers-summary" className="m-0 min-w-[200px] flex-1 text-[13px] font-semibold leading-[19px]" style={{ color: O.chipOn }}>{summaryText}</p>
            {!ended && (
              <div className="flex flex-wrap items-center gap-2">
                {c?.status === "DRAFT" && <Btn kind="danger" testId="offers-delete" disabled={busy} onClick={() => setConfirm("delete")}>Delete</Btn>}
                {c?.status === "LAUNCHED" && <Btn testId="offers-pause" disabled={busy} onClick={() => setConfirm("pause")}>Pause</Btn>}
                {(c?.status === "LAUNCHED" || c?.status === "PAUSED") && <Btn kind="danger" testId="offers-end" disabled={busy} onClick={() => setConfirm("end")}>End</Btn>}
                {canLaunch && launchBtn("offers-launch-bar")}
                {c?.status === "PAUSED" && resumeBtn("offers-resume-bar")}
              </div>
            )}
          </div>
        </div>
      </div>

      {picking && (
        <PhotoPicker tiles={tiles} suggested={suggestedTiles} suggestedLabel={suggestedPhotoLabel(f, data.matches, data.cities, data.fields)} cities={data.cities}
          selected={copy.photoUrl ?? null} stored={c?.photoUrl ?? null} frozen={frozen}
          upload={{ pct: upPct, err: upErr, allowed: !ended, onFile: uploadPhoto }}
          onHide={hidePhoto} onCancel={() => setPicking(false)} onUse={(url) => { pickPhoto(url); setPicking(false); }} />
      )}
      {confirm === "launch" && (
        <ConfirmDialog title={c?.status === "PAUSED" ? `Resume ${f.name.trim()}?` : `Launch ${f.name.trim()}?`}
          note={c?.status === "PAUSED" ? "Players who match start getting it again the next time they open the app." : `${pushOnlyPrefix(f)}${summary(f, count, data.matches, data.cities, offerWall(), data.fields)} After launch the deal, who gets it and when it runs can't change.${pushOn && pf.enabled ? ` Also sends a push, "${pushText(pf, pushSugg).title}", ${pf.at ? `at ${pf.sendLocal} in each player's city` : "as soon as it launches"}.` : ""}`}
          extra={c?.status !== "PAUSED" && pushOn && pf.enabled ? <SendsTo campaignId={c && !offerDirty ? c.id : null} /> : null}
          warnings={staleLines(stale, f)}
          action={c?.status === "PAUSED" ? "Resume" : stale.length > 0 ? "Launch anyway" : "Launch"} onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(launch); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
      {confirm === "push" && (
        <ConfirmDialog title="Queue the push now?" note={`${f.name.trim()} is live, so saving queues its push ${pf.at ? `for ${pf.sendLocal} in each player's city` : "to go right away"}. It goes to the players this offer reaches who allow pushes, as far as the backend's push switch lets it. It can't be changed once queued.`}
          extra={<SendsTo campaignId={c?.id ?? null} />}
          action="Save and queue" onCancel={() => setConfirm(null)}
          onConfirm={async () => { const r = await once(save); if (!r) return null; setOutcome(r.o); if (r.o.verdict === "LANDED") { setConfirm(null); onLanded(r.o, r.id ?? undefined, savedAs(r.after)); } return r.o; }} />
      )}
      {confirm === "delete" && (
        <ConfirmDialog title={`Delete the draft ${c!.name}?`} kind="dangerSolid" note="It was never launched, so no player has it. This can't be undone."
          action="Delete" onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(discard); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
      {confirm === "pause" && (
        <ConfirmDialog title={`Pause ${c!.name}?`} note={pauseNote(c!.endsLocal)}
          action="Pause" onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(() => move("pause")); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
      {confirm === "end" && (
        <ConfirmDialog title={`End ${c!.name} for good?`} kind="dangerSolid" note={endNote(c!.endsLocal)}
          action="End" onCancel={() => setConfirm(null)}
          onConfirm={async () => { const o = await once(() => move("end")); if (o) { setOutcome(o); if (o.verdict === "LANDED") setConfirm(null); } return o; }} />
      )}
    </div>
  );
}

// A looked-up account in Specific players and Send test, tagged when it's staff rather than a player.
function PlayerRow({ p }: { p: Lookup["players"][number] }) {
  return (
    <div data-testid="offers-player-row" data-id={p.id} className="flex flex-wrap items-center gap-1.5" style={{ color: O.ink }}>
      <span>{playerLine(p)}</span>
      {isAdminAccount(p) && <span data-testid="offers-admin-tag" className="rounded-full px-1.5 py-[1px] text-[10px] font-semibold" style={{ background: O.warnBg, color: O.warnInk }}>Admin</span>}
    </div>
  );
}

const matchUnreadText = (read: MatchRead) => (read === "failed" ? "Couldn't load the match" : "Loading the match…");

// A wall-clock time that reads like the mock ("Today · 9:00 AM", "Sun, Nov 8 · 11:59 PM") and opens the
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
