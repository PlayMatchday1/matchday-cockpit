"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type PermissionFlags = {
  is_admin: boolean;
  can_access_clubhouse: boolean;
  can_access_cities: boolean;
  can_access_org: boolean;
  can_access_data: boolean;
  can_access_docs: boolean;
};

const INITIAL_PERMISSIONS: PermissionFlags = {
  is_admin: false,
  can_access_clubhouse: true,
  can_access_cities: false,
  can_access_org: false,
  can_access_data: false,
  can_access_docs: false,
};

const PERMISSION_LABELS: { key: keyof PermissionFlags; label: string }[] = [
  { key: "is_admin", label: "Admin (full access + manage users)" },
  { key: "can_access_clubhouse", label: "Clubhouse" },
  { key: "can_access_cities", label: "Cities" },
  { key: "can_access_org", label: "Org" },
  { key: "can_access_data", label: "Data" },
  { key: "can_access_docs", label: "Docs" },
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
    const { error: insertErr } = await supabase.from("app_users").insert({
      email: email.trim().toLowerCase(),
      full_name: fullName.trim() || null,
      ...perms,
    });
    setSaving(false);
    if (insertErr) {
      setError(insertErr.message);
      return;
    }
    onCreated();
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
