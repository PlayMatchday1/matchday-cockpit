"use client";

/* MEMBERS — the Retool MEMBERSHIPS page, rebuilt. Figma: 9TgSk4sYqq4nNoTH73wRRs, page "Clubhouse ·
 * Members", frames 1 (page + panel), 2 (member price), 4 (end confirm), 5 (two-fact result) and 6
 * (search). Frame 3 (email members) is NOT built: no path can send to exactly the filter on screen —
 * Clubhouse has no mail provider and the backend's Email Members goes to every ACTIVE row in every
 * city. Frame 1's "Keep membership" is NOT built: the backend has no admin resume.
 *
 * Every rule is in src/lib/membersPageModel.ts; this file draws and calls routes.
 *
 * READS: /api/membership/members (list, search, CSV, city settings), /api/membership/members/{id}
 * (Stripe, last charge, comment author), /api/lookup/{env}?id= (the live player read).
 * WRITES, each with its own server-side grant: change price and end (EDIT MEMBERSHIPS, the existing
 * Player Lookup routes), comment (EDIT MEMBERSHIPS), member price and strike fine (admin only), strike
 * remove (MANAGE PLAYERS, the existing route — switched off here, see STRIKE_BACKEND_FIX_LIVE).
 *
 * Plain <style>, not styled-jsx, and NO BACKTICKS anywhere inside the CSS string. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth, canEditMemberships, canManagePlayers } from "@/lib/useAuth";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { envBadge } from "@/lib/matchEnvBadge";
import { centsFromDollars, dollarsFromCents, priceRefusal, endRefusal } from "@/lib/membershipAdminModel";
import { strikeControl, strikeReasonLabel, removalEffect, STRIKE_LIMIT } from "@/lib/playerLookupModel";
import {
  TABS, dayCT, dateCT, usd, trimPct, strikesLabel, owedLabel, scheduledEnd, endConfirmCopy,
  membersStrikeControl, commentRefusal, planPriceRefusal, strikeFineRefusal, strikeFineTaxLine,
  factsFromVerdict, twoFacts, strikeRemoveFacts, STRIKE_BACKEND_FIX_LIVE, STRIKE_REMOVE_OFF_REASON, SEARCH_MIN, COMMENT_MAX,
  type Tab, type Chip, type NextCell, type Fact,
} from "@/lib/membersPageModel";

const ENV = FULL_EDITOR_ENV;
const CITY_KEY = "members.city";

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

/* ── shapes the routes return ───────────────────────────────────────────────────────────────── */
type ViewRow = {
  membershipId: number; userId: number; city: string; cityName: string; slug: string | null;
  name: string; email: string | null; phone: string | null; status: string; priceDollars: number | null;
  activationDate: string | null; canceledAt: string | null; comment: string | null; suspendedTo: string | null;
  strikePoints: number; absentOwed: number; chip: Chip; next: NextCell; days: number | null;
  listPrice: string | null; hasComment: boolean;
};
type Settings = {
  city: string; planCents: number | null; taxRatePct: number | null; fineCents: number | null;
  payingCount: number; errors: string[];
};
type ListRes = {
  mode: "list"; city: string; tab: Tab; counts: Record<Tab, number>; confinedTo: string | null;
  cities: { identifier: string; name: string }[]; settings: Settings | null; syncedAt: string | null;
  source: string; page: number; pages: number; total: number; rows: ViewRow[];
};
type SearchRes = { mode: "search"; q: string; summary: string; rows: ViewRow[]; syncedAt: string | null };
type Extras = {
  subscriptionId: string | null;
  stripe: { found: boolean; status: string | null; cancelAtPeriodEnd: boolean | null; cancelAt: string | null; currentPeriodEnd: string | null; unitAmount: number | null; card: string | null; error: string | null };
  lastPaid: { cents: number; at: string } | null;
  stored: { failedAt?: string | null; failedAmountCents?: number | null; nextRetryAt?: string | null; cancelAt?: string | null; cancelAtPeriodEnd?: boolean | null; currentPeriodEnd?: string | null; endReadAt?: string | null } | null;
  comment: { text: string | null; by: string | null; at: string | null };
};
type StrikeLog = { id: number | null; userMatchId: number | null; penaltyPoint: number; active: boolean; reason: string | null; matchName: string | null; when: string | null; hoursBefore: number | null };
type Profile = {
  membership: { id: number | null; statusRaw: string | null; stripeSubscriptionId: string | null; price: number | null; canceledAt: string | null; renews: string | null } | null;
  strikes: { activeCount: number; isSuspended: boolean; suspendedTo: string | null; expiredAt: string | null; logs: StrikeLog[] };
};
type Result = { title: string; facts: Fact[]; allGood: boolean; note?: string };

