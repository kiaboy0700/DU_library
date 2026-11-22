"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, ChevronRight, Zap } from "lucide-react";
import { OccupancyMeter } from "./OccupancyMeter";
import { useApp } from "./Providers";
import { Button, Panel, Tag, useAction } from "./ui";
import { ruleTexts, type Settings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import type { RoomSummary } from "@/lib/types";
import { cx, errMsg, fmtTime, level } from "@/lib/util";

/** 열람실 카드에서 쓰는 동작: 빈자리 알림 켜고 끄기, 빈자리 바로 예약 */
export function useRoomActions(settings: Settings | null) {
  const { status, toast, refresh } = useApp();
  const router = useRouter();
  const { busy, run } = useAction((m) => toast(m, "error"));
  const [watching, setWatching] = useState<Set<number>>(new Set());
  const uid = status?.profile.id;

  const loadWatch = useCallback(async () => {
    if (!uid) return setWatching(new Set());
    const { data } = await supabase.from("watch_requests").select("room_id").eq("user_id", uid);
    setWatching(new Set((data ?? []).map((w) => w.room_id)));
  }, [uid]);
  useEffect(() => {
    loadWatch();
  }, [loadWatch]);

  async function toggleWatch(room: RoomSummary) {
    if (!uid) return;
    try {
      if (watching.has(room.id)) {
        const { error } = await supabase.from("watch_requests").delete().eq("user_id", uid).eq("room_id", room.id);
        if (error) throw error;
        toast(`${room.name} 빈자리 알림을 껐습니다.`);
      } else {
        const { error } = await supabase.from("watch_requests").insert({ user_id: uid, room_id: room.id });
        if (error) throw error;
        toast(`${room.name}에 자리가 나면 알려 드릴게요.`, "ok");
      }
      loadWatch();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  // 빠른 예약: 좌석을 고르지 않고 빈자리 하나를 바로 배정
  const quick = (room: RoomSummary) =>
    run(`q${room.id}`, async () => {
      const r = await rpc<{ seat_label: string }>("quick_reserve", { p_room: room.id });
      await refresh();
      toast(`${room.name} ${r.seat_label} 좌석을 예약했습니다. ${settings?.checkin_minutes ?? 15}분 안에 좌석 QR을 스캔하세요.`, "ok");
      router.push("/me");
    });

  return { watching, toggleWatch, quick, busy, hasSeat: !!status?.reservation };
}

/** 열람실 한 곳의 요약: 남은 좌석, 혼잡도 눈금, 좌석 고르기·바로 예약·빈자리 알림 */
export function RoomCard({
  room,
  settings,
  actions,
  className,
}: {
  room: RoomSummary;
  settings: Settings | null;
  actions: ReturnType<typeof useRoomActions>;
  className?: string;
}) {
  const lv = level(room.pct);
  const free = room.total - room.occupied;
  const on = actions.watching.has(room.id);
  return (
    <Panel className={cx("flex flex-col p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{room.name}</h2>
          {room.is_open && room.closes_at && <p className="tabular text-[13px] text-muted">{fmtTime(room.closes_at)} 폐관</p>}
          {!room.is_open && <p className="text-[13px] text-muted">{room.reason}</p>}
        </div>
        {room.is_open ? <Tag tone={room.pct >= 80 ? "danger" : room.pct >= 50 ? "warn" : "deep"}>{lv.name}</Tag> : <Tag>운영 종료</Tag>}
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <p className="tabular text-[40px] font-bold leading-none tracking-tight">{free}</p>
        <p className="text-sm text-muted">
          석 남음 <span className="tabular">/ 전체 {room.total}석</span>
        </p>
        <p className="tabular ml-auto whitespace-nowrap text-sm font-semibold" style={{ color: lv.color }}>
          이용률 {room.pct}%
        </p>
      </div>

      <div className="mt-3">
        <OccupancyMeter pct={room.pct} rules={ruleTexts(settings, "away")} />
      </div>

      <div className="mt-4 flex gap-2">
        <Link
          href={`/rooms/${room.id}`}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--radius-ctl)] bg-du-deep px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-du-deep-dark"
        >
          좌석 고르기
          <ChevronRight size={16} aria-hidden />
        </Link>
        {free > 0 && room.is_open && !actions.hasSeat ? (
          <Button busy={actions.busy === `q${room.id}`} onClick={() => actions.quick(room)} title="옆자리가 비어 있는 좌석을 골라 바로 예약합니다">
            <Zap size={16} aria-hidden />
            바로 예약
          </Button>
        ) : null}
        <Button
          onClick={() => actions.toggleWatch(room)}
          aria-pressed={on}
          aria-label={on ? `${room.name} 빈자리 알림 끄기` : `${room.name} 빈자리 알림 받기`}
          title={on ? "빈자리 알림 켜짐" : "자리가 나면 알림 받기"}
          className={cx("w-11 shrink-0 !px-0", on && "border-du-deep/40 bg-du-tint text-du-deep-dark")}
        >
          {on ? <BellRing size={18} aria-hidden /> : <Bell size={18} aria-hidden />}
        </Button>
      </div>
    </Panel>
  );
}
