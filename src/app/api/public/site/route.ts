// GET /api/public/site — the same payload as /api/public/site.json, as a readable page, so what the
// website will show can be checked by eye. PUBLIC (it shows nothing the JSON does not). Read only.
import { buildPublicSite, EDGE_CACHE } from "@/lib/publicSiteServer";
import type { SiteCity, SiteField, SitePayload } from "@/lib/publicSite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const n = (x: number) => x.toLocaleString("en-US");
const MISSING = `<span class="bad">missing</span>`;
const dateLabel = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
};

function fieldRow(f: SiteField): string {
  const addr = [f.address.street, f.address.city, f.address.state, f.address.zip].filter(Boolean).join(", ");
  const sched = f.next_14_days.length
    ? f.next_14_days.map((m) => `${esc(dateLabel(m.date))} ${esc(m.kickoff_label)} · ${esc(m.format ?? "?")} · ${m.price_cents != null ? usd(m.price_cents) : "?"} · ${m.spots_open ?? "?"} of ${m.spots_total ?? "?"} open`).join("<br>")
    : `<span class="dim">none</span>`;
  return `<tr>
    <td class="img">${f.cover_photo_url ? `<img src="${esc(f.cover_photo_url)}" alt="" loading="lazy">` : MISSING}</td>
    <td><b>${esc(f.name)}</b><div class="dim">${esc(f.slug)} · field ${f.mdapi_field_ids.join(", ")}</div><div class="dim">${f.price_per_match_cents ? (f.price_per_match_cents.min === f.price_per_match_cents.max ? usd(f.price_per_match_cents.min) : `${usd(f.price_per_match_cents.min)}–${usd(f.price_per_match_cents.max)}`) : "no regular price"}${f.site_url ? ` · <a href="${esc(f.site_url)}">site page</a>` : " · no site page"}</div></td>
    <td><span class="pill ${f.status}">${f.status}</span>${f.first_match_date ? `<div>first ${esc(dateLabel(f.first_match_date))}</div>` : ""}</td>
    <td>${f.address.street ? esc(addr) : MISSING}<div class="dim">${f.lat != null ? `${f.lat}, ${f.lng}` : MISSING}</div></td>
    <td>${esc(f.formats.join(", ") || "—")}</td>
    <td>${esc(f.weekdays.join(" "))}</td>
    <td class="num">${f.matches_last_30_days}</td>
    <td class="sched">${sched}</td>
  </tr>`;
}

function citySection(c: SiteCity): string {
  const price = c.price_per_match_cents ? (c.price_per_match_cents.min === c.price_per_match_cents.max ? usd(c.price_per_match_cents.min) : `${usd(c.price_per_match_cents.min)}–${usd(c.price_per_match_cents.max)}`) : "—";
  return `<section>
  <h2>${esc(c.display_name)}${c.display_name !== c.full_name ? ` <span class="dim">(${esc(c.full_name)})</span>` : ""}${c.state ? `, ${esc(c.state)}` : ""} <span class="pill ${c.status}">${c.status.replace("_", " ")}</span></h2>
  <p class="meta">/${esc(c.slug)} · ${esc(c.time_zone ?? "no time zone")}${c.first_match_date ? ` · first match ${esc(dateLabel(c.first_match_date))}` : ""} · per match ${price} · membership ${c.membership_monthly_cents != null ? usd(c.membership_monthly_cents) + "/mo" : "—"}
   · ${n(c.counts.matches_last_30_days)} matches last 30 days · ${n(c.counts.matches_all_time)} all time · ${n(c.counts.players_all_time)} players all time</p>
  ${c.fields.length ? `<div class="scroll"><table><thead><tr><th>Photo</th><th>Field</th><th>Status</th><th>Address</th><th>Formats</th><th>Days</th><th>Last 30</th><th>Next 14 days</th></tr></thead><tbody>${c.fields.map(fieldRow).join("")}</tbody></table></div>` : `<p class="dim">No fields yet.</p>`}
</section>`;
}

function page(p: SitePayload): string {
  const t = p.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Website Feed</title>
<style>
:root{--bg:#fff;--fg:#16181d;--dim:#6b7280;--line:#e5e7eb;--card:#f8f9fb;--live:#0f7b3f;--up:#9a6700;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e8eaee;--dim:#9aa1ad;--line:#2a2e37;--card:#181b22;--live:#4cc38a;--up:#e3b341;--bad:#ff7b72}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1280px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 4px}
.meta,.dim{color:var(--dim)}.meta{margin:0 0 10px}.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px}.tile b{display:block;font-size:20px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:900px}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
th{font-size:12px;color:var(--dim);font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums}.sched{font-size:12px;white-space:nowrap}
.img img{width:96px;height:64px;object-fit:cover;border-radius:4px;display:block}.bad{color:var(--bad);font-weight:600}
.pill{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:2px 6px;border-radius:4px;border:1px solid currentColor;vertical-align:middle}
.live{color:var(--live)}.upcoming,.launching{color:var(--up)}.coming_soon{color:var(--dim)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;font-size:12px;color:var(--dim)}dt{font-weight:600}
</style></head><body><main>
<h1>Website feed</h1>
<p class="meta">What playmatchday.com reads from <a href="/api/public/site.json">/api/public/site.json</a> · schema v${p.schema_version} · built ${esc(p.generated_at)} (UTC) · rebuilt at most hourly</p>
<div class="tiles">
 <div class="tile"><b>${t.live_cities}</b>live cities</div><div class="tile"><b>${t.launching_cities}</b>launching</div>
 <div class="tile"><b>${t.live_fields}</b>live fields</div><div class="tile"><b>${t.upcoming_fields}</b>upcoming fields</div>
 <div class="tile"><b>${esc(t.matches_display)}</b>matches all time (${n(t.matches_all_time)})</div><div class="tile"><b>${esc(t.players_display)}</b>players all time (${n(t.players_all_time)})</div>
</div>
${p.cities.map(citySection).join("")}
<h2>Definitions</h2><dl>${Object.entries(p.definitions).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
</main></body></html>`;
}

export async function GET() {
  try {
    const p = await buildPublicSite();
    return new Response(page(p), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": EDGE_CACHE } });
  } catch (e) {
    console.error(`[public-site] page build failed: ${(e as Error).message}`);
    return new Response("<!doctype html><title>Website Feed</title><p>The site feed could not be built. Try again shortly.</p>", { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
