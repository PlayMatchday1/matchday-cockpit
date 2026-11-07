"use client";

// MEMBERSHIP HISTORY, drawn. Figma 9TgSk4sYqq4nNoTH73wRRs, page "Clubhouse · Membership History":
//   layout="full"     Player Lookup's Membership card (20865:45)
//   layout="compact"  Player Chats details › Membership (20865:183)
//   the states        never a member, ended (Retool), past due (20865:285)
// Everything on screen comes from buildMembershipHistory (src/lib/membershipHistory.ts); this file
// only draws it. useMembershipHistory makes the one read (/api/lookup/{env}/membership-history).

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  buildMembershipHistory, money, type History, type HistItem, type InvoiceRow, type LiveMembership,
  type MembershipBlock, type RefundRow, type SubRow, type UnpaidRow, type Tone, type CellKind, type NowTone,
} from "@/lib/membershipHistory";

const INK = "#13241d", MUTED = "#5e6b66", FAINT = "#7c8782", LINE = "#e3e3db";
const CELL: Record<CellKind, string> = { first: "#a5ebc8", paid: "#2cdb87", none: "#e3e3db", refunded: "#d64531", failed: "#f0a63a" };
const DOT: Record<Tone, string> = { green: "#2cdb87", amber: "#c98a0b", red: "#d64531", grey: "#9aa39f" };
const BADGE_STYLE: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: "#e3f7ec", fg: "#0e6b3f" },
  CANCELLING: { bg: "#fdf1d0", fg: "#8a6300" },
  ENDED: { bg: "#efefea", fg: "#5e6b66" },
  "PAST DUE": { bg: "#fde4e1", fg: "#b3241f" },
  COMPED: { bg: "#e8eefc", fg: "#2f4fa3" },
};
const NOW_COLOR: Record<NowTone, string> = { ok: INK, warn: "#8a6300", bad: "#b3241f", none: INK };
const BANNER: Record<NowTone, { bg: string; fg: string }> = {
  ok: { bg: "#ebf8f1", fg: INK }, warn: { bg: "#fdf6e3", fg: "#6b4d00" }, bad: { bg: "#fdecea", fg: "#8f1d18" }, none: { bg: "#f3f3ef", fg: INK },
};

async function authFetch(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
}

export type HistoryRead =
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | { phase: "ok"; rows: SubRow[]; invoices: InvoiceRow[]; refunds: RefundRow[]; unpaid: UnpaidRow[]; syncedAt: string | null };

/** The one read. `reloadKey` re-reads after a membership write on the card. */
export function useMembershipHistory(env: string, playerId: number | null, reloadKey = 0): HistoryRead | null {
  const [state, setState] = useState<HistoryRead | null>(null);
  useEffect(() => {
    if (playerId == null) { setState(null); return; }
    let live = true;
    setState({ phase: "loading" });
    (async () => {
      try {
        const res = await authFetch(`/api/lookup/${env}/membership-history?id=${playerId}`);
        const j = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok || j?.ok !== true) setState({ phase: "error", error: j?.error || `Failed (${res.status})` });
        else setState({ phase: "ok", rows: j.rows ?? [], invoices: j.invoices ?? [], refunds: j.refunds ?? [], unpaid: j.unpaid ?? [], syncedAt: j.syncedAt ?? null });
      } catch (e) { if (live) setState({ phase: "error", error: e instanceof Error ? e.message : String(e) }); }
    })();
    return () => { live = false; };
  }, [env, playerId, reloadKey]);
  return state;
}

export function useBuiltHistory(read: HistoryRead | null, live: LiveMembership): History | null {
  return useMemo(() => (read?.phase === "ok"
    ? buildMembershipHistory({ rows: read.rows, invoices: read.invoices, refunds: read.refunds, unpaid: read.unpaid, live, now: new Date(), syncedAt: read.syncedAt })
    : null), [read, live]);
}

function Badge({ text }: { text: string }) {
  if (!text) return null;
  const s = BADGE_STYLE[text] ?? BADGE_STYLE.ENDED;
  return <span data-testid="mh-badge" className="inline-flex items-center rounded-full px-2 py-[2px] text-[10.5px] font-bold tracking-[0.06em]" style={{ background: s.bg, color: s.fg }}>{text}</span>;
}

function Strip({ cells, labels }: { cells: MembershipBlock["strip"]; labels: boolean }) {
  if (!cells.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-[4px] gap-y-[6px]" data-testid="mh-strip">
      {cells.map((c) => (
        <div key={c.ym} className="flex w-[26px] flex-col items-center" title={c.title}>
          <span data-kind={c.kind} className="block h-[10px] w-[26px] rounded-[3px]" style={{ background: CELL[c.kind] }} />
          {labels && <span className="mt-[3px] text-[9.5px]" style={{ color: FAINT }}>{c.label}</span>}
        </div>
      ))}
    </div>
  );
}

