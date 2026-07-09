// Read-only diagnostic: hit the live MatchDay /admin/matches/{id}/players
// endpoint (the one syncMdapiMatches uses) and dump every promo-related
// field for is_first_match players, to see whether the API carries a promo
// code per player and under what name. Local only; not committed.
//   npx tsx scripts/check-firstmatch-promo-api.ts

import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const readEnv = (n: string) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
};

const baseUrl = readEnv("MATCHDAY_API_BASE_URL") || "https://playmatchday.herokuapp.com";
const email = readEnv("MATCHDAY_API_EMAIL")!;
const password = readEnv("MATCHDAY_API_PASSWORD")!;

// 14781: two NULL-promocode firstmatch claims (paid). 14748: firstmatch
// claims WITH promocode_id 10010 (free). 14751: promocode_id 12321.
const MATCH_IDS = [14781, 14748, 14751];

async function main() {
  const signin = await fetch(`${baseUrl}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const sj = await signin.json();
  const token =
    sj.accessToken ?? sj.access_token ?? sj.data?.accessToken ?? sj.data?.access_token;
  if (!token) {
    console.error("No token from signin:", {
      message: sj.message,
      statusCode: sj.statusCode,
      errorCode: sj.errorCode,
      emailLoaded: !!email,
      emailDomain: email ? email.split("@")[1] : null,
      passwordLen: password ? password.length : 0,
      baseUrl,
    });
    process.exit(1);
  }
  console.log("signed in OK\n");

  const promoKeyRe = /promo|code|discount|coupon/i;

  for (const mid of MATCH_IDS) {
    const res = await fetch(`${baseUrl}/admin/matches/${mid}/players`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const players = await res.json();
    if (!Array.isArray(players)) {
      console.log(`match ${mid}: unexpected response`, players);
      continue;
    }
    const firstMatchers = players.filter((p: any) => p.isFirstMatch === true);
    console.log(`=== match ${mid}: ${players.length} players, ${firstMatchers.length} first-match ===`);
    for (const p of firstMatchers) {
      // Any promo-ish key anywhere on the player or nested user.
      const promoKeysTop = Object.keys(p).filter((k) => promoKeyRe.test(k));
      const promoKeysUser = p.user ? Object.keys(p.user).filter((k) => promoKeyRe.test(k)) : [];
      console.log(
        JSON.stringify({
          id: p.id,
          userId: p.userId,
          isFirstMatch: p.isFirstMatch,
          promocodeId: p.promocodeId,
          amount: p.amount,
          paidStatus: p.paidStatus,
          promoKeysOnPlayer: promoKeysTop,
          promoValuesOnPlayer: Object.fromEntries(promoKeysTop.map((k) => [k, p[k]])),
          promoKeysOnUser: promoKeysUser,
        }),
      );
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
