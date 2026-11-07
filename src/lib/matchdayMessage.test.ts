// Run: `node --test src/lib/matchdayMessage.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchdayMessage } from "./matchdayMessage.ts";

test("MatchDay's own words out of a refusal body", () => {
  assert.equal(matchdayMessage('{"statusCode":400,"message":"Match already finished"}'), "Match already finished");
  assert.equal(matchdayMessage('{"message":["a","b"]}'), "a; b");
  assert.equal(matchdayMessage('{"error":"Forbidden"}'), "Forbidden");
  assert.equal(matchdayMessage("Bad Request"), "Bad Request");
  assert.equal(matchdayMessage("<html>500</html>"), null);
  assert.equal(matchdayMessage(""), null);
  assert.equal(matchdayMessage('{"statusCode":400}'), null);
});
