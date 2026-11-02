import "server-only";
// STAFF APP: CALL A DESKTOP ROUTE HANDLER IN PROCESS, as the caller. The /api/app routes write and
// read nothing of their own where a desktop route already does it: they hand the desktop handler a
// request carrying the caller's own Authorization header, at the desktop URL, so its permission
// gate, city boundary, guarded write client and change_log entry all apply unchanged.

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;
type NoParams = (req: Request) => Promise<Response>;

export type Called = { status: number; ok: boolean; json: Record<string, unknown> | null };

export async function callDesktop<P>(
  from: Request, handler: Handler<P> | NoParams, path: string,
  init: { method?: string; body?: unknown } = {}, params?: P,
): Promise<Called> {
  const origin = new URL(from.url).origin;
  const headers: Record<string, string> = { authorization: from.headers.get("authorization") ?? "" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`${origin}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const res = params === undefined ? await (handler as NoParams)(req) : await (handler as Handler<P>)(req, { params: Promise.resolve(params) });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, ok: res.ok, json };
}

/** The desktop's own refusal, passed through as it came. */
export const passThrough = (c: Called) => Response.json(c.json ?? { error: `HTTP ${c.status}` }, { status: c.status });
