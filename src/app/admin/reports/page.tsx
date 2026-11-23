"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Inbox, MapPin } from "lucide-react";
import { HelpChat } from "@/components/HelpChat";
import { useApp } from "@/components/Providers";
import { ActionRow, Button, Confirm, Empty, FoldPanel, GraceControl, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
import { rpc } from "@/lib/supabase";
import { fmtDateTime, fmtRemain, fmtTime } from "@/lib/util";

interface Report {
  id: number;
  created_at: string;
  respond_deadline: string;
  occupancy_pct: number;
  seat_label: string;
  room_name: string;
  owner_name: string;
  owner_sid: string;
  reporter_name: string;
  reporter_sid: string;
  end_at: string;
  checked_in_at: string | null;
  extend_count: number;
}
interface Help {
  id: number;
  created_at: string;
  reason: string;
  message: string | null;
  reservation_id: number | null;
  name: string;
  student_id: string;
  seat_label: string | null;
  room_name: string | null;
  room_id: number | null;
  seat_id: number | null;
  res_status: string | null;
  end_at: string | null;
  deadline: string | null;
}
interface Appeal {
  id: number;
  created_at: string;
  message: string;
  name: string;
  student_id: string;
  penalty_type: string;
  points: number;
  note: string | null;
  penalty_at: string;
}
interface Overview {
  reports: Report[];
  helps: Help[];
  appeals: Appeal[];
}

export default function AdminReports() {
  const { toast, pulse } = useApp();
  const now = useNow();
  const [ov, setOv] = useState<Overview | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  // 허위 신고로 기록하기 전에 한 번 묻는다
  const [falseId, setFalseId] = useState<number | null>(null);
  const { busy, run } = useAction((m) => toast(m, "error"));
  // 이 화면을 마지막으로 본 시각. 그 뒤에 들어온 건은 '새로 들어옴'으로 표시한다
  const [seenAt] = useState(() => {
    try {
      return Number(localStorage.getItem("du-admin-reports-seen") ?? 0);
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    const mark = () => {
      try {
        localStorage.setItem("du-admin-reports-seen", String(Date.now()));
      } catch {}
    };
    window.addEventListener("pagehide", mark);
    return () => {
      window.removeEventListener("pagehide", mark);
      mark();
    };
  }, []);
  const fresh = (iso: string) => new Date(iso).getTime() > seenAt && <Tag tone="danger">새로 들어옴</Tag>;

  const load = useCallback(() => rpc<Overview>("admin_overview").then(setOv).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load, pulse]);

  const act = (key: string, fn: () => Promise<unknown>, msg: string) =>
    run(key, async () => {
      await fn();
      toast(msg, "ok");
      await load();
    });

  if (!ov) return <Skeleton className="h-80 !rounded-[var(--radius-panel)]" />;
  const empty = ov.reports.length + ov.helps.length + ov.appeals.length === 0;

  return (
    <div className="space-y-6">
      <h1 className="text-[22px] font-bold">처리 대기</h1>
      {falseId !== null && (
        <Confirm
          title="허위 신고"
          confirmLabel="허위 신고로 기록"
          danger
          busy={busy === `rd${falseId}`}
          onClose={() => setFalseId(null)}
          onConfirm={() => act(`rd${falseId}`, () => rpc("admin_resolve_report", { p_report: falseId, p_decision: "dismiss" }), "허위 신고로 기록했습니다.").then(() => setFalseId(null))}
        >
          이용자가 자리에 앉아 있었던 신고로 기록합니다. 쌓이면 신고자에게 벌점이 붙습니다.
        </Confirm>
      )}

      {empty && (
        <Panel>
          <Empty icon={<Inbox size={36} strokeWidth={1.6} aria-hidden />} title="처리할 일이 없습니다" />
        </Panel>
      )}

      {ov.reports.length > 0 && (
        <section aria-labelledby="rep-h">
          <h2 id="rep-h" className="text-lg font-bold">
            자리비움 신고 <span className="tabular text-muted">{ov.reports.length}</span>
          </h2>
          <div className="mt-2 space-y-2">
            {ov.reports.map((r, i) => {
              const left = new Date(r.respond_deadline).getTime() - now;
              return (
                <FoldPanel
                  key={r.id}
                  defaultOpen={i === 0}
                  head={
                    <>
                      <span className="text-base font-bold">
                        {r.room_name} {r.seat_label}
                      </span>
                      {fresh(r.created_at)}
                      <Tag tone={left < 180_000 ? "danger" : "warn"}>
                        <span className="tabular">{left > 0 ? `자동 반납까지 ${fmtRemain(left)}` : "곧 자동 처리"}</span>
                      </Tag>
                    </>
                  }
                >
                  <div>
                    {/* 누가 쓰던 자리이고 누가 신고했는지 */}
                    <dl className="grid grid-cols-2 gap-2">
                      <div className="rounded-[var(--radius-ctl)] bg-canvas px-3 py-2">
                        <dt className="text-xs font-bold text-muted">이용자</dt>
                        <dd className="font-bold">{r.owner_name}</dd>
                        <dd className="tabular text-[13px] text-muted">{r.owner_sid}</dd>
                        <dd className="tabular mt-1.5 border-t border-line pt-1.5 text-[13px]">
                          {r.checked_in_at && <span className="block">{fmtTime(r.checked_in_at)} 체크인</span>}
                          <span className="block">
                            {r.end_at ? fmtTime(r.end_at) : "-"} 종료 · <b>{r.end_at ? fmtRemain(new Date(r.end_at).getTime() - now) : "-"}</b> 남음
                          </span>
                          <span className="block">연장 {r.extend_count}회</span>
                        </dd>
                      </div>
                      <div className="rounded-[var(--radius-ctl)] bg-warn-tint px-3 py-2">
                        <dt className="text-xs font-bold text-[#5c3d00]">신고자</dt>
                        <dd className="font-bold">{r.reporter_name}</dd>
                        <dd className="tabular text-[13px] text-[#5c3d00]">{r.reporter_sid}</dd>
                        <dd className="tabular mt-1.5 border-t border-warn/30 pt-1.5 text-[13px] text-[#5c3d00]">
                          <span className="block">{fmtTime(r.created_at)} 신고</span>
                          <span className="block">당시 이용률 {r.occupancy_pct}%</span>
                        </dd>
                      </div>
                    </dl>
                    <HelpChat kind="report" helpId={r.id} admin className="mt-3 max-w-xl" />
                    <ActionRow className="mt-3">
                      <Button variant="danger" busy={busy === `rc${r.id}`} onClick={() => act(`rc${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "confirm" }), "반납 처리하고 벌점을 부여했습니다.")}>
                        반납 확정
                      </Button>
                      <Button busy={busy === `rt${r.id}`} onClick={() => act(`rt${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "returned" }), "복귀를 확인했습니다. 벌점은 없습니다.")}>
                        돌아옴
                      </Button>
                      <Button busy={busy === `rd${r.id}`} onClick={() => setFalseId(r.id)}>
                        허위 신고
                      </Button>
                      <Button busy={busy === `re${r.id}`} onClick={() => act(`re${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "extend" }), "자동 반납을 10분 늦췄습니다.")}>
                        반납 10분 연장
                      </Button>
                    </ActionRow>
                  </div>
                </FoldPanel>
              );
            })}
          </div>
        </section>
      )}

      {ov.helps.length > 0 && (
        <section aria-labelledby="help-h">
          <h2 id="help-h" className="text-lg font-bold">
            도움 요청 <span className="tabular text-muted">{ov.helps.length}</span>
          </h2>
          <div className="mt-2 space-y-2">
            {ov.helps.map((h, i) => (
              <FoldPanel
                key={h.id}
                defaultOpen={i === 0}
                head={
                  <>
                    <span className="text-base font-bold">{h.reason}</span>
                    {fresh(h.created_at)}
                    <span className="text-sm text-muted">
                      {h.name}
                      {h.seat_label && ` · ${h.seat_label}`}
                    </span>
                  </>
                }
              >
                <div>
                  <p className="text-sm text-[#3d4744]">
                    {h.name} <span className="tabular text-muted">{h.student_id}</span>
                    {h.res_status && ` · ${h.res_status === "reserved" ? "체크인 대기" : h.res_status === "away" ? "외출" : h.res_status === "in_use" ? "이용 중" : "좌석 없음"}`}
                    {h.deadline && (h.res_status === "reserved" || h.res_status === "away") && (
                      <b className={new Date(h.deadline).getTime() - now < 3 * 60_000 ? "tabular ml-1.5 text-danger" : "tabular ml-1.5 text-du-deep-dark"}>{fmtRemain(new Date(h.deadline).getTime() - now)} 남음</b>
                    )}
                  </p>
                  {h.end_at && (h.res_status === "in_use" || h.res_status === "away") && (
                    <p className="tabular text-[13px] text-[#3d4744]">
                      {fmtTime(h.end_at)} 이용 종료 · <b>{fmtRemain(new Date(h.end_at).getTime() - now)}</b> 남음
                    </p>
                  )}
                  {/* 어느 좌석인지: 누르면 관제 지도에서 그 좌석을 바로 보여 준다 */}
                  <p className="mt-1.5">
                    {h.seat_id ? (
                      <Link href={`/admin?room=${h.room_id}&seat=${h.seat_id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-du-tint px-2.5 text-sm font-bold text-du-deep-dark hover:underline">
                        <MapPin size={15} aria-hidden />
                        {h.room_name} {h.seat_label}
                      </Link>
                    ) : (
                      <span className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-canvas px-2.5 text-sm text-muted">
                        <MapPin size={15} aria-hidden />
                        좌석 없음
                      </span>
                    )}
                  </p>
                  {h.message && <p className="mt-1 rounded-md bg-canvas px-2.5 py-2 text-sm">{h.message}</p>}
                  <p className="tabular mt-1 text-[13px] text-muted">{fmtDateTime(h.created_at)} 접수</p>
                  <HelpChat helpId={h.id} admin className="mt-3 max-w-xl" />
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {h.reservation_id && (h.res_status === "reserved" || h.res_status === "away") && (
                      <GraceControl
                        label={h.res_status === "reserved" ? "체크인 대기" : "외출 시간"}
                        busy={busy === `hg${h.id}`}
                        onGive={(m) => act(`hg${h.id}`, () => rpc("admin_res_action", { p_res: h.reservation_id, p_action: "grace", p_reason: h.reason, p_arg: m }), `${m}분 연장했습니다.`)}
                      />
                    )}
                    {h.reservation_id && h.res_status === "reserved" && (
                      <Button
                        busy={busy === `hc${h.id}`}
                        onClick={() =>
                          act(
                            `hc${h.id}`,
                            async () => {
                              await rpc("admin_res_action", { p_res: h.reservation_id, p_action: "check_in", p_reason: h.reason });
                              await rpc("admin_resolve_help", { p_help: h.id, p_resolution: "관리자가 체크인을 대신 처리했습니다." });
                            },
                            "체크인을 대신 처리했습니다.",
                          )
                        }
                      >
                        대리 체크인
                      </Button>
                    )}
                  </div>
                  {/* 요청 마무리: 대화 보내기와 헷갈리지 않게 따로 */}
                  <div className="mt-4 rounded-[var(--radius-ctl)] border border-line bg-[#f8faf9] p-3">
                    <p className="mb-2 text-[13px] font-bold">요청 마무리</p>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <input
                        className={inputClass}
                        aria-label="처리 결과"
                        placeholder="처리 결과 (선택)"
                        value={text[`h${h.id}`] ?? ""}
                        onChange={(e) => setText({ ...text, [`h${h.id}`]: e.target.value })}
                      />
                      <Button variant="primary" busy={busy === `hr${h.id}`} onClick={() => act(`hr${h.id}`, () => rpc("admin_resolve_help", { p_help: h.id, p_resolution: text[`h${h.id}`] || null }), "도움 요청을 완료 처리했습니다.")}>
                        완료 처리
                      </Button>
                    </div>
                  </div>
                </div>
              </FoldPanel>
            ))}
          </div>
        </section>
      )}

      {ov.appeals.length > 0 && (
        <section aria-labelledby="ap-h">
          <h2 id="ap-h" className="text-lg font-bold">
            벌점 이의신청 <span className="tabular text-muted">{ov.appeals.length}</span>
          </h2>
          <div className="mt-2 space-y-2">
            {ov.appeals.map((a, i) => (
              <FoldPanel
                key={a.id}
                defaultOpen={i === 0}
                head={
                  <>
                    <span className="font-bold">{a.name}</span>
                    <span className="tabular text-sm text-muted">{a.student_id}</span>
                    {fresh(a.created_at)}
                    <Tag>
                      <span className="tabular">벌점 {a.points}점</span>
                    </Tag>
                  </>
                }
              >
                <div>
                  <p className="text-sm text-[#3d4744]">
                    대상 벌점: <span className="tabular">{a.points}점</span> · {a.note} <span className="tabular text-muted">({fmtDateTime(a.penalty_at)})</span>
                  </p>
                  <p className="mt-2 rounded-md bg-canvas px-2.5 py-2 text-sm">{a.message}</p>
                  <div className="mt-3 grid gap-2">
                    <input
                      className={inputClass}
                      aria-label="학생에게 보낼 답변"
                      placeholder="답변"
                      value={text[`a${a.id}`] ?? ""}
                      onChange={(e) => setText({ ...text, [`a${a.id}`]: e.target.value })}
                    />
                    <ActionRow wide={2}>
                    <Button variant="primary" busy={busy === `aa${a.id}`} onClick={() => act(`aa${a.id}`, () => rpc("admin_resolve_appeal", { p_appeal: a.id, p_approve: true, p_reply: text[`a${a.id}`] || null }), "이의신청을 승인하고 벌점을 취소했습니다.")}>
                      승인
                    </Button>
                    <Button busy={busy === `ar${a.id}`} onClick={() => act(`ar${a.id}`, () => rpc("admin_resolve_appeal", { p_appeal: a.id, p_approve: false, p_reply: text[`a${a.id}`] || null }), "이의신청을 반려했습니다.")}>
                      반려
                    </Button>
                    </ActionRow>
                  </div>
                </div>
              </FoldPanel>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
