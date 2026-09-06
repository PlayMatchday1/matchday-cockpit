"use client";

/* THE PLAYER CONTEXT PANE — everything Player Lookup shows, beside the conversation.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT CHANGED. Its header comment explained the gaps: no
 * membership renewal date because "no renewal column exists", and no action buttons because there
 * was "no player-profile route", so "a button that bounces advertises a page you can't open".
 * BOTH WERE TRUE WHEN WRITTEN. Neither is true now — /match-ops/player-lookup exists, and
 * /admin/players/{id} carries the subscription's status, renewal, price and cancellation. The rule
 * was real and it expired; it is recorded here rather than deleted so the next person knows which.
 *
 * THE PANE IS FOR ANSWERING. A player wrote "Where's my match credit" and the reply was "Click
 * profile on the app and it will show your credits" — a redirect, not an answer, sent because this
 * pane showed matches played and no-shows and not the balance. His balance was $16.24. Two of the
 * three matches on the same pane were cancelled, on screen, while the number that would have
 * answered him was one page away.
 *
 * ONE REQUEST PER THREAD SWITCH. /api/crm/threads/{id}/context now assembles the lookup half too,
 * because you switch threads quickly and two round trips per switch will show.
 *
 * SHOW FACTS; DO NOT NARRATE CAUSES YOU HAVE NOT CHECKED. An earlier draft explained in the Credits
 * section where match credits come from. Nobody verified that claim, and a confident sentence about
 * somebody's billing is worse than no sentence. The Payments rows show the money; the operator
 * draws the conclusion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import CopyPhone from "@/components/CopyPhone";
import { colorForCity } from "@/lib/cityColors";
import { useAuth, canEditCredits } from "@/lib/useAuth";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { validateAdjustment, fmtUsd, REASON_REQUIRED } from "@/lib/creditsModel";
import {
  SECTION_IDS, SECTION_LABEL, accountSummary, creditsSummary, matchReason, matchesSummary,
  membershipSummary, paymentsSummary, readSectionState, sectionStorageKey, strikesSummary,
  REASON_LABEL, type SectionId, type Summary, type Tone,
} from "@/lib/paneSections";
import {
  MATCH_STATE_LABEL, MATCH_STATE_TONE, chargeLabel,
  type ChargeOnRow, type MatchState, type MatchTone,
} from "@/lib/matchHistory";

const ENV = FULL_EDITOR_ENV;

type RecentMatch = {
  venue: string | null; start_date: string | null; start_date_utc: string | null;
  city_identifier: string | null; status: "Played" | "Upcoming" | "No-show" | "Canceled";
};
type ProfileMatch = {
  umId: number | null; matchId: number | null; name: string;
  /** WALL CLOCK — display only, printed in UTC. */
  startDate: string | null;
  /** TRUE INSTANT — orders the list. Never formatted as a date. */
  startDateUtc: string | null;
  price: number; charged: number | null; userStatus: string | null;
  state: MatchState; mirrorOnly: boolean; charge?: ChargeOnRow | null;
};
type PaymentRow = {
  id: string; description: string; created: string; card: string | null;
  status: "succeeded" | "pending" | "refunded" | "failed" | "disputed";
  amount: number; matchId: string | null; isMembership: boolean;
};
type Profile = {
  player: {
    id: number | null; name: string; email: string | null; phone: string | null; city: string | null;
    level: number | null; registered: string | null; credits: number;
    status: "ok" | "suspended" | "expelled"; banReason: string | null; banExpiredAt: string | null;
    matchesPlayed: number; upcoming: number;
  };
  membership: { status: string; number: string | null; since: string | null; renews: string | null; canceledAt: string | null; price: number | null; city: string | null } | null;
  matches: ProfileMatch[];
  strikes: { activeCount: number; limit: number; isSuspended: boolean; suspendedTo: string | null };
  accountHistory: { action: "suspend" | "expel"; reason: string | null; when: string | null; until: string | null; by: string | null }[];
};
type ContextResponse = {
  player: { first_name: string | null; last_name: string | null; preferable_city_normalized: string | null;
    preferable_city_name: string | null; is_member: boolean | null; created_at: string | null; } | null;
  recent_matches: RecentMatch[];
  profile: Profile | null;
  payments: { ok: true; result: { rows: PaymentRow[]; customerMatched: boolean } } | { ok: false; error: string } | null;
};
type SearchRow = { id: number; name: string; email: string | null; phone: string | null; city: string | null };

