"use client";

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/Providers";
import { Button, Field, Panel, Skeleton, Tag, inputClass, useAction } from "@/components/ui";
import { useAdminMap, useRooms } from "@/lib/admin";
import { rpc, supabase } from "@/lib/supabase";
import { SEAT_TYPE_LABEL } from "@/lib/types";
import { cx } from "@/lib/util";

export default function AdminSeats() {
  const { toast } = useApp();
  const { rooms, reload: reloadRooms } = useRooms();
  const [roomId, setRoomId] = useState<number | null>(null);
  const { seats, reload } = useAdminMap(roomId);
  const [reason, setReason] = useState("");
  const { busy, run } = useAction((m) => toast(m, "error"));

  useEffect(() => {
    if (rooms?.length && roomId === null) setRoomId(rooms[0].id);
  }, [rooms, roomId]);

  const room = rooms?.find((r) => r.id === roomId);
  const zones = useMemo(() => {
    const m = new Map<string, { total: number; off: number; used: number; type: string; ids: number[] }>();
    seats?.forEach((s) => {
      const z = m.get(s.zone) ?? { total: 0, off: 0, used: 0, type: SEAT_TYPE_LABEL[s.seat_type], ids: [] };
      z.total += 1;
      if (!s.is_active) z.off += 1;
      if (s.res) z.used += 1;
      z.ids.push(s.seat_id);
      m.set(s.zone, z);
    });
    return [...m.entries()];
  }, [seats]);
  const off = seats?.filter((s) => !s.is_active) ?? [];

  const act = (key: string, fn: () => Promise<unknown>, msg: string) =>
    run(key, async () => {
      await fn();
      toast(msg, "ok");
      setReason("");
      await Promise.all([reload(), reloadRooms()]);
    });

  return (
    <div className="space-y-4">
      <h1 className="text-[22px] font-bold">좌석·열람실</h1>
      <div role="tablist" aria-label="열람실" className="flex gap-1.5">
        {rooms?.map((r) => (
          <button
            key={r.id}
            role="tab"
            type="button"
            aria-selected={roomId === r.id}
            onClick={() => setRoomId(r.id)}
            className={cx("min-h-10 rounded-full border px-4 text-sm font-semibold", roomId === r.id ? "border-du-deep bg-du-deep text-white" : "border-line bg-surface hover:bg-canvas")}
          >
            {r.name}
          </button>
        ))}
      </div>

      {!room || !seats ? (
        <Skeleton className="h-80 !rounded-[var(--radius-panel)]" />
      ) : (
        <>
          <Panel className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold">{room.name} 운영</h2>
              <Tag tone={room.is_closed ? "danger" : "deep"}>{room.is_closed ? "임시 폐쇄 중" : "운영 중"}</Tag>
            </div>
            {room.is_closed && <p className="mt-1 text-sm text-muted">폐쇄 사유: {room.closed_reason ?? "-"}</p>}
            <div className="mt-4 max-w-md">
              <Field label="사유 (학생에게 전달됩니다)">
                <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 냉난방 점검, 청소, 행사" />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant={room.is_closed ? "primary" : "danger"}
                busy={busy === "close"}
                onClick={() => {
                  if (!room.is_closed && !window.confirm(`${room.name}을 임시 폐쇄할까요? 이용 중인 학생은 모두 벌점 없이 반납되고 알림을 받습니다.`)) return;
                  act("close", () => rpc("admin_close_room", { p_room: room.id, p_closed: !room.is_closed, p_reason: reason || "시설 점검" }), room.is_closed ? "열람실을 다시 열었습니다." : "열람실을 임시 폐쇄했습니다.");
                }}
              >
                {room.is_closed ? "열람실 다시 열기" : "열람실 임시 폐쇄"}
              </Button>
              <label className="ml-1 flex min-h-11 items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="size-[18px]"
                  checked={room.open_24h_in_exam}
                  onChange={(e) =>
                    act(
                      "24h",
                      async () => {
                        const { error } = await supabase.from("rooms").update({ open_24h_in_exam: e.target.checked }).eq("id", room.id);
                        if (error) throw new Error(error.message);
                      },
                      "시험기간 24시간 운영 설정을 바꿨습니다.",
                    )
                  }
                />
                시험기간에 24시간 운영
              </label>
            </div>
          </Panel>

          <Panel>
            <h2 className="px-4 pt-4 text-lg font-bold sm:px-5">구역</h2>
            <div className="mt-3 overflow-x-auto border-t border-line">
              <table className="tabular w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium sm:px-5">구역</th>
                    <th className="px-2 py-2 font-medium">종류</th>
                    <th className="px-2 py-2 text-right font-medium">좌석</th>
                    <th className="px-2 py-2 text-right font-medium">이용 중</th>
                    <th className="px-2 py-2 text-right font-medium">중지</th>
                    <th className="px-4 py-2 sm:px-5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {zones.map(([z, v]) => (
                    <tr key={z}>
                      <th scope="row" className="px-4 py-2.5 font-bold sm:px-5">
                        {z}구역
                      </th>
                      <td className="px-2">{v.type}</td>
                      <td className="px-2 text-right">{v.total}</td>
                      <td className="px-2 text-right">{v.used}</td>
                      <td className="px-2 text-right">{v.off}</td>
                      <td className="px-4 py-1.5 text-right sm:px-5">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={v.off === v.total}
                            busy={busy === `off${z}`}
                            onClick={() => {
                              if (v.used > 0 && !window.confirm(`${z}구역에 이용 중인 학생 ${v.used}명이 있습니다. 차단하면 모두 벌점 없이 반납됩니다. 계속할까요?`)) return;
                              act(`off${z}`, () => rpc("admin_set_seats", { p_ids: v.ids, p_active: false, p_reason: reason || "구역 점검" }), `${z}구역을 차단했습니다.`);
                            }}
                          >
                            구역 차단
                          </Button>
                          <Button size="sm" disabled={v.off === 0} busy={busy === `on${z}`} onClick={() => act(`on${z}`, () => rpc("admin_set_seats", { p_ids: v.ids, p_active: true, p_reason: null }), `${z}구역을 다시 열었습니다.`)}>
                            다시 열기
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <h2 className="px-4 pt-4 text-lg font-bold sm:px-5">
              사용 중지된 좌석 <span className="tabular text-muted">{off.length}</span>
            </h2>
            {off.length === 0 ? (
              <p className="px-4 pb-4 pt-1 text-sm text-muted sm:px-5">없음</p>
            ) : (
              <ul className="mt-2 divide-y divide-line border-t border-line">
                {off.map((s) => (
                  <li key={s.seat_id} className="flex items-center justify-between gap-3 px-4 py-2 sm:px-5">
                    <p className="min-w-0 text-sm">
                      <strong className="font-bold">{s.label}</strong> <span className="text-muted">· {s.inactive_reason ?? "사유 없음"}</span>
                    </p>
                    <Button size="sm" busy={busy === `s${s.seat_id}`} onClick={() => act(`s${s.seat_id}`, () => rpc("admin_set_seats", { p_ids: [s.seat_id], p_active: true, p_reason: null }), `${s.label} 좌석을 다시 열었습니다.`)}>
                      다시 열기
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