export default function MembersView() {
  const { appUser } = useAuth();
  const canMember = canEditMemberships(appUser);   // courtesy only — every route re-checks
  const isAdmin = appUser?.is_admin === true;       // courtesy only — the city routes re-check
  const canManage = canManagePlayers(appUser);      // courtesy only — the strikes route re-checks (MANAGE PLAYERS)
  const badge = envBadge(ENV);

  const [city, setCity] = useState<string>("ATX");
  const [tab, setTab] = useState<Tab>("current");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ListRes | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState<SearchRes | null>(null);
  const [sel, setSel] = useState<ViewRow | null>(null);
  const [dlg, setDlg] = useState<null | "plan" | "fine">(null);
  const [result, setResult] = useState<Result | null>(null);
  const reqRef = useRef(0);

  useEffect(() => { try { const c = window.localStorage.getItem(CITY_KEY); if (c) setCity(c); } catch { /* storage blocked */ } }, []);

  const load = useCallback(async (fresh = false) => {
    const my = ++reqRef.current;
    setLoading(true); setLoadErr(null);
    try {
      const r = await authFetch(`/api/membership/members?env=${ENV}&city=${encodeURIComponent(city)}&tab=${tab}&page=${page}${fresh ? "&fresh=1" : ""}`);
      const j = await r.json();
      if (my !== reqRef.current) return;
      if (!r.ok) { setLoadErr(j.error ?? `HTTP ${r.status}`); return; }
      setList(j as ListRes);
      if ((j as ListRes).confinedTo && (j as ListRes).confinedTo !== city) setCity((j as ListRes).confinedTo as string);
    } catch (e) { if (my === reqRef.current) setLoadErr(e instanceof Error ? e.message : String(e)); }
    finally { if (my === reqRef.current) setLoading(false); }
  }, [city, tab, page]);
  useEffect(() => { void load(); }, [load]);

  // SEARCH — every city, every status; the picker does not move (frame 6).
  useEffect(() => {
    const t = q.trim();
    if (t.length < SEARCH_MIN) { setSearch(null); return; }
    const h = setTimeout(async () => {
      const r = await authFetch(`/api/membership/members?env=${ENV}&city=${encodeURIComponent(city)}&q=${encodeURIComponent(t)}&settings=0`);
      const j = await r.json().catch(() => ({}));
      if (r.ok) setSearch(j as SearchRes); else setLoadErr(j.error ?? `HTTP ${r.status}`);
    }, 250);
    return () => clearTimeout(h);
  }, [q, city]);

  const pickCity = (c: string) => {
    setCity(c); setPage(1); setSel(null);
    try { window.localStorage.setItem(CITY_KEY, c); } catch { /* storage blocked */ }
  };
  const searchFresh = !!search && search.q === q.trim();
  const cityName = list?.cities.find((c) => c.identifier === city)?.name ?? city;
  const s = list?.settings ?? null;

  const downloadCsv = async () => {
    const r = await authFetch(`/api/membership/members?env=${ENV}&city=${encodeURIComponent(city)}&tab=${tab}&format=csv&settings=1`);
    if (!r.ok) { setLoadErr((await r.json().catch(() => ({}))).error ?? `CSV failed (HTTP ${r.status})`); return; }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `members-${city}-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const afterWrite = (res: Result) => { setResult(res); void load(true); };

  return (
    <div className="mbr" data-testid="members-page">
      <style>{CSS}</style>
      <div className="mbr-main">
        <div className="mbr-head">
          <h1>Members</h1>
          <select className="mbr-city" data-testid="members-city" value={city} disabled={!!list?.confinedTo}
            onChange={(e) => pickCity(e.target.value)} aria-label="City">
            {(list?.cities ?? [{ identifier: city, name: city }]).map((c) => <option key={c.identifier} value={c.identifier}>{c.name}</option>)}
          </select>
          {badge && <span className="mbr-env" title="Every read and write on this page goes to this environment">{badge.label}</span>}
          <span className="mbr-sp" />
          <button className="mbr-btn" data-testid="members-csv" onClick={downloadCsv} disabled={!list || loading}>Download CSV</button>
        </div>

        <div className="mbr-settings" data-testid="members-settings">
          <div className="mbr-set">
            <div className="mbr-k">MEMBER PRICE</div>
            <div className="mbr-v">{s?.planCents != null ? `${usd(s.planCents)}/mo` : "—"}
              {isAdmin && s?.planCents != null && <button className="mbr-link" data-testid="edit-plan" onClick={() => setDlg("plan")}>Edit</button>}
            </div>
            <div className="mbr-sub">{s?.taxRatePct ? `plus ${trimPct(s.taxRatePct)}% tax · ` : ""}new signups only</div>
          </div>
          <div className="mbr-set">
            <div className="mbr-k">STRIKE FINE</div>
            <div className="mbr-v">{s?.fineCents != null ? `$${(s.fineCents / 100).toFixed(s.fineCents % 100 ? 2 : 0)}` : "—"}
              {isAdmin && s?.fineCents != null && <button className="mbr-link" data-testid="edit-fine" onClick={() => setDlg("fine")}>Edit</button>}
            </div>
            <div className="mbr-sub" data-testid="fine-tax">{strikeFineTaxLine(s?.taxRatePct ?? null)}</div>
          </div>
          <span className="mbr-sp" />
          <div className="mbr-set">
            <div className="mbr-k">MEMBERS</div>
            <div className="mbr-v">{s ? s.payingCount : "—"}</div>
            <div className="mbr-sub">paying this month</div>
          </div>
          {s?.errors?.length ? <div className="mbr-err" role="alert">Could not read {s.errors.join("; ")}</div> : null}
        </div>

        <div className="mbr-tabs">
          {TABS.map((t) => (
            <button key={t.tab} className={`mbr-tab${tab === t.tab && q.trim().length < SEARCH_MIN ? " on" : ""}`} data-testid={`tab-${t.tab}`}
              onClick={() => { setTab(t.tab); setPage(1); setQ(""); }}>
              {t.label}<span>{list ? list.counts[t.tab].toLocaleString() : "…"}</span>
            </button>
          ))}
          <span className="mbr-sp" />
          <input className="mbr-search" data-testid="members-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search all cities: name, email or phone" aria-label="Search members in every city" />
        </div>

        {loadErr && <div className="mbr-err" role="alert">{loadErr}</div>}

        {q.trim().length >= SEARCH_MIN ? (
          <div className="mbr-card" data-testid="search-results">
            {/* ONLY RESULTS FOR THE TEXT ON SCREEN ARE CLICKABLE. While a new search is in flight the
              * old hits are not shown: clicking one opened the previous query's member. */}
            <div className="mbr-qline" data-testid="search-summary">{searchFresh ? search!.summary : "Searching…"}</div>
            {searchFresh && search!.rows.length === 0 && <div className="mbr-empty">No member matches “{q.trim()}” in any city.</div>}
            {searchFresh && search!.rows.map((r) => (
              <button key={r.membershipId} className={`mbr-hit${sel?.membershipId === r.membershipId ? " sel" : ""}`} data-testid="search-hit" onClick={() => setSel(r)}>
                <span className="mbr-who"><b>{r.name}</b>{r.chip && <ChipView c={r.chip} />}<small>{r.email ?? "—"}</small></span>
                <span className={`mbr-chip ${r.city === city ? "city" : "info"}`} data-testid="search-city">{r.cityName}</span>
                <span className="mbr-hnext">{[r.next.main, r.next.sub].filter(Boolean).join(" · ")}</span>
              </button>
            ))}
            <div className="mbr-note">Search always covers every city and every status. Clicking a result opens their panel without changing the city you&apos;re on.</div>
          </div>
        ) : (
          <div className="mbr-card" data-testid="members-table">
            <div className="mbr-tr mbr-th">
              <span className="c-m">MEMBER</span><span className="c-p">PHONE</span><span className="c-s">SINCE</span>
              <span className="c-n">NEXT</span><span className="c-k">STRIKES</span><span className="c-o">OWED</span><span className="c-c" />
            </div>
            {list && list.rows.length === 0 && <div className="mbr-empty" data-testid="members-empty">No members on this tab in {cityName}.</div>}
            {list?.rows.map((r) => (
              <button key={r.membershipId} className={`mbr-tr${sel?.membershipId === r.membershipId ? " sel" : ""}`} data-testid="member-row" onClick={() => setSel(r)}>
                <span className="c-m"><span className="mbr-nm"><b>{r.name}</b>{r.chip && <ChipView c={r.chip} />}</span><small>{r.email ?? "—"}</small></span>
                <span className="c-p">{r.phone ?? "—"}</span>
                <span className="c-s">{dateCT(r.activationDate)}<small>{r.days != null ? `${r.days} days` : ""}</small></span>
                <span className={`c-n t-${r.next.tone}`}>{r.next.main}{r.next.sub && <small>{r.next.sub}</small>}</span>
                <span className={`c-k${r.strikePoints > 0 ? " hot" : " dim"}`}>{strikesLabel(r.strikePoints)}</span>
                <span className={`c-o${r.absentOwed > 0 ? "" : " dim"}`}>{owedLabel(r.absentOwed)}</span>
                <span className="c-c" title={r.hasComment ? "Has a comment" : undefined}>{r.hasComment ? "💬" : ""}</span>
              </button>
            ))}
            {list && (
              <div className="mbr-foot">
                <span>{list.total ? `Showing ${(list.page - 1) * 25 + 1}–${Math.min(list.page * 25, list.total)} of ${list.total.toLocaleString()}` : "Showing 0"}</span>
                <span className="mbr-sp" />
                <button className="mbr-pg" disabled={list.page <= 1} onClick={() => setPage(list.page - 1)} aria-label="Previous page">‹</button>
                <span>{list.page} of {list.pages}</span>
                <button className="mbr-pg" disabled={list.page >= list.pages} onClick={() => setPage(list.page + 1)} aria-label="Next page">›</button>
              </div>
            )}
          </div>
        )}
        <p className="mbr-fine">
          {list?.source === "mirror" ? `From our copy of MatchDay's member list, synced ${list.syncedAt ? `${dayCT(list.syncedAt)} ${new Date(list.syncedAt).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT` : "at an unknown time"}. ` : list ? "Read live from the staging member list. " : ""}
          The list knows prices in whole dollars only; a member at the city plan&apos;s dollars is shown at the plan price, and the panel shows each member&apos;s exact amount.
        </p>
      </div>

      {sel && <MemberPanel key={sel.membershipId} row={sel} canMember={canMember} canManage={canManage} onClose={() => setSel(null)} onResult={afterWrite} />}

      {dlg === "plan" && s && <PlanDialog city={city} cityName={cityName} settings={s} currentMembers={list?.counts.current ?? 0} onClose={() => setDlg(null)} onResult={(r) => { setDlg(null); afterWrite(r); }} />}
      {dlg === "fine" && s && <FineDialog city={city} cityName={cityName} settings={s} onClose={() => setDlg(null)} onResult={(r) => { setDlg(null); afterWrite(r); }} />}
      {result && <ResultDialog r={result} onClose={() => setResult(null)} />}
    </div>
  );
}

