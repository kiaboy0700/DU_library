"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Empty, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
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
  res_status: string | null;
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
            {ov.reports.map((r) => {
              const left = new Date(r.respond_deadline).getTime() - now;
              return (
                <Panel key={r.id} className="p-4">
                  <div>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="flex flex-wrap items-center gap-2 text-base font-bold">
                          {r.room_name} {r.seat_label}
                          {fresh(r.created_at)}
                        </p>
                        <p className="text-sm text-[#3d4744]">
                          이용자 {r.owner_name} <span className="tabular text-muted">{r.owner_sid}</span> · 신고자 {r.reporter_name} <span className="tabular text-muted">{r.reporter_sid}</span>
                        </p>
                        <p className="tabular text-[13px] text-muted">
                          {fmtTime(r.created_at)} 접수 · 당시 이용률 {r.occupancy_pct}%
                        </p>
                      </div>
                      <Tag tone={left < 180_000 ? "danger" : "warn"}>
                        <span className="tabular">{left > 0 ? `자동 반납까지 ${fmtRemain(left)}` : "곧 자동 처리"}</span>
                      </Tag>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="danger" busy={busy === `rc${r.id}`} onClick={() => act(`rc${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "confirm" }), "반납 처리하고 벌점을 부여했습니다. 좌석은 빈자리가 되었습니다.")}>
                        비어 있음 확정
                      </Button>
                      <Button busy={busy === `rt${r.id}`} onClick={() => act(`rt${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "returned" }), "복귀를 확인했습니다. 이용자와 신고자 모두 불이익이 없습니다.")}>
                        돌아옴 (불이익 없음)
                      </Button>
                      <Button
                        busy={busy === `rd${r.id}`}
                        onClick={() => {
                          if (!window.confirm("신고 당시 이용자가 자리에 앉아 있었나요? 허위 신고로 기록되고, 누적되면 신고자에게 벌점이 부여됩니다.")) return;
                          act(`rd${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "dismiss" }), "허위 신고로 기록했습니다.");
                        }}
                      >
                        앉아 있었음 (허위 신고)
                      </Button>
                      <Button variant="quiet" busy={busy === `re${r.id}`} onClick={() => act(`re${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "extend" }), "응답 시간을 10분 늘렸습니다.")}>
                        10분 더 기다리기
                      </Button>
                    </div>
                  </div>
                </Panel>
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
            {ov.helps.map((h) => (
              <Panel key={h.id} className="p-4">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-base font-bold">
                    {h.reason}
                    {fresh(h.created_at)}
                  </p>
                  <p className="text-sm text-[#3d4744]">
                    {h.name} <span className="tabular text-muted">{h.student_id}</span>
                    {h.seat_label && ` · ${h.room_name} ${h.seat_label} (${h.res_status === "reserved" ? "체크인 대기" : h.res_status === "away" ? "외출" : h.res_status === "in_use" ? "이용 중" : "종료"})`}
                  </p>
                  {h.message && <p className="mt-1 rounded-md bg-canvas px-2.5 py-2 text-sm">{h.message}</p>}
                  <p className="tabular mt-1 text-[13px] text-muted">{fmtDateTime(h.created_at)} 접수</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {h.reservation_id && h.res_status === "reserved" && (
                      <Button
                        variant="primary"
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
                        대리 체크인하고 완료
                      </Button>
                    )}
                    <input
                      className={`${inputClass} !min-h-11 max-w-xs flex-1`}
                      aria-label="학생에게 보낼 답변"
                      placeholder="학생에게 보낼 답변 (선택)"
                      value={text[`h${h.id}`] ?? ""}
                      onChange={(e) => setText({ ...text, [`h${h.id}`]: e.target.value })}
                    />
                    <Button busy={busy === `hr${h.id}`} onClick={() => act(`hr${h.id}`, () => rpc("admin_resolve_help", { p_help: h.id, p_resolution: text[`h${h.id}`] || null }), "도움 요청을 완료 처리했습니다.")}>
                      완료
                    </Button>
                  </div>
                </div>
              </Panel>
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
            {ov.appeals.map((a) => (
              <Panel key={a.id} className="p-4">
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-bold">
                    {a.name} <span className="tabular font-normal text-muted">{a.student_id}</span>
                    {fresh(a.created_at)}
                  </p>
                  <p className="text-sm text-[#3d4744]">
                    대상 벌점: <span className="tabular">{a.points}점</span> · {a.note} <span className="tabular text-muted">({fmtDateTime(a.penalty_at)})</span>
                  </p>
                  <p className="mt-2 rounded-md bg-canvas px-2.5 py-2 text-sm">{a.message}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      className={`${inputClass} !min-h-11 max-w-sm flex-1`}
                      aria-label="학생에게 보낼 답변"
                      placeholder="답변 (반려할 때는 이유를 적어 주세요)"
                      value={text[`a${a.id}`] ?? ""}
                      onChange={(e) => setText({ ...text, [`a${a.id}`]: e.target.value })}
                    />
                    <Button variant="primary" busy={busy === `aa${a.id}`} onClick={() => act(`aa${a.id}`, () => rpc("admin_resolve_appeal", { p_appeal: a.id, p_approve: true, p_reply: text[`a${a.id}`] || null }), "이의신청을 승인하고 벌점을 취소했습니다.")}>
                      승인 (벌점 취소)
                    </Button>
                    <Button busy={busy === `ar${a.id}`} onClick={() => act(`ar${a.id}`, () => rpc("admin_resolve_appeal", { p_appeal: a.id, p_approve: false, p_reply: text[`a${a.id}`] || null }), "이의신청을 반려했습니다.")}>
                      반려
                    </Button>
                  </div>
                </div>
              </Panel>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
