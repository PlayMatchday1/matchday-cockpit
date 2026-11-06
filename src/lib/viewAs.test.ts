// Run: `node --test src/lib/viewAs.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { signViewAs, verifyViewAs, canViewAs, viewAsMethodAllowed, applyViewAs, VIEW_AS_HEADER, VIEW_AS_ADMINS_ONLY, VIEW_AS_READ_ONLY, VIEW_AS_INVALID, VIEW_AS_EXPIRED, forwardedAuth } from "./viewAs.ts";

const SECRET = "test-secret";
process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
const admin = { id: "A", is_admin: true, full_name: "Ryan" };
const target = { id: "T", email: "garrett@x.com", is_city_manager: true, city_identifier: "ATX" };
const fakeSb = { from: () => ({ select: () => ({ eq: (_: string, id: string) => ({ maybeSingle: async () => ({ data: id === "T" ? target : null, error: null }) }) }) }) } as never;
const req = (method: string, token?: string) => new Request("http://x/api/app/production/today", { method, headers: token ? { [VIEW_AS_HEADER]: token } : {} });
const tok = (o: Partial<{ a: string; t: string; s: number; e: number }> = {}) => signViewAs({ a: "A", t: "T", s: 0, e: 10_000, ...o }, SECRET);

test("signature round-trips and rejects tampering or another key", () => {
  const t = tok();
  assert.deepEqual(verifyViewAs(t, SECRET), { a: "A", t: "T", s: 0, e: 10_000 });
  assert.equal(verifyViewAs(t, "other"), null);
  const [body, mac] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ a: "A", t: "X", s: 0, e: 10_000 })).toString("base64url");
  assert.equal(verifyViewAs(`${forged}.${mac}`, SECRET), null);
  assert.equal(verifyViewAs(body, SECRET), null);
  assert.equal(verifyViewAs("garbage", SECRET), null);
});

test("only an unconfined admin may view as; only reads pass", () => {
  assert.equal(canViewAs(admin), true);
  assert.equal(canViewAs({ ...admin, city_identifier: "ATX" }), false);
  assert.equal(canViewAs({ id: "C", is_city_manager: true, city_identifier: "ATX" }), false);
  assert.equal(canViewAs({ ...admin, is_service_account: true }), false);
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(viewAsMethodAllowed(m), false);
  assert.equal(viewAsMethodAllowed("GET"), true);
});

test("applyViewAs: no header is the real row; a good header is the viewed row", async () => {
  const none = await applyViewAs(req("GET"), fakeSb, admin, "r@x.com", 5);
  assert.ok(none.ok && none.row === admin && none.viewAs === null);
  const on = await applyViewAs(req("GET", tok()), fakeSb, admin, "r@x.com", 5);
  assert.ok(on.ok && on.row === target && on.email === "garrett@x.com" && on.viewAs?.adminId === "A");
});

test("applyViewAs refuses, never falls back to the admin", async () => {
  const cm = { id: "C", is_city_manager: true, city_identifier: "ATX" };
  assert.deepEqual(await applyViewAs(req("GET", signViewAs({ a: "C", t: "T", s: 0, e: 10_000 }, SECRET)), fakeSb, cm, "c@x.com", 5), { ok: false, status: 403, error: VIEW_AS_ADMINS_ONLY });
  assert.deepEqual(await applyViewAs(req("GET", tok({ a: "B" })), fakeSb, admin, "r@x.com", 5), { ok: false, status: 403, error: VIEW_AS_INVALID });
  assert.deepEqual(await applyViewAs(req("GET", tok()), fakeSb, admin, "r@x.com", 20_000), { ok: false, status: 403, error: VIEW_AS_EXPIRED });
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.deepEqual(await applyViewAs(req(m, tok()), fakeSb, admin, "r@x.com", 5), { ok: false, status: 403, error: VIEW_AS_READ_ONLY });
  const gone = await applyViewAs(req("GET", tok({ t: "Z" })), fakeSb, admin, "r@x.com", 5);
  assert.equal(gone.ok, false);
});

test("forwardedAuth carries the header on in-process calls", () => {
  const r = new Request("http://x", { headers: { authorization: "Bearer b", [VIEW_AS_HEADER]: "v" } });
  assert.deepEqual(forwardedAuth(r), { authorization: "Bearer b", [VIEW_AS_HEADER]: "v" });
  assert.deepEqual(forwardedAuth(new Request("http://x", { headers: { authorization: "Bearer b" } })), { authorization: "Bearer b" });
});
