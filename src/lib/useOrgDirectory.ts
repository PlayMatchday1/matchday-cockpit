"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { OrgDirectory, OrgGroup, OrgPerson } from "./org";

let cached: OrgDirectory | null = null;
let pending: Promise<OrgDirectory> | null = null;
const subscribers = new Set<(d: OrgDirectory) => void>();

async function fetchAll(): Promise<OrgDirectory> {
  const [groups, people] = await Promise.all([
    supabase
      .from("org_groups")
      .select("*")
      .order("sort_order")
      .order("name"),
    supabase
      .from("org_people")
      .select("*")
      .order("sort_order")
      .order("name"),
  ]);
  const d: OrgDirectory = {
    groups: (groups.data ?? []) as OrgGroup[],
    people: (people.data ?? []) as OrgPerson[],
  };
  cached = d;
  subscribers.forEach((fn) => fn(d));
  return d;
}

export function useOrgDirectory(): OrgDirectory | null {
  const [dir, setDir] = useState<OrgDirectory | null>(cached);

  useEffect(() => {
    subscribers.add(setDir);
    if (cached) {
      setDir(cached);
    } else if (!pending) {
      pending = fetchAll().finally(() => {
        pending = null;
      });
    }
    return () => {
      subscribers.delete(setDir);
    };
  }, []);

  return dir;
}

export async function refetchOrgDirectory(): Promise<void> {
  await fetchAll();
}
