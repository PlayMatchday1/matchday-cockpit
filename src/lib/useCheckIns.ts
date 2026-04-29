"use client";

import { useEffect, useState } from "react";
import { fetchCheckIns, type CheckInsData } from "./checkIns";

type State = {
  data: CheckInsData | null;
  loading: boolean; // true on first fetch, false thereafter
  syncing: boolean; // true during any refresh
  lastSyncedAt: Date | null;
  error: string | null;
  autoRefresh: boolean;
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — per spec

const INITIAL: State = {
  data: null,
  loading: true,
  syncing: false,
  lastSyncedAt: null,
  error: null,
  autoRefresh: true,
};

let cached: State = INITIAL;
let pending: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let visibilityListenerAttached = false;
const subscribers = new Set<(s: State) => void>();

function publish(next: State) {
  cached = next;
  subscribers.forEach((fn) => fn(next));
}

async function load(): Promise<void> {
  publish({ ...cached, syncing: true, error: null });
  try {
    const data = await fetchCheckIns();
    publish({
      ...cached,
      data,
      loading: false,
      syncing: false,
      lastSyncedAt: new Date(),
      error: null,
    });
  } catch (e) {
    publish({
      ...cached,
      loading: false,
      syncing: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (cached.autoRefresh && !document.hidden) load();
  }, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function attachVisibilityListener() {
  if (visibilityListenerAttached || typeof document === "undefined") return;
  visibilityListenerAttached = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopAutoRefresh();
    } else if (cached.autoRefresh) {
      load();
      startAutoRefresh();
    }
  });
}

export function useCheckIns(): State & {
  refresh: () => Promise<void>;
  setAutoRefresh: (on: boolean) => void;
} {
  const [s, setS] = useState<State>(cached);

  useEffect(() => {
    subscribers.add(setS);
    if (cached.data) {
      setS(cached);
    } else if (!pending) {
      pending = load().finally(() => {
        pending = null;
      });
    }
    if (cached.autoRefresh) startAutoRefresh();
    attachVisibilityListener();
    return () => {
      subscribers.delete(setS);
      // Keep timer alive across mounts — singleton store. Stops only
      // when autoRefresh is toggled off.
    };
  }, []);

  return {
    ...s,
    refresh: () => load(),
    setAutoRefresh: (on: boolean) => {
      publish({ ...cached, autoRefresh: on });
      if (on) {
        startAutoRefresh();
        load();
      } else {
        stopAutoRefresh();
      }
    },
  };
}
