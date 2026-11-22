"use client";

import { useCallback, useEffect, useState } from "react";
import { LocateFixed, Trash2 } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Field, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
import { useRooms } from "@/lib/admin";
import { useSettings, type Settings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { MODE_LABEL, type Mode } from "@/lib/types";
import { cx, fmtDateTime, getPosition } from "@/lib/util";

const TOGGLES: { key: string; label: string; desc: string; danger?: boolean }[] = [
  { key: "incident_mode", label: "장애 모드", desc: "시스템·인터넷 장애 때 켭니다. 자동 취소, 자동 반납, 벌점 부여가 모두 멈추고 사이트에 안내가 표시됩니다.", danger: true },
  { key: "force_open", label: "운영시간 무시 (시연용)", desc: "켜 두면 주말·야간에도 예약할 수 있습니다. 실제 운영에서는 끄세요." },
  { key: "gps_disabled", label: "위치 확인 끄기 (시연용)", desc: "켜 두면 도서관 밖에서도 QR 체크인이 됩니다. 실제 운영에서는 끄세요." },
];

const GROUPS: { title: string; desc?: string; fields: [string, string, string][] }[] = [
  {
    title: "예약·연장",
    fields: [
      ["max_minutes", "1회 최대 이용", "분"],
      ["checkin_minutes", "체크인 마감", "분"],
      ["extend_minutes", "1회 연장", "분"],
      ["extend_window_min", "연장 가능 시점 (종료 전)", "분"],
      ["max_extends", "최대 연장 횟수 (평소)", "회"],
    ],
  },
  {
    title: "혼잡도 기준과 외출 허용 시간",
    desc: "이용률이 '혼잡' 기준 이상이면 가장 짧은 시간이 적용됩니다.",
    fields: [
      ["occ_mid", "보통 기준", "% 이상"],
      ["occ_high", "혼잡 기준", "% 이상"],
      ["away_low", "외출: 여유", "분"],
      ["away_mid", "외출: 보통", "분"],
      ["away_high", "외출: 혼잡", "분"],
    ],
  },
  {
    title: "자리비움 신고",
    desc: "허위 신고는 관리자가 '앉아 있었음'으로 판정한 경우만 셉니다. 이용자가 신고 직후 바로 응답한 경우는 벌점 없이 횟수만 세고, 기준에 닿으면 관리자에게 알립니다.",
    fields: [
      ["report_low", "응답 시간: 여유", "분"],
      ["report_mid", "응답 시간: 보통", "분"],
      ["report_high", "응답 시간: 혼잡", "분"],
      ["report_min_after_checkin", "체크인 직후 신고 금지", "분"],
      ["report_cooldown", "기각 후 재신고 금지", "분"],
      ["report_hourly_limit", "1인당 신고 한도", "건/시간"],
      ["report_daily_limit", "하루 신고 한도", "건"],
      ["false_report_limit", "허위 신고 정지 기준", "회"],
      ["false_quick_seconds", "즉시 응답으로 보는 시간", "초"],
      ["false_quick_flag", "즉시 응답 알림 기준", "회"],
      ["false_report_window_days", "허위 신고 누적 기간", "일"],
      ["false_report_ban_days", "신고 정지 기간", "일"],
      ["pen_false_report", "허위 신고 벌점", "점"],
    ],
  },
  {
    title: "벌점과 예약 정지",
    fields: [
      ["pen_no_show", "미체크인", "점"],
      ["pen_away", "외출 시간 초과", "점"],
      ["pen_report", "자리비움 (평소)", "점"],
      ["pen_report_busy", "자리비움 (혼잡·시험기간)", "점"],
      ["penalty_window_days", "누적 기간", "일"],
      ["ban1_points", "1차 정지 기준", "점"],
      ["ban1_days", "1차 정지 기간", "일"],
      ["ban2_points", "2차 정지 기준", "점"],
      ["ban2_days", "2차 정지 기간", "일"],
    ],
  },
  {
    title: "운영 시간",
    desc: "시험기간에는 '좌석·열람실'에서 24시간 운영으로 지정한 열람실이 종일 열립니다.",
    fields: [
      ["semester_open", "학기 중 개관", "시"],
      ["semester_close", "학기 중 폐관", "시"],
      ["vacation_open", "방학 개관", "시"],
      ["vacation_close", "방학 폐관", "시"],
    ],
  },
  {
    title: "도서관 위치 (QR 체크인 확인용)",
    fields: [
      ["library_lat", "위도", ""],
      ["library_lng", "경도", ""],
      ["gps_radius_m", "허용 반경", "m"],
    ],
  },
];

interface Period {
  id: number;
  mode: Mode;
  label: string | null;
  start_date: string;
  end_date: string;
}
interface Announcement {
  id: number;
  title: string;
  body: string;
  room_id: number | null;
  until: string | null;
  created_at: string;
}

export default function AdminSettings() {
  const { toast } = useApp();
  const { settings, reload } = useSettings();
  const { rooms } = useRooms();
  const [draft, setDraft] = useState<Settings>({});
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [closed, setClosed] = useState<{ day: string; reason: string | null }[]>([]);
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [np, setNp] = useState({ mode: "exam" as Mode, label: "", start: "", end: "" });
  const [nc, setNc] = useState({ day: "", reason: "" });
  const [na, setNa] = useState({ title: "", body: "", room: "", hours: 24, push: true });
  const { busy, run } = useAction((m) => toast(m, "error"));
  const now = useNow(30000);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadLists = useCallback(async () => {
    const [p, c, a] = await Promise.all([
      supabase.from("operating_periods").select("*").order("start_date"),
      supabase.from("closed_days").select("*").order("day"),
      supabase.from("announcements").select("*").order("created_at", { ascending: false }).limit(20),
    ]);
    setPeriods((p.data as Period[]) ?? []);
    setClosed(c.data ?? []);
    setAnns((a.data as Announcement[]) ?? []);
  }, []);
  useEffect(() => {
    loadLists();
  }, [loadLists]);

  const val = (k: string) => (k in draft ? draft[k] : settings?.[k]);
  const dirty = Object.keys(draft).filter((k) => draft[k] !== settings?.[k]);

  const save = (key: string, entries: [string, number | boolean][], msg: string) =>
    run(key, async () => {
      for (const [k, v] of entries) {
        if (typeof v === "number" && !Number.isFinite(v)) throw new Error("숫자를 입력해 주세요.");
        const { error } = await supabase.from("settings").upsert({ key: k, value: v });
        if (error) throw new Error(error.message);
      }
      await rpc("admin_log_setting", { p_keys: entries.map(([k, v]) => `${k}=${v}`).join(", ") }).catch(() => {});
      await reload();
      setDraft({});
      toast(msg, "ok");
    });
  const db = (key: string, fn: () => PromiseLike<{ error: { message: string } | null }>, msg: string) =>
    run(key, async () => {
      const { error } = await fn();
      if (error) throw new Error(error.message);
      toast(msg, "ok");
      await loadLists();
    });

  if (!settings) return <Skeleton className="h-96 !rounded-[var(--radius-panel)]" />;

  return (
    <div className="space-y-5">
      <h1 className="text-[22px] font-bold">운영 설정</h1>

      <Panel className="divide-y divide-line">
        {TOGGLES.map((t) => {
          const on = !!settings[t.key];
          return (
            <div key={t.key} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-semibold">
                  {t.label}
                  {on && <Tag tone={t.danger ? "danger" : "warn"}>켜짐</Tag>}
                </p>
                <p className="mt-0.5 text-sm text-muted">{t.desc}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={t.label}
                disabled={busy === t.key}
                onClick={() => save(t.key, [[t.key, !on]], `${t.label}를 ${on ? "껐습니다" : "켰습니다"}.`)}
                className={cx("relative h-7 w-12 shrink-0 rounded-full transition-colors duration-150", on ? (t.danger ? "bg-danger" : "bg-du-deep") : "bg-[#b9c6c2]")}
              >
                <span className={cx("absolute left-0.5 top-0.5 size-6 rounded-full bg-white shadow transition-transform duration-150", on && "translate-x-5")} />
              </button>
            </div>
          );
        })}
      </Panel>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save("rules", dirty.map((k) => [k, draft[k]] as [string, number]), "설정을 저장했습니다. 바로 적용됩니다.");
        }}
        className="space-y-4"
      >
        {GROUPS.map((g) => (
          <Panel key={g.title} className="p-4 sm:p-5">
            <h2 className="font-bold">{g.title}</h2>
            {g.desc && <p className="mt-0.5 text-sm text-muted">{g.desc}</p>}
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
              {g.fields.map(([k, label, unit]) => (
                <label key={k} className="block">
                  <span className="mb-1.5 block text-[13px] font-semibold">{label}</span>
                  <span className="relative block">
                    <input
                      className={cx(inputClass, "tabular", unit && "pr-14", k in draft && draft[k] !== settings[k] && "border-du-deep bg-du-tint")}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={String(val(k) ?? "")}
                      onChange={(e) => setDraft({ ...draft, [k]: e.target.value === "" ? NaN : Number(e.target.value) })}
                    />
                    {unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{unit}</span>}
                  </span>
                </label>
              ))}
            </div>
            {g.title.startsWith("도서관 위치") && (
              <Button
                size="sm"
                className="mt-3"
                onClick={async () => {
                  const pos = await getPosition();
                  if (!pos) return toast("현재 위치를 가져오지 못했습니다. 브라우저의 위치 권한을 확인해 주세요.", "error");
                  setDraft({ ...draft, library_lat: Number(pos.lat.toFixed(6)), library_lng: Number(pos.lng.toFixed(6)) });
                  toast("현재 위치를 입력했습니다. 아래 '변경 사항 저장'을 눌러 적용하세요.");
                }}
              >
                <LocateFixed size={15} aria-hidden />
                지금 내 위치로 설정
              </Button>
            )}
          </Panel>
        ))}
        <div className="sticky bottom-[calc(60px+env(safe-area-inset-bottom)+8px)] z-20 flex items-center justify-end gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-3 shadow-[var(--shadow-float)] sm:bottom-4">
          <p className="mr-auto text-sm text-muted">{dirty.length > 0 ? `바꾼 항목 ${dirty.length}개` : "바꾼 항목이 없습니다"}</p>
          <Button disabled={dirty.length === 0} onClick={() => setDraft({})}>
            되돌리기
          </Button>
          <Button type="submit" variant="primary" disabled={dirty.length === 0} busy={busy === "rules"}>
            변경 사항 저장
          </Button>
        </div>
      </form>

      <Panel className="p-4 sm:p-5">
        <h2 className="font-bold">운영 기간</h2>
        <p className="mt-0.5 text-sm text-muted">기간이 겹치면 시험기간이 우선합니다. 어느 기간에도 속하지 않는 날은 학기 중으로 봅니다.</p>
        {periods === null ? (
          <Skeleton className="mt-3 h-24" />
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-[var(--radius-ctl)] border border-line">
            {periods.length === 0 && <li className="px-3 py-3 text-sm text-muted">등록된 기간이 없습니다.</li>}
            {periods.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <p className="tabular min-w-0 text-sm">
                  <Tag tone={p.mode === "exam" ? "danger" : p.mode === "vacation" ? "neutral" : "deep"}>{MODE_LABEL[p.mode]}</Tag> <strong className="font-semibold">{p.label}</strong>{" "}
                  <span className="text-muted">
                    {p.start_date} ~ {p.end_date}
                  </span>
                </p>
                <button type="button" aria-label={`${p.label ?? MODE_LABEL[p.mode]} 기간 삭제`} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-danger-tint hover:text-danger" onClick={() => db(`dp${p.id}`, () => supabase.from("operating_periods").delete().eq("id", p.id), "기간을 삭제했습니다.")}>
                  <Trash2 size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 grid grid-cols-2 items-end gap-2 sm:grid-cols-[130px_1fr_150px_150px_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (np.end < np.start) return toast("종료일이 시작일보다 빠릅니다.", "error");
            db("np", () => supabase.from("operating_periods").insert({ mode: np.mode, label: np.label || MODE_LABEL[np.mode], start_date: np.start, end_date: np.end }), "운영 기간을 추가했습니다.").then(() => setNp({ ...np, label: "", start: "", end: "" }));
          }}
        >
          <Field label="구분">
            <select className={inputClass} value={np.mode} onChange={(e) => setNp({ ...np, mode: e.target.value as Mode })}>
              <option value="exam">시험기간</option>
              <option value="semester">학기 중</option>
              <option value="vacation">방학</option>
            </select>
          </Field>
          <Field label="이름">
            <input className={inputClass} value={np.label} onChange={(e) => setNp({ ...np, label: e.target.value })} placeholder="예: 1학기 중간고사" />
          </Field>
          <Field label="시작일">
            <input className={inputClass} type="date" required value={np.start} onChange={(e) => setNp({ ...np, start: e.target.value })} />
          </Field>
          <Field label="종료일">
            <input className={inputClass} type="date" required value={np.end} onChange={(e) => setNp({ ...np, end: e.target.value })} />
          </Field>
          <Button type="submit" busy={busy === "np"} className="col-span-2 sm:col-span-1">
            기간 추가
          </Button>
        </form>

        <h3 className="mt-6 text-sm font-bold">휴관일</h3>
        <p className="text-sm text-muted">토요일과 일요일은 자동으로 휴관입니다. 공휴일·개교기념일·장서점검일을 등록하세요.</p>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {closed.map((c) => (
            <li key={c.day} className="tabular flex items-center gap-1 rounded-full border border-line py-1 pl-3 pr-1 text-sm">
              {c.day} {c.reason}
              <button type="button" aria-label={`${c.day} 휴관일 삭제`} className="grid size-7 place-items-center rounded-full text-muted hover:bg-danger-tint hover:text-danger" onClick={() => db(`dc${c.day}`, () => supabase.from("closed_days").delete().eq("day", c.day), "휴관일을 삭제했습니다.")}>
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            db("nc", () => supabase.from("closed_days").upsert({ day: nc.day, reason: nc.reason || "휴관" }), "휴관일을 추가했습니다.").then(() => setNc({ day: "", reason: "" }));
          }}
        >
          <div className="w-40">
            <Field label="날짜">
              <input className={inputClass} type="date" required value={nc.day} onChange={(e) => setNc({ ...nc, day: e.target.value })} />
            </Field>
          </div>
          <div className="min-w-40 flex-1 sm:max-w-xs">
            <Field label="사유">
              <input className={inputClass} value={nc.reason} onChange={(e) => setNc({ ...nc, reason: e.target.value })} placeholder="예: 개교기념일" />
            </Field>
          </div>
          <Button type="submit" busy={busy === "nc"}>
            휴관일 추가
          </Button>
        </form>
      </Panel>

      <Panel className="p-4 sm:p-5">
        <h2 className="font-bold">공지</h2>
        <p className="mt-0.5 text-sm text-muted">홈 화면 위쪽에 표시됩니다. 푸시를 켠 학생에게는 알림으로도 보낼 수 있습니다.</p>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run("na", async () => {
              await rpc("admin_announce", { p_title: na.title, p_body: na.body, p_room: na.room ? Number(na.room) : null, p_hours: na.hours, p_push: na.push });
              toast("공지를 등록했습니다.", "ok");
              setNa({ ...na, title: "", body: "" });
              await loadLists();
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_170px_150px]">
            <Field label="제목">
              <input className={inputClass} required maxLength={60} value={na.title} onChange={(e) => setNa({ ...na, title: e.target.value })} placeholder="예: 오늘 18시 조기 폐관" />
            </Field>
            <Field label="대상">
              <select className={inputClass} value={na.room} onChange={(e) => setNa({ ...na, room: e.target.value })}>
                <option value="">전체</option>
                {rooms?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="게시 기간">
              <select className={inputClass} value={na.hours} onChange={(e) => setNa({ ...na, hours: Number(e.target.value) })}>
                <option value={6}>6시간</option>
                <option value={24}>하루</option>
                <option value={72}>3일</option>
                <option value={168}>일주일</option>
                <option value={0}>삭제할 때까지</option>
              </select>
            </Field>
          </div>
          <Field label="내용 (선택)">
            <textarea className={cx(inputClass, "py-2.5")} rows={2} maxLength={300} value={na.body} onChange={(e) => setNa({ ...na, body: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
              <input type="checkbox" className="size-[18px]" checked={na.push} onChange={(e) => setNa({ ...na, push: e.target.checked })} />
              푸시 알림으로도 보내기
            </label>
            <Button type="submit" variant="primary" busy={busy === "na"}>
              공지 등록
            </Button>
          </div>
        </form>
        {anns.length > 0 && (
          <ul className="mt-4 divide-y divide-line rounded-[var(--radius-ctl)] border border-line">
            {anns.map((a) => {
              const over = a.until && new Date(a.until).getTime() < now;
              return (
                <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <p className={cx("min-w-0 text-sm", over && "text-muted")}>
                    <strong className="font-semibold">{a.title}</strong> <span className="text-muted">{a.body}</span>
                    <span className="tabular block text-xs text-muted">
                      {fmtDateTime(a.created_at)} 등록 · {over ? "게시 종료" : a.until ? `${fmtDateTime(a.until)}까지` : "계속 게시"}
                    </span>
                  </p>
                  <button type="button" aria-label={`공지 "${a.title}" 삭제`} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-danger-tint hover:text-danger" onClick={() => db(`da${a.id}`, () => supabase.from("announcements").delete().eq("id", a.id), "공지를 삭제했습니다.")}>
                    <Trash2 size={16} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
