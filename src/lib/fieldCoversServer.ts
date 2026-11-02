import "server-only";
// FIELD COVER PHOTOS — the server half of /api/covers/*. Client-safe half: src/lib/fieldCovers.ts.
//
// THE GATE, in order (every route calls coversGate first):
//   1. Signed in with Match Ops read (authenticateMatchOpsRead: the E2E service account is refused there by email).
//   2. Not confined to a city. Covers are a field-wide setting and these routes take bare field and match ids.
//   3. LOCAL MODE ONLY, for now: the backend endpoints exist only on the local backend branch. Off, 503 and no
//      request leaves. When the backend ships, this is the one place that picks the production target.
//   4. Writes: EDIT MATCHES (can_edit_matches, read fresh by the auth helper), the same grant that edits a match
//      today. apiWrite enforces it again as the unbypassable chokepoint.
//   5. Writes: the signed-in person's email as X-Acting-Staff-Email (server session only, never the browser).
//
// EVERY WRITE: one attempt, never retried; recordWrite (which in local mode runs the write and read-back and
// stores nothing); a verdict from a read-back of the API, not from the 2xx. Never log a body that holds a person.

import { randomUUID } from "node:crypto";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, type ClientEnv, type WriteActor } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { localModeOn, LOCAL_MDAPI_HOST } from "@/lib/localMode";
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import { staffEmailOf, WHO_ARE_YOU } from "@/lib/staffIdentity";
import { S3_HOSTS } from "@/lib/fieldPhotos";
import { COVERS_UNAVAILABLE, coverFileProblem, type CoverVerdict } from "@/lib/fieldCovers";

export type CoversCtx = { env: ClientEnv; email: string; actor: WriteActor; staff: string | null; canEdit: boolean };

/** The target, or null when cover photos are not available here (see 3 above). */
export function coversEnv(): ClientEnv | null {
  return localModeOn() ? "local" : null;
}

export async function coversGate(req: Request, write: boolean): Promise<{ ok: true; ctx: CoversCtx } | { ok: false; res: Response }> {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return { ok: false, res: Response.json({ error: auth.error }, { status: auth.status }) };
  if (auth.confinedCity) return { ok: false, res: Response.json({ error: "Cover photos are managed by Match Ops, not per city." }, { status: 403 }) };
  const env = coversEnv();
  if (!env) return { ok: false, res: Response.json({ error: COVERS_UNAVAILABLE, unavailable: true }, { status: 503 }) };
  const ctx: CoversCtx = {
    env, email: auth.email, canEdit: auth.canEditMatches, staff: staffEmailOf(auth.email),
    actor: { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId },
  };
  if (write) {
    if (!auth.canEditMatches) {
      console.warn(`[field-covers] 403: ${auth.email} attempted a cover write without EDIT MATCHES`);
      return { ok: false, res: Response.json({ error: NO_EDIT_MATCHES }, { status: 403 }) };
    }
    if (!ctx.staff) return { ok: false, res: Response.json({ error: WHO_ARE_YOU }, { status: 400 }) };
  }
  return { ok: true, ctx };
}

/** GET /api/covers/status: available (local mode, not city-confined) and canEdit (EDIT MATCHES). */
export async function coversStatus(req: Request): Promise<Response> {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const env = coversEnv();
  return Response.json({
    available: env !== null && !auth.confinedCity, env, canEdit: auth.canEditMatches,
    reason: env === null ? COVERS_UNAVAILABLE : auth.confinedCity ? "Cover photos are managed by Match Ops, not per city." : null,
  });
}

export const coversGet = <T>(ctx: CoversCtx, path: string, query?: Record<string, string | number | boolean>) => apiGet<T>(ctx.env, path, query);

/** The backend's own words from a refusal ({ message, errorCode }), else the client's message. */
export function upstreamMessage(e: unknown): string {
  if (e instanceof WriteFailedError) {
    try {
      const j = JSON.parse(e.bodySnippet) as { message?: unknown; errorCode?: unknown };
      if (typeof j.message === "string") return j.message;
    } catch { /* not JSON, or cut at 200 characters */ }
  }
  return e instanceof Error ? e.message : String(e);
}

export function verdictForThrow(e: unknown): CoverVerdict {
  return e instanceof AmbiguousWriteError ? "UNKNOWN" : e instanceof WriteFailedError ? "FAILED" : (e instanceof Error && /Refusing/.test(e.message) ? "FAILED" : "UNKNOWN");
}

/* ONE COVER WRITE. `readBack` is the API's view after the write; `landed` says whether it shows the change.
 * Logged as source "Field covers · <what>". The body passed to the log is ids and names only. */
