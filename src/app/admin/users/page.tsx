"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, UserRound } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Empty, Field, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
import { rpc } from "@/lib/supabase";
import type { Penalty, Profile } from "@/lib/types";
import { cx, fmtDateTime } from "@/lib/util";

interface Row extends Profile {
  points: number;
  active: boolean;
}
interface Detail {
  profile: Profile & { is_virtual?: boolean };
  points: number;
  penalties: Penalty[];
  reservations: { id: number; status: string; start_at: string; end_at: string; ended_at: string | null; end_reason: string | null; seat_label: string; room_name: string; by_admin: boolean }[];
  reports_made: number;
  reports_dismissed: number;
}
const END: Record<string, string> = { user: "직접 반납", expired: "시간 종료", closing: "폐관", away_timeout: "외출 초과", report: "자리비움 신고", admin: "관리자 반납", room_closed: "열람실 폐쇄", no_show: "미체크인" };
const STATUS: Record<string, string> = { reserved: "체크인 대기", in_use: "이용 중", away: "외출", ended: "종료", no_show: "노쇼", cancelled: "취소" };

export default function AdminUsers() {
  const { toast, status } = useApp();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState({ points: 1, note: "", days: 3, banReason: "", pw: "" });
  const [create, setCreate] = useState({ sid: "", name: "", dept: "", grade: 1, pw: "" });
  const { busy, run } = useAction((m) => toast(m, "error"));
  const now = useNow(30000);

  const search = useCallback(async (text: string) => setRows(await rpc<Row[]>("admin_search_users", { p_q: text })), []);
  useEffect(() => {
    const t = setTimeout(() => search(q).catch(() => setRows([])), 250);
    return () => clearTimeout(t);
  }, [q, search]);

  const open = async (id: string) => setDetail(await rpc<Detail>("admin_user_detail", { p_user: id }));
  const act = (key: string, fn: () => Promise<unknown>, msg: string) =>
    run(key, async () => {
      await fn();
      toast(msg, "ok");
      if (detail) await open(detail.profile.id);
      await search(q);
    });

  const d = detail;
  const banned = d?.profile.banned_until && new Date(d.profile.banned_until).getTime() > now;

  return (
    <div className="space-y-4">
      <h1 className="text-[22px] font-bold">학생·제재</h1>
      <div className="grid items-start gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel>
            <div className="relative p-3">
              <Search size={16} className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input className={cx(inputClass, "pl-9")} placeholder="학번 또는 이름" aria-label="학번 또는 이름으로 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {rows === null ? (
              <div className="p-3">
                <Skeleton className="h-40" />
              </div>
            ) : rows.length === 0 ? (
              <p className="px-4 pb-5 pt-1 text-sm text-muted">{q.trim() ? "검색 결과가 없습니다." : "벌점이 있거나 예약이 정지된 학생이 없습니다. 학번이나 이름으로 검색해 보세요."}</p>
            ) : (
              <>
                {!q.trim() && <p className="px-4 pb-1 text-xs text-muted">벌점이 있거나 정지된 학생, 관리자</p>}
                <ul className="max-h-[52vh] divide-y divide-line overflow-auto border-t border-line">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => open(r.id)} aria-current={d?.profile.id === r.id} className={cx("flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-canvas", d?.profile.id === r.id && "bg-du-tint")}>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{r.name}</span>
                          <span className="tabular block truncate text-[13px] text-muted">
                            {r.student_id} {r.department && `· ${r.department}`}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {r.role === "admin" && <Tag tone="deep">관리자</Tag>}
                          {r.banned_until && new Date(r.banned_until).getTime() > now && <Tag tone="danger">정지</Tag>}
                          {r.points > 0 && <Tag tone="warn">{r.points}점</Tag>}
                          {r.active && <Tag>이용 중</Tag>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>

          <details className="rounded-[var(--radius-panel)] border border-line bg-surface">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">새 학생 계정 만들기</summary>
            <form
              className="space-y-3 border-t border-line p-4"
              onSubmit={(e) => {
                e.preventDefault();
                run("create", async () => {
                  const id = await rpc<string>("admin_create_account", { p_student_id: create.sid, p_name: create.name, p_department: create.dept || null, p_grade: create.grade, p_password: create.pw });
                  toast(`${create.name} 학생 계정을 만들었습니다.`, "ok");
                  setCreate({ sid: "", name: "", dept: "", grade: 1, pw: "" });
                  await open(id);
                });
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <Field label="학번">
                  <input className={inputClass} required value={create.sid} onChange={(e) => setCreate({ ...create, sid: e.target.value })} />
                </Field>
                <Field label="이름">
                  <input className={inputClass} required value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} />
                </Field>
                <Field label="학과">
                  <input className={inputClass} value={create.dept} onChange={(e) => setCreate({ ...create, dept: e.target.value })} />
                </Field>
                <Field label="학년">
                  <select className={inputClass} value={create.grade} onChange={(e) => setCreate({ ...create, grade: Number(e.target.value) })}>
                    {[1, 2, 3, 4].map((g) => (
                      <option key={g} value={g}>
                        {g}학년
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="임시 비밀번호" hint="8자 이상">
                <input className={inputClass} type="password" required minLength={8} autoComplete="new-password" value={create.pw} onChange={(e) => setCreate({ ...create, pw: e.target.value })} />
              </Field>
              <Button type="submit" variant="primary" busy={busy === "create"}>
                계정 만들기
              </Button>
            </form>
          </details>
        </div>

        {!d ? (
          <Panel>
            <Empty icon={<UserRound size={36} strokeWidth={1.6} aria-hidden />} title="학생을 선택하세요">
              왼쪽에서 학생을 고르면 벌점·예약 기록을 보고 벌점 부여·취소, 예약 정지·해제, 비밀번호 초기화를 할 수 있습니다.
            </Empty>
          </Panel>
        ) : (
          <div className="space-y-4">
            <Panel className="p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">{d.profile.name}</h2>
                  <p className="tabular text-sm text-muted">
                    {d.profile.student_id}
                    {d.profile.department && ` · ${d.profile.department}`}
                    {d.profile.grade && ` ${d.profile.grade}학년`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {d.profile.role === "admin" && <Tag tone="deep">관리자</Tag>}
                  {d.profile.is_virtual && <Tag>가상 학생</Tag>}
                  {banned && <Tag tone="danger">예약 정지</Tag>}
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">벌점 (30일)</dt>
                  <dd className="tabular text-xl font-bold">{d.points}점</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">정지 기한</dt>
                  <dd className="tabular font-semibold">{banned ? fmtDateTime(d.profile.banned_until!) : "없음"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">신고한 횟수 / 기각</dt>
                  <dd className="tabular font-semibold">
                    {d.reports_made}건 / {d.reports_dismissed}건
                  </dd>
                </div>
              </dl>
              {banned && <p className="mt-2 text-sm text-[#7d1a14]">정지 사유: {d.profile.ban_reason}</p>}

              <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act("pen", () => rpc("admin_penalty", { p_user: d.profile.id, p_points: form.points, p_note: form.note }), `벌점 ${form.points}점을 부여했습니다.`);
                  }}
                >
                  <p className="text-[13px] font-semibold">벌점 부여</p>
                  <div className="flex gap-2">
                    <select className={cx(inputClass, "w-24")} aria-label="벌점" value={form.points} onChange={(e) => setForm({ ...form, points: Number(e.target.value) })}>
                      {[1, 2, 3].map((n) => (
                        <option key={n} value={n}>
                          {n}점
                        </option>
                      ))}
                    </select>
                    <input className={inputClass} aria-label="벌점 사유" placeholder="사유" required value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                  </div>
                  <Button type="submit" size="sm" busy={busy === "pen"}>
                    벌점 부여
                  </Button>
                </form>
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act("ban", () => rpc("admin_ban", { p_user: d.profile.id, p_days: form.days, p_reason: form.banReason }), `${form.days}일간 예약을 정지했습니다.`);
                  }}
                >
                  <p className="text-[13px] font-semibold">예약 정지</p>
                  <div className="flex gap-2">
                    <select className={cx(inputClass, "w-24")} aria-label="정지 기간" value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}>
                      {[1, 3, 7, 14, 30].map((n) => (
                        <option key={n} value={n}>
                          {n}일
                        </option>
                      ))}
                    </select>
                    <input className={inputClass} aria-label="정지 사유" placeholder="사유" required value={form.banReason} onChange={(e) => setForm({ ...form, banReason: e.target.value })} />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" variant="danger" busy={busy === "ban"}>
                      정지
                    </Button>
                    {banned && (
                      <Button size="sm" busy={busy === "unban"} onClick={() => act("unban", () => rpc("admin_ban", { p_user: d.profile.id, p_days: 0, p_reason: "관리자 해제" }), "예약 정지를 해제했습니다.")}>
                        정지 해제
                      </Button>
                    )}
                  </div>
                </form>
              </div>

              <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
                <div className="w-56">
                  <Field label="비밀번호 초기화">
                    <input className={inputClass} type="password" autoComplete="new-password" placeholder="새 비밀번호 (8자 이상)" value={form.pw} onChange={(e) => setForm({ ...form, pw: e.target.value })} />
                  </Field>
                </div>
                <Button disabled={form.pw.length < 8} busy={busy === "pw"} onClick={() => act("pw", async () => { await rpc("admin_reset_password", { p_user: d.profile.id, p_password: form.pw }); setForm({ ...form, pw: "" }); }, "비밀번호를 바꿨습니다.")}>
                  변경
                </Button>
                {d.profile.id !== status?.profile.id && (
                  <Button
                    variant="quiet"
                    className="ml-auto"
                    busy={busy === "role"}
                    onClick={() => {
                      const to = d.profile.role === "admin" ? "student" : "admin";
                      if (!window.confirm(to === "admin" ? `${d.profile.name}님에게 관리자 권한을 줄까요?` : `${d.profile.name}님의 관리자 권한을 해제할까요?`)) return;
                      act("role", () => rpc("admin_set_role", { p_user: d.profile.id, p_role: to }), "권한을 변경했습니다.");
                    }}
                  >
                    {d.profile.role === "admin" ? "관리자 권한 해제" : "관리자로 지정"}
                  </Button>
                )}
              </div>
            </Panel>

            <Panel>
              <h3 className="px-4 pt-4 font-bold">벌점 기록</h3>
              {d.penalties.length === 0 ? (
                <p className="px-4 pb-4 pt-1 text-sm text-muted">벌점 기록이 없습니다.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line border-t border-line">
                  {d.penalties.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className={cx("text-sm font-semibold", p.revoked_at && "text-muted line-through")}>
                          <span className="tabular">{p.points}점</span> · {p.note}
                        </p>
                        <p className="tabular text-xs text-muted">
                          {fmtDateTime(p.created_at)}
                          {p.revoked_at && " · 취소됨"}
                        </p>
                      </div>
                      {!p.revoked_at && (
                        <Button size="sm" variant="quiet" busy={busy === `rv${p.id}`} onClick={() => act(`rv${p.id}`, () => rpc("admin_revoke_penalty", { p_penalty: p.id, p_reason: "관리자 취소" }), "벌점을 취소했습니다.")}>
                          취소
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel>
              <h3 className="px-4 pt-4 font-bold">최근 예약</h3>
              {d.reservations.length === 0 ? (
                <p className="px-4 pb-4 pt-1 text-sm text-muted">예약 기록이 없습니다.</p>
              ) : (
                <div className="mt-2 overflow-x-auto border-t border-line">
                  <table className="tabular w-full min-w-[480px] text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="px-4 py-2 font-medium">좌석</th>
                        <th className="px-2 py-2 font-medium">시작</th>
                        <th className="px-2 py-2 font-medium">종료</th>
                        <th className="px-4 py-2 font-medium">상태</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {d.reservations.map((r) => (
                        <tr key={r.id}>
                          <td className="px-4 py-2 font-semibold">
                            {r.room_name} {r.seat_label}
                          </td>
                          <td className="px-2 py-2">{fmtDateTime(r.start_at)}</td>
                          <td className="px-2 py-2">{fmtDateTime(r.ended_at ?? r.end_at)}</td>
                          <td className="px-4 py-2">
                            {STATUS[r.status] ?? r.status}
                            {r.end_reason && r.status === "ended" && ` · ${END[r.end_reason] ?? r.end_reason}`}
                            {r.by_admin && " · 대리"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
