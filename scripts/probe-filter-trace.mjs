// Verify the comparison logic in isolation. Synthetic rows with the
// exact format dateToLocalIso emits.
const baseline = "2026-03-31";
const synth = [
  { match_start: "2026-02-15T19:30:00", expect: "drop" },
  { match_start: "2026-03-30T23:59:00", expect: "drop" },
  { match_start: "2026-03-31T00:00:00", expect: "keep" },
  { match_start: "2026-03-31T19:30:00", expect: "keep" },
  { match_start: "2026-04-15T19:30:00", expect: "keep" },
  { match_start: "2026-05-02T10:00:00", expect: "keep" },
];
console.log("baseline:", JSON.stringify(baseline));
for (const r of synth) {
  const sliced = r.match_start.slice(0, 10);
  const kept = sliced >= baseline;
  console.log(
    `match_start=${r.match_start}  slice=${JSON.stringify(sliced)}  >= baseline? ${kept}  expected=${r.expect}  ${kept === (r.expect === "keep") ? "OK" : "BUG"}`
  );
}
