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

// 단일 색상(DU Deep Green) 5단계 + 값은 칸 안의 숫자로도 표시
const shade = (pct: number) => (pct >= 80 ? "#00594c" : pct >= 60 ? "#00826f" : pct >= 40 ? "#57ab9d" : pct >= 20 ? "#a8d5cc" : "#e3f1ee");
const ink = (pct: number) => (pct >= 40 ? "#ffffff" : "#1f4a43");

function kstNow() {
  const k = new Date(Date.now() + 9 * 3600_000);
  return { dow: k.getUTCDay() === 0 ? 7 : k.getUTCDay(), hour: k.getUTCHours() };
}

export default function StatsPage() {
  const { home } = useHome();
  const [roomId, setRoomId] = useState<number | null>(null);
  const [cells, setCells] = useState<Cell[] | null>(null);
  const cur = kstNow();

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
  const today = HOURS.map((h) => ({ h, pct: at(cur.dow, h) ?? 0 }));
  // '지금'은 평균이 아니라 실제 이용률을 쓴다 (위의 문장과 숫자가 어긋나지 않게)
  const upcoming = today.filter((t) => t.h >= cur.hour).slice(0, 6).map((t) => (t.h === cur.hour && room ? { ...t, pct: room.pct } : t));
  const peak = Math.max(40, ...upcoming.map((t) => t.pct));
  const quiet = today.filter((t) => t.h >= cur.hour && t.h >= 9).sort((a, b) => a.pct - b.pct)[0];

  return (
    <div className="space-y-5">
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

      <Panel className="p-4">
        <h2 className="font-bold">오늘 예상</h2>
        {cells === null ? (
          <Skeleton className="mt-3 h-28" />
        ) : upcoming.length === 0 ? (
          <p className="mt-2 text-sm text-muted">오늘 운영이 끝났습니다.</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-[#3d4744]">
              지금 <strong className="tabular">{room?.pct ?? "-"}%</strong>
              {quiet && (
                <>
                  {" · "}
                  가장 한산한 시간 <strong className="tabular">{quiet.h}시</strong> <span className="tabular text-muted">({quiet.pct}%)</span>
                </>
              )}
            </p>
            <ol className="mt-4 flex h-28 items-end gap-2" aria-label="시간대별 예상 이용률">
              {upcoming.map((t) => {
                const lv = level(t.pct);
                return (
                  <li key={t.h} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                    <span className="tabular text-xs font-semibold" style={{ color: lv.color }}>
                      {t.pct}%
                    </span>
                    <span className="w-full max-w-12 rounded-t-md" style={{ height: `${Math.max(4, (t.pct / peak) * 66)}%`, background: lv.color }} />
                    <span className={cx("tabular text-xs", t.h === cur.hour ? "font-bold" : "text-muted")}>{t.h === cur.hour ? "지금" : `${t.h}시`}</span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </Panel>

      <Panel className="p-4">
        <h2 className="font-bold">요일·시간대별 평균 (최근 5주)</h2>
        {cells === null ? (
          <Skeleton className="mt-3 h-64" />
        ) : cells.length === 0 ? (
          <p className="mt-2 text-sm text-muted">기록이 부족합니다</p>
        ) : (
          <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="요일·시간대별 평균 이용률 표, 스크롤 가능">
            <table className="tabular w-full min-w-[620px] border-separate border-spacing-[3px] text-center text-[11px]">
              <thead>
                <tr>
                  <th scope="col" className="w-8">
                    <span className="sr-only">요일</span>
                  </th>
                  {HOURS.map((h) => (
                    <th key={h} scope="col" className={cx("pb-1 font-medium text-muted", h === cur.hour && "font-bold text-du-black")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DOW.map((d, i) => (
                  <tr key={d}>
                    <th scope="row" className={cx("pr-1 text-xs font-medium text-muted", i + 1 === cur.dow && "font-bold text-du-black")}>
                      {d}
                    </th>
                    {HOURS.map((h) => {
                      const v = at(i + 1, h) ?? 0;
                      const nowCell = i + 1 === cur.dow && h === cur.hour;
                      return (
                        <td key={h} className={cx("h-8 rounded-[5px] font-semibold", nowCell && "outline-2 outline-offset-1 outline-du-black")} style={{ background: shade(v), color: ink(v) }}>
                          {v}
                          <span className="sr-only">퍼센트{nowCell && ", 현재 시간대"}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
          <span className="flex items-center gap-2 whitespace-nowrap">
            한산
            <span className="flex overflow-hidden rounded">
              {[10, 30, 50, 70, 90].map((v) => (
                <span key={v} className="h-3 w-7" style={{ background: shade(v) }} />
              ))}
            </span>
            혼잡
          </span>
          <span className="whitespace-nowrap">테두리 칸이 지금</span>
        </div>
      </Panel>
    </div>
  );
}
