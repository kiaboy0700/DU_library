"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readCache, writeCache } from "./cache";
import { rpc, supabase } from "./supabase";
import type { HomeSummary } from "./types";

export type Settings = Record<string, number | boolean>;

let settingsCache: Settings | null = null;
let settingsAt = 0;
let homeCache: HomeSummary | null = null;

/** 규칙 설정값 (공개 읽기). 한 번 읽어 캐시 */
export function useSettings() {
  const [s, setS] = useState<Settings | null>(settingsCache);
  const load = useCallback(async () => {
    const { data } = await supabase.from("settings").select("key,value");
    if (data) {
      settingsCache = Object.fromEntries(data.map((r) => [r.key, r.value])) as Settings;
      settingsAt = Date.now();
      setS(settingsCache);
      writeCache("settings", settingsCache);
    }
  }, []);
  useEffect(() => {
    // 처음 열 때는 지난번 값으로 먼저 그리고, 5분이 넘었으면 뒤에서 새로 받는다
    if (!settingsCache) {
      const cached = readCache<Settings>("settings", 24 * 3600_000);
      if (cached) {
        settingsCache = cached;
        setS(cached);
      }
    }
    if (Date.now() - settingsAt > 5 * 60_000) load();
  }, [load]);
  return { settings: s, reload: load };
}

export const ruleTexts = (s: Settings | null, kind: "away" | "report") =>
  s ? [`${s[`${kind}_low`]}분`, `${s[`${kind}_mid`]}분`, `${s[`${kind}_high`]}분`] : ["–", "–", "–"];

/** 열람실 요약. 좌석 상태가 바뀌면 다시 불러온다 */
export function useHome() {
  const [home, setHome] = useState<HomeSummary | null>(homeCache);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      homeCache = await rpc<HomeSummary>("home_summary");
      setHome(homeCache);
      writeCache("home", homeCache);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    // 새로 연 직후에는 조금 전 값(2분 이내)을 먼저 보여 준다. 실제 값은 바로 뒤따라온다
    if (!homeCache) {
      const cached = readCache<HomeSummary>("home", 2 * 60_000);
      if (cached) {
        homeCache = cached;
        setHome(cached);
      }
    }
    load();
    const soon = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 400);
    };
    const ch = supabase
      .channel("home-seats")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "seat_state" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, soon)
      .subscribe();
    const poll = setInterval(load, 30000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  return { home, error, reload: load };
}
