"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { Decor, Seat, SeatState, SeatType } from "@/lib/types";
import { SEAT_TYPE_LABEL, STATE_LABEL } from "@/lib/types";
import { cx } from "@/lib/util";

export type SeatVisual = SeatState | "mine" | "inactive";

const PAINT: Record<SeatVisual, { fill: string; stroke: string; text: string; dash?: string }> = {
  free: { fill: "#6fbe44", stroke: "#4f9a2a", text: "#12300a" },
  reserved: { fill: "#ffffff", stroke: "#7d8a86", text: "#4b5552", dash: "3 2.5" },
  in_use: { fill: "#c5cecb", stroke: "#aab5b1", text: "#3f4946" },
  away: { fill: "#ddd820", stroke: "#b3ae0c", text: "#38360a" },
  mine: { fill: "#00826f", stroke: "#005a4d", text: "#ffffff" },
  inactive: { fill: "#f0f3f2", stroke: "#d5dcda", text: "#9aa5a2" },
};

export const LEGEND: { key: SeatVisual; label: string }[] = [
  { key: "free", label: "빈자리" },
  { key: "in_use", label: "사용 중" },
  { key: "reserved", label: "체크인 대기" },
  { key: "away", label: "외출" },
  { key: "mine", label: "내 좌석" },
];

export function LegendSwatch({ kind }: { kind: SeatVisual }) {
  const p = PAINT[kind];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill={p.fill} stroke={p.stroke} strokeWidth="1.2" strokeDasharray={p.dash} />
    </svg>
  );
}

function DecorShape({ d, c }: { d: Decor; c: number }) {
  const x = d.x * c;
  const y = d.y * c;
  const w = d.w * c;
  const h = d.h * c;
  if (d.t === "table") return <rect x={x + 2} y={y + c * 0.22} width={w - 4} height={h - c * 0.44} rx={3} fill="#e4eae8" />;
  if (d.t === "pillar")
    return (
      <g>
        <rect x={x + 3} y={y + 3} width={w - 6} height={h - 6} fill="#8d9995" />
        <title>기둥</title>
      </g>
    );
  if (d.t === "label")
    return (
      <text x={x} y={y + h * 0.7} fontSize={Math.max(11, c * 0.42)} fontWeight={700} fill="#3d4744">
        {d.text}
      </text>
    );
  if (d.t === "door")
    return (
      <g>
        <line x1={x} y1={y + h / 2} x2={x + w} y2={y + h / 2} stroke="#8d9995" strokeWidth={2} strokeDasharray="6 4" />
        <rect x={x + w / 2 - c * 1.2} y={y + h * 0.1} width={c * 2.4} height={h * 0.8} rx={4} fill="#f3f6f4" />
        <text x={x + w / 2} y={y + h * 0.68} fontSize={Math.max(10, c * 0.38)} fontWeight={600} fill="#5b6663" textAnchor="middle">
          {d.text}
        </text>
      </g>
    );
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill="#eef3f1" stroke="#d0d9d6" strokeDasharray="5 4" />
      <text x={x + w / 2} y={y + h / 2 + 4} fontSize={Math.max(10, c * 0.38)} fill="#5b6663" textAnchor="middle">
        {d.text}
      </text>
    </g>
  );
}

function SeatShape({ type, s, paint, selected }: { type: SeatType; s: number; paint: (typeof PAINT)[SeatVisual]; selected: boolean }) {
  const common = { fill: paint.fill, stroke: selected ? "#231f20" : paint.stroke, strokeWidth: selected ? 2.5 : 1.2, strokeDasharray: selected ? undefined : paint.dash };
  if (type === "window") return <circle cx={s / 2} cy={s / 2} r={s / 2} {...common} />;
  return (
    <>
      <rect width={s} height={s} rx={type === "booth" ? s * 0.34 : s * 0.2} {...common} />
      {/* 칸막이: 위쪽 가림판 */}
      {type === "partition" && <rect x={1} y={1} width={s - 2} height={Math.max(3, s * 0.14)} rx={1.5} fill={paint.text} opacity={0.55} />}
      {/* 노트북석: 콘센트 표시 */}
      {type === "laptop" && <rect x={s - s * 0.32} y={s - s * 0.26} width={s * 0.2} height={s * 0.14} rx={1} fill={paint.text} opacity={0.6} />}
    </>
  );
}