const INK = "#12241d", MUTED = "#6d7b74", FAINT = "#93a49b", LINE = "#e6ebe8";
const TONE_COLOR: Record<Tone, string> = { plain: MUTED, amber: "#8a6300", red: "#a83b1c", info: "#4a539a" };
/* NEITHER CANCELLATION IS RED. "He cancelled" is amber — it may carry a strike. "We cancelled" is
 * informational: he did nothing wrong, and it is the row an operator points at about money. */
const PANE_TONE: Record<MatchTone, Tone> = { plain: "plain", amber: "amber", info: "info" };

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, cache: "no-store",
    headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" } });
}

const initialsOf = (f: string | null, l: string | null) =>
  (((f ?? "").trim()[0] ?? "") + ((l ?? "").trim()[0] ?? "") || "?").toUpperCase();
const monthYear = (iso: string | null) => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Date(Date.parse(iso)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};
/* WALL CLOCK, FORMATTED IN UTC — the same pairing Player Lookup uses (fmtWhen(m.startDate)).
 * MatchDay's startDate carries a Z it does not mean: it is the local clock at the pitch. Printed in
 * UTC, the characters come back out as they went in. The GENUINE UTC field must never be used for
 * a date here: Jose's cancelled Parmer match is 2026-09-05T20:00 local, 2026-09-06T01:00Z, and
 * preferring the UTC field printed it as Sunday Sep 6 for a match played on Saturday. */
const dayOf = (iso: string | null) => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Date(Date.parse(iso)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};

