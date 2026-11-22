"use client";

import { useCallback, useEffect, useState } from "react";
import { rpc, supabase } from "./supabase";
import type { Room, SeatType } from "./types";

export interface AdminSeat {
  seat_id: number;
  label: string;
  zone: string;
  seat_type: SeatType;
  x: number;
  y: number;
  is_active: boolean;
  inactive_reason: string | null;
  qr_token: string;
  res: {
    id: number;
    status: "reserved" | "in_use" | "away";
    start_at: string;
    end_at: string;
    checkin_deadline: string;
    away_deadline: string | null;
    extend_count: number;
    on_hold: boolean;
    by_admin: boolean;
    user_id: string;
    student_id: string;
    name: string;
    department: string | null;
    grade: number | null;
    points: number;
    report: boolean;
  } | null;
}

export function useRooms() {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from("rooms").select("*").order("floor");
    setRooms((data as Room[]) ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { rooms, reload: load };
}

/** 관리자 좌석맵 데이터. 예약이 바뀌면 다시 불러온다 */
export function useAdminMap(roomId: number | null) {
  const [seats, setSeats] = useState<AdminSeat[] | null>(null);
  const load = useCallback(async () => {
    if (roomId === null) return;
    try {
      setSeats(await rpc<AdminSeat[]>("admin_room_map", { p_room: roomId }));
    } catch {
      setSeats([]);
    }
  }, [roomId]);
  useEffect(() => {
    setSeats(null);
    load();
    if (roomId === null) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 300);
    };
    const ch = supabase
      .channel(`admin-map-${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "seat_state", filter: `room_id=eq.${roomId}` }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "seat_reports" }, soon)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
      if (t) clearTimeout(t);
    };
  }, [roomId, load]);
  return { seats, reload: load };
}
