"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import {
  TOPIC_STATUS_ORDER,
  type Topic,
  type TopicStatus,
} from "./topics";

type State = {
  topics: Topic[];
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { topics: [], loading: true, error: null };

let cached: State | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

function sortTopics(topics: Topic[]): Topic[] {
  return [...topics].sort((a, b) => {
    const aOrder = TOPIC_STATUS_ORDER[a.status as TopicStatus] ?? 99;
    const bOrder = TOPIC_STATUS_ORDER[b.status as TopicStatus] ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aSort = a.sort_order ?? Number.POSITIVE_INFINITY;
    const bSort = b.sort_order ?? Number.POSITIVE_INFINITY;
    if (aSort !== bSort) return aSort - bSort;
    return b.created_at.localeCompare(a.created_at);
  });
}

async function load(): Promise<void> {
  publish({ topics: cached?.topics ?? [], loading: true, error: null });
  const { data, error } = await supabase.from("topics").select("*");
  if (error) {
    publish({ topics: [], loading: false, error: error.message });
    return;
  }
  publish({
    topics: sortTopics((data ?? []) as Topic[]),
    loading: false,
    error: null,
  });
}

export function useTopics(): State {
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

export async function refetchTopics(): Promise<void> {
  await load();
}
