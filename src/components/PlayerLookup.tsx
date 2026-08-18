"use client";

// Player Lookup (Phase 18) — one player, everything we can honestly show: account,
// membership and match history, with Add-to-a-match and Remove under EDIT MATCHES.
// Built from lookup-v2.html, but deliberately NARROWER than the mockup: the STRIKES,
// PAYMENTS and ACCOUNT-HISTORY panels are NOT built. An empty Payments panel on a
// page someone opens during a payment dispute reads as "this player has no payments" —
// a false negative worse than the panel not existing. A short footer says which panels
// are absent so nobody reads absence as zero.
//
// Reads go through /api/lookup/{env}; the two WRITES reuse the existing guarded roster
// route (/api/matchday/{env}/roster/{matchId}) so there is one write path with the
// EDIT MATCHES gate, deny-lists and recordWrite already on it. canEdit here is only a
// courtesy gate — the server refuses regardless (zero-network 403 for read-only users).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth, canEditMatches, canManagePlayers, canEditCredits } from "@/lib/useAuth";
import { validateAdjustment, fmtUsd, MAX_ADJUSTMENT_CENTS, REASON_REQUIRED } from "@/lib/creditsModel";
import { useDockSubject } from "@/lib/useDockSubject";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { envBadge } from "@/lib/matchEnvBadge";
import {
  detectKind, SEARCH_HINT, money, openSpots as openSpotsOf, suggestSpot, STRIKE_LIMIT, strikeReasonLabel, isKnownStrikeReason,
  type SpotTeam, type SearchKind,
} from "@/lib/playerLookupModel";

const ENV = FULL_EDITOR_ENV;

// Per-screen dock snippets (Phase 19 Step 3b) — the lines worth saying while you have a player's
// account open. Static to this screen; clicking one inserts into the docked chat's draft.
const LOOKUP_SNIPPETS = [
  "Can you confirm the email on your account?",
  "I'm looking at your account now — one moment.",
  "Which city are you playing in?",
];

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

// ---- types (mirror the lookup route) ----
type SearchRow = { id: number; name: string; email: string | null; phone: string | null; city: string | null; status: "expelled" | "suspended" | "ok"; hasMembership: boolean };
type MatchRow = { umId: number; matchId: number; name: string; startDate: string | null; startDateUtc: string | null; team: number | null; num: number | null; price: number; charged: number | null; userStatus: string | null; state: "upcoming" | "played" | "cancelled"; removable: boolean };
type MatchBucket = "all" | "upcoming" | "played" | "noshow" | "cancelled";
// Single source of truth for the header facts AND the filter chips, so they can never
// disagree. state partitions into upcoming/played/cancelled; no-show is carved out of
// played (a no-show is not "played"), keeping the four buckets summing to the total.
function bucketOf(m: MatchRow): Exclude<MatchBucket, "all"> {
  if (m.state === "cancelled") return "cancelled";
  if (m.state === "upcoming") return "upcoming";
  return m.userStatus === "NO_SHOW" ? "noshow" : "played";
}
function matchCounts(ms: MatchRow[]) {
  const c = { all: ms.length, upcoming: 0, played: 0, noshow: 0, cancelled: 0 };
  for (const m of ms) c[bucketOf(m)]++;
  return c;
}
type Membership = { status: string; number: string | null; since: string | null; renews: string | null; canceledAt: string | null; price: number | null; city: string | null } | null;
type StrikeLog = { penaltyPoint: number; active: boolean; reason: string | null; matchName: string | null; when: string | null; issued: string | null; canceledAt: string | null; hoursBefore: number | null };
type Strikes = { activeCount: number; limit: number; isSuspended: boolean; suspendedTo: string | null; expiredAt: string | null; firstStrikeAt: string | null; logs: StrikeLog[] };
type HistoryRow = { action: "suspend" | "expel"; reason: string | null; when: string | null; until: string | null; by: string | null };
type Profile = {
  player: {
    id: number; name: string; email: string | null; phone: string | null; phoneVerified: boolean; city: string | null;
    level: number | null; registered: string | null; goals: number; cityManager: boolean; credits: number;
    status: "expelled" | "suspended" | "ok"; banReason: string | null; bannedAt: string | null; banExpiredAt: string | null;
    matchesPlayed: number; upcoming: number;
  };
  membership: Membership;
  matches: MatchRow[];
  strikes: Strikes;
  accountHistory: HistoryRow[];
};

// ---- optional facts, chosen by the operator (persisted) ----
const OPTIONAL = [
  { key: "uid", label: "Player ID", def: true },
  { key: "city", label: "Preferable city", def: true },
  { key: "level", label: "Soccer level", def: true },
  { key: "joined", label: "Registered", def: true },
  { key: "verified", label: "Phone verified", def: true },
  { key: "goals", label: "Goals scored", def: false },
  { key: "mgr", label: "City manager", def: false },
] as const;
type FieldKey = (typeof OPTIONAL)[number]["key"];
const FIELDS_LS = "pl-fields-v1";
const RECENT_LS = "pl-recent-v1";

function loadFields(): Record<FieldKey, boolean> {
  const base = Object.fromEntries(OPTIONAL.map((f) => [f.key, f.def])) as Record<FieldKey, boolean>;
  if (typeof window === "undefined") return base;
  try { const s = JSON.parse(localStorage.getItem(FIELDS_LS) || "{}"); for (const f of OPTIONAL) if (typeof s[f.key] === "boolean") base[f.key] = s[f.key]; } catch { /* default */ }
  return base;
}

// MatchDay stores wall-clock times labelled "Z" (startDate, activationDate, etc. are
// the local clock, not a true instant). Format in UTC so the printed date/time is the
// clock the API meant — and so a date-only midnight value never renders a day early in
// a negative-offset timezone.
const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const fmtWhen = (iso: string | null) => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
};
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function statusTags(r: { status: string; hasMembership?: boolean }): [string, string][] {
  const t: [string, string][] = [];
  if (r.status === "expelled") t.push(["expel", "EXPELLED"]);
  else if (r.status === "suspended") t.push(["susp", "SUSPENDED"]);
  if (r.hasMembership) t.push(["member", "MEMBER"]);
  return t;
}

