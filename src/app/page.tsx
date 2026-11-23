"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRight, DoorOpen, LogOut, Megaphone, QrCode, TriangleAlert, WifiOff, X } from "lucide-react";
import { Banner } from "@/components/Banner";
import { useApp } from "@/components/Providers";
import { QrScanner } from "@/components/QrScanner";
import { RoomCard, useRoomActions } from "@/components/RoomCards";
import { Button, Confirm, Notice, Skeleton, useAction, useNow } from "@/components/ui";
import { hoursLabel, useHome, useSettings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { NOTICE_SEEN_KEY, cx, fmtRemain } from "@/lib/util";

interface Announcement {
  id: number;
  title: string;
  body: string;
  room_id: number | null;
}

/** 홈: 내 상황을 한눈에. 프로필과 내 자리, 공지, 그리고 넘겨 보는 열람실 배너 */
export default function HomePage() {
  const { status, toast, refresh, pulse } = useApp();
  // 내가 신고한 좌석이 반납되어 먼저 예약할 수 있는 동안
  const [pri, setPri] = useState<{ seat_label: string; room_name: string; expires_at: string; token: string } | null>(null);
  const myId = status?.profile.id;
  const hasSeat = !!status?.reservation;
  useEffect(() => {
    if (!myId) return setPri(null);
    rpc<typeof pri>("my_priority")
      .then(setPri)
      .catch(() => {});
  }, [myId, hasSeat, pulse, status?.reservation?.seat_id]);
  const { busy, run } = useAction((m) => toast(m, "error"));
  const [ask, setAsk] = useState<"cancel" | "away" | "return" | null>(null);
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
  // 내 자리 칸: 좌석이 있든 없든 같은 크기
  const tile = "relative flex h-[104px] w-[136px] shrink-0 flex-col justify-center rounded-xl px-3.5 shadow-[0_2px_8px_-2px_rgb(0_60_50/0.18)] transition-transform duration-150 hover:-translate-y-0.5 active:translate-y-0";
  const needScan = !!res && res.status !== "in_use";
  const deadline = res ? (res.status === "reserved" ? res.checkin_deadline : res.status === "away" && res.away_deadline ? res.away_deadline : res.end_at) : null;
  const tileInfo = res && deadline && (
    <>
      <span className="truncate pr-7 text-xs font-medium text-white/85">
        {/* QR 아이콘이 들어가는 상태에서는 자리가 좁아 층 이름을 줄인다 */}
        {res.status === "reserved" ? "체크인 대기" : res.status === "away" ? "외출 중" : `${res.room_name.replace(" 열람실", "")} · 이용 중`}
      </span>
      <span className="text-[24px] font-bold leading-tight tracking-tight">{res.seat_label}</span>
      <span className="tabular text-[13px] font-semibold">
        {fmtRemain(new Date(deadline).getTime() - now)}
        <span className="font-normal text-white/85"> 남음</span>
      </span>
    </>
  );

  // 홈에서 바로 하는 동작: 확인 창을 거친다
  const doAsk = async () => {
    if (!ask) return;
    await run(ask, async () => {
      if (ask === "away") {
        const m = await rpc<number>("go_away");
        toast(`외출 처리했습니다. ${m}분 안에 돌아와 QR을 스캔하세요.`, "ok");
      } else {
        await rpc("return_seat");
        toast(ask === "cancel" ? "예약을 취소했습니다." : "좌석을 반납했습니다.", "ok");
      }
      await refresh();
      reload();
    });
    setAsk(null);
  };
  const strip = "inline-flex min-h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-ctl)] bg-surface/80 px-3 text-sm font-semibold text-du-black transition-colors duration-150 hover:bg-surface";

  return (
    <div className="space-y-5">
      <h1 className="sr-only">홈</h1>

      {/* 내 프로필과 내 자리 */}
      {status && (
        <section aria-label="내 프로필" className="relative overflow-hidden rounded-[var(--radius-panel)] bg-du-tint p-5">
          <span aria-hidden className="absolute -right-10 -top-16 size-48 rounded-full bg-white/45" />
          <span aria-hidden className="absolute -bottom-20 right-24 size-40 rounded-full bg-white/35" />
          <div className="relative flex items-center gap-4">
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
            needScan ? (
              // 체크인 대기·외출 중: QR을 찍어야 하는 상태이므로 누르면 바로 스캐너가 열린다
              <button type="button" onClick={() => setScan(true)} aria-label={`${res.seat_label} ${res.status === "reserved" ? "QR 체크인" : "QR 찍고 복귀"}`} className={cx(tile, "bg-du-deep text-left text-white")}>
                {tileInfo}
                <span className="absolute right-2.5 top-2.5 grid size-7 place-items-center rounded-md bg-white/20">
                  <QrCode size={17} aria-hidden />
                </span>
              </button>
            ) : (
              <Link href="/me" className={cx(tile, "bg-du-deep text-white")}>
                {tileInfo}
              </Link>
            )
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
          </div>
          {/* 내 자리로 지금 할 수 있는 일 */}
          {res && (
            <div className={cx("relative mt-4 grid gap-2", res.status === "in_use" ? "grid-cols-3" : "grid-cols-2")}>
              {res.status === "reserved" && (
                <button type="button" className={strip} onClick={() => setAsk("cancel")}>
                  <X size={16} aria-hidden />
                  예약 취소
                </button>
              )}
              {res.status === "in_use" && (
                <button type="button" className={strip} onClick={() => setAsk("away")}>
                  <DoorOpen size={16} aria-hidden />
                  외출
                </button>
              )}
              {res.status !== "reserved" && (
                <button type="button" className={strip} onClick={() => setAsk("return")}>
                  <LogOut size={16} aria-hidden />
                  반납
                </button>
              )}
              <Link href="/me" className={strip}>
                내 좌석
                <ChevronRight size={16} aria-hidden />
              </Link>
            </div>
          )}
        </section>
      )}

      {ask && res && (
        <Confirm
          title={ask === "cancel" ? "예약 취소" : ask === "away" ? "외출" : "반납"}
          confirmLabel={ask === "cancel" ? "예약 취소" : ask === "away" ? "외출" : "반납"}
          danger={ask !== "away"}
          busy={busy === ask}
          onConfirm={doAsk}
          onClose={() => setAsk(null)}
        >
          {ask === "away" ? (
            <>
              <b className="tabular">{res.away_minutes}분</b> 안에 돌아와 QR을 찍지 않으면 자동 반납되고 벌점이 붙습니다.
            </>
          ) : (
            <b>
              {res.room_name} {res.seat_label}
            </b>
          )}
        </Confirm>
      )}

      {scan && (
        <QrScanner
          onToken={(t) => {
            setScan(false);
            router.push(`/s/${t}`);
          }}
          onClose={() => setScan(false)}
          seat={res ? { label: res.seat_label, room: res.room_name } : undefined}
          deadline={res && deadline ? { label: res.status === "reserved" ? "체크인 마감까지" : res.status === "away" ? "복귀 마감까지" : "남은 이용 시간", at: deadline } : undefined}
        />
      )}

      {pri && new Date(pri.expires_at).getTime() > now && (
        <Link href={`/s/${pri.token}`} className="flex items-center gap-3 rounded-[var(--radius-panel)] bg-du-deep px-4 py-3 text-white transition-colors duration-150 hover:bg-du-deep-dark">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-white/85">{hasSeat ? "좌석 바꾸기" : "우선 예약"} · {pri.room_name}</span>
            <span className="block text-lg font-bold leading-tight">{pri.seat_label}</span>
          </span>
          <span className="tabular shrink-0 rounded-full bg-white/20 px-3 py-1 text-sm font-bold">{fmtRemain(new Date(pri.expires_at).getTime() - now)}</span>
          <ChevronRight size={18} className="shrink-0" aria-hidden />
        </Link>
      )}

      {home?.incident && (
        <Notice tone="warn" icon={<TriangleAlert size={18} aria-hidden />}>
          <strong className="font-semibold">시스템 점검 중</strong> · 자동 취소와 벌점이 멈춰 있습니다.
        </Notice>
      )}

      {/* 공지: 최근 두 건만 보여 주고 나머지는 공지 화면에서 */}
      {status && (
        <Link href="/notices" className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3 transition-colors duration-150 hover:bg-canvas">
          <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-du-tint text-du-deep-dark">
            <Megaphone size={18} aria-hidden />
            {fresh && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-danger ring-2 ring-surface" aria-label="새 공지" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{notices[0]?.title ?? "공지"}</span>
            <span className="block truncate text-[13px] text-muted">{notices.length === 0 ? "새 공지 없음" : notices.length > 1 ? `외 ${notices.length - 1}건의 공지` : notices[0].body || "공지 보기"}</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden />
        </Link>
      )}

      <section aria-labelledby="rooms-h">
        <div className="mb-3 flex items-end justify-between gap-3">
          <h2 id="rooms-h" className="text-[20px] font-bold leading-snug">
            열람실
            {hoursLabel(home, settings) && <span className="tabular ml-2 text-sm font-normal text-muted">{hoursLabel(home, settings)}</span>}
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
            ["이용 시간", `최대 ${Number(settings?.max_minutes ?? 240) / 60}시간 · 종료 ${settings?.extend_window_min ?? 30}분 전부터 ${Number(settings?.extend_minutes ?? 120) / 60}시간씩 연장`],
            ["연장", `혼잡(${settings?.occ_high ?? 80}% 이상)할 때는 ${settings?.max_extends ?? 2}회까지 · 0시·12시에 다시 셈 · 좌석을 바꿔도 합산 · 그 밖에는 제한 없음`],
            ["재예약", `방금 쓴 좌석(반납·종료·취소)은 ${settings?.rebook_same_seat_minutes ?? 10}분 동안 다시 예약할 수 없음 · 다른 좌석은 바로 가능`],
            ["예약 정지", `벌점 ${settings?.ban1_points ?? 3}점 ${settings?.ban1_days ?? 3}일 · ${settings?.ban2_points ?? 6}점 ${settings?.ban2_days ?? 14}일 · 정지되면 이용 중인 좌석도 반납`],
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
