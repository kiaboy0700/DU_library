"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleSlash, MapPin, QrCode } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { useApp } from "@/components/Providers";
import { QrScanner } from "@/components/QrScanner";
import { SeatWatchButton } from "@/components/SeatWatch";
import { Button, Empty, Notice, Panel, Skeleton, Tag, TimeLeft, useAction, useNow } from "@/components/ui";
import { ruleTexts, useSettings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { SEAT_TYPE_LABEL, STATE_LABEL, type SeatContext, type SeatInfo } from "@/lib/types";
import { cx, fmtRemain, fmtTime, getPosition } from "@/lib/util";

/** 좌석 QR을 스캔하면 열리는 화면. 상황에 맞는 동작 하나를 가장 크게 보여 준다 */
export default function SeatQrPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { status, refresh, toast, pulse } = useApp();
  const { settings } = useSettings();
  const now = useNow();
  const [ctx, setCtx] = useState<SeatContext | null | undefined>(undefined);
  const [done, setDone] = useState<string | null>(null);
  const [info, setInfo] = useState<SeatInfo | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<"report" | "return" | "away" | null>(null);
  const [rescan, setRescan] = useState(false);
  const { busy, run } = useAction((m) => toast(m, "error"));

  const load = useCallback(async () => {
    try {
      const c = await rpc<SeatContext | null>("seat_context_v2", { p_token: token });
      setCtx(c);
      // 누가 쓰는지는 알 수 없고, 언제 비는지만 가져온다
      if (c) {
        const { data } = await supabase.from("seat_state").select("seat_id,state,end_at,until_at,extend_count").eq("seat_id", c.seat.id).maybeSingle();
        setInfo((data as SeatInfo) ?? null);
      }
    } catch {
      setCtx(null);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load, status?.profile.id, pulse]);

  /** 위치가 필요한 동작: 좌표를 붙여 호출 */
  const scan = (key: string, fn: string, okText: (r: unknown) => string, extra: Record<string, unknown> = {}) =>
    run(key, async () => {
      const pos = ctx?.gps_required ? await getPosition() : null;
      const r = await rpc(fn, { p_token: token, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, ...extra });
      setDone(okText(r));
      setConfirm(null);
      await Promise.all([refresh(), load()]);
    });
  const plain = (key: string, fn: () => Promise<string>) =>
    run(key, async () => {
      setDone(await fn());
      setConfirm(null);
      await Promise.all([refresh(), load()]);
    });

  // QR을 찍고 들어오면 버튼을 한 번 더 누르지 않아도 되게, 할 일이 하나뿐인 경우는 바로 처리한다
  // (체크인 대기 → 체크인, 외출 중 → 복귀, 자리 확인 요청 → 자리에 있음 확인)
  const auto = useRef(false);
  // 이 화면에서 다른 QR을 다시 찍으면 처음부터
  useEffect(() => {
    auto.current = false;
    setDone(null);
    setConfirm(null);
    setCtx(undefined);
  }, [token]);
  useEffect(() => {
    // 이동하려고 맡아 둔 좌석의 QR을 찍었으면 바로 이동
    if (!auto.current && ctx?.held_by_me && status?.reservation?.status === "in_use") {
      auto.current = true;
      scan("move", "move_seat", (r) => `${(r as { from: string; to: string }).from}에서 ${(r as { from: string; to: string }).to}(으)로 옮겼습니다.`);
      return;
    }
    if (auto.current || !ctx?.is_mine || !ctx.my_reservation) return;
    const st = ctx.my_reservation.status;
    if (st === "reserved") {
      auto.current = true;
      scan("in", "check_in", () => "체크인했습니다. 열공하세요!");
    } else if (st === "away") {
      auto.current = true;
      scan("back", "come_back", () => "복귀 처리했습니다.");
    } else if (st === "in_use" && ctx.pending_report) {
      auto.current = true;
      scan("here", "confirm_presence", () => "자리에 있음을 확인했습니다. 벌점은 없습니다.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 좌석 정보를 처음 받았을 때 한 번만
  }, [ctx]);

  if (ctx === undefined) return <Skeleton className="h-72 !rounded-[var(--radius-panel)]" />;
  if (ctx === null)
    return (
      <Panel>
        <Empty icon={<CircleSlash size={36} strokeWidth={1.6} aria-hidden />} title="사용할 수 없는 QR입니다">
          책상의 QR을 다시 스캔해 주세요
          <Link href="/" className="mt-3 block font-semibold text-du-deep-dark underline underline-offset-4">
            홈으로 가기
          </Link>
        </Empty>
      </Panel>
    );

  const { seat } = ctx;
  const maxHours = Number(settings?.max_minutes ?? 240) / 60;
  const extendsLeft = info ? Math.max(0, Number(settings?.max_extends ?? 2) - info.extend_count) : 0;
  const r = ctx.my_reservation;
  const isAdmin = status?.profile.role === "admin";
  // 좌석을 쓰는 동작은 학생 계정만
  const loggedIn = !!status && !isAdmin;
  const endLeft = r ? new Date(r.end_at).getTime() - now : 0;
  const canExtend = !!r && r.status === "in_use" && endLeft <= ctx.extend_window_min * 60_000;
  // 내 좌석이 따로 있는데 다른 좌석의 QR을 찍은 경우: QR을 찍어야 풀리는 상태(체크인 대기·외출)면 먼저 알려 준다
  const mine = loggedIn && !ctx.is_mine ? (status?.reservation ?? null) : null;
  const wrong = mine && mine.status !== "in_use" ? mine : null;
  const wrongUntil = wrong ? (wrong.status === "reserved" ? wrong.checkin_deadline : (wrong.away_deadline ?? wrong.end_at)) : null;

  return (
    <div className="space-y-4">
      <Panel className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <QrCode size={15} aria-hidden />
              {seat.room_name} · {SEAT_TYPE_LABEL[seat.seat_type]}
            </p>
            <h1 className="text-[36px] font-bold leading-tight tracking-tight">{seat.label}</h1>
          </div>
          <Tag tone={ctx.is_mine ? "deep" : ctx.state === "free" ? "deep" : "neutral"}>{ctx.is_mine ? `내 좌석 · ${STATE_LABEL[ctx.state]}` : STATE_LABEL[ctx.state]}</Tag>
        </div>

        {done && (
          <div className="rise mt-4" role="status">
            <Notice icon={<CircleCheck size={18} aria-hidden />}>
              <strong className="font-semibold">{done}</strong>
            </Notice>
          </div>
        )}

        {ctx.gps_required && (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
            <MapPin size={14} aria-hidden />
            도서관 안에서만 처리됩니다 (위치 확인)
          </p>
        )}

        <div className="mt-4 space-y-2.5">
          {isAdmin && (
            <Notice>
              관리자 계정입니다. 이 좌석은{" "}
              <Link href="/admin" className="font-semibold underline underline-offset-2">
                관제 화면
              </Link>
              에서 처리할 수 있습니다.
            </Notice>
          )}
          {!status && (
            <>
              <Button variant="primary" size="lg" className="w-full" onClick={() => router.push(`/login?next=/s/${token}`)}>
                로그인
              </Button>
            </>
          )}

          {wrong && !ctx.priority_until && (
            <div className="rounded-[var(--radius-ctl)] border border-warn/40 bg-warn-tint p-3.5">
              <p className="font-bold text-[#5c3d00]">내 좌석이 아닙니다</p>
              <p className="mt-0.5 text-sm text-[#5c3d00]">
                내 좌석 <strong className="font-semibold">{wrong.room_name} {wrong.seat_label}</strong> · {wrong.status === "reserved" ? "체크인 마감까지" : "복귀 마감까지"}{" "}
                <strong className="tabular">{wrongUntil ? fmtRemain(new Date(wrongUntil).getTime() - now) : "-"}</strong>
              </p>
              <Button variant={ctx.state === "free" && seat.is_active ? "secondary" : "primary"} className="mt-3 w-full" onClick={() => setRescan(true)}>
                <QrCode size={16} aria-hidden />
                내 좌석 QR 찍기
              </Button>
            </div>
          )}

          {loggedIn && !seat.is_active && <Notice tone="warn">사용이 중지된 좌석입니다</Notice>}

          {/* 빈 좌석: 바로 예약 + 체크인 */}
          {loggedIn && seat.is_active && ctx.state === "free" && !ctx.have_other && !ctx.held_by_other && (
            <>
              {ctx.is_open ? (
                <>
                  <fieldset>
                    <legend className="text-[13px] font-semibold">이용 시간</legend>
                    <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                      {Array.from({ length: maxHours }, (_, i) => i + 1).map((h) => (
                        <label
                          key={h}
                          className={cx(
                            "flex min-h-11 cursor-pointer items-center justify-center rounded-[var(--radius-ctl)] border text-sm font-semibold transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-du-deep",
                            (hours ?? maxHours) === h ? "border-du-deep bg-du-tint text-du-deep-dark" : "border-line hover:bg-canvas",
                          )}
                        >
                          <input type="radio" name="hours" value={h} checked={(hours ?? maxHours) === h} onChange={() => setHours(h)} className="sr-only" />
                          {h}시간
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full"
                    busy={busy === "sit"}
                    onClick={() =>
                      run("sit", async () => {
                        await rpc("reserve_seat", { p_seat: seat.id, p_minutes: (hours ?? maxHours) * 60 });
                        const pos = ctx.gps_required ? await getPosition() : null;
                        await rpc("check_in", { p_token: token, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
                        setDone(`${seat.label} 좌석 이용을 시작했습니다.`);
                        await Promise.all([refresh(), load()]);
                      })
                    }
                  >
                    이 좌석 예약하고 바로 시작
                  </Button>
                </>
              ) : (
                <Notice tone="warn">{ctx.reason}</Notice>
              )}
            </>
          )}
          {loggedIn && ctx.state === "free" && ctx.have_other && !ctx.held_by_other && status?.reservation?.status === "in_use" && (
            <>
              <p className="text-sm text-[#3d4744]">
                <strong className="font-semibold">{status.reservation.seat_label}</strong> → <strong className="font-semibold">{seat.label}</strong> · 남은 시간 그대로
              </p>
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                busy={busy === "move"}
                onClick={() => scan("move", "move_seat", (r) => `${(r as { from: string; to: string }).from}에서 ${(r as { from: string; to: string }).to}(으)로 옮겼습니다.`)}
              >
                이 자리로 이동
              </Button>
            </>
          )}
          {/* 체크인 대기·외출 중에 다른 빈 좌석을 찍음: 이 좌석으로 바꿀 수 있다 */}
          {wrong && seat.is_active && ctx.state === "free" && !ctx.held_by_other &&
            (ctx.is_open ? (
              <>
                <p className="text-sm text-[#3d4744]">
                  <strong className="font-semibold">{wrong.seat_label}</strong> → <strong className="font-semibold">{seat.label}</strong> · 남은 시간 그대로
                </p>
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  busy={busy === "sw"}
                  onClick={() =>
                    scan("sw", "switch_seat", (x) => `${(x as { from: string; to: string }).from}에서 ${(x as { from: string; to: string }).to}(으)로 바꿔 ${wrong.status === "reserved" ? "체크인했습니다" : "복귀했습니다"}.`)
                  }
                >
                  이 좌석으로 바꿔 {wrong.status === "reserved" ? "체크인" : "복귀"}
                </Button>
              </>
            ) : (
              <Notice tone="warn">{ctx.reason}</Notice>
            ))}
          {loggedIn && ctx.state === "free" && ctx.held_by_other && <Notice tone="warn">다른 학생이 이동하려고 맡아 둔 좌석입니다.</Notice>}

          {/* 내 좌석 */}
          {ctx.is_mine && r?.status === "reserved" && (
            <>
              <p className="text-sm text-[#3d4744]">
                체크인 마감까지 <strong className="tabular">{fmtRemain(new Date(r.checkin_deadline).getTime() - now)}</strong>
              </p>
              <Button variant="primary" size="lg" className="w-full" busy={busy === "in"} onClick={() => scan("in", "check_in", () => "체크인했습니다. 열공하세요!")}>
                체크인
              </Button>
            </>
          )}

          {ctx.is_mine && r?.status === "away" && (
            <>
              <p className="text-sm text-[#3d4744]">
                복귀 마감까지 <strong className="tabular">{r.away_deadline ? fmtRemain(new Date(r.away_deadline).getTime() - now) : "-"}</strong>
              </p>
              <Button variant="primary" size="lg" className="w-full" busy={busy === "back"} onClick={() => scan("back", "come_back", () => "복귀 처리했습니다.")}>
                자리로 복귀
              </Button>
            </>
          )}

          {ctx.is_mine && r?.status === "in_use" && (
            <>
              {ctx.pending_report ? (
                <>
                  <Notice tone="danger">
                    자리 확인 요청
                    {ctx.report_deadline && (
                      <>
                        {" · "}
                        <strong className="tabular">{fmtRemain(new Date(ctx.report_deadline).getTime() - now)}</strong> 남음
                      </>
                    )}
                  </Notice>
                  <Button variant="primary" size="lg" className="w-full" busy={busy === "here"} onClick={() => scan("here", "confirm_presence", () => "자리에 있음을 확인했습니다. 벌점은 없습니다.")}>
                    자리에 있어요
                  </Button>
                </>
              ) : (
                <p className="text-sm text-[#3d4744]">
                  <strong className="tabular">{fmtTime(r.end_at)}</strong>까지 · 남은 시간 <span className="tabular">{fmtRemain(endLeft)}</span>
                </p>
              )}
              <div className="grid grid-cols-3 gap-2">
                <Button aria-expanded={confirm === "away"} disabled={ctx.pending_report} onClick={() => setConfirm(confirm === "away" ? null : "away")}>
                  외출
                </Button>
                <Button
                  disabled={!canExtend}
                  busy={busy === "ext"}
                  onClick={() => scan("ext", "extend_reservation", (end) => `${fmtTime(end as string)}까지 연장했습니다.`)}
                >
                  연장
                </Button>
                <Button variant="danger" aria-expanded={confirm === "return"} onClick={() => setConfirm(confirm === "return" ? null : "return")}>
                  반납
                </Button>
              </div>
              {!canExtend && <p className="text-xs text-muted">연장은 종료 {ctx.extend_window_min}분 전부터</p>}
            </>
          )}
          {ctx.is_mine && r?.status === "away" && (
            <Button variant="danger" className="w-full" aria-expanded={confirm === "return"} onClick={() => setConfirm(confirm === "return" ? null : "return")}>
              반납
            </Button>
          )}

          {confirm === "away" && (
            <div className="rise rounded-[var(--radius-ctl)] border border-line p-3.5">
              <p className="font-semibold">
                지금 외출하면 <span className="tabular text-du-deep-dark">{ctx.away_minutes}분</span> 안에 돌아와야 합니다
              </p>
              <div className="mt-3">
                <OccupancyMeter pct={ctx.occupancy} rules={ruleTexts(settings, "away")} />
              </div>
              <Button variant="primary" className="mt-3" busy={busy === "away"} onClick={() => plain("away", async () => `외출 처리했습니다. ${await rpc<number>("go_away")}분 안에 돌아오세요.`)}>
                외출 시작
              </Button>
            </div>
          )}
          {confirm === "return" && (
            <div className="rise rounded-[var(--radius-ctl)] border border-line p-3.5">
              <p className="font-semibold">{seat.label} 좌석을 반납할까요?</p>
              <Button variant="danger" className="mt-3" busy={busy === "ret"} onClick={() => plain("ret", async () => { await rpc("return_seat"); return "좌석을 반납했습니다."; })}>
                반납하기
              </Button>
            </div>
          )}

          {/* 다른 사람의 좌석: 언제 비는지 */}
          {loggedIn && !ctx.is_mine && ctx.state !== "free" && info && info.state !== "free" && (
            <dl className="grid grid-cols-3 gap-2 rounded-[var(--radius-ctl)] bg-[#f6f9f8] px-3.5 py-3 text-sm">
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
                <dd className="tabular font-semibold">{ctx.mode === "exam" ? "제한 없음" : `${extendsLeft}회`}</dd>
              </div>
            </dl>
          )}
          {loggedIn && !ctx.is_mine && ctx.state !== "free" && !ctx.priority_until && <SeatWatchButton seatId={seat.id} label={seat.label} className="w-full" />}
          {/* 다른 사람의 좌석 */}
          {loggedIn && !ctx.is_mine && ctx.state === "in_use" && (
            <>
              <Button aria-expanded={confirm === "report"} className="w-full" onClick={() => setConfirm(confirm === "report" ? null : "report")}>
                자리가 비어 있어요
              </Button>
              {confirm === "report" && (
                <div className="rise rounded-[var(--radius-ctl)] border border-line p-3.5">
                  <p className="font-semibold">자리비움을 신고할까요?</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-[#3d4744]">
                    <li>
                      이용자가 <strong className="tabular">{ctx.report_minutes}분</strong> 안에 응답하지 않으면 자동 반납됩니다.
                    </li>
                    <li>
                      <strong className="font-semibold">앉아 있는 좌석</strong>을 신고하면 허위 신고입니다. <span className="tabular">{String(settings?.false_report_limit ?? 3)}회</span> 확인되면{" "}
                      <span className="tabular">{String(settings?.false_report_ban_days ?? 7)}일간</span> 신고할 수 없고 벌점이 부여됩니다.
                    </li>
                  </ul>
                  <div className="mt-3">
                    <OccupancyMeter pct={ctx.occupancy} rules={ruleTexts(settings, "report")} ruleLabel="응답" />
                  </div>
                  <Button variant="primary" className="mt-3" busy={busy === "rep"} onClick={() => scan("rep", "report_seat", (m) => `신고를 접수했습니다. ${m}분 뒤 결과를 알림으로 알려 드립니다.`)}>
                    신고 접수
                  </Button>
                </div>
              )}
            </>
          )}
          {loggedIn && !ctx.is_mine && ctx.state === "away" && <Notice>외출 중인 좌석 · 시간이 지나면 자동 반납됩니다</Notice>}
          {/* 체크인 대기 중에 신고한 좌석이 반납됨: 정해진 시간 안에 이 좌석으로 바꿀지 고른다 */}
          {loggedIn && seat.is_active && ctx.priority_until && status?.reservation?.status === "reserved" && !ctx.is_mine && (
            <>
              <Notice>
                <strong className="font-semibold">좌석 바꾸기</strong> · <strong className="tabular">{fmtRemain(new Date(ctx.priority_until).getTime() - now)}</strong> 남음
              </Notice>
              <p className="text-sm text-[#3d4744]">
                <strong className="font-semibold">{status.reservation.seat_label}</strong> → <strong className="font-semibold">{seat.label}</strong> · 체크인 대기 {String(settings?.checkin_minutes ?? 15)}분
              </p>
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                busy={busy === "take"}
                onClick={() =>
                  plain("take", async () => {
                    const r = await rpc<{ from: string; to: string; minutes: number }>("take_priority_seat", { p_token: token });
                    return `${r.from}에서 ${r.to}(으)로 바꿨습니다. ${r.minutes}분 안에 좌석 QR을 찍어 주세요.`;
                  })
                }
              >
                {seat.label}(으)로 바꾸기
              </Button>
              <Link href="/me" className="flex min-h-11 items-center justify-center rounded-[var(--radius-ctl)] border border-line bg-surface text-sm font-semibold hover:bg-canvas">
                {status.reservation.seat_label} 그대로
              </Link>
            </>
          )}
          {/* 내가 신고해서 반납된 좌석: 정해진 시간 동안 나만 예약할 수 있다 */}
          {loggedIn && seat.is_active && ctx.priority_until && !ctx.have_other && (
            <>
              <Notice>
                <strong className="font-semibold">우선 예약</strong> · <strong className="tabular">{fmtRemain(new Date(ctx.priority_until).getTime() - now)}</strong> 남음
              </Notice>
              {ctx.is_open ? (
                <>
                  <fieldset>
                    <legend className="text-[13px] font-semibold">이용 시간</legend>
                    <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                      {Array.from({ length: maxHours }, (_, i) => i + 1).map((h) => (
                        <button
                          key={h}
                          type="button"
                          aria-pressed={(hours ?? maxHours) === h}
                          onClick={() => setHours(h)}
                          className={cx(
                            "flex min-h-11 items-center justify-center rounded-[var(--radius-ctl)] border text-sm font-semibold transition-colors duration-150",
                            (hours ?? maxHours) === h ? "border-du-deep bg-du-tint text-du-deep-dark" : "border-line hover:bg-canvas",
                          )}
                        >
                          {h}시간
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full"
                    busy={busy === "pri"}
                    onClick={() =>
                      plain("pri", async () => {
                        await rpc("reserve_seat", { p_seat: seat.id, p_minutes: (hours ?? maxHours) * 60 });
                        return `${seat.label} 좌석을 예약했습니다. ${settings?.checkin_minutes ?? 15}분 안에 좌석 QR을 찍어 주세요.`;
                      })
                    }
                  >
                    이 좌석 예약
                  </Button>
                </>
              ) : (
                <Notice tone="warn">{ctx.reason}</Notice>
              )}
            </>
          )}
          {loggedIn && !ctx.is_mine && ctx.state === "reserved" && !ctx.priority_until && (
            <Notice>체크인 대기 중인 좌석 · {settings?.checkin_minutes ?? 15}분 안에 오지 않으면 자동 취소됩니다</Notice>
          )}
        </div>
      </Panel>

      {rescan && (
        <QrScanner
          onToken={(t) => {
            setRescan(false);
            router.replace(`/s/${t}`);
          }}
          onClose={() => setRescan(false)}
          seat={wrong ? { label: wrong.seat_label, room: wrong.room_name } : undefined}
          deadline={wrong && wrongUntil ? { label: wrong.status === "reserved" ? "체크인 마감까지" : "복귀 마감까지", at: wrongUntil } : undefined}
        />
      )}

      <div className="flex gap-2">
        <Link href={isAdmin ? "/admin" : "/me"} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-ctl)] border border-line bg-surface text-sm font-semibold hover:bg-canvas">
          {isAdmin ? "관제" : "내 좌석"}
        </Link>
        {!isAdmin && (
          <Link href={`/rooms/${seat.room_id}`} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-ctl)] border border-line bg-surface text-sm font-semibold hover:bg-canvas">
            {seat.room_name} 좌석 보기
          </Link>
        )}
      </div>
    </div>
  );
}
