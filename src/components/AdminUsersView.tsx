"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { type AppUser, useAuth } from "@/lib/useAuth";
import AddUserModal from "./AddUserModal";
import InlineEdit from "./InlineEdit";

type PermissionKey =
  | "is_admin"
  | "can_access_chats"
  | "can_access_clubhouse"
  | "can_access_cities"
  | "can_access_org"
  | "can_access_data"
  | "can_access_docs"
  | "can_access_finance";

const PERMISSION_COLUMNS: { key: PermissionKey; label: string }[] = [
  { key: "is_admin", label: "Admin" },
  { key: "can_access_chats", label: "Chats" },
  { key: "can_access_clubhouse", label: "Clubhouse" },
  { key: "can_access_cities", label: "Cities" },
  { key: "can_access_org", label: "Org" },
  { key: "can_access_data", label: "Data" },
  { key: "can_access_docs", label: "Docs" },
  { key: "can_access_finance", label: "Finance" },
];

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
  const [flashedId, setFlashedId] = useState<string | null>(null);

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

  function flash(id: string) {
    setFlashedId(id);
    setTimeout(() => {
      setFlashedId((cur) => (cur === id ? null : cur));
    }, 800);
  }

  async function togglePermission(user: AppUser, key: PermissionKey) {
    if (key === "is_admin" && appUser?.id === user.id) return;
    // Admins always have Finance access via is_admin — block toggling it
    // off on their own row so the UI doesn't mislead them.
    if (key === "can_access_finance" && appUser?.id === user.id) return;
    const newValue = !user[key];
    const original = users;
    setUsers((prev) =>
      prev.map((u) => (u.id === user.id ? { ...u, [key]: newValue } : u)),
    );
    const { error: updateErr } = await supabase
      .from("app_users")
      .update({ [key]: newValue })
      .eq("id", user.id);
    if (updateErr) {
      setUsers(original);
      alert(updateErr.message);
      return;
    }
    flash(user.id);
  }

  async function updateName(user: AppUser, value: string) {
    const trimmed = value.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    if (next === user.full_name) return;
    const original = users;
    setUsers((prev) =>
      sortUsers(
        prev.map((u) => (u.id === user.id ? { ...u, full_name: next } : u)),
      ),
    );
    const { error: updateErr } = await supabase
      .from("app_users")
      .update({ full_name: next })
      .eq("id", user.id);
    if (updateErr) {
      setUsers(original);
      alert(updateErr.message);
      return;
    }
    flash(user.id);
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
    const original = users;
    setUsers((prev) => prev.filter((u) => u.id !== user.id));
    const { error: delErr } = await supabase
      .from("app_users")
      .delete()
      .eq("id", user.id);
    if (delErr) {
      setUsers(original);
      alert(delErr.message);
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

      <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-cream-line bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-3 py-3 text-left">Email</th>
                {PERMISSION_COLUMNS.map((c) => (
                  <th key={c.key} className="px-2 py-3 text-center">
                    {c.label}
                  </th>
                ))}
                <th className="px-3 py-3 text-left">Last login</th>
                <th className="px-3 py-3 text-right">{""}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={PERMISSION_COLUMNS.length + 4}
                    className="px-4 py-8 text-center text-sm text-deep-green/50"
                  >
                    Loading…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td
                    colSpan={PERMISSION_COLUMNS.length + 4}
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
                      <td className="px-3 py-2 align-middle text-sm text-deep-green/65">
                        {lastLoginText(u.last_login_at)}
                      </td>
                      <td className="px-3 py-2 align-middle text-right">
                        <button
                          type="button"
                          onClick={() => deleteUser(u)}
                          disabled={isSelf}
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
