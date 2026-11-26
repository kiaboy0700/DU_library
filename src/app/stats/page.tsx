"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel, Skeleton } from "@/components/ui";
import { useHome } from "@/lib/hooks";
import { rpc } from "@/lib/supabase";
import { cx, level } from "@/lib/util";

interface Cell {
  dow: number;
  hour: number;
  pct: number;
}
const DOW = ["월", "화", "수", "목", "금", "토", "일"];
const HOURS = Array.from({ length: 16 }, (_, i) => i + 7); // 7시~22시

function kstNow() {
  const k = new Date(Date.now() + 9 * 3600_000);
  return { dow: k.getUTCDay() === 0 ? 7 : k.getUTCDay(), hour: k.getUTCHours() };
}

/** 혼잡도: 요일을 고르면 그날의 시간대별 평균을 막대로 보여 준다. 오늘은 지금 시각의 실제 이용률을 함께 쓴다 */
export default function StatsPage() {
  const { home } = useHome();
  const [roomId, setRoomId] = useState<number | null>(null);
  const [cells, setCells] = useState<Cell[] | null>(null);
  const cur = kstNow();
  const [dow, setDow] = useState(cur.dow);
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    if (home && roomId === null) setRoomId(home.rooms[0]?.id ?? null);
  }, [home, roomId]);
  useEffect(() => {
    if (roomId === null) return;
    setCells(null);
    rpc<Cell[]>("occupancy_heatmap", { p_room: roomId }).then(setCells).catch(() => setCells([]));
  }, [roomId]);

  const at = useMemo(() => {
    const m = new Map<string, number>();
    cells?.forEach((c) => m.set(`${c.dow}-${c.hour}`, c.pct));
    return (d: number, h: number) => m.get(`${d}-${h}`);
  }, [cells]);

  const room = home?.rooms.find((r) => r.id === roomId);
  const isToday = dow === cur.dow;
  // 오늘의 '지금' 칸은 평균이 아니라 실제 이용률
  const bars = HOURS.map((h) => ({ h, pct: isToday && h === cur.hour && room ? room.pct : (at(dow, h) ?? 0), now: isToday && h === cur.hour }));
  const sorted = [...bars].sort((a, b) => a.pct - b.pct);
  const quiet = sorted[0];
  const busy = sorted[sorted.length - 1];
  // 기본으로 보여 주는 칸: 오늘이면 지금, 다른 요일이면 가장 붐비는 시간
  const shown = (picked !== null ? bars.find((b) => b.h === picked) : bars.find((b) => b.now)) ?? busy;
  const empty = cells !== null && cells.length === 0;

  return (
    <div className="space-y-4">
      <h1 className="text-[22px] font-bold">혼잡도</h1>

      <div role="tablist" aria-label="열람실" className="flex gap-1.5">
        {home?.rooms.map((r) => (
          <button
            key={r.id}
            role="tab"
            type="button"
            aria-selected={roomId === r.id}
            onClick={() => setRoomId(r.id)}
            className={cx(
              "min-h-10 rounded-full border px-4 text-sm font-semibold transition-colors duration-150",
              roomId === r.id ? "border-du-deep bg-du-deep text-white" : "border-line bg-surface hover:bg-canvas",
            )}
          >
            {r.name}
          </button>
        )) ?? <Skeleton className="h-10 w-48 !rounded-full" />}
      </div>

      <Panel className="p-4 sm:p-5">
        {/* 요일 */}
        <div role="tablist" aria-label="요일" className="grid grid-cols-7 gap-1">
          {DOW.map((d, i) => {
            const on = dow === i + 1;
            return (
              <button
                key={d}
                role="tab"
                type="button"
                aria-selected={on}
                onClick={() => {
                  setDow(i + 1);
                  setPicked(null);
                }}
                className={cx(
                  "relative flex min-h-10 items-center justify-center rounded-[var(--radius-ctl)] text-sm font-semibold transition-colors duration-150",
                  on ? "bg-du-deep text-white" : "bg-canvas hover:bg-[#e3ebe8]",
                )}
              >
                {d}
                {i + 1 === cur.dow && <span className={cx("absolute bottom-1 size-1 rounded-full", on ? "bg-white" : "bg-du-deep")} aria-label="오늘" />}
              </button>
            );
          })}
        </div>

        {cells === null ? (
          <Skeleton className="mt-4 h-56" />
        ) : empty ? (
          <p className="mt-4 text-sm text-muted">기록이 부족합니다</p>
        ) : (
          <>
            {/* 고른 시간대의 값 (기본은 지금) */}
            <div className="mt-4 flex items-end justify-between gap-3">
              <p aria-live="polite">
                <span className="block text-[13px] text-muted">{shown.now ? "지금" : `${DOW[dow - 1]}요일 ${shown.h}시 평균`}</span>
                <span className="flex items-baseline gap-2">
                  <span className="tabular text-[34px] font-bold leading-none tracking-tight">{shown.pct}%</span>
                  <span className="text-sm font-semibold" style={{ color: level(shown.pct).color }}>
                    {level(shown.pct).name}
                  </span>
                </span>
              </p>
              <dl className="tabular shrink-0 text-right text-[13px]">
                <div>
                  <dt className="inline text-muted">한산 </dt>
                  <dd className="inline font-semibold">
                    {quiet.h}시 {quiet.pct}%
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted">붐빔 </dt>
                  <dd className="inline font-semibold">
                    {busy.h}시 {busy.pct}%
                  </dd>
                </div>
              </dl>
            </div>

            {/* 시간대별 막대: 색은 여유·보통·혼잡 */}
            <div className="relative mt-4">
              {/* 50%·80% 기준선 */}
              <span aria-hidden className="absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `calc(20px + ${0.8 * 144}px)` }} />
              <span aria-hidden className="absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `calc(20px + ${0.5 * 144}px)` }} />
              <ol className="relative flex items-end gap-[3px] sm:gap-1.5" aria-label={`${DOW[dow - 1]}요일 시간대별 이용률`}>
                {bars.map((b) => {
                  const on = shown.h === b.h;
                  return (
                    <li key={b.h} className="min-w-0 flex-1">
                      <button
                        type="button"
                        aria-label={`${b.h}시 ${b.pct}퍼센트${b.now ? ", 지금" : ""}`}
                        aria-pressed={on}
                        onClick={() => setPicked(b.h)}
                        className="flex w-full flex-col items-center justify-end"
                      >
                        <span className="flex h-36 w-full items-end">
                          <span
                            className={cx("w-full rounded-t-[4px] transition-[height,opacity] duration-200", !on && "opacity-55")}
                            style={{ height: `${Math.max(3, b.pct)}%`, background: level(b.pct).color }}
                          />
                        </span>
                        <span className={cx("tabular flex h-5 items-center text-[11px]", b.now ? "font-bold text-du-black" : on ? "font-semibold text-du-black" : "text-muted")}>{b.h}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>

            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="색 범례">
              {[20, 60, 90].map((v) => (
                <li key={v} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ background: level(v).color }} aria-hidden />
                  {level(v).name}
                </li>
              ))}
              <li className="ml-auto">최근 5주 평균</li>
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}