function ChipView({ c }: { c: NonNullable<Chip> }) {
  return <span className={`mbr-chip ${c.tone}`}>{c.label}</span>;
}

/* ═══ THE MEMBER PANEL (frame 1, right) ═══════════════════════════════════════════════════════ */
function MemberPanel({ row, canMember, canManage, onClose, onResult }: { row: ViewRow; canMember: boolean; canManage: boolean; onClose: () => void; onResult: (r: Result) => void }) {
  const [extras, setExtras] = useState<Extras | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | "price" | "end">(null);
  const [comment, setComment] = useState(row.comment ?? "");
  const [savingComment, setSavingComment] = useState(false);
  const past = row.status.toUpperCase() === "CANCELED";
  const [readKey, setReadKey] = useState(0); // bumped after a strike removal so the panel re-reads the player

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [p, x] = await Promise.all([
          authFetch(`/api/lookup/${ENV}?id=${row.userId}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? `player read HTTP ${r.status}`)))),
          authFetch(`/api/membership/members/${row.membershipId}?env=${ENV}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? `member read HTTP ${r.status}`)))),
        ]);
        if (!live) return;
        setProfile((p.profile ?? p) as Profile);
        setExtras(x as Extras);
        // THE COMMENT BOX IS NEVER FILLED FROM THE PLAYER READ. It comes from the list row, which
        // carries the stored comment whether or not the player read includes this membership.
      } catch (e) { if (live) setErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; };
  }, [row.userId, row.membershipId, readKey]);

  /* IS THIS MEMBERSHIP ON MATCHDAY'S PLAYER RECORD? The price and end routes key their read-back on
   * it, and GET /admin/players/{id} keeps only ACTIVE memberships with an unexpired period. */
  const onRecord = profile?.membership?.id === row.membershipId;
  const exactCents = onRecord ? profile?.membership?.price ?? null : null;
  const cancelling = row.status.toUpperCase() === "ACTIVE" && !!row.canceledAt;
  const pastDue = row.status.toUpperCase() === "PAST_DUE";
  const stripeEnd = extras ? (extras.stripe.found
    ? (extras.stripe.cancelAt ?? (extras.stripe.cancelAtPeriodEnd ? extras.stripe.currentPeriodEnd : null))
    : scheduledEnd(extras.stored ?? undefined)) : null;
  const scheduled = extras?.stripe.found ? !!(extras.stripe.cancelAt || extras.stripe.cancelAtPeriodEnd) : false;

  const blocked = !canMember ? "You do not hold EDIT MEMBERSHIPS."
    : !profile ? "Reading the player…"
    : !onRecord ? "MatchDay's player record does not include this membership (it only keeps current paid periods), so it can't be changed from here."
    : null;

  const saveComment = async () => {
    setSavingComment(true);
    try {
      const r = await authFetch(`/api/matchday/${ENV}/memberships/${row.membershipId}/comment`, {
        method: "PUT", body: JSON.stringify({ playerId: row.userId, comment, playerName: row.name, source: "Members" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onResult({ title: "Comment not saved", facts: [{ who: "MatchDay", state: "bad", text: j.error ?? `HTTP ${r.status}` }], allGood: false }); return; }
      const f = twoFacts("comment", j.row === "moved" ? "moved" : j.row === "unchanged" ? "unchanged" : "unknown", "absent", null);
      onResult(j.row === "unknown" ? { ...f, note: "MatchDay does not return this membership on the player record, so the saved comment could not be read back. Logged to Change Log as UNKNOWN." } : f);
    } finally { setSavingComment(false); }
  };
  const commentWhy = commentRefusal(comment, row.comment);

  return (
    <aside className="mbr-panel" data-testid="member-panel">
      <div className="mbr-ps">
        <div className="mbr-ph"><h2>{row.name}</h2><span className="mbr-sp" /><button className="mbr-x" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="mbr-sub2">{[row.email, row.phone].filter(Boolean).join(" · ")}</div>
        <div className="mbr-chips">
          {row.chip && <ChipView c={row.chip} />}
          {row.slug && <span className="mbr-chip muted">{row.slug}</span>}
          <span className="mbr-chip city">{row.cityName}</span>
          <a className="mbr-link" href={`/match-ops/player-lookup?id=${row.userId}`}>Open in Player Lookup →</a>
        </div>
      </div>

      <div className="mbr-ps">
        <div className="mbr-k">MEMBERSHIP</div>
        {err && <div className="mbr-err" role="alert">{err}</div>}
        {cancelling && (
          <div className="mbr-call warn" data-testid="cancel-callout">
            <b>Cancelled in the app on {dayCT(row.canceledAt)}</b>
            <span>
              {extras?.lastPaid ? `Last charge ${usd(extras.lastPaid.cents)} (incl. tax) on ${dayCT(extras.lastPaid.at)}` : "No paid charge on file"}
              {" · "}{stripeEnd ? `Ends ${dayCT(stripeEnd)}` : "End date not set yet"}
              {" · "}{stripeLine(extras, scheduled)}
            </span>
          </div>
        )}
        {pastDue && (
          <div className="mbr-call bad">
            <b>Payment failed{extras?.stored?.failedAt ? ` ${dayCT(extras.stored.failedAt)}` : ""}</b>
            <span>{extras?.stored?.failedAmountCents != null ? `${usd(extras.stored.failedAmountCents)} due` : "Amount not synced"}{extras?.stored?.nextRetryAt ? ` · Stripe retries ${dayCT(extras.stored.nextRetryAt)}` : " · no retry scheduled"}</span>
          </div>
        )}
        <Fact k="Price" v={exactCents != null ? `${usd(exactCents)}/mo (+ tax)` : row.priceDollars != null ? `$${row.priceDollars}/mo (+ tax), whole dollars` : "—"} />
        <Fact k="Member since" v={`${dateCT(row.activationDate)}${row.days != null ? ` · ${row.days} days` : ""}`} />
        {past && <Fact k="Ended" v={row.next.main.replace(/^Ended /, "")} />}
        <Fact k="Card" v={!extras ? "…" : extras.stripe.card ?? (extras.stripe.error ? "Stripe unreadable" : "—")} />
        <Fact k="Absent owed" v={row.absentOwed > 0 ? `$${row.absentOwed} · free spots marked no-show` : "—"} />
        {/* OUR INVOICE TABLES FIRST, THEN THE PLAYER READ — staging memberships are in neither of
          * our Stripe tables, and a comp is in neither place because it has no subscription. */}
        <Fact k="Stripe" v={(() => {
          const id = extras?.subscriptionId ?? profile?.membership?.stripeSubscriptionId ?? null;
          if (id) return <a className="mbr-link" href={`https://dashboard.stripe.com/subscriptions/${id}`} target="_blank" rel="noreferrer">{short(id)} ↗</a>;
          return extras && profile ? "No subscription on file" : "…";
        })()} />
      </div>

      <StrikesSection row={row} profile={profile} canManage={canManage}
        onResult={(r) => { setReadKey((k) => k + 1); onResult(r); }} />

      <div className="mbr-ps">
        <div className="mbr-kh"><span className="mbr-k">COMMENT</span><span className="mbr-sp" />
          <span className="mbr-meta">{extras?.comment.by ? `Saved by ${extras.comment.by.split("@")[0]} · ${dayCT(extras.comment.at)}` : row.comment ? "Saved before Clubhouse" : ""}</span>
        </div>
        <textarea className="mbr-ta" data-testid="comment-box" value={comment} maxLength={COMMENT_MAX} rows={3}
          disabled={!canMember || savingComment} onChange={(e) => setComment(e.target.value)} placeholder={canMember ? "Add a note for staff" : "No comment"} />
        {canMember && (
          <div className="mbr-row">
            <span className="mbr-hint">{comment.trim() && commentWhy && comment.trim() !== (row.comment ?? "").trim() ? commentWhy : ""}</span>
            <span className="mbr-sp" />
            <button className="mbr-btn sm" data-testid="comment-save" disabled={!!commentWhy || savingComment} title={commentWhy ?? undefined} onClick={saveComment}>
              {savingComment ? "Saving…" : "Save comment"}
            </button>
          </div>
        )}
      </div>

      {!past && (
        <div className="mbr-ps">
          <div className="mbr-k">ACTIONS</div>
          <div className="mbr-row">
            <button className="mbr-btn grow" data-testid="act-price" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setDlg("price")}>Change price</button>
          </div>
          <button className="mbr-btn danger full" data-testid="act-end" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setDlg("end")}>End membership now</button>
          <p className="mbr-fine">Ending now cancels in Stripe immediately with no refund. To follow the 5th rule, use the app.</p>
          {blocked && profile && <p className="mbr-fine" data-testid="actions-blocked">{blocked}</p>}
        </div>
      )}

      {dlg === "price" && profile?.membership && (
        <PriceDialog row={row} current={profile.membership.price} onClose={() => setDlg(null)} onResult={(r) => { setDlg(null); onResult(r); }} />
      )}
      {dlg === "end" && (
        <EndDialog row={row} cancelling={cancelling} end={stripeEnd} onClose={() => setDlg(null)} onResult={(r) => { setDlg(null); onResult(r); }} />
      )}
    </aside>
  );
}

