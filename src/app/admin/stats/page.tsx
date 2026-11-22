"use client";

import { useEffect, useState } from "react";
import { Panel, Skeleton } from "@/components/ui";
import { rpc } from "@/lib/supabase";
import { cx, fmtDate, fmtDateTime } from "@/lib/util";

interface Stats {
  daily: { day: string; reservations: number; no_shows: number; auto_returns: number; reports: number; penalty_points: number }[];
  totals: { users: number; banned: number; avg_minutes: number; recovered: number };
  actions: { id: number; created_at: string; action: string; reason: string | null; actor: string | null; target: string | null; target_sid: string | null }[];
}

const ACTION: Record<string, string> = {
  reserve: "대리 배정",
  "res:check_in": "대리 체크인",
  "res:come_back": "대리 복귀",
  "res:away": "외출 처리",
  "res:extend": "이용 시간 연장",
  "res:grace": "마감 늘려 줌",
  "res:return": "강제 반납",
  "res:move": "좌석 이동",
  "report:confirm": "신고 확정",
  "report:dismiss": "허위 신고로 판정",
  "report:returned": "신고 종결(복귀 확인)",
  "report:extend": "신고 응답 시간 연장",
  "appeal:approve": "이의신청 승인",
  "appeal:reject": "이의신청 반려",
  "help:resolve": "도움 요청 완료",
  revoke_penalty: "벌점 취소",
  unban: "정지 해제",
  report_unban: "신고 정지 해제",
  "seats:on": "좌석 다시 열기",
  "seats:off": "좌석 사용 중지",
  "room:close": "열람실 임시 폐쇄",
  "room:open": "열람실 다시 열기",
  regen_qr: "QR 재발급",
  announce: "공지 등록",
  demo_fill: "시연용 채우기",
  create_account: "계정 생성",
  reset_password: "비밀번호 초기화",
  settings: "설정 변경",
};
const actionName = (a: string) => ACTION[a] ?? (a.startsWith("penalty:") ? `벌점 ${a.slice(8)}점 부여` : a.startsWith("ban:") ? `${a.slice(4)}일 예약 정지` : a.startsWith("set_role:") ? "권한 변경" : a);

export default function AdminStats() {
  const [days, setDays] = useState(14);
  const [s, setS] = useState<Stats | null>(null);

  useEffect(() => {
    setS(null);
    rpc<Stats>("admin_stats", { p_days: days }).then(setS).catch(() => {});
  }, [days]);

  const max = Math.max(1, ...(s?.daily.map((d) => d.reservations) ?? [1]));
  const sum = (k: "reservations" | "no_shows" | "auto_returns" | "reports") => s?.daily.reduce((a, d) => a + d[k], 0) ?? 0;
  const noShowRate = s && sum("reservations") > 0 ? Math.round((100 * sum("no_shows")) / sum("reservations")) : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[22px] font-bold">통계·기록</h1>
        <div role="group" aria-label="기간" className="flex gap-1.5">
          {[7, 14, 30].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className={cx("min-h-9 rounded-full border px-3 text-[13px] font-semibold", days === d ? "border-du-deep bg-du-deep text-white" : "border-line bg-surface hover:bg-canvas")}>
              최근 {d}일
            </button>
          ))}
        </div>
      </div>

      {!s ? (
        <Skeleton className="h-96 !rounded-[var(--radius-panel)]" />
      ) : (
        <>
          <Panel className="p-4 sm:p-5">
            <h2 className="text-[17px] font-bold">되찾은 자리</h2>
            <p className="tabular mt-1 text-[15px] text-[#3d4744]">
              <strong className="text-2xl font-bold text-du-deep-dark">{s.totals.recovered}석</strong> 자동 회수 · 노쇼 {noShowRate}% · 평균 이용 {s.totals.avg_minutes}분
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 text-sm sm:grid-cols-4">
              {[
                ["등록 학생", `${s.totals.users}명`],
                ["예약 정지 중", `${s.totals.banned}명`],
                ["자리비움 신고", `${sum("reports")}건`],
                ["자동 회수", `${sum("auto_returns") + sum("no_shows")}건`],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="tabular text-lg font-bold">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel>
            <h2 className="px-4 pt-4 text-[17px] font-bold sm:px-5">일별 현황</h2>
            <div className="mt-2 overflow-x-auto border-t border-line">
              <table className="tabular w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium sm:px-5">날짜</th>
                    <th className="px-2 py-2 font-medium">예약</th>
                    <th className="px-2 py-2 text-right font-medium">노쇼</th>
                    <th className="px-2 py-2 text-right font-medium">자동 반납</th>
                    <th className="px-2 py-2 text-right font-medium">신고</th>
                    <th className="px-4 py-2 text-right font-medium sm:px-5">벌점</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...s.daily].reverse().map((d) => (
                    <tr key={d.day}>
                      <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium sm:px-5">
                        {fmtDate(d.day)}
                      </th>
                      <td className="w-[45%] px-2 py-2">
                        <span className="flex items-center gap-2">
                          <span className="h-2.5 rounded-sm bg-du-deep" style={{ width: `${(d.reservations / max) * 100}%`, minWidth: d.reservations ? 3 : 0 }} aria-hidden />
                          {d.reservations}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right">{d.no_shows}</td>
                      <td className="px-2 py-2 text-right">{d.auto_returns}</td>
                      <td className="px-2 py-2 text-right">{d.reports}</td>
                      <td className="px-4 py-2 text-right sm:px-5">{d.penalty_points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <h2 className="px-4 pt-4 text-[17px] font-bold sm:px-5">관리자 처리 기록</h2>
            {s.actions.length === 0 ? (
              <p className="px-4 pb-4 pt-1 text-sm text-muted sm:px-5">기록이 없습니다</p>
            ) : (
              <ul className="mt-2 divide-y divide-line border-t border-line">
                {s.actions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm sm:px-5">
                    <span className="tabular w-28 shrink-0 text-xs text-muted">{fmtDateTime(a.created_at)}</span>
                    <span className="font-semibold">{actionName(a.action)}</span>
                    {a.target && (
                      <span>
                        {a.target} <span className="tabular text-muted">{a.target_sid}</span>
                      </span>
                    )}
                    {a.reason && <span className="min-w-0 text-muted">{a.reason}</span>}
                    <span className="ml-auto text-xs text-muted">{a.actor}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
