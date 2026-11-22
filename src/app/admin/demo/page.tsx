"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Play, Plus, RotateCcw, Square, X } from "lucide-react";
import { OccupancyMeter } from "@/components/OccupancyMeter";
import { useApp } from "@/components/Providers";
import { Button, Panel, Skeleton, Tag, TimeLeft, inputClass, useAction } from "@/components/ui";
import { useHome } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { MODE_LABEL, STATE_LABEL, type Mode, type RoomSummary } from "@/lib/types";
import { cx, level } from "@/lib/util";

interface DemoState {
  points: number;
  banned_until: string | null;
  help_open: boolean;
  res: {
    status: "reserved" | "in_use" | "away";
    seat_label: string;
    room_name: string;
    room_id: number;
    end_at: string;
    checkin_deadline: string;
    away_deadline: string | null;
    on_hold: boolean;
    report_deadline: string | null;
  } | null;
}
interface DemoResult {
  message?: string;
  state?: DemoState;
}

const PRESETS = [
  { label: "여유", pct: 30 },
  { label: "보통", pct: 65 },
  { label: "혼잡", pct: 90 },
];

const FLAGS = [
  { key: "force_open", label: "운영시간 무시" },
  { key: "gps_disabled", label: "위치 확인 끔" },
  { key: "incident_mode", label: "장애 모드 · 자동 취소·벌점 멈춤" },
] as const;

/** 학생 한 명을 그 상황으로 만드는 버튼들. 화살표 뒤는 그 결과 */
const SCENARIOS: { title: string; items: { action: string; label: string; arg?: string; danger?: boolean }[] }[] = [
  {
    title: "예약·체크인",
    items: [
      { action: "reserved", label: "체크인 대기" },
      { action: "checkin_soon", label: "체크인 마감 1분 전" },
      { action: "no_show", label: "미체크인 → 자동 취소·벌점", danger: true },
    ],
  },
  {
    title: "이용",
    items: [
      { action: "in_use", label: "이용 중" },
      { action: "end_soon", label: "종료 9분 전 · 연장 가능" },
      { action: "expire", label: "시간 종료 → 자동 반납" },
    ],
  },
  {
    title: "외출",
    items: [
      { action: "away", label: "외출 중" },
      { action: "away_soon", label: "복귀 마감 4분 전" },
      { action: "away_timeout", label: "외출 초과 → 자동 반납·벌점", danger: true },
    ],
  },
  {
    title: "자리비움 신고",
    items: [
      { action: "report", label: "신고 접수" },
      { action: "report_timeout", label: "무응답 → 자동 반납·벌점", danger: true },
    ],
  },
  {
    title: "도움 요청·제재",
    items: [
      { action: "help", label: "도움 요청 접수" },
      { action: "penalty", label: "벌점 1점", arg: "1" },
      { action: "penalty", label: "벌점 3점 → 예약 정지", arg: "3", danger: true },
    ],
  },
];

const ITEMS = [...SCENARIOS.flatMap((g) => g.items.map((it) => ({ ...it, key: it.action + (it.arg ?? "") }))), { action: "reset", label: "처음으로", key: "reset", arg: undefined, danger: false }];
const itemOf = (key: string) => ITEMS.find((i) => i.key === key);

interface Step {
  id: number;
  key: string;
  /** 앞 상황이 끝난 뒤 이 상황을 실행하기까지 기다리는 시간(초) */
  delay: number;
}
/** 자주 보여 주는 흐름 */
const FLOWS: { label: string; keys: string[] }[] = [
  { label: "미체크인", keys: ["reset", "reserved", "checkin_soon", "no_show"] },
  { label: "이용·연장", keys: ["reset", "reserved", "in_use", "end_soon", "expire"] },
  { label: "외출 초과", keys: ["reset", "in_use", "away", "away_soon", "away_timeout"] },
  { label: "자리비움 신고", keys: ["reset", "in_use", "report", "report_timeout"] },
  { label: "벌점 누적 → 정지", keys: ["reset", "no_show", "away_timeout", "report_timeout"] },
];
const SEQ_KEY = "du-demo-seq";
let stepId = 1;
const toSteps = (keys: string[], delay: number): Step[] => keys.map((key, i) => ({ id: stepId++, key, delay: i === 0 ? 0 : delay }));

