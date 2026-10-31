"use client";

// ONE OFFER, top to bottom (Figma 20571:334; the specific-match state is 20581:54): Name, The deal,
// Who gets it (with the live count), Popup (live preview, text written from the deal and editable
// behind Edit text), Runs, More options (holdout), the summary with the most it can cost,
// then Launch. After launch the deal, the audience and the dates are locked (the backend refuses
// them); the name, the popup text and the total limit can still change, and Pause and End appear.
//
// SEND TEST (backend POST .../send-preview): the popup on up to 20 players' phones on their next app
// open, or on your own with Use my email. Needs a saved offer (any status, drafts included). Reported
// as "Sent to N", never as arrived. The last ids are remembered in this browser as a convenience.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FIRST_NAME_TOKEN, MAX_TEST_IDS, SECTION_ADD, addSection, autoCopy, canReset, copyAfterType, isRemovable, staleLines, staleSections, writtenForOnLoad, removeSection, resetCopy, sectionCollapsed, canHidePhoto, copyAfterHide, hideUpload, photoContentType, photoFileProblem, photoUrlOk, settableHeaders, uploadTiles, MAX_USES_PER_PLAYER, notFoundLine, parsePlayerIds, playerLine, prefillField, PREVIEW_FIRST_NAME, amountText, limitLine, stepLimit, stepUses, usesLine, audienceBody, buttonMatchNote, buttonOf, opensText, chicagoWallNow, copyOf, createBody, defaultRun, endsTicket, formOf, formProblem, fromInput, matchInfo,
  newForm, patchBody, mergeMatches, withCovers, COUNT_BLOCK, COUNT_DEBOUNCE_MS, countState, countWanted, lockedSummary, endHasPassed, launchProblem, offerWallNow, offerZones, setPriceAnyWarning, setPriceProblem, pickedMatch, startLabel, STEPPER, summary, toInput, wallLabel,
  type Campaign, type City, type Count, type FieldOpt, type Lookup, type UploadedPhoto, type CopyKey, type ListChange, type DealType, type Form, type MatchOpt, type WrittenFor,
} from "@/lib/offersModel";
import MatchPicker from "./MatchPicker";
import OfferPopupPreview from "./OfferPopupPreview";
import {
  Btn, Chip, ConfirmDialog, Labeled, O, PanelSection, VerdictLine, authed, inputCls, inputStyle, outcomeOf, settled, type WriteOutcome,
} from "./offersUi";

