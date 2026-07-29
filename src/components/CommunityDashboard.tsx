"use client";

// Admin surface for the Community WhatsApp invite poster (Cities → Field Ops →
// Community). Now city → communities: single-community cities read as one row;
// Austin/Houston show their communities as sub-rows, each with its own invite
// URL, Save, state chip and Posts · 7d. Multi-community cities also expose a
// field editor so the field→community mapping is maintained without a
// migration. An unassigned field with recent matches is surfaced the same way
// "needs URL" is — never silently skipped.
//
// Reads GET /api/community/cities; mutates via PATCH /communities/[id],
// PUT /field-map, PATCH /settings — all admin-gated.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isValidWhatsAppInviteUrl } from "@/lib/community";

type CommunityRow = {
  id: number;
  name: string;
  whatsapp_url: string | null;
  active: boolean;
  activated_at: string | null;
  posts_last_7d: number;
  matches_last_30d: number;
  needs_url: boolean;
};
type FieldRow = {
  field_id: number;
  field_title: string | null;
  matches_30d: number;
  matches_90d: number;
  community_id: number | null;
};
type CityRow = {
  city_code: string;
  display_name: string;
  is_multi: boolean;
  null_posts_last_7d: number;
  communities: CommunityRow[];
  fields: FieldRow[];
};
type UnassignedField = {
  field_id: number;
  field_title: string | null;
  city_code: string;
  matches_30d: number;
};
type Unconfigured = { city_code: string; display_name: string; matches_last_30d: number };
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
  const [unassigned, setUnassigned] = useState<UnassignedField[]>([]);
  const [unconfigured, setUnconfigured] = useState<Unconfigured[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState<Record<number, string>>({});

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
        unassignedFields?: UnassignedField[];
        unconfigured?: Unconfigured[];
        settings?: Settings;
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? "Failed to load.");
      } else {
        const cs = json.cities ?? [];
        setCities(cs);
        setUnassigned(json.unassignedFields ?? []);
        setUnconfigured(json.unconfigured ?? []);
        setSettings(json.settings ?? null);
        setUrlDraft(
          Object.fromEntries(
            cs.flatMap((c) => c.communities.map((k) => [k.id, k.whatsapp_url ?? ""])),
          ),
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

  const patchCommunity = useCallback(
    async (id: number, patch: { whatsapp_url?: string; active?: boolean }) => {
      setBusy(`c${id}`);
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) return;
        const res = await fetch(`/api/community/communities/${id}`, {
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

  const assignField = useCallback(
    async (fieldId: number, communityId: number | null) => {
      setBusy(`f${fieldId}`);
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) return;
        const res = await fetch("/api/community/field-map", {
          method: "PUT",
          headers,
          body: JSON.stringify({ field_id: fieldId, community_id: communityId }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) setError(json.error ?? "Assignment failed.");
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
      if (
        next &&
        !window.confirm(
          "Enable community posting? Active communities will start posting invite links into finished match chats.",
        )
      ) {
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
  const anyNeedsUrl = cities.some((c) => c.communities.some((k) => k.needs_url));

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

      {settings && settings.last_status && settings.last_status >= 400 ? (
        <div className="rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
          Last run reported status {settings.last_status}
          {settings.last_error ? ` — ${settings.last_error}` : ""}. Attempted{" "}
          {fmtAgo(agoMinutes(settings.last_attempted_at))}.
        </div>
      ) : null}

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
            Master switch. When off, nothing posts no matter how communities are set.
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

      {/* Needs setup: communities that can't post (recent activity, no URL),
          unassigned fields in split cities, and unknown markets. */}
      {(anyNeedsUrl || unassigned.length > 0 || unconfigured.length > 0) && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-amber-700">
            <AlertTriangle className="h-4 w-4" />
            Needs setup
          </div>
          <ul className="mt-2 space-y-1.5 text-[13px] text-amber-800">
            {cities.flatMap((c) =>
              c.communities
                .filter((k) => k.needs_url)
                .map((k) => (
                  <li key={`nu-${k.id}`}>
                    <span className="font-semibold">
                      {c.display_name}
                      {c.is_multi ? ` · ${k.name}` : ""}
                    </span>{" "}
                    — {k.matches_last_30d} match{k.matches_last_30d === 1 ? "" : "es"} in 30d,
                    no invite URL. Add one below.
                  </li>
                )),
            )}
            {unassigned.map((f) => {
              const city = cities.find((c) => c.city_code === f.city_code);
              return (
                <li key={`ua-${f.field_id}`} className="flex flex-wrap items-center gap-2">
                  <span>
                    <span className="font-semibold">
                      {f.field_title ?? `field ${f.field_id}`}
                    </span>{" "}
                    <span className="font-mono text-amber-700/70">
                      (field {f.field_id}, {f.city_code})
                    </span>{" "}
                    — {f.matches_30d} match{f.matches_30d === 1 ? "" : "es"} in 30d, assigned to
                    no community. It posts nowhere until you assign it:
                  </span>
                  <select
                    disabled={busy === `f${f.field_id}`}
                    defaultValue=""
                    onChange={(e) =>
                      void assignField(
                        f.field_id,
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                    className="rounded border border-amber-300 bg-white px-2 py-1 text-[12px] text-deep-green"
                  >
                    <option value="">— assign —</option>
                    {(city?.communities ?? []).map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
            {unconfigured.map((u) => (
              <li key={`uc-${u.city_code}`}>
                <span className="font-semibold">{u.display_name}</span>{" "}
                <span className="font-mono text-amber-700/70">({u.city_code})</span> —{" "}
                {u.matches_last_30d} match{u.matches_last_30d === 1 ? "" : "es"} in 30d, no city
                row yet. Add it to city_community_links.
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-city → communities editor */}
      <div className="space-y-4">
        {cities.map((city) => (
          <div key={city.city_code} className="overflow-hidden rounded-xl border border-cream-line">
            <div className="flex items-center justify-between gap-2 bg-cream-soft px-3 py-2">
              <div className="text-sm font-bold text-deep-green">
                {city.display_name}{" "}
                <span className="font-mono text-[11px] font-normal text-deep-green/40">
                  {city.city_code}
                </span>
                {city.is_multi && (
                  <span className="ml-2 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold text-deep-green/60">
                    {city.communities.length} communities
                  </span>
                )}
              </div>
              {city.null_posts_last_7d > 0 && (
                <span className="text-[11px] text-deep-green/45">
                  {city.null_posts_last_7d} pre-split post
                  {city.null_posts_last_7d === 1 ? "" : "s"} · 7d
                </span>
              )}
            </div>

            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-deep-green/45">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">Community</th>
                  <th className="px-3 py-1.5 font-semibold">WhatsApp invite URL</th>
                  <th className="px-3 py-1.5 font-semibold">State</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Posts · 7d</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-line">
                {city.communities.map((k) => {
                  const draft = urlDraft[k.id] ?? "";
                  const dirty = draft.trim() !== (k.whatsapp_url ?? "");
                  const draftValid =
                    draft.trim() === "" || isValidWhatsAppInviteUrl(draft.trim());
                  const b = busy === `c${k.id}`;
                  return (
                    <tr key={k.id} className="bg-white align-top">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-deep-green">{k.name}</span>
                          {k.needs_url && (
                            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                              needs URL
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-deep-green/40">
                          {k.matches_last_30d} matches/30d
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <input
                            value={draft}
                            onChange={(e) =>
                              setUrlDraft((m) => ({ ...m, [k.id]: e.target.value }))
                            }
                            placeholder="https://chat.whatsapp.com/…"
                            className={`w-80 rounded-lg border bg-white px-2.5 py-1.5 text-[12px] text-deep-green outline-none ${
                              draftValid ? "border-cream-line focus:border-mint" : "border-coral/60"
                            }`}
                          />
                          <button
                            type="button"
                            disabled={b || !dirty || !draftValid}
                            onClick={() =>
                              void patchCommunity(k.id, { whatsapp_url: draft.trim() })
                            }
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
                          disabled={b}
                          onClick={() => void patchCommunity(k.id, { active: !k.active })}
                          title={k.active ? "Active — click to pause" : "Inactive — click to activate"}
                          className={
                            k.active
                              ? "inline-flex items-center rounded-full border border-mint/50 bg-mint-soft px-2 py-0.5 text-[11px] font-semibold text-deep-green transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover disabled:opacity-50"
                              : "inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 transition hover:border-mint hover:bg-mint-soft hover:text-deep-green disabled:opacity-50"
                          }
                        >
                          {k.active ? "Active" : "Inactive"}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-deep-green/70">
                        {k.posts_last_7d}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Field editor — only for multi-community cities. */}
            {city.is_multi && city.fields.length > 0 && (
              <div className="border-t border-cream-line bg-cream-soft/40 px-3 py-3">
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-deep-green/45">
                  Fields in {city.display_name} → community (last 90d)
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-[12px]">
                    <tbody className="divide-y divide-cream-line/70">
                      {city.fields.map((f) => (
                        <tr key={f.field_id} className="align-middle">
                          <td className="py-1.5 pr-3">
                            <span className="font-semibold text-deep-green">
                              {f.field_title ?? `field ${f.field_id}`}
                            </span>{" "}
                            <span className="font-mono text-[10px] text-deep-green/40">
                              #{f.field_id}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums text-deep-green/55">
                            {f.matches_30d}/30d · {f.matches_90d}/90d
                          </td>
                          <td className="py-1.5">
                            <select
                              disabled={busy === `f${f.field_id}`}
                              value={f.community_id ?? ""}
                              onChange={(e) =>
                                void assignField(
                                  f.field_id,
                                  e.target.value ? Number(e.target.value) : null,
                                )
                              }
                              className={`rounded border bg-white px-2 py-1 text-[12px] text-deep-green ${
                                f.community_id == null && f.matches_30d > 0
                                  ? "border-amber-400"
                                  : "border-cream-line"
                              }`}
                            >
                              <option value="">— unassigned —</option>
                              {city.communities.map((k) => (
                                <option key={k.id} value={k.id}>
                                  {k.name}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ))}
        {cities.length === 0 && !loading && (
          <div className="rounded-xl border border-cream-line px-3 py-6 text-center text-sm text-deep-green/45">
            No cities configured. Run migrations 0080 + 0084.
          </div>
        )}
      </div>
    </div>
  );
}
