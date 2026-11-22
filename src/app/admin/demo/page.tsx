"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Play } from "lucide-react";
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
  const [students, setStudents] = useState<{ student_id: string; name: string }[]>([]);
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
    supabase
      .from("profiles")
      .select("student_id,name")
      .eq("role", "student")
      .eq("is_virtual", false)
      .order("student_id")
      .then(({ data }) => {
        setStudents(data ?? []);
        if (data?.[0]) setSid(data[0].student_id);
      });
    loadOps();
  }, [loadOps]);

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
            <select aria-label="학생" className={inputClass} value={sid} onChange={(e) => setSid(e.target.value)}>
              {students.map((s) => (
                <option key={s.student_id} value={s.student_id}>
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
                      <Button key={key} variant={it.danger ? "danger" : "secondary"} busy={busy === key} disabled={!!busy || !sid} onClick={() => scenario(key, it.action, it.arg)}>
                        {it.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-line bg-[#f8faf9] p-4">
            <Button busy={busy === "reset"} disabled={!!busy || !sid} onClick={() => scenario("reset", "reset")}>
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
