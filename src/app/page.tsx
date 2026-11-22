"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRight, Megaphone, QrCode, TriangleAlert, WifiOff } from "lucide-react";
import { Banner } from "@/components/Banner";
import { useApp } from "@/components/Providers";
import { QrScanner } from "@/components/QrScanner";
import { RoomCard, useRoomActions } from "@/components/RoomCards";
import { Button, Notice, Skeleton, useNow } from "@/components/ui";
import { useHome, useSettings } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { MODE_LABEL } from "@/lib/types";
import { NOTICE_SEEN_KEY, fmtRemain } from "@/lib/util";

interface Announcement {
  id: number;
  title: string;
  body: string;
  room_id: number | null;
}

/** 홈: 내 상황을 한눈에. 프로필과 내 자리, 공지, 그리고 넘겨 보는 열람실 배너 */
export default function HomePage() {
  const { status } = useApp();
  const { home, error, reload } = useHome();
  const { settings } = useSettings();
  const actions = useRoomActions(settings);
  const [notices, setNotices] = useState<Announcement[]>([]);
  const [fresh, setFresh] = useState(false);
  const [scan, setScan] = useState(false);
  const router = useRouter();
  const now = useNow();

  useEffect(() => {
    supabase
      .from("announcements")
      .select("id,title,body,room_id,until")
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => {
        const live = (data ?? []).filter((a) => !a.until || new Date(a.until).getTime() > Date.now());
        setNotices(live);
        // 공지 화면에서 마지막으로 읽은 것보다 새 공지가 있으면 점으로 알린다
        try {
          setFresh(live.length > 0 && live[0].id > Number(localStorage.getItem(NOTICE_SEEN_KEY) ?? 0));
        } catch {}
      });
  }, []);

  // 소속을 '전공'과 '단과대학·학부'로 나눠 두 줄로 보여 준다
  const dept = status?.profile.department ?? null;
  const major = dept ? (dept.match(/\(([^)]+)\)/)?.[1] ?? dept.replace(/^\S+\s+/, "")) : null;
  const upper = dept ? (dept.includes("(") ? dept.replace(/\([^)]*\)/, "").trim() : dept.split(" ")[0]) : null;

  const res = status?.reservation;
  const mode = home?.mode;

  return (
    <div className="space-y-5">
      <h1 className="sr-only">홈</h1>

      {/* 내 프로필과 내 자리 */}
      {status && (
        <section aria-label="내 프로필" className="relative flex items-center gap-4 overflow-hidden rounded-[var(--radius-panel)] bg-du-tint p-5">
          <span aria-hidden className="absolute -right-10 -top-16 size-48 rounded-full bg-white/45" />
          <span aria-hidden className="absolute -bottom-20 right-24 size-40 rounded-full bg-white/35" />
          <div className="relative min-w-0 flex-1">
            <p className="text-[26px] font-bold leading-tight tracking-[-0.02em]">{status.profile.name}</p>
            <p className="mt-1 text-[15px] font-semibold text-du-deep-dark">{major ?? "학과 미등록"}</p>
            {upper && <p className="text-[13px] text-[#3d4744]">{upper}</p>}
            <p className="tabular mt-0.5 text-[13px] text-[#3d4744]">
              {status.profile.student_id}
            </p>
          </div>
          {/* 내 자리 칸: 좌석이 있든 없든 같은 크기라 화면이 들썩이지 않는다 */}
          {res ? (
            <Link
              href="/me"
              className="relative flex h-[104px] w-[136px] shrink-0 flex-col justify-center rounded-xl bg-du-deep px-3.5 text-white shadow-[0_2px_8px_-2px_rgb(0_60_50/0.18)] transition-transform duration-150 hover:-translate-y-0.5 active:translate-y-0"
            >
              <span className="truncate text-xs font-medium text-white/85">
                {res.room_name.replace(" 열람실", "")} · {res.status === "reserved" ? "체크인 대기" : res.status === "away" ? "외출 중" : "이용 중"}
              </span>
              <span className="text-[24px] font-bold leading-tight tracking-tight">{res.seat_label}</span>
              <span className="tabular text-[13px] font-semibold">
                {fmtRemain(new Date(res.status === "reserved" ? res.checkin_deadline : res.status === "away" && res.away_deadline ? res.away_deadline : res.end_at).getTime() - now)}
                <span className="font-normal text-white/85"> 남음</span>
              </span>
            </Link>
          ) : (
            <div className="relative flex h-[104px] w-[136px] shrink-0 flex-col overflow-hidden rounded-xl bg-surface shadow-[0_2px_8px_-2px_rgb(0_60_50/0.18)]">
              <button
                type="button"
                onClick={() => setScan(true)}
                aria-label="좌석 QR 스캔해서 예약"
                className="flex flex-1 flex-col items-center justify-center gap-0.5 text-du-deep-dark transition-colors duration-150 hover:bg-du-tint"
              >
                <QrCode size={30} strokeWidth={1.8} aria-hidden />
                <span className="text-xs font-semibold">QR 스캔</span>
              </button>
              <Link href="/rooms" className="flex h-9 items-center justify-center gap-0.5 border-t border-line text-[13px] font-semibold text-du-deep-dark transition-colors duration-150 hover:bg-du-tint">
                좌석 고르기
                <ChevronRight size={14} aria-hidden />
              </Link>
            </div>
          )}
        </section>
      )}

      {scan && (
        <QrScanner
          onToken={(t) => {
            setScan(false);
            router.push(`/s/${t}`);
          }}
          onClose={() => setScan(false)}
        />
      )}

      {home?.incident && (
        <Notice tone="warn" icon={<TriangleAlert size={18} aria-hidden />}>
          <strong className="font-semibold">시스템 점검 중</strong> · 자동 취소와 벌점이 멈춰 있습니다.
        </Notice>
      )}

      {/* 공지: 최근 두 건만 보여 주고 나머지는 공지 화면에서 */}
      {notices.length > 0 && (
        <Link href="/notices" className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3 transition-colors duration-150 hover:bg-canvas">
          <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-du-tint text-du-deep-dark">
            <Megaphone size={18} aria-hidden />
            {fresh && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-danger ring-2 ring-surface" aria-label="새 공지" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{notices[0].title}</span>
            <span className="block truncate text-[13px] text-muted">{notices.length > 1 ? `외 ${notices.length - 1}건의 공지` : notices[0].body || "공지 보기"}</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden />
        </Link>
      )}

      <section aria-labelledby="rooms-h">
        <div className="mb-3 flex items-end justify-between gap-3">
          <h2 id="rooms-h" className="text-[20px] font-bold leading-snug">
            열람실
            {mode && (
              <span className="ml-2 text-sm font-normal text-muted">
                {MODE_LABEL[mode]} 운영{mode === "exam" && " · 24시간"}
              </span>
            )}
          </h2>
          <Link href="/rooms" className="-mr-1 flex min-h-9 items-center gap-0.5 whitespace-nowrap rounded-md px-1 text-sm font-semibold text-du-deep-dark hover:underline">
            모두 보기
            <ChevronRight size={16} aria-hidden />
          </Link>
        </div>

        {error && !home && (
          <Notice tone="danger" icon={<WifiOff size={18} aria-hidden />}>
            좌석 현황을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.
            <Button size="sm" className="mt-2" onClick={reload}>
              다시 불러오기
            </Button>
          </Notice>
        )}

        {!home && !error && <Skeleton className="h-[236px] !rounded-[var(--radius-panel)]" />}
        {home && (
          <Banner label="열람실" names={home.rooms.map((r) => r.name)}>
            {home.rooms.map((room) => (
              <RoomCard key={room.id} room={room} actions={actions} className="h-full" />
            ))}
          </Banner>
        )}
      </section>

      <details className="rounded-[var(--radius-panel)] border border-line bg-surface">
        <summary className="flex min-h-12 cursor-pointer items-center px-4 text-sm font-semibold">이용 규칙</summary>
        <dl className="divide-y divide-line border-t border-line text-sm">
          {[
            ["체크인", `예약 후 ${settings?.checkin_minutes ?? 15}분 안에 좌석 QR 스캔 · 늦으면 자동 취소, 벌점 ${settings?.pen_no_show ?? 1}점`],
            ["외출", `혼잡도에 따라 ${settings?.away_high ?? 20}~${settings?.away_low ?? 60}분 · 늦으면 자동 반납, 벌점 ${settings?.pen_away ?? 1}점`],
            ["자리비움 신고", `${settings?.report_high ?? 10}~${settings?.report_low ?? 20}분 안에 QR 스캔으로 응답 · 무응답 시 반납, 벌점 ${settings?.pen_report ?? 2}~${settings?.pen_report_busy ?? 3}점`],
            ["허위 신고", `앉아 있는 좌석을 신고한 것으로 확인되면 · ${settings?.false_report_limit ?? 3}회면 ${settings?.false_report_ban_days ?? 7}일 신고 정지, 벌점 ${settings?.pen_false_report ?? 1}점`],
            ["자리 이동", `옮길 좌석의 QR을 찍으면 이동 · 좌석을 먼저 고르면 ${settings?.move_hold_minutes ?? 10}분 동안 맡아 둠 · 남은 시간은 그대로`],
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
