"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleSlash, MapPin, QrCode } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { useApp } from "@/components/Providers";
import { Button, Empty, Notice, Panel, Skeleton, Tag, useAction, useNow } from "@/components/ui";
import { ruleTexts, useSettings } from "@/lib/hooks";
import { rpc } from "@/lib/supabase";
import { SEAT_TYPE_LABEL, STATE_LABEL, type SeatContext } from "@/lib/types";
import { fmtRemain, fmtTime, getPosition } from "@/lib/util";

/** 좌석 QR을 스캔하면 열리는 화면. 상황에 맞는 동작 하나를 가장 크게 보여 준다 */
export default function SeatQrPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { status, refresh, toast, pulse } = useApp();
  const { settings } = useSettings();
  const now = useNow();
  const [ctx, setCtx] = useState<SeatContext | null | undefined>(undefined);
  const [done, setDone] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"report" | "return" | "away" | null>(null);
  const { busy, run } = useAction((m) => toast(m, "error"));

  const load = useCallback(async () => {
    try {
      setCtx(await rpc<SeatContext | null>("seat_context", { p_token: token }));
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

  if (ctx === undefined) return <Skeleton className="h-72 !rounded-[var(--radius-panel)]" />;
  if (ctx === null)
    return (
      <Panel>
        <Empty icon={<CircleSlash size={36} strokeWidth={1.6} aria-hidden />} title="사용할 수 없는 QR입니다">
          QR이 교체되었거나 주소가 잘못되었습니다. 책상의 QR을 다시 스캔하거나 안내 데스크에 알려 주세요.
          <Link href="/" className="mt-3 block font-semibold text-du-deep-dark underline underline-offset-4">
            홈으로 가기
          </Link>
        </Empty>
      </Panel>
    );

  const { seat } = ctx;
  const r = ctx.my_reservation;
  const loggedIn = !!status;
  const endLeft = r ? new Date(r.end_at).getTime() - now : 0;
  const canExtend = !!r && r.status === "in_use" && endLeft <= ctx.extend_window_min * 60_000;

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
            도서관 안에 있는지 확인하기 위해 위치 권한을 요청합니다.
          </p>
        )}

        <div className="mt-4 space-y-2.5">
          {!loggedIn && (
            <>
              <p className="text-sm text-[#3d4744]">이 좌석을 이용하려면 먼저 로그인해 주세요.</p>
              <Button variant="primary" size="lg" className="w-full" onClick={() => router.push(`/login?next=/s/${token}`)}>
                로그인
              </Button>
            </>
          )}

          {loggedIn && !seat.is_active && <Notice tone="warn">지금은 사용이 중지된 좌석입니다. 다른 좌석을 이용해 주세요.</Notice>}

          {/* 빈 좌석: 바로 예약 + 체크인 */}
          {loggedIn && seat.is_active && ctx.state === "free" && !ctx.have_other && (
            <>
              {ctx.is_open ? (
                <>
                  <p className="text-sm text-[#3d4744]">비어 있는 좌석입니다. 지금 앉아서 바로 이용을 시작할 수 있습니다.</p>
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full"
                    busy={busy === "sit"}
                    onClick={() =>
                      run("sit", async () => {
                        await rpc("reserve_seat", { p_seat: seat.id });
                        const pos = ctx.gps_required ? await getPosition() : null;
                        await rpc("check_in", { p_token: token, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
                        setDone(`${seat.label} 좌석 이용을 시작했습니다.`);
                        await Promise.all([refresh(), load()]);
                      })
                    }
                  >
                    이 좌석 이용 시작하기
                  </Button>
                </>
              ) : (
                <Notice tone="warn">지금은 예약할 수 없습니다. {ctx.reason}</Notice>
              )}
            </>
          )}
          {loggedIn && ctx.state === "free" && ctx.have_other && (
            <Notice tone="warn">
              이미 다른 좌석({status?.reservation?.seat_label})을 이용 중입니다.{" "}
              <Link href="/me" className="font-semibold underline underline-offset-2">
                내 좌석
              </Link>
              에서 먼저 반납해 주세요.
            </Notice>
          )}

          {/* 내 좌석 */}
          {ctx.is_mine && r?.status === "reserved" && (
            <>
              <p className="text-sm text-[#3d4744]">
                체크인 마감까지 <strong className="tabular">{fmtRemain(new Date(r.checkin_deadline).getTime() - now)}</strong> 남았습니다.
              </p>
              <Button variant="primary" size="lg" className="w-full" busy={busy === "in"} onClick={() => scan("in", "check_in", () => "체크인했습니다. 열공하세요!")}>
                체크인
              </Button>
            </>
          )}

          {ctx.is_mine && r?.status === "away" && (
            <>
              <p className="text-sm text-[#3d4744]">
                외출 중입니다. 복귀 마감까지 <strong className="tabular">{r.away_deadline ? fmtRemain(new Date(r.away_deadline).getTime() - now) : "-"}</strong> 남았습니다.
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
                    자리가 비어 있다는 신고가 접수되었습니다.{" "}
                    {ctx.report_deadline && (
                      <>
                        <strong className="tabular">{fmtRemain(new Date(ctx.report_deadline).getTime() - now)}</strong> 안에 확인해 주세요.
                      </>
                    )}
                  </Notice>
                  <Button variant="primary" size="lg" className="w-full" busy={busy === "here"} onClick={() => scan("here", "confirm_presence", () => "자리에 있음을 확인했습니다. 벌점은 없습니다.")}>
                    자리에 있어요
                  </Button>
                </>
              ) : (
                <p className="text-sm text-[#3d4744]">
                  <strong className="tabular">{fmtTime(r.end_at)}</strong>까지 이용할 수 있습니다. 남은 시간 <span className="tabular">{fmtRemain(endLeft)}</span>
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
              {!canExtend && <p className="text-xs text-muted">연장은 종료 {ctx.extend_window_min}분 전부터 할 수 있습니다.</p>}
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
              <p className="mt-0.5 text-sm text-muted">이용률 {ctx.occupancy}% 기준입니다. 돌아와서 이 QR을 다시 스캔하세요.</p>
              <div className="mt-3">
                <OccupancyMeter pct={ctx.occupancy} rules={ruleTexts(settings, "away")} compact />
              </div>
              <Button variant="primary" className="mt-3" busy={busy === "away"} onClick={() => plain("away", async () => `외출 처리했습니다. ${await rpc<number>("go_away")}분 안에 돌아오세요.`)}>
                외출 시작
              </Button>
            </div>
          )}
          {confirm === "return" && (
            <div className="rise rounded-[var(--radius-ctl)] border border-line p-3.5">
              <p className="font-semibold">{seat.label} 좌석을 반납할까요?</p>
              <p className="mt-0.5 text-sm text-muted">반납하면 바로 다른 학생이 예약할 수 있습니다.</p>
              <Button variant="danger" className="mt-3" busy={busy === "ret"} onClick={() => plain("ret", async () => { await rpc("return_seat"); return "좌석을 반납했습니다."; })}>
                반납하기
              </Button>
            </div>
          )}

          {/* 다른 사람의 좌석 */}
          {loggedIn && !ctx.is_mine && ctx.state === "in_use" && (
            <>
              <p className="text-sm text-[#3d4744]">다른 학생이 이용 중인 좌석입니다. 짐만 있고 오랫동안 비어 있다면 신고할 수 있습니다.</p>
              <Button aria-expanded={confirm === "report"} className="w-full" onClick={() => setConfirm(confirm === "report" ? null : "report")}>
                자리가 비어 있어요
              </Button>
              {confirm === "report" && (
                <div className="rise rounded-[var(--radius-ctl)] border border-line p-3.5">
                  <p className="font-semibold">자리비움을 신고할까요?</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-[#3d4744]">
                    <li>
                      이용자에게 확인 요청이 가고, <strong className="tabular">{ctx.report_minutes}분</strong> 안에 QR을 스캔하지 않으면 좌석이 자동 반납됩니다.
                    </li>
                    <li>화장실처럼 잠깐 비운 자리일 수 있으니, 한동안 비어 있었는지 확인해 주세요.</li>
                    <li>신고자가 누구인지는 이용자에게 알려지지 않습니다.</li>
                  </ul>
                  <div className="mt-3">
                    <OccupancyMeter pct={ctx.occupancy} rules={ruleTexts(settings, "report")} ruleLabel="응답 시간" compact />
                  </div>
                  <Button variant="primary" className="mt-3" busy={busy === "rep"} onClick={() => scan("rep", "report_seat", (m) => `신고를 접수했습니다. ${m}분 뒤 결과를 알림으로 알려 드립니다.`)}>
                    신고 접수
                  </Button>
                </div>
              )}
            </>
          )}
          {loggedIn && !ctx.is_mine && ctx.state === "away" && <Notice>이용자가 외출 처리한 좌석입니다. 외출 시간이 지나면 자동으로 반납됩니다.</Notice>}
          {loggedIn && !ctx.is_mine && ctx.state === "reserved" && (
            <Notice>예약된 좌석이며 체크인을 기다리고 있습니다. {settings?.checkin_minutes ?? 15}분 안에 오지 않으면 자동으로 취소됩니다.</Notice>
          )}
        </div>
      </Panel>

      <div className="flex gap-2">
        <Link href="/me" className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-ctl)] border border-line bg-surface text-sm font-semibold hover:bg-canvas">
          내 좌석
        </Link>
        <Link href={`/rooms/${seat.room_id}`} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-ctl)] border border-line bg-surface text-sm font-semibold hover:bg-canvas">
          {seat.room_name} 좌석 보기
        </Link>
      </div>
    </div>
  );
}
