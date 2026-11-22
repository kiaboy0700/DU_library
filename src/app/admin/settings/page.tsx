"use client";

import { useCallback, useEffect, useState } from "react";
import { LocateFixed, Search, Trash2 } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Field, Panel, Skeleton, Tag, inputClass, useAction, useNow } from "@/components/ui";
import { useRooms } from "@/lib/admin";
import { useSettings, type Settings } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { MODE_LABEL, type Mode } from "@/lib/types";
import { cx, fmtDateTime, getPosition } from "@/lib/util";

/** 항목 하나: [키, 이름, 단위, 도움말] */
type Row = [key: string, label: string, unit: string, help?: string];
interface Group {
  sub?: string;
  desc?: string;
  rows: Row[];
}
interface Section {
  id: string;
  title: string;
  /** 왼쪽 목록에 보이는 한 줄 요약 */
  hint: string;
  groups?: Group[];
}

const SECTIONS: Section[] = [
  {
    id: "reserve",
    title: "예약·연장",
    hint: "이용 시간, 체크인 마감, 연장",
    groups: [
      {
        sub: "예약",
        rows: [
          ["max_minutes", "1회 최대 이용 시간", "분", "한 번 예약으로 쓸 수 있는 시간"],
          ["checkin_minutes", "체크인 마감", "분", "예약 후 이 시간 안에 좌석 QR을 찍지 않으면 자동 취소"],
        ],
      },
      {
        sub: "자리 이동",
        rows: [["move_hold_minutes", "옮길 좌석 맡아 두는 시간", "분", "좌석을 먼저 고른 경우, 이 시간 안에 그 좌석의 QR을 찍어야 함"]],
      },
      {
        sub: "연장",
        rows: [
          ["extend_minutes", "1회 연장 시간", "분"],
          ["extend_window_min", "연장 가능 시점", "분 전", "종료 몇 분 전부터 연장할 수 있는지"],
          ["max_extends", "최대 연장 횟수", "회", "평소 기준입니다. 시험기간에는 제한이 없습니다"],
        ],
      },
    ],
  },
  { id: "crowd", title: "혼잡도별 규칙", hint: "단계 기준, 외출 시간, 신고 응답 시간" },
  {
    id: "report",
    title: "자리비움 신고",
    hint: "신고 조건, 허위 신고",
    groups: [
      {
        sub: "신고할 수 있는 조건",
        rows: [
          ["report_min_after_checkin", "체크인 직후 신고 금지", "분", "방금 앉은 좌석은 이 시간 동안 신고할 수 없음"],
          ["report_cooldown", "응답 후 재신고 금지", "분", "이용자가 응답한 좌석을 다시 신고할 수 없는 시간"],
          ["report_hourly_limit", "1시간 신고 한도", "건", "한 사람이 1시간에 할 수 있는 신고"],
          ["report_daily_limit", "하루 신고 한도", "건"],
        ],
      },
      {
        sub: "허위 신고",
        desc: "관리자가 '앉아 있었음'으로 판정한 신고만 허위로 셉니다. 이용자가 돌아와 응답한 신고는 세지 않습니다.",
        rows: [
          ["false_report_limit", "신고 정지 기준", "회", "허위 신고가 이 횟수가 되면 신고 정지"],
          ["false_report_ban_days", "신고 정지 기간", "일"],
          ["pen_false_report", "벌점", "점"],
          ["false_report_window_days", "누적 기간", "일", "이 기간 안의 허위 신고만 셈"],
        ],
      },
      {
        sub: "즉시 응답 (확인 필요)",
        desc: "신고 직후 이용자가 바로 응답한 경우입니다. 벌점 없이 횟수만 세고 관리자에게 알립니다.",
        rows: [
          ["false_quick_seconds", "즉시 응답으로 보는 시간", "초"],
          ["false_quick_flag", "관리자 알림 기준", "회"],
        ],
      },
    ],
  },
  {
    id: "penalty",
    title: "벌점·예약 정지",
    hint: "벌점 점수, 정지 기준과 기간",
    groups: [
      {
        sub: "벌점",
        rows: [
          ["pen_no_show", "예약 후 미체크인", "점"],
          ["pen_away", "외출 시간 초과", "점"],
          ["pen_report", "자리비움 (평소)", "점"],
          ["pen_report_busy", "자리비움 (혼잡·시험기간)", "점"],
        ],
      },
      {
        sub: "예약 정지",
        rows: [
          ["ban1_points", "1차 정지 기준", "점"],
          ["ban1_days", "1차 정지 기간", "일"],
          ["ban2_points", "2차 정지 기준", "점"],
          ["ban2_days", "2차 정지 기간", "일"],
          ["penalty_window_days", "벌점 누적 기간", "일", "이 기간 안의 벌점만 합산"],
        ],
      },
    ],
  },
  {
    id: "hours",
    title: "운영 시간·기간",
    hint: "개관·폐관, 시험기간, 휴관일",
    groups: [
      {
        sub: "개관·폐관 시각",
        desc: "시험기간에는 '좌석·열람실'에서 24시간 운영으로 지정한 열람실이 종일 열립니다.",
        rows: [
          ["semester_open", "학기 중 개관", "시"],
          ["semester_close", "학기 중 폐관", "시"],
          ["vacation_open", "방학 개관", "시"],
          ["vacation_close", "방학 폐관", "시"],
        ],
      },
    ],
  },
  {
    id: "place",
    title: "도서관 위치",
    hint: "QR 체크인 위치 확인",
    groups: [
      {
        rows: [
          ["library_lat", "위도", ""],
          ["library_lng", "경도", ""],
          ["gps_radius_m", "허용 반경", "m", "이 거리 안에서만 QR 체크인 가능"],
        ],
      },
    ],
  },
  { id: "notice", title: "공지", hint: "홈 화면 공지, 푸시" },
  { id: "test", title: "테스트 설정", hint: "운영시간 무시, 위치 확인 끄기" },
];

