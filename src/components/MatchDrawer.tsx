"use client";

// Master Schedule edit drawer (Phase 7 Part B; Phase 10: PRODUCTION). Opens on a
// match card, PUSHES the grid (never covers it), edits nine fields, and writes a
// partial update through the guarded route /api/matchday/{DRAWER_ENV}/matches/{id}
// (DRAWER_ENV from matchEnv.ts; currently production) — env named per call. Uses the
// same shared diff (fieldChanged / diffKeys / pick from matchEditModel) as the full
// editor, so the two screens can never disagree about what a change is. Production
// PUT is a proven partial apply (Phase 9). The manager control is a real dropdown
// scoped to the match's city (GET /city-managers/users).
//
// The date + time inputs collapse into the startDate/endDate PAIR: a time move
// shifts endDate by the same amount so the duration is preserved and the pair
// can never silently invert (Phase 7 date decision — docs/matchday-api-facts.md).
// A match that loads already inverted (endDate <= startDate) is flagged and its
// date/time is held, never silently rewritten. Nothing here calls new Date() on a
// wall-clock string — see matchWallClock.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { tzLabelOfCity } from "@/lib/matchTimezone";
import MatchEditor from "@/app/(internal)/match-ops/matches/[id]/MatchEditor";
import { DRAWER_ENV, FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { noteLogResponse } from "@/lib/logHealth";

export const DRAWER_W = 480;

// The drawer targets DRAWER_ENV (matchEnv.ts): one value builds the request URL AND
// the badge, so the two can't disagree. The "open full editor" link only renders
// when the full editor targets the SAME environment (FULL_EDITOR_ENV) — otherwise
// it would send the operator from a production match to a different-env editor.
const SAME_ENV_AS_EDITOR = DRAWER_ENV === FULL_EDITOR_ENV;

export type DrawerPatch = { name: string; startDate: string; fieldId: number; venue: string | null; city: string | null };
export type DrawerMatch = { apiId: number; veo: boolean; siblings: number[] };

type FieldRow = { id: number; title: string; city: string | null };
type Mgr = { id?: number | null; firstName?: string | null; lastName?: string | null; name?: string | null; deletedAt?: string | null } | null;
type Detail = {
  match: Record<string, unknown> & {
    id: number; name: string | null; fieldId: number | null; startDate: string | null; endDate: string | null;
    registrationPrice: number | null; additionalSpotPrice: number | null; guestCount: number | null;
    managerId: number | null; secondManagerId: number | null; teams?: unknown[] | null;
    fieldTitle: string | null; cityName: string | null; maxPlayerCount: number | null;
    manager: Mgr; secondManager: Mgr;
  };
  fields: FieldRow[];
  players: unknown[];
  managers: { id: number; name: string }[];
};

// The nine editable fields. date/time are UI-only and collapse to startDate/endDate.
const REAL_KEYS = ["fieldId", "name", "registrationPrice", "additionalSpotPrice", "guestCount", "managerId", "secondManagerId"] as const;
const LABEL: Record<string, string> = {
  date: "Date", time: "Start time", fieldId: "Field", name: "Name",
  registrationPrice: "Price", additionalSpotPrice: "Spot price", guestCount: "Guest count",
  managerId: "Manager", secondManagerId: "Second manager",
};

type State = Record<string, unknown> & { date: string; time: string };

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

export default function MatchDrawer({
  apiId, cardVeo, siblings, onClose, onDirtyChange, onSaved, onToggleVeo, onStep, onToast, onCancelLanded,
}: {
  apiId: number; cardVeo: boolean; siblings: number[];
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (apiId: number, patch: DrawerPatch) => void;
  onToggleVeo: (apiId: number, enabled: boolean) => void;
  onStep: (targetId: number) => void;
  onToast: (msg: string, warn?: boolean) => void;
  /* PASS-THROUGH, deliberately not handled here. The drawer does not own the schedule behind it;
   * the surface that does decides what a landed cancel means for its own view. */
  onCancelLanded?: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving] = useState(false);   // header disables the arrows while a save is in flight
  const panelRef = useRef<HTMLDivElement | null>(null);

  /* THE DRAWER NO LONGER OWNS A FORM. It loads the match for THREE header facts only — the city
   * crumb, the timezone chip and the title — and MatchEditor loads the match itself for editing.
   * Two reads of the same id, deliberately: the alternative is threading a loaded match through a
   * prop and having two components disagree about which one is authoritative.
   *
   * Everything that used to live here — its own state, diff, save, revert, date pair, manager
   * dropdown, timezone warning and deleted-manager note — is GONE. The last three were not
   * deleted but MOVED into MatchEditor, because they were capabilities rather than presentation. */
  useEffect(() => {
    let live = true;
    (async () => {
      setDetail(null); setLoadErr(null);
      const res = await authFetch(`/api/matchday/${DRAWER_ENV}/matches/${apiId}`);
      const json = await res.json().catch(() => ({}));
      if (!live) return;
      if (!res.ok) { setLoadErr(json?.error ?? `HTTP ${res.status}`); return; }
      setDetail(json as Detail);
    })();
    return () => { live = false; };
  }, [apiId]);

  useEffect(() => { if (detail) panelRef.current?.focus(); }, [detail]);

  const [dirty, setDirty] = useState(false);
  const reportDirty = useCallback((d: boolean) => { setDirty(d); onDirtyChange(d); }, [onDirtyChange]);

  const requestClose = useCallback(() => {
    if (dirty) { onToast(`Save or revert match ${apiId} first.`, true); return; }
    onClose();
  }, [dirty, apiId, onClose, onToast]);

  const step = useCallback((delta: number) => {
    if (dirty) { onToast(`Save or revert match ${apiId} first.`, true); return; }
    const i = siblings.indexOf(apiId);
    const t = siblings[i + delta];
    if (t != null) onStep(t);
  }, [dirty, apiId, siblings, onStep, onToast]);

  // Escape closes (guarded) while the drawer is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); requestClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // THE HEADER'S THREE FACTS, and nothing else. The form that used the rest is gone.
  const m = detail?.match;
  const cityName = m?.cityName ?? null;
  const tzLabel = tzLabelOfCity(cityName);

  return (
    <aside
      ref={panelRef}
      className="mdw"   /* no red framing: the panel is the app's normal chrome now */
      role="dialog"
      aria-modal="false"
      aria-label={`${m ? "Edit " : ""}match ${apiId}`.trim()}
      tabIndex={-1}
      data-testid="drawer"
      data-env={DRAWER_ENV}
      style={{ width: DRAWER_W }}
    >
      <style>{CSS}</style>
      <div className="mdw-head">
        <div className="mdw-row1">
          <div className="mdw-crumb" data-testid="dr-crumb">{cityName ?? "—"}</div>
          <div className="mdw-sp">
            <button type="button" className="mdw-iconb" data-testid="dr-prev" title="Previous match this day" aria-label="Previous match this day" disabled={siblings.indexOf(apiId) <= 0} onClick={() => step(-1)}>↑</button>
            <button type="button" className="mdw-iconb" data-testid="dr-next" title="Next match this day" aria-label="Next match this day" disabled={siblings.indexOf(apiId) >= siblings.length - 1} onClick={() => step(1)}>↓</button>
            <button type="button" className="mdw-iconb" data-testid="dr-close" title="Close (Esc)" aria-label="Close" onClick={requestClose}>✕</button>
          </div>
        </div>
        <h3 className="mdw-name" data-testid="dr-title">{m ? (String(m.name ?? "") || "Untitled match") : `Loading match ${apiId}…`}</h3>
        <div className="mdw-chips">
          <span className="mdw-chip id">ID {apiId}</span>
          <span className="mdw-chip tz" data-testid="dr-tzchip">{tzLabel.toUpperCase()}</span>
          {/* THE LIVE / CANCELLED PILL, moved here from the editor's own header — which no longer
              renders in panel mode. It identifies the match, so it has to survive the de-duplication.

              "PRODUCTION — LIVE EDITS" is GONE. It earned its place when Master Schedule and the
              editor could point at different environments; they cannot, so it fired on every single
              match — and a warning that fires every time stops being read by the second one. */}
          <span className={"mdw-chip " + (m?.isCancelled ? "warn" : "live")} data-testid="dr-livepill">
            {m?.isCancelled ? "Cancelled" : "Live"}</span>
          {/* "Open full editor →" is gone: this IS the full editor now, in a panel. A link to a
              fuller one would have nowhere to go. */}
        </div>
      </div>

      {/* ── ONE EDITOR, RENDERED IN A PANEL ───────────────────────────────────────────────────
          This used to be a second form: nine fields against the full editor's twenty-one, its own
          diff, its own save, and its own copy of the date rules. Two editors on one route is how
          they drift — the date sentence in the full editor described a restriction this drawer
          ignored, and its writes logged with no source so nobody could tell which one had moved a
          production match by eight and a half hours.

          The drawer keeps what only a week grid needs: the header, the sibling arrows, the close,
          and the production framing. Everything below it is MatchEditor. Same fields, same
          validation, same save path, same audit entry — the only difference is the chrome. */}
      <MatchEditor
        id={String(apiId)}
        variant="panel"
        onDirtyChange={reportDirty}
        veo={cardVeo}
        onToggleVeo={(next: boolean) => onToggleVeo(apiId, next)}
        onCancelLanded={onCancelLanded}
      />

    </aside>
  );
}

const CSS = `
.mdw{position:fixed;top:0;right:0;bottom:0;background:#fff;border-left:1px solid #DCE5E0;
  box-shadow:-14px 0 40px rgba(0,32,21,.16);display:flex;flex-direction:column;z-index:60;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0B1F17}
.mdw:focus{outline:none}
.mdw *{box-sizing:border-box}
.mdw-head{background:#04291D;color:#fff;padding:15px 18px 16px;flex:0 0 auto}
/* THE EDITOR GETS THE REMAINING HEIGHT, BOUNDED. Without min-height:0 the flex child grows to its
   content and the panel scrolls as a whole — which is exactly the bug: the save bar rides off the
   bottom of the screen and the fields above it cannot be reached. */
.mdw > .me{flex:1 1 auto;min-height:0}
.mdw-row1{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.mdw-crumb{font-size:12px;color:#9FC9B6;letter-spacing:.02em}
.mdw-row1 .mdw-sp{margin-left:auto;display:flex;gap:6px}
.mdw-iconb{width:29px;height:29px;border-radius:7px;border:1px solid #2A5644;background:transparent;color:#CFE7DC;line-height:1;font-size:14px;cursor:pointer;font-family:inherit}
.mdw-iconb:hover:not(:disabled){background:#14432F;color:#fff}
.mdw-iconb:disabled{opacity:.32;cursor:not-allowed}
.mdw-name{margin:0;font-size:18.5px;letter-spacing:-.2px}
.mdw-chips{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap;align-items:center}
.mdw-chip{font-size:10.5px;font-weight:700;letter-spacing:.07em;border-radius:20px;padding:3px 9px}
.mdw-chip.id{background:#14432F;color:#B7DECB}
.mdw-chip.live{background:#0F6B4F;color:#CFF3E3}
.mdw-chip.warn{background:#5A3A12;color:#F4E3C4}
.mdw-chip.tz{background:#14432F;color:#B7DECB}
/* The environment pill and its red framing are gone — both environments are production, so it
   fired on every match. The full-editor link went with the drawer's form: this IS the editor. */
.mdw-body{flex:1 1 auto;overflow-y:auto;padding:4px 18px 18px}
.mdw-state{padding:26px 4px;font-size:13px;color:#5C6B62;font-weight:650}
.mdw-inverted{margin:12px 0 0;background:#FDE9E5;border:1px solid #F3C4BB;color:#7a2415;border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.5}
.mdw-inverted b{color:#A83120}
.mdw-sec{border-bottom:1px solid #E9EFEB;padding:16px 0}
.mdw-sec:last-child{border-bottom:0}
.mdw-sec h5{margin:0 0 12px;font-size:10.5px;letter-spacing:.12em;color:#67746C;font-weight:700;display:flex;align-items:center}
.mdw-n{margin-left:auto;font-size:11px;letter-spacing:0;color:#1B4F9C;font-weight:700;text-transform:none}
.mdw-f{margin-bottom:12px}
.mdw-f:last-child{margin-bottom:0}
.mdw-f label{display:block;font-size:11px;letter-spacing:.09em;font-weight:700;color:#67746C;margin-bottom:5px}
.mdw-f.mdw-dirty label{color:#1B4F9C}
.mdw-two{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.mdw-three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px}
.mdw input[type=text],.mdw input[type=time],.mdw input[type=date],.mdw input[type=number],.mdw select{
  width:100%;padding:9px 11px;border:1px solid #CBD7D1;border-radius:8px;background:#fff;font-family:inherit;font-size:13.5px;color:#0B1F17}
.mdw input:focus,.mdw select:focus{outline:2px solid #046B45;outline-offset:-1px;border-color:#046B45}
.mdw input:disabled{background:#F1F4F1;color:#67746C;cursor:not-allowed}
.mdw-f.mdw-dirty input,.mdw-f.mdw-dirty select{border-color:#9CB6DD;background:#F4F8FE}
.mdw-money{position:relative}
/* [type=number] to out-specify the general ".mdw input[type=number]" rule, else
   padding-left is 11px and the "$" overlay covers the leading digit ($12 -> $2). */
.mdw-money input[type=number]{padding-left:24px}
.mdw-money span{position:absolute;left:11px;top:9px;color:#5C6B62;pointer-events:none}
.mdw-hint{font-size:12px;color:#5C6B62;margin-top:6px;line-height:1.45}
.mdw-hint.warn{color:#7A5200}
.mdw-sub{font-size:11.5px;color:#5C6B62;margin-top:4px;font-weight:650}
.mdw-tzline{font-size:12px;line-height:1.5;color:#5C6B62;margin-top:6px}
.mdw-tzline b{color:#2A473B}
.mdw-veorow{display:flex;align-items:center;gap:12px;border:1px solid #DCE5E0;border-radius:10px;padding:12px 13px;background:#FBFCFB}
.mdw-lab{font-weight:600;font-size:14px}
.mdw-sw{margin-left:auto;width:46px;height:26px;border-radius:20px;border:1px solid #C3CDC7;background:#E7EDEA;position:relative;flex:0 0 46px;cursor:pointer}
.mdw-sw i{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:left .13s}
.mdw-sw.on{background:#F2E31D;border-color:#D9CA10}
.mdw-sw.on i{left:22px}
.mdw-sw:focus-visible{outline:2px solid #046B45;outline-offset:2px}
.mdw-ro{background:#F6F9F7;border:1px solid #DCE5E0;border-radius:10px;padding:12px 13px}
.mdw-rr{display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0}
.mdw-rr span{color:#5C6B62}
.mdw-note{font-size:12px;color:#5C6B62;margin-top:9px;border-top:1px solid #E9EFEB;padding-top:9px}
.mdw-note a{color:#046B45}
.mdw-foot{flex:0 0 auto;border-top:1px solid #DCE5E0;background:#fff}
.mdw-diff{background:#F2F7FE;border-bottom:1px solid #D9E5F7;padding:13px 18px}
.mdw-dt{font-size:10.5px;letter-spacing:.12em;font-weight:700;color:#1B4F9C;margin-bottom:9px}
.mdw-dchip{display:inline-block;background:#fff;border:1px solid #C9DBF3;border-radius:7px;padding:4px 9px;font-size:12.5px;margin:0 6px 6px 0}
.mdw-dchip s{color:#5C6B62;text-decoration:line-through}
.mdw-dchip em{font-style:normal;color:#1B4F9C;font-weight:700}
.mdw-fine{font-size:11.5px;color:#264F8C;line-height:1.45;margin-top:3px}
.mdw-acts{display:flex;align-items:center;gap:9px;padding:13px 18px}
.mdw-cnt{font-size:13px;color:#5C6B62}
.mdw-msg{font-size:12.5px;font-weight:700}
.mdw-acts .mdw-sp{margin-left:auto;display:flex;gap:9px}
.mdw-gh{border:1px solid #DCE5E0;background:#fff;border-radius:9px;padding:9px 17px;color:#1B3227;font-family:inherit;font-weight:700;cursor:pointer}
.mdw-gh:disabled{opacity:.42;cursor:not-allowed}
.mdw-gh:not(:disabled):hover{background:#F2F7F4}
.mdw-go{border:0;background:#003326;color:#fff;border-radius:9px;padding:9px 21px;font-weight:700;font-family:inherit;cursor:pointer}
.mdw-go:disabled{background:#DCE3DF;color:#4E5A54;cursor:not-allowed}
.mdw-go:not(:disabled):hover{background:#01452F}
`;