/* WHAT STRIPE SAID, AND ONLY WHAT IT SAID. "Not scheduled" is a claim about a subscription we read;
 * with no id on file nothing was read, and the line says that instead (staging, or a member with no
 * paid invoice in our tables). */
function stripeLine(extras: Extras | null, scheduled: boolean): string {
  if (!extras) return "reading Stripe…";
  if (!extras.subscriptionId) return "Stripe not checked (no subscription id on file)";
  if (extras.stripe.error) return "Stripe unreadable";
  if (!extras.stripe.found) return `Stripe has no subscription ${extras.subscriptionId}`;
  return scheduled ? "Stripe scheduled ✓" : "Stripe not scheduled yet (set when the next invoice is paid)";
}

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id);

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="mbr-fact"><span>{k}</span><b>{v}</b></div>;
}

/* ── STRIKES — the list, with Remove behind STRIKE_BACKEND_FIX_LIVE and MANAGE PLAYERS ──────────────
 * Remove goes through the existing strikes route (the one Player Lookup uses): MANAGE PLAYERS, a
 * required reason, and the route's own read-back. Off when the switch is off; the route refuses then
 * too, before any MatchDay call. */
function StrikesSection({ row, profile, canManage, onResult }: { row: ViewRow; profile: Profile | null; canManage: boolean; onResult: (r: Result) => void }) {
  const st = profile?.strikes;
  const logs = (st?.logs ?? []).filter((l) => l.penaltyPoint > 0 || l.active);
  const [pending, setPending] = useState<StrikeLog | null>(null);
  return (
    <div className="mbr-ps" data-testid="strikes">
      <div className="mbr-kh"><span className="mbr-k">STRIKES</span><span className="mbr-sp" />
        <span className="mbr-meta">{st ? `${st.activeCount} of ${STRIKE_LIMIT}${st.expiredAt && st.activeCount > 0 ? ` · resets ${dayCT(st.expiredAt)}` : ""}${st.isSuspended && st.suspendedTo ? ` · suspended to ${dayCT(st.suspendedTo)}` : ""}` : strikesLabel(row.strikePoints)}</span>
      </div>
      {!profile && <div className="mbr-fine">Reading strikes…</div>}
      {profile && logs.length === 0 && <div className="mbr-fine">No strikes.</div>}
      {logs.map((l, i) => {
        const ctl = membersStrikeControl(strikeControl({ id: l.id, penaltyPoint: l.penaltyPoint, active: l.active }, st?.expiredAt ?? null));
        const why = l.reason ? strikeReasonLabel(l.reason) : "Strike";
        const blocked = !ctl.enabled ? ctl.why : !canManage ? "Removing a strike needs MANAGE PLAYERS" : null;
        return (
          <div key={l.id ?? i} className="mbr-strike" data-testid="strike-row">
            <span className="mbr-who"><b>{why}{l.hoursBefore != null && l.reason === "CANCEL_W_IN_SOME_HOURS" ? ` (${fmtHours(l.hoursBefore)} before)` : ""}</b>
              <small>{[l.matchName, l.when ? dateCT(l.when) : null].filter(Boolean).join(" · ")}</small></span>
            <span className="mbr-sp" />
            <b className="mbr-pts">+{l.penaltyPoint}</b>
            <button className="mbr-link" data-testid="strike-remove" disabled={!ctl.enabled || !canManage} title={blocked ?? undefined}
              onClick={() => setPending(l)}>{ctl.label}</button>
          </div>
        );
      })}
      {!STRIKE_BACKEND_FIX_LIVE && logs.length > 0 && <p className="mbr-fine" data-testid="strike-off">{STRIKE_REMOVE_OFF_REASON}</p>}
      {pending && st && (
        <StrikeRemoveDialog row={row} log={pending} activeCount={st.activeCount} isSuspended={st.isSuspended}
          onClose={() => setPending(null)} onResult={(r) => { setPending(null); onResult(r); }} />
      )}
    </div>
  );
}

