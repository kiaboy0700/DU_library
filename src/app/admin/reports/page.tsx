"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Ban, Check, Clock, Inbox, MapPin, Package, Search, Undo2, X } from "lucide-react";
import { HelpChat } from "@/components/HelpChat";
import { useApp } from "@/components/Providers";
import { ActionRow, Button, Confirm, Empty, FoldPanel, GraceControl, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
import { rpc } from "@/lib/supabase";
import { fmtDate, fmtDateTime, fmtRemain, fmtTime } from "@/lib/util";

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
  penalty_type: string | null;
  points: number | null;
  note: string | null;
  penalty_at: string | null;
  report_id: number | null;
  report_seat: string | null;
  report_at: string | null;
}
interface Item {
  id: number;
  code: string;
  items: string[];
  status: "stored" | "picked" | "disposed";
  closed_at: string | null;
  memo: string;
  place: string;
  until_at: string;
  created_at: string;
  name: string | null;
  student_id: string | null;
  seat: string | null;
}
interface Storage {
  place: string;
  hours: string;
  days: number;
  count: number;
  items: Item[];
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
  // 위쪽 칩으로 종류를 골라 본다
  const [tab, setTab] = useState<"all" | "rep" | "help" | "ap" | "item">("all");
  // 보관 중인 짐과 보관 안내(장소·시간·기간)
  const [store, setStore] = useState<Storage | null>(null);
  const [storeForm, setStoreForm] = useState<{ place: string; hours: string; days: number } | null>(null);
  const [newItem, setNewItem] = useState({ sid: "", memo: "", where: "" });
  // 보관 번호·학번·이름으로 찾기, 방금 등록한 묶음의 번호
  const [itemQ, setItemQ] = useState("");
  const [lastCode, setLastCode] = useState<{ code: string; count: number } | null>(null);
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

