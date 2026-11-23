"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DoorClosed, X, Zap } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { QuickConfirm } from "@/components/RoomCards";
import { useApp } from "@/components/Providers";
import { SeatWatchButton } from "@/components/SeatWatch";
import { LEGEND, LegendSwatch, SeatMap, useWideHover, type SeatVisual } from "@/components/SeatMap";
import { Button, Empty, Notice, Panel, Skeleton, Tag, TimeLeft, useAction, useNow } from "@/components/ui";
import { useHome, useSettings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { SEAT_TYPE_LABEL, STATE_LABEL, type Room, type Seat, type SeatInfo } from "@/lib/types";
import { cx, fmtLeft, fmtTime, level } from "@/lib/util";

export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const roomId = Number(id);
  const router = useRouter();
  const { status, toast, refresh } = useApp();
  const { home } = useHome();
  const { settings } = useSettings();
  const wide = useWideHover();
  const [room, setRoom] = useState<Room | null | undefined>(undefined);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [states, setStates] = useState<Map<number, SeatInfo>>(new Map());
  const [selected, setSelected] = useState<Seat | null>(null);
  const [hours, setHours] = useState(4);
  const { busy, run } = useAction((m) => toast(m, "error"));
  const now = useNow(30000);

  const loadStates = useCallback(async () => {
    const { data } = await supabase.from("seat_state").select("seat_id,state,end_at,until_at,extend_count").eq("room_id", roomId);
    if (data) setStates(new Map((data as SeatInfo[]).map((s) => [s.seat_id, s])));
  }, [roomId]);

  useEffect(() => {
    if (!Number.isFinite(roomId)) return setRoom(null);
    setRoom(undefined);
    setSelected(null);
    (async () => {
      const [r, s] = await Promise.all([
        supabase.from("rooms").select("*").eq("id", roomId).maybeSingle(),
        supabase.from("seats_public").select("*").eq("room_id", roomId).order("id"),
      ]);
      setRoom((r.data as Room) ?? null);
      setSeats((s.data as Seat[]) ?? []);
      loadStates();
    })();
    const ch = supabase
      .channel(`room-${roomId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "seat_state", filter: `room_id=eq.${roomId}` }, (p) => {
        const row = p.new as SeatInfo;
        setStates((m) => new Map(m).set(row.seat_id, row));
      })
      .subscribe();
    const poll = setInterval(loadStates, 45000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(poll);
    };
  }, [roomId, loadStates]);

  const summary = home?.rooms.find((r) => r.id === roomId);
  const mine = status?.reservation;

  const visual = useCallback(
    (seat: Seat): SeatVisual => {
      if (mine?.seat_id === seat.id) return "mine";
      if (!seat.is_active) return "inactive";
      return states.get(seat.id)?.state ?? "free";
    },
    [mine, states],
  );

  // Esc 로 팝업 닫기
  useEffect(() => {
    if (!selected) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [selected]);

  const after = async (label: string) => {
    await refresh();
    toast(`${label} 좌석을 예약했습니다. ${settings?.checkin_minutes ?? 15}분 안에 좌석 QR을 스캔하세요.`, "ok");
    router.push("/me");
  };
  const reserve = () =>
    selected &&
    run("reserve", async () => {
      await rpc("reserve_seat", { p_seat: selected.id, p_minutes: hours * 60 });
      await after(selected.label);
    });
  // 자리 이동: 좌석을 맡아 두고, 그 좌석의 QR을 찍으면 끝난다
  const move = () =>
    selected &&
    run("move", async () => {
      const r = await rpc<{ seat_label: string; minutes: number }>("request_move", { p_seat: selected.id });
      await refresh();
      setSelected(null);
      toast(`${r.seat_label} 좌석을 ${r.minutes}분 동안 맡아 뒀습니다. 그 좌석의 QR을 찍으면 이동합니다.`, "ok");
    });
  const [ask, setAsk] = useState(false);
  const quick = async () => {
    await run("quick", async () => {
      const r = await rpc<{ seat_label: string }>("quick_reserve", { p_room: roomId, p_minutes: hours * 60 });
      await after(r.seat_label);
    });
    setAsk(false);
  };

  if (room === null)
    return (
      <Empty icon={<DoorClosed size={32} aria-hidden />} title="열람실을 찾을 수 없습니다">
        <Link href="/rooms" className="font-semibold text-du-deep-dark underline underline-offset-4">
          열람실 목록으로
        </Link>
      </Empty>
    );

  const maxHours = Number(settings?.max_minutes ?? 240) / 60;
  const lv = summary ? level(summary.pct) : null;
  const free = summary ? summary.total - summary.occupied : null;
  const banned = !!status?.profile.banned_until && new Date(status.profile.banned_until).getTime() > now;
  const blocked = banned || (!!summary && !summary.is_open);
  const exam = home?.mode === "exam";

  // 사용 중인 좌석: 누가 쓰는지는 알 수 없고, 언제 비는지만 알려 준다
  const info = selected ? states.get(selected.id) : undefined;
  const holding = !!selected && status?.move?.seat_id === selected.id;
  const taken = !!selected && !!info && info.state !== "free" && mine?.seat_id !== selected.id;
  const extendsLeft = info ? Math.max(0, Number(settings?.max_extends ?? 2) - info.extend_count) : 0;
  const hint = (seat: Seat) => {
    const i = states.get(seat.id);
    if (!i || i.state === "free" || !i.until_at) return null;
    const left = fmtLeft(new Date(i.until_at).getTime() - now);
    return i.state === "reserved" ? `체크인 마감 ${left} 전` : i.state === "away" ? `복귀 마감 ${left} 전` : `${left} 남음`;
  };

  const form = selected && (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xl font-bold tracking-tight">{selected.label}</p>
          <p className="text-sm text-muted">
            {room?.name} · {SEAT_TYPE_LABEL[selected.seat_type]}
          </p>
        </div>
        <button type="button" aria-label="선택 취소" onClick={() => setSelected(null)} className="-m-1 grid size-9 place-items-center rounded-lg text-muted hover:bg-canvas">
          <X size={18} aria-hidden />
        </button>
      </div>
      {holding ? (
        <>
          <p className="mt-3 text-sm text-[#3d4744]">
            맡아 둔 좌석 · <strong className="tabular font-semibold">{status?.move ? <TimeLeft at={status.move.expires_at} /> : ""}</strong> 안에 이 좌석의 QR을 찍으세요
          </p>
          <Button
            className="mt-3 w-full"
            busy={busy === "cancel"}
            onClick={() =>
              run("cancel", async () => {
                await rpc("cancel_move");
                await refresh();
                setSelected(null);
                toast("자리 이동을 취소했습니다.");
              })
            }
          >
            이동 취소
          </Button>
        </>
      ) : taken && info ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
            <div>
              <dt className="text-xs text-muted">상태</dt>
              <dd className="mt-0.5">
                <Tag tone={info.state === "in_use" ? "neutral" : "warn"}>{STATE_LABEL[info.state]}</Tag>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{info.state === "reserved" ? "체크인 마감까지" : info.state === "away" ? "복귀 마감까지" : "남은 시간"}</dt>
              <dd className="tabular font-bold">{info.until_at ? <TimeLeft at={info.until_at} /> : "–"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">이용 종료</dt>
              <dd className="tabular font-semibold">{info.end_at ? fmtTime(info.end_at) : "–"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">남은 연장</dt>
              <dd className="tabular font-semibold">{exam ? "제한 없음" : `${extendsLeft}회`}</dd>
            </div>
          </dl>
          {info.state === "in_use" && !exam && extendsLeft === 0 && info.end_at && <p className="mt-3 text-xs text-muted">{fmtTime(info.end_at)}에 비워집니다</p>}
          <SeatWatchButton key={selected.id} seatId={selected.id} label={selected.label} className="mt-3 w-full" />
        </>
      ) : mine ? (
        mine.status === "in_use" ? (
          <>
            <p className="mt-3 text-sm text-[#3d4744]">
              <strong className="font-semibold">{mine.seat_label}</strong> → <strong className="font-semibold">{selected.label}</strong> · {String(settings?.move_hold_minutes ?? 10)}분 안에 이 좌석의 QR을 찍으세요
            </p>
            <Button variant="primary" size="lg" className="mt-3 w-full" busy={busy === "move"} disabled={blocked} onClick={move}>
              이 자리로 이동
            </Button>
          </>
        ) : (
          <p className="mt-3 text-sm text-[#3d4744]">
            {mine.seat_label} {mine.status === "reserved" ? "체크인 대기 중" : "외출 중"} · 체크인 후 옮길 수 있습니다
          </p>
        )
      ) : (
        <>
          <fieldset className="mt-3">
            <legend className="text-[13px] font-semibold">
              이용 시간
              {summary?.closes_at && <span className="tabular ml-1.5 font-normal text-muted">{fmtTime(summary.closes_at)} 폐관</span>}
            </legend>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {Array.from({ length: maxHours }, (_, i) => i + 1).map((h) => (
                <label
                  key={h}
                  className={cx(
                    "flex min-h-11 cursor-pointer items-center justify-center rounded-[var(--radius-ctl)] border text-sm font-semibold transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-du-deep",
                    hours === h ? "border-du-deep bg-du-tint text-du-deep-dark" : "border-line hover:bg-canvas",
                  )}
                >
                  <input type="radio" name="hours" value={h} checked={hours === h} onChange={() => setHours(h)} className="sr-only" />
                  {h}시간
                </label>
              ))}
            </div>
          </fieldset>
          <Button variant="primary" size="lg" className="mt-3 w-full" busy={busy === "reserve"} disabled={blocked} onClick={reserve}>
            {selected.label} 예약하기
          </Button>
        </>
      )}
    </>
  );

  return (
    <div className={cx("space-y-4", selected && !wide && "pb-52")}>
      <div>
        {/* 열람실 바로 이동: 뒤로 가지 않고 층을 바꾼다 */}
        <nav aria-label="열람실 선택" className="flex gap-1.5 overflow-x-auto">
          {(home?.rooms ?? []).map((x) => {
            const on = x.id === roomId;
            return (
              <Link
                key={x.id}
                href={`/rooms/${x.id}`}
                aria-current={on ? "page" : undefined}
                className={cx(
                  "flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors duration-150",
                  on ? "border-du-deep bg-du-deep text-white" : "border-line bg-surface hover:bg-canvas",
                )}
              >
                {x.name}
                <span className={cx("tabular font-normal", on ? "text-white/85" : "text-muted")}>{x.total - x.occupied}석</span>
              </Link>
            );
          })}
          {!home && <Skeleton className="h-10 w-56 !rounded-full" />}
        </nav>
        <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-1">
          <h1 className="sr-only">{room?.name ?? "열람실"}</h1>
          {summary && lv && (
            <p className="tabular text-sm">
              <span className="font-bold">{free}석 남음</span>
              <span className="text-muted"> / {summary.total}석 · </span>
              <span className="font-semibold" style={{ color: lv.color }}>
                이용률 {summary.pct}% {lv.name}
              </span>
            </p>
          )}
        </div>
      </div>

      {summary && !summary.is_open && (
        <Notice tone="warn" icon={<DoorClosed size={18} aria-hidden />}>
          {summary.reason}
        </Notice>
      )}
      {banned && (
        <Notice tone="danger">
          예약이 정지된 상태입니다. {status?.profile.ban_reason} ·{" "}
          <Link href="/me" className="font-semibold underline underline-offset-2">
            내 벌점 보기
          </Link>
        </Notice>
      )}

      {summary && (
        <Panel className="p-4">
          <OccupancyMeter pct={summary.pct} />
        </Panel>
      )}

      <Panel className="p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]" aria-label="좌석 상태 범례">
            {LEGEND.map((l) => (
              <li key={l.key} className="flex items-center gap-1.5">
                <LegendSwatch kind={l.key} />
                {l.label}
              </li>
            ))}
          </ul>
          {!mine && (
            <Button size="sm" busy={busy === "quick"} disabled={blocked || free === 0} onClick={() => setAsk(true)}>
              <Zap size={15} aria-hidden />
              빠른 예약
            </Button>
          )}
          {ask && room && <QuickConfirm roomName={room.name} busy={busy === "quick"} onClose={() => setAsk(false)} onConfirm={quick} />}
        </div>
        {room ? (
          <SeatMap
            title={room.name}
            width={room.layout_w}
            height={room.layout_h}
            decor={room.decor}
            seats={seats}
            visual={visual}
            selectedId={selected?.id}
            onSelect={(s) => setSelected((cur) => (cur?.id === s.id ? null : s))}
            selectable={(v) => v !== "inactive" && v !== "mine"}
            hint={hint}
            popover={wide ? form : undefined}
            focusId={mine?.room_id === roomId ? mine.seat_id : null}
          />
        ) : (
          <Skeleton className="h-[420px]" />
        )}
      </Panel>

      {/* 좁은 화면: 아래에서 올라오는 시트 */}
      {selected && !wide && (
        <div className="rise no-print fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 px-3">
          <div className="mx-auto max-w-3xl rounded-[var(--radius-panel)] border border-line bg-surface p-4 shadow-[var(--shadow-float)]">{form}</div>
        </div>
      )}
    </div>
  );
}
