"use client";

// PLAYER DETAILS, docked on the right at 400px (Figma 20855:44); a full-screen panel with a back
// arrow below 1024px (Ryan 2026-11-06 — the old Info button did nothing there).
//
// Tabs: Activity, Matches, Payments, Credits, Account. Everything comes from the one context read
// the strip already made (useThreadContext) and the App activity read Player Lookup uses
// (useAppActivity, app_request_log). Activity shows only what that log holds.
//
// Same rules as ContextPane: show facts, never narrate causes; match dates are WALL CLOCK printed
// in UTC (dayOf); the one write is the credit adjustment (CreditBox, the guarded route); the severe
// account actions stay on the full Player Lookup page, one click away, not here.

import { useMemo, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import { useAuth, canEditCredits, canViewActivity } from "@/lib/useAuth";
import { isAction, matchLine, timeIn, ymdIn, type Item, type MatchInfo } from "@/lib/appActivity";
import { zoneOfCity } from "@/lib/matchTimezone";
import { fmtUsd } from "@/lib/creditsModel";
import { MATCH_STATE_LABEL, MATCH_STATE_TONE, chargeLabel } from "@/lib/matchHistory";
import { membershipLevel } from "@/lib/inbox2Model";
import CopyPhone from "@/components/CopyPhone";
import { CreditBox, Empty, Fact, Line, LinkAccount, PANE_TONE, Search, dayOf, monthYear } from "../components/ContextPane";
import type { ThreadContext } from "./useThreadContext";

export type DetailsTab = "activity" | "matches" | "payments" | "credits" | "account";
const TABS: { key: DetailsTab; label: string }[] = [
  { key: "activity", label: "Activity" }, { key: "matches", label: "Matches" }, { key: "payments", label: "Payments" },
  { key: "credits", label: "Credits" }, { key: "account", label: "Account" },
];
const INK = "#13241d", MUTED = "#5e6b66", FAINT = "#7c8782", LINE = "#e3e3db";

export type ActivityState = { phase: "loading" } | { phase: "error"; error: string } | { phase: "ok"; items: Item[]; matches: Record<number, MatchInfo> } | null;

export default function DetailsPanel({ threadId, phone, playerId, name, ctx, tab, onTab, onClose, activity }: {
  threadId: string; phone: string; playerId: number | null; name: string;
  ctx: ThreadContext; tab: DetailsTab; onTab: (t: DetailsTab) => void; onClose: () => void;
  /** The one App activity read, made by the page and shared with the strip's activity line. */
  activity: ActivityState;
}) {
  const { appUser } = useAuth();
  const prof = ctx.data?.profile ?? null;
  const mirror = ctx.data?.player ?? null;
  const linked = Boolean(prof ?? mirror);
  const activityPlayer = playerId ?? prof?.player.id ?? null;
  const cityName = prof?.player.city || mirror?.preferable_city_name || mirror?.preferable_city_normalized || null;

  return (
    <aside data-testid="details-panel"
      className="fixed inset-0 z-50 flex flex-col bg-white lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l"
      style={{ borderColor: LINE }}>
      <div className="flex items-center gap-2 px-5 pt-5 lg:px-5">
        <button type="button" onClick={onClose} aria-label="Back to the conversation" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-[#5e6b66] lg:hidden">
          <ChevronLeft aria-hidden className="h-5 w-5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[17px] font-bold" style={{ color: INK }} data-testid="details-name">{name}</span>
        <button type="button" data-testid="details-close" onClick={onClose} aria-label="Close player details" className="hidden h-8 w-8 items-center justify-center rounded-full text-[#5e6b66] hover:bg-[#f3f3ef] lg:flex">
          <X aria-hidden className="h-[18px] w-[18px]" />
        </button>
      </div>
      <div role="tablist" className="mt-3 flex gap-5 overflow-x-auto border-b px-5" style={{ borderColor: LINE }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} data-testid={`details-tab-${t.key}`} onClick={() => onTab(t.key)}
            className={`-mb-px whitespace-nowrap border-b-2 pb-[10px] text-[13px] ${tab === t.key ? "border-[#0e3b2c] font-semibold text-[#13241d]" : "border-transparent font-medium text-[#7c8782]"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!ctx.data && !ctx.error && <p className="py-6 text-center text-[12px]" style={{ color: FAINT }}>Loading player…</p>}
        {ctx.error && <p className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>Couldn&apos;t load player details ({ctx.error}).</p>}
        {ctx.data && tab === "activity" && (
          canViewActivity(appUser)
            ? activityPlayer != null
              ? <ActivityTab playerId={activityPlayer} city={cityName} state={activity} />
              : <Empty>No linked account, so there is no app activity to show. Link one on the Account tab.</Empty>
            : <Empty>App activity needs <b>VIEW ACTIVITY</b>.</Empty>
        )}
        {ctx.data && tab === "matches" && (
          !prof ? <Unread /> : (
            <>
              {prof.matches.length === 0 && <Empty>No matches on record.</Empty>}
              {prof.matches.slice(0, 20).map((m) => (
                <Line key={`${m.matchId}-${m.startDateUtc}`} left={m.name}
                  sub={[dayOf(m.startDate ?? m.startDateUtc), chargeLabel(m), m.mirrorOnly ? "from our mirror" : null].filter(Boolean).join(" · ")}
                  right={m.userStatus === "NO_SHOW" && m.state === "played" ? "No-show" : MATCH_STATE_LABEL[m.state]}
                  tone={m.userStatus === "NO_SHOW" && m.state === "played" ? "amber" : PANE_TONE[MATCH_STATE_TONE[m.state]]} />
              ))}
              <LookupLink id={prof.player.id} label="All matches in Player Lookup ›" />
            </>
          )
        )}
        {ctx.data && tab === "payments" && (() => {
          const p = ctx.data.payments;
          const rows = p?.ok ? p.result.rows : null;
          return (
            <>
              {p && !p.ok && <Empty>{p.error} Nothing was retried.</Empty>}
              {p?.ok && (rows?.length ?? 0) === 0 && <Empty>No charges on file for this account.</Empty>}
              {!p && <Empty>No payments read for this conversation.</Empty>}
              {(rows ?? []).slice(0, 20).map((r) => (
                <Line key={r.id} left={r.description || (r.isMembership ? "Membership" : "Match spot")}
                  sub={`${dayOf(r.created)}${r.card ? ` · ${r.card}` : ""}`}
                  right={`${fmtUsd(r.amount)}${r.status === "succeeded" ? "" : ` · ${r.status}`}`}
                  tone={r.status === "failed" || r.status === "disputed" ? "red" : r.status === "refunded" ? "amber" : "plain"} />
              ))}
            </>
          );
        })()}
        {ctx.data && tab === "credits" && (
          !prof ? <Unread /> : (
            <CreditBox playerId={prof.player.id} playerName={prof.player.name} balanceCents={ctx.credits ?? 0}
              canCredit={canEditCredits(appUser)} onBalance={ctx.setLiveCredits} />
          )
        )}
        {ctx.data && tab === "account" && (
          <div className="flex flex-col gap-3">
            {linked ? (
              <div>
                <Fact k="Name" v={prof?.player.name ?? name} />
                <Fact k="Plays as" v={membershipLevel(Boolean(prof?.membership ?? mirror?.is_member), prof?.player.level)} />
                {cityName && <Fact k="City" v={cityName} />}
                {monthYear(prof?.player.registered ?? mirror?.created_at ?? null) && <Fact k="Joined" v={monthYear(prof?.player.registered ?? mirror?.created_at ?? null) as string} />}
                <div className="flex items-baseline justify-between gap-3 py-[3px]">
                  <span className="text-[11px] font-semibold" style={{ color: "#93a49b" }}>Phone</span>
                  <span className="inline-flex items-center gap-0.5 font-mono text-[12px]" style={{ color: INK }}>{phone}<CopyPhone value={phone} /></span>
                </div>
                {(mirror?.email ?? prof?.player.email) && (
                  <div className="flex items-baseline justify-between gap-3 py-[3px]">
                    <span className="text-[11px] font-semibold" style={{ color: "#93a49b" }}>Email</span>
                    <span className="inline-flex min-w-0 items-center gap-0.5 text-[12px]" style={{ color: INK }}>
                      <span className="truncate">{mirror?.email ?? prof?.player.email}</span><CopyPhone value={(mirror?.email ?? prof?.player.email) as string} noun="email" testId="copy-email" />
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="text-[13px] font-semibold" style={{ color: INK }}>Unknown number</div>
                <p className="mt-1 text-[12px]" style={{ color: MUTED }}>No player account matched this number. Ask for the phone number on their account, then link it here.</p>
              </div>
            )}
            <LinkAccount threadId={threadId} linked={linked} />
            {prof && (
              <>
                <Group title="Membership">
                  {!prof.membership ? <Empty>Pays per match. Nothing to renew, nothing to cancel.</Empty> : (
                    <>
                      <Fact k="Status" v={prof.membership.canceledAt ? `${prof.membership.status} at MatchDay` : prof.membership.status} />
                      {prof.membership.since && <Fact k="Since" v={dayOf(prof.membership.since)} />}
                      {prof.membership.canceledAt && <Fact k="Cancelled" v={dayOf(prof.membership.canceledAt)} />}
                      {prof.membership.renews && <Fact k={prof.membership.canceledAt ? "Ends" : "Renews"} v={dayOf(prof.membership.renews)} />}
                      {prof.membership.price != null && <Fact k="Price" v={fmtUsd(prof.membership.price)} />}
                    </>
                  )}
                </Group>
                <Group title="Strikes">
                  <Fact k="Active" v={`${prof.strikes.activeCount} of ${prof.strikes.limit} points`} />
                  {prof.strikes.isSuspended && <Fact k="Suspended to" v={dayOf(prof.strikes.suspendedTo)} />}
                </Group>
                <Group title="Account status">
                  {prof.accountHistory.length === 0 && <Empty>No ban on record. This reflects the current ban only, not a full audit trail.</Empty>}
                  {prof.accountHistory.map((h, i) => (
                    <Line key={i} left={h.action === "expel" ? "Expelled" : "Suspended"}
                      sub={[h.reason, h.by ? `by ${h.by}` : null].filter(Boolean).join(" · ")}
                      right={h.until ? `until ${dayOf(h.until)}` : dayOf(h.when)} tone="red" />
                  ))}
                </Group>
              </>
            )}
            {!prof && linked && <Unread />}
            <div className="-mx-5 border-t" style={{ borderColor: LINE }}><Search compact={linked} /></div>
            {prof?.player.id != null && <LookupLink id={prof.player.id} label="Open the full Player Lookup ›" />}
          </div>
        )}
      </div>
    </aside>
  );
}

const Unread = () => (
  <p className="py-2 text-[12px]" style={{ color: "#8a6300" }} data-testid="details-profile-missing">
    The account details could not be read from MatchDay just now.
  </p>
);

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 text-[10px] font-semibold tracking-[0.08em]" style={{ color: FAINT }}>{title.toUpperCase()}</div>
      {children}
    </section>
  );
}

function LookupLink({ id, label, activity }: { id: number | null; label: string; activity?: boolean }) {
  if (id == null) return null;
  return (
    <a href={`/match-ops/player-lookup?id=${id}${activity ? "&activity=open" : ""}`} data-testid={activity ? "details-activity-all" : undefined}
      className="mt-3 block text-[12px] font-semibold" style={{ color: "#0e3b2c" }}>{label}</a>
  );
}

// ── ACTIVITY: the App activity read Player Lookup uses, actions only, grouped by day in the
// player's city zone (Central when the city has none). Failures are red with their reason.
function ActivityTab({ playerId, city, state }: { playerId: number; city: string | null; state: ActivityState }) {
  const tz = zoneOfCity(city) ?? "America/Chicago";
  const items = useMemo(() => (state?.phase === "ok" ? state.items.filter(isAction) : []), [state]);
  const matches = state?.phase === "ok" ? state.matches : {};
  const days = useMemo(() => {
    const out: { ymd: string; label: string; items: typeof items }[] = [];
    const today = ymdIn(new Date().toISOString(), tz);
    const yest = ymdIn(new Date(Date.now() - 86_400_000).toISOString(), tz);
    for (const it of items.slice(0, 40)) {
      const ymd = ymdIn(it.ts, tz);
      let d = out[out.length - 1];
      if (!d || d.ymd !== ymd) {
        const noon = new Date(`${ymd}T12:00:00Z`);
        const label = ymd === today ? "TODAY" : ymd === yest ? "YESTERDAY"
          : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(noon).toUpperCase();
        d = { ymd, label, items: [] }; out.push(d);
      }
      d.items.push(it);
    }
    return out;
  }, [items, tz]);
  if (!state || state.phase === "loading") return <p className="text-[12px]" style={{ color: FAINT }}>Loading…</p>;
  if (state.phase === "error") return <p className="text-[12px]" style={{ color: "#b3241f" }}>Couldn&apos;t load app activity: {state.error}</p>;
  return (
    <div data-testid="details-activity">
      {!items.length && <Empty>No app activity in the last 30 days.</Empty>}
      {days.map((d) => (
        <div key={d.ymd} className="mb-2">
          <div className="border-b pb-2 pt-1 text-[10px] font-semibold tracking-[0.08em]" style={{ color: FAINT, borderColor: LINE }}>{d.label}</div>
          {d.items.map((i) => (
            <div key={i.id} data-testid="details-activity-row" data-failed={i.failed ? "1" : "0"} className="flex gap-3 border-b py-[10px]" style={{ borderColor: "#efefea" }}>
              <span className="w-[64px] shrink-0 text-[12px]" style={{ color: MUTED }}>{timeIn(i.ts, tz)}</span>
              <span className="mt-[5px] inline-block h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: i.failed ? "#d64531" : "#2cdb87" }} />
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] font-semibold ${i.known ? "" : "font-mono"}`} style={{ color: i.failed ? "#d64531" : INK }}>{i.title}</span>
                {(i.matchRef != null || i.detail) && (
                  <span className="block text-[12px]" style={{ color: MUTED }}>{i.matchRef != null ? matchLine(matches[i.matchRef], i.matchRef) : i.detail}</span>
                )}
                {i.failed && i.reason && <span className="block text-[12px]" style={{ color: MUTED }}>{i.reason}</span>}
              </span>
            </div>
          ))}
        </div>
      ))}
      <LookupLink id={playerId} label="Open full activity in Player Lookup ›" activity />
    </div>
  );
}
