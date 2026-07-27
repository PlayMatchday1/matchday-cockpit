"use client";

// Admin surface for the Community WhatsApp invite poster (Cities → Field Ops →
// Community). Shows the run heartbeat, the global kill switch, and a per-city
// editor (invite URL + active toggle + 7-day post count). Reads GET
// /api/community/cities; mutates via the admin-gated PATCH routes.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isValidWhatsAppInviteUrl } from "@/lib/community";

type CityRow = {
  city_code: string;
  display_name: string;
  whatsapp_url: string | null;
  active: boolean;
  posts_last_7d: number;
  matches_last_30d: number;
  needs_setup: boolean;
};

type Unconfigured = {
  city_code: string;
  display_name: string;
  matches_last_30d: number;
};

type Settings = {
  posting_enabled: boolean;
  last_attempted_at: string | null;
  last_success_at: string | null;
  last_status: number | null;
  last_error: string | null;
};

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function agoMinutes(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function fmtAgo(min: number | null): string {
  if (min == null) return "never";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default function CommunityDashboard() {
  const [cities, setCities] = useState<CityRow[]>([]);
  const [unconfigured, setUnconfigured] = useState<Unconfigured[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("Not signed in.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/community/cities", { headers });
      const json = (await res.json()) as {
        cities?: CityRow[];
        unconfigured?: Unconfigured[];
        settings?: Settings;
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? "Failed to load.");
      } else {
        setCities(json.cities ?? []);
        setUnconfigured(json.unconfigured ?? []);
        setSettings(json.settings ?? null);
        setUrlDraft(
          Object.fromEntries((json.cities ?? []).map((c) => [c.city_code, c.whatsapp_url ?? ""])),
        );
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchCity = useCallback(
    async (code: string, patch: { whatsapp_url?: string; active?: boolean }) => {
      setBusy(code);
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) return;
        const res = await fetch(`/api/community/cities/${code}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(patch),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) setError(json.error ?? "Update failed.");
        else await load();
      } catch {
        setError("Network error.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const toggleKill = useCallback(
    async (next: boolean) => {
      if (next && !window.confirm("Enable community posting? Active cities will start posting invite links into finished match chats.")) {
        return;
      }
      setBusy("__kill__");
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) return;
        const res = await fetch("/api/community/settings", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ posting_enabled: next }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) setError(json.error ?? "Update failed.");
        else await load();
      } catch {
        setError("Network error.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const successMin = agoMinutes(settings?.last_success_at ?? null);
  const stale = successMin == null || successMin > 45;

  return (
    <div className="space-y-6">
      {/* Heartbeat + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${
            stale
              ? "border-coral/50 bg-coral-soft text-coral-hover"
              : "border-mint/50 bg-mint-soft text-deep-green"
          }`}
        >
          {stale ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          Last successful run: {fmtAgo(successMin)}
          {stale && " — check the schedule / endpoint"}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cream-line bg-white px-3 py-1.5 text-[13px] font-semibold text-deep-green transition hover:border-mint"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {settings && (settings.last_status && settings.last_status >= 400 ? (
        <div className="rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
          Last run reported status {settings.last_status}
          {settings.last_error ? ` — ${settings.last_error}` : ""}. Attempted{" "}
          {fmtAgo(agoMinutes(settings.last_attempted_at))}.
        </div>
      ) : null)}

      {error && (
        <div className="rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral-hover">
          {error}
        </div>
      )}

      {/* Global kill switch */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cream-line bg-white p-4">
        <div>
          <div className="text-sm font-bold text-deep-green">Global posting</div>
          <div className="text-xs text-deep-green/55">
            Master switch. When off, nothing posts no matter how cities are set.
          </div>
        </div>
        <button
          type="button"
          disabled={busy === "__kill__" || !settings}
          onClick={() => void toggleKill(!settings?.posting_enabled)}
          className={
            settings?.posting_enabled
              ? "rounded-full border border-mint/50 bg-mint-soft px-3 py-1 text-[13px] font-bold text-deep-green transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover disabled:opacity-50"
              : "rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-[13px] font-bold text-amber-700 transition hover:border-mint hover:bg-mint-soft hover:text-deep-green disabled:opacity-50"
          }
        >
          {settings?.posting_enabled ? "ON — posting enabled" : "OFF — posting disabled"}
        </button>
      </div>

      {/* Needs-setup: live markets that can't post yet (recent matches but no
          url, or no city row at all). */}
      {(unconfigured.length > 0 || cities.some((c) => c.needs_setup)) && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-amber-700">
            <AlertTriangle className="h-4 w-4" />
            Needs setup — markets with recent matches but no working invite
          </div>
          <ul className="mt-2 space-y-1 text-[13px] text-amber-800">
            {cities
              .filter((c) => c.needs_setup)
              .map((c) => (
                <li key={c.city_code}>
                  <span className="font-semibold">{c.display_name}</span>{" "}
                  <span className="font-mono text-amber-700/70">({c.city_code})</span> —{" "}
                  {c.matches_last_30d} match{c.matches_last_30d === 1 ? "" : "es"} in 30d, no
                  invite URL. Add one below.
                </li>
              ))}
            {unconfigured.map((u) => (
              <li key={u.city_code}>
                <span className="font-semibold">{u.display_name}</span>{" "}
                <span className="font-mono text-amber-700/70">({u.city_code})</span> —{" "}
                {u.matches_last_30d} match{u.matches_last_30d === 1 ? "" : "es"} in 30d, no city
                row yet. Add it to city_community_links.
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-city editor */}
      <div className="overflow-x-auto rounded-xl border border-cream-line">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="bg-cream-soft text-[11px] uppercase tracking-wide text-deep-green/50">
            <tr>
              <th className="px-3 py-2 font-semibold">City</th>
              <th className="px-3 py-2 font-semibold">WhatsApp invite URL</th>
              <th className="px-3 py-2 font-semibold">State</th>
              <th className="px-3 py-2 text-right font-semibold">Posts · 7d</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-line">
            {cities.map((c) => {
              const draft = urlDraft[c.city_code] ?? "";
              const dirty = draft.trim() !== (c.whatsapp_url ?? "");
              const draftValid = draft.trim() === "" || isValidWhatsAppInviteUrl(draft.trim());
              return (
                <tr key={c.city_code} className="bg-white align-top">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-deep-green">{c.display_name}</span>
                      {c.needs_setup && (
                        <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                          needs URL
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-deep-green/40">
                      {c.city_code} · {c.matches_last_30d} matches/30d
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={draft}
                        onChange={(e) =>
                          setUrlDraft((m) => ({ ...m, [c.city_code]: e.target.value }))
                        }
                        placeholder="https://chat.whatsapp.com/…"
                        className={`w-80 rounded-lg border bg-white px-2.5 py-1.5 text-[12px] text-deep-green outline-none ${
                          draftValid ? "border-cream-line focus:border-mint" : "border-coral/60"
                        }`}
                      />
                      <button
                        type="button"
                        disabled={busy === c.city_code || !dirty || !draftValid}
                        onClick={() => void patchCity(c.city_code, { whatsapp_url: draft.trim() })}
                        className="rounded-lg bg-deep-green px-2.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-deep-green-hover disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                    {!draftValid && (
                      <div className="mt-1 text-[11px] text-coral-hover">
                        Must be a chat.whatsapp.com invite link.
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={busy === c.city_code}
                      onClick={() => void patchCity(c.city_code, { active: !c.active })}
                      title={c.active ? "Active — click to pause" : "Inactive — click to activate"}
                      className={
                        c.active
                          ? "inline-flex items-center rounded-full border border-mint/50 bg-mint-soft px-2 py-0.5 text-[11px] font-semibold text-deep-green transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover disabled:opacity-50"
                          : "inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 transition hover:border-mint hover:bg-mint-soft hover:text-deep-green disabled:opacity-50"
                      }
                    >
                      {c.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-deep-green/70">
                    {c.posts_last_7d}
                  </td>
                </tr>
              );
            })}
            {cities.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-deep-green/45">
                  No cities configured. Run migration 0080.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