export function SeatMap({
  width,
  height,
  decor,
  seats,
  visual,
  selectedId,
  onSelect,
  dimTypes,
  badge,
  selectable = (v) => v === "free" || v === "mine",
  title,
}: {
  width: number;
  height: number;
  decor: Decor[];
  seats: Seat[];
  visual: (seat: Seat) => SeatVisual;
  selectedId?: number | null;
  onSelect?: (seat: Seat) => void;
  /** 필터로 흐리게 처리할 좌석 종류 */
  dimTypes?: Set<SeatType>;
  /** 좌석 위에 작은 점 표시 (관리자: 신고·보류) */
  badge?: (seat: Seat) => "report" | "hold" | null;
  selectable?: (v: SeatVisual, seat: Seat) => boolean;
  title: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(30);
  const [fit, setFit] = useState(30);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const f = Math.floor((el.clientWidth - 24) / width);
      setFit(f);
      setCell((c) => (c === 30 ? Math.min(34, Math.max(22, f)) : c));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const s = cell - 5;
  const zoom = (d: number) => setCell((c) => Math.min(44, Math.max(Math.min(14, Math.max(fit, 10)), c + d)));

  return (
    <div className="relative">
      <div ref={wrap} className="overflow-auto overscroll-x-contain rounded-[var(--radius-ctl)] bg-[#f8faf9] p-3" style={{ maxHeight: "68vh" }} tabIndex={0} aria-label={`${title} 좌석 배치도, 스크롤 가능`}>
        <svg width={width * cell} height={height * cell} viewBox={`0 0 ${width * cell} ${height * cell}`} role="group" aria-label={title} className="block">
          {decor.map((d, i) => (
            <DecorShape key={i} d={d} c={cell} />
          ))}
          {seats.map((seat) => {
            const v = visual(seat);
            const paint = PAINT[v];
            const can = !!onSelect && selectable(v, seat);
            const dim = dimTypes?.has(seat.seat_type);
            const num = String(Number(seat.label.split("-")[1]));
            const b = badge?.(seat);
            const stateName = v === "mine" ? "내 좌석" : v === "inactive" ? "사용 중지" : STATE_LABEL[v];
            return (
              <g
                key={seat.id}
                transform={`translate(${seat.x * cell + 2.5} ${seat.y * cell + 2.5})`}
                role={can ? "button" : "img"}
                tabIndex={can ? 0 : undefined}
                aria-label={`${seat.label} ${SEAT_TYPE_LABEL[seat.seat_type]}, ${stateName}`}
                aria-pressed={can ? selectedId === seat.id : undefined}
                onClick={can ? () => onSelect(seat) : undefined}
                onKeyDown={
                  can
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(seat);
                        }
                      }
                    : undefined
                }
                opacity={dim ? 0.25 : 1}
                className={cx(can && "cursor-pointer outline-none [&:focus-visible>rect:first-of-type]:stroke-[#231f20] [&:focus-visible>rect:first-of-type]:stroke-[3px] [&:focus-visible>circle]:stroke-[#231f20] [&:focus-visible>circle]:stroke-[3px]", v === "reserved" && "seat-pulse")}
              >
                <SeatShape type={seat.seat_type} s={s} paint={paint} selected={selectedId === seat.id} />
                {cell >= 22 && (
                  <text x={s / 2} y={s / 2 + (seat.seat_type === "partition" ? 5 : 3.5)} fontSize={Math.min(11, s * 0.42)} fontWeight={600} fill={paint.text} textAnchor="middle" className="tabular pointer-events-none select-none">
                    {num}
                  </text>
                )}
                {v === "inactive" && <line x1={4} y1={4} x2={s - 4} y2={s - 4} stroke="#9aa5a2" strokeWidth={1.5} />}
                {b && <circle cx={s - 1} cy={1} r={4.5} fill={b === "report" ? "#b3261e" : "#8a5a00"} stroke="#fff" strokeWidth={1.5} />}
                <title>{`${seat.label} · ${SEAT_TYPE_LABEL[seat.seat_type]} · ${stateName}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="no-print absolute right-2 top-2 flex overflow-hidden rounded-lg border border-line bg-surface shadow-[0_1px_3px_rgb(0_60_50/0.12)]">
        <button type="button" aria-label="좌석 배치도 축소" onClick={() => zoom(-4)} className="grid size-9 place-items-center hover:bg-canvas">
          <Minus size={16} aria-hidden />
        </button>
        <span className="w-px bg-line" />
        <button type="button" aria-label="좌석 배치도 확대" onClick={() => zoom(4)} className="grid size-9 place-items-center hover:bg-canvas">
          <Plus size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
