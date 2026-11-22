"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Armchair, Bell, BellOff, LifeBuoy, LogOut, QrCode, ScanLine, TriangleAlert } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { useApp } from "@/components/Providers";
import { QrScanner } from "@/components/QrScanner";
import { Button, Empty, Field, Notice, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
import { ruleTexts, useSettings } from "@/lib/hooks";
import { disablePush, enablePush, pushEnabled } from "@/lib/push";
import { rpc, supabase } from "@/lib/supabase";
import { MODE_LABEL, SEAT_TYPE_LABEL, type Notice as NoticeRow, type Penalty } from "@/lib/types";
import { cx, fmtDateTime, fmtRemain, fmtTime } from "@/lib/util";

const PENALTY_LABEL: Record<string, string> = { no_show: "예약 후 미체크인", away_timeout: "외출 시간 초과", vacancy_report: "자리비움", manual: "관리자 부여" };
const HELP_REASONS = ["QR이 인식되지 않아요", "위치 확인이 안 돼요", "좌석에 문제가 있어요", "기타"];

interface Appeal {
  penalty_id: number;
  status: "open" | "approved" | "rejected";
  reply: string | null;
}

export default function MePage() {
  const router = useRouter();
  const { status, refresh, signOut, toast, pulse } = useApp();
  const { settings } = useSettings();
  const now = useNow();
  const { busy, run } = useAction((m) => toast(m, "error"));
  const [open, setOpen] = useState<"away" | "return" | "help" | "scan" | null>(null);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [appealFor, setAppealFor] = useState<number | null>(null);
  const [appealText, setAppealText] = useState("");
  const [helpReason, setHelpReason] = useState(HELP_REASONS[0]);
  const [helpText, setHelpText] = useState("");
  const [push, setPush] = useState<boolean | null>(null);
  const uid = status?.profile.id;

  const load = useCallback(async () => {
    if (!uid) return;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const [p, a, n] = await Promise.all([
      supabase.from("penalties").select("id,type,points,note,created_at,revoked_at").eq("user_id", uid).gt("created_at", since).order("created_at", { ascending: false }),
      supabase.from("appeals").select("penalty_id,status,reply").eq("user_id", uid),
      supabase.from("notifications").select("id,title,body,url,created_at,read_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(12),
    ]);
    setPenalties((p.data as Penalty[]) ?? []);
    setAppeals((a.data as Appeal[]) ?? []);
    setNotices((n.data as NoticeRow[]) ?? []);
    // 화면에 보인 알림은 읽음 처리
    if (n.data?.some((x) => !x.read_at)) {
      await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", uid).is("read_at", null);
    }
  }, [uid]);

  useEffect(() => {
    load();
  }, [load, pulse]);
  useEffect(() => {
    pushEnabled().then(setPush);
  }, []);
  useEffect(() => {
    if (status === null) router.replace("/login?next=/me");
  }, [status, router]);

  if (!status)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 !rounded-[var(--radius-panel)]" />
      </div>
    );

  const res = status.reservation;
  const banned = status.profile.banned_until && new Date(status.profile.banned_until).getTime() > now;
  const act = (key: string, fn: () => Promise<void>) =>
    run(key, async () => {
      await fn();
      await refresh();
      setOpen(null);
    });

  const endMs = res ? new Date(res.end_at).getTime() - now : 0;
  const canExtend = !!res && res.status === "in_use" && endMs <= res.extend_window_min * 60_000;
  const extendsLeft = res && res.max_extends != null ? res.max_extends - res.extend_count : null;
  const target = res ? (res.status === "reserved" ? res.checkin_deadline : res.status === "away" && res.away_deadline ? res.away_deadline : res.end_at) : null;
  const remain = target ? new Date(target).getTime() - now : 0;
  const urgent = !!res && (res.status !== "in_use" ? remain < 5 * 60_000 : remain < 10 * 60_000);

  return (
    <div className="space-y-5">
      <h1 className="text-[22px] font-bold">내 좌석</h1>

      {res?.report_deadline && (
        <Notice tone="danger" icon={<TriangleAlert size={18} aria-hidden />}>
          <p className="font-bold">자리 확인 요청이 왔습니다</p>
          <p className="mt-0.5">
            <strong className="tabular">{fmtRemain(new Date(res.report_deadline).getTime() - now)}</strong> 안에 좌석 QR을 스캔하지 않으면 자동 반납되고 벌점이 부여됩니다.
          </p>
          <Button variant="danger" size="sm" className="mt-2.5" onClick={() => setOpen("scan")}>
            <ScanLine size={16} aria-hidden />
            지금 QR 스캔하기
          </Button>
        </Notice>
      )}

      {open === "scan" && <QrScanner onToken={(t) => router.push(`/s/${t}`)} onClose={() => setOpen(null)} />}

      {res ? (
        <Panel className="overflow-hidden">
          <div className="p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-muted">
                  {res.room_name} · {SEAT_TYPE_LABEL[res.seat_type]}
                </p>
                <p className="text-[32px] font-bold leading-tight tracking-tight">{res.seat_label}</p>
              </div>
              <Tag tone={res.status === "in_use" ? "deep" : "warn"}>{res.status === "reserved" ? "체크인 대기" : res.status === "away" ? "외출 중" : "이용 중"}</Tag>
            </div>

            <div className="mt-4" aria-live="off">
              <p className="text-sm text-muted">{res.status === "reserved" ? "체크인 마감까지" : res.status === "away" ? "복귀 마감까지" : "남은 이용 시간"}</p>
              <p className={cx("tabular text-[44px] font-bold leading-none tracking-tight", urgent && "text-danger")}>{fmtRemain(remain)}</p>
            </div>

            <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-sm">
              <div>
                <dt className="text-xs text-muted">시작</dt>
                <dd className="tabular font-semibold">{fmtTime(res.start_at)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">종료</dt>
                <dd className="tabular font-semibold">{fmtTime(res.end_at)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">연장</dt>
                <dd className="tabular font-semibold">{res.max_extends != null ? `${res.extend_count} / ${res.max_extends}회` : `${res.extend_count}회 (제한 없음)`}</dd>
              </div>
            </dl>
          </div>

          <div className="border-t border-line bg-[#f8faf9] p-4 sm:p-5">
            {res.status === "reserved" && (
              <>
                {res.on_hold && <p className="mb-3 text-sm font-semibold text-warn">도움 요청 접수됨 · 자동 취소가 멈춰 있습니다</p>}
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="primary" onClick={() => setOpen("scan")}>
                    <QrCode size={16} aria-hidden />
                    QR 체크인
                  </Button>
                  <Button busy={busy === "cancel"} onClick={() => act("cancel", async () => { await rpc("return_seat"); toast("예약을 취소했습니다.", "ok"); })}>
                    예약 취소
                  </Button>
                </div>
              </>
            )}

            {res.status === "in_use" && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Button aria-expanded={open === "away"} onClick={() => setOpen(open === "away" ? null : "away")}>
                    외출
                  </Button>
                  <Button
                    busy={busy === "extend"}
                    disabled={!canExtend || extendsLeft === 0}
                    onClick={() =>
                      res.mode === "exam"
                        ? setOpen("scan")
                        : act("extend", async () => {
                            const end = await rpc<string>("extend_reservation");
                            toast(`${fmtTime(end)}까지 연장했습니다.`, "ok");
                          })
                    }
                  >
                    연장
                  </Button>
                  <Button variant="danger" aria-expanded={open === "return"} onClick={() => setOpen(open === "return" ? null : "return")}>
                    반납
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {extendsLeft === 0
                    ? "연장 횟수를 모두 사용했습니다"
                    : canExtend
                      ? res.mode === "exam"
                        ? "연장은 좌석 QR 스캔으로"
                        : ""
                      : `연장은 ${fmtTime(new Date(new Date(res.end_at).getTime() - res.extend_window_min * 60_000).toISOString())}부터`}
                </p>
              </>
            )}

            {res.status === "away" && (
              <>
                <p className="text-sm text-[#3d4744]">시간이 지나면 자동 반납 · 벌점 {settings?.pen_away ?? 1}점</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="primary" onClick={() => setOpen("scan")}>
                    <QrCode size={16} aria-hidden />
                    QR 스캔해 복귀
                  </Button>
                  <Button variant="danger" aria-expanded={open === "return"} onClick={() => setOpen(open === "return" ? null : "return")}>
                    반납
                  </Button>
                </div>
              </>
            )}

            {open === "away" && res.status === "in_use" && (
              <div className="rise mt-3 rounded-[var(--radius-ctl)] border border-line bg-surface p-3.5">
                <p className="font-semibold">
                  지금 외출하면 <span className="tabular text-du-deep-dark">{res.away_minutes}분</span> 안에 돌아와야 합니다
                </p>
                <p className="mt-0.5 text-sm text-muted">화장실처럼 잠깐 다녀올 때는 외출하지 않아도 됩니다.</p>
                <div className="mt-3">
                  <OccupancyMeter pct={res.occupancy} rules={ruleTexts(settings, "away")} />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" busy={busy === "away"} onClick={() => act("away", async () => { const m = await rpc<number>("go_away"); toast(`외출 처리했습니다. ${m}분 안에 돌아와 QR을 스캔하세요.`, "ok"); })}>
                    외출 시작
                  </Button>
                  <Button onClick={() => setOpen(null)}>닫기</Button>
                </div>
              </div>
            )}

            {open === "return" && (
              <div className="rise mt-3 rounded-[var(--radius-ctl)] border border-line bg-surface p-3.5">
                <p className="font-semibold">{res.seat_label} 좌석을 반납할까요?</p>
                <div className="mt-3 flex gap-2">
                  <Button variant="danger" busy={busy === "return"} onClick={() => act("return", async () => { await rpc("return_seat"); toast("좌석을 반납했습니다. 이용해 주셔서 감사합니다.", "ok"); })}>
                    반납하기
                  </Button>
                  <Button onClick={() => setOpen(null)}>계속 이용</Button>
                </div>
              </div>
            )}
          </div>
        </Panel>
      ) : (
        <Panel>
          <Empty icon={<Armchair size={36} strokeWidth={1.6} aria-hidden />} title="이용 중인 좌석이 없습니다">
            {banned ? (
              <>{fmtDateTime(status.profile.banned_until!)}까지 예약 정지</>
            ) : (
              <>
                <Link href="/" className="mt-2 flex min-h-11 items-center justify-center rounded-[var(--radius-ctl)] bg-du-deep px-5 text-sm font-semibold text-white hover:bg-du-deep-dark">
                  좌석 고르기
                </Link>
              </>
            )}
          </Empty>
        </Panel>
      )}

      <section aria-labelledby="pen-h">
        <div className="flex items-baseline justify-between">
          <h2 id="pen-h" className="text-base font-bold">
            벌점
          </h2>
          <p className="text-sm text-muted">최근 {settings?.penalty_window_days ?? 30}일 누적</p>
        </div>
        <Panel className="mt-2">
          <div className="flex items-center gap-4 p-4">
            <p className={cx("tabular shrink-0 whitespace-nowrap text-[32px] font-bold leading-none", status.points >= Number(settings?.ban1_points ?? 3) && "text-danger")}>
              {status.points}
              <span className="ml-0.5 text-base font-semibold text-muted">점</span>
            </p>
            <p className="min-w-0 text-sm text-[#3d4744]">
              {banned ? (
                <strong className="font-semibold text-danger">{fmtDateTime(status.profile.banned_until!)}까지 예약 정지</strong>
              ) : (
                <span className="tabular text-muted">
                  {settings?.ban1_points ?? 3}점부터 {settings?.ban1_days ?? 3}일, {settings?.ban2_points ?? 6}점부터 {settings?.ban2_days ?? 14}일 예약 정지
                </span>
              )}
            </p>
          </div>
          {penalties.length > 0 && (
            <ul className="divide-y divide-line border-t border-line">
              {penalties.map((p) => {
                const ap = appeals.find((a) => a.penalty_id === p.id);
                return (
                  <li key={p.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={cx("font-semibold", p.revoked_at && "text-muted line-through")}>
                          {PENALTY_LABEL[p.type] ?? p.type} <span className="tabular">{p.points}점</span>
                        </p>
                        <p className="text-[13px] text-muted">
                          {fmtDateTime(p.created_at)} · {p.note}
                        </p>
                        {p.revoked_at && <p className="text-[13px] font-semibold text-du-deep-dark">취소된 벌점입니다.</p>}
                        {ap && !p.revoked_at && (
                          <p className="mt-1 text-[13px]">
                            {ap.status === "open" ? "이의신청을 검토하고 있습니다." : `이의신청이 반려되었습니다${ap.reply ? `: ${ap.reply}` : "."}`}
                          </p>
                        )}
                      </div>
                      {!p.revoked_at && !ap && (
                        <Button size="sm" variant="quiet" aria-expanded={appealFor === p.id} onClick={() => { setAppealFor(appealFor === p.id ? null : p.id); setAppealText(""); }}>
                          이의신청
                        </Button>
                      )}
                    </div>
                    {appealFor === p.id && (
                      <form
                        className="rise mt-3"
                        onSubmit={(e) => {
                          e.preventDefault();
                          run("appeal", async () => {
                            await rpc("submit_appeal", { p_penalty: p.id, p_message: appealText });
                            toast("이의신청을 접수했습니다. 결과는 알림으로 알려 드립니다.", "ok");
                            setAppealFor(null);
                            load();
                          });
                        }}
                      >
                        <Field label="사유">
                          <textarea className={cx(inputClass, "py-2.5")} rows={3} maxLength={500} value={appealText} onChange={(e) => setAppealText(e.target.value)} required />
                        </Field>
                        <div className="mt-2 flex gap-2">
                          <Button type="submit" variant="primary" size="sm" busy={busy === "appeal"}>
                            신청하기
                          </Button>
                          <Button size="sm" onClick={() => setAppealFor(null)}>
                            취소
                          </Button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </section>

      <section aria-labelledby="noti-h">
        <div className="flex items-center justify-between gap-3">
          <h2 id="noti-h" className="text-base font-bold">
            알림
          </h2>
          {push !== null && (
            <Button
              size="sm"
              busy={busy === "push"}
              aria-pressed={push}
              onClick={() =>
                run("push", async () => {
                  if (push) {
                    await disablePush();
                    setPush(false);
                    toast("이 기기의 푸시 알림을 껐습니다.");
                  } else {
                    await enablePush(status.profile.id);
                    setPush(true);
                    toast("푸시 알림을 켰습니다. 종료 10분 전과 자리 확인 요청을 알려 드립니다.", "ok");
                  }
                })
              }
            >
              {push ? <Bell size={15} aria-hidden /> : <BellOff size={15} aria-hidden />}
              {push ? "푸시 켜짐" : "푸시 알림 켜기"}
            </Button>
          )}
        </div>
        <Panel className="mt-2">
          {notices.length === 0 ? (
            <Empty title="알림이 없습니다" />
          ) : (
            <ul className="divide-y divide-line">
              {notices.map((n) => (
                <li key={n.id} className="flex gap-3 px-4 py-3">
                  <span aria-hidden className={cx("mt-2 size-1.5 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-du-deep")} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {!n.read_at && <span className="sr-only">새 알림: </span>}
                      {n.title}
                    </p>
                    <p className="text-sm text-[#3d4744]">{n.body}</p>
                    <p className="tabular mt-0.5 text-xs text-muted">{fmtDateTime(n.created_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      <section aria-labelledby="help-h">
        <h2 id="help-h" className="text-base font-bold">
          도움 요청
        </h2>
        <Panel className="mt-2 p-4">
          {status.help_open ? (
            <p className="flex items-start gap-2 text-sm">
              <LifeBuoy size={18} className="mt-0.5 shrink-0 text-du-deep" aria-hidden />
              관리자가 확인하고 있습니다. 처리될 때까지 예약은 자동 취소되지 않습니다.
            </p>
          ) : open === "help" ? (
            <form
              className="rise space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                act("help", async () => {
                  await rpc("request_help", { p_reason: helpReason, p_message: helpText || null });
                  toast("관리자에게 도움을 요청했습니다.", "ok");
                  setHelpText("");
                });
              }}
            >
              <Field label="어떤 문제가 있나요?">
                <select className={inputClass} value={helpReason} onChange={(e) => setHelpReason(e.target.value)}>
                  {HELP_REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
              <Field label="자세한 내용 (선택)">
                <textarea className={cx(inputClass, "py-2.5")} rows={2} maxLength={300} value={helpText} onChange={(e) => setHelpText(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" busy={busy === "help"}>
                  도움 요청 보내기
                </Button>
                <Button onClick={() => setOpen(null)}>취소</Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 basis-40 text-sm text-[#3d4744]">QR·휴대폰 문제는 관리자가 대신 처리합니다.</p>
              <Button onClick={() => setOpen("help")}>
                <LifeBuoy size={16} aria-hidden />
                도움 요청
              </Button>
            </div>
          )}
        </Panel>
      </section>

      <section aria-labelledby="acct-h">
        <h2 id="acct-h" className="text-base font-bold">
          계정
        </h2>
        <Panel className="mt-2 flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-semibold">{status.profile.name}</p>
            <p className="tabular truncate text-sm text-muted">
              {status.profile.student_id}
              {status.profile.department && ` · ${status.profile.department}`}
              {status.profile.grade && ` ${status.profile.grade}학년`}
              {res && ` · ${MODE_LABEL[res.mode]}`}
            </p>
          </div>
          <Button
            onClick={async () => {
              await signOut();
              router.replace("/login");
            }}
          >
            <LogOut size={16} aria-hidden />
            로그아웃
          </Button>
        </Panel>
      </section>
    </div>
  );
}