  const load = useCallback(
    () =>
      Promise.all([
        rpc<Overview>("admin_overview").then(setOv),
        rpc<Storage>("admin_items", { p_q: itemQ.trim() || null }).then(setStore),
      ]).catch(() => {}),
    [itemQ],
  );
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
      {(
        <div role="tablist" aria-label="처리 종류" className="no-scrollbar sticky top-[calc(61px+env(safe-area-inset-top))] z-10 -mx-4 !mt-3 flex gap-2 overflow-x-auto bg-canvas px-4 py-2">
          {(
            [
              ["all", "전체", ov.reports.length + ov.helps.length + ov.appeals.length],
              ["rep", "자리비움 신고", ov.reports.length],
              ["help", "도움 요청", ov.helps.length],
              ["ap", "이의신청", ov.appeals.length],
              ["item", "짐·분실물", store?.count ?? 0],
            ] as const
          ).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-semibold transition-colors duration-150 ${tab === key ? "border-du-deep bg-du-deep text-white" : "border-line bg-surface hover:bg-canvas"}`}
            >
              {label}
              <span className={`tabular grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs ${tab === key ? "bg-white/25" : n > 0 ? "bg-danger text-white" : "bg-[#eaefed] text-muted"}`}>{n}</span>
            </button>
          ))}
        </div>
      )}
      {!empty && tab !== "all" && tab !== "item" && (tab === "rep" ? ov.reports : tab === "help" ? ov.helps : ov.appeals).length === 0 && (
        <Panel>
          <Empty icon={<Inbox size={36} strokeWidth={1.6} aria-hidden />} title="처리할 일이 없습니다" />
        </Panel>
      )}
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

      {empty && tab !== "item" && (
        <Panel>
          <Empty icon={<Inbox size={36} strokeWidth={1.6} aria-hidden />} title="처리할 일이 없습니다" />
        </Panel>
      )}

      {ov.reports.length > 0 && (tab === "all" || tab === "rep") && (
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
                    {/* 자리에 짐이 있었으면 적어 둔다: 반납 확정과 함께 보관 기록이 만들어지고 이용자에게 찾는 곳·기한이 간다 */}
                    <label className="mt-3 flex items-center gap-2">
                      <Package size={18} className="shrink-0 text-muted" aria-hidden />
                      <input
                        className={inputClass}
                        aria-label="보관할 짐"
                        placeholder="보관할 짐 · 쉼표로 여러 개"
                        maxLength={200}
                        value={text[`i${r.id}`] ?? ""}
                        onChange={(e) => setText({ ...text, [`i${r.id}`]: e.target.value })}
                      />
                    </label>
                    {/* 가장 자주 쓰는 처리만 진하게, 나머지는 뜻에 맞는 옅은 색과 아이콘으로 */}
                    <ActionRow className="mt-3">
                      <Button variant="primary" busy={busy === `rc${r.id}`} onClick={() =>
                          act(
                            `rc${r.id}`,
                            async () => {
                              await rpc("admin_resolve_report", { p_report: r.id, p_decision: "confirm" });
                              const memo = (text[`i${r.id}`] ?? "").trim();
                              if (memo) setLastCode(await rpc<{ code: string; count: number }>("admin_store_item", { p_memo: memo, p_report: r.id }));
                            },
                            (text[`i${r.id}`] ?? "").trim() ? "반납 처리하고 짐 보관을 등록했습니다." : "반납 처리하고 벌점을 부여했습니다.",
                          )
                        }
                      >
                        <Check size={16} aria-hidden />
                        반납 확정
                      </Button>
                      <Button variant="soft" busy={busy === `rt${r.id}`} onClick={() => act(`rt${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "returned" }), "복귀를 확인했습니다. 벌점은 없습니다.")}>
                        <Undo2 size={16} aria-hidden />
                        돌아옴
                      </Button>
                      <Button variant="softNeutral" busy={busy === `re${r.id}`} onClick={() => act(`re${r.id}`, () => rpc("admin_resolve_report", { p_report: r.id, p_decision: "extend" }), "자동 반납을 10분 늦췄습니다.")}>
                        <Clock size={16} aria-hidden />
                        반납 10분 연장
                      </Button>
                      <Button variant="softDanger" busy={busy === `rd${r.id}`} onClick={() => setFalseId(r.id)}>
                        <Ban size={16} aria-hidden />
                        허위 신고
                      </Button>
                    </ActionRow>
                  </div>
                </FoldPanel>
              );
            })}
          </div>
        </section>
      )}

      {ov.helps.length > 0 && (tab === "all" || tab === "help") && (
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

      {ov.appeals.length > 0 && (tab === "all" || tab === "ap") && (
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
                    <Tag tone={a.report_id ? "warn" : "neutral"}>{a.report_id ? "허위 신고" : <span className="tabular">벌점 {a.points}점</span>}</Tag>
                  </>
                }
              >
                <div>
                  <p className="text-sm text-[#3d4744]">
                    {a.report_id ? (
                      <>
                        허위 신고로 기록된 신고: <b>{a.report_seat}</b> <span className="tabular text-muted">({a.report_at ? fmtDateTime(a.report_at) : "-"})</span>
                      </>
                    ) : (
                      <>
                        대상 벌점: <span className="tabular">{a.points}점</span> · {a.note} <span className="tabular text-muted">({a.penalty_at ? fmtDateTime(a.penalty_at) : "-"})</span>
                      </>
                    )}
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
                    <Button variant="primary" busy={busy === `aa${a.id}`} onClick={() => act(`aa${a.id}`, () => rpc("admin_resolve_appeal", { p_appeal: a.id, p_approve: true, p_reply: text[`a${a.id}`] || null }), a.report_id ? "이의신청을 승인하고 허위 신고 기록에서 지웠습니다." : "이의신청을 승인하고 벌점을 취소했습니다.")}>
                      승인
                    </Button>
                    <Button variant="softNeutral" busy={busy === `ar${a.id}`} onClick={() => act(`ar${a.id}`, () => rpc("admin_resolve_appeal", { p_appeal: a.id, p_approve: false, p_reply: text[`a${a.id}`] || null }), "이의신청을 반려했습니다.")}>
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
      {/* 방금 등록한 묶음의 번호: 짐에 적어 붙인다 */}
      {lastCode && (
        <div role="status" className="rise flex items-center gap-3 rounded-[var(--radius-panel)] bg-du-deep p-4 text-white">
          <Package size={24} className="shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-white/85">보관 번호 · 짐에 적어 주세요</p>
            <p className="font-mono text-[22px] font-bold leading-tight tracking-tight">{lastCode.code}</p>
            {lastCode.count > 1 && (
              <p className="tabular text-[13px] text-white/85">
                짐마다 -1 ~ -{lastCode.count}
              </p>
            )}
          </div>
          <button type="button" aria-label="닫기" onClick={() => setLastCode(null)} className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-white/15">
            <X size={18} aria-hidden />
          </button>
        </div>
      )}

      {store && (tab === "item" || (tab === "all" && store.items.length > 0)) && (
        <section aria-labelledby="item-h">
          <h2 id="item-h" className="text-lg font-bold">
            짐·분실물 <span className="tabular text-muted">{store.count}</span>
          </h2>

          {tab === "item" && (
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              {/* 보관 안내: 신고로 반납될 때 이용자에게 자동으로 가는 내용 */}
              <Panel className="p-4">
                <h3 className="text-[13px] font-bold">보관 안내</h3>
                {storeForm ? (
                  <form
                    className="mt-2 grid gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      act("st", () => rpc("admin_set_storage", { p_place: storeForm.place, p_hours: storeForm.hours, p_days: storeForm.days }), "보관 안내를 바꿨습니다.").then(() => setStoreForm(null));
                    }}
                  >
                    <input className={inputClass} aria-label="보관 장소" placeholder="보관 장소" required value={storeForm.place} onChange={(e) => setStoreForm({ ...storeForm, place: e.target.value })} />
                    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
                      <input className={inputClass} aria-label="찾을 수 있는 시간" placeholder="찾을 수 있는 시간" value={storeForm.hours} onChange={(e) => setStoreForm({ ...storeForm, hours: e.target.value })} />
                      <label className="flex items-center gap-1.5 text-sm">
                        <input className={`${inputClass} tabular text-right`} type="number" min={1} max={90} aria-label="보관 기간(일)" value={storeForm.days} onChange={(e) => setStoreForm({ ...storeForm, days: Number(e.target.value) || 1 })} />
                        일
                      </label>
                    </div>
                    <ActionRow wide={2}>
                      <Button onClick={() => setStoreForm(null)}>취소</Button>
                      <Button type="submit" variant="primary" busy={busy === "st"}>
                        저장
                      </Button>
                    </ActionRow>
                  </form>
                ) : (
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <p className="min-w-0 text-sm">
                      <b>{store.place}</b> · {store.hours} · <span className="tabular">{store.days}일</span>
                    </p>
                    <Button size="sm" className="shrink-0" onClick={() => setStoreForm({ place: store.place, hours: store.hours, days: store.days })}>
                      바꾸기
                    </Button>
                  </div>
                )}
              </Panel>
              {/* 신고와 상관없이 짐을 보관하게 됐을 때 */}
              <Panel className="p-4">
                <h3 className="text-[13px] font-bold">짐·분실물 등록</h3>
                <form
                  className="mt-2 grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act("ni", async () => setLastCode(await rpc<{ code: string; count: number }>("admin_store_item", { p_memo: newItem.memo, p_student: newItem.sid || null, p_where: newItem.where || null })), "보관을 등록했습니다.").then(() => setNewItem({ sid: "", memo: "", where: "" }));
                  }}
                >
                  <input className={inputClass} aria-label="보관한 물건" placeholder="물건 · 쉼표로 여러 개" required maxLength={200} value={newItem.memo} onChange={(e) => setNewItem({ ...newItem, memo: e.target.value })} />
                  {/* 주인을 알면 학번, 분실물이면 발견한 곳. 둘 중 하나는 있어야 한다 */}
                  <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
                    <input className={`${inputClass} tabular`} aria-label="학번 (주인을 알 때)" placeholder="학번" value={newItem.sid} onChange={(e) => setNewItem({ ...newItem, sid: e.target.value })} />
                    <input className={inputClass} aria-label="발견한 곳" placeholder="발견한 곳" maxLength={60} required={!newItem.sid.trim()} value={newItem.where} onChange={(e) => setNewItem({ ...newItem, where: e.target.value })} />
                  </div>
                  <Button type="submit" variant="primary" busy={busy === "ni"}>
                    등록
                  </Button>
                </form>
              </Panel>
            </div>
          )}

          {tab === "item" && (
            <label className="relative mt-2 block">
              <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input className={`${inputClass} pl-10`} aria-label="보관 번호·학번·이름·물건으로 찾기" placeholder="보관 번호 · 학번 · 이름 · 물건" value={itemQ} onChange={(e) => setItemQ(e.target.value)} />
            </label>
          )}
          <div className="mt-2 space-y-2">
            {store.items.length === 0 && tab === "item" && (
              <Panel>
                <Empty icon={<Package size={36} strokeWidth={1.6} aria-hidden />} title={itemQ.trim() ? "찾는 짐이 없습니다" : "보관 중인 짐이 없습니다"} />
              </Panel>
            )}
            {store.items.map((it, i) => {
              const over = new Date(it.until_at).getTime() < now;
              return (
                <FoldPanel
                  key={it.id}
                  defaultOpen={(i === 0 && tab === "item") || !!itemQ.trim()}
                  head={
                    <>
                      <span className="font-mono text-base font-bold">{it.code}</span>
                      <span className="text-sm text-muted">
                        {it.name ?? "분실물"} · {it.items.length}개
                      </span>
                      {it.status === "stored" ? (
                        <Tag tone={over ? "danger" : "warn"}>
                          <span className="tabular">{over ? "기한 지남" : `${fmtDate(it.until_at)}까지`}</span>
                        </Tag>
                      ) : (
                        <Tag>{it.status === "picked" ? "찾아감" : "처분"}</Tag>
                      )}
                    </>
                  }
                >
                  <p className="text-sm text-[#3d4744]">
                    {it.name ? (
                      <>
                        {it.name} <span className="tabular text-muted">{it.student_id}</span>
                      </>
                    ) : (
                      "주인 모름"
                    )}
                    {it.seat && ` · ${it.seat}`}
                  </p>
                  <p className="tabular text-[13px] text-muted">
                    {fmtDateTime(it.created_at)} 보관 · {it.place}
                    {it.closed_at && ` · ${fmtDateTime(it.closed_at)} ${it.status === "picked" ? "찾아감" : "처분"}`}
                  </p>
                  <ol className="mt-2 divide-y divide-line overflow-hidden rounded-[var(--radius-ctl)] border border-line">
                    {it.items.map((name, n) => (
                      <li key={n} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="font-mono text-[13px] font-semibold text-du-deep-dark">
                          {it.code}-{n + 1}
                        </span>
                        <span className="min-w-0 flex-1 font-semibold">{name}</span>
                      </li>
                    ))}
                  </ol>
                  {it.status === "stored" && (
                    <ActionRow wide={2} className="mt-3">
                      <Button variant="primary" busy={busy === `ip${it.id}`} onClick={() => act(`ip${it.id}`, () => rpc("admin_item_done", { p_item: it.id, p_status: "picked" }), "찾아간 것으로 처리했습니다.")}>
                        <Check size={16} aria-hidden />
                        찾아감
                      </Button>
                      <Button variant="softDanger" busy={busy === `id${it.id}`} disabled={!over} title={over ? undefined : "보관 기한이 지난 뒤에 처분할 수 있습니다"} onClick={() => act(`id${it.id}`, () => rpc("admin_item_done", { p_item: it.id, p_status: "disposed" }), "처분한 것으로 처리했습니다.")}>
                        처분
                      </Button>
                    </ActionRow>
                  )}
                </FoldPanel>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
