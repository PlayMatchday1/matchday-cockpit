"use client";

/* MEETING ACTION ITEMS — the month's city goals, and the team's things to try and takeaways.
 *
 * Sits above the Monthly Check-In Status block. The month picker and city chips here govern the
 * WHOLE page: CheckInsView owns that state and passes it down, so the goals and the check-ins
 * below them cannot drift out of step. Two pickers is how they would.
 *
 * TEAM ACTIONS ARE THE EXCEPTION. They are org-wide, so the city filter deliberately does not
 * reach them — filtering to Atlanta must not hide a decision that applies to Atlanta. That is why
 * `city` is not a parameter of the team section at all rather than an ignored one. */

import { useMemo, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { useCmActions } from "@/lib/useCmActions";
import {
  CM_STATUS_LABEL, CM_GREEN, CM_GREEN_TINT, CM_CORAL, CM_CORAL_TINT,
  CM_CITIES, cityGoals, citiesWithGoals, cityNameOf, deriveRollup, isPastMonth,
  monthLabel, nextStatus, shiftMonth, shortDate, teamItems, updateHistory,
  type CmItem, type CmStatus, type CmUpdate,
} from "@/lib/cmActions";
import { MANAGERS } from "@/lib/checkIns";

const C = {
  line: "#DCE5E0", line2: "#EFF3EF", ink: "#12241d", ink2: "#3d5245",
  mut: "#6d7b74", faint: "#9AA8A0", forest: "#0d3b2e",
  amb: "#8a6300", ambb: "#fdf1d0", ambl: "#e3c369",
};

export default function CmActionItems({ month, setMonth, city, setCity, currentMonth }: {
  month: string; setMonth: (m: string) => void;
  city: string | null; setCity: (c: string | null) => void;
  currentMonth: string;
}) {
  const api = useCmActions(month);
  const { items, updates, loading, error } = api;
  const past = isPastMonth(month, currentMonth);
  const { appUser } = useAuth();
  // Who wrote a progress line. The name if we have one, the email if not — an update with no
  // author beside it is a note nobody can follow up on.
  const author = appUser?.full_name || appUser?.email || null;

  /* EVERY CONTROL IS GATED THE SAME WAY. `past` used to gate only the status pill; with add, edit,
   * delete, reorder and report-progress on the page, gating one of six would make the
   * PAST MONTH · READ ONLY badge a label that is not true. */
  const rw = !past;

  // DERIVED FROM THE LIST, NEVER STORED. Cycling a status moves these because they are recomputed
  // from the same array the board renders.
  const rollup = useMemo(() => deriveRollup(items), [items]);
  const cities = useMemo(() => citiesWithGoals(items, city), [items, city]);
  const tries = useMemo(() => teamItems(items, "try"), [items]);
  const takeaways = useMemo(() => teamItems(items, "takeaway"), [items]);
  const hasAnything = items.length > 0;

  const cycle = (it: CmItem) => {
    if (past || it.status === null) return;
    void api.setStatus(it.id, nextStatus(it.status));
  };

  return (
    <div data-testid="cm-actions" className="mb-8 overflow-hidden rounded-2xl border bg-white"
      style={{ borderColor: C.line }}>

      {/* ── the one bar that governs the page ── */}
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: C.line }}>
        <div className="inline-flex gap-1.5">
          <button type="button" data-testid="cm-prev" aria-label="Previous month"
            onClick={() => setMonth(shiftMonth(month, -1))}
            className="h-[30px] min-w-[30px] rounded-lg border text-xs font-semibold"
            style={{ borderColor: C.line, color: C.ink2 }}>‹</button>
          <button type="button" data-testid="cm-next" aria-label="Next month"
            onClick={() => setMonth(shiftMonth(month, 1))}
            className="h-[30px] min-w-[30px] rounded-lg border text-xs font-semibold"
            style={{ borderColor: C.line, color: C.ink2 }}>›</button>
        </div>
        <div data-testid="cm-month" className="min-w-[132px] text-[15px] font-extrabold tracking-tight">
          {monthLabel(month)}
        </div>
        <button type="button" data-testid="cm-thismonth" onClick={() => setMonth(currentMonth)}
          className="h-[30px] rounded-lg border px-3 text-xs font-semibold text-white"
          style={{ background: C.forest, borderColor: C.forest }}>This month</button>
        {/* PAST MONTHS ARE READ ONLY. September's goals in November are a record of what was
            agreed and how it went; editing them retroactively makes the record worthless, which
            is the whole reason for keeping it. */}
        {past && (
          <span data-testid="cm-readonly" className="rounded-md border px-2.5 py-[3px] text-[11px] font-extrabold tracking-wide"
            style={{ background: C.ambb, borderColor: C.ambl, color: C.amb }}>
            PAST MONTH · READ ONLY
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-3 text-[11.5px]" style={{ color: C.mut }}>
          <Roll n={rollup.total} label="action items" />
          <Roll n={rollup.ontrack} label="on track" colour={CM_GREEN} />
          <Roll n={rollup.atrisk} label="at risk" colour={CM_CORAL} />
          <Roll n={rollup.done} label="done" />
          <Roll n={rollup.open} label="not started" />
        </span>
      </div>

      {/* ── the city filter, which governs the goals AND the check-ins below ── */}
      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2.5" style={{ borderColor: C.line, background: "#FAFCFB" }}>
        <span className="mr-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#8C9E93" }}>City</span>
        <Chip on={city === null} onClick={() => setCity(null)} testid="cm-city-all">All cities</Chip>
        {/* IN CITY_SCOPES ORDER, which is the order the board below uses. Built from the union of
            the cities with goals and the cities with a manager, so a city with September targets
            and nobody to own them (Atlanta) still gets a chip, and a manager with no goals this
            month is still reachable. */}
        {CM_CITIES.filter((id) =>
          items.some((i) => i.scope === "city" && i.city === id) || MANAGERS.some((m) => m.cityId === id),
        ).map((id) => {
          const n = items.filter((i) => i.scope === "city" && i.city === id).length;
          const risk = items.some((i) => i.scope === "city" && i.city === id && i.status === "atrisk");
          return (
            <Chip key={id} on={city === id} onClick={() => setCity(id)} testid={`cm-city-${id}`}>
              {cityNameOf(id)}
              {n > 0 && <u className="ml-1.5 text-[10.5px] font-bold no-underline" style={{ color: city === id ? "#9fd6bb" : C.faint }}>{n}</u>}
              {risk && <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: CM_CORAL }} />}
            </Chip>
          );
        })}
      </div>

      {error && (
        <div data-testid="cm-error" className="border-b px-4 py-3 text-[12.5px]"
          style={{ borderColor: C.line, background: CM_CORAL_TINT, color: CM_CORAL }}>
          <b>The action items could not be loaded — this is not an empty month.</b> {error}
        </div>
      )}

      {/* ── the goals board ── */}
      {loading && !hasAnything ? (
        <div className="px-4 py-8 text-center text-[13px]" style={{ color: C.mut }}>Loading action items…</div>
      ) : !hasAnything && !error ? (
        /* A MONTH WITH NOTHING SET SAYS SO. An empty grid is indistinguishable from a month whose
           goals failed to load, and it offers nothing to do about it. */
        <div data-testid="cm-empty" className="px-4 py-9 text-center text-[13px]" style={{ color: C.mut }}>
          <b className="mb-1.5 block text-[14px]" style={{ color: C.ink }}>
            No action items set for {monthLabel(month)} yet.
          </b>
          They are agreed in the monthly meeting.
          {!past && (
            <div className="mt-3">
              <button type="button" data-testid="cm-carry"
                onClick={() => void api.carryForward(shiftMonth(month, -1), month)}
                className="h-[30px] rounded-lg border px-3 text-xs font-semibold text-white"
                style={{ background: C.forest, borderColor: C.forest }}>
                Carry {monthLabel(shiftMonth(month, -1))}&rsquo;s goals forward
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div data-testid="cm-board" className="grid grid-cols-1 lg:grid-cols-2">
            {cities.map((id, i) => {
              const gs = cityGoals(items, id);
              const mgr = MANAGERS.find((m) => m.cityId === id);
              const done = gs.filter((g) => g.status === "done").length;
              return (
                <div key={id} data-testid="cm-city" data-city={id}
                  className="border-b px-4 pb-3 pt-3.5 lg:border-r"
                  style={{ borderColor: C.line2, ...(i % 2 === 1 ? { borderRightWidth: 0 } : {}) }}>
                  <div className="mb-2.5 flex items-center gap-2">
                    <b className="text-[15px] font-extrabold tracking-tight" style={{ color: CM_GREEN }}>{cityNameOf(id)}</b>
                    {/* No manager is stated, not papered over — Atlanta has goals and nobody to own them. */}
                    <span className="text-[11.5px]" style={{ color: mgr ? C.mut : CM_CORAL }}>
                      {mgr ? mgr.name : "No manager"}
                    </span>
                    <span className="ml-auto text-[11px] font-bold" style={{ color: C.mut }}>{done}/{gs.length} done</span>
                  </div>
                  {gs.map((g) => (
                    <Row key={g.id} item={g} rw={rw} onCycle={() => cycle(g)}
                      updates={updates} api={api} author={author} siblings={gs} />
                  ))}
                  {/* THE CITY COMES FROM THE CARD, never a free field: cm_ai_city_shape requires
                      one and the card already knows which. */}
                  {rw && <AddRow label={`+ Add a goal for ${cityNameOf(id)}`} testid={`cm-add-goal-${id}`}
                    onSubmit={(v) => api.addItem({ kind: "goal", city: id, body: v.body })} />}
                </div>
              );
            })}
          </div>

          {/* ── TEAM ACTIONS — org-wide, so the city filter above leaves them alone ── */}
          {/* ── ALWAYS RENDERED ─────────────────────────────────────────────────────────────────
              This was gated on `tries.length > 0 || takeaways.length > 0`, and the only control
              that could create a first team item lived inside it — so there was no path to a
              first one. The section is the empty state now, not a thing that appears once
              somebody has already done the impossible. */}
          <div data-testid="cm-team" className="border-t" style={{ borderColor: C.line, background: "#FAFCFB" }}>
              <div className="flex flex-wrap items-baseline gap-2.5 px-4 pb-1 pt-3">
                <b className="text-[11px] font-extrabold uppercase tracking-wider" style={{ color: C.ink }}>Team actions</b>
                <span className="text-[11.5px]" style={{ color: C.mut }}>
                  from the {monthLabel(month).split(" ")[0]} meeting · not city specific, so the city filter leaves them alone
                </span>
                <span className="ml-auto text-[11px] font-bold" style={{ color: C.mut }}>
                  {tries.filter((t) => t.status !== "done").length} open of {tries.length}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2">
                <div className="px-4 pb-3.5 pt-1.5 md:border-r" style={{ borderColor: C.line2 }}>
                  <div className="pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#8C9E93" }}>Things to try</div>
                  {tries.map((t) => (
                    <Row key={t.id} item={t} rw={rw} onCycle={() => cycle(t)}
                      updates={updates} api={api} author={author} siblings={tries} />
                  ))}
                  {tries.length === 0 && (
                    <p className="py-1.5 text-[12px]" data-testid="cm-try-empty" style={{ color: C.faint }}>
                      Nothing agreed this month. A thing to try is a decision with an owner — something the team
                      is going to do differently and check back on.
                    </p>
                  )}
                  {/* city IS NOT PASSED. cm_ai_team_shape requires null, and the city filter above
                      is a view, not a property of an org-wide decision. */}
                  {rw && <AddRow label="+ Add a thing to try" testid="cm-add-try" owner
                    onSubmit={(v) => api.addItem({ kind: "try", body: v.body, owner: v.extra })} />}
                </div>
                <div className="px-4 pb-3.5 pt-1.5">
                  <div className="pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#8C9E93" }}>Takeaways</div>
                  {/* A TAKEAWAY IS NOT A TASK. No status pill, no owner, no chasing — a source and
                      a date and nothing else. The database refuses one a status too
                      (cm_ai_takeaway_shape), so this is not the only thing holding the line. */}
                  {takeaways.map((k) => (
                    <div key={k.id} data-testid="cm-takeaway" className="flex items-start gap-2.5 border-t py-[7px]" style={{ borderColor: C.line2 }}>
                      <span aria-hidden className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: C.faint }} />
                      <div className="min-w-0">
                        <div className="text-[13px] leading-[1.45]">{k.body}</div>
                        <div className="mt-0.5 text-[11.5px]" style={{ color: C.faint }}>{k.source}</div>
                      </div>
                    </div>
                  ))}
                  {takeaways.length === 0 && (
                    <p className="py-1.5 text-[12px]" data-testid="cm-takeaway-empty" style={{ color: C.faint }}>
                      Nothing recorded this month. A takeaway is what the month taught us — no owner, no status,
                      just the thing we now know and where it came from.
                    </p>
                  )}
                  {/* REQUIRED SOURCE, NO STATUS CONTROL. cm_ai_takeaway_shape rejects a takeaway
                      that carries a status or an owner, and rejects one with no source. */}
                  {rw && <AddRow label="+ Add a takeaway" testid="cm-add-takeaway" sourceRequired
                    onSubmit={(v) => api.addItem({ kind: "takeaway", body: v.body, source: v.extra })} />}
                </div>
              </div>
          </div>
        </>
      )}
    </div>
  );
}

