"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, MousePointerClick, PenLine } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { useApp } from "@/components/Providers";
import { LEGEND, LegendSwatch, SeatMap, type SeatVisual } from "@/components/SeatMap";
import { Button, Empty, Field, GraceControl, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
import { useAdminMap, useRooms, type AdminSeat } from "@/lib/admin";
import { useHome } from "@/lib/hooks";
import { rpc } from "@/lib/supabase";
import { SEAT_TYPE_LABEL, STATE_LABEL, type Seat } from "@/lib/types";
import { cx, fmtRemain, fmtTime } from "@/lib/util";

interface Overview {
  today: { reservations: number; no_shows: number; auto_returns: number; reports: number; active: number };
  reports: unknown[];
  helps: unknown[];
  appeals: unknown[];
}

export default function AdminHome() {
  const { toast, pulse } = useApp();
  const { rooms } = useRooms();
  const { home, reload: reloadHome } = useHome();
  const now = useNow();
  const [roomId, setRoomId] = useState<number | null>(null);
  const { seats, reload } = useAdminMap(roomId);
  const [ov, setOv] = useState<Overview | null>(null);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [sid, setSid] = useState("");
  const [reason, setReason] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [points, setPoints] = useState(0);
  const { busy, run } = useAction((m) => toast(m, "error"));

  const loadOv = useCallback(() => rpc<Overview>("admin_overview").then(setOv).catch(() => {}), []);
  useEffect(() => {
    loadOv();
    const t = setInterval(loadOv, 20000);
    return () => clearInterval(t);
  }, [loadOv, pulse]);
  useEffect(() => {
    if (rooms?.length && roomId === null) setRoomId(rooms[0].id);
  }, [rooms, roomId]);
  // 처리 대기에서 '좌석 위치'를 누르고 왔으면 그 열람실의 그 좌석을 연다
  const [want, setWant] = useState<{ room: number; seat: number } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const room = Number(q.get("room"));
    const seat = Number(q.get("seat"));
    if (room && seat) {
      setWant({ room, seat });
      setRoomId(room);
    }
  }, []);
  const prevRoom = useRef(roomId);
  useEffect(() => {
    if (want && roomId === want.room && seats?.some((x) => x.seat_id === want.seat)) {
      prevRoom.current = roomId;
      setPickedId(want.seat);
      setWant(null);
    } else if (prevRoom.current !== roomId) {
      // 열람실을 바꾸면 고른 좌석을 푼다
      prevRoom.current = roomId;
      if (!want) setPickedId(null);
    }
  }, [roomId, seats, want]);

  const room = rooms?.find((r) => r.id === roomId);
  const summary = home?.rooms.find((r) => r.id === roomId);
  const byId = useMemo(() => new Map(seats?.map((s) => [s.seat_id, s]) ?? []), [seats]);
  const picked = pickedId ? byId.get(pickedId) : undefined;
  const mapSeats: Seat[] = useMemo(
    () => (seats ?? []).map((s) => ({ id: s.seat_id, room_id: roomId ?? 0, zone: s.zone, label: s.label, seat_type: s.seat_type, x: s.x, y: s.y, is_active: s.is_active, inactive_reason: s.inactive_reason })),
    [seats, roomId],
  );
  const queue = ov ? ov.reports.length + ov.helps.length + ov.appeals.length : 0;

  const done = async (msg: string) => {
    toast(msg, "ok");
    setReason("");
    setMoveTo("");
    setPoints(0);
    await Promise.all([reload(), loadOv(), reloadHome()]);
  };
  const resAct = (key: string, action: string, msg: string, arg: number | null = null) =>
    run(key, async () => {
      await rpc("admin_res_action", { p_res: picked!.res!.id, p_action: action, p_reason: reason || null, p_arg: arg });
      await done(msg);
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[22px] font-bold">열람실 관제</h1>
        <Link href="/notices?write" className="ml-auto inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-ctl)] border border-line bg-surface px-4 text-sm font-semibold transition-colors duration-150 hover:bg-canvas">
          <PenLine size={16} aria-hidden />
          공지 쓰기
        </Link>
        <Link
          href="/admin/reports"
          className={cx(
            "inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-ctl)] px-4 text-sm font-semibold transition-colors duration-150",
            queue > 0 ? "bg-danger text-white hover:bg-[#981f18]" : "border border-line bg-surface hover:bg-canvas",
          )}
        >
          처리 대기 <span className="tabular">{queue}건</span>
          <ChevronRight size={16} aria-hidden />
        </Link>
      </div>

      <dl className="grid grid-cols-2 divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface sm:grid-cols-5 sm:divide-x">
        {[
          ["지금 이용 중", ov?.today.active],
          ["오늘 예약", ov?.today.reservations],
          ["오늘 노쇼", ov?.today.no_shows],
          ["자동 회수", ov?.today.auto_returns],
          ["자리비움 신고", ov?.today.reports],
        ].map(([k, v]) => (
          <div key={k as string} className="px-4 py-3">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="tabular text-xl font-bold">{v ?? "–"}</dd>
          </div>
        ))}
      </dl>

      <div role="tablist" aria-label="열람실" className="flex gap-1.5">
        {rooms?.map((r) => {
          const s = home?.rooms.find((x) => x.id === r.id);
          return (
            <button
              key={r.id}
              role="tab"
              type="button"
              aria-selected={roomId === r.id}
              onClick={() => setRoomId(r.id)}
              className={cx("min-h-10 rounded-full border px-4 text-sm font-semibold", roomId === r.id ? "border-du-deep bg-du-deep text-white" : "border-line bg-surface hover:bg-canvas")}
            >
              {r.name}
              {s && <span className="tabular ml-1.5 font-normal opacity-85">{s.pct}%</span>}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel className="p-3 sm:p-4">
          {summary && (
            <div className="mb-4">
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <p className="tabular font-semibold">
                  {summary.occupied} / {summary.total}석 이용 중 · {summary.pct}%
                </p>
                <p className="text-muted">
                  {summary.is_open ? (summary.closes_at ? `${fmtTime(summary.closes_at)} 폐관` : "운영 중") : summary.reason}
                  {room?.is_closed && " (임시 폐쇄)"}
                </p>
              </div>
              <OccupancyMeter pct={summary.pct} />
            </div>
          )}
          <ul className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px]" aria-label="범례">
            {LEGEND.filter((l) => l.key !== "mine").map((l) => (
              <li key={l.key} className="flex items-center gap-1.5">
                <LegendSwatch kind={l.key} />
                {l.label}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-danger" aria-hidden /> 신고 접수
            </li>
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-warn" aria-hidden /> 도움 요청
            </li>
          </ul>
          {room && seats ? (
            <SeatMap
              title={room.name}
              width={room.layout_w}
              height={room.layout_h}
              decor={room.decor}
              seats={mapSeats}
              visual={(s): SeatVisual => {
                const a = byId.get(s.id);
                return !a?.is_active ? "inactive" : (a.res?.status ?? "free");
              }}
              badge={(s) => {
                const a = byId.get(s.id);
                return a?.res?.report ? "report" : a?.res?.on_hold ? "hold" : null;
              }}
              selectedId={pickedId}
              focusId={pickedId}
              onSelect={(s) => setPickedId(s.id)}
              selectable={() => true}
            />
          ) : (
            <Skeleton className="h-[440px]" />
          )}
        </Panel>

        <Panel className="lg:sticky lg:top-[72px]">
          {!picked ? (
            <Empty icon={<MousePointerClick size={32} strokeWidth={1.6} aria-hidden />} title="좌석을 선택하세요" />
          ) : (
            <SeatPanel
              key={picked.seat_id}
              seat={picked}
              now={now}
              busy={busy}
              sid={sid}
              setSid={setSid}
              reason={reason}
              setReason={setReason}
              moveTo={moveTo}
              setMoveTo={setMoveTo}
              points={points}
              setPoints={setPoints}
              onAssign={(checkin) =>
                run("assign", async () => {
                  await rpc("admin_reserve", { p_student_id: sid, p_seat: picked.seat_id, p_reason: reason || "현장 대리 배정", p_checkin: checkin });
                  setSid("");
                  await done(`${picked.label} 좌석을 배정했습니다.`);
                })
              }
              onToggle={() =>
                run("toggle", async () => {
                  await rpc("admin_set_seats", { p_ids: [picked.seat_id], p_active: !picked.is_active, p_reason: reason || "시설 점검" });
                  await done(picked.is_active ? `${picked.label} 좌석 사용을 중지했습니다.` : `${picked.label} 좌석을 다시 열었습니다.`);
                })
              }
              onAct={resAct}
              onMove={() =>
                run("move", async () => {
                  const target = seats?.find((s) => s.label.toLowerCase() === moveTo.trim().toLowerCase());
                  if (!target) throw new Error("옮길 좌석 번호를 찾을 수 없습니다. 예: B-012");
                  await rpc("admin_res_action", { p_res: picked.res!.id, p_action: "move", p_reason: reason || "좌석 이동", p_arg: target.seat_id });
                  setPickedId(target.seat_id);
                  await done(`${picked.label} → ${target.label} 로 옮겼습니다.`);
                })
              }
            />
          )}
        </Panel>
      </div>

    </div>
  );
}

function SeatPanel(p: {
  seat: AdminSeat;
  now: number;
  busy: string | null;
  sid: string;
  setSid: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  moveTo: string;
  setMoveTo: (v: string) => void;
  points: number;
  setPoints: (v: number) => void;
  onAssign: (checkin: boolean) => void;
  onToggle: () => void;
  onAct: (key: string, action: string, msg: string, arg?: number | null) => void;
  onMove: () => void;
}) {
  const { seat, now } = p;
  const r = seat.res;
  const target = r ? (r.status === "reserved" ? r.checkin_deadline : r.status === "away" && r.away_deadline ? r.away_deadline : r.end_at) : null;

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{seat.label}</h2>
          <p className="text-sm text-muted">{SEAT_TYPE_LABEL[seat.seat_type]}</p>
        </div>
        <Tag tone={!seat.is_active ? "neutral" : r ? (r.report ? "danger" : "neutral") : "deep"}>{!seat.is_active ? "사용 중지" : r ? STATE_LABEL[r.status] : "빈자리"}</Tag>
      </div>

      {r && (
        <>
          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 whitespace-nowrap text-muted">이용자</dt>
              <dd className="text-right font-semibold">
                {r.name} <span className="tabular font-normal text-muted">{r.student_id}</span>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 whitespace-nowrap text-muted">소속</dt>
              <dd className="min-w-0 text-right text-[13px] leading-snug">
                {r.department ?? "-"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 whitespace-nowrap text-muted">이용 시간</dt>
              <dd className="tabular text-right">
                {fmtTime(r.start_at)} ~ {fmtTime(r.end_at)} · 연장 {r.extend_count}회
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 whitespace-nowrap text-muted">{r.status === "reserved" ? "체크인 마감" : r.status === "away" ? "복귀 마감" : "남은 시간"}</dt>
              <dd className="tabular text-right font-semibold">{target ? fmtRemain(new Date(target).getTime() - now) : "-"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 whitespace-nowrap text-muted">벌점</dt>
              <dd className="tabular text-right">{r.points}점</dd>
            </div>
          </dl>
          {r.report && <p className="mt-2 rounded-md bg-danger-tint px-2.5 py-2 text-[13px] font-semibold text-[#7d1a14]">자리비움 신고 접수 · 응답 대기 중</p>}
          {r.on_hold && <p className="mt-2 rounded-md bg-warn-tint px-2.5 py-2 text-[13px] font-semibold text-[#5c3d00]">도움 요청 중 · 자동 취소·반납·벌점 멈춤</p>}

          <div className="mt-4 border-t border-line pt-3">
            <h3 className="text-xs font-bold text-muted">대신 처리</h3>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {r.status === "reserved" && (
              <Button variant="primary" className="col-span-2" busy={p.busy === "ci"} onClick={() => p.onAct("ci", "check_in", "체크인을 대신 처리했습니다.")}>
                대리 체크인
              </Button>
            )}
            {r.status === "away" && (
              <Button variant="primary" className="col-span-2" busy={p.busy === "cb"} onClick={() => p.onAct("cb", "come_back", "복귀를 대신 처리했습니다.")}>
                대리 복귀
              </Button>
            )}
            {r.status === "in_use" && (
              <Button busy={p.busy === "aw"} onClick={() => p.onAct("aw", "away", "외출 처리했습니다.")}>
                외출 처리
              </Button>
            )}
            <GraceControl className="col-span-2" label="이용 시간" initial={120} max={480} busy={p.busy === "ex"} onGive={(m) => p.onAct("ex", "extend", `이용 시간을 ${m}분 연장했습니다.`, m)} />
            {/* 마감이 걸려 있는 상황(체크인 대기·외출·자리 확인 요청)에서만 */}
            {(r.status !== "in_use" || r.report) && (
              <GraceControl
                className="col-span-2"
                label={r.status === "reserved" ? "체크인 대기" : r.status === "away" ? "외출 시간" : "자리 확인 시간"}
                left={r.status === "reserved" ? new Date(r.checkin_deadline).getTime() - now : r.status === "away" && r.away_deadline ? new Date(r.away_deadline).getTime() - now : undefined}
                busy={p.busy === "gr"}
                onGive={(m) => p.onAct("gr", "grace", `${m}분 연장했습니다.`, m)}
              />
            )}
          </div>

          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <h3 className="text-xs font-bold text-muted">좌석 옮기기</h3>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="옮길 좌석">
                  <input className={inputClass} value={p.moveTo} onChange={(e) => p.setMoveTo(e.target.value)} placeholder="옮길 좌석 번호 (예: B-012)" />
                </Field>
              </div>
              <Button busy={p.busy === "move"} disabled={!p.moveTo.trim()} onClick={p.onMove}>
                이동
              </Button>
            </div>
          </div>
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <h3 className="text-xs font-bold text-muted">반납시키기</h3>
            <Field label="사유 (학생에게 전달됩니다)">
              <input className={inputClass} value={p.reason} onChange={(e) => p.setReason(e.target.value)} placeholder="예: 장시간 자리비움" />
            </Field>
            <div className="flex items-end gap-2">
              <div className="w-24">
                <Field label="벌점">
                  <select className={inputClass} value={p.points} onChange={(e) => p.setPoints(Number(e.target.value))}>
                    {[0, 1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? "없음" : `${n}점`}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button
                variant="danger"
                className="flex-1"
                busy={p.busy === "ret"}
                onClick={() => {
                  if (p.points > 0 && !p.reason.trim()) return alert("벌점을 부여할 때는 사유를 입력해 주세요.");
                  p.onAct("ret", "return", "좌석을 반납 처리했습니다.", p.points);
                }}
              >
                강제 반납
              </Button>
            </div>
          </div>
        </>
      )}

      {!r && seat.is_active && (
        <form
          className="mt-3 space-y-3 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            p.onAssign(true);
          }}
        >
          <Field label="학번">
            <input className={inputClass} value={p.sid} onChange={(e) => p.setSid(e.target.value)} placeholder="예: 22123456" inputMode="numeric" required />
          </Field>
          <Field label="사유">
            <input className={inputClass} value={p.reason} onChange={(e) => p.setReason(e.target.value)} placeholder="예: 휴대폰 고장" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button type="submit" variant="primary" busy={p.busy === "assign"} disabled={!p.sid.trim()}>
              배정하고 체크인
            </Button>
            <Button disabled={!p.sid.trim() || p.busy === "assign"} onClick={() => p.onAssign(false)}>
              예약만
            </Button>
          </div>
        </form>
      )}

      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <h3 className="text-xs font-bold text-muted">좌석 상태</h3>
        {!seat.is_active && <p className="text-sm text-muted">중지 사유: {seat.inactive_reason ?? "-"}</p>}
        <Button className="w-full" busy={p.busy === "toggle"} onClick={p.onToggle}>
          {seat.is_active ? "이 좌석 사용 중지" : "이 좌석 다시 열기"}
        </Button>
        {seat.is_active && r && <p className="mt-1.5 text-xs text-muted">이용 중인 학생은 벌점 없이 반납됩니다</p>}
      </div>
    </div>
  );
}
