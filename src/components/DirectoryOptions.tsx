import type { DirectoryPartition } from "@/lib/org";

export default function DirectoryOptions({
  partition,
}: {
  partition: DirectoryPartition;
}) {
  return (
    <>
      {partition.people.length > 0 && (
        <optgroup label="People">
          {partition.people.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
              {p.title ? ` — ${p.title}` : ""}
            </option>
          ))}
        </optgroup>
      )}
      {partition.teams.length > 0 && (
        <optgroup label="Teams">
          {partition.teams.map((g) => (
            <option key={g.id} value={g.name}>
              {g.name}
            </option>
          ))}
        </optgroup>
      )}
      {partition.cities.length > 0 && (
        <optgroup label="Cities">
          {partition.cities.map((g) => (
            <option key={g.id} value={g.name}>
              {g.name}
            </option>
          ))}
        </optgroup>
      )}
      {partition.root && (
        <optgroup label="Whole org">
          <option value={partition.root.name}>{partition.root.name}</option>
        </optgroup>
      )}
    </>
  );
}