function RoomFill({ room, onDone }: { room: RoomSummary; onDone: () => void }) {
  const { toast } = useApp();
  const { busy, run } = useAction((m) => toast(m, "error"));
  const [pct, setPct] = useState(room.pct);
  const lv = level(room.pct);
  const fill = (v: number) =>
    run(`f${v}`, async () => {
      await rpc("admin_demo_fill", { p_room: room.id, p_pct: v });
      setPct(v);
      toast(`${room.name} 혼잡도를 ${v}%로 맞췄습니다.`, "ok");
      onDone();
    });

  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-bold">{room.name}</h3>
        <Tag tone={room.pct >= 80 ? "danger" : room.pct >= 50 ? "warn" : "deep"}>{lv.name}</Tag>
      </div>
      <p className="mt-2 flex items-baseline gap-2">
        <span className="tabular text-[34px] font-bold leading-none tracking-tight">{room.pct}%</span>
        <span className="tabular text-sm text-muted">
          {room.occupied} / {room.total}석
        </span>
      </p>
      <div className="mt-3">
        <OccupancyMeter pct={room.pct} />
      </div>
      <p className="tabular mt-3 text-sm">
        외출 <b>{room.away_minutes}분</b> · 신고 응답 <b>{room.report_minutes}분</b>
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2">
        {PRESETS.map((p) => (
          <Button key={p.pct} busy={busy === `f${p.pct}`} disabled={!!busy} onClick={() => fill(p.pct)}>
            {p.label} {p.pct}%
          </Button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          aria-label={`${room.name} 혼잡도`}
          className="h-11 min-w-0 flex-1 accent-[var(--color-du-deep,#00826f)]"
        />
        <span className="tabular w-11 text-right text-sm font-semibold">{pct}%</span>
        <Button variant="primary" busy={!!busy && !PRESETS.some((p) => busy === `f${p.pct}`)} disabled={!!busy} onClick={() => fill(pct)}>
          적용
        </Button>
      </div>
    </Panel>
  );
}

/** 시연: 층별 혼잡도와 운영 상황을 정하고, 학생 한 명을 원하는 상황으로 만든다 */
export default function DemoPage() {
  const { toast } = useApp();
  const { home, reload } = useHome();
  const { busy, run } = useAction((m) => toast(m, "error"));
  const [students, setStudents] = useState<{ student_id: string; name: string; virtual?: boolean }[]>([]);
  // 자동 시연: 상황을 순서대로 담아 두고, 사이사이 기다리는 시간을 두고 실행한다
  const [seq, setSeq] = useState<Step[]>([]);
  const [gap, setGap] = useState(5);
  const [playing, setPlaying] = useState<{ index: number; left: number } | null>(null);
  const stop = useRef(false);
  const [sid, setSid] = useState("");
  const [roomId, setRoomId] = useState<number | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [forced, setForced] = useState<Mode | "auto">("auto");

  const loadOps = useCallback(async () => {
    const [{ data: st }, { data: per }] = await Promise.all([
      supabase.from("settings").select("key,value").in("key", FLAGS.map((f) => f.key)),
      supabase.from("operating_periods").select("mode").eq("label", "시연").limit(1),
    ]);
    setFlags(Object.fromEntries((st ?? []).map((r) => [r.key, r.value === true])));
    setForced(((per ?? [])[0]?.mode as Mode) ?? "auto");
  }, []);

  useEffect(() => {
    Promise.all([
      supabase.from("profiles").select("student_id,name").eq("role", "student").eq("is_virtual", false).order("student_id"),
      // 시연 전용 가상 학생: 실제 계정을 건드리지 않고 보여 줄 수 있다
      supabase.from("profiles").select("student_id,name").eq("is_virtual", true).like("student_id", "2599%").limit(140),
    ]).then(([real, virt]) => {
      const pool = virt.data ?? [];
      const v = pool.length ? [{ ...pool[Math.floor(Math.random() * pool.length)], virtual: true }] : [];
      const list = [...v, ...(real.data ?? [])];
      setStudents(list);
      if (list[0]) setSid(list[0].student_id);
    });
    loadOps();
    try {
      const saved = JSON.parse(localStorage.getItem(SEQ_KEY) ?? "[]") as { key: string; delay: number }[];
      setSeq(saved.filter((x) => itemOf(x.key)).map((x) => ({ id: stepId++, key: x.key, delay: Number(x.delay) || 0 })));
    } catch {}
    return () => {
      stop.current = true;
    };
  }, [loadOps]);

  const saveSeq = (next: Step[]) => {
    setSeq(next);
    try {
      localStorage.setItem(SEQ_KEY, JSON.stringify(next.map(({ key, delay }) => ({ key, delay }))));
    } catch {}
  };
  const swap = (i: number, j: number) => {
    if (j < 0 || j >= seq.length) return;
    const next = [...seq];
    [next[i], next[j]] = [next[j], next[i]];
    saveSeq(next);
  };

  useEffect(() => {
    if (!sid) return;
    rpc<DemoResult>("admin_demo", { p_action: "state", p_student: sid })
      .then((r) => setState(r.state ?? null))
      .catch(() => setState(null));
  }, [sid]);

  const rooms = home?.rooms ?? [];
  const room = roomId ?? rooms[0]?.id ?? null;

  const scenario = (key: string, action: string, arg?: string) =>
    run(key, async () => {
      const r = await rpc<DemoResult>("admin_demo", { p_action: action, p_student: sid, p_room: room, p_arg: arg ?? null });
      if (r.state) setState(r.state);
      if (r.message) toast(r.message, "ok");
      reload();
    });
  const setMode = (m: Mode | "auto") =>
    run(`m${m}`, async () => {
      await rpc("admin_demo", { p_action: "mode", p_arg: m });
      setForced(m);
      reload();
    });
  const setFlag = (key: string, on: boolean) =>
    run(`s${key}`, async () => {
      await rpc("admin_demo", { p_action: "setting", p_student: key, p_arg: String(on) });
      setFlags((f) => ({ ...f, [key]: on }));
      reload();
    });

  // 담아 둔 상황을 차례로 실행. 멈추면 지금 기다리던 상황부터 실행하지 않는다
  async function play() {
    if (!sid || seq.length === 0 || playing) return;
    stop.current = false;
    try {
      for (let i = 0; i < seq.length; i++) {
        for (let left = seq[i].delay; left > 0; left--) {
          setPlaying({ index: i, left });
          await new Promise((r) => setTimeout(r, 1000));
          if (stop.current) return;
        }
        setPlaying({ index: i, left: 0 });
        const it = itemOf(seq[i].key);
        if (!it) continue;
        const r = await rpc<DemoResult>("admin_demo", { p_action: it.action, p_student: sid, p_room: room, p_arg: it.arg ?? null });
        if (stop.current) return;
        if (r.state) setState(r.state);
        if (r.message) toast(r.message, "ok");
        reload();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "오류가 발생했습니다.", "error");
    } finally {
      setPlaying(null);
    }
  }

  const res = state?.res;
  const deadline = res ? (res.report_deadline ?? (res.status === "reserved" ? res.checkin_deadline : res.status === "away" && res.away_deadline ? res.away_deadline : res.end_at)) : null;

  return (
    <div className="space-y-8">
      <h1 className="text-[24px] font-bold leading-tight">시연</h1>

      <section aria-labelledby="occ-h">
        <h2 id="occ-h" className="mb-3 border-l-4 border-du-deep pl-2.5 text-[18px] font-bold">
          층별 혼잡도
        </h2>
        {home ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
            {rooms.map((r) => (
              <RoomFill key={r.id} room={r} onDone={reload} />
            ))}
          </div>
        ) : (
          <Skeleton className="h-64 !rounded-[var(--radius-panel)]" />
        )}
      </section>

      <section aria-labelledby="ops-h">
        <h2 id="ops-h" className="mb-3 border-l-4 border-du-deep pl-2.5 text-[18px] font-bold">
          운영 상황
        </h2>
        <Panel className="divide-y divide-line">
          <div className="p-4">
            <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              운영 기간
              {home && <Tag tone="deep">지금 {MODE_LABEL[home.mode]}</Tag>}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["auto", "semester", "vacation", "exam"] as const).map((m) => (
                <Button
                  key={m}
                  aria-pressed={forced === m}
                  busy={busy === `m${m}`}
                  disabled={!!busy}
                  className={cx(forced === m && "!border-du-deep !bg-du-tint !text-du-deep-dark")}
                  onClick={() => setMode(m)}
                >
                  {m === "auto" ? "일정대로" : MODE_LABEL[m]}
                </Button>
              ))}
            </div>
          </div>
          {FLAGS.map((f) => {
            const on = !!flags[f.key];
            return (
              <div key={f.key} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm font-semibold">{f.label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={f.label}
                  disabled={!!busy}
                  onClick={() => setFlag(f.key, !on)}
                  className={cx("relative h-7 w-12 shrink-0 rounded-full transition-colors duration-150", on ? "bg-du-deep" : "bg-[#c5cecb]")}
                >
                  <span className={cx("absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left] duration-150", on ? "left-[22px]" : "left-0.5")} />
                </button>
              </div>
            );
          })}
        </Panel>
      </section>

      <section aria-labelledby="sc-h">
        <h2 id="sc-h" className="mb-3 border-l-4 border-du-deep pl-2.5 text-[18px] font-bold">
          학생 시나리오
        </h2>
        <Panel className="overflow-hidden">
          <div className="grid grid-cols-2 gap-2 p-4">
            <select aria-label="학생" className={inputClass} value={sid} disabled={!!playing} onChange={(e) => setSid(e.target.value)}>
              {students.map((s) => (
                <option key={s.student_id} value={s.student_id}>
                  {s.virtual ? "가상 학생 · " : ""}
                  {s.name} {s.student_id}
                </option>
              ))}
            </select>
            <select aria-label="열람실" className={inputClass} value={room ?? ""} onChange={(e) => setRoomId(Number(e.target.value))}>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          {/* 이 학생의 지금 상태 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-du-tint px-4 py-3" aria-live="polite">
            {res ? (
              <>
                <span className="font-bold">
                  {res.room_name} {res.seat_label}
                </span>
                <Tag tone="deep">{STATE_LABEL[res.status]}</Tag>
                {res.report_deadline && <Tag tone="danger">자리 확인 요청</Tag>}
                {res.on_hold && <Tag tone="warn">도움 요청 중</Tag>}
                {deadline && (
                  <span className="tabular text-sm font-semibold">
                    <TimeLeft at={deadline} /> 남음
                  </span>
                )}
              </>
            ) : (
              <span className="font-bold">좌석 없음</span>
            )}
            <span className="tabular ml-auto text-sm">
              벌점 <b>{state?.points ?? 0}점</b>
            </span>
            {state?.banned_until && <Tag tone="danger">예약 정지</Tag>}
          </div>

          <div className="divide-y divide-line">
            {SCENARIOS.map((g) => (
              <div key={g.title} className="p-4">
                <h3 className="mb-2 text-[13px] font-semibold text-muted">{g.title}</h3>
                <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-3">
                  {g.items.map((it) => {
                    const key = it.action + (it.arg ?? "");
                    return (
                      <Button key={key} variant={it.danger ? "danger" : "secondary"} busy={busy === key} disabled={!!busy || !!playing || !sid} onClick={() => scenario(key, it.action, it.arg)}>
                        {it.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* 자동 시연 */}
          <div className="border-t-4 border-du-tint p-4">
            <h3 className="mb-3 text-base font-bold">자동 시연</h3>
            <div className="flex flex-wrap gap-2">
              {FLOWS.map((f) => (
                <Button key={f.label} size="sm" disabled={!!playing} onClick={() => saveSeq(toSteps(f.keys, gap))}>
                  {f.label}
                </Button>
              ))}
            </div>

            {seq.length > 0 && (
              <ol className="mt-3 divide-y divide-line overflow-hidden rounded-[var(--radius-ctl)] border border-line">
                {seq.map((st, i) => {
                  const it = itemOf(st.key);
                  const on = playing?.index === i;
                  const done = !!playing && playing.index > i;
                  return (
                    <li key={st.id} aria-current={on ? "step" : undefined} className={cx("flex items-center gap-2 px-3 py-2 transition-colors duration-150", on && "bg-du-tint", done && "text-muted")}>
                      <span className={cx("tabular grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold", on ? "bg-du-deep text-white" : "bg-[#eaefed]")}>{i + 1}</span>
                      <span className={cx("min-w-0 flex-1 truncate text-sm font-semibold", it?.danger && !done && "text-danger")}>{it?.label}</span>
                      {on && playing.left > 0 ? (
                        <span className="tabular shrink-0 text-sm font-bold text-du-deep-dark">{playing.left}초</span>
                      ) : (
                        <label className="flex shrink-0 items-center gap-1 text-[13px] text-muted">
                          <input
                            type="number"
                            min={0}
                            max={600}
                            inputMode="numeric"
                            aria-label={`${i + 1}번 상황 전 대기 시간(초)`}
                            disabled={!!playing}
                            value={st.delay}
                            onChange={(e) => saveSeq(seq.map((x) => (x.id === st.id ? { ...x, delay: Math.max(0, Math.min(600, Number(e.target.value) || 0)) } : x)))}
                            className="tabular h-9 w-14 rounded-md border border-line bg-surface px-1.5 text-right text-sm text-du-black"
                          />
                          초 뒤
                        </label>
                      )}
                      {!playing && (
                        <span className="flex shrink-0">
                          <button type="button" aria-label="위로" disabled={i === 0} className="grid size-8 place-items-center rounded-md text-muted hover:bg-canvas disabled:opacity-30" onClick={() => swap(i, i - 1)}>
                            <ArrowUp size={15} aria-hidden />
                          </button>
                          <button type="button" aria-label="아래로" disabled={i === seq.length - 1} className="grid size-8 place-items-center rounded-md text-muted hover:bg-canvas disabled:opacity-30" onClick={() => swap(i, i + 1)}>
                            <ArrowDown size={15} aria-hidden />
                          </button>
                          <button type="button" aria-label="빼기" className="grid size-8 place-items-center rounded-md text-muted hover:bg-danger-tint hover:text-danger" onClick={() => saveSeq(seq.filter((x) => x.id !== st.id))}>
                            <X size={15} aria-hidden />
                          </button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-40">
                <Plus size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
                <select
                  aria-label="상황 추가"
                  className={cx(inputClass, "pl-9")}
                  value=""
                  disabled={!!playing}
                  onChange={(e) => e.target.value && saveSeq([...seq, { id: stepId++, key: e.target.value, delay: seq.length ? gap : 0 }])}
                >
                  <option value="">상황 추가</option>
                  {ITEMS.map((it) => (
                    <option key={it.key} value={it.key}>
                      {it.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-sm">
                간격
                <input
                  type="number"
                  min={0}
                  max={600}
                  inputMode="numeric"
                  aria-label="상황 사이 기본 간격(초)"
                  disabled={!!playing}
                  value={gap}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(600, Number(e.target.value) || 0));
                    setGap(v);
                    saveSeq(seq.map((x, i) => ({ ...x, delay: i === 0 ? 0 : v })));
                  }}
                  className="tabular h-11 w-16 rounded-[var(--radius-ctl)] border border-line bg-surface px-2 text-right"
                />
                초
              </label>
              {playing ? (
                <Button
                  variant="danger"
                  className="shrink-0"
                  onClick={() => {
                    stop.current = true;
                    setPlaying(null);
                  }}
                >
                  <Square size={15} aria-hidden />
                  멈춤
                </Button>
              ) : (
                <Button variant="primary" className="shrink-0" disabled={!sid || seq.length === 0 || !!busy} onClick={play}>
                  <Play size={16} aria-hidden />
                  시작
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-line bg-[#f8faf9] p-4">
            <Button busy={busy === "reset"} disabled={!!busy || !!playing || !sid} onClick={() => scenario("reset", "reset")}>
              <RotateCcw size={16} aria-hidden />
              처음으로
            </Button>
            <Button
              busy={busy === "tick"}
              disabled={!!busy}
              onClick={() =>
                run("tick", async () => {
                  await rpc("admin_demo", { p_action: "tick" });
                  if (sid) setState((await rpc<DemoResult>("admin_demo", { p_action: "state", p_student: sid })).state ?? null);
                  toast("자동 처리를 실행했습니다.", "ok");
                  reload();
                })
              }
            >
              <Play size={16} aria-hidden />
              자동 처리 지금 실행
            </Button>
          </div>
        </Panel>
      </section>
    </div>
  );
}