function Roll({ n, label, colour }: { n: number; label: string; colour?: string }) {
  return (
    <span data-testid={`cm-roll-${label.replace(/\s+/g, "-")}`} data-n={n}>
      <b className="mr-[3px] text-[14px] font-extrabold" style={{ color: colour ?? C.ink }}>{n}</b>
      <span style={colour ? { color: colour } : undefined}>{label}</span>
    </span>
  );
}

function Chip({ on, onClick, children, testid }: {
  on: boolean; onClick: () => void; children: React.ReactNode; testid: string;
}) {
  return (
    <button type="button" data-testid={testid} data-on={on ? "1" : "0"} onClick={onClick}
      className="inline-flex h-[27px] items-center gap-1.5 rounded-full border px-3 text-xs font-semibold"
      style={on
        ? { background: C.forest, borderColor: C.forest, color: "#fff" }
        : { background: "#fff", borderColor: C.line, color: C.ink2 }}>
      {children}
    </button>
  );
}

/* ONE ROW: a status pill, the text, the latest progress line, and the controls for every column
 * migration 0158 created. Used by both a city goal and a thing to try, because they are the same
 * thing — somebody has to do them. A takeaway is not rendered here; it has no status and no owner
 * and the database refuses it both. */
function Row({ item, rw, onCycle, updates, api, author, siblings }: {
  item: CmItem; rw: boolean; onCycle: () => void;
  updates: CmUpdate[]; api: ReturnType<typeof useCmActions>; author: string | null;
  siblings: CmItem[];
}) {
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<null | "progress" | "body" | "owner">(null);
  const [showAll, setShowAll] = useState(false);
  const s = item.status as CmStatus;
  const history = updateHistory(updates, item.id);
  const latest = history[0] ?? null;
  const i = siblings.findIndex((x) => x.id === item.id);

  const tone = s === "ontrack" ? { color: CM_GREEN, borderColor: "#a8d6ba", background: CM_GREEN_TINT, dot: CM_GREEN }
    : s === "atrisk" ? { color: CM_CORAL, borderColor: "#e6b3a6", background: CM_CORAL_TINT, dot: CM_CORAL }
    : s === "done" ? { color: "#fff", borderColor: CM_GREEN, background: CM_GREEN, dot: "#fff" }
    : { color: C.mut, borderColor: C.line, background: "#fff", dot: C.line };

  return (
    <div data-testid="cm-row" data-id={item.id} data-status={s} className="border-t py-[7px]" style={{ borderColor: C.line2 }}>
      <div className="flex items-start gap-2.5">
        <button type="button" data-testid="cm-status" data-status={s} disabled={!rw} onClick={onCycle}
          aria-label={`Status: ${CM_STATUS_LABEL[s]}${rw ? " — click to cycle" : " (read only)"}`}
          className="mt-px inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[10.5px] font-bold tracking-wide disabled:cursor-default"
          style={{ color: tone.color, borderColor: tone.borderColor, background: tone.background, opacity: rw ? 1 : 0.75 }}>
          <span aria-hidden className="h-[7px] w-[7px] rounded-full" style={{ background: tone.dot }} />
          {CM_STATUS_LABEL[s]}
        </button>
        <div className="min-w-0 flex-1">
          {mode === "body" ? (
            <InlineEdit initial={item.body} label="Wording" testid="cm-edit-body"
              onCancel={() => setMode(null)}
              onSave={(v) => { void api.updateItem(item.id, { body: v }); setMode(null); }} />
          ) : (
            <div data-testid="cm-body" className="text-[13.5px] leading-[1.4]"
              style={s === "done" ? { color: C.mut, textDecoration: "line-through" } : undefined}>{item.body}</div>
          )}
          {mode === "owner" && (
            <InlineEdit initial={item.owner ?? ""} label="Owner" testid="cm-edit-owner" allowEmpty
              onCancel={() => setMode(null)}
              onSave={(v) => { void api.updateItem(item.id, { owner: v || null }); setMode(null); }} />
          )}
          {latest ? (
            <div data-testid="cm-update" className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: C.mut }}>
              <b style={{ color: C.ink2 }}>{shortDate(latest.reported_on)}</b> · {latest.body}{" "}
              {latest.author && <span style={{ color: C.faint }}>{latest.author}</span>}
              {/* THE TABLE KEEPS EVERY UPDATE AND THE PAGE RENDERED ONE. The point of keeping a
                  past month is that it is a record, so let someone read it. */}
              {history.length > 1 && (
                <button type="button" data-testid="cm-history-toggle" onClick={() => setShowAll((v) => !v)}
                  className="ml-1.5 underline" style={{ color: CM_GREEN, fontWeight: 700 }}>
                  {showAll ? "hide" : `${history.length} updates`}
                </button>
              )}
            </div>
          ) : (
            <div className="mt-1 text-[11.5px] italic" style={{ color: C.faint }}>
              No progress reported{item.owner ? ` · owner ${item.owner}` : ""}
            </div>
          )}
          {showAll && history.slice(1).map((u) => (
            <div key={u.id} data-testid="cm-update-old" className="mt-0.5 pl-2 text-[11.5px] leading-[1.45]"
              style={{ color: C.faint, borderLeft: `2px solid ${C.line2}` }}>
              <b style={{ color: C.mut }}>{shortDate(u.reported_on)}</b> · {u.body} {u.author && <span>{u.author}</span>}
            </div>
          ))}
          {mode === "progress" && (
            <ProgressForm author={author} onCancel={() => setMode(null)}
              onSave={(body, on) => { void api.addUpdate(item.id, body, author, on); setMode(null); }} />
          )}
          {/* A ROW THAT ALREADY HAS AN UPDATE STILL OFFERS ANOTHER — cm_action_updates is history,
              not a field that gets overwritten. */}
          {rw && mode === null && (
            <button type="button" data-testid="cm-report" onClick={() => setMode("progress")}
              className="mt-1 text-[11.5px] font-bold underline" style={{ color: CM_GREEN }}>+ Report progress</button>
          )}
        </div>
        {rw && (
          <div className="relative flex-none">
            <button type="button" data-testid="cm-menu" aria-label="Row actions" onClick={() => setMenu((v) => !v)}
              className="rounded-[7px] border px-2 py-0.5 text-[13px] leading-none"
              style={{ borderColor: C.line, color: C.mut, minHeight: 24 }}>⋯</button>
            {menu && (
              <>
                <span className="fixed inset-0 z-[40]" onClick={() => setMenu(false)} />
                <div data-testid="cm-menu-panel" className="absolute right-0 z-[41] mt-1 w-[168px] overflow-hidden rounded-[10px] border bg-white"
                  style={{ borderColor: C.line, boxShadow: "0 8px 22px rgba(16,40,28,.14)" }}>
                  {[
                    { t: "Edit wording", id: "edit-body", on: () => setMode("body") },
                    { t: "Set owner", id: "edit-owner", on: () => setMode("owner") },
                    { t: "Report progress", id: "report", on: () => setMode("progress") },
                    { t: "Move up", id: "up", on: () => void api.reorder(siblings, item.id, -1), off: i <= 0 },
                    { t: "Move down", id: "down", on: () => void api.reorder(siblings, item.id, 1), off: i < 0 || i >= siblings.length - 1 },
                    { t: "Delete", id: "delete", on: () => { if (confirm(`Delete “${item.body}”? Its progress updates go with it.`)) void api.deleteItem(item.id); }, danger: true },
                  ].map((a) => (
                    <button key={a.id} type="button" data-testid={`cm-menu-${a.id}`} disabled={a.off}
                      onClick={() => { setMenu(false); a.on(); }}
                      className="block w-full border-b px-3 py-2 text-left text-[12.5px] font-semibold last:border-b-0 disabled:opacity-40"
                      style={{ borderColor: C.line2, color: a.danger ? CM_CORAL : C.ink2 }}>{a.t}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* A one-field inline edit. Escape cancels, Enter saves — the same two keys the capture bar uses. */
function InlineEdit({ initial, label, testid, allowEmpty, onSave, onCancel }: {
  initial: string; label: string; testid: string; allowEmpty?: boolean;
  onSave: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const ok = allowEmpty || v.trim().length > 0;
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label={label} data-testid={testid}
        onKeyDown={(e) => { if (e.key === "Enter" && ok) onSave(v.trim()); if (e.key === "Escape") onCancel(); }}
        className="min-w-0 flex-1 rounded-[8px] border px-2 text-[12.5px]" style={{ borderColor: C.line, minHeight: 30 }} />
      <button type="button" data-testid={`${testid}-save`} disabled={!ok} onClick={() => onSave(v.trim())}
        className="rounded-[8px] px-2.5 text-[11.5px] font-bold text-white disabled:opacity-40"
        style={{ background: C.forest, minHeight: 30 }}>Save</button>
      <button type="button" onClick={onCancel} className="text-[11.5px] font-bold" style={{ color: C.mut }}>Cancel</button>
    </div>
  );
}

/* REPORT PROGRESS — the call site addUpdate never had. The date defaults to today and is editable,
 * because the day being reported about is not always the day somebody types it. */
function ProgressForm({ author, onSave, onCancel }: {
  author: string | null; onSave: (body: string, on: string) => void; onCancel: () => void;
}) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const [body, setBody] = useState("");
  const [on, setOn] = useState(today);
  return (
    <div className="mt-1.5 rounded-[9px] border p-2" style={{ borderColor: C.line, background: "#FAFCFB" }}>
      <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={2}
        data-testid="cm-progress-body" aria-label="What happened"
        placeholder="What happened?" className="w-full rounded-[8px] border px-2 py-1.5 text-[12.5px]"
        style={{ borderColor: C.line }} />
      <div className="mt-1.5 flex items-center gap-1.5">
        <input type="date" value={on} onChange={(e) => setOn(e.target.value)} data-testid="cm-progress-date"
          aria-label="Date reported about"
          className="rounded-[8px] border px-2 text-[12px]" style={{ borderColor: C.line, minHeight: 30 }} />
        <span className="text-[11px]" style={{ color: C.faint }}>{author ?? "unattributed"}</span>
        <button type="button" data-testid="cm-progress-save" disabled={!body.trim()}
          onClick={() => onSave(body, on)}
          className="ml-auto rounded-[8px] px-2.5 text-[11.5px] font-bold text-white disabled:opacity-40"
          style={{ background: C.forest, minHeight: 30 }}>Save</button>
        <button type="button" onClick={onCancel} className="text-[11.5px] font-bold" style={{ color: C.mut }}>Cancel</button>
      </div>
    </div>
  );
}

/* ADD. One shape for all three kinds; `owner` and `sourceRequired` say which second field it
 * carries. A takeaway's source is REQUIRED because cm_ai_takeaway_shape rejects a row without one,
 * and a takeaway form has NO status control because the same constraint rejects a status. */
function AddRow({ label, testid, owner, sourceRequired, onSubmit }: {
  label: string; testid: string; owner?: boolean; sourceRequired?: boolean;
  onSubmit: (v: { body: string; extra: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [extra, setExtra] = useState("");
  const ok = body.trim().length > 0 && (!sourceRequired || extra.trim().length > 0);
  if (!open) {
    return (
      <button type="button" data-testid={testid} onClick={() => setOpen(true)}
        className="mt-1.5 text-[12px] font-bold underline" style={{ color: CM_GREEN }}>{label}</button>
    );
  }
  return (
    <div className="mt-1.5 rounded-[9px] border p-2" data-testid={`${testid}-form`} style={{ borderColor: C.line, background: "#FAFCFB" }}>
      <input autoFocus value={body} onChange={(e) => setBody(e.target.value)} data-testid={`${testid}-body`}
        aria-label="What" placeholder="What is it?" className="w-full rounded-[8px] border px-2 text-[12.5px]"
        style={{ borderColor: C.line, minHeight: 32 }} />
      {(owner || sourceRequired) && (
        <input value={extra} onChange={(e) => setExtra(e.target.value)} data-testid={`${testid}-extra`}
          aria-label={sourceRequired ? "Source" : "Owner"}
          placeholder={sourceRequired ? "Where did this come from? (required)" : "Owner (optional)"}
          className="mt-1.5 w-full rounded-[8px] border px-2 text-[12.5px]" style={{ borderColor: C.line, minHeight: 32 }} />
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button type="button" data-testid={`${testid}-save`} disabled={!ok}
          onClick={() => { onSubmit({ body, extra }); setBody(""); setExtra(""); setOpen(false); }}
          className="rounded-[8px] px-2.5 text-[11.5px] font-bold text-white disabled:opacity-40"
          style={{ background: C.forest, minHeight: 30 }}>Add</button>
        <button type="button" onClick={() => { setOpen(false); setBody(""); setExtra(""); }}
          className="text-[11.5px] font-bold" style={{ color: C.mut }}>Cancel</button>
      </div>
    </div>
  );
}