function Block({ b, compact }: { b: MembershipBlock; compact: boolean }) {
  return (
    <section data-testid="mh-block" data-state={b.state} className={`rounded-xl border bg-white ${compact ? "px-3 py-3" : "px-4 py-4"}`} style={{ borderColor: LINE }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`${compact ? "text-[13.5px]" : "text-[14.5px]"} font-bold`} style={{ color: INK }}>Membership {b.n}</span>
        <Badge text={b.badge} />
        <span className={`${compact ? "basis-full sm:basis-auto sm:ml-auto" : "basis-full sm:basis-auto sm:ml-auto"} whitespace-nowrap text-[12px]`} style={{ color: MUTED }}>{b.range}</span>
      </div>
      <Strip cells={b.strip} labels={!compact} />
      <ul className="mt-3 flex flex-col gap-3">
        {b.events.map((e) => (
          <li key={e.key} className="flex gap-3" data-testid="mh-event" data-key={e.key}>
            <span className="mt-[6px] inline-block h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: DOT[e.tone] }} />
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold" style={{ color: INK }}>{e.title}</span>
              {e.quote && <span className="block text-[12px] italic" style={{ color: MUTED }}>&ldquo;{e.quote}&rdquo;</span>}
              {e.sub && <span className="block text-[12px]" style={{ color: MUTED }}>{e.sub}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Items({ items, compact }: { items: HistItem[]; compact: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => it.type === "membership"
        ? <Block key={`m${it.block.membershipId}`} b={it.block} compact={compact} />
        : (
          <div key={`g${i}`} data-testid="mh-gap" className="flex items-center gap-3 px-4 py-1 text-[12px] italic" style={{ color: FAINT }}>
            <span aria-hidden className="h-4 border-l border-dashed" style={{ borderColor: "#b9c0bc" }} />{it.text}
          </div>
        ))}
    </div>
  );
}

function Legend() {
  const k: [CellKind, string][] = [["first", "First charge"], ["paid", "Paid month"], ["failed", "Not paid"], ["none", "No charge"], ["refunded", "Refunded"]];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]" style={{ color: MUTED }}>
      {k.map(([kind, label]) => (
        <span key={kind} className="inline-flex items-center gap-1.5"><span className="inline-block h-[9px] w-[9px] rounded-[2px]" style={{ background: CELL[kind] }} />{label}</span>
      ))}
    </div>
  );
}

function Stat({ k, v, sub, color }: { k: string; v: React.ReactNode; sub?: React.ReactNode; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-semibold tracking-[0.08em]" style={{ color: FAINT }}>{k}</div>
      <div className="mt-0.5 text-[19px] font-bold leading-tight" style={{ color: color ?? INK }}>{v}</div>
      {sub && <div className="mt-0.5 text-[12px]" style={{ color: MUTED }}>{sub}</div>}
    </div>
  );
}

/** Player Lookup's Membership card body. `actions` is the card's Actions menu, unchanged writes. */
export function MembershipHistoryFull({ read, history, neverLine, actions, notes }: {
  read: HistoryRead | null; history: History | null; neverLine: string;
  actions?: React.ReactNode; notes?: React.ReactNode;
}) {
  const h = history;
  const current = h && !h.never && (h.now.title === "Active" || h.now.title === "Cancelling" || h.now.title === "Comped" || h.now.badge === "PAST DUE");
  const s = h?.summary;
  return (
    <div data-testid="mh-full" className="rounded-2xl border bg-white px-4 py-4 sm:px-5" style={{ borderColor: LINE }}>
      <div className="flex items-center gap-3">
        <h3 className="m-0 text-[11.5px] font-bold tracking-[0.1em]" style={{ color: MUTED }}>MEMBERSHIP</h3>
        <div className="ml-auto">{actions}</div>
      </div>
      {(!read || read.phase === "loading") && <p className="py-4 text-[12.5px]" style={{ color: FAINT }}>Loading membership history…</p>}
      {read?.phase === "error" && <p data-testid="mh-error" className="mt-3 rounded-lg border px-3 py-2 text-[12.5px]" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>Couldn&apos;t load membership history: {read.error}</p>}
      {h && h.never && (
        <div data-testid="mh-never" className="mt-2">
          <div className="text-[16px] font-bold" style={{ color: INK }}>Never been a member</div>
          <div className="mt-1 text-[12.5px]" style={{ color: MUTED }}>{neverLine}</div>
        </div>
      )}
      {h && !h.never && s && (
        <>
          {current ? (
            <div data-testid="mh-stats" className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-4">
              <Stat k="NOW" v={<span className="inline-flex flex-wrap items-center gap-2">{h.now.title}{h.now.badge && h.now.badge !== "ACTIVE" && <Badge text={h.now.badge} />}</span>}
                color={NOW_COLOR[h.now.tone]} sub={<>{h.now.sub}{h.now.sub2 && <span className="block">{h.now.sub2}</span>}</>} />
              <Stat k="MEMBER SINCE" v={s.memberSince ?? "—"} sub={`${s.memberships} membership${s.memberships === 1 ? "" : "s"}`} />
              <Stat k="MONTHS PAID" v={s.monthsPaid} sub={`of ${s.monthsSinceJoining} since joining`} />
              <Stat k="TOTAL PAID" v={money(s.totalPaidCents)} sub={s.totalCaption} />
            </div>
          ) : (
            <div data-testid="mh-state" className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[16px] font-bold" style={{ color: NOW_COLOR[h.now.tone] }}>{h.now.title}</span>
                {h.now.badge && <Badge text={h.now.badge} />}
              </div>
              {h.now.sub && <div className="mt-1 text-[12.5px]" style={{ color: MUTED }}>{h.now.sub}</div>}
              <div className="mt-1 text-[12.5px]" style={{ color: MUTED }} data-testid="mh-statline">
                {[s.memberSince ? `Member since ${s.memberSince}` : null, `${s.memberships} membership${s.memberships === 1 ? "" : "s"}`,
                  `${s.monthsPaid} month${s.monthsPaid === 1 ? "" : "s"} paid`, `${money(s.totalPaidCents)} paid (${s.totalCaption})`].filter(Boolean).join(" · ")}
              </div>
            </div>
          )}
          {notes}
          {h.notices.map((n) => <p key={n} className="mt-3 text-[12.5px]" style={{ color: "#8a6300" }} data-testid="mh-notice">{n}</p>)}
          {h.items.length > 0 && (
            <>
              <div className="mt-5 mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-[11px] font-semibold tracking-[0.08em]" style={{ color: FAINT }}>HISTORY</span>
                <span className="sm:ml-auto"><Legend /></span>
              </div>
              <Items items={h.items} compact={false} />
            </>
          )}
          <p className="mt-4 text-[11.5px]" style={{ color: FAINT }} data-testid="mh-footer">{h.footer}</p>
        </>
      )}
      {h?.never && notes}
    </div>
  );
}

/** Player Chats details › Membership. */
export function MembershipHistoryCompact({ read, history, neverLine }: { read: HistoryRead | null; history: History | null; neverLine: string }) {
  const h = history;
  if (!read || read.phase === "loading") return <p className="text-[12px]" style={{ color: FAINT }}>Loading…</p>;
  if (read.phase === "error") return <p className="text-[12px]" style={{ color: "#b3241f" }} data-testid="mh-error">Couldn&apos;t load membership history: {read.error}</p>;
  if (!h) return null;
  if (h.never) return (
    <div data-testid="mh-compact" className="rounded-xl px-3 py-3" style={{ background: BANNER.none.bg }}>
      <div className="text-[13.5px] font-bold" style={{ color: INK }}>Never been a member</div>
      <div className="text-[12px]" style={{ color: MUTED }}>{neverLine}</div>
    </div>
  );
  const s = h.summary, b = BANNER[h.now.tone];
  return (
    <div data-testid="mh-compact" className="flex flex-col gap-3">
      <div className="rounded-xl px-3 py-[10px]" style={{ background: b.bg }} data-testid="mh-banner">
        <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-bold" style={{ color: b.fg }}>
          <span>{[h.now.title, h.now.sub && (h.now.title === "Active" || h.now.title === "Cancelling") ? h.now.sub : null].filter(Boolean).join(" · ")}</span>
          {h.now.badge && h.now.badge !== "ACTIVE" && <Badge text={h.now.badge} />}
        </div>
        {h.now.sub && !(h.now.title === "Active" || h.now.title === "Cancelling") && <div className="text-[12px]" style={{ color: MUTED }}>{h.now.sub}</div>}
        <div className="text-[12px]" style={{ color: MUTED }}>
          {[s.memberSince ? `Member since ${s.memberSince}` : null, `${s.memberships} membership${s.memberships === 1 ? "" : "s"}`,
            `${s.monthsPaid} month${s.monthsPaid === 1 ? "" : "s"} paid`, `${money(s.totalPaidCents)} total`].filter(Boolean).join(" · ")}
        </div>
      </div>
      {h.notices.map((n) => <p key={n} className="text-[12px]" style={{ color: "#8a6300" }}>{n}</p>)}
      <Items items={h.items} compact />
      <p className="text-[11px]" style={{ color: FAINT }}>{h.footer}</p>
    </div>
  );
}