export async function coverWrite<T>(ctx: CoversCtx, opts: {
  what: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: Record<string, unknown>;
  matchId?: number | null; logBody: Record<string, unknown>;
  readBack: () => Promise<Record<string, unknown>>; landed: (after: Record<string, unknown>, result: unknown) => boolean;
}): Promise<{ verdict: CoverVerdict; result?: T; after?: Record<string, unknown>; error?: string; logRecorded: boolean }> {
  let result: unknown;
  let after: Record<string, unknown> | undefined;
  let reads = 0;
  const { outcome, error, logged } = await recordWrite(
    {
      env: ctx.env, source: `Field covers · ${opts.what}`, actorName: ctx.email, actorEmail: ctx.email,
      saveId: randomUUID(), matchId: opts.matchId ?? null, matchName: null,
      method: opts.method, path: opts.path, body: opts.logBody, keys: Object.keys(opts.logBody), label: (k) => k,
      applied: (_before, a) => opts.landed(a, result),
    },
    {
      // First call = before, second = after (recordWrite's contract). Only the after is kept.
      readResource: async () => { const r = await opts.readBack(); if (reads++ > 0) after = r; return r; },
      write: async () => { result = await apiWrite<T>(ctx.env, opts.method, opts.path, opts.body, ctx.actor, "edit", undefined, ctx.staff ?? undefined); return result; },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  if (error) return { verdict: verdictForThrow(error), error: upstreamMessage(error), logRecorded: logged };
  return { verdict: outcome === "landed" ? "LANDED" : "NOT APPLIED", result: result as T, after, logRecorded: logged };
}

export class UploadHostError extends Error {
  constructor(message: string) { super(message); this.name = "UploadHostError"; }
}

/* THE UPLOAD URL IS HOST-GUARDED ON THE PARSED HOST before a byte is sent (CLAUDE.md: every non-GET). Local mode:
 * exactly http://localhost:3010 (the dev upload route). Production (not reachable yet): the S3 bucket, https. */
export function assertCoverUploadHost(uploadUrl: string, env: ClientEnv): URL {
  let u: URL;
  try { u = new URL(uploadUrl); } catch { throw new UploadHostError("Refusing an un-parseable upload URL."); }
  const want = env === "local" ? { protocol: "http:", host: LOCAL_MDAPI_HOST } : { protocol: "https:", host: S3_HOSTS[env] };
  if (!want.host || u.protocol !== want.protocol || u.host !== want.host) {
    throw new UploadHostError(`Refusing to PUT to ${JSON.stringify(`${u.protocol}//${u.host}`)}; expected ${JSON.stringify(`${want.protocol}//${want.host}`)}.`);
  }
  return u;
}

/** The file from a multipart body, checked against the same rules the page shows. */
export async function fileFrom(req: Request): Promise<{ ok: true; file: File; form: FormData } | { ok: false; res: Response }> {
  let form: FormData;
  try { form = await req.formData(); } catch { return { ok: false, res: Response.json({ error: "No file was received." }, { status: 400 }) }; }
  const f = form.get("file");
  if (!(f instanceof File)) return { ok: false, res: Response.json({ error: "No file was received." }, { status: 400 }) };
  const problem = coverFileProblem(f);
  if (problem) return { ok: false, res: Response.json({ error: problem }, { status: 400 }) };
  return { ok: true, file: f, form };
}

/* STEP ONE OF EVERY IMAGE: an upload link (POST /files: creates nothing), the host guard, one PUT of the bytes.
 * Returns the fileKey to register. The PUT is storage, not the write the verdict is about: the register call is. */
export async function uploadCoverImage(ctx: CoversCtx, fieldId: number, kind: "extraCover" | "cover", file: File): Promise<{ ok: true; fileKey: string } | { ok: false; verdict: CoverVerdict; error: string }> {
  let link: { uploadURL?: string; fileKey?: string };
  try {
    link = await apiWrite(ctx.env, "POST", "/files", { contentType: file.type, entity: "field", entityContent: kind, entityId: fieldId }, ctx.actor, "edit", undefined, ctx.staff ?? undefined);
  } catch (e) {
    return { ok: false, verdict: "FAILED", error: `Couldn't get an upload link: ${upstreamMessage(e)}` };
  }
  if (!link?.uploadURL || !link.fileKey) return { ok: false, verdict: "FAILED", error: "The upload link came back without a URL or a file key. Nothing was uploaded." };
  let url: URL;
  try { url = assertCoverUploadHost(link.uploadURL, ctx.env); }
  catch (e) {
    console.error("[field-covers] upload host refused", e instanceof Error ? e.message : e);
    return { ok: false, verdict: "FAILED", error: "The upload link was not the expected storage host. Nothing was uploaded." };
  }
  try {
    // NO AUTHORIZATION HEADER: the link is presigned. ONE PUT, never retried.
    const res = await fetch(url.toString(), { method: "PUT", headers: { "Content-Type": file.type }, body: new Uint8Array(await file.arrayBuffer()), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, verdict: "FAILED", error: `The image upload was refused (HTTP ${res.status}). Nothing was saved.` };
  } catch (e) {
    return { ok: false, verdict: "UNKNOWN", error: `The image upload did not answer: ${e instanceof Error ? e.message : String(e)}. Nothing was registered.` };
  }
  return { ok: true, fileKey: link.fileKey };
}

export const idParam = (raw: string): number | null => (/^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= 2_147_483_647 ? Number(raw) : null);
