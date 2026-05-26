"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type PermissionFlags = {
  is_admin: boolean;
  can_access_chats: boolean;
  can_access_clubhouse: boolean;
  can_access_cities: boolean;
  can_access_org: boolean;
  can_access_data: boolean;
  can_access_docs: boolean;
  can_access_finance: boolean;
};

const INITIAL_PERMISSIONS: PermissionFlags = {
  is_admin: false,
  can_access_chats: false,
  can_access_clubhouse: true,
  can_access_cities: false,
  can_access_org: false,
  can_access_data: false,
  can_access_docs: false,
  can_access_finance: false,
};

const PERMISSION_LABELS: { key: keyof PermissionFlags; label: string }[] = [
  { key: "is_admin", label: "Admin (full access + manage users)" },
  { key: "can_access_chats", label: "Chats" },
  { key: "can_access_clubhouse", label: "Clubhouse" },
  { key: "can_access_cities", label: "Cities" },
  { key: "can_access_org", label: "Org" },
  { key: "can_access_data", label: "Data" },
  { key: "can_access_docs", label: "Docs" },
  { key: "can_access_finance", label: "Finance" },
];

export default function AddUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [perms, setPerms] = useState<PermissionFlags>(INITIAL_PERMISSIONS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || saving) return;
    setSaving(true);
    setError(null);

    // The route does the same trim+lowercase server-side, but
    // normalize here too so app_users.email and the invite email
    // resolve identically regardless of operator typing.
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedFullName = fullName.trim() || null;

    // Send the caller's session bearer so the route's
    // isProvisioningOwner guard can resolve their Supabase UID and
    // confirm the action is allowed.
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      setSaving(false);
      setError("Your sign-in expired. Reload and try again.");
      return;
    }

    let res: Response;
    try {
      res = await fetch("/api/admin/users/invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          email: normalizedEmail,
          full_name: normalizedFullName,
          permissions: perms,
        }),
      });
    } catch (e) {
      setSaving(false);
      setError(
        `Network error: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    setSaving(false);

    if (res.ok) {
      onCreated();
      return;
    }

    // Adding users is locked to the provisioning owner. Other admins
    // who somehow open this modal (the +Add user button is admin-
    // gated, but isProvisioningOwner is stricter) get a clear note
    // instead of a generic 401 string.
    if (res.status === 401) {
      setError(
        "Only Ryan can provision new users. Ask him to add this account.",
      );
      return;
    }

    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && typeof data.error === "string") detail = data.error;
    } catch {
      // Non-JSON body — fall back to statusText.
    }
    setError(detail);
  }

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-deep-green/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="absolute left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-extrabold tracking-tight text-deep-green">
          Add user
        </h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <Field label="Email">
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@playmatchday.com"
              required
              className="w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
            />
          </Field>
          <Field label="Full name">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
            />
          </Field>
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              Permissions
            </div>
            <ul className="space-y-1.5">
              {PERMISSION_LABELS.map(({ key, label }) => (
                <li key={key}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-deep-green">
                    <input
                      type="checkbox"
                      checked={perms[key]}
                      onChange={(e) =>
                        setPerms((p) => ({ ...p, [key]: e.target.checked }))
                      }
                      className="h-4 w-4 accent-mint"
                    />
                    {label}
                  </label>
                </li>
              ))}
            </ul>
          </div>
          {error && (
            <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-1.5 text-xs text-coral">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-sm font-medium text-deep-green/70 hover:text-deep-green"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!email.trim() || saving}
              className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              {saving ? "Adding…" : "Add user"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      {children}
    </label>
  );
}
