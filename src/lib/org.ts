export type OrgGroupKind = "org" | "team" | "city";

export type OrgGroup = {
  id: string;
  name: string;
  kind: OrgGroupKind;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
};

export type OrgPerson = {
  id: string;
  name: string;
  title: string | null;
  group_id: string | null;
  is_external: boolean;
  sort_order: number;
  created_at: string;
};

export type OrgDirectory = {
  groups: OrgGroup[];
  people: OrgPerson[];
};

export const GROUP_KIND_LABEL: Record<OrgGroupKind, string> = {
  org: "Whole org",
  team: "Team",
  city: "City",
};

export type DirectoryPartition = {
  root: OrgGroup | null;
  teams: OrgGroup[];
  cities: OrgGroup[];
  people: OrgPerson[];
};

export function partitionDirectory(dir: OrgDirectory): DirectoryPartition {
  const root = dir.groups.find((g) => g.kind === "org") ?? null;
  const teams = dir.groups
    .filter((g) => g.kind === "team")
    .sort((a, b) => a.name.localeCompare(b.name));
  const cities = dir.groups
    .filter((g) => g.kind === "city")
    .sort((a, b) => a.name.localeCompare(b.name));
  const people = [...dir.people].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { root, teams, cities, people };
}

export type OwnerLookup =
  | { kind: "person"; person: OrgPerson }
  | { kind: "group"; group: OrgGroup }
  | { kind: "unknown" };

export function lookupOwner(
  owner: string,
  dir: OrgDirectory | null,
): OwnerLookup {
  if (!dir || !owner) return { kind: "unknown" };
  const person = dir.people.find((p) => p.name === owner);
  if (person) return { kind: "person", person };
  const group = dir.groups.find((g) => g.name === owner);
  if (group) return { kind: "group", group };
  return { kind: "unknown" };
}