function StrikeRemoveDialog({ row, log, activeCount, isSuspended, onClose, onResult }: {
  row: ViewRow; log: StrikeLog; activeCount: number; isSuspended: boolean; onClose: () => void; onResult: (r: Result) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const eff = removalEffect(activeCount, log.penaltyPoint, isSuspended, STRIKE_LIMIT);
  const go = async () => {
    if (!reason.trim() || log.id == null) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/matchday/${ENV}/strikes/${log.id}`, {
        method: "DELETE",
        body: JSON.stringify({ playerId: row.userId, userMatchId: log.userMatchId, reason: reason.trim(), playerName: row.name, source: "Members" }),
      });
      const j = await r.json().catch(() => ({}));
      onResult(strikeRemoveFacts(r.ok, j));
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`Remove ${row.name}'s strike?`} onClose={onClose} testid="strike-dialog">
      <div className="mbr-box">{eff.sentence}</div>
      <label className="mbr-lbl">Reason (required)</label>
      <input className="mbr-in" data-testid="strike-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this penalty is being reversed" autoFocus />
      {!reason.trim() && <p className="mbr-fine" data-testid="strike-why">A reason is required.</p>}
      <div className="mbr-acts"><button className="mbr-btn" onClick={onClose}>Keep it</button>
        <button className="mbr-btn dark" data-testid="strike-go" disabled={!reason.trim() || busy} onClick={go}>{busy ? "Removing…" : "Remove strike"}</button></div>
    </Modal>
  );
}
const fmtHours = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${m % 60}m`; };

/* ═══ DIALOGS ═══════════════════════════════════════════════════════════════════════════════════ */
function Modal({ title, children, onClose, testid }: { title: string; children: React.ReactNode; onClose: () => void; testid: string }) {
  return (
    <div className="mbr-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mbr-modal" role="dialog" aria-modal="true" aria-label={title} data-testid={testid}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Change one member's price — the existing Player Lookup route and its two-fact read-back. */
function PriceDialog({ row, current, onClose, onResult }: { row: ViewRow; current: number | null; onClose: () => void; onResult: (r: Result) => void }) {
  const [v, setV] = useState(current != null ? dollarsFromCents(current) : "");
  const [busy, setBusy] = useState(false);
  const cents = centsFromDollars(v);
  const why = cents == null ? "Enter dollars and cents, like 59.00." : priceRefusal({ id: row.membershipId, statusRaw: row.status, stripeSubscriptionId: null, canceledAt: row.canceledAt, price: current }, cents);
  const go = async () => {
    if (why || cents == null) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/matchday/${ENV}/memberships/${row.membershipId}/price`, { method: "PATCH", body: JSON.stringify({ playerId: row.userId, cents, playerName: row.name, source: "Members" }) });
      const j = await r.json().catch(() => ({}));
      onResult(r.ok ? factsFromVerdict("price", j, { cents }) : { title: "Price not changed", facts: [{ who: "MatchDay", state: j.ambiguous ? "unknown" : "bad", text: j.error ?? `HTTP ${r.status}` }], allGood: false });
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`${row.name}'s price`} onClose={onClose} testid="price-dialog">
      <label className="mbr-lbl">Monthly price before tax</label>
      <input className="mbr-in" data-testid="price-input" value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" autoFocus />
      <div className="mbr-box">From the next charge. The current month is not re-charged or refunded (Stripe proration off).</div>
      <p className="mbr-fine" data-testid="price-why">{v.trim() ? why ?? `Sends ${cents} cents.` : ""}</p>
      <div className="mbr-acts"><button className="mbr-btn" onClick={onClose}>Cancel</button>
        <button className="mbr-btn dark" data-testid="price-go" disabled={!!why || busy} onClick={go}>{busy ? "Saving…" : "Save price"}</button></div>
    </Modal>
  );
}

