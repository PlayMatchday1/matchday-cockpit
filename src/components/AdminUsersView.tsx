"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { type AppUser, useAuth } from "@/lib/useAuth";
import AddUserModal from "./AddUserModal";
import InlineEdit from "./InlineEdit";
import { CITY_SCOPES, cityNameFor, isUnknownScope } from "@/lib/cityScope";

type PermissionKey =
  | "is_admin"
  | "can_access_home"
  | "can_access_finance"
  | "can_access_growth"
  | "can_access_membership"
  | "can_access_matchops"
  | "can_access_chats"
  | "can_access_tech";

const PERMISSION_COLUMNS: { key: PermissionKey; label: string; hint?: string }[] = [
  { key: "is_admin", label: "Admin" },
  { key: "can_access_home", label: "Home" },
  { key: "can_access_finance", label: "Finance" },
  { key: "can_access_growth", label: "Player Lifecycle" },
  { key: "can_access_membership", label: "Membership" },
  { key: "can_access_matchops", label: "Match Ops" },
  {
    key: "can_access_chats",
    label: "Chats",
    hint: "Customer conversations · within Match Ops",
  },
  { key: "can_access_tech", label: "Tech" },
];

// Rendered AFTER the eight permission columns, as a pair: the tier and the scope it is worthless
// without. They are not PermissionKeys — neither is a plain boolean toggle on app_users, and both
// write through the guarded city-manager route.
const CITY_MANAGER_COLUMNS = ["City Manager", "City"] as const;

// WHO HAS ACTUALLY ARRIVED. app_users says what someone may do; only auth.users says whether they
// ever signed in. The grid showed the first and not the second, so an account whose invite silently
// never landed was indistinguishable from a working one — which is exactly how a real invite went
// missing without anyone noticing.
type AuthStatus = { invitedAt: string | null; confirmedAt: string | null; lastSignInAt: string | null };

function whenShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function lastLoginText(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sortUsers(users: AppUser[]): AppUser[] {
  return [...users].sort((a, b) => {
    const aName = (a.full_name ?? a.email).toLowerCase();
    const bName = (b.full_name ?? b.email).toLowerCase();
    return aName.localeCompare(bName);
  });
}

export default function AdminUsersView() {
  const { appUser } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [flashedId, setFlashedId] = useState<string | null>(null);
  const [permErr, setPermErr] = useState<{ id: string; msg: string } | null>(null);
  const [authStatus, setAuthStatus] = useState<Record<string, AuthStatus>>({});
  const [resend, setResend] = useState<{ email: string; msg: string; bad: boolean } | null>(null);
  const [resending, setResending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: loadErr } = await supabase
      .from("app_users")
      .select("*");
    if (loadErr) {
      setError(loadErr.message);
      setLoading(false);
      return;
    }
    setUsers(sortUsers((data ?? []) as AppUser[]));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // auth.users is service-role only, so this is a route rather than a client read.
  useEffect(() => {
    void (async () => {
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) return;
      const res = await fetch("/api/admin/users/auth-status", {
        headers: { Authorization: `Bearer ${sess.session.access_token}` }, cache: "no-store",
      }).catch(() => null);
      if (!res?.ok) return;
      const j = await res.json().catch(() => ({}));
      if (j?.users) setAuthStatus(j.users as Record<string, AuthStatus>);
    })();
  }, []);

  // RE-SEND. A silently undelivered invite had no recovery path short of the Supabase dashboard.
  // The result reports what is actually known — ACCEPTED, not delivered.
  async function resendInvite(user: AppUser) {
    setResending(user.id); setResend(null);
    const { data: sess } = await supabase.auth.getSession();
    try {
      const res = await fetch("/api/admin/users/resend-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(sess.session ? { Authorization: `Bearer ${sess.session.access_token}` } : {}) },
        body: JSON.stringify({ email: user.email }),
      });
      const j = await res.json().catch(() => ({}));
      setResend({ email: user.email, msg: (res.ok ? j.message : j.error) ?? `HTTP ${res.status}`, bad: !res.ok });
    } catch (e) {
      setResend({ email: user.email, msg: e instanceof Error ? e.message : String(e), bad: true });
    } finally { setResending(null); }
  }

  function flash(id: string) {
    setFlashedId(id);
    setTimeout(() => {
      setFlashedId((cur) => (cur === id ? null : cur));
    }, 800);
  }

  // MATCH OPS + EDIT MATCHES go through the guarded route so the hard rules apply
  // (edit requires matchops, revoke cascades, E2E can't edit, self-demotion guard). We do
  // NOT trust the optimistic value: on success we render the row the server re-read from
  // the DB (post-trigger truth); on failure we revert and surface the error INLINE — the
  // Clubhouse E2E row raises P0001 from the DB trigger and that message must be shown.
  async function saveMatchPermission(user: AppUser, patch: { canAccessMatchops?: boolean; canEditMatches?: boolean; canManagePlayers?: boolean }) {
    setPermErr((e) => (e?.id === user.id ? null : e));
    const original = users;
    setUsers((prev) => prev.map((u) => (u.id === user.id ? {
      ...u,
      // matchops off cascades BOTH write permissions off (rules mirrored server-side)
      ...(patch.canAccessMatchops !== undefined ? { can_access_matchops: patch.canAccessMatchops, can_edit_matches: patch.canAccessMatchops ? u.can_edit_matches : false, can_manage_players: patch.canAccessMatchops ? u.can_manage_players : false } : {}),
      ...(patch.canEditMatches !== undefined ? { can_edit_matches: patch.canEditMatches } : {}),
      ...(patch.canManagePlayers !== undefined ? { can_manage_players: patch.canManagePlayers } : {}),
    } : u)));
    const { data: sess } = await supabase.auth.getSession();
    let json: { user?: { can_access_matchops: boolean; can_edit_matches: boolean; can_manage_players?: boolean; is_service_account?: boolean }; error?: string } = {};
    try {
      const res = await fetch("/api/admin/users/match-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(sess.session ? { Authorization: `Bearer ${sess.session.access_token}` } : {}) },
        body: JSON.stringify({ userId: user.id, ...patch }),
      });
      json = await res.json().catch(() => ({}));
      if (!res.ok) { setUsers(original); setPermErr({ id: user.id, msg: json?.error ?? `HTTP ${res.status}` }); return; }
    } catch (e) { setUsers(original); setPermErr({ id: user.id, msg: e instanceof Error ? e.message : String(e) }); return; }
    // Render ACTUAL DB state returned by the server's re-read, never the optimistic value.
    const row = json.user;
    if (row) setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, can_access_matchops: row.can_access_matchops, can_edit_matches: row.can_edit_matches, ...(row.can_manage_players !== undefined ? { can_manage_players: row.can_manage_players } : {}), ...(row.is_service_account !== undefined ? { is_service_account: row.is_service_account } : {}) } : u)));
    flash(user.id);
  }

  // CITY MANAGER goes through its own guarded route, for the same reason MATCH OPS does: the hard
  // rules (allowlisted city, mutually exclusive with Admin, tier-off nulls the city, service
  // accounts refused, recordWrite) live on the server. The grid renders whatever the server
  // re-read from the database afterwards — never the optimistic value, because the 0120 trigger
  // nulls the city on its own and the grid must show what actually happened.
  async function saveCityManager(user: AppUser, patch: { isCityManager?: boolean; cityIdentifier?: string | null }) {
    setPermErr((e) => (e?.id === user.id ? null : e));
    const { data: sess } = await supabase.auth.getSession();
    try {
      const res = await fetch("/api/admin/users/city-manager", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(sess.session ? { Authorization: `Bearer ${sess.session.access_token}` } : {}) },
        body: JSON.stringify({ userId: user.id, ...patch }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setPermErr({ id: user.id, msg: json?.error ?? `HTTP ${res.status}` }); return; }
      const row = json.user as { is_city_manager: boolean; city_identifier: string | null } | undefined;
      if (row) setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, is_city_manager: row.is_city_manager, city_identifier: row.city_identifier } : u)));
      flash(user.id);
    } catch (e) { setPermErr({ id: user.id, msg: e instanceof Error ? e.message : String(e) }); }
  }

  async function togglePermission(user: AppUser, key: PermissionKey) {
    if (key === "is_admin" && appUser?.id === user.id) return;
    // Admins always have Finance access via is_admin — block toggling it
    // off on their own row so the UI doesn't mislead them.
    if (key === "can_access_finance" && appUser?.id === user.id) return;
    if (key === "can_access_matchops") { await saveMatchPermission(user, { canAccessMatchops: !user.can_access_matchops }); return; }
    const newValue = !user[key];
    // NO OPTIMISTIC UPDATE. The switch used to move BEFORE the await and only came back if
    // `updateErr` was truthy — which it never was, because RLS makes the client's UPDATE match zero
    // rows and return no error. A revoke that failed looked exactly like one that worked. The
    // toggle now moves when the SERVER confirms it moved.
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { alert("No active session."); return; }
    setSavingId(`${user.id}:${key}`);
    try {
      const res = await fetch("/api/admin/users/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: user.id, key, value: newValue }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; outcome?: string; error?: string; conflict?: string };
      if (!res.ok || !json.ok) {
        alert(`${json.error ?? `HTTP ${res.status}`}\n\nOutcome: ${json.outcome ?? "UNKNOWN"} — the setting was not changed.`);
        return;
      }
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, [key]: newValue } : u)));
      flash(user.id);
    } finally {
      setSavingId(null);
    }
  }

  async function updateName(user: AppUser, value: string) {
    const trimmed = value.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    if (next === user.full_name) return;
    // Same server route, same reason — see the toggle above.
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { alert("No active session."); return; }
    setSavingId(`${user.id}:full_name`);
    try {
      const res = await fetch("/api/admin/users/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: user.id, key: "full_name", value: next }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; outcome?: string; error?: string };
      if (!res.ok || !json.ok) {
        alert(`${json.error ?? `HTTP ${res.status}`}\n\nOutcome: ${json.outcome ?? "UNKNOWN"} — the name was not changed.`);
        return;
      }
      setUsers((prev) => sortUsers(prev.map((u) => (u.id === user.id ? { ...u, full_name: next } : u))));
      flash(user.id);
    } finally {
      setSavingId(null);
    }
  }

  async function deleteUser(user: AppUser) {
    if (appUser?.id === user.id) return;
    if (
      !confirm(
        `Delete ${user.full_name ?? user.email}? They'll lose access immediately.`,
      )
    ) {
      return;
    }
    // NO OPTIMISTIC REMOVAL. The row used to disappear on the line BEFORE the await and only came
    // back if `error` was truthy — which it never was, because RLS makes the client's DELETE match
    // zero rows and return 204 with error: null. A failed delete was indistinguishable from a
    // successful one until you refreshed. The row now goes when the SERVER confirms it went.
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { alert("No active session."); return; }
    setDeletingId(user.id);
    try {
      const res = await fetch("/api/admin/users/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: user.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; outcome?: string; error?: string };
      // THE VERDICT IS THE SERVER'S, and it comes from a re-read of both stores — not from res.ok.
      if (!res.ok || !json.ok) {
        alert(`${json.error ?? `HTTP ${res.status}`}\n\nOutcome: ${json.outcome ?? "UNKNOWN"} — nothing was removed from the list.`);
        return;
      }
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-deep-green/70">
          {users.length} {users.length === 1 ? "user" : "users"}
        </div>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover"
        >
          + Add user
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
          {error}
        </div>
      )}

      {/* ACCEPTED is not DELIVERED, and the banner says which one happened. */}
      {resend && (
        <div data-testid="resend-result" data-bad={resend.bad ? "true" : "false"}
          className={`rounded-md border px-3 py-2 text-sm ${resend.bad ? "border-coral/40 bg-coral-soft text-coral" : "border-cream-line bg-cream-soft text-deep-green/80"}`}>
          <b>{resend.email}</b> — {resend.msg}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-cream-line bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-3 py-3 text-left">Email</th>
                {PERMISSION_COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className="px-2 py-3 text-center"
                    title={c.hint}
                  >
                    {c.label}
                  </th>
                ))}
                {CITY_MANAGER_COLUMNS.map((label) => (
                  <th key={label} className="px-2 py-3 text-center" data-testid={`col-${label.toLowerCase().replace(/ /g, "-")}`}
                    title={label === "City" ? "The scope every page this account sees is filtered to" : "A scoped, non-admin tier — mutually exclusive with Admin"}>
                    {label}
                  </th>
                ))}
                <th className="px-2 py-3 text-left" data-testid="col-invited" title="When Supabase ACCEPTED an invite — not proof it was delivered">Invited</th>
                <th className="px-2 py-3 text-left" data-testid="col-signed-in" title="When they actually followed a link — the only proof of delivery this system gets">Signed in</th>
                <th className="px-3 py-3 text-left">Last login</th>
                <th className="px-3 py-3 text-right">{""}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={PERMISSION_COLUMNS.length + CITY_MANAGER_COLUMNS.length + 6}
                    className="px-4 py-8 text-center text-sm text-deep-green/50"
                  >
                    Loading…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td
                    colSpan={PERMISSION_COLUMNS.length + CITY_MANAGER_COLUMNS.length + 6}
                    className="px-4 py-8 text-center text-sm text-deep-green/50"
                  >
                    No users yet.
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isSelf = appUser?.id === u.id;
                  return (
                    <tr
                      key={u.id}
                      className={`border-t border-cream-line/40 ${
                        flashedId === u.id ? "flash-mint" : ""
                      }`}
                    >
                      <td className="px-4 py-2 align-middle">
                        <InlineEdit
                          value={u.full_name ?? ""}
                          onSave={(v) => updateName(u, v)}
                          className="text-sm font-bold text-deep-green"
                          inputClassName="text-sm font-bold text-deep-green"
                          placeholder="Add name"
                        />
                      </td>
                      <td className="px-3 py-2 align-middle text-sm text-deep-green/75">
                        {u.email}
                      </td>
                      {PERMISSION_COLUMNS.map((c) => {
                        const on = u[c.key];
                        const disabled =
                          (c.key === "is_admin" && isSelf) ||
                          (c.key === "can_access_finance" && isSelf);
                        if (c.key === "can_access_matchops") {
                          const matchops = !!u.can_access_matchops;
                          return (
                            <td key={c.key} className="px-2 py-2 align-middle text-center">
                              <div className="flex flex-col items-center gap-1">
                                <ToggleBox on={matchops} disabled={disabled} onClick={() => togglePermission(u, c.key)} label={`Match Ops (read) access for ${u.email}`} />
                                {/* EDIT MATCHES — nested under Match Ops (the WRITE permission), disabled when read is off */}
                                <div className="flex items-center gap-1 pl-3" title={u.is_service_account ? "The E2E service account can never hold EDIT MATCHES" : !matchops ? "Requires Match Ops" : "EDIT MATCHES — production writes"}>
                                  <span className="text-[8px] leading-none text-deep-green/40">↳ edit</span>
                                  <ToggleBox on={!!u.can_edit_matches} disabled={!matchops || !!u.is_service_account} onClick={() => saveMatchPermission(u, { canEditMatches: !u.can_edit_matches })} label={`EDIT MATCHES (write) for ${u.email}`} />
                                </div>
                                {/* MANAGE PLAYERS — INDEPENDENT of EDIT MATCHES (suspend/expel/lift); also disabled when read is off or service account */}
                                <div className="flex items-center gap-1 pl-3" title={u.is_service_account ? "The E2E service account can never hold MANAGE PLAYERS" : !matchops ? "Requires Match Ops" : "MANAGE PLAYERS — suspend / expel / lift"}>
                                  <span className="text-[8px] leading-none text-deep-green/40">↳ manage</span>
                                  <ToggleBox on={!!u.can_manage_players} disabled={!matchops || !!u.is_service_account} onClick={() => saveMatchPermission(u, { canManagePlayers: !u.can_manage_players })} label={`MANAGE PLAYERS (write) for ${u.email}`} />
                                </div>
                                {permErr?.id === u.id && (
                                  <span className="mt-1 max-w-[160px] text-[10px] leading-tight text-coral" data-testid="perm-error">{permErr.msg}</span>
                                )}
                              </div>
                            </td>
                          );
                        }
                        return (
                          <td
                            key={c.key}
                            className="px-2 py-2 align-middle text-center"
                          >
                            <ToggleBox
                              on={on}
                              disabled={disabled}
                              onClick={() => togglePermission(u, c.key)}
                              label={`${c.label} access for ${u.email}`}
                            />
                          </td>
                        );
                      })}
                      {/* CITY MANAGER — refused for admins in the UI as well as at the route, and
                          the reason is on screen rather than a silently disabled box. */}
                      <td className="px-2 py-2 align-middle text-center" data-testid="cell-city-manager">
                        <div className="flex flex-col items-center gap-1">
                          <ToggleBox
                            on={!!u.is_city_manager}
                            disabled={!!u.is_admin || !!u.is_service_account}
                            onClick={() => saveCityManager(u, { isCityManager: !u.is_city_manager, ...(u.is_city_manager ? {} : { cityIdentifier: u.city_identifier ?? CITY_SCOPES[1].identifier }) })}
                            label={`City Manager tier for ${u.email}`}
                          />
                          {u.is_admin && (
                            <span className="max-w-[120px] text-[9px] leading-tight text-deep-green/50" data-testid="cm-admin-conflict">
                              Admins can&rsquo;t be City Managers
                            </span>
                          )}
                        </div>
                      </td>
                      {/* CITY — A DROPDOWN, NEVER FREE TEXT. A typed value scopes the account to
                          nothing and looks identical here, which is why this was SQL-only before. */}
                      <td className="px-2 py-2 align-middle text-center" data-testid="cell-city">
                        {u.is_city_manager ? (
                          <div className="flex flex-col items-center gap-1">
                            <select
                              data-testid="city-select"
                              aria-label={`City scope for ${u.email}`}
                              value={u.city_identifier ?? ""}
                              onChange={(e) => saveCityManager(u, { cityIdentifier: e.target.value })}
                              className="rounded-md border border-cream-line bg-white px-2 py-1 text-xs text-deep-green"
                            >
                              {/* a stored value outside the list is shown as itself rather than
                                  silently re-pointed at a city this account was never scoped to */}
                              {isUnknownScope(u.city_identifier) && (
                                <option value={u.city_identifier ?? ""}>{u.city_identifier} — unknown</option>
                              )}
                              {CITY_SCOPES.map((c) => (
                                <option key={c.identifier} value={c.identifier}>{c.name}</option>
                              ))}
                            </select>
                            {isUnknownScope(u.city_identifier) && (
                              <span className="max-w-[120px] text-[9px] leading-tight text-coral" data-testid="city-unknown">
                                Not a known city — this account sees nothing
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-deep-green/35" data-testid="city-empty">&mdash;</span>
                        )}
                      </td>
                      {(() => {
                        const st = authStatus[(u.email ?? "").toLowerCase()];
                        const neverArrived = !!st && !st.confirmedAt;
                        return (
                          <>
                            <td className="px-2 py-2 align-middle text-xs text-deep-green/65" data-testid="cell-invited" data-value={st?.invitedAt ?? ""}>
                              {whenShort(st?.invitedAt ?? null)}
                            </td>
                            {/* NEVER SIGNED IN is the state worth seeing — it is what an
                                undelivered invite looks like, and it used to look like nothing. */}
                            <td className="px-2 py-2 align-middle text-xs" data-testid="cell-signed-in" data-value={st?.confirmedAt ?? ""}
                              data-never={neverArrived ? "true" : "false"}>
                              {st?.confirmedAt ? (
                                <span className="text-deep-green/65">{whenShort(st.confirmedAt)}</span>
                              ) : st ? (
                                <span className="flex flex-col items-start gap-1">
                                  <span className="text-coral" data-testid="never-signed-in">Never</span>
                                  <button type="button" data-testid="resend-invite" disabled={resending === u.id}
                                    onClick={() => void resendInvite(u)}
                                    className="rounded-md border border-cream-line px-2 py-0.5 text-[10px] font-bold text-deep-green/70 hover:bg-cream-soft disabled:opacity-50">
                                    {resending === u.id ? "Sending…" : "Re-send"}
                                  </button>
                                </span>
                              ) : (
                                <span className="text-deep-green/35">—</span>
                              )}
                            </td>
                          </>
                        );
                      })()}
                      <td className="px-3 py-2 align-middle text-sm text-deep-green/65">
                        {lastLoginText(u.last_login_at)}
                      </td>
                      <td className="px-3 py-2 align-middle text-right">
                        <button
                          type="button"
                          onClick={() => deleteUser(u)}
                          data-testid="delete-user"
                          disabled={isSelf || deletingId === u.id}
                          aria-label={`Delete ${u.email}`}
                          className="rounded-full p-1.5 text-deep-green/30 transition hover:bg-coral-soft hover:text-coral disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-deep-green/30"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-deep-green/55">
        Permission changes save immediately. Admin can&apos;t demote
        themselves — toggle is disabled on your own row.
      </p>

      {showAddModal && (
        <AddUserModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => {
            setShowAddModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ToggleBox({
  on,
  disabled,
  onClick,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={on}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md ring-1 ring-inset transition ${
        on
          ? "bg-mint text-deep-green ring-mint"
          : "bg-white text-transparent ring-cream-line hover:bg-cream-soft"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <Check className="h-3.5 w-3.5" />
    </button>
  );
}
