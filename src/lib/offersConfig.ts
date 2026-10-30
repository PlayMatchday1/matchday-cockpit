import "server-only";
// GROWTH › OFFERS, WHERE IT TALKS TO. Read from the environment on every request, and any problem
// closes the whole page (offersGate answers 503). There is no default for anything.
//
//   OFFERS_ENV            local | staging | production
//   OFFERS_API_BASE_URL   the backend, e.g. http://localhost:3070
//   OFFERS_UPLOAD_HOST    the one host a photo upload link may point at, e.g. localhost:3070
//
// A CONFIG STRING NEVER WIDENS THE HOST GUARD. The base URL's parsed host must be the write client's
// own allowlisted host for that environment, and the client checks it again on every request. local
// also needs local mode on, and local mode on refuses staging and production, so a dev server can't
// reach a real backend by way of these variables. The full list for release is in docs/LATER.md.

import { LOCAL_MDAPI_HOST, localModeOn } from "@/lib/localMode";
import { MATCHDAY_HOSTS, type ClientEnv } from "@/lib/matchdayStageApi";

export type OffersConfig = { env: ClientEnv; baseUrl: string; uploadHost: string };
export type OffersConfigResult = { ok: true; config: OffersConfig } | { ok: false; problem: string };
type Env = Record<string, string | undefined>;

// A bare host, with a port if it has one: no scheme, path, wildcard or credentials.
function isBareHost(v: string): boolean {
  try { return /^[a-z0-9.:-]+$/.test(v) && new URL(`https://${v}`).host.replace(/:443$/, "") === v.replace(/:443$/, ""); } catch { return false; }
}

export function readOffersConfig(e: Env = process.env): OffersConfigResult {
  const no = (problem: string): OffersConfigResult => ({ ok: false, problem });
  const env = e.OFFERS_ENV;
  if (env !== "local" && env !== "staging" && env !== "production") return no("OFFERS_ENV must be local, staging or production");
  const local = localModeOn(e);
  if (env === "local" && !local) return no("OFFERS_ENV is local but local mode is off (MATCHDAY_LOCAL_API=1 under next dev)");
  if (env !== "local" && local) return no(`OFFERS_ENV is ${env} but local mode is on, which reaches only the local backend`);
  const expected = env === "local" ? LOCAL_MDAPI_HOST : MATCHDAY_HOSTS[env];
  let base: URL;
  try { base = new URL(e.OFFERS_API_BASE_URL ?? ""); } catch { return no("OFFERS_API_BASE_URL is unset or not a URL"); }
  if (base.host !== expected) return no(`OFFERS_API_BASE_URL must be on ${expected} for OFFERS_ENV=${env}`);
  if (base.protocol !== "https:" && !(env === "local" && base.protocol === "http:")) return no("OFFERS_API_BASE_URL must be https");
  if (base.pathname !== "/" || base.search || base.username || base.password) return no("OFFERS_API_BASE_URL must be the bare origin");
  const uploadHost = e.OFFERS_UPLOAD_HOST ?? "";
  if (!isBareHost(uploadHost)) return no("OFFERS_UPLOAD_HOST must be a bare host, such as bucket.s3.amazonaws.com");
  return { ok: true, config: { env, baseUrl: base.origin, uploadHost } };
}
