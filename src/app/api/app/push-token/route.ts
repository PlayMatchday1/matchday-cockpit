// Staff app: the device's Expo push token. POST stores it against the signed-in staff member,
// DELETE removes it on sign-out. Nothing sends to these tokens yet.
//
// app_push_tokens is a Clubhouse-owned table with RLS on and no policies, so only the service role
// inside this route reads or writes it. Until its migration is applied the table does not exist and
// this route answers 503 with a sentence saying so, rather than pretending the token was stored.

import { authenticateApp } from "@/lib/appAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE_MISSING = "Push tokens cannot be stored yet: the app_push_tokens table has not been created.";
const missing = (msg: string | undefined) => /app_push_tokens/.test(msg ?? "") && /(does not exist|schema cache|not find)/i.test(msg ?? "");

const BUILD_TYPES = ["simulator_dev", "simulator_release", "device_dev", "testflight", "app_store", "device_release"];
/** The device label, build type, APNs environment and app version the app reports, checked. */
function deviceInfoOf(b: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof b?.deviceLabel === "string" && b.deviceLabel.trim()) out.device_label = b.deviceLabel.trim().slice(0, 80);
  if (typeof b?.buildType === "string" && BUILD_TYPES.includes(b.buildType)) out.build_type = b.buildType;
  if (b?.apsEnvironment === "development" || b?.apsEnvironment === "production") out.aps_environment = b.apsEnvironment;
  if (typeof b?.appVersion === "string" && b.appVersion.trim()) out.app_version = b.appVersion.trim().slice(0, 40);
  return out;
}

async function readBody(req: Request): Promise<{ token: string; platform: string } | null> {
  const b = (await req.json().catch(() => null)) as { token?: unknown; platform?: unknown } | null;
  const token = typeof b?.token === "string" ? b.token.trim() : "";
  const platform = typeof b?.platform === "string" ? b.platform : "";
  if (!/^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(token) || (platform !== "ios" && platform !== "android")) return null;
  return { token, platform };
}

export async function POST(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const raw = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null;
  const body = await readBody(req);
  if (!body) return Response.json({ error: "token (an Expo push token) and platform (ios | android) required" }, { status: 400 });
  const now = new Date().toISOString();
  const row = { token: body.token, app_user_id: auth.appUserId, platform: body.platform, last_seen_at: now };
  /* WHICH DEVICE AND WHICH BUILD (Ryan, 2026-10-30: so a token row is never a guess). Written once the
   * columns exist (migration 0242); until then the upsert without them still stores the token. */
  const info = deviceInfoOf(raw);
  let { error } = await auth.supabase.from("app_push_tokens").upsert({ ...row, ...info }, { onConflict: "token" });
  if (error && Object.keys(info).length && /column|schema cache/i.test(error.message) && !missing(error.message)) {
    ({ error } = await auth.supabase.from("app_push_tokens").upsert(row, { onConflict: "token" }));
  }
  if (error) return Response.json({ error: missing(error.message) ? TABLE_MISSING : error.message }, { status: missing(error.message) ? 503 : 500 });
  return Response.json({ stored: true });
}

export async function DELETE(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = await readBody(req);
  if (!body) return Response.json({ error: "token and platform required" }, { status: 400 });
  // Only this staff member's own token row, never another account's.
  const { error } = await auth.supabase.from("app_push_tokens").delete().eq("token", body.token).eq("app_user_id", auth.appUserId);
  if (error) return Response.json({ error: missing(error.message) ? TABLE_MISSING : error.message }, { status: missing(error.message) ? 503 : 500 });
  return Response.json({ removed: true });
}