/** End now — frame 4. A reason is required; immediate, no refund, said in words. */
const END_REASONS = ["Requested by player", "Moving", "Duplicate membership", "Payment issue", "Staff account", "Removed for conduct"];
function EndDialog({ row, cancelling, end, onClose, onResult }: { row: ViewRow; cancelling: boolean; end: string | null; onClose: () => void; onResult: (r: Result) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const why = endRefusal({ id: row.membershipId, statusRaw: row.status, stripeSubscriptionId: null, canceledAt: row.canceledAt, price: null }, reason);
  const go = async () => {
    if (why) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/matchday/${ENV}/memberships/${row.membershipId}/end`, { method: "POST", body: JSON.stringify({ playerId: row.userId, reason: reason.trim(), playerName: row.name, source: "Members" }) });
      const j = await r.json().catch(() => ({}));
      onResult(r.ok ? factsFromVerdict("end", j, { reason }) : { title: "Membership not ended", facts: [{ who: "MatchDay", state: j.ambiguous ? "unknown" : "bad", text: j.error ?? `HTTP ${r.status}` }], allGood: false });
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`End ${row.name}'s membership now?`} onClose={onClose} testid="end-dialog">
      <div className="mbr-box bad">{endConfirmCopy(row.name, cancelling, end)}</div>
      <label className="mbr-lbl">Reason (required)</label>
      <input className="mbr-in" data-testid="end-reason" list="mbr-end-reasons" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Pick or type a reason" autoFocus />
      <datalist id="mbr-end-reasons">{END_REASONS.map((x) => <option key={x} value={x} />)}</datalist>
      {!reason.trim() && <p className="mbr-fine" data-testid="end-why">A reason is required.</p>}
      <div className="mbr-acts"><button className="mbr-btn" onClick={onClose}>Keep it</button>
        <button className="mbr-btn dangerfill" data-testid="end-go" disabled={!!why || busy} onClick={go}>{busy ? "Ending…" : "End now"}</button></div>
    </Modal>
  );
}

/** City member price — frame 2. New signups only. */
function PlanDialog({ city, cityName, settings, currentMembers, onClose, onResult }: { city: string; cityName: string; settings: Settings; currentMembers: number; onClose: () => void; onResult: (r: Result) => void }) {
  const [v, setV] = useState(settings.planCents != null ? dollarsFromCents(settings.planCents) : "");
  const [busy, setBusy] = useState(false);
  const cents = centsFromDollars(v);
  const why = planPriceRefusal(cents, settings.planCents);
  const go = async () => {
    if (why || cents == null) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/matchday/${ENV}/memberships/city/${city}/price`, { method: "POST", body: JSON.stringify({ cents }) });
      const j = await r.json().catch(() => ({}));
      onResult(r.ok && j.facts ? j.facts : { title: "Member price not changed", facts: [{ who: "MatchDay", state: j.ambiguous ? "unknown" : "bad", text: j.error ?? `HTTP ${r.status}` }], allGood: false });
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`${cityName} member price`} onClose={onClose} testid="plan-dialog">
      <label className="mbr-lbl">Monthly price before tax</label>
      <input className="mbr-in" data-testid="plan-input" value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" autoFocus />
      <div className="mbr-box">New signups only. The {currentMembers.toLocaleString()} current members keep their price. To change one member, use Change price on their panel.</div>
      <p className="mbr-fine">Was {settings.planCents != null ? usd(settings.planCents) : "—"}{settings.taxRatePct ? ` · plus ${trimPct(settings.taxRatePct)}% tax` : ""} · changes the Stripe plan for {cityName}</p>
      {v.trim() && why && <p className="mbr-fine bad" data-testid="plan-why">{why}</p>}
      <div className="mbr-acts"><button className="mbr-btn" onClick={onClose}>Cancel</button>
        <button className="mbr-btn dark" data-testid="plan-go" disabled={!!why || busy} onClick={go}>{busy ? "Saving…" : "Save price"}</button></div>
    </Modal>
  );
}

/** City strike fine — whole dollars, $1 to $100, validated here and on the server. */
function FineDialog({ city, cityName, settings, onClose, onResult }: { city: string; cityName: string; settings: Settings; onClose: () => void; onResult: (r: Result) => void }) {
  const [v, setV] = useState(settings.fineCents != null ? String(Math.round(settings.fineCents / 100)) : "");
  const [busy, setBusy] = useState(false);
  const { why } = strikeFineRefusal(v, settings.fineCents);
  const go = async () => {
    if (why) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/matchday/${ENV}/memberships/city/${city}/strike-fine`, { method: "POST", body: JSON.stringify({ dollars: v.trim() }) });
      const j = await r.json().catch(() => ({}));
      onResult(r.ok && j.facts ? j.facts : { title: "Strike fine not changed", facts: [{ who: "MatchDay", state: j.ambiguous ? "unknown" : "bad", text: j.error ?? `HTTP ${r.status}` }], allGood: false });
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`${cityName} strike fine`} onClose={onClose} testid="fine-dialog">
      <label className="mbr-lbl">Fine in whole dollars</label>
      <input className="mbr-in" data-testid="fine-input" value={v} onChange={(e) => setV(e.target.value)} inputMode="numeric" autoFocus />
      <div className="mbr-box">What a suspended player pays to clear their strikes and suspension. Charged at the amount current when they pay; {strikeFineTaxLine(settings.taxRatePct).split(" · ")[0]}.</div>
      {v.trim() && why && <p className="mbr-fine bad" data-testid="fine-why">{why}</p>}
      <div className="mbr-acts"><button className="mbr-btn" onClick={onClose}>Cancel</button>
        <button className="mbr-btn dark" data-testid="fine-go" disabled={!!why || busy} onClick={go}>{busy ? "Saving…" : "Save fine"}</button></div>
    </Modal>
  );
}

