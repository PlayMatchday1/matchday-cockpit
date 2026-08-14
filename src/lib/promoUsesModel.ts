// Who actually used a promo code — the model behind the uses drawer.
//
// Ryan's question is not "list the redemptions", it is "is somebody working this code". So the
// arithmetic that answers it is done HERE, once, rather than left for a reader to do while
// scanning rows.
//
// ── WHAT PART 0 PROVED, and what this is built on ───────────────────────────────────────────────
// A redemption lives on the USER-MATCH ROW: mdapi_match_players.promocode_id. There is no
// redemption table and no usage endpoint — `usageCount` on GET /admin/promocodes/{id} is an
// aggregate with nothing behind it. The row carries player name, email, phone, the match, the
// amount and created_at, which is everything this screen needs in one read.
//
// AND A REDEMPTION SURVIVES ACCOUNT DELETION. 3,258 distinct accounts appear in 14,146 redemption
// rows; 3,254 resolve in mdapi_users and 4 do not. That is the finding that makes this feature
// worth building: if the delete cascaded, this panel could only ever show honest users.

export type UseRow = {
  id: number;                 // the user-match row id — the redemption's own key
  // THE PLAYER ID SURVIVES DELETION. Proven in Part 0: 4 of 3,258 accounts in the redemption set
  // no longer resolve in mdapi_users, and their user-match rows still carry the id. So "deleted"
  // is NOT "playerId is null" — it is "playerId is present and no longer resolves", which is why
  // it is its own flag. Modelling it as a null id would scatter one person's uses across as many
  // groups as they had redemptions, and hide exactly the breach being hunted.
  playerId: number | null;
  deleted: boolean;           // the id no longer resolves to an account
  name: string | null;
  email: string | null;
  phone: string | null;
  at: string;                 // ISO instant of the redemption
  matchId: number | null;
  match: string | null;
  kickoff: string | null;
  city: string | null;
  amountCents: number;        // what this spot was worth
};

export type UseGroup = {
  key: string;
  playerId: number | null;
  deleted: boolean;
  deletedRef: string | null;  // whatever id survived
  name: string | null;
  email: string | null;
  phone: string | null;
  rows: UseRow[];
  uses: number;
  worthCents: number;
  overCap: boolean;
};

// A DELETED ACCOUNT IS STILL ONE PERSON, and it still has an id. Group on that id whether or not
// it resolves; two different deleted accounts stay two accounts, and one deleted account's five
// uses stay one block with a 5 on it. Only a row with no id at all falls back to its own row id,
// which at least keeps strangers from merging.
export const keyOf = (u: UseRow): string => (u.playerId != null ? `p${u.playerId}` : `r${u.id}`);
const groupKey = keyOf;

export function groupUses(rows: UseRow[], capPerUser: number): UseGroup[] {
  const m = new Map<string, UseGroup>();
  for (const u of rows) {
    const k = groupKey(u);
    let g = m.get(k);
    if (!g) {
      g = {
        key: k, playerId: u.playerId, deleted: u.deleted,
        deletedRef: u.deleted ? `user ${u.playerId ?? u.id}` : null,
        name: u.name, email: u.email, phone: u.phone,
        rows: [], uses: 0, worthCents: 0, overCap: false,
      };
      m.set(k, g);
    }
    g.rows.push(u);
  }
  for (const g of m.values()) {
    // NEWEST FIRST inside a group — the most recent use is the one being investigated.
    g.rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
    g.uses = g.rows.length;
    g.worthCents = g.rows.reduce((s, r) => s + (Number(r.amountCents) || 0), 0);
    // STRICTLY GREATER. A cap of 2 permits two uses; three is the breach. Getting this boundary
    // wrong would either cry wolf on every compliant account or miss the first offender.
    g.overCap = capPerUser > 0 && g.uses > capPerUser;
  }
  // heaviest first, then most recent — the offender should be the first thing on screen
  return [...m.values()].sort((a, b) => b.uses - a.uses || (a.rows[0]?.at < b.rows[0]?.at ? 1 : -1));
}

export type UsesSummary = {
  total: number;
  distinctUsers: number;
  capPerUser: number;
  usesPerUser: number;        // the average, to one decimal at the edge
  worthCents: number;
  breachers: UseGroup[];
  breach: boolean;
  breachWorthCents: number;
};

export function summarise(rows: UseRow[], capPerUser: number): UsesSummary {
  const groups = groupUses(rows, capPerUser);
  const breachers = groups.filter((g) => g.overCap);
  return {
    total: rows.length,
    distinctUsers: groups.length,
    capPerUser,
    usesPerUser: groups.length ? rows.length / groups.length : 0,
    worthCents: rows.reduce((s, r) => s + (Number(r.amountCents) || 0), 0),
    breachers,
    // THE BREACH IS THE HEADLINE. It is true only when a single ACCOUNT exceeded the per-user cap
    // — never when the total merely looks large. TOMBALL is the case this exists to get right:
    // 10 redemptions against a cap of 2 sounds alarming and is not, because it was 10 different
    // people using it once each.
    breach: breachers.length > 0,
    breachWorthCents: breachers.reduce((s, g) => s + g.worthCents, 0),
  };
}

// The chronological view. Keeps deleted rows — dropping them here would make the two views
// disagree about what happened, and the deleted ones are the interesting ones.
export function byTime(rows: UseRow[]): UseRow[] {
  return [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
}

export const money = (cents: number): string => `$${(Math.abs(cents) / 100).toFixed(2)}`;

// ── THE PII RULE ────────────────────────────────────────────────────────────────────────────────
// Name, email and phone are DISPLAYED because identifying a repeat offender is the entire job.
// They are never written to change_log. This is what a log entry about a promo may carry: ids and
// counts, nothing that identifies a redeemer.
export function loggableUsesSummary(promoId: number, s: UsesSummary): Record<string, unknown> {
  return {
    promoId,
    redemptions: s.total,
    distinctUsers: s.distinctUsers,
    capPerUser: s.capPerUser,
    breach: s.breach,
    breachingPlayerIds: s.breachers.map((g) => g.playerId),   // IDs ONLY — never name/email/phone
  };
}
