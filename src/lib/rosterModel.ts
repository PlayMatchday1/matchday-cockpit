// The roster plan is a DIFF, not a journal (same rule the field editors use, over a
// SET of calls instead of one body). Given the loaded roster + the on-screen state,
// planRoster returns the exact ordered list of requests a save will fire — move a
// player twice and it is one request; move them and back and it is none.
//
// Endpoints are the ones PROVEN on staging in Phase 13 Part 1 (the mockup/Phase-6
// inventory were wrong twice):
//   add     POST   /admin/matches/{id}/players/{playerId}   {team, playerNumber}
//   fake+   POST   /admin/matches/{id}/fake-players          {team, playerNumber}
//   move    POST   /admin/user-matches                       {userMatchId, team, playerNumber}
//   remove  DELETE /admin/matches/user-matches/{userMatchId}
//   fake ~  PATCH  /admin/players/{playerId}/fake-player
//   teams   PUT    /admin/teams/{teamId}                     {name?, locked?}  (never password)
//   shape   PUT    /admin/matches/{id}                       {teamNumbers, maxPlayerCount, maxTeamSize{2,4}Team}
// mark-absent is intentionally ABSENT: its documented route 404s on staging.
//
// The two ids are different and getting them wrong targets the wrong record:
//   move + remove key on userMatchId ; add + fake key on playerId.

export type LoadedPlayer = { umId: number; playerId: number; team: number; num: number; fake: boolean };
export type StatePlayer = {
  key: string;            // stable UI key
  umId: number | null;    // null until saved (added players)
  playerId: number | null;// null for a not-yet-created fake
  team: number | null;    // null = removed from the match
  num: number | null;
  fake: boolean;
  added: boolean;         // staged this session
};
export type TeamState = { teamNumber: number; name: string; locked: boolean };
export type Shape = { perTeam: number; teamN: number };

export type RosterRequest = {
  kind: "shape" | "teams" | "add" | "add-fake" | "move" | "remove" | "fake";
  method: "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
  label: string;
  idField?: "userMatchId" | "playerId"; // which id this request keys on (asserted)
};

const norm = (v: unknown) => (v === null || v === undefined || v === "" ? null : v);

export function planRoster(
  matchId: number,
  loaded: Record<number, LoadedPlayer>,     // by playerId
  state: StatePlayer[],
  loadedTeams: Record<number, { name: string; locked: boolean }>, // by teamId
  teams: (TeamState & { id: number })[],
  loadedShape: Shape,
  shape: Shape,
  teamName: (i: number) => string,
): RosterRequest[] {
  const out: RosterRequest[] = [];

  // 1. shape (match endpoint) — teamNumbers + maxPlayerCount + the cap for the
  //    format actually in play; the OTHER format's cap is left alone.
  if (shape.perTeam !== loadedShape.perTeam || shape.teamN !== loadedShape.teamN) {
    const total = shape.teamN * shape.perTeam;
    const body: Record<string, unknown> = { teamNumbers: shape.teamN, maxPlayerCount: total };
    if (shape.teamN === 2) body.maxTeamSize2Team = total;
    else if (shape.teamN === 4) body.maxTeamSize4Team = total;
    out.push({ kind: "shape", method: "PUT", path: `/admin/matches/${matchId}`, body,
      label: `Set the match to ${shape.teamN} teams of ${shape.perTeam} — ${total} spots` });
  }

  // 2. team name / lock (teams endpoint) — changed fields only, never password.
  for (const t of teams) {
    const L = loadedTeams[t.id];
    if (!L) continue;
    const body: Record<string, unknown> = {};
    if (t.name !== L.name) body.name = t.name;
    if (t.locked !== L.locked) body.locked = t.locked;
    if (!Object.keys(body).length) continue;
    out.push({ kind: "teams", method: "PUT", path: `/admin/teams/${t.id}`, body,
      label: body.name !== undefined
        ? `Rename “${L.name}” → “${t.name}”${body.locked !== undefined ? ` and ${t.locked ? "lock" : "unlock"} it` : ""}`
        : `${t.locked ? "Lock" : "Unlock"} ${L.name}` });
  }

  // 3. players — add / remove / move / fake.
  for (const p of state) {
    // added this session
    if (p.added) {
      if (p.team === null) continue; // added then removed before saving → nothing
      if (p.playerId === null || p.fake) {
        out.push({ kind: "add-fake", method: "POST", path: `/admin/matches/${matchId}/fake-players`,
          body: { team: teamNumberOf(teams, p.team), playerNumber: p.num },
          label: `Add fake player to ${teamName(p.team)} #${p.num}` });
      } else {
        out.push({ kind: "add", method: "POST", path: `/admin/matches/${matchId}/players/${p.playerId}`,
          body: { team: teamNumberOf(teams, p.team), playerNumber: p.num }, idField: "playerId",
          label: `Add player to ${teamName(p.team)} #${p.num}` });
      }
      continue;
    }
    const L = p.playerId !== null ? loaded[p.playerId] : undefined;
    if (!L) continue;
    // removed
    if (p.team === null) {
      out.push({ kind: "remove", method: "DELETE", path: `/admin/matches/user-matches/${p.umId}`,
        idField: "userMatchId", label: `Remove player from the match` });
      continue;
    }
    // moved
    if (L.team !== p.team || L.num !== p.num) {
      out.push({ kind: "move", method: "POST", path: `/admin/user-matches`,
        body: { userMatchId: p.umId, team: teamNumberOf(teams, p.team), playerNumber: p.num }, idField: "userMatchId",
        label: `Move — ${teamName(L.team)} #${L.num} → ${teamName(p.team)} #${p.num}` });
    }
    // fake toggled
    if (norm(L.fake) !== norm(p.fake)) {
      out.push({ kind: "fake", method: "PATCH", path: `/admin/players/${p.playerId}/fake-player`,
        idField: "playerId", label: `${p.fake ? "Set" : "Unset"} as a fake player` });
    }
  }
  return out;
}

// team array index -> the API teamNumber (1-indexed on the match).
function teamNumberOf(teams: { teamNumber: number }[], idx: number): number {
  return teams[idx]?.teamNumber ?? idx + 1;
}
