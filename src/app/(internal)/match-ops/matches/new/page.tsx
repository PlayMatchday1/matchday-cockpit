import MatchEditor from "../[id]/MatchEditor";

// COPY A MATCH — step one of two.
//
// The SAME editor Gameday Ops uses, in create mode: pre-filled from ?from=<sourceId>, with the
// date deliberately blank. Nothing is written until Create is pressed. A static segment, so it
// takes precedence over [id] and "new" can never be read as a match id.
export const dynamic = "force-dynamic";

export default async function NewMatchPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const from = typeof sp.from === "string" && sp.from ? sp.from : null;
  return <MatchEditor id="new" mode="create" sourceId={from} />;
}