/** 테스트할 때만 켜는 설정. 실제 운영에서는 둘 다 끈다 */
const TEST_TOGGLES: { key: string; label: string; desc: string }[] = [
  { key: "force_open", label: "운영시간 무시", desc: "켜 두면 주말·야간·휴관일에도 예약할 수 있습니다." },
  { key: "gps_disabled", label: "위치 확인 끄기", desc: "켜 두면 도서관 밖에서도 QR 체크인·이동·신고가 됩니다." },
];

/** 혼잡도별 규칙 표에 들어가는 키 */
const CROWD_KEYS = ["occ_mid", "occ_high", "away_low", "away_mid", "away_high", "report_low", "report_mid", "report_high"];
const keysOf = (sec: Section) => (sec.id === "crowd" ? CROWD_KEYS : (sec.groups ?? []).flatMap((g) => g.rows.map((r) => r[0])));

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
  const [tab, setTab] = useState("reserve");
  const [q, setQ] = useState("");

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

  const changed = (k: string) => k in draft && draft[k] !== settings[k];
  // 숫자 입력 한 칸
  const num = (k: string, unit: string, label: string, wide?: boolean) => (
    <span className={cx("relative block shrink-0", wide ? "w-full" : "w-32")}>
      <input
        aria-label={label}
        className={cx(inputClass, "tabular text-right", unit ? "pr-12" : "pr-3", changed(k) && "border-du-deep bg-du-tint font-semibold")}
        type="number"
        step="any"
        inputMode="decimal"
        value={String(val(k) ?? "")}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value === "" ? NaN : Number(e.target.value) })}
      />
      {unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{unit}</span>}
    </span>
  );
  // 항목 한 줄: 왼쪽에 이름과 설명, 오른쪽에 값
  const row = ([k, label, unit, help]: Row) => (
    <div key={k} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <p className="text-[15px] font-medium">
          {label}
          {changed(k) && <span className="ml-2 text-xs font-semibold text-du-deep-dark">바뀜</span>}
        </p>
        {help && <p className="text-[13px] text-muted">{help}</p>}
      </div>
      {num(k, unit, label)}
    </div>
  );
  const groupBlock = (g: Group, i: number) => (
    <div key={g.sub ?? i}>
      {g.sub && (
        <div className="border-y border-[#d5e7e2] bg-du-tint px-4 py-2 first:border-t-0 sm:px-5">
          <h3 className="text-[13px] font-bold text-du-deep-dark">{g.sub}</h3>
          {g.desc && <p className="mt-0.5 text-[13px] font-normal text-[#3d4744]">{g.desc}</p>}
        </div>
      )}
      <div className="divide-y divide-line">{g.rows.map(row)}</div>
    </div>
  );

  const section = SECTIONS.find((x) => x.id === tab) ?? SECTIONS[0];
  const query = q.trim().toLowerCase();
  const hits = query
    ? SECTIONS.flatMap((sec) => (sec.groups ?? []).flatMap((g) => g.rows.filter((r) => `${r[1]} ${r[3] ?? ""} ${g.sub ?? ""} ${sec.title}`.toLowerCase().includes(query)).map((r) => ({ sec, r }))))
    : [];
  const dirtyIn = (sec: Section) => keysOf(sec).filter(changed).length;
  const LEVELS = [
    { name: "여유", occ: null, away: "away_low", rep: "report_low", tone: "text-du-deep-dark" },
    { name: "보통", occ: "occ_mid", away: "away_mid", rep: "report_mid", tone: "text-warn" },
    { name: "혼잡", occ: "occ_high", away: "away_high", rep: "report_high", tone: "text-danger" },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">운영 설정</h1>
        <label className="relative block w-full sm:w-72">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input className={cx(inputClass, "pl-9")} type="search" placeholder="설정 찾기 (예: 외출, 벌점, 연장)" aria-label="설정 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
        {/* 구역 목록: 한 번에 한 구역만 본다 */}
        <nav aria-label="설정 구역" className="lg:sticky lg:top-[72px]">
          <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:rounded-[var(--radius-panel)] lg:border lg:border-line lg:bg-surface lg:p-1.5">
            {SECTIONS.map((sec) => {
              const on = !query && sec.id === tab;
              const n = dirtyIn(sec);
              return (
                <li key={sec.id} className="shrink-0">
                  <button
                    type="button"
                    aria-current={on ? "true" : undefined}
                    onClick={() => {
                      setTab(sec.id);
                      setQ("");
                    }}
                    className={cx(
                      "flex w-full items-center gap-2 whitespace-nowrap rounded-full border px-3.5 py-2 text-left text-sm font-semibold transition-colors duration-150 lg:whitespace-normal lg:rounded-[10px] lg:border-transparent lg:px-3 lg:py-2.5",
                      on ? "border-du-deep bg-du-deep text-white lg:bg-du-tint lg:text-du-deep-dark" : "border-line bg-surface hover:bg-canvas",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      {sec.title}
                      <span className={cx("hidden text-xs font-normal lg:block", on ? "text-du-deep-dark/80" : "text-muted")}>{sec.hint}</span>
                    </span>
                    {sec.id === "test" && TEST_TOGGLES.some((t) => settings[t.key]) && <span className="size-2 shrink-0 rounded-full bg-[#c98a12]" aria-label="켜진 항목 있음" />}
                    {n > 0 && <span className="tabular grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-du-deep px-1 text-[11px] font-bold text-white lg:bg-du-deep">{n}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="space-y-4">
          {query ? (
            <Panel className="overflow-hidden">
              <div className="px-4 pb-3 pt-4 sm:px-5">
                <h2 className="text-lg font-bold tracking-[-0.01em]">
                  &lsquo;{q.trim()}&rsquo; 검색 결과 <span className="tabular font-normal text-muted">{hits.length}개</span>
                </h2>
              </div>
              {hits.length === 0 ? (
                <p className="border-t border-line px-4 py-6 text-sm text-muted sm:px-5">맞는 설정이 없습니다. 다른 낱말로 찾아보거나 왼쪽 구역에서 골라 주세요.</p>
              ) : (
                <div className="divide-y divide-line border-t border-line">
                  {hits.map(({ sec, r }) => (
                    <div key={r[0]}>
                      <p className="px-4 pt-2.5 text-xs font-semibold text-muted sm:px-5">{sec.title}</p>
                      {row(r)}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          ) : (
            <>
              {section.id === "test" && (
                <Panel className="divide-y divide-line overflow-hidden">
                  <div className="px-4 pb-3 pt-4 sm:px-5">
                    <h2 className="text-lg font-bold tracking-[-0.01em]">{section.title}</h2>
                    <p className="text-[13px] text-muted">누르는 즉시 적용됩니다. 실제로 운영할 때는 둘 다 꺼 주세요.</p>
                  </div>
                  {TEST_TOGGLES.map((t) => {
                    const on = !!settings[t.key];
                    return (
                      <div key={t.key} className="flex items-center justify-between gap-4 px-4 py-3.5 sm:px-5">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-[15px] font-medium">
                            {t.label}
                            {on && <Tag tone="warn">켜짐</Tag>}
                          </p>
                          <p className="mt-0.5 text-[13px] text-muted">{t.desc}</p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={t.label}
                          disabled={busy === t.key}
                          onClick={() => save(t.key, [[t.key, !on]], `${t.label}: ${on ? "껐습니다" : "켰습니다"}.`)}
                          className={cx("relative h-7 w-12 shrink-0 rounded-full transition-colors duration-150", on ? "bg-du-deep" : "bg-[#b9c6c2]")}
                        >
                          <span className={cx("absolute left-0.5 top-0.5 size-6 rounded-full bg-white shadow transition-transform duration-150", on && "translate-x-5")} />
                        </button>
                      </div>
                    );
                  })}
                </Panel>
              )}

              {section.id === "crowd" && (
                <Panel className="overflow-hidden">
                  <div className="px-4 pb-3 pt-4 sm:px-5">
                    <h2 className="text-lg font-bold tracking-[-0.01em]">{section.title}</h2>
                    <p className="text-[13px] text-muted">이용률이 높을수록 외출 시간과 신고 응답 시간이 짧아집니다. 한 줄이 한 단계입니다.</p>
                  </div>
                  <div className="overflow-x-auto border-t border-line">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead className="border-y border-[#d5e7e2] bg-du-tint text-left text-[13px] text-du-deep-dark">
                        <tr>
                          <th scope="col" className="px-4 py-2.5 font-bold sm:px-5">
                            단계
                          </th>
                          <th scope="col" className="px-2 py-2.5 font-bold">
                            이용률 기준
                          </th>
                          <th scope="col" className="px-2 py-2.5 font-bold">
                            외출 허용 시간
                          </th>
                          <th scope="col" className="px-4 py-2.5 font-bold sm:px-5">
                            신고 응답 시간
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {LEVELS.map((lv) => (
                          <tr key={lv.name}>
                            <th scope="row" className={cx("px-4 py-3 text-left text-base font-bold sm:px-5", lv.tone)}>
                              {lv.name}
                            </th>
                            <td className="px-2 py-3">{lv.occ ? num(lv.occ, "% 이상", `${lv.name} 이용률 기준`) : <span className="tabular text-muted">{String(val("occ_mid"))}% 미만</span>}</td>
                            <td className="px-2 py-3">{num(lv.away, "분", `${lv.name} 외출 허용 시간`)}</td>
                            <td className="px-4 py-3 sm:px-5">{num(lv.rep, "분", `${lv.name} 신고 응답 시간`)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              {section.groups && (
                <Panel className="overflow-hidden">
                  <div className="px-4 pb-3 pt-4 sm:px-5">
                    <h2 className="text-lg font-bold tracking-[-0.01em]">{section.title}</h2>
                  </div>
                  <div className="border-t border-line">{section.groups.map(groupBlock)}</div>
                  {section.id === "place" && (
                    <div className="border-t border-line px-4 py-3 sm:px-5">
                      <Button
                        size="sm"
                        onClick={async () => {
                          const pos = await getPosition();
                          if (!pos) return toast("현재 위치를 가져오지 못했습니다. 브라우저의 위치 권한을 확인해 주세요.", "error");
                          setDraft({ ...draft, library_lat: Number(pos.lat.toFixed(6)), library_lng: Number(pos.lng.toFixed(6)) });
                          toast("현재 위치를 입력했습니다. '변경 사항 저장'을 눌러 적용하세요.");
                        }}
                      >
                        <LocateFixed size={15} aria-hidden />
                        지금 내 위치로 설정
                      </Button>
                    </div>
                  )}
                </Panel>
              )}
            </>
          )}

          {!query && section.id === "hours" && (
            <>
          <Panel className="p-4 sm:p-5">
            <h2 className="text-lg font-bold tracking-[-0.01em]">운영 기간</h2>
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

            </>
          )}
          {!query && section.id === "notice" && (
            <>
          <Panel className="p-4 sm:p-5">
            <h2 className="text-lg font-bold tracking-[-0.01em]">공지</h2>
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
            </>
          )}

          {/* 바꾼 값이 있을 때만 나타나는 저장 줄 */}
          {dirty.length > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save("rules", dirty.map((k) => [k, draft[k]] as [string, number]), "설정을 저장했습니다. 바로 적용됩니다.");
              }}
              className="rise sticky bottom-[calc(60px+env(safe-area-inset-bottom)+8px)] z-20 flex flex-wrap items-center justify-end gap-2 rounded-[var(--radius-panel)] border border-du-deep/40 bg-surface p-3 shadow-[var(--shadow-float)] sm:bottom-4"
            >
              <p className="mr-auto text-sm font-semibold">
                바꾼 항목 <span className="tabular">{dirty.length}개</span>
                <span className="font-normal text-muted"> · 저장해야 적용됩니다</span>
              </p>
              <Button onClick={() => setDraft({})}>되돌리기</Button>
              <Button type="submit" variant="primary" busy={busy === "rules"}>
                변경 사항 저장
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
