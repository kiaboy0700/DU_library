"use client";

import { WifiOff } from "lucide-react";
import { RoomCard, useRoomActions } from "@/components/RoomCards";
import { Button, Notice, Skeleton } from "@/components/ui";
import { hoursLabel, useHome, useSettings } from "@/lib/hooks";

/** 열람실: 두 열람실의 요약을 한 화면에 모두 보여 주고, 여기서 좌석을 고르거나 바로 예약한다 */
export default function RoomsPage() {
  const { home, error, reload } = useHome();
  const { settings } = useSettings();
  const actions = useRoomActions(settings);
  const free = home?.rooms.reduce((n, r) => n + (r.total - r.occupied), 0);
  const total = home?.rooms.reduce((n, r) => n + r.total, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h1 className="text-[22px] font-bold">열람실</h1>
        {home && (
          <p className="tabular text-sm text-muted">
            {hoursLabel(home, settings) && `${hoursLabel(home, settings)} · `}
            전체 <strong className="font-semibold text-du-black">{free}석</strong> 남음 / {total}석
          </p>
        )}
      </div>

      {error && !home && (
        <Notice tone="danger" icon={<WifiOff size={18} aria-hidden />}>
          좌석 현황을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.
          <Button size="sm" className="mt-2" onClick={reload}>
            다시 불러오기
          </Button>
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {!home && !error && [0, 1].map((i) => <Skeleton key={i} className="h-[236px] !rounded-[var(--radius-panel)]" />)}
        {home?.rooms.map((room) => (
          <RoomCard key={room.id} room={room} actions={actions} />
        ))}
      </div>
    </div>
  );
}