export default function PlayerLookup() {
  const router = useRouter();
  const { appUser } = useAuth();
  const canEdit = canEditMatches(appUser);   // EDIT MATCHES — add/remove; server holds regardless
  const canManage = canManagePlayers(appUser); // MANAGE PLAYERS — suspend/expel/lift; independent
  // EDIT CREDITS — the only grant here that moves MONEY, and the only one not tied to Match Ops.
  // Courtesy only: the route re-reads the flag from the database on every request.
  const canCredit = canEditCredits(appUser);
  const badge = envBadge(ENV);

  const [q, setQ] = useState("");
  const [kind, setKind] = useState<SearchKind>("empty");
  const [results, setResults] = useState<SearchRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  const [fields, setFields] = useState<Record<FieldKey, boolean>>(() => (typeof window === "undefined" ? Object.fromEntries(OPTIONAL.map((f) => [f.key, f.def])) as Record<FieldKey, boolean> : loadFields()));
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [recent, setRecent] = useState<{ id: number; name: string }[]>([]);
  const [modal, setModal] = useState<{ type: "add" } | { type: "remove"; m: MatchRow } | { type: "suspend" | "expel" | "lift" } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => { try { setRecent(JSON.parse(localStorage.getItem(RECENT_LS) || "[]")); } catch { /* none */ } }, []);
  const showToast = useCallback((s: string) => { setToast(s); window.setTimeout(() => setToast(null), 3200); }, []);

  const setField = (k: FieldKey, on: boolean) => {
    setFields((prev) => { const next = { ...prev, [k]: on }; try { localStorage.setItem(FIELDS_LS, JSON.stringify(next)); } catch { /* ignore */ } return next; });
  };

  const runSearch = useCallback(async (raw: string) => {
    const d = detectKind(raw);
    setKind(d.kind);
    if (d.kind === "empty") { setResults(null); setSearchErr(null); return; }
    const my = ++seq.current;
    setSearching(true); setSearchErr(null);
    try {
      const res = await authFetch(`/api/lookup/${ENV}?q=${encodeURIComponent(raw.trim())}`);
      const j = await res.json();
      if (my !== seq.current) return; // a newer keystroke won
      if (!res.ok) { setSearchErr(j?.error || `Search failed (${res.status})`); setResults([]); return; }
      setResults((j.results ?? []) as SearchRow[]);
    } catch (e) { if (my === seq.current) { setSearchErr(e instanceof Error ? e.message : String(e)); setResults([]); } }
    finally { if (my === seq.current) setSearching(false); }
  }, []);

  // debounce keystrokes
  useEffect(() => {
    if (profile) return; // typing is handled in onChange (which closes the profile)
    const t = window.setTimeout(() => runSearch(q), 180);
    return () => window.clearTimeout(t);
  }, [q, profile, runSearch]);

  const openProfile = useCallback(async (id: number, name?: string) => {
    setLoadingProfile(true); setProfileErr(null); setProfile(null);
    try {
      const res = await authFetch(`/api/lookup/${ENV}?id=${id}`);
      const j = await res.json();
      if (!res.ok) { setProfileErr(j?.error || `Load failed (${res.status})`); return; }
      setProfile(j as Profile);
      const rec = [{ id, name: (j as Profile).player.name || name || `ID ${id}` }, ...recent.filter((r) => r.id !== id)].slice(0, 6);
      setRecent(rec); try { localStorage.setItem(RECENT_LS, JSON.stringify(rec)); } catch { /* ignore */ }
      window.scrollTo(0, 0);
    } catch (e) { setProfileErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoadingProfile(false); }
  }, [recent]);

  const reloadProfile = useCallback(() => { if (profile) openProfile(profile.player.id); }, [profile, openProfile]);

  // Phase 19 Step 3a/3b — tell the docked player-chat which player THIS screen is about (Banner B)
  // and the canned lines worth saying while looking a player up (snippets). Inert when nothing docked.
  useDockSubject(profile?.player.id ?? null, profile?.player.name ?? null, LOOKUP_SNIPPETS);

  const backToSearch = () => { setProfile(null); setProfileErr(null); };

  return (
    <div className="pl">
      <style>{CSS}</style>

      <div className="head">
        <div className="headtop">
          <div>
            <h1 className="h1">Player Lookup</h1>
            <p className="hsub">One player — account, membership and matches. Add them to a match or take them out.</p>
          </div>
          <span className={`livetag ${badge.tone}`}><span className="livedot" />{ENV === "production" ? "PRODUCTION" : "STAGING"} · {canEdit || canManage ? "LIVE EDITS" : "READ ONLY"}</span>
        </div>

        <div className="searchrow">
          <span className="sbox">
            <span className="sicon" aria-hidden>⌕</span>
            <input
              id="pl-q" type="search" autoComplete="off" aria-label="Search players"
              placeholder="Phone, email, name or player ID"
              value={q}
              onChange={(e) => { setQ(e.target.value); if (profile) setProfile(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && results && results.length === 1) openProfile(results[0].id); }}
            />
          </span>
          <span className="fieldswrap">
            <button className="btn" aria-expanded={fieldsOpen} onClick={() => setFieldsOpen((o) => !o)}>Fields</button>
            {fieldsOpen && (
              <>
                <span className="scrim-quiet" onClick={() => setFieldsOpen(false)} />
                <div className="pop" role="dialog" aria-label="Optional fields">
                  <h4>OPTIONAL FACTS</h4>
                  <p>Pick what you actually read. Saved on this device.</p>
                  {OPTIONAL.map((f) => (
                    <label key={f.key}>
                      <input type="checkbox" checked={fields[f.key]} onChange={(e) => setField(f.key, e.target.checked)} data-field={f.key} />
                      {f.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </span>
        </div>
        <p className="hint" id="pl-hint">{SEARCH_HINT[kind]}</p>
      </div>

      {/* ---------- SEARCH VIEW ---------- */}
      {!profile && !loadingProfile && (
        <div className="panel">
          <div className="ptitle">
            <h3>{kind === "empty" ? "RECENT LOOKUPS" : "RESULTS"}</h3>
            <span className="note">{searching ? "searching…" : kind === "empty" ? "" : results ? `${results.length} match${results.length === 1 ? "" : "es"}` : ""}</span>
          </div>
          <div className="reslist">
            {searchErr && <p className="empty" data-testid="search-err"><b>Search failed</b>{searchErr}</p>}
            {!searchErr && kind === "empty" && (
              recent.length
                ? recent.map((r) => (
                  <button key={r.id} className="res recent" data-pid={r.id} onClick={() => openProfile(r.id, r.name)}>
                    <span className="c-name"><span className="rn">{r.name}</span><span className="rid">ID {r.id}</span></span>
                    <span className="c-email"><span className="rt muted">reopen</span></span>
                  </button>
                ))
                : <p className="empty"><b>Search for a player</b>Type a phone, email, name or ID above.</p>
            )}
            {!searchErr && kind !== "empty" && results && results.length === 0 && !searching && (
              <p className="empty" data-testid="no-results"><b>No player found</b>Nothing matches that {kind}. Phone numbers match on digits only — try without the country code.</p>
            )}
            {!searchErr && kind !== "empty" && results && results.map((r) => (
              <button key={r.id} className="res" data-pid={r.id} onClick={() => openProfile(r.id, r.name)}>
                <span className="c-name"><span className="rn">{r.name}</span><span className="rid">ID {r.id}</span></span>
                <span className="c-email"><span className="rt">{r.email ?? "—"}</span></span>
                <span className="c-phone"><span className="rt mono">{r.phone ?? "—"}</span></span>
                <span className="c-city"><span className="rt">{r.city ?? "—"}</span></span>
                <span className="rtags">{statusTags(r).map(([c, l]) => <span key={l} className={`tag ${c}`}>{l}</span>)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---------- PROFILE VIEW ---------- */}
      {loadingProfile && <div className="panel"><p className="empty">Loading player…</p></div>}
      {profileErr && !loadingProfile && <div className="panel"><p className="empty" data-testid="profile-err"><b>Could not load player</b>{profileErr}</p></div>}

      {profile && !loadingProfile && (
        <div id="profileview">
          <button className="back" data-testid="lookup-back" onClick={backToSearch}>‹ Back to search</button>
          <ProfileView p={profile} fields={fields} canEdit={canEdit} canManage={canManage} canCredit={canCredit}
            onOpenMatch={(id) => router.push(`/match-ops/matches/${id}`)}
            onAdd={() => setModal({ type: "add" })}
            onRemove={(m) => setModal({ type: "remove", m })}
            onSuspend={() => setModal({ type: "suspend" })}
            onExpel={() => setModal({ type: "expel" })}
            onLift={() => setModal({ type: "lift" })}
          />
          <p className="foot" data-testid="builtnote">
            Account, membership, strikes, matches and live Stripe payments are all shown above. Account history reflects the current ban only, not a full audit trail.
          </p>
        </div>
      )}

      {modal?.type === "add" && profile && (
        <AddMatchModal p={profile} canEdit={canEdit} onClose={() => setModal(null)}
          onDone={(msg) => { setModal(null); showToast(msg); reloadProfile(); }} />
      )}
      {modal?.type === "remove" && profile && (
        <RemoveModal p={profile} m={modal.m} canEdit={canEdit} onClose={() => setModal(null)}
          onDone={(msg) => { setModal(null); showToast(msg); reloadProfile(); }} />
      )}
      {(modal?.type === "suspend" || modal?.type === "expel" || modal?.type === "lift") && profile && (
        <BanModal p={profile} kind={modal.type} canManage={canManage} onClose={() => setModal(null)}
          onDone={(msg) => { setModal(null); showToast(msg); reloadProfile(); }} />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

// ---------- profile ----------
function Fact({ k, v, big }: { k: string; v: React.ReactNode; big?: boolean }) {
  return <span className="f"><span className="k">{k}</span><span className={`v${big ? " big" : ""}`}>{v}</span></span>;
}

function ProfileView({ p, fields, canEdit, canManage, canCredit, onOpenMatch, onAdd, onRemove, onSuspend, onExpel, onLift }: {
  p: Profile; fields: Record<FieldKey, boolean>; canEdit: boolean; canManage: boolean; canCredit: boolean;
  onOpenMatch: (id: number) => void; onAdd: () => void; onRemove: (m: MatchRow) => void;
  onSuspend: () => void; onExpel: () => void; onLift: () => void;
}) {
  const pl = p.player;
  const tags = statusTags({ status: pl.status, hasMembership: !!p.membership && p.membership.status !== "canceled" });
  const counts = useMemo(() => matchCounts(p.matches), [p.matches]);
  // The live balance, in CENTS, once an adjustment has landed — so the headline figure and the
  // panel below it can never disagree about what this player has.
  const [liveCredits, setLiveCredits] = useState<number | null>(null);
  return (
    <>
      <div className="idcard" data-pid={pl.id}>
        <div className="idtop">
          <span className="who">
            <h2>{pl.name}</h2>
            <span className="sub"><span>{pl.email ?? "no email"}</span> · <span>{pl.phone ?? "no phone"}</span></span>
          </span>
          <span className="idtags">{tags.map(([c, l]) => <span key={l} className={`tag ${c}`}>{l}</span>)}</span>
        </div>

        {pl.status === "expelled" && (
          <div className="banner expel"><span><b>Expelled{pl.banReason ? ` — ${pl.banReason}` : ""}</b>
            <small>{fmtWhen(pl.bannedAt)} · permanent until lifted</small></span></div>
        )}
        {pl.status === "suspended" && (
          <div className="banner susp"><span><b>Suspended{pl.banReason ? ` — ${pl.banReason}` : ""}</b>
            <small>{fmtWhen(pl.bannedAt)}{pl.banExpiredAt ? ` · until ${fmtDate(pl.banExpiredAt)}` : ""}</small></span></div>
        )}

        <div className="facts">
          <Fact k="CREDITS" v={money(liveCredits ?? pl.credits)} big />
          {/* facts come from the SAME counts as the match-history chips (single source) */}
          <Fact k="PLAYED" v={counts.played} big />
          <Fact k="UPCOMING" v={counts.upcoming} big />
          {fields.uid && <Fact k="PLAYER ID" v={pl.id} />}
          {fields.city && <Fact k="PREFERABLE CITY" v={pl.city ?? "—"} />}
          {fields.level && <Fact k="SOCCER LEVEL" v={pl.level ?? "—"} />}
          {fields.joined && <Fact k="REGISTERED" v={fmtDate(pl.registered)} />}
          {fields.verified && <Fact k="PHONE VERIFIED" v={pl.phoneVerified ? "Yes" : "No"} />}
          {fields.goals && <Fact k="GOALS SCORED" v={pl.goals} />}
          {fields.mgr && <Fact k="CITY MANAGER" v={pl.cityManager ? "Yes" : "No"} />}
        </div>
      </div>

      <CreditPanel playerId={pl.id} playerName={pl.name} balanceCents={liveCredits ?? pl.credits}
        canCredit={canCredit} onBalance={setLiveCredits} />

      <MembershipPanel m={p.membership} />

      <StrikePanel s={p.strikes} isMember={!!p.membership} />

      <MatchHistoryPanel matches={p.matches} counts={counts} canEdit={canEdit}
        onOpenMatch={onOpenMatch} onAdd={onAdd} onRemove={onRemove} />

      <PaymentsPanel playerId={pl.id} email={pl.email} matches={p.matches} />

      <AccountHistoryPanel p={p} canManage={canManage} onSuspend={onSuspend} onExpel={onExpel} onLift={onLift} />
    </>
  );
}

// ---------- CREDIT ADJUSTMENT (Phase 27) — the only control in Clubhouse that moves money ----------
//
// AN ADJUSTMENT, NOT AN OVERWRITE. Retool's version is a stepper pre-filled with the current
// balance: one mis-key silently REPLACES someone's money with a different number, and nothing on
// the screen would look wrong, because a balance and a typo look identical. Here you enter "+25" or
// "-10" and Clubhouse computes the absolute value the API wants — the worst a mis-key can do is
// move the wrong amount, which the sentence below states before you commit and the change log
// records after.
//
// The route is the control; every rule here is re-checked server-side against a fresh read of the
// permission and a fresh read of the balance.
function CreditPanel({ playerId, playerName, balanceCents, canCredit, onBalance }: {
  playerId: number; playerName: string; balanceCents: number; canCredit: boolean; onBalance: (cents: number) => void;
}) {
  const [amt, setAmt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // AN ERROR ON AN UNTOUCHED FORM READS AS A BROKEN FEATURE, NOT AS GUIDANCE. The panel opened with
  // "A reason is required" already in red and Apply greyed, which is what a refusal looks like —
  // and it was reported as credits being broken. The hint under the field ("required — written to
  // the change log") already says it before you start, so the error is only useful once you have
  // either tried to submit or left the field empty behind you.
  const [reasonTouched, setReasonTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [res, setRes] = useState<{ verdict: "LANDED" | "FAILED" | "NOT APPLIED" | "UNKNOWN" | "ABORTED"; text: string } | null>(null);

  const v = validateAdjustment({ raw: amt, reason, beforeCents: balanceCents, playerName, canEdit: canCredit });
  // The BUTTON still uses the full validation — readiness is unchanged, only what is SHOWN moves.
  const shownErrors = v.errors.filter((e) => e !== REASON_REQUIRED || reasonTouched || attempted);

  const apply = async () => {
    if (!v.ok || v.deltaCents == null || busy) return;
    setBusy(true); setRes(null);
    try {
      // ONE ATTEMPT. No retry on any outcome — if the endpoint were a delta a retry would be a
      // second grant, and even for an absolute set it is a second money movement nobody asked for.
      const r = await authFetch(`/api/matchday/${ENV}/players/${playerId}/credits`, {
        method: "POST",
        body: JSON.stringify({ deltaCents: v.deltaCents, expectedBeforeCents: balanceCents, reason: reason.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.aborted) {
        // The balance moved between the screen loading and this click. Nothing was sent.
        if (typeof j.balanceCents === "number") onBalance(j.balanceCents);
        setRes({ verdict: "ABORTED", text: String(j.error) });
        return;
      }
      if (!r.ok) { setRes({ verdict: j.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILED", text: String(j.error ?? `HTTP ${r.status}`) }); return; }
      if (typeof j.balanceCents === "number") onBalance(j.balanceCents);
      if (j.landed) {
        setRes({ verdict: "LANDED", text: `${playerName}'s balance is now ${fmtUsd(j.balanceCents)} — a re-read confirms it. Logged with your reason.` });
        setAmt(""); setReason("");
      } else {
        setRes({ verdict: "NOT APPLIED", text: `The server accepted the write (2xx) but a re-read shows ${fmtUsd(j.balanceCents)}, not ${fmtUsd(j.intendedAfterCents)}. Nothing was retried.` });
      }
    } catch (e) {
      // UNKNOWN is not FAILED: the write may have landed. Never retried, and it says so.
      setRes({ verdict: "UNKNOWN", text: `${e instanceof Error ? e.message : String(e)} — the request may or may not have landed. Nothing was retried; reload and check the balance before acting.` });
    } finally { setBusy(false); }
  };

  return (
    <section className="panel credpanel" data-testid="credit-panel">
      <h3>CREDITS</h3>
      <p className="credbal" data-testid="credit-balance" data-cents={balanceCents}>
        Balance <b>{fmtUsd(balanceCents)}</b>
      </p>
      {!canCredit ? (
        <p className="credlock" data-testid="credit-locked">
          Adjusting credits needs <b>EDIT CREDITS</b>, which is granted separately from Match Ops — holding Match Ops does not include it.
        </p>
      ) : null}
      <div className="credrow">
        <label className="credf">
          <span>ADJUSTMENT <em>+ adds, − subtracts</em></span>
          <input data-testid="credit-amount" value={amt} inputMode="decimal" placeholder="+25 or -10"
            disabled={!canCredit || busy} onChange={(e) => setAmt(e.target.value)} aria-label="Credit adjustment" />
        </label>
        <label className="credf grow">
          <span>REASON <em>required — written to the change log</em></span>
          <input data-testid="credit-reason" value={reason} placeholder="Why this is being adjusted"
            disabled={!canCredit || busy} onChange={(e) => setReason(e.target.value)}
            onBlur={() => setReasonTouched(true)} aria-label="Reason for the adjustment" />
        </label>
      </div>
      {/* THE CONSEQUENCE, BEFORE THE CLICK — same pattern as the manager-pay screen. It is drawn
          from the SAME arithmetic that produces the number sent, so it cannot promise one figure
          and send another. */}
      {v.consequence && <p className="credconseq" data-testid="credit-consequence">{v.consequence}</p>}
      {shownErrors.length > 0 && (
        <ul className="crederrs" data-testid="credit-errors">
          {shownErrors.map((e, i) => <li key={i} data-testid="credit-error">{e}</li>)}
        </ul>
      )}
      <div className="credacts">
        {/* onPointerDown fires even though the button is disabled for a click, so reaching for
            Apply counts as an attempt and the outstanding reason error appears. */}
        <span onPointerDown={() => setAttempted(true)} className="credbtnwrap">
        <button type="button" className="credbtn" data-testid="credit-apply" disabled={!v.ok || busy} onClick={() => { setAttempted(true); void apply(); }}>
          {busy ? "Applying…" : "Apply adjustment"}
        </button>
        </span>
        <span className="credcap">One adjustment at a time, up to {fmtUsd(MAX_ADJUSTMENT_CENTS)}. Sent once — never retried.</span>
      </div>
      {res && <p className="credres" data-testid="credit-result" data-verdict={res.verdict}><b>{res.verdict}</b> — {res.text}</p>}
    </section>
  );
}

// ---------- payments (LIVE Stripe, never cached) ----------
type PayStatus = "succeeded" | "pending" | "refunded" | "failed" | "disputed";
type PaymentRow = { id: string; description: string; created: string; card: string | null; status: PayStatus; amount: number; matchId: string | null; isMembership: boolean };
type PaymentsResp = { ok: boolean; rows?: PaymentRow[]; foundVia?: ("email" | "userId")[]; customerMatched?: boolean; email?: string | null; error?: string; kind?: string };

function PaymentsPanel({ playerId, email, matches }: { playerId: number; email: string | null; matches: MatchRow[] }) {
  const [state, setState] = useState<{ phase: "loading" | "ok" | "error"; data?: PaymentsResp }>({ phase: "loading" });
  const matchName = useMemo(() => new Map(matches.map((m) => [String(m.matchId), m.name])), [matches]);

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    if (!email) { setState({ phase: "ok", data: { ok: true, rows: [], customerMatched: false, email: null } }); return; }
    (async () => {
      try {
        // live, per profile view — the route sets no-store; add a cache-buster too
        const res = await authFetch(`/api/lookup/${ENV}/payments?id=${playerId}&email=${encodeURIComponent(email)}`);
        const j = (await res.json().catch(() => ({}))) as PaymentsResp;
        if (!live) return;
        if (!res.ok || j.ok === false) setState({ phase: "error", data: j });
        else setState({ phase: "ok", data: j });
      } catch (e) { if (live) setState({ phase: "error", data: { ok: false, error: e instanceof Error ? e.message : String(e), kind: "unreachable" } }); }
    })();
    return () => { live = false; };
  }, [playerId, email]);

  const head = (note: React.ReactNode) => (
    <div className="ptitle"><h3>PAYMENTS · STRIPE</h3><span className="note">{note}</span></div>
  );

  if (state.phase === "loading") {
    return <div className="panel" data-testid="payments"><div className="ptitle"><h3>PAYMENTS · STRIPE</h3><span className="note">reading Stripe…</span></div><p className="empty small">Reading live charges from Stripe…</p></div>;
  }

  // FAILURE MODE 2 — Stripe unreachable/erroring. Never degrade to an empty list.
  if (state.phase === "error") {
    return (
      <div className="panel" data-testid="payments">
        {head(<span className="tag expel">STRIPE ERROR</span>)}
        <div className="warn hard" data-testid="pay-error" style={{ margin: 16 }}><b>Stripe could not be read right now.</b>
          {state.data?.error ?? "Unknown error."} This does <b>NOT</b> mean the player has no payments — retry, or check Stripe directly.</div>
      </div>
    );
  }

  const d = state.data!;
  const rows = d.rows ?? [];

  if (rows.length === 0) {
    // FAILURE MODE 1 — email mismatch / no customer. NEVER an empty list that reads as "never paid".
    return (
      <div className="panel" data-testid="payments">
        {head("")}
        {!email
          ? <div className="warn" data-testid="pay-nomatch" style={{ margin: 16 }}><b>No email on file for this player.</b>Stripe is looked up by email — without one, charges can&apos;t be found here. Check Stripe directly.</div>
          : d.customerMatched
            ? <div className="nomem"><b>No charges on record</b>A Stripe customer matched this email, but has no charges.</div>
            : <div className="warn" data-testid="pay-nomatch" style={{ margin: 16 }}><b>No Stripe customer found for this email ({email}).</b>
                This does NOT mean they never paid — their Stripe email may differ from MatchDay&apos;s (a known mismatch). Also tried metadata.userId and found nothing. Check Stripe directly by name or card.</div>}
        <p className="pfoot">Live from Stripe, read-only, not cached.</p>
      </div>
    );
  }

  const pending = rows.filter((r) => r.status === "pending").length;
  const bad = rows.filter((r) => r.status === "failed" || r.status === "disputed").length;
  const notes = [];
  if (pending) notes.push(`${pending} pending`);
  if (bad) notes.push(`${bad} failed/disputed`);
  const via = d.foundVia ?? [];
  const onlyUserId = via.length === 1 && via[0] === "userId";

  return (
    <div className="panel" data-testid="payments">
      {head(notes.join(" · ") || "all settled")}
      {onlyUserId && (
        <div className="warn" data-testid="pay-via-userid" style={{ margin: "12px 16px 0" }}><b>Matched by metadata.userId, not email.</b>
          This player&apos;s Stripe email differs from their MatchDay email — worth flagging.</div>
      )}
      <div className="rows">
        {rows.map((r) => {
          const tag = r.isMembership ? "Membership" : (matchName.get(String(r.matchId)) ?? `Match ${r.matchId}`);
          return (
            <div className="row prow" key={r.id} data-charge={r.id}>
              <span className="ptitle2"><span className="l1">{r.description}</span>
                <span className="l2">{fmtWhen(r.created)}{r.card ? ` · ${r.card}` : ""} · {tag}</span></span>
              <span className={`st ${r.status}`} data-status={r.status}>{r.status.toUpperCase()}</span>
              <span className="num">{money(r.amount)}</span>
            </div>
          );
        })}
      </div>
      <p className="pfoot">Ten most recent, <b>live from Stripe, read-only, not cached</b>. <b>Pending</b> means Stripe has the charge but hasn&apos;t settled it — the player has paid as far as they know. Joined to matches on <code>metadata.matchId</code>; no matchId = a membership charge.</p>
      <p className="pfoot" data-testid="pay-amount-note" style={{ borderTop: 0 }}>Amounts are what Stripe <b>charged the card</b> — the base spot price <b>plus the card processing fee, minus any credit</b>. The Match History shows the <b>base spot price</b>, so it reads a few cents lower for the same match. Both are correct; they answer different questions (what the match costs vs. what the player was charged).</p>
    </div>
  );
}

function AccountHistoryPanel({ p, canManage, onSuspend, onExpel, onLift }: {
  p: Profile; canManage: boolean; onSuspend: () => void; onExpel: () => void; onLift: () => void;
}) {
  const st = p.player.status;
  // Lift is offered when already suspended/expelled; otherwise suspend + expel.
  const actions = !canManage
    ? <span className="locked">Suspend, expel and lift need MANAGE PLAYERS</span>
    : st === "expelled"
      ? <button className="sbtn" data-testid="act-lift" onClick={onLift}>Lift expulsion</button>
      : st === "suspended"
        ? <><button className="sbtn" data-testid="act-lift" onClick={onLift}>Lift suspension</button>
            <button className="sbtn danger" data-testid="act-expel" onClick={onExpel}>Expel</button></>
        : <><button className="sbtn danger" data-testid="act-suspend" onClick={onSuspend}>Suspend</button>
            <button className="sbtn danger" data-testid="act-expel" onClick={onExpel}>Expel</button></>;
  return (
    <div className="panel" data-testid="account-history">
      <div className="ptitle"><h3>ACCOUNT HISTORY</h3><span className="acts">{actions}</span></div>
      <div className="rows">
        {p.accountHistory.length === 0
          ? <p className="empty small"><b>Clean record</b>No suspensions or expulsions on file.</p>
          : p.accountHistory.map((h, i) => (
            <div className="row hrow" key={i}>
              <span className={`st ${h.action === "expel" ? "expel" : "suspend"}`}>{h.action === "expel" ? "EXPELLED" : "SUSPENDED"}</span>
              <span className="htitle"><span className="l1">{h.reason ?? "—"}</span>
                <span className="l2">{fmtWhen(h.when)}{h.until ? ` · until ${fmtDate(h.until)}` : " · indefinite"}</span></span>
              <span className="mid c-until">{h.until ? fmtDate(h.until) : "—"}</span>
              <span className="mid c-by">{h.by ?? "—"}</span>
            </div>
          ))}
      </div>
      <p className="pfoot">The API exposes the CURRENT ban only, not a full audit trail. Suspending blocks new bookings until the date but does NOT cancel existing bookings — remove those separately. Every action you take here is recorded in the Change Log with your name on it.</p>
    </div>
  );
}

const PAGE_STEP = 25;
const BUCKET_LABEL: Record<MatchBucket, string> = { all: "All", upcoming: "Upcoming", played: "Played", noshow: "No-show", cancelled: "Cancelled" };

function MatchHistoryPanel({ matches, counts, canEdit, onOpenMatch, onAdd, onRemove }: {
  matches: MatchRow[]; counts: ReturnType<typeof matchCounts>; canEdit: boolean;
  onOpenMatch: (id: number) => void; onAdd: () => void; onRemove: (m: MatchRow) => void;
}) {
  const [filter, setFilter] = useState<MatchBucket>("all");
  const [pastShown, setPastShown] = useState(10);
  const setF = (f: MatchBucket) => { setFilter(f); setPastShown(10); };

  const asc = (a: MatchRow, b: MatchRow) => (Date.parse(a.startDateUtc ?? "") || 0) - (Date.parse(b.startDateUtc ?? "") || 0);
  const desc = (a: MatchRow, b: MatchRow) => (Date.parse(b.startDateUtc ?? "") || 0) - (Date.parse(a.startDateUtc ?? "") || 0);

  // Upcoming ALWAYS pinned to the top, ALL of them, soonest first — they're the only
  // actionable rows (the only ones with Remove), so none is ever hidden behind "show more".
  const upcoming = useMemo(() => matches.filter((m) => bucketOf(m) === "upcoming").sort(asc), [matches]);
  // Past = everything else, newest first; paginated.
  const pastAll = useMemo(() => {
    const inFilter = (m: MatchRow) => filter === "all" ? bucketOf(m) !== "upcoming" : bucketOf(m) === filter;
    return matches.filter((m) => bucketOf(m) !== "upcoming" && inFilter(m)).sort(desc);
  }, [matches, filter]);

  const showUpcoming = filter === "all" || filter === "upcoming";
  const pastVisible = filter === "upcoming" ? [] : pastAll.slice(0, pastShown);
  const totalInView = (showUpcoming ? upcoming.length : 0) + (filter === "upcoming" ? 0 : pastAll.length);
  const shownInView = (showUpcoming ? upcoming.length : 0) + pastVisible.length;
  const moreLeft = pastAll.length - pastVisible.length;

  const chips: MatchBucket[] = ["all", "upcoming", "played", "noshow", "cancelled"];

  const row = (m: MatchRow) => (
    <div className="row mrow" key={m.umId} data-match={m.matchId} data-bucket={bucketOf(m)}>
      <span className="mtitle" role="button" tabIndex={0}
        onClick={() => onOpenMatch(m.matchId)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenMatch(m.matchId); } }}>
        <span className="l1">{m.name}</span>
        <span className="l2">{fmtWhen(m.startDate)}{m.team != null ? ` · T${m.team}` : ""}{m.num != null ? ` · #${m.num}` : ""} · {money(m.price)}</span>
      </span>
      <span className={`st ${m.state}`}>{bucketOf(m) === "noshow" ? "NO SHOW" : m.state.toUpperCase()}</span>
      <span className="mid c-team">{m.team != null ? `T${m.team}` : ""}{m.num != null ? ` · #${m.num}` : ""}</span>
      <span className="num">
        {m.removable
          ? <button className="rowbtn" data-remove={m.matchId} disabled={!canEdit}
            title={canEdit ? undefined : "Requires EDIT MATCHES"} onClick={() => onRemove(m)}>Remove</button>
          : <span className="mid">{money(m.price)}</span>}
      </span>
    </div>
  );

  return (
    <div className="panel" data-testid="match-history">
      <div className="ptitle">
        <h3>MATCH HISTORY</h3>
        <span className="acts">
          <button className="sbtn go" data-testid="add-match" disabled={!canEdit}
            title={canEdit ? undefined : "Requires EDIT MATCHES"} onClick={onAdd}>+ Add to a match</button>
        </span>
      </div>
      <div className="chips" data-testid="match-chips">
        {chips.map((c) => (
          <button key={c} className={`chip${filter === c ? " on" : ""}`} data-chip={c} aria-pressed={filter === c} onClick={() => setF(c)}>
            {BUCKET_LABEL[c]} <b>{counts[c]}</b>
          </button>
        ))}
      </div>
      <p className="pfoot topline" data-testid="match-showing">Showing {shownInView} of {totalInView}{canEdit ? "" : <> · <span className="locked">write actions need EDIT MATCHES</span></>}</p>
      <div className="rows">
        {matches.length === 0 && <p className="empty small">No matches on record.</p>}
        {showUpcoming && upcoming.map(row)}
        {pastVisible.map(row)}
        {matches.length > 0 && shownInView === 0 && <p className="empty small">No {BUCKET_LABEL[filter].toLowerCase()} matches.</p>}
      </div>
      {filter !== "upcoming" && moreLeft > 0
        ? <button className="showmore" data-testid="show-more" onClick={() => setPastShown((n) => n + PAGE_STEP)}>Show {Math.min(PAGE_STEP, moreLeft)} more ({moreLeft} left)</button>
        : filter !== "upcoming" && pastAll.length > 10 ? <p className="pfoot" data-testid="all-shown">All {pastAll.length} shown.</p> : null}
      <p className="pfoot">Upcoming pinned on top (soonest first); past newest first. Click a match to open its roster. Removing writes to production and appears in the Change Log with your name on it.</p>
    </div>
  );
}

function MembershipPanel({ m }: { m: Membership }) {
  if (!m) return (
    <div className="panel">
      <div className="ptitle"><h3>MEMBERSHIP</h3></div>
      <div className="nomem"><b>Not a member</b>Pays per match. Nothing to renew, nothing to cancel.</div>
    </div>
  );
  const st = (m.status || "").toLowerCase();
  const label = st.includes("cancel") ? (["none", "CANCELLED"] as const)
    : st.includes("past") || st.includes("due") || st.includes("unpaid") ? (["susp", "PAST DUE"] as const)
    : (["ok", "ACTIVE"] as const);
  return (
    <div className="panel">
      <div className="ptitle"><h3>MEMBERSHIP</h3><span className="note"><span className={`tag ${label[0]}`}>{label[1]}</span></span></div>
      <div className="memgrid">
        {m.number && <Fact k="SUBSCRIPTION" v={m.number} />}
        <Fact k="STATUS" v={m.status || "—"} />
        {m.since && <Fact k="SINCE" v={fmtDate(m.since)} />}
        {m.renews && <Fact k={m.canceledAt ? "ENDS" : "RENEWS"} v={fmtDate(m.renews)} />}
        {m.price != null && <Fact k="PRICE" v={money(m.price)} />}
        {m.city && <Fact k="CITY" v={m.city} />}
      </div>
      <p className="pfoot">From MatchDay subscriptions. Stripe payment detail is not shown here — check Stripe for charge status.</p>
    </div>
  );
}

// ---------- strikes (display only) ----------
function StrikePanel({ s, isMember }: { s: Strikes; isMember: boolean }) {
  // Strikes are a members-only penalty. A pay-per-match player who no-shows already
  // forfeits the fee (the 24h refund rule), so there is no strike to show.
  if (!isMember && s.logs.length === 0 && s.activeCount === 0) {
    return (
      <div className="panel" data-testid="strikes-members-only">
        <div className="ptitle"><h3>STRIKES</h3></div>
        <div className="nomem"><b>Members only</b>This player pays per match, so a missed spot already costs them the fee. Strikes exist because a member&apos;s does not.</div>
      </div>
    );
  }
  const active = s.activeCount;         // POINT SUM from the server, not a row count
  const tripped = active >= s.limit;
  const over = Math.max(0, active - s.limit);
  const remaining = Math.max(0, s.limit - active);
  return (
    <div className="panel" data-testid="strikes">
      <div className="ptitle"><h3>STRIKES</h3><span className="note" data-testid="strike-count">{active} of {s.limit} points</span></div>

      {s.isSuspended && (
        <div className="banner susp" data-testid="strike-suspended"><span><b>Suspended by strikes</b>
          <small>{s.limit} strike points = a one-week suspension{s.suspendedTo ? ` · until ${fmtDate(s.suspendedTo)}` : ""}</small></span></div>
      )}

      <div className="strikebar">
        <span className="pips">
          {Array.from({ length: s.limit }, (_, i) => (
            <span key={i} className={`pip ${i < Math.min(active, s.limit) ? (tripped ? "trip" : "on") : ""}`} />
          ))}
          {over > 0 && <span className="pip pipover" data-testid="pip-over">+{over}</span>}
        </span>
        <span className="stxt">
          {/* activeStrikes is a SUM of penaltyPoints (a single strike can weigh >1), so the
              number is POINTS, not rows — say so, or three rows under "N of 4" reads as a bug. */}
          <b>{active} of {s.limit} strike points</b> · {s.limit} suspends a member for a week
          {over > 0 ? ` · ${over} OVER the threshold` : active < s.limit ? ` · ${remaining} to go` : " · at the threshold"}
          {s.expiredAt ? <> · current strikes expire {fmtDate(s.expiredAt)}</> : null}
        </span>
      </div>

      <div className="rows">
        {s.logs.length === 0 && <p className="empty small">No strikes on record.</p>}
        {s.logs.map((l, i) => {
          const known = isKnownStrikeReason(l.reason);
          const label = strikeReasonLabel(l.reason); // "STRIKE" for NONE / ON_TIME / absent
          const cls = l.reason === "NO_SHOW" ? "noshow" : l.reason === "CANCEL_W_IN_SOME_HOURS" ? "latecancel" : l.reason === "LATE" ? "late" : "strike";
          const detail = l.reason === "CANCEL_W_IN_SOME_HOURS" && l.hoursBefore != null ? `Cancelled ${l.hoursBefore}h before kickoff`
            : l.reason === "NO_SHOW" ? "Never checked in"
            : l.reason === "LATE" ? "Arrived after kickoff"
            : known ? "" : "Reason not recorded on the linked match";
          return (
            <div className="row srow" key={i}>
              <span className="stitle"><span className="l1">{l.matchName ?? "Match"}</span>
                <span className="l2">{fmtWhen(l.when)}{detail ? ` · ${detail}` : ""}{l.penaltyPoint > 1 ? ` · ×${l.penaltyPoint}` : ""}</span></span>
              <span className={`st ${cls}`}>{label}</span>
              <span className={`st ${l.active ? "sactive" : "expired"}`}>{l.active ? "ACTIVE" : "EXPIRED"}</span>
            </div>
          );
        })}
      </div>
      <p className="pfoot">A member is struck for arriving late, not showing, or cancelling inside 6 hours of kickoff (see docs). {s.limit} active strikes suspends the membership for a week. Read-only here — issuing and removing strikes stays in MatchDay.</p>
    </div>
  );
}

// ---------- add to a match ----------
type Candidate = { id: number; name: string; startDateUtc: string; startDate: string; city: string | null; price: number | null; open: number; full: boolean };
type RosterResp = { teams: { teamNumber: number; name: string }[]; players: { team: number; playerNumber: number }[]; shape: { teamN: number; perTeam: number }; maxPlayerCount: number | null };

function AddMatchModal({ p, canEdit, onClose, onDone }: { p: Profile; canEdit: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterResp | null>(null);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [pick, setPick] = useState<{ team: number; spot: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeErr, setWriteErr] = useState<string | null>(null);

  const alreadyIn = useMemo(() => new Set(p.matches.map((m) => m.matchId)), [p.matches]);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/matchday/${ENV}/gameday?date=${todayYmd()}`);
        const j = await res.json();
        if (!res.ok) { setLoadErr(j?.error || `Load failed (${res.status})`); return; }
        const rows = (j.matches ?? []) as Record<string, unknown>[];
        const now = Date.now();
        const list: Candidate[] = rows.map((m) => {
          const cap = typeof m.maxPlayerCount === "number" ? m.maxPlayerCount : null;
          const filled = (m._count as { players?: number } | undefined)?.players ?? 0;
          const open = cap != null ? Math.max(0, cap - filled) : 0;
          const field = (m.field as { city?: { name?: string } } | undefined);
          return {
            id: m.id as number, name: (m.name as string) ?? `Match ${m.id}`,
            startDateUtc: (m.startDateUtc as string) ?? (m.startDate as string) ?? "",
            startDate: (m.startDate as string) ?? "",
            city: field?.city?.name ?? null,
            price: (m.registrationPrice as number | null) ?? null,
            open, full: !m.isCancelled ? open === 0 : true,
          };
        }).filter((m) => Date.parse(m.startDateUtc) > now - 3 * 3600_000) // today, drop long-finished
          .sort((a, b) => (Date.parse(a.startDateUtc) || 0) - (Date.parse(b.startDateUtc) || 0));
        setCands(list);
      } catch (e) { setLoadErr(e instanceof Error ? e.message : String(e)); }
    })();
  }, []);

  const selectMatch = useCallback(async (id: number) => {
    setSel(id); setRoster(null); setPick(null); setRosterBusy(true); setWriteErr(null);
    try {
      const res = await authFetch(`/api/matchday/${ENV}/roster/${id}`);
      const j = await res.json();
      if (!res.ok) { setWriteErr(j?.error || `Could not read roster (${res.status})`); return; }
      const r = j as RosterResp;
      setRoster(r);
      const teams = spotTeams(r);
      setPick(suggestSpot(teams)); // pre-select the suggestion
    } catch (e) { setWriteErr(e instanceof Error ? e.message : String(e)); }
    finally { setRosterBusy(false); }
  }, []);

  const shown = useMemo(() => (cands ?? []).filter((m) => !filter || (m.name + " " + (m.city ?? "")).toLowerCase().includes(filter.toLowerCase())), [cands, filter]);
  const selMatch = cands?.find((m) => m.id === sel) ?? null;
  const teams = roster ? spotTeams(roster) : [];
  const sug = roster ? suggestSpot(teams) : null;

  const confirm = async () => {
    if (sel == null || !pick || !roster || busy) return;
    setBusy(true); setWriteErr(null);
    try {
      const teamNumber = roster.teams[pick.team]?.teamNumber ?? pick.team + 1;
      const res = await authFetch(`/api/matchday/${ENV}/roster/${sel}`, {
        method: "POST",
        body: JSON.stringify({ kind: "add", playerId: p.player.id, team: teamNumber, playerNumber: pick.spot, source: "player-lookup", matchName: selMatch?.name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setWriteErr(j?.error || `Add failed (${res.status})`); setBusy(false); return; }
      onDone(`Added ${p.player.name} to ${selMatch?.name ?? "the match"} · team ${teamNumber} · #${pick.spot}`);
    } catch (e) { setWriteErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Modal title={`Add ${p.player.name} to a match`} onClose={onClose}>
      {!canEdit && <div className="warn hard"><b>You have read-only Match Ops access.</b>EDIT MATCHES is required. The server will refuse this write.</div>}
      <span className="fld"><span className="lb">FIND A MATCH</span>
        <input type="search" autoComplete="off" placeholder="Match name or city" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="help">Today&apos;s matches with room. Matches {p.player.name} is already in are greyed out.</span>
      </span>

      {loadErr && <div className="warn hard"><b>Could not load today&apos;s matches.</b>{loadErr}</div>}
      {!loadErr && !cands && <p className="empty small">Loading today&apos;s matches…</p>}
      {cands && (
        <div className="mlist" data-testid="match-list">
          {shown.length === 0 && <p className="empty small">No match matches “{filter}”.</p>}
          {shown.map((m) => {
            const dup = alreadyIn.has(m.id);
            const dead = dup || m.full;
            const why = dup ? "already in" : m.full ? "full" : `${m.open} open`;
            return (
              <button key={m.id} type="button" className="mopt" aria-pressed={sel === m.id} disabled={dead} data-mid={m.id} onClick={() => selectMatch(m.id)}>
                <span><span className="l1">{m.name}</span><span className="l2">{fmtWhen(m.startDate)} · {m.city ?? "—"}{m.price != null ? ` · ${money(m.price)}` : ""}</span></span>
                <span className="rt2">{why}</span>
              </button>
            );
          })}
        </div>
      )}

      <span className="fld lbonly"><span className="lb">SPOT</span></span>
      {sel == null && <p className="sugnote">Pick a match to see its open spots.</p>}
      {sel != null && rosterBusy && <p className="empty small">Reading roster…</p>}
      {sel != null && roster && (
        <>
          <div className="teams">
            {teams.map((t, i) => {
              const free = openSpotsOf(t);
              const label = roster.teams[i]?.name || `Team ${i + 1}`;
              if (!free.length) return <div className="team" key={i}><h5>{label}</h5><span className="cap">{t.taken.length} of {t.size}</span><span className="full">Full</span></div>;
              return (
                <div className="team" key={i}>
                  <h5>{label}</h5>
                  <span className="cap">{t.taken.length} of {t.size} · {free.length} open</span>
                  <span className="spots">{free.map((n) => {
                    const isSug = sug && sug.team === i && sug.spot === n;
                    const on = pick && pick.team === i && pick.spot === n;
                    return <button key={n} type="button" className={`spot${isSug ? " sug" : ""}`} aria-pressed={!!on} onClick={() => setPick({ team: i, spot: n })}>{n}</button>;
                  })}</span>
                </div>
              );
            })}
          </div>
          <span className="sugnote">Green is the suggestion: the emptier side, lowest free number. A 6v4 is a better match than an 8v2, so it balances before it fills.</span>
        </>
      )}

      {writeErr && <div className="warn hard" data-testid="add-err"><b>That didn&apos;t work.</b>{writeErr}</div>}
      {sel != null && pick && selMatch && (
        <span className="summary" data-testid="add-summary"><b>Add {p.player.name} to {selMatch.name}</b>
          {fmtWhen(selMatch.startDate)} · {roster?.teams[pick.team]?.name ?? `Team ${pick.team + 1}`} spot {pick.spot}{selMatch.price != null ? ` · ${money(selMatch.price)}` : ""}<br />
          One production write. It will appear in the Change Log with your name on it.</span>
      )}

      <ModalFoot>
        <button className="sbtn" onClick={onClose}>Cancel</button>
        <button className="sbtn go" data-testid="add-confirm" disabled={sel == null || !pick || busy || !canEdit} onClick={confirm}>{busy ? "Adding…" : "Add to match"}</button>
      </ModalFoot>
    </Modal>
  );
}

function spotTeams(r: RosterResp): SpotTeam[] {
  const size = r.shape?.perTeam || (r.maxPlayerCount && r.teams.length ? Math.round(r.maxPlayerCount / r.teams.length) : 0) || 0;
  return r.teams.map((t) => ({ size, taken: r.players.filter((p) => p.team === t.teamNumber).map((p) => p.playerNumber) }));
}

// ---------- remove from a match ----------
function RemoveModal({ p, m, canEdit, onClose, onDone }: { p: Profile; m: MatchRow; canEdit: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await authFetch(`/api/matchday/${ENV}/roster/${m.matchId}`, {
        method: "POST",
        body: JSON.stringify({ kind: "remove", userMatchId: m.umId, source: "player-lookup", matchName: m.name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error || `Remove failed (${res.status})`); setBusy(false); return; }
      onDone(`Removed ${p.player.name} from ${m.name}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Modal title="Remove from match" onClose={onClose}>
      <div className="warn hard"><b>This removes a real person from a real match.</b>
        {p.player.name} · {m.name} · {fmtWhen(m.startDate)}{m.team != null ? ` · team ${m.team}` : ""}{m.num != null ? `, spot ${m.num}` : ""}</div>
      {m.price > 0 && (
        <div className="warn"><b>They paid {money(m.price)} for this spot (MatchDay).</b>
          Whether removing them refunds it is UNCONFIRMED — the question is open with the backend. Assume it does not.
          <br /><b>After removing, re-check this player&apos;s Payments panel</b> (live Stripe) to see if a refund appears — this dialog can&apos;t tell you whether it does.</div>
      )}
      <p className="plain">Removing does not notify the player. Only cancelling the whole match does that.</p>
      {!canEdit && <div className="warn hard"><b>Read-only access.</b>The server will refuse this — EDIT MATCHES is required.</div>}
      {err && <div className="warn hard" data-testid="remove-err"><b>That didn&apos;t work.</b>{err}</div>}
      <ModalFoot>
        <button className="sbtn" onClick={onClose}>Keep them in</button>
        <button className="sbtn danger" data-testid="remove-confirm" disabled={busy || !canEdit} onClick={confirm}>{busy ? "Removing…" : `Remove ${p.player.name}`}</button>
      </ModalFoot>
    </Modal>
  );
}

// ---------- suspend / expel / lift ----------
function BanModal({ p, kind, canManage, onClose, onDone }: { p: Profile; kind: "suspend" | "expel" | "lift"; canManage: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = p.player.name;
  const liftWord = p.player.status === "expelled" ? "expulsion" : "suspension";

  const ready = kind === "suspend" ? !!reason.trim() && /^\d{4}-\d{2}-\d{2}$/.test(until)
    : kind === "expel" ? !!reason.trim() && confirmName.trim() === name
    : !!reason.trim();

  const title = kind === "suspend" ? `Suspend ${name}` : kind === "expel" ? `Expel ${name}` : `Lift ${liftWord}`;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await authFetch(`/api/lookup/${ENV}/ban`, {
        method: "POST",
        body: JSON.stringify({ action: kind, playerId: p.player.id, reason: reason.trim(), until: kind === "suspend" ? until : undefined, playerName: name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error || `Failed (${res.status})`); setBusy(false); return; }
      // A 2xx is not proof. The route re-reads the player and returns landed/status; a write that
      // did NOT apply must never be reported as done — the operator would walk away believing it.
      if (j?.landed === false) {
        setErr(`${j.status === "NOT APPLIED" ? "NOT APPLIED" : "UNKNOWN"} — MatchDay accepted the request but the re-read shows the ban state unchanged. Recorded in the Change Log; check the account before trying again (writes never retry).`);
        setBusy(false); return;
      }
      onDone(kind === "suspend" ? `${name} suspended` : kind === "expel" ? `${name} expelled` : `${liftWord.charAt(0).toUpperCase() + liftWord.slice(1)} lifted for ${name}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Modal title={title} onClose={onClose}>
      {kind === "suspend" && <div className="warn"><b>Suspension blocks new bookings until the date you set.</b>Existing bookings are NOT cancelled — remove those separately if that is what you mean.</div>}
      {kind === "expel" && <div className="warn hard"><b>Expulsion is permanent until someone lifts it.</b>{name} loses access to the platform. Use suspension if there is any chance this is temporary.</div>}
      {kind === "lift" && <div className="warn"><b>This restores {name}&apos;s access immediately.</b>Current reason on file: {p.player.banReason ?? "—"}</div>}

      <span className="fld"><span className="lb">{kind === "lift" ? "WHY — REQUIRED" : "REASON — REQUIRED"}</span>
        <input data-testid="ban-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off"
          placeholder={kind === "suspend" ? "e.g. Repeated late cancellations" : kind === "expel" ? "e.g. Fraudulent dispute after playing" : "e.g. Appealed, dispute resolved"} autoFocus />
        <span className="help">Recorded in the account history and the Change Log with your name on it. Write it for someone reading it in six months.</span>
      </span>

      {kind === "suspend" && (
        <span className="fld"><span className="lb">SUSPENDED UNTIL — REQUIRED</span>
          <input data-testid="ban-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          <span className="help">MatchDay stores an end date for a suspension. For an indefinite ban with no review date, use Expel instead.</span>
        </span>
      )}
      {kind === "expel" && (
        <span className="fld"><span className="lb">TYPE THE PLAYER&apos;S NAME TO CONFIRM</span>
          <input data-testid="ban-confirm-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={name} autoComplete="off" />
          <span className="help">Deliberate friction. Expulsion should not be one mis-click away.</span>
        </span>
      )}

      {!canManage && <div className="warn hard"><b>You do not hold MANAGE PLAYERS.</b>The server will refuse this write.</div>}
      {err && <div className="warn hard" data-testid="ban-err"><b>That didn&apos;t work.</b>{err}</div>}
      <ModalFoot>
        <button className="sbtn" onClick={onClose}>Cancel</button>
        <button className={`sbtn ${kind === "lift" ? "go" : "danger"}`} data-testid="ban-confirm" disabled={!ready || busy || !canManage} onClick={submit}>
          {busy ? "Working…" : kind === "suspend" ? "Suspend" : kind === "expel" ? "Expel" : `Lift ${liftWord}`}
        </button>
      </ModalFoot>
    </Modal>
  );
}

// ---------- modal shell ----------
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mhead"><h3>{title}</h3><button className="mclose" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="mbody">{children}</div>
      </div>
    </div>
  );
}
function ModalFoot({ children }: { children: React.ReactNode }) {
  return <div className="mfoot"><span className="spacer" />{children}</div>;
}

const CSS = `
.pl{--ink:#0e1a13;--ink2:#3d5349;--ink3:#5c7168;--line:#dde6e1;--bg:#f2f6f4;--card:#fff;
  --grn:#146c43;--grnbg:#e6f4ec;--grnln:#9fd3b6;--amb:#8a5600;--ambbg:#fdf2e0;--ambln:#e8c383;
  --red:#b3241f;--redbg:#fdecea;--redln:#f0a9a4;--blu:#1d4f8f;--blubg:#e8f0fa;--bluln:#a8c4e6;--focus:#0b6bcb;
  color:var(--ink);font-size:14px;line-height:1.45;max-width:1180px;margin:0 auto;padding:4px 2px 64px}
.pl *{box-sizing:border-box}
.pl .head{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.pl .headtop{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.pl .h1{font-size:23px;font-weight:700;letter-spacing:-.02em;margin:0}
.pl .hsub{color:var(--ink2);margin:2px 0 0}
.pl .livetag{margin-left:auto;display:inline-flex;align-items:center;gap:7px;background:#5b6b63;color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;border-radius:999px;white-space:nowrap}
.pl .livetag.prod{background:#12301f}
.pl .livetag.stage{background:#8a5600}
.pl .livedot{width:7px;height:7px;border-radius:50%;background:#fff;display:block}
.pl .searchrow{display:flex;gap:10px;align-items:stretch;margin-top:14px;flex-wrap:wrap}
.pl .sbox{flex:1 1 320px;min-width:0;position:relative;display:flex}
.pl .sbox input{width:100%;min-width:0;border:1px solid var(--line);border-radius:11px;padding:12px 14px 12px 40px;font:inherit;font-size:15px;background:#fbfdfc;color:var(--ink)}
.pl .sbox input:focus{outline:2px solid var(--focus);outline-offset:-1px;background:#fff}
.pl .sicon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--ink3);font-size:14px;pointer-events:none}
.pl .btn{border:1px solid var(--line);background:var(--card);border-radius:11px;padding:0 16px;font:inherit;font-weight:700;cursor:pointer;color:var(--ink2);min-height:44px;white-space:nowrap}
.pl .btn:hover{background:#f6faf8}
.pl .hint{margin:9px 2px 0;font-size:12.5px;color:var(--ink3)}
.pl .fieldswrap{position:relative}
.pl .scrim-quiet{position:fixed;inset:0;z-index:15}
.pl .pop{position:absolute;right:0;top:calc(100% + 8px);z-index:20;width:250px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 28px rgba(9,30,20,.16);padding:12px 14px}
.pl .pop h4{margin:0 0 4px;font-size:10.5px;letter-spacing:.12em;color:var(--ink3);font-weight:800}
.pl .pop p{margin:0 0 9px;font-size:11.5px;color:var(--ink3);line-height:1.35}
.pl .pop label{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:13px;cursor:pointer;color:var(--ink2)}
.pl .pop input{width:16px;height:16px;accent-color:#12301f;flex:0 0 auto}
.pl .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:14px}
.pl .ptitle{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);background:#fafcfb}
.pl .ptitle h3{margin:0;font-size:12px;font-weight:800;letter-spacing:.1em;color:var(--ink2)}
.pl .ptitle .note{margin-left:auto;font-size:11.5px;color:var(--ink3);font-weight:600}
.pl .res{display:grid;gap:12px;align-items:center;width:100%;text-align:left;cursor:pointer;grid-template-columns:minmax(140px,1.3fr) minmax(150px,1.5fr) 130px 96px auto;padding:11px 16px;border:0;border-bottom:1px solid var(--line);background:var(--card);font:inherit;color:inherit}
.pl .res:last-child{border-bottom:0}
.pl .res:hover{background:#f7fbf9}
.pl .res:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.pl .res.recent{grid-template-columns:minmax(140px,1fr) auto}
.pl .rn{display:block;font-weight:700;overflow-wrap:anywhere}
.pl .rid{display:block;font-size:11.5px;color:var(--ink3);font-variant-numeric:tabular-nums}
.pl .rt{display:block;font-size:13px;color:var(--ink2);overflow-wrap:anywhere}
.pl .rt.mono{font-variant-numeric:tabular-nums}
.pl .rt.muted{color:var(--ink3);font-style:italic}
.pl .rtags{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.pl .tag{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;padding:2px 7px;border-radius:999px;border:1px solid;white-space:nowrap}
.pl .tag.member{background:var(--blubg);color:var(--blu);border-color:var(--bluln)}
.pl .tag.none{background:#f0f4f2;color:var(--ink3);border-color:var(--line)}
.pl .tag.susp{background:var(--ambbg);color:var(--amb);border-color:var(--ambln)}
.pl .tag.expel{background:var(--redbg);color:var(--red);border-color:var(--redln)}
.pl .tag.ok{background:var(--grnbg);color:var(--grn);border-color:var(--grnln)}
.pl .empty{padding:30px 16px;text-align:center;color:var(--ink3)}
.pl .empty.small{padding:16px}
.pl .empty b{display:block;color:var(--ink2);margin-bottom:4px}
.pl .back{display:inline-flex;align-items:center;gap:7px;background:none;border:0;padding:6px 2px;margin:0 0 8px;font:inherit;font-weight:700;color:var(--ink2);cursor:pointer;min-height:32px}
.pl .back:hover{color:var(--ink)}
.pl .idcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.pl .idtop{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.pl .who{min-width:0}
.pl .who h2{margin:0;font-size:21px;letter-spacing:-.02em;overflow-wrap:anywhere}
.pl .who .sub{display:block;margin-top:3px;color:var(--ink2);font-size:13.5px;overflow-wrap:anywhere}
.pl .idtags{display:flex;gap:7px;flex-wrap:wrap;margin-left:auto;align-items:center}
.pl .banner{display:flex;gap:10px;align-items:flex-start;margin-top:13px;padding:11px 13px;border-radius:11px;border:1px solid}
.pl .banner.expel{background:var(--redbg);border-color:var(--redln);color:#7d1a16}
.pl .banner.susp{background:var(--ambbg);border-color:var(--ambln);color:#6b4400}
.pl .banner b{display:block;font-size:13px}
.pl .banner small{display:block;font-size:12.5px;margin-top:2px;opacity:.9}
.pl .facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.pl .f{display:block;min-width:0}
.pl .f .k{display:block;font-size:10px;font-weight:800;letter-spacing:.11em;color:var(--ink3);margin-bottom:3px}
.pl .f .v{display:block;font-size:14px;overflow-wrap:anywhere}
.pl .f .v.big{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.pl .memgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;padding:14px 16px}
.pl .nomem{padding:20px 16px;color:var(--ink3);font-size:13.5px}
.pl .nomem b{display:block;color:var(--ink2);margin-bottom:3px;font-size:14px}
.pl .rows{display:block}
.pl .row{display:grid;gap:11px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}
.pl .row:last-child{border-bottom:0}
.pl .chips{display:flex;gap:7px;flex-wrap:wrap;padding:11px 16px;border-bottom:1px solid var(--line);background:#fafcfb}
.pl .chip{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;font-weight:600;color:var(--ink2);cursor:pointer;min-height:30px;white-space:nowrap}
.pl .chip:hover{background:#f0f5f2}
.pl .chip b{font-variant-numeric:tabular-nums;color:var(--ink)}
.pl .chip.on{background:#12301f;border-color:#12301f;color:#fff}
.pl .chip.on b{color:#fff}
.pl .showmore{display:block;width:calc(100% - 32px);margin:12px 16px;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px;font:inherit;font-weight:700;font-size:13px;color:var(--ink2);cursor:pointer;min-height:40px}
.pl .showmore:hover{background:#f6faf8}
.pl .mrow{grid-template-columns:minmax(0,1fr) 84px 96px 84px}
.pl .mtitle{display:block;min-width:0;cursor:pointer}
.pl .mtitle:hover .l1{text-decoration:underline}
.pl .l1{display:block;font-weight:600;overflow-wrap:anywhere}
.pl .l2{display:block;font-size:11.5px;color:var(--ink3);overflow-wrap:anywhere}
.pl .num{display:block;text-align:right;font-variant-numeric:tabular-nums;font-weight:700}
.pl .mid{display:block;text-align:center;font-variant-numeric:tabular-nums;font-size:12.5px;color:var(--ink2)}
.pl .st{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:3px 6px;border-radius:6px;font-size:10.5px;font-weight:800;letter-spacing:.03em;border:1px solid;white-space:nowrap}
.pl .st.upcoming{background:var(--blubg);color:var(--blu);border-color:var(--bluln)}
.pl .st.played{background:#f0f4f2;color:var(--ink2);border-color:var(--line)}
.pl .st.cancelled{background:var(--ambbg);color:var(--amb);border-color:var(--ambln)}
.pl .st.late{background:var(--ambbg);color:var(--amb);border-color:var(--ambln)}
.pl .st.latecancel{background:var(--ambbg);color:var(--amb);border-color:var(--ambln)}
.pl .st.noshow{background:var(--redbg);color:var(--red);border-color:var(--redln)}
.pl .st.strike{background:#f0f4f2;color:var(--ink2);border-color:var(--line)}
.pl .st.sactive{background:var(--redbg);color:var(--red);border-color:var(--redln)}
.pl .st.expired{background:#f0f4f2;color:var(--ink2);border-color:var(--line)}
.pl .strikebar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.pl .pips{display:flex;gap:5px}
.pl .pip{width:16px;height:16px;border-radius:5px;background:#e7edea;border:1px solid var(--line);display:block}
.pl .pip.on{background:var(--amb);border-color:var(--amb)}
.pl .pip.trip{background:var(--red);border-color:var(--red)}
.pl .pip.pipover{width:auto;min-width:16px;padding:0 5px;background:var(--red);border-color:var(--red);color:#fff;font-size:10.5px;font-weight:800;line-height:16px;text-align:center}
.pl .strikebar .stxt{font-size:12.5px;color:var(--ink2)}
.pl .strikebar .stxt b{color:var(--ink)}
.pl .srow{grid-template-columns:minmax(0,1fr) 104px 84px}
.pl .stitle{display:block;min-width:0}
.pl .st.suspend{background:var(--ambbg);color:var(--amb);border-color:var(--ambln)}
.pl .st.expel{background:var(--redbg);color:var(--red);border-color:var(--redln)}
.pl .hrow{grid-template-columns:104px minmax(0,1fr) 118px 128px}
.pl .htitle{display:block;min-width:0}
/* payments — FIVE distinct status colours (each text/bg >=4.5, all five different hues) */
.pl .prow{grid-template-columns:minmax(0,1fr) 104px 92px}
.pl .ptitle2{display:block;min-width:0}
.pl .st.succeeded{background:var(--grnbg);color:#0f5132;border-color:var(--grnln)}
.pl .st.pending{background:var(--ambbg);color:#7a4a00;border-color:var(--ambln)}
.pl .st.refunded{background:var(--blubg);color:#123f74;border-color:var(--bluln)}
.pl .st.failed{background:var(--redbg);color:#8a1a16;border-color:var(--redln)}
.pl .st.disputed{background:#efe3fb;color:#5b1897;border-color:#d3b8f2}
.pl .pfoot{padding:10px 16px;border-top:1px solid var(--line);background:#fafcfb;font-size:12px;color:var(--ink3)}
.pl .pfoot.topline{border-top:0;border-bottom:1px solid var(--line)}
.pl .locked{font-style:italic}
.pl .acts{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.pl .sbtn{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:700;color:var(--ink2);cursor:pointer;min-height:34px;white-space:nowrap}
.pl .sbtn:hover:not(:disabled){background:#f6faf8}
.pl .sbtn:disabled{opacity:.45;cursor:not-allowed}
.pl .sbtn.go{background:#12301f;border-color:#12301f;color:#fff}
.pl .sbtn.go:hover:not(:disabled){background:#1b4630}
.pl .sbtn.danger{color:var(--red);border-color:var(--redln)}
.pl .sbtn.danger:hover:not(:disabled){background:var(--redbg)}
.pl .rowbtn{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:5px 10px;font:inherit;font-size:11.5px;font-weight:700;color:var(--red);cursor:pointer;min-height:32px;white-space:nowrap}
.pl .rowbtn:hover:not(:disabled){background:var(--redbg)}
.pl .rowbtn:disabled{opacity:.4;cursor:not-allowed;color:var(--ink3)}
.pl .foot{margin-top:2px;color:var(--ink3);font-size:12px;padding:6px 4px;line-height:1.5}
.pl .foot b{color:var(--ink2)}
.pl .scrim{position:fixed;inset:0;background:rgba(9,24,17,.42);display:flex;align-items:flex-start;justify-content:center;padding:32px 14px;z-index:60;overflow:auto}
.pl .modal{background:var(--card);border-radius:16px;width:100%;max-width:620px;box-shadow:0 24px 60px rgba(6,20,13,.34);overflow:hidden}
.pl .mhead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}
.pl .mhead h3{margin:0;font-size:16px;overflow-wrap:anywhere}
.pl .mclose{margin-left:auto;border:0;background:none;font-size:20px;line-height:1;color:var(--ink3);cursor:pointer;min-height:32px;min-width:32px}
.pl .mbody{padding:16px 18px}
.pl .mfoot{display:flex;gap:9px;align-items:center;padding:13px 18px;border-top:1px solid var(--line);background:#fafcfb;flex-wrap:wrap}
.pl .mfoot .spacer{flex:1 1 auto;min-width:0}
.pl .warn{display:block;padding:11px 13px;border-radius:10px;background:var(--ambbg);border:1px solid var(--ambln);color:#6b4400;font-size:12.5px;margin-bottom:13px}
.pl .warn b{display:block;margin-bottom:2px}
.pl .warn.hard{background:var(--redbg);border-color:var(--redln);color:#7d1a16}
.pl .plain{margin:0 0 4px;color:var(--ink2);font-size:13px}
.pl .fld{display:block;margin-bottom:13px}
.pl .fld.lbonly{margin-bottom:6px}
.pl .fld .lb{display:block;font-size:10px;font-weight:800;letter-spacing:.11em;color:var(--ink3);margin-bottom:5px}
.pl .fld input{width:100%;min-width:0;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit;background:#fbfdfc;color:var(--ink)}
.pl .fld input:focus{outline:2px solid var(--focus);outline-offset:-1px;background:#fff}
.pl .fld .help{display:block;margin-top:5px;font-size:11.5px;color:var(--ink3)}
.pl .mlist{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:11px}
.pl .mopt{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:var(--card);padding:10px 13px;font:inherit;color:inherit;cursor:pointer}
.pl .mopt:last-child{border-bottom:0}
.pl .mopt:hover:not(:disabled){background:#f7fbf9}
.pl .mopt[aria-pressed="true"]{background:var(--grnbg)}
.pl .mopt:disabled{opacity:.5;cursor:not-allowed}
.pl .mopt .l2{font-size:11.5px}
.pl .mopt .rt2{display:block;text-align:right;font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums;white-space:nowrap}
.pl .teams{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:11px;margin-top:6px}
.pl .team{border:1px solid var(--line);border-radius:11px;padding:11px 12px}
.pl .team h5{margin:0 0 3px;font-size:13px}
.pl .team .cap{display:block;font-size:11.5px;color:var(--ink3);margin-bottom:8px}
.pl .spots{display:flex;gap:6px;flex-wrap:wrap}
.pl .spot{border:1px solid var(--line);background:var(--card);border-radius:8px;min-width:34px;min-height:34px;padding:0 8px;font:inherit;font-size:12.5px;font-weight:700;color:var(--ink2);cursor:pointer;font-variant-numeric:tabular-nums}
.pl .spot:hover{background:#f6faf8}
.pl .spot[aria-pressed="true"]{background:#12301f;border-color:#12301f;color:#fff}
.pl .spot.sug{border-color:var(--grn);color:var(--grn)}
.pl .spot.sug[aria-pressed="true"]{background:var(--grn);border-color:var(--grn);color:#fff}
.pl .team .full{display:block;font-size:11.5px;color:var(--ink3);font-style:italic}
.pl .sugnote{display:block;margin-top:9px;font-size:12px;color:var(--ink3)}
.pl .summary{display:block;padding:12px 14px;border-radius:11px;background:var(--grnbg);border:1px solid var(--grnln);color:#0d4a2e;font-size:13px;margin-top:13px}
.pl .summary b{display:block;margin-bottom:3px}
.pl .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#12301f;color:#fff;padding:11px 18px;border-radius:11px;font-size:13.5px;font-weight:600;z-index:80;box-shadow:0 10px 26px rgba(6,20,13,.3);max-width:calc(100vw - 28px)}
@media (max-width:880px){
  .pl .facts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pl .memgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:640px){
  .pl .livetag{margin-left:0}
  .pl .res{grid-template-columns:minmax(0,1fr) auto;gap:6px 10px}
  .pl .res .c-email{grid-column:1;order:2}
  .pl .res .c-phone{grid-column:1;order:3}
  .pl .res .c-city{display:none}
  .pl .res .rtags{grid-column:2;grid-row:1;order:1}
  .pl .memgrid{grid-template-columns:1fr}
  .pl .mrow{grid-template-columns:minmax(0,1fr) 76px 84px}
  .pl .mrow .c-team{display:none}
  .pl .srow{grid-template-columns:minmax(0,1fr) 92px 76px}
  .pl .hrow{grid-template-columns:92px minmax(0,1fr) 96px}
  .pl .hrow .c-until{display:none}
  .pl .prow{grid-template-columns:minmax(0,1fr) 88px 80px}
  .pl .idtags{margin-left:0}
  .pl .acts{margin-left:0;width:100%}
  .pl .modal{max-width:none}
}

/* ── CREDIT ADJUSTMENT (Phase 27). Deliberately NOT alarm-coloured: this is a routine, logged,
   reversible-by-a-second-adjustment action, and dressing it in red would teach people to ignore
   red. The friction that matters is the required reason and the stated consequence, not the paint. */
.pl .credpanel{padding:0 0 13px}
.pl .credpanel h3{margin:0;padding:12px 14px;font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--ink3);border-bottom:1px solid var(--line)}
.pl .credbal{margin:11px 14px 0;font-size:13px;color:var(--ink2)}
.pl .credbal b{font-size:17px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums}
.pl .credlock{margin:8px 14px 0;font-size:11.5px;line-height:1.5;color:var(--ink3);background:#f4f7f5;border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.pl .credrow{display:flex;gap:9px;margin:10px 14px 0;flex-wrap:wrap}
.pl .credf{display:flex;flex-direction:column;gap:4px;min-width:140px}
.pl .credf.grow{flex:1;min-width:200px}
.pl .credf span{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--ink3)}
.pl .credf em{font-style:normal;font-weight:600;letter-spacing:0;color:var(--ink3);opacity:.85;margin-left:5px}
.pl .credf input{border:1px solid var(--line2);border-radius:9px;padding:9px 11px;font:inherit;font-size:13.5px;background:#fff;min-height:40px;width:100%}
.pl .credf input:disabled{background:#f4f7f5;color:var(--ink3);cursor:not-allowed}
.pl .credf input:focus{outline:2px solid var(--focus);outline-offset:-1px}
.pl .credconseq{margin:10px 14px 0;font-size:13px;line-height:1.5;color:var(--ink);background:#eef7f1;border:1px solid #a9d3ba;border-radius:9px;padding:9px 11px;font-weight:600}
.pl .crederrs{list-style:none;margin:8px 14px 0;padding:0;display:flex;flex-direction:column;gap:4px}
.pl .crederrs li{font-size:11.5px;line-height:1.45;color:#7a2a12;background:#fdf3ef;border:1px solid #e6c3b6;border-radius:8px;padding:7px 10px}
.pl .credacts{display:flex;align-items:center;gap:10px;margin:11px 14px 0;flex-wrap:wrap}
.pl .credbtn{border:1px solid #10603f;background:var(--grn,#146c43);color:#fff;border-radius:9px;padding:0 16px;min-height:40px;font:inherit;font-weight:700;cursor:pointer}
.pl .credbtn:disabled{opacity:.45;cursor:not-allowed}
.pl .credcap{font-size:11px;color:var(--ink3)}
.pl .credres{margin:10px 14px 0;font-size:12px;line-height:1.5;border-radius:9px;padding:9px 11px;border:1px solid var(--line);background:#f4f7f5}
.pl .credres b{font-weight:800;letter-spacing:.04em}
.pl .credres[data-verdict="LANDED"]{background:#eef7f1;border-color:#a9d3ba;color:#14512f}
.pl .credres[data-verdict="FAILED"],.pl .credres[data-verdict="NOT APPLIED"]{background:#fbeeec;border-color:#e6b7b0;color:#8a2018}
.pl .credres[data-verdict="UNKNOWN"],.pl .credres[data-verdict="ABORTED"]{background:#fdf8ee;border-color:#dcbc71;color:#6b4a09}
@media (max-width:560px){.pl .credrow{flex-direction:column}.pl .credf,.pl .credf.grow{min-width:0;width:100%}}
`;