/** Frame 5 — two facts, never one verdict. */
function ResultDialog({ r, onClose }: { r: Result; onClose: () => void }) {
  return (
    <Modal title={r.title} onClose={onClose} testid="result-dialog">
      {r.facts.map((f) => (
        <div key={f.who} className={`mbr-factbox ${f.state}`} data-testid={`fact-${f.who.toLowerCase()}`} data-state={f.state}>
          <span className="mbr-tick">{f.state === "ok" ? "✓" : f.state === "absent" ? "–" : f.state === "unknown" ? "?" : "✕"}</span>
          <span className="mbr-who"><b>{f.who}</b><small>{f.text}</small></span>
        </div>
      ))}
      <p className="mbr-fine">{r.note ?? (r.allGood ? "Logged to Change Log." : "Logged to Change Log. Anything marked ✕ or ? needs a look by hand.")}</p>
      <div className="mbr-acts"><button className="mbr-btn dark" data-testid="result-done" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

/* ═══ STYLE — frame 1's tokens ═════════════════════════════════════════════════════════════════ */
const CSS = [
  ".mbr{display:flex;gap:18px;align-items:flex-start;color:#0b2e22;font-size:13px}",
  ".mbr-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:16px;max-width:820px}",
  ".mbr-head{display:flex;gap:10px;align-items:center}",
  ".mbr-head h1{font-size:22px;font-weight:700;margin:0}",
  ".mbr-sp{flex:1 1 auto}",
  ".mbr-city{background:#fff;border:1px solid #e0e0db;border-radius:8px;padding:7px 10px;font-weight:600;font-size:13px;color:#0b2e22}",
  ".mbr-env{font-size:11px;font-weight:600;background:#fff4cf;color:#8a6a12;border-radius:10px;padding:3px 8px}",
  ".mbr-btn{background:#fff;border:1px solid #e0e0db;border-radius:8px;padding:8px 14px;font-weight:600;font-size:13px;color:#0b2e22;cursor:pointer}",
  ".mbr-btn:disabled{opacity:.45;cursor:not-allowed}",
  ".mbr-btn.dark{background:#063d2c;border-color:#063d2c;color:#fff}",
  ".mbr-btn.danger{border-color:#f0c4bd;color:#a33a2a}",
  ".mbr-btn.dangerfill{background:#a33a2a;border-color:#a33a2a;color:#fff}",
  ".mbr-btn.sm{padding:6px 12px;font-size:12px}",
  ".mbr-btn.grow{flex:1 1 0}",
  ".mbr-btn.full{width:100%}",
  ".mbr-link{background:none;border:0;padding:0;color:#16794a;font-weight:600;font-size:12px;cursor:pointer;text-decoration:none}",
  ".mbr-link:disabled{color:#8aa59a;cursor:not-allowed}",
  ".mbr-settings{display:flex;gap:28px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid #e0e0db;border-radius:12px;padding:14px 16px}",
  ".mbr-set{display:flex;flex-direction:column;gap:3px}",
  ".mbr-k{font-size:10px;font-weight:600;letter-spacing:.6px;color:#8aa59a}",
  ".mbr-v{font-size:16px;font-weight:700;display:flex;gap:8px;align-items:center}",
  ".mbr-sub{font-size:11px;color:#5d7a6f}",
  ".mbr-sub2{font-size:12px;color:#5d7a6f}",
  ".mbr-tabs{display:flex;gap:6px;align-items:center;flex-wrap:nowrap}",
  ".mbr-tab{flex:none;white-space:nowrap;display:flex;gap:6px;align-items:center;background:#fff;border:1px solid #e0e0db;border-radius:20px;padding:7px 12px;font-weight:600;font-size:13px;color:#0b2e22;cursor:pointer}",
  ".mbr-tab span{font-weight:500;font-size:12px;color:#5d7a6f}",
  ".mbr-tab.on{background:#063d2c;border-color:#063d2c;color:#fff}",
  ".mbr-tab.on span{color:#2cdb87}",
  ".mbr-search{flex:0 1 280px;min-width:180px;background:#fff;border:1px solid #e0e0db;border-radius:8px;padding:8px 12px;font-size:13px}",
  ".mbr-search:focus,.mbr-in:focus,.mbr-ta:focus{outline:none;border-color:#2cdb87}",
  ".mbr-card{background:#fff;border:1px solid #e0e0db;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}",
  ".mbr-tr{display:flex;align-items:center;padding:12px 16px;border:0;border-top:1px solid #e0e0db;background:#fff;text-align:left;font:inherit;color:inherit;cursor:pointer;width:100%}",
  ".mbr-tr:hover{background:#f6f8f7}",
  ".mbr-tr.sel{background:#f0fbf5;box-shadow:inset 3px 0 0 #2cdb87}",
  ".mbr-th{background:#eef2ef;border-top:0;padding:10px 16px;cursor:default;font-size:10px;font-weight:600;letter-spacing:.6px;color:#8aa59a}",
  ".mbr-th:hover{background:#eef2ef}",
  ".mbr-tr>span{display:flex;flex-direction:column;gap:2px;overflow:hidden}",
  ".mbr-tr small,.mbr-who small{font-size:11px;color:#5d7a6f;font-weight:400}",
  ".mbr-tr .c-m small{font-size:12px}",
  ".mbr-tr>span>small,.mbr-tr .mbr-nm b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
  ".mbr-tr .c-m{padding-right:12px;box-sizing:border-box}",
  ".c-m{width:240px;flex:none}.c-p{width:120px;flex:none}.c-s{width:110px;flex:none}.c-n{width:120px;flex:none}.c-k{width:70px;flex:none}.c-o{width:60px;flex:none}.c-c{flex:1 1 auto}",
  ".mbr-nm{display:flex;gap:6px;align-items:center}",
  ".mbr-nm b,.mbr-who b{font-weight:600}",
  ".dim{color:#8aa59a}.hot{color:#a33a2a;font-weight:600}",
  ".t-warn{color:#8a6a12}.t-bad{color:#a33a2a;font-weight:600}.t-muted{color:#5d7a6f}",
  ".mbr-chip{display:inline-block;border-radius:10px;padding:3px 8px;font-size:11px;font-weight:600;white-space:nowrap}",
  ".mbr-chip.warn{background:#fff4cf;color:#8a6a12}.mbr-chip.bad{background:#fdecea;color:#a33a2a}",
  ".mbr-chip.info{background:#e6f4ff;color:#1f5f99}.mbr-chip.muted{background:#eef2ef;color:#5d7a6f}",
  ".mbr-chip.city{background:#e6efea;color:#16794a}",
  ".mbr-foot{display:flex;gap:8px;align-items:center;padding:10px 16px;border-top:1px solid #e0e0db;font-size:12px;color:#5d7a6f}",
  ".mbr-pg{background:none;border:0;font-size:14px;color:#5d7a6f;cursor:pointer;padding:0 4px}",
  ".mbr-pg:disabled{opacity:.35;cursor:default}",
  ".mbr-empty{padding:18px 16px;color:#5d7a6f;border-top:1px solid #e0e0db}",
  ".mbr-qline{padding:12px 16px;font-size:12px;color:#5d7a6f}",
  ".mbr-hit{display:flex;gap:12px;align-items:center;padding:12px 16px;border:0;border-top:1px solid #e0e0db;background:#fff;font:inherit;color:inherit;text-align:left;cursor:pointer;width:100%}",
  ".mbr-hit:hover{background:#f6f8f7}.mbr-hit.sel{background:#f0fbf5}",
  ".mbr-hit .mbr-who{flex:1 1 auto;display:flex;flex-wrap:wrap;gap:2px 6px;align-items:center}",
  ".mbr-hit .mbr-who small{flex-basis:100%;font-size:12px}",
  ".mbr-hnext{font-size:12px;color:#5d7a6f;white-space:nowrap}",
  ".mbr-note{padding:10px 16px 12px;font-size:12px;color:#5d7a6f}",
  ".mbr-fine{font-size:11px;color:#5d7a6f;margin:0}",
  ".mbr-fine.bad{color:#a33a2a}",
  ".mbr-err{background:#fdecea;color:#a33a2a;border-radius:8px;padding:8px 12px;font-size:12px}",
  ".mbr-panel{width:400px;flex:none;background:#fff;border:1px solid #e0e0db;border-radius:12px;overflow:hidden;position:sticky;top:12px;max-height:calc(100vh - 24px);overflow-y:auto}",
  ".mbr-ps{padding:16px 20px;display:flex;flex-direction:column;gap:10px;border-top:1px solid #e0e0db}",
  ".mbr-ps:first-child{border-top:0}",
  ".mbr-ph{display:flex;align-items:center;gap:8px}.mbr-ph h2{font-size:18px;font-weight:700;margin:0}",
  ".mbr-x{background:none;border:0;font-size:14px;color:#5d7a6f;cursor:pointer}",
  ".mbr-chips{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
  ".mbr-call{border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;font-size:12px}",
  ".mbr-call b{font-size:13px;font-weight:600}",
  ".mbr-call.warn{background:#fff4cf;color:#8a6a12}.mbr-call.bad{background:#fdecea;color:#a33a2a}",
  ".mbr-fact{display:flex;font-size:13px}.mbr-fact>span{width:120px;flex:none;color:#5d7a6f}.mbr-fact>b{font-weight:500}",
  ".mbr-kh{display:flex;align-items:center;gap:8px}",
  ".mbr-meta{font-size:11px;color:#8aa59a}",
  ".mbr-strike{display:flex;align-items:center;gap:8px;background:#f6f8f7;border-radius:8px;padding:10px 12px}",
  ".mbr-strike .mbr-who{display:flex;flex-direction:column;gap:2px}",
  ".mbr-pts{color:#a33a2a;font-weight:700}",
  ".mbr-ta{width:100%;box-sizing:border-box;border:1px solid #e0e0db;border-radius:8px;padding:10px 12px;font:inherit;font-size:13px;resize:vertical}",
  ".mbr-row{display:flex;gap:8px;align-items:center}",
  ".mbr-hint{font-size:11px;color:#a33a2a}",
  ".mbr-scrim{position:fixed;inset:0;background:rgba(6,61,44,.28);display:flex;align-items:center;justify-content:center;z-index:60;padding:16px}",
  ".mbr-modal{background:#fff;border:1px solid #e0e0db;border-radius:14px;padding:22px 24px;width:440px;max-width:100%;display:flex;flex-direction:column;gap:16px;box-sizing:border-box}",
  ".mbr-modal h3{font-size:17px;font-weight:700;margin:0}",
  ".mbr-lbl{font-size:12px;font-weight:600;color:#5d7a6f;margin-bottom:-10px}",
  ".mbr-in{border:1px solid #e0e0db;border-radius:8px;padding:9px 12px;font-size:13px}",
  ".mbr-box{background:#eef2ef;border-radius:8px;padding:10px 12px;font-size:12px}",
  ".mbr-box.bad{background:#fdecea;color:#a33a2a}",
  ".mbr-acts{display:flex;gap:8px;justify-content:flex-end}",
  ".mbr-factbox{display:flex;gap:10px;align-items:center;border-radius:8px;padding:10px 12px;background:#e8f8ef}",
  ".mbr-factbox.bad{background:#fdecea}.mbr-factbox.unknown{background:#fff4cf}.mbr-factbox.absent{background:#eef2ef}",
  ".mbr-factbox .mbr-who{display:flex;flex-direction:column;gap:2px}",
  ".mbr-tick{font-weight:700;color:#16794a;width:12px}.mbr-factbox.bad .mbr-tick{color:#a33a2a}.mbr-factbox.unknown .mbr-tick{color:#8a6a12}",
  "@media (max-width:1100px){.mbr{flex-direction:column}.mbr-panel{width:100%;position:static;max-height:none}.mbr-main{max-width:none;width:100%}}",
].join("\n");
