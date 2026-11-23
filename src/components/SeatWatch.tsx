"use client";

import { useEffect, useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { useApp } from "./Providers";
import { Button } from "./ui";
import { rpc, supabase } from "@/lib/supabase";
import { errMsg } from "@/lib/util";

/** 누가 쓰고 있는 좌석의 알림: 비면, 그리고 이용 종료 5분 전에 알려 준다 */
export function SeatWatchButton({ seatId, label, className }: { seatId: number; label: string; className?: string }) {
  const { status, toast } = useApp();
  const uid = status?.profile.id;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!uid) return;
    let alive = true;
    supabase
      .from("seat_watches")
      .select("seat_id")
      .eq("user_id", uid)
      .eq("seat_id", seatId)
      .maybeSingle()
      .then(({ data }) => alive && setOn(!!data));
    return () => {
      alive = false;
    };
  }, [uid, seatId]);

  if (!uid || status?.profile.role === "admin") return null;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const now = await rpc<boolean>("toggle_seat_watch", { p_seat: seatId });
      setOn(now);
      toast(now ? `${label} 좌석이 비면, 그리고 종료 5분 전에 알려 드립니다.` : `${label} 좌석 알림을 껐습니다.`, now ? "ok" : undefined);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant={on ? "soft" : "secondary"} className={className} busy={busy} aria-pressed={on} onClick={toggle}>
      {on ? <BellRing size={16} aria-hidden /> : <Bell size={16} aria-hidden />}
      {on ? "빈자리 알림 켜짐" : "이 좌석 빈자리 알림"}
    </Button>
  );
}
