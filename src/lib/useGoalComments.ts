"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { GoalComment } from "./types";

type State = { comments: GoalComment[]; loading: boolean };

const INITIAL: State = { comments: [], loading: true };

let cached: State | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

async function load(): Promise<void> {
  publish({ comments: cached?.comments ?? [], loading: true });
  const { data } = await supabase
    .from("goal_comments")
    .select("*")
    .order("created_at", { ascending: true });
  publish({ comments: (data ?? []) as GoalComment[], loading: false });
}

export function useGoalComments(): State {
  const [s, setS] = useState<State>(cached ?? INITIAL);

  useEffect(() => {
    subscribers.add(setS);
    if (cached) {
      setS(cached);
    } else if (!pending) {
      pending = load().finally(() => {
        pending = null;
      });
    }
    return () => {
      subscribers.delete(setS);
    };
  }, []);

  return s;
}

export async function refetchGoalComments(): Promise<void> {
  await load();
}
