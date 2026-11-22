"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Armchair, Check, LifeBuoy, LogOut, MapPin, QrCode, ScanLine, TriangleAlert } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { useApp } from "@/components/Providers";
import { HelpChat } from "@/components/HelpChat";
import { QrScanner } from "@/components/QrScanner";
import { Button, Empty, Field, Notice, Panel, Skeleton, Tag, inputClass, useAction, useFold, useNow } from "@/components/ui";
import { ruleTexts, useSettings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { MODE_LABEL, SEAT_TYPE_LABEL, type Penalty, type SeatContext } from "@/lib/types";
import { cx, fmtDateTime, fmtRemain, fmtTime } from "@/lib/util";

const PENALTY_LABEL: Record<string, string> = { no_show: "예약 후 미체크인", away_timeout: "외출 시간 초과", vacancy_report: "자리비움", false_report: "허위 신고", manual: "관리자 부여" };
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
  const [open, setOpen] = useState<"away" | "return" | "help" | "scan" | "move" | null>(null);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const penFold = useFold(penalties, 2);
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [appealFor, setAppealFor] = useState<number | null>(null);
  const [appealText, setAppealText] = useState("");
  const [helpReason, setHelpReason] = useState(HELP_REASONS[0]);
  const [helpText, setHelpText] = useState("");
  // 도움 요청이 어느 좌석 이야기인지: 내 좌석 / QR로 찍은 좌석 / 번호로 적은 좌석 / 좌석과 무관
  const [helpAt, setHelpAt] = useState<"mine" | "qr" | "label" | "none" | null>(null);
  const [helpSeat, setHelpSeat] = useState<{ token: string; text: string } | null>(null);
  const [helpRoom, setHelpRoom] = useState<number | null>(null);
  const [helpLabel, setHelpLabel] = useState("");
  const [helpScan, setHelpScan] = useState(false);
  const [rooms, setRooms] = useState<{ id: number; name: string }[]>([]);
  const [myHelp, setMyHelp] = useState<{ id: number; reason: string; message: string | null; created_at: string; seat_label: string | null; room_name: string | null } | null>(null);
  const helpOpen = !!status?.help_open;
  useEffect(() => {
    supabase
      .from("rooms")
      .select("id,name")
      .order("floor")
      .then(({ data }) => setRooms(data ?? []));
  }, []);
  useEffect(() => {
    if (!helpOpen) return setMyHelp(null);
    rpc<typeof myHelp>("my_help")
      .then(setMyHelp)
      .catch(() => {});
  }, [helpOpen]);
  const uid = status?.profile.id;

  const load = useCallback(async () => {
    if (!uid) return;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const [p, a] = await Promise.all([
      supabase.from("penalties").select("id,type,points,note,created_at,revoked_at").eq("user_id", uid).gt("created_at", since).order("created_at", { ascending: false }),
      supabase.from("appeals").select("penalty_id,status,reply").eq("user_id", uid),
    ]);
    setPenalties((p.data as Penalty[]) ?? []);
    setAppeals((a.data as Appeal[]) ?? []);
  }, [uid]);

  useEffect(() => {
    load();
  }, [load, pulse]);
  useEffect(() => {
    if (status === null) router.replace("/login");
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

      {open === "scan" && (
        <QrScanner
          onToken={(t) => router.push(`/s/${t}`)}
          onClose={() => setOpen(null)}
          seat={res ? { label: res.seat_label, room: res.room_name } : undefined}
          deadline={
            res
              ? res.report_deadline
                ? { label: "자리 확인까지", at: res.report_deadline }
                : res.status === "reserved"
                  ? { label: "체크인 마감까지", at: res.checkin_deadline }
                  : res.status === "away" && res.away_deadline
                    ? { label: "복귀 마감까지", at: res.away_deadline }
                    : { label: "남은 이용 시간", at: res.end_at }
              : undefined
          }
        />
      )}

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
            {res.on_hold && <p className="mb-3 rounded-[var(--radius-ctl)] bg-warn-tint px-3 py-2 text-sm font-semibold text-[#5c3d00]">도움 요청 접수됨 · 처리될 때까지 자동 취소·반납·벌점이 멈춥니다</p>}
            {res.status === "reserved" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="primary" onClick={() => setOpen("scan")}>
                    <QrCode size={16} aria-hidden />
                    QR 체크인
                  </Button>
                  <Button busy={busy === "cancel"} onClick={() => act("cancel", async () => { await rpc("return_seat"); toast("예약을 취소했습니다.", "ok"); })}>
                    예약 취소
                  </Button>
                </div>
                <Button
                  className="mt-2 w-full"
                  disabled={status.help_open}
                  onClick={() => {
                    setOpen("help");
                    document.getElementById("help-h")?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                >
                  <LifeBuoy size={16} aria-hidden />
                  {status.help_open ? "도움 요청 접수됨" : "도움 요청"}
                </Button>
              </>
            )}

            {res.status === "in_use" && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                  <Button aria-expanded={open === "move"} onClick={() => setOpen(open === "move" ? null : "move")}>
                    자리 이동
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

            {open === "move" && res.status === "in_use" && (
              <div className="rise mt-3 rounded-[var(--radius-ctl)] border border-line bg-surface p-3.5">
                <p className="font-semibold">옮길 좌석의 QR을 찍으면 이동합니다</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="primary" onClick={() => setOpen("scan")}>
                    <QrCode size={16} aria-hidden />
                    바로 QR 찍기
                  </Button>
                  <Link
                    href={`/rooms/${res.room_id}`}
                    className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-ctl)] border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas"
                  >
                    좌석 먼저 고르기
                  </Link>
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
          <h2 id="pen-h" className="text-[17px] font-bold">
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
            <>
<ul className="divide-y divide-line border-t border-line">
              {penFold.shown.map((p) => {
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
            {penFold.toggle}
</>
          )}
        </Panel>
      </section>


      <section aria-labelledby="help-h">
        <h2 id="help-h" className="text-[17px] font-bold">
          도움 요청
        </h2>
        <Panel className="mt-2 p-4">
          {status.help_open ? (
            <>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-du-tint text-du-deep-dark">
                <LifeBuoy size={18} aria-hidden />
              </span>
              <div className="min-w-0 text-sm">
                <p className="text-base font-bold">관리자가 확인하고 있습니다</p>
                {myHelp && (
                  <>
                    <p className="mt-0.5 font-semibold">{myHelp.reason}</p>
                    {myHelp.seat_label && (
                      <p className="flex items-center gap-1 text-[#3d4744]">
                        <MapPin size={14} aria-hidden />
                        {myHelp.room_name} {myHelp.seat_label}
                      </p>
                    )}
                    {myHelp.message && <p className="mt-1 rounded-md bg-canvas px-2.5 py-2">{myHelp.message}</p>}
                    <p className="tabular mt-1 text-[13px] text-muted">{fmtDateTime(myHelp.created_at)} 접수</p>
                  </>
                )}
              </div>
            </div>
            {myHelp && <HelpChat helpId={myHelp.id} className="mt-3" />}
            </>
          ) : open === "help" ? (
            <form
              className="rise space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const at = helpAt ?? (res ? "mine" : "none");
                if (at === "qr" && !helpSeat) return toast("좌석 QR을 찍어 주세요.", "error");
                if (at === "label" && !helpLabel.trim()) return toast("좌석 번호를 입력해 주세요.", "error");
                act("help", async () => {
                  await rpc("request_help", {
                    p_reason: helpReason,
                    p_message: helpText || null,
                    p_token: at === "qr" ? helpSeat?.token : null,
                    p_room: at === "label" ? (helpRoom ?? rooms[0]?.id ?? null) : null,
                    p_label: at === "label" ? helpLabel : null,
                  });
                  toast("관리자에게 도움을 요청했습니다.", "ok");
                  setHelpText("");
                  setHelpSeat(null);
                  setHelpLabel("");
                  setHelpAt(null);
                });
              }}
            >
              <fieldset>
                <legend className="mb-1.5 text-[13px] font-semibold">문제</legend>
                <div className="grid grid-cols-2 gap-2">
                  {HELP_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={helpReason === r}
                      onClick={() => setHelpReason(r)}
                      className={cx(
                        "flex min-h-11 items-center justify-center rounded-[var(--radius-ctl)] border px-2 text-center text-sm font-semibold transition-colors duration-150",
                        helpReason === r ? "border-du-deep bg-du-tint text-du-deep-dark" : "border-line bg-surface hover:bg-canvas",
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1.5 text-[13px] font-semibold">좌석</legend>
                {(() => {
                  const at = helpAt ?? (res ? "mine" : "none");
                  const opts: { key: typeof at; label: React.ReactNode }[] = [
                    res ? { key: "mine", label: `내 좌석 ${res.seat_label}` } : { key: "none", label: "좌석 없음" },
                    {
                      key: "qr",
                      label: (
                        <>
                          <QrCode size={15} aria-hidden />
                          QR 찍기
                        </>
                      ),
                    },
                    { key: "label", label: "번호 입력" },
                  ];
                  return (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        {opts.map((o) => (
                          <button
                            key={o.key}
                            type="button"
                            aria-pressed={at === o.key}
                            onClick={() => {
                              setHelpAt(o.key);
                              if (o.key === "qr") setHelpScan(true);
                            }}
                            className={cx(
                              "flex min-h-11 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--radius-ctl)] border px-1.5 text-sm font-semibold transition-colors duration-150",
                              at === o.key ? "border-du-deep bg-du-tint text-du-deep-dark" : "border-line bg-surface hover:bg-canvas",
                            )}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                      {at === "qr" && helpSeat && (
                        <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-du-deep-dark">
                          <Check size={16} aria-hidden />
                          {helpSeat.text}
                        </p>
                      )}
                      {at === "label" && (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <select aria-label="열람실" className={inputClass} value={helpRoom ?? rooms[0]?.id ?? ""} onChange={(e) => setHelpRoom(Number(e.target.value))}>
                            {rooms.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                          <input aria-label="좌석 번호" className={inputClass} placeholder="예: N-024" autoCapitalize="characters" value={helpLabel} onChange={(e) => setHelpLabel(e.target.value)} />
                        </div>
                      )}
                    </>
                  );
                })()}
              </fieldset>

              <Field label="자세한 내용 (선택)">
                <textarea className={cx(inputClass, "py-2.5")} rows={2} maxLength={300} value={helpText} onChange={(e) => setHelpText(e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => setOpen(null)}>취소</Button>
                <Button type="submit" variant="primary" busy={busy === "help"}>
                  보내기
                </Button>
              </div>
            </form>
          ) : (
            <Button className="w-full sm:w-auto" onClick={() => setOpen("help")}>
              <LifeBuoy size={16} aria-hidden />
              도움 요청
            </Button>
          )}
          {helpScan && (
            <QrScanner
              onToken={async (t) => {
                setHelpScan(false);
                try {
                  const c = await rpc<SeatContext | null>("seat_context_v2", { p_token: t });
                  if (!c) throw new Error("유효하지 않은 QR입니다.");
                  setHelpSeat({ token: t, text: `${c.seat.room_name} ${c.seat.label}` });
                } catch (e) {
                  setHelpSeat(null);
                  toast(e instanceof Error ? e.message : "좌석을 확인하지 못했습니다.", "error");
                }
              }}
              onClose={() => setHelpScan(false)}
            />
          )}
        </Panel>
      </section>

      <section aria-labelledby="acct-h">
        <h2 id="acct-h" className="text-[17px] font-bold">
          계정
        </h2>
        <Panel className="mt-2 flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-semibold">{status.profile.name}</p>
            <p className="tabular truncate text-sm text-muted">
              {status.profile.student_id}
              {status.profile.department && ` · ${status.profile.department}`}
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