export default function ContextPane({ threadId, phone }: { threadId: string; phone?: string | null }) {
  const { appUser } = useAuth();
  const canCredit = canEditCredits(appUser);
  const [data, setData] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A locally-adjusted balance, so a credit applied here updates the pane without a refetch.
  const [liveCredits, setLiveCredits] = useState<number | null>(null);

  /* SECTION STATE IS A PREFERENCE, KEYED ON THE OPERATOR AND NEVER ON THE THREAD. Opening Payments
   * once during a run of billing questions leaves it open on the next conversation, which is the
   * whole of "while you are going chat to chat". */
  const storeKey = sectionStorageKey(appUser?.id ?? null);
  const [open, setOpen] = useState(() => readSectionState(null));
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (loadedKey.current === storeKey) return;
    loadedKey.current = storeKey;
    try { setOpen(readSectionState(window.localStorage.getItem(storeKey))); } catch { /* private mode */ }
  }, [storeKey]);
  const toggle = (id: SectionId) => setOpen((prev) => {
    const next = { ...prev, [id]: !prev[id] };
    try { window.localStorage.setItem(storeKey, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  useEffect(() => {
    let off = false;
    setData(null); setError(null); setLiveCredits(null);
    void (async () => {
      try {
        const res = await authFetch(`/api/crm/threads/${threadId}/context`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!off) setData((await res.json()) as ContextResponse);
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { off = true; };
  }, [threadId]);

  const mirror = data?.player ?? null;
  const prof = data?.profile ?? null;
  const linked = Boolean(mirror ?? prof);
  const payRows = data?.payments?.ok ? data.payments.result.rows : null;
  /* ONE LIST FOR THE SECTION AND ITS SUMMARY, and it is `profile.matches` — the same field Player
   * Lookup reads. The merge and the charge join moved into playerProfile.ts so both surfaces get
   * them; when they lived here, the pane could show a match the full page could not, and the
   * pane's own footer button sent the operator to that page. */
  const history = prof?.matches ?? [];
  const payError = data?.payments && !data.payments.ok ? data.payments.error : null;

  const cityCode = mirror?.preferable_city_normalized || null;
  const cityName = prof?.player.city || mirror?.preferable_city_name || cityCode || null;
  const joined = monthYear(prof?.player.registered ?? mirror?.created_at ?? null);
  const name = (prof?.player.name ?? (mirror ? `${mirror.first_name ?? ""} ${mirror.last_name ?? ""}`.trim() : "")) || "Player";
  const badge = cityCode ? colorForCity(cityCode) : MUTED;
  const credits = liveCredits ?? prof?.player.credits ?? null;

  return (
    <aside
      data-testid="ctx-pane"
      className="hidden min-h-0 w-[392px] shrink-0 flex-col overflow-y-auto border-l min-[1260px]:flex"
      style={{ background: "linear-gradient(180deg,#fafbfa,#f6f9f7)", borderColor: LINE }}
    >
      {/* PART 2 — SEARCH. Full box on an unlinked thread, one collapsed line on a linked one,
          because "my friend's account" is the same lookup. */}
      <Search compact={linked} />

      {!data && !error && (
        <div className="px-4 py-8 text-center text-[12px]" style={{ color: FAINT }}>Loading player…</div>
      )}
      {error && (
        <div className="m-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>
          Couldn&apos;t load player details.
        </div>
      )}
      {data && !linked && (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: MUTED }}>
          <div className="font-[760]" style={{ color: INK }}>Unknown number</div>
          <p className="mt-1 text-[11.5px]">No player account matched this number. Search above for the one they give you.</p>
          {phone && (
            <div className="mt-2 inline-flex items-center gap-0.5">
              <span className="font-mono text-[12px]" data-testid="ctx-phone-unknown" style={{ color: MUTED }}>{phone}</span>
              <CopyPhone value={phone} />
            </div>
          )}
        </div>
      )}

      {linked && (
        <>
          <header className="border-b px-4 pb-3 pt-4 text-center" style={{ borderColor: LINE }}>
            <div className="mx-auto mb-[9px] flex h-[52px] w-[52px] items-center justify-center rounded-full text-[16px] font-[780]"
              style={{ background: `${badge}1f`, color: badge, boxShadow: "0 0 0 4px rgba(255,255,255,.7)" }}>
              {initialsOf(mirror?.first_name ?? name.split(" ")[0] ?? null, mirror?.last_name ?? name.split(" ")[1] ?? null)}
            </div>
            <div className="text-[15px] font-[760] tracking-[-0.015em]" data-testid="ctx-name" style={{ color: INK }}>{name}</div>
            <div className="mt-[3px] text-[11.5px] font-semibold" style={{ color: MUTED }}>
              {[cityName, prof?.player.level != null ? `Level ${prof.player.level}` : null, joined ? `joined ${joined}` : null].filter(Boolean).join(" · ")}
            </div>
            {phone && (
              <div className="mt-[5px] inline-flex items-center justify-center gap-0.5">
                <span className="font-mono text-[11.5px]" data-testid="ctx-phone" style={{ color: MUTED }}>{phone}</span>
                <CopyPhone value={phone} />
              </div>
            )}
            <div className="mt-[9px] flex flex-wrap justify-center gap-[5px]">
              <span className="rounded-full border px-2 py-[2.5px] text-[10px] font-[780]"
                style={{ background: "#eef0fa", color: "#4a539a", borderColor: "#dde1f4" }}>
                {prof?.membership ? "Member" : mirror?.is_member ? "Member" : "Casual"}
              </span>
            </div>
          </header>

          {/* THREE HEADLINE NUMBERS, credits first because it is the commonest question in this
              inbox. No no-shows: nearly always zero, and it earns nothing in a strip this narrow. */}
          <div className="grid grid-cols-3 border-b" data-testid="ctx-headline" style={{ borderColor: LINE }}>
            {([
              ["credits", credits == null ? "—" : fmtUsd(credits)],
              // The API's played count, so the headline agrees with Player Lookup. The merged list
              // below adds only matches the API omits, and it omits none that were PLAYED.
              ["played", prof ? String(prof.player.matchesPlayed) : "—"],
              ["strikes", prof ? `${prof.strikes.activeCount}/${prof.strikes.limit}` : "—"],
            ] as const).map(([k, v]) => (
              <div key={k} className="px-2 py-[13px] text-center" data-testid={`ctx-head-${k}`}>
                <div className="text-[17px] font-[770] leading-[1.1] tracking-[-0.02em]" style={{ color: INK }}>{v}</div>
                <div className="mt-[2px] text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: FAINT }}>{k}</div>
              </div>
            ))}
          </div>

          {!prof && (
            <p className="px-4 py-3 text-[11.5px]" data-testid="ctx-profile-missing" style={{ color: "#8a6300" }}>
              The account details could not be read from MatchDay just now. The matches below come from our own mirror.
            </p>
          )}

          {prof && (
            <>
              <Section id="credits" summary={creditsSummary(credits)} open={open.credits} onToggle={toggle}>
                <CreditBox playerId={prof.player.id} playerName={prof.player.name} balanceCents={credits ?? 0}
                  canCredit={canCredit} onBalance={setLiveCredits} />
              </Section>

              <Section id="matches" summary={matchesSummary(history)} open={open.matches} onToggle={toggle}>
                {history.length === 0 && <Empty>No matches on record.</Empty>}
                {history.slice(0, 8).map((m) => (
                  <Line key={`${m.matchId}-${m.startDateUtc}`}
                    left={m.name}
                    /* THE WALL CLOCK, and the money. A row with no charge says "no charge found";
                       it never says $0.00, because zero is a claim about money this does not know.
                       Nothing here says a credit was ISSUED for the match — there is no per-match
                       credit record anywhere, only one balance on the player. */
                    sub={[dayOf(m.startDate ?? m.startDateUtc), chargeLabel(m), m.mirrorOnly ? "from our mirror" : null]
                      .filter(Boolean).join(" · ")}
                    right={m.userStatus === "NO_SHOW" && m.state === "played" ? "No-show" : MATCH_STATE_LABEL[m.state]}
                    tone={m.userStatus === "NO_SHOW" && m.state === "played" ? "amber" : PANE_TONE[MATCH_STATE_TONE[m.state]]} />
                ))}
              </Section>

              <Section id="membership" summary={membershipSummary(prof.membership)} open={open.membership} onToggle={toggle}>
                {!prof.membership ? <Empty>Pays per match. Nothing to renew, nothing to cancel.</Empty> : (
                  <>
                    <Fact k="Status" v={prof.membership.canceledAt ? `${prof.membership.status} at MatchDay` : prof.membership.status} />
                    {prof.membership.since && <Fact k="Since" v={dayOf(prof.membership.since)} />}
                    {prof.membership.canceledAt && <Fact k="Cancelled" v={dayOf(prof.membership.canceledAt)} />}
                    {prof.membership.renews && <Fact k={prof.membership.canceledAt ? "Ends" : "Renews"} v={dayOf(prof.membership.renews)} />}
                    {prof.membership.price != null && <Fact k="Price" v={fmtUsd(prof.membership.price)} />}
                  </>
                )}
              </Section>

              <Section id="payments" summary={paymentsSummary(payRows, payError)} open={open.payments} onToggle={toggle}>
                {payError && <Empty>{payError} Nothing was retried.</Empty>}
                {!payError && (payRows?.length ?? 0) === 0 && <Empty>No charges on file for this account.</Empty>}
                {(payRows ?? []).slice(0, 8).map((r) => (
                  <Line key={r.id}
                    left={r.description || (r.isMembership ? "Membership" : "Match spot")}
                    sub={`${dayOf(r.created)}${r.card ? ` · ${r.card}` : ""}`}
                    right={`${fmtUsd(r.amount)}${r.status === "succeeded" ? "" : ` · ${r.status}`}`}
                    tone={r.status === "failed" || r.status === "disputed" ? "red" : r.status === "refunded" ? "amber" : "plain"} />
                ))}
              </Section>

              <Section id="strikes" summary={strikesSummary(prof.strikes)} open={open.strikes} onToggle={toggle}>
                <Fact k="Active" v={`${prof.strikes.activeCount} of ${prof.strikes.limit} points`} />
                {prof.strikes.isSuspended && <Fact k="Suspended to" v={dayOf(prof.strikes.suspendedTo)} />}
                {prof.strikes.activeCount === 0 && <Empty>No active strikes.</Empty>}
              </Section>

              <Section id="account" summary={accountSummary(prof.player.status, prof.accountHistory)} open={open.account} onToggle={toggle}>
                {prof.accountHistory.length === 0 && <Empty>No ban on record. This reflects the current ban only, not a full audit trail.</Empty>}
                {prof.accountHistory.map((h, i) => (
                  <Line key={i} left={h.action === "expel" ? "Expelled" : "Suspended"}
                    sub={[h.reason, h.by ? `by ${h.by}` : null].filter(Boolean).join(" · ")}
                    right={h.until ? `until ${dayOf(h.until)}` : dayOf(h.when)} tone="red" />
                ))}
              </Section>
            </>
          )}

          {/* ONE FOOTER ACTION. Suspend, Expel, Remove from a match and Add to a match stay on the
              full page: they are severe or irreversible and should not be one click from a chat. */}
          {prof?.player.id != null && (
            <div className="mt-auto border-t px-4 py-3" style={{ borderColor: LINE }}>
              <a data-testid="ctx-open-lookup" href={`/match-ops/player-lookup?id=${prof.player.id}`}
                className="block rounded-[9px] border px-3 py-2 text-center text-[12px] font-[720]"
                style={{ borderColor: LINE, background: "#fff", color: INK }}>
                Open the full Player Lookup
              </a>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------

function Section({ id, summary, open, onToggle, children }: {
  id: SectionId; summary: Summary; open: boolean; onToggle: (id: SectionId) => void; children: React.ReactNode;
}) {
  return (
    <section className="border-b" data-testid={`ctx-section-${id}`} data-open={open ? 1 : 0} style={{ borderColor: LINE }}>
      <button type="button" onClick={() => onToggle(id)} data-testid={`ctx-toggle-${id}`}
        className="flex w-full items-center gap-2 px-4 py-[11px] text-left">
        <span className="text-[11px] font-extrabold uppercase tracking-[0.1em]" style={{ color: FAINT }}>{SECTION_LABEL[id]}</span>
        {/* THE SHUT SECTION'S ANSWER. Derived from the section's own data — see paneSections.ts. */}
        <span className="ml-auto truncate text-[11.5px] font-[720]" data-testid={`ctx-summary-${id}`} data-tone={summary.tone}
          style={{ color: TONE_COLOR[summary.tone] }}>{summary.text}</span>
        <span aria-hidden className="text-[10px]" style={{ color: FAINT }}>{open ? "▾" : "›"}</span>
      </button>
      {open && <div className="px-4 pb-[13px]">{children}</div>}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-1 text-[11.5px]" style={{ color: MUTED }}>{children}</p>
);

const Fact = ({ k, v }: { k: string; v: string }) => (
  <div className="flex items-baseline justify-between gap-3 py-[3px]">
    <span className="text-[11px] font-semibold" style={{ color: FAINT }}>{k}</span>
    <span className="text-[12px] font-[650]" style={{ color: INK }}>{v}</span>
  </div>
);

function Line({ left, sub, right, tone }: { left: string; sub: string; right: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-2 border-t py-[6px] first:border-t-0" style={{ borderColor: "#eff3f1" }}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-[650]" style={{ color: INK }}>{left}</span>
        {sub && <span className="block truncate text-[10.5px] font-semibold" style={{ color: MUTED }}>{sub}</span>}
      </span>
      <span className="flex-none text-[10.5px] font-[780]" data-tone={tone} style={{ color: TONE_COLOR[tone] }}>{right}</span>
    </div>
  );
}

/* ── THE ONE WRITE ─────────────────────────────────────────────────────────────────────────────
 * The credit adjustment, and nothing else, because it is the answer to the commonest question in
 * this inbox. Every guard the Player Lookup panel carries comes with it, unchanged: a reason is
 * required, the amount is capped, one attempt with no retry on any outcome, and the route re-checks
 * the permission and the balance server-side against a fresh read. */
function CreditBox({ playerId, playerName, balanceCents, canCredit, onBalance }: {
  playerId: number | null; playerName: string; balanceCents: number; canCredit: boolean; onBalance: (c: number) => void;
}) {
  const [amt, setAmt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [res, setRes] = useState<{ verdict: string; text: string } | null>(null);

  const v = validateAdjustment({ raw: amt, reason, beforeCents: balanceCents, playerName, canEdit: canCredit });
  const shown = v.errors.filter((e) => e !== REASON_REQUIRED || attempted);

  const apply = useCallback(async () => {
    if (!v.ok || v.deltaCents == null || busy || playerId == null) return;
    setBusy(true); setRes(null);
    try {
      // ONE ATTEMPT, no retry on any outcome — a retry is a second money movement nobody asked for.
      const r = await authFetch(`/api/matchday/${ENV}/players/${playerId}/credits`, {
        method: "POST",
        body: JSON.stringify({ deltaCents: v.deltaCents, expectedBeforeCents: balanceCents, reason: reason.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.aborted) {
        if (typeof j.balanceCents === "number") onBalance(j.balanceCents);
        setRes({ verdict: "ABORTED", text: String(j.error) }); return;
      }
      if (!r.ok) { setRes({ verdict: j.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILED", text: String(j.error ?? `HTTP ${r.status}`) }); return; }
      if (typeof j.balanceCents === "number") onBalance(j.balanceCents);
      if (j.landed) {
        setRes({ verdict: "LANDED", text: `Balance is now ${fmtUsd(j.balanceCents)}. Logged with your reason.` });
        setAmt(""); setReason(""); setAttempted(false);
      } else {
        setRes({ verdict: "NOT APPLIED", text: `The server accepted the write but a re-read shows ${fmtUsd(j.balanceCents)}. Nothing was retried.` });
      }
    } catch (e) {
      setRes({ verdict: "UNKNOWN", text: `${e instanceof Error ? e.message : String(e)} — it may or may not have landed. Nothing was retried.` });
    } finally { setBusy(false); }
  }, [v.ok, v.deltaCents, busy, playerId, balanceCents, reason, onBalance]);

  return (
    <div data-testid="ctx-credit">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <span className="text-[11px] font-semibold" style={{ color: FAINT }}>Balance</span>
        <span className="text-[13px] font-[760]" data-testid="ctx-credit-balance" data-cents={balanceCents} style={{ color: INK }}>{fmtUsd(balanceCents)}</span>
      </div>
      {!canCredit ? (
        <p className="text-[11.5px]" data-testid="ctx-credit-locked" style={{ color: MUTED }}>
          Adjusting credits needs <b>EDIT CREDITS</b>, which is granted separately from Match Ops.
        </p>
      ) : (
        <>
          <div className="flex gap-2">
            <input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="+25 or -10" inputMode="decimal"
              data-testid="ctx-credit-amount" aria-label="Adjustment"
              className="w-[92px] rounded-[8px] border px-2 py-[6px] text-[12px]" style={{ borderColor: LINE, color: INK }} />
            <input value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setAttempted(true)}
              placeholder="Reason — written to the change log" data-testid="ctx-credit-reason" aria-label="Reason"
              className="min-w-0 flex-1 rounded-[8px] border px-2 py-[6px] text-[12px]" style={{ borderColor: LINE, color: INK }} />
          </div>
          {v.consequence && <p className="mt-2 text-[11.5px]" data-testid="ctx-credit-sentence" style={{ color: MUTED }}>{v.consequence}</p>}
          {shown.map((e) => (
            <p key={e} className="mt-1 text-[11.5px] font-semibold" data-testid="ctx-credit-error" style={{ color: "#a83b1c" }}>{e}</p>
          ))}
          <button type="button" data-testid="ctx-credit-apply" disabled={!v.ok || busy}
            onClick={() => { setAttempted(true); void apply(); }}
            className="mt-2 rounded-[8px] px-3 py-[6px] text-[12px] font-[720] disabled:opacity-40"
            style={{ background: INK, color: "#fff" }}>
            {busy ? "Applying…" : "Apply"}
          </button>
          {res && (
            <p className="mt-2 text-[11.5px] font-semibold" data-testid="ctx-credit-result" data-verdict={res.verdict}
              style={{ color: res.verdict === "LANDED" ? "#12704a" : "#a83b1c" }}>{res.verdict} — {res.text}</p>
          )}
        </>
      )}
    </div>
  );
}

/* ── PART 2: SEARCH ────────────────────────────────────────────────────────────────────────────
 * A thread's number often resolves to nobody and the player then gives you a different one. There
 * was nowhere to type it: the pane rendered "Unknown number" and stopped.
 *
 * LOOKING UP IS NOT LINKING. Picking a result shows that account so you can answer. It does not
 * touch crm_threads.player_id, and nothing in this repo can: /api/crm/threads/[id]/ holds assign
 * (an OPERATOR, not a player), context, follow-up, mark-read, no-reply and status. No route writes
 * that column. Linking would change who every future message on the number is attributed to, and it
 * is the one action here that can show one player another player's membership and match history —
 * so it is a separate route, a separate audit row and a separate decision. */
function Search({ compact }: { compact: boolean }) {
  const [openBox, setOpenBox] = useState(!compact);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => { setOpenBox(!compact); }, [compact]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRows(null); setErr(null); return; }
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      setBusy(true); setErr(null);
      try {
        const res = await authFetch(`/api/lookup/${ENV}?q=${encodeURIComponent(term)}`);
        const j = await res.json();
        if (my !== seq.current) return;
        if (!res.ok) { setErr(j?.error || `Search failed (${res.status})`); setRows([]); return; }
        setRows((j.results ?? []) as SearchRow[]);
      } catch (e) {
        if (my === seq.current) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
      } finally { if (my === seq.current) setBusy(false); }
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const results = useMemo(() => (rows ?? []).map((r) => ({ row: r, reason: matchReason(q, r) })), [rows, q]);

  if (compact && !openBox) {
    return (
      <button type="button" data-testid="ctx-search-open" onClick={() => setOpenBox(true)}
        className="flex w-full items-center gap-2 border-b px-4 py-[9px] text-left text-[11.5px] font-semibold"
        style={{ borderColor: LINE, color: FAINT }}>
        <span aria-hidden>⌕</span> Look up another account
      </button>
    );
  }

  return (
    <div className="border-b px-4 py-3" data-testid="ctx-search" style={{ borderColor: LINE }}>
      <div className="flex items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
          placeholder="Phone, email, name or player ID" data-testid="ctx-search-input" aria-label="Search for a player"
          className="min-w-0 flex-1 rounded-[8px] border px-2 py-[6px] text-[12px]" style={{ borderColor: LINE, color: INK }} />
        {compact && (
          <button type="button" data-testid="ctx-search-close" onClick={() => { setOpenBox(false); setQ(""); setRows(null); }}
            className="text-[11px] font-[720]" style={{ color: MUTED }}>Close</button>
        )}
      </div>
      {busy && <p className="mt-2 text-[11px]" style={{ color: FAINT }}>Searching…</p>}
      {err && <p className="mt-2 text-[11.5px] font-semibold" style={{ color: "#a83b1c" }}>{err}</p>}
      {rows && rows.length === 0 && !busy && !err && (
        <p className="mt-2 text-[11.5px]" style={{ color: MUTED }}>Nothing matched that.</p>
      )}
      {results.length > 0 && (
        <div className="mt-2" data-testid="ctx-search-results">
          {results.slice(0, 6).map(({ row, reason }) => (
            <a key={row.id} href={`/match-ops/player-lookup?id=${row.id}`} data-testid={`ctx-search-result-${row.id}`}
              className="flex items-center gap-2 border-t py-[7px] first:border-t-0" style={{ borderColor: "#eff3f1" }}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-[650]" style={{ color: INK }}>{row.name}</span>
                <span className="block truncate text-[10.5px] font-semibold" style={{ color: MUTED }}>
                  {[row.city, row.phone].filter(Boolean).join(" · ")}
                </span>
              </span>
              {/* WHY IT MATCHED. A list of names with no reason is a guess dressed as a
                  recommendation, and the operator is deciding whether a number read out over the
                  phone really belongs to this account. */}
              <span className="flex-none rounded-full px-[7px] py-[2px] text-[9.5px] font-[780]"
                data-testid="ctx-search-reason" data-reason={reason}
                style={{ background: "#eef0fa", color: "#4a539a" }}>{REASON_LABEL[reason]}</span>
            </a>
          ))}
          <p className="mt-2 text-[11px]" data-testid="ctx-search-note" style={{ color: FAINT }}>
            Opening a result shows you that account. It does not link this conversation to it.
          </p>
        </div>
      )}
    </div>
  );
}
