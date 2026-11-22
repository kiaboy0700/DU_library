"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, ChevronRight, Megaphone, TriangleAlert, WifiOff, Zap } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { useApp } from "@/components/Providers";
import { Button, Notice, Panel, Skeleton, Tag, useAction, useNow } from "@/components/ui";
import { ruleTexts, useHome, useSettings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { MODE_LABEL, type RoomSummary } from "@/lib/types";
import { cx, errMsg, fmtRemain, fmtTime, level } from "@/lib/util";

interface Announcement {
  id: number;
  title: string;
  body: string;
  room_id: number | null;
}

export default function HomePage() {
  const { status, toast, refresh } = useApp();
  const router = useRouter();
  const { busy, run } = useAction((m) => toast(m, "error"));
  const { home, error, reload } = useHome();
  const { settings } = useSettings();
  const [notices, setNotices] = useState<Announcement[]>([]);
  const [watching, setWatching] = useState<Set<number>>(new Set());
  const now = useNow();
  const uid = status?.profile.id;

  useEffect(() => {
    supabase
      .from("announcements")
      .select("id,title,body,room_id,until")
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => setNotices((data ?? []).filter((a) => !a.until || new Date(a.until).getTime() > Date.now())));
  }, []);

  const loadWatch = useCallback(async () => {
    if (!uid) return setWatching(new Set());
    const { data } = await supabase.from("watch_requests").select("room_id").eq("user_id", uid);
    setWatching(new Set((data ?? []).map((w) => w.room_id)));
  }, [uid]);
  useEffect(() => {
    loadWatch();
  }, [loadWatch]);

  async function toggleWatch(room: RoomSummary) {
    if (!uid) return toast("로그인하면 빈자리 알림을 받을 수 있습니다.");
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

  const res = status?.reservation;
  const mode = home?.mode;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h1 className="text-[22px] font-bold leading-snug">
          열람실
        </h1>
        {mode && (
          <p className="text-sm text-muted">
            {MODE_LABEL[mode]} 운영
            {mode === "exam" && " · 24시간"}
          </p>
        )}
      </div>

      {home?.incident && (
        <Notice tone="warn" icon={<TriangleAlert size={18} aria-hidden />}>
          <strong className="font-semibold">시스템 점검 중</strong> · 자동 취소와 벌점이 멈춰 있습니다.
        </Notice>
      )}

      {notices.map((n) => (
        <Notice key={n.id} icon={<Megaphone size={18} aria-hidden />}>
          <strong className="font-semibold">{n.title}</strong>
          {n.body && <span className="block">{n.body}</span>}
        </Notice>
      ))}

      {res && (
        <Link href="/me" className="block rounded-[var(--radius-panel)] bg-du-deep p-4 text-white transition-colors duration-150 hover:bg-du-deep-dark">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-white/85">
                {res.room_name} · {res.status === "reserved" ? "체크인 대기" : res.status === "away" ? "외출 중" : "이용 중"}
              </p>
              <p className="mt-0.5 text-2xl font-bold tracking-tight">{res.seat_label}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-white/85">{res.status === "reserved" ? "체크인까지" : res.status === "away" ? "복귀까지" : "남은 시간"}</p>
              <p className="tabular mt-0.5 text-2xl font-bold">
                {fmtRemain(new Date(res.status === "reserved" ? res.checkin_deadline : res.status === "away" && res.away_deadline ? res.away_deadline : res.end_at).getTime() - now)}
              </p>
            </div>
            <ChevronRight size={20} className="shrink-0 text-white/80" aria-hidden />
          </div>
        </Link>
      )}

      {error && !home && (
        <Notice tone="danger" icon={<WifiOff size={18} aria-hidden />}>
          좌석 현황을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.
          <Button size="sm" className="mt-2" onClick={reload}>
            다시 불러오기
          </Button>
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {!home && !error && [0, 1].map((i) => <Skeleton key={i} className="h-[232px] !rounded-[var(--radius-panel)]" />)}
        {home?.rooms.map((room) => {
          const lv = level(room.pct);
          const free = room.total - room.occupied;
          const on = watching.has(room.id);
          return (
            <Panel key={room.id} className="flex flex-col p-4">
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
                <p className="tabular ml-auto text-sm font-semibold" style={{ color: lv.color }}>
                  이용률 {room.pct}%
                </p>
              </div>

              <div className="mt-3">
                <OccupancyMeter pct={room.pct} rules={ruleTexts(settings, "away")} />
              </div>


              <div className="mt-4 flex gap-2">
                <Link
                  href={`/rooms/${room.id}`}
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-1 rounded-[var(--radius-ctl)] bg-du-deep px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-du-deep-dark"
                >
                  좌석 고르기
                  <ChevronRight size={16} aria-hidden />
                </Link>
                {free > 0 && room.is_open && !res ? (
                  <Button busy={busy === `q${room.id}`} onClick={() => quick(room)} title="옆자리가 비어 있는 좌석을 골라 바로 예약합니다">
                    <Zap size={16} aria-hidden />
                    바로 예약
                  </Button>
                ) : null}
                <Button
                  onClick={() => toggleWatch(room)}
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
        })}
      </div>

      <details className="rounded-[var(--radius-panel)] border border-line bg-surface">
        <summary className="flex min-h-12 cursor-pointer items-center px-4 text-sm font-semibold">이용 규칙</summary>
        <dl className="divide-y divide-line border-t border-line text-sm">
          {[
            ["체크인", `예약 후 ${settings?.checkin_minutes ?? 15}분 안에 좌석 QR 스캔 · 늦으면 자동 취소, 벌점 ${settings?.pen_no_show ?? 1}점`],
            ["외출", `혼잡도에 따라 ${settings?.away_high ?? 20}~${settings?.away_low ?? 60}분 · 늦으면 자동 반납, 벌점 ${settings?.pen_away ?? 1}점`],
            ["자리비움 신고", `${settings?.report_high ?? 10}~${settings?.report_low ?? 20}분 안에 QR 스캔으로 응답 · 무응답 시 반납, 벌점 ${settings?.pen_report ?? 2}~${settings?.pen_report_busy ?? 3}점`],
            ["허위 신고", `이용자가 앉아 있는 좌석을 신고한 것으로 관리자가 확인한 경우 · ${settings?.false_report_limit ?? 3}회면 ${settings?.false_report_ban_days ?? 7}일 신고 정지, 벌점 ${settings?.pen_false_report ?? 1}점. 비어 있던 자리를 신고했다면 이용자가 금방 돌아와도 불이익이 없습니다`],
            ["이용 시간", `최대 ${Number(settings?.max_minutes ?? 240) / 60}시간 · 종료 ${settings?.extend_window_min ?? 30}분 전부터 연장`],
            ["예약 정지", `벌점 ${settings?.ban1_points ?? 3}점 ${settings?.ban1_days ?? 3}일 · ${settings?.ban2_points ?? 6}점 ${settings?.ban2_days ?? 14}일`],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-3 px-4 py-2.5">
              <dt className="w-24 shrink-0 font-semibold">{k}</dt>
              <dd className="min-w-0 text-[#3d4744]">{v}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