// Whether the matches this offer names are in hand. Until they are, what the form would work out from
// them (the match, its button, its text) is wrong, so nothing can be edited or launched. Pause, End and
// Delete still work, so an offer whose match can't be read can always be stopped.
export type MatchRead = "ok" | "loading" | "failed";
type Data = { campaigns: Campaign[]; cities: City[]; fields: FieldOpt[]; matches: MatchOpt[]; matchesComplete: boolean; matchesError: string | null };
const DEALS: { type: DealType; label: string }[] = [
  { type: "PERCENT_OFF", label: "% off" }, { type: "AMOUNT_OFF", label: "$ off" }, { type: "SET_PRICE", label: "Set price" }, { type: "FREE_MATCH", label: "Free match" },
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

export default function OfferPanel({ c, data: loaded, matchRead, onRetryMatch, onClose, onLanded }: {
  c: Campaign | null; data: Data; matchRead: MatchRead; onRetryMatch: () => void; onClose: () => void; onLanded: (o: WriteOutcome, selectId?: number, change?: ListChange) => void;
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
  const start = useMemo(() => (c ? formOf(c, data.matches, data.cities) : newForm(nowWall)), [c, data, nowWall]);
  const [f, setF] = useState<Form>(start);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const locked = c !== null && c.status !== "DRAFT";
  const ended = c?.status === "ENDED";
  const matchUnread = matchRead !== "ok";
  const frozen = ended || matchUnread;
  const m = pickedMatch(f, data.matches);
  const copy = copyOf(f, data.matches, data.cities);
  // Now, as the wall clock furthest ahead among this offer's cities. Worked out when asked, not on mount.
  const offerWall = () => offerWallNow(offerZones(f, m?.cityId ?? null, data.cities));
  const problem = matchUnread ? null : formProblem(f, data.matches, c?.status ?? null);
  const diff = c && !matchUnread ? patchBody(c, f, data.matches, data.cities) : null;
  const dirty = c === null || Object.keys(diff ?? {}).length > 0;
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
    if (matchUnread || !wantCount) return;
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
  const savedAs = (after: Campaign | null): ListChange | undefined => (after ? { kind: "saved", campaign: after } : undefined);
  async function save(): Promise<{ o: WriteOutcome; id: number | null; after: Campaign | null }> {
    if (c === null) {
      const { o, after } = await send("/api/offers", "POST", createBody(f, data.matches, data.cities), `Saved "${f.name.trim()}" as a draft.`);
      // A new offer's uploads move to its id, so they are still tiles when it reopens.
      if (after?.id) { keepUploads(after.id, uploaded); keepWritten(after.id, writtenFor); }
      return { o, id: after?.id ?? null, after };
    }
    if (!dirty) return { o: { verdict: "LANDED", text: "Nothing to save." }, id: c.id, after: null };
    const { o, after } = await send(`/api/offers/${c.id}`, "PATCH", diff, `Saved changes to "${f.name.trim()}".`);
    if (o.verdict === "LANDED") keepWritten(c.id, writtenFor);
    return { o, id: c.id, after };
  }
  async function onSave() {
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
  const pickDeal = (type: DealType) => set({ dealType: type, dealAmount: STEPPER[type]?.start ?? 0 });
  const step = (dir: 1 | -1) => {
    const s = STEPPER[f.dealType];
    if (!s) return;
    set({ dealAmount: Math.min(s.max, Math.max(s.min, f.dealAmount + dir * s.step)) });
  };
  const pickScope = (scope: "ANY" | "MATCH") => {
    if (scope === f.scope) return;
    if (scope === "ANY") set({ scope, matchId: null, endsLocal: defaultRun(nowWall).endsLocal });
    else set({ scope, usesPerPlayer: 1 });
  };
  const pickMatch = (id: number) => {
    const mm = data.matches.find((x) => x.id === id) ?? null;
    // A specific match's offer ends at its kickoff unless someone moves it, and Played at is
    // prefilled with that match's field (the person can take it off).
    set({ matchId: id, ...(mm ? { endsLocal: mm.startLocal, fieldIds: prefillField(f.fieldIds, mm) } : {}) });
  };

  // ── who gets it ──
  const [addingCity, setAddingCity] = useState(false);
  const otherCities = data.cities.filter((x) => !f.cityIds.includes(x.id));
  const lastPlayedOn = (lp: Form["lastPlayed"], days: number | null) => f.lastPlayed === lp && (lp !== "LAPSED" || f.lastPlayedDays === days);
  const oddLapse = f.lastPlayed === "LAPSED" && f.lastPlayedDays !== 30 && f.lastPlayedDays !== 60;
  const [addingField, setAddingField] = useState(false);
  const fieldsInCities = data.fields.filter((x) => f.cityIds.length === 0 || (x.cityId !== null && f.cityIds.includes(x.cityId)));
  const otherFields = fieldsInCities.filter((x) => !f.fieldIds.includes(x.id));
  const fieldTitle = (id: number) => data.fields.find((x) => x.id === id)?.title ?? `Field ${id}`;
  const players = f.audienceMode === "PLAYERS";

  // ── specific players: look the ids up as they are typed (debounced) ──
  const parsed = useMemo(() => parsePlayerIds(f.playerIdsText), [f.playerIdsText]);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const idsKey = parsed.ids.join(",");
  useEffect(() => {
    if (!players || parsed.ids.length === 0) { setLookup(null); setLookupErr(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await authed("/api/offers/players", { method: "POST", body: JSON.stringify({ ids: parsed.ids }) });
      if (cancelled) return;
      if (!r.ok) { setLookupErr(String(r.json.error)); setLookup(null); return; }
      setLookupErr(null); setLookup(r.json as unknown as Lookup);
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, idsKey]);
  // The ids sent are the ones typed, less any the lookup says are not players (the backend refuses those).
  useEffect(() => {
    const keep = parsed.ids.filter((id) => !(lookup?.notFound ?? []).includes(id));
    setF((x) => (x.playerIds.join(",") === keep.join(",") ? x : { ...x, playerIds: keep }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, lookup]);

  // ── popup text ──
  const [editText, setEditText] = useState(false);
  const suggested = autoCopy(f, data.matches, data.cities);
  const setCopy = (k: CopyKey, v: string) => {
    setF((x) => ({ ...x, copy: copyAfterType(x.copy, k, v, suggested[k]) }));
    setWrittenFor((w) => ({ ...w, [k]: suggested[k] }));
  };
  const [writtenFor, setWrittenFor] = useState<WrittenFor>(() => (c ? writtenForOnLoad(start, readWritten(c.id), data.matches, data.cities) : {}));
  const stale = staleSections(f, writtenFor, c?.status ?? null, data.matches, data.cities);
  // What a section held when Remove was pressed, so + Add puts it back. Cleared by a save (the panel remounts).
  const [typedBefore, setTypedBefore] = useState<Partial<Record<CopyKey, string>>>({});
  const [more, setMore] = useState(false);
  const ends = endsTicket(f.endsLocal, offerWall());
  // ── Button opens (Figma 20612:47 / 92 / 142). Editable after launch like the rest of the text;
  // forced and locked to the deal's match when the offer is for a specific match.
  const photoName = (url: string | null) => {
    if (!url) return "MatchDay photo";
    const fx = data.fields.find((x) => x.cover === url);
    return fx ? `${fx.title} cover` : "Custom photo";
  };
  const btn = buttonOf(f, data.matches);
  const btnMatch = data.matches.find((x) => x.id === btn.matchId) ?? null;
  // ── Photo (no mock): field cover photos for fields in the offer's cities, name and city under each.
  // Picking one stores its URL as the photo; MatchDay photo is the app's default. No uploads in v1.
  // A specific match's own field cover is the default for that offer. Editable after launch.
  const coverFields = data.fields.filter((x) => x.cover && (f.cityIds.length === 0 || (x.cityId !== null && f.cityIds.includes(x.cityId))));
  const cityName = (id: number | null) => data.cities.find((x) => x.id === id)?.name ?? "";
  // UPLOAD: the tile after the covers (click or drop). The file goes straight from this browser to the
  // backend's link, with progress, then is registered and selected. The backend keeps no list of an
  // offer's uploads, so they are remembered per offer in this browser (a convenience); the offer's
  // saved photo always shows as a tile whatever this browser remembers.
  const [uploaded, setUploaded] = useState<UploadedPhoto[]>(() => (c ? readUploads(c.id) : []));
  const [upPct, setUpPct] = useState<number | null>(null);
  const [upErr, setUpErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
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
      setF((v) => ({ ...v, copy: { ...v.copy, photoUrl: url } }));
    } finally { setUpPct(null); }
  }
  const coverUrls = coverFields.map((x) => x.cover as string);
  // The × hides an upload from this offer's tiles in this browser. The file itself is not deleted.
  function hidePhoto(url: string) {
    const next = hideUpload(uploaded, url);
    setUploaded(next);
    if (c) keepUploads(c.id, next);
    setF((v) => ({ ...v, copy: copyAfterHide(v.copy, url, c?.photoUrl ?? (c ? null : undefined), copyOf({ ...v, copy: {} }, data.matches, data.cities).photoUrl) }));
  }
  const photoTile = (key: string | number, url: string | null, title: string, sub: string, onHide?: () => void) => {
    const on = (copy.photoUrl ?? null) === url;
    return (
      <div key={key} className="relative flex">
      <button type="button" data-testid={`offers-photo-${key}`} data-on={on ? "1" : "0"} disabled={frozen}
        onClick={() => setF((v) => ({ ...v, copy: { ...v.copy, photoUrl: url } }))}
        className="flex w-full flex-col overflow-hidden rounded-[8px] border-2 text-left" style={{ borderColor: on ? O.chipOn : O.line }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" src={url ?? "/offers/offer-popup-photo.jpg"} className="h-[48px] w-full object-cover" />
        <span className="truncate px-1.5 pt-1 text-[11px] font-medium" style={{ color: O.ink }}>{title}</span>
        <span className="truncate px-1.5 pb-1 text-[10.5px]" style={{ color: O.muted }}>{sub}</span>
      </button>
      {onHide && !frozen && (
        <button type="button" data-testid={`offers-hide-${key}`} aria-label={`Hide ${title}`} title="Hide this photo" onClick={onHide}
          className="absolute right-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[12px] leading-none text-white" style={{ background: "rgba(6,61,44,.85)" }}>×</button>
      )}
      </div>
    );
  };
  const photoPicker = () => (
    <div data-testid="offers-photo" className="flex flex-col gap-1.5">
      <div className="text-[12px] font-medium" style={{ color: O.ink }}>Photo</div>
      <div className="grid grid-cols-2 gap-2">
        {photoTile("default", null, "MatchDay photo", "Default")}
        {coverFields.map((x) => photoTile(`field-${x.id}`, x.cover, x.title, cityName(x.cityId)))}
        {uploadTiles(uploaded, c?.photoUrl ?? null, coverUrls).map((p, i) => photoTile(`upload-${i}`, p.url, p.name, "Uploaded", canHidePhoto(p.url, c?.photoUrl ?? null) ? () => hidePhoto(p.url) : undefined))}
        {!ended && (
          <button type="button" data-testid="offers-photo-upload" disabled={upPct !== null}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); uploadPhoto(e.dataTransfer.files[0]); }}
            className="flex min-h-[82px] flex-col items-center justify-center gap-1 rounded-[8px] border-2 border-dashed px-1.5 text-center"
            style={{ borderColor: dragging ? O.chipOn : O.line, background: dragging ? O.mint : O.surface }}>
            {upPct === null
              ? <><span className="text-[12px] font-semibold" style={{ color: O.ink }}>Upload</span><span className="text-[10.5px]" style={{ color: O.muted }}>Click or drop an image</span></>
              : <>
                  <span data-testid="offers-upload-pct" className="text-[11px] font-medium" style={{ color: O.ink }}>{upPct >= 1 ? "Finishing…" : `Uploading ${Math.round(upPct * 100)}%`}</span>
                  <span className="h-1 w-4/5 overflow-hidden rounded-full" style={{ background: O.line }}><span className="block h-full" style={{ width: `${Math.round(upPct * 100)}%`, background: O.chipOn }} /></span>
                </>}
          </button>
        )}
      </div>
      <input ref={fileInput} data-testid="offers-photo-file" type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={(e) => { uploadPhoto(e.target.files?.[0]); e.target.value = ""; }} />
      {upErr && <div data-testid="offers-upload-error" className="text-[11.5px] font-medium" style={{ color: O.critInk }}>{upErr}</div>}
      <div className="text-[11.5px] leading-[16px]" style={{ color: O.muted }}>Best at 1200 × 650, landscape. Text on the image may be covered by the tag and line.</div>
    </div>
  );
  const buttonOpens = () => {
    const off = btn.locked || frozen;
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
            <MatchPicker {...pickerProps} testId="offers-btn-match" selected={btnMatch}
              disabled={frozen} locked={btn.locked} empty={matchUnread ? matchUnreadText(matchRead) : undefined} onPick={(id) => set({ buttonMatchId: id })} />
            {btn.locked
              ? <div data-testid="offers-btn-note" className="rounded-[8px] px-2.5 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Opens the match this offer is for.</div>
              : btnMatch && <div data-testid="offers-btn-note" className="rounded-[8px] px-2.5 py-2 text-[12px]" style={{ background: O.mint, color: O.ok }}>{buttonMatchNote(btnMatch)}</div>}
          </>
        )}
      </div>
    );
  };
  const dl = locked || frozen; // deal, audience and run locked
  const passed = endHasPassed(f.endsLocal, offerWall());
  const launchWhy = matchUnread ? matchUnreadText(matchRead) : problem ?? launchProblem(f, offerWall()) ?? COUNT_BLOCK[countNow];
  const dealWarn = setPriceProblem(f, m);
  const anyWarn = setPriceAnyWarning(f, data.matches);

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
          <input data-testid="offers-name" className={inputCls} style={inputStyle} value={f.name} disabled={frozen} placeholder="Austin win-back"
            onChange={(e) => set({ name: e.target.value })} />
        </Labeled>
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
        {!m && !matchUnread && (
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
            <Chip testId="offers-limit-none" on={f.maxRedemptions === null} disabled={frozen} onClick={() => set({ maxRedemptions: null })}>No limit</Chip>
            {f.maxRedemptions === null
              ? <Chip testId="offers-limit-set" on={false} disabled={frozen} onClick={() => set({ maxRedemptions: 50 })}>Set a limit</Chip>
              : (
                <div className="flex items-center gap-2.5">
                  <Stepper testId="offers-limit-n" value={f.maxRedemptions} disabled={frozen} atMin={f.maxRedemptions <= 1}
                    minus={() => set({ maxRedemptions: stepLimit(f.maxRedemptions, -1) })} plus={() => set({ maxRedemptions: stepLimit(f.maxRedemptions, 1) })}
                    onType={(n) => set({ maxRedemptions: n })} />
                  <span className="text-[13px]" style={{ color: O.ink }}>uses in total</span>
                </div>
              )}
          </div>
          {f.maxRedemptions !== null && <div data-testid="offers-limit-line" className="text-[12px]" style={{ color: O.muted }}>{limitLine(f.maxRedemptions)}</div>}
        </div>
        {!dl && dealWarn && <div data-testid="offers-setprice-block" className="text-[12px] font-medium" style={{ color: O.critInk }}>{dealWarn}</div>}
        {!dl && !dealWarn && m && f.dealType === "SET_PRICE" && f.dealAmount === m.price && (
          <div className="text-[12px]" style={{ color: O.warnInk }}>That is the same as its normal {amountText("SET_PRICE", m.price)}, so nobody saves anything.</div>
        )}
        {!dl && !dealWarn && anyWarn && <div data-testid="offers-setprice-warn" className="text-[12px]" style={{ color: O.warnInk }}>{anyWarn}</div>}
        <Labeled label="Applies to">
          <div className="flex flex-wrap gap-1.5">
            <Chip testId="offers-scope-ANY" on={f.scope === "ANY"} disabled={dl} onClick={() => pickScope("ANY")}>Any match</Chip>
            <Chip testId="offers-scope-MATCH" on={f.scope === "MATCH"} disabled={dl} onClick={() => pickScope("MATCH")}>A specific match</Chip>
          </div>
        </Labeled>
        {f.scope === "MATCH" && (
          <>
            <Labeled label="Match">
              <MatchPicker {...pickerProps} testId="offers-match" selected={m}
                disabled={dl} empty={matchUnread ? matchUnreadText(matchRead) : undefined} onPick={pickMatch} />
            </Labeled>
            {m && <div data-testid="offers-match-info" className="rounded-[8px] px-3 py-[9px] text-[12px]" style={{ background: O.subtle, color: O.muted }}>{matchInfo(m)}</div>}
          </>
        )}
      </PanelSection>

      {/* WHO GETS IT */}
      <PanelSection title="Who gets it" testId="offers-who">
        {/* Figma 20620:75 (filters + fields) and 20620:128 (specific players). */}
        <div className="flex flex-wrap gap-1.5">
          <Chip testId="offers-mode-FILTERS" on={!players} disabled={dl} onClick={() => set({ audienceMode: "FILTERS" })}>Filters</Chip>
          <Chip testId="offers-mode-PLAYERS" on={players} disabled={dl} onClick={() => set({ audienceMode: "PLAYERS" })}>Specific players</Chip>
        </div>
        {players ? (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-medium" style={{ color: O.ink }}>Player IDs</span>
                <span className="text-[11px]" style={{ color: O.label }}>commas, spaces or one per line</span>
              </div>
              <textarea data-testid="offers-player-ids" rows={4} disabled={dl} className={`${inputCls} leading-[19px]`} style={inputStyle}
                value={f.playerIdsText} onChange={(e) => set({ playerIdsText: e.target.value })} placeholder="10482, 10511, 9877" />
            </div>
            {parsed.bad.length > 0 && <div data-testid="offers-ids-bad" className="self-start rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium" style={{ background: O.warnBg, color: O.warnInk }}>Not an ID: {parsed.bad.slice(0, 5).join(", ")}{parsed.bad.length > 5 ? "…" : ""}. It will be skipped.</div>}
            {parsed.tooMany && <div className="self-start rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium" style={{ background: O.warnBg, color: O.warnInk }}>Only the first 2,000 IDs are used.</div>}
            {lookupErr && <div className="self-start rounded-[8px] px-2.5 py-1.5 text-[12px]" style={{ background: O.critBg, color: O.critInk }}>Couldn&apos;t look them up: {lookupErr}</div>}
            {lookup && (
              <>
                <div data-testid="offers-found" className="flex gap-1.5 self-start rounded-[8px] px-2.5 py-1.5 text-[12px]" style={{ background: O.mint, color: O.ok }}>
                  <b>{lookup.players.length.toLocaleString("en-US")} {lookup.players.length === 1 ? "player" : "players"}</b><span>found</span>
                </div>
                {lookup.notFound.length > 0 && <div data-testid="offers-not-found" className="self-start rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium" style={{ background: O.warnBg, color: O.warnInk }}>{notFoundLine(lookup.notFound)}</div>}
                {lookup.players.length > 0 && (
                  <div data-testid="offers-found-list" className="flex flex-col gap-1 rounded-[8px] px-3 py-2.5 text-[12px]" style={{ background: O.subtle }}>
                    {lookup.players.slice(0, 3).map((p) => <div key={p.id} style={{ color: O.ink }}>{playerLine(p)}</div>)}
                    {lookup.players.length > 3 && <div style={{ color: O.ok }}>+ {(lookup.players.length - 3).toLocaleString("en-US")} more</div>}
                  </div>
                )}
              </>
            )}
            <div className="text-[12px] leading-[17px]" style={{ color: O.muted }}>Only these players get it. City and other filters don&apos;t apply, and nobody is held back.</div>
          </>
        ) : (
          <>
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
            <div data-testid="offers-played-at" className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-medium" style={{ color: O.ink }}>Played at</span>
                <span className="text-[11px]" style={{ color: O.label }}>any of these fields · leave empty for all</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {f.fieldIds.map((id) => (
                  <Chip key={id} on testId={`offers-pf-${id}`} disabled={dl} title={dl ? undefined : "Remove"} onClick={() => set({ fieldIds: f.fieldIds.filter((x) => x !== id) })}>{`${fieldTitle(id)}  ×`}</Chip>
                ))}
                {!dl && otherFields.length > 0 && <Chip testId="offers-add-field" on={false} onClick={() => setAddingField((v) => !v)}>+ Field</Chip>}
                {f.fieldIds.length === 0 && (dl || otherFields.length === 0) && <span className="self-center text-[12px]" style={{ color: O.muted }}>Any field</span>}
              </div>
              {addingField && !dl && (
                <div className="flex flex-wrap gap-1.5 rounded-[8px] p-2" style={{ background: O.subtle }}>
                  {otherFields.map((x) => <Chip key={x.id} testId={`offers-field-${x.id}`} on={false} onClick={() => { set({ fieldIds: [...f.fieldIds, x.id] }); setAddingField(false); }}>{x.title}</Chip>)}
                </div>
              )}
            </div>
            <Labeled label="Last played">
              <div className="flex flex-wrap gap-1.5">
                <Chip testId="offers-lp-any" on={lastPlayedOn("ANY", null)} disabled={dl} onClick={() => set({ lastPlayed: "ANY", lastPlayedDays: null })}>Any time</Chip>
                <Chip testId="offers-lp-30" on={lastPlayedOn("LAPSED", 30)} disabled={dl} onClick={() => set({ lastPlayed: "LAPSED", lastPlayedDays: 30 })}>30+ days ago</Chip>
                <Chip testId="offers-lp-60" on={lastPlayedOn("LAPSED", 60)} disabled={dl} onClick={() => set({ lastPlayed: "LAPSED", lastPlayedDays: 60 })}>60+ days ago</Chip>
                {oddLapse && <Chip on>{`${f.lastPlayedDays}+ days ago`}</Chip>}
                <Chip testId="offers-lp-never" on={lastPlayedOn("NEVER", null)} disabled={dl} onClick={() => set({ lastPlayed: "NEVER", lastPlayedDays: null })}>Never</Chip>
              </div>
            </Labeled>
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
          </>
        )}
        {!players && !matchUnread && wantCount && <div data-testid="offers-count" data-state={countNow} className="flex flex-wrap gap-1.5 self-start rounded-[8px] px-2.5 py-1.5 text-[12px]" style={{ background: countNow === "error" ? O.critBg : O.mint, color: countNow === "error" ? O.critInk : O.ok }}>
          {countNow === "error" ? <><span>Couldn&apos;t count: {countErr}</span><button type="button" data-testid="offers-count-retry" className="font-semibold underline" onClick={retryCount}>Retry</button></>
            : count ? <><b>≈ {count.count.toLocaleString("en-US")} {count.count === 1 ? "player" : "players"}</b><span>match right now</span></>
            : <span>Counting…</span>}
        </div>}
      </PanelSection>

      {/* POPUP */}
      <PanelSection title={editText && !frozen ? "Popup · Edit text" : "Popup"} testId="offers-popup">
        {/* Figma 20612:47: with Edit text open the fields take the summary's place beside the preview. */}
        <div className="flex items-start gap-3.5">
          <div className="flex shrink-0 flex-col gap-2">
            <OfferPopupPreview copy={copy} ends={ends} />
            <div data-testid="offers-opens" className="max-w-[156px] text-[11px] font-medium" style={{ color: O.muted }}>{matchUnread ? "↳ Opens a match" : opensText(f, data.matches)}</div>
          </div>
          {editText && !frozen ? (
            <div data-testid="offers-text-fields" className="flex min-w-0 flex-1 flex-col gap-3">
              {([["buttonLabel", "Button label", 64], ["eyebrow", "Tag on the photo", 64], ["caption", "Line on the photo", 64], ["headline", "Headline (last word in green)", 64], ["line", "Line", 64], ["body", "Body", 300], ["dismissLabel", "Dismiss link", 64]] as const).map(([k, label, max]) => {
                const auto = suggested[k];
                if (isRemovable(k) && sectionCollapsed(f.copy, k, auto)) {
                  return (
                    <button key={k} type="button" data-testid={`offers-add-${k}`} className="self-start text-[12px] font-semibold" style={{ color: O.ok }}
                      onClick={() => setF((x) => ({ ...x, copy: addSection(x.copy, k, typedBefore[k], auto) }))}>{SECTION_ADD[k]}</button>
                  );
                }
                const value = f.copy[k] ?? auto ?? "";
                return (
                  <div key={k} className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <label htmlFor={`offers-copy-${k}`} className="text-[12px] font-medium" style={{ color: O.ink }}>{label}</label>
                        {isRemovable(k) && (
                          <button type="button" data-testid={`offers-remove-${k}`} className="text-[11.5px] font-medium" style={{ color: O.muted }}
                            onClick={() => {
                              const typed = f.copy[k];
                              setTypedBefore((x) => { const n = { ...x }; if (typeof typed === "string") n[k] = typed; else delete n[k]; return n; });
                              setF((x) => ({ ...x, copy: removeSection(x.copy, k) }));
                            }}>Remove</button>
                        )}
                      </div>
                      {k === "body"
                        ? <textarea id={`offers-copy-${k}`} data-testid={`offers-copy-${k}`} rows={3} maxLength={max} className={inputCls} style={inputStyle} value={value} onChange={(e) => setCopy(k, e.target.value)} />
                        : <input id={`offers-copy-${k}`} data-testid={`offers-copy-${k}`} maxLength={max} className={inputCls} style={inputStyle} value={value} onChange={(e) => setCopy(k, e.target.value)} />}
                      {(stale.includes(k) || canReset(f.copy, k, auto)) && (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          {stale.includes(k) && <span data-testid={`offers-stale-${k}`} className="text-[11.5px] font-medium" style={{ color: O.warnInk }}>Written for the old deal</span>}
                          {canReset(f.copy, k, auto) && (
                            <button type="button" data-testid={`offers-reset-${k}`} className="text-[11.5px] font-medium" style={{ color: O.ok }}
                              onClick={() => setF((x) => ({ ...x, copy: resetCopy(x.copy, k) }))}>Reset to suggested</button>
                          )}
                        </div>
                      )}
                    </div>
                    {k === "buttonLabel" && buttonOpens()}
                    {k === "buttonLabel" && photoPicker()}
                  </div>
                );
              })}
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
              {stale.length > 0 && <div data-testid="offers-stale-note" className="text-[12px] font-medium" style={{ color: O.warnInk }}>Written for the old deal: {stale.length} {stale.length === 1 ? "section" : "sections"}. See Edit text.</div>}
              {!frozen && (
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
        {passed && !dl && <div data-testid="offers-end-passed" className="text-[12px] font-medium" style={{ color: O.critInk }}>That end time has already passed, so it can&apos;t launch.</div>}
        {!players && <button type="button" data-testid="offers-more" onClick={() => setMore((v) => !v)} className="flex w-full items-center justify-between gap-2 rounded-[8px] px-3 py-[9px] text-left text-[12px]" style={{ background: O.subtle }}>
          <span className="font-medium" style={{ color: O.ink }}>More options</span>
          <span style={{ color: O.muted }}>{f.holdoutPercent > 0 ? `${f.holdoutPercent}% held back to measure` : "Nobody held back"} {more ? "‹" : "›"}</span>
        </button>}
        {more && !players && (
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
          {matchUnread ? matchUnreadText(matchRead) : wantCount ? summary(f, count, data.matches, data.cities, offerWall(), data.fields) : lockedSummary(f, data.matches, data.cities, offerWall(), data.fields)}
        </p>
        {outcome && <VerdictLine outcome={outcome} />}
        {problem && !ended && dirty && <div data-testid="offers-problem" className="text-[12px]" style={{ color: O.warnInk }}>{problem}</div>}
        {!ended && (
          <div className="flex flex-wrap gap-2">
            {(c === null || c.status === "DRAFT") && (
              <Btn kind="primary" testId="offers-launch" disabled={busy || !!launchWhy} title={launchWhy ?? undefined} onClick={() => setConfirm("launch")}>Launch</Btn>
            )}
            {c?.status === "PAUSED" && <Btn kind="primary" testId="offers-resume" disabled={busy || dirty || passed} title={passed ? "The end time has already passed." : dirty ? "Save or undo your changes first" : undefined} onClick={() => setConfirm("launch")}>Resume</Btn>}
            {(c === null || dirty) && (
              <Btn testId="offers-save" disabled={busy || !!problem || (c !== null && settled(outcome) && !dirty)} onClick={onSave}>{c === null ? "Save draft" : "Save changes"}</Btn>
            )}
            {c?.status === "LAUNCHED" && <Btn testId="offers-pause" disabled={busy} onClick={() => setConfirm("pause")}>Pause</Btn>}
            {(c?.status === "LAUNCHED" || c?.status === "PAUSED") && <Btn kind="danger" testId="offers-end" disabled={busy} onClick={() => setConfirm("end")}>End</Btn>}
            {c?.status === "DRAFT" && <Btn kind="danger" testId="offers-delete" disabled={busy} onClick={() => setConfirm("delete")}>Delete</Btn>}
            <Btn testId="offers-test" disabled={busy || c === null || (c.status === "DRAFT" && dirty)} title={c === null ? "Save it as a draft first" : c.status === "DRAFT" && dirty ? "Save your changes first, so the phone shows what you see" : undefined}
              onClick={() => { if (!testOpen) setTestText(readTestIds()); setTestOpen((v) => !v); }}>Send test</Btn>
          </div>
        )}
        {testOpen && c !== null && !ended && (
          <div data-testid="offers-test-pop" className="flex flex-col gap-2 rounded-[10px] border p-3 shadow-[0_6px_20px_rgba(0,51,38,0.10)]" style={{ borderColor: O.line, background: O.surface }}>
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium" style={{ color: O.ink }}>Player IDs</span>
              <span className="text-[11px]" style={{ color: O.label }}>up to {MAX_TEST_IDS} · commas, spaces or one per line</span>
            </div>
            <textarea data-testid="offers-test-ids" rows={2} className={inputCls} style={inputStyle} value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="10482, 10511" />
            {testParsed.ids.length > MAX_TEST_IDS && <div className="text-[12px] font-medium" style={{ color: O.warnInk }}>A test goes to {MAX_TEST_IDS} players at most ({testParsed.ids.length} here).</div>}
            {testLookup && (
              <div data-testid="offers-test-found" className="flex flex-col gap-1 rounded-[8px] px-3 py-2 text-[12px]" style={{ background: O.subtle }}>
                {testLookup.players.map((p) => <div key={p.id} style={{ color: O.ink }}>{playerLine(p)}</div>)}
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
        {!ended && c === null && <div data-testid="offers-phone-note" className="text-[11.5px]" style={{ color: O.muted }}>Save it as a draft to send a test.</div>}
      </section>

      {confirm === "launch" && (
        <ConfirmDialog title={c?.status === "PAUSED" ? `Resume ${f.name.trim()}?` : `Launch ${f.name.trim()}?`}
          note={c?.status === "PAUSED" ? "Players who match start getting it again the next time they open the app." : `${summary(f, count, data.matches, data.cities, offerWall(), data.fields)} After launch the deal, who gets it and when it runs can't change.`}
          warnings={staleLines(stale, f)}
          action={c?.status === "PAUSED" ? "Resume" : stale.length > 0 ? "Launch anyway" : "Launch"} onCancel={() => setConfirm(null)}
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

const matchUnreadText = (read: MatchRead) => (read === "failed" ? "Couldn't load the match" : "Loading the match…");

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
