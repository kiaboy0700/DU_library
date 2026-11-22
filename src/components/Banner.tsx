"use client";

import { Children, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { cx } from "@/lib/util";

/**
 * 좌우로 넘겨 보는 배너. 한 번에 한 장만 보이고, 건드리지 않으면 자동으로 다음 장으로 넘어간다.
 *  - 원형으로 이어진다: 마지막 장 다음은 첫 장이고, 자동 넘김은 언제나 오른쪽으로만 간다
 *    (양 끝에 복제한 장을 하나씩 두고, 복제 장에 닿으면 진짜 장으로 소리 없이 옮겨 놓는다)
 *  - 손가락으로 밀거나, 아래의 화살표·점·키보드 좌우 키로 넘긴다
 *  - 마우스를 올리고 있는 동안에는 잠깐 멈추고, 누르거나 밀면 자동 넘김이 꺼진다 (재생 버튼으로 다시 켠다)
 *  - 넓은 화면(PC)에서는 넘기지 않고 전부 나란히 보여 준다
 */
export function Banner({ label, names, interval = 5000, children }: { label: string; names: string[]; interval?: number; children: React.ReactNode }) {
  const slides = Children.toArray(children);
  const count = slides.length;
  const loop = count > 1;
  // 화면에 놓는 순서: [마지막 장의 복제, 진짜 장들…, 첫 장의 복제]
  const track = loop ? [slides[count - 1], ...slides, slides[0]] : slides;

  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const hovering = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 지금 가장 가운데에 온 칸(복제 포함)의 번호 */
  const pos = useCallback(() => {
    const el = scroller.current;
    if (!el) return loop ? 1 : 0;
    let best = 0;
    let dist = Infinity;
    [...el.children].forEach((c, i) => {
      const d = Math.abs((c as HTMLElement).offsetLeft - el.offsetLeft - el.scrollLeft - (el.clientWidth - (c as HTMLElement).offsetWidth) / 2);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  }, [loop]);

  const to = useCallback((p: number, smooth: boolean) => {
    const el = scroller.current;
    const target = el?.children[p] as HTMLElement | undefined;
    if (!el || !target) return;
    el.scrollTo({ left: target.offsetLeft - el.offsetLeft - (el.clientWidth - target.offsetWidth) / 2, behavior: smooth ? "smooth" : "instant" });
  }, []);

  // 처음과 화면 너비가 바뀔 때: 진짜 첫 장(또는 보고 있던 장)에 맞춰 놓는다
  const indexRef = useRef(0);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    const place = () => to(loop ? indexRef.current + 1 : 0, false);
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [loop, to]);

  const onScroll = () => {
    if (!loop) return;
    const p = pos();
    setIndex((((p - 1) % count) + count) % count);
    // 넘김이 멈추면, 복제 장에 서 있는 경우 같은 내용의 진짜 장으로 옮겨 놓는다
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const q = pos();
      if (q === 0) to(count, false);
      else if (q === count + 1) to(1, false);
    }, 140);
  };
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  // 자동 넘김: 언제나 오른쪽으로. 움직임 줄이기를 켜지 않았고, 탭이 보이고, 마우스가 올라가 있지 않을 때만
  useEffect(() => {
    if (paused || !loop) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const wide = window.matchMedia("(min-width: 768px)");
    const t = setInterval(() => {
      if (wide.matches || calm.matches || document.hidden || hovering.current) return;
      to(pos() + 1, true);
    }, interval);
    return () => clearInterval(t);
  }, [paused, loop, interval, to, pos]);

  const stop = () => setPaused(true);
  const step = (d: number) => {
    stop();
    to(pos() + d, true);
  };

  // 넘기기 버튼은 카드 아래 줄에 둔다 (카드 위에 띄우면 내용을 가린다)
  const arrow = "grid size-8 place-items-center rounded-full text-[#3d4744] transition-colors duration-150 hover:bg-[#e6ecea]";
  // 옆으로 넘기는 자리: 마우스를 배너에 올리면 양옆 여백에 화살표가 나타나고, 누르면 그쪽으로 넘어간다.
  // 카드 안쪽 여백(16px)까지만 걸치므로 카드의 글자나 버튼을 가리지 않는다
  const edge =
    "group/edge absolute inset-y-0 z-10 hidden w-8 items-center opacity-0 transition-opacity duration-300 ease-[var(--ease-out-expo)] group-hover/banner:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:flex md:!hidden";
  const chevron = "text-du-deep-dark transition-transform duration-200 ease-[var(--ease-out-expo)]";

  return (
    <section
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      className="group/banner"
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") hovering.current = true;
      }}
      onPointerLeave={() => {
        hovering.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") step(1);
        if (e.key === "ArrowLeft") step(-1);
      }}
    >
      <div className="relative -mx-4 md:mx-0">
        <div
          ref={scroller}
          onScroll={onScroll}
          onPointerDown={stop}
          onTouchStart={stop}
          onFocusCapture={stop}
          className="no-scrollbar flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 md:grid md:grid-cols-2 md:overflow-visible md:px-0"
        >
          {track.map((s, i) => {
            const clone = loop && (i === 0 || i === track.length - 1);
            const real = loop ? (((i - 1) % count) + count) % count : i;
            return (
              <div
                key={i}
                role="group"
                aria-roledescription="slide"
                aria-label={`${names[real] ?? ""} (${real + 1} / ${count})`}
                aria-hidden={clone || undefined}
                inert={clone || undefined}
                className={cx("relative w-full shrink-0 snap-center md:w-auto md:shrink", clone && "md:hidden")}
              >
                {s}
              </div>
            );
          })}
        </div>
        {loop && (
          <>
            <button
              type="button"
              aria-label={`이전: ${names[(index - 1 + count) % count] ?? ""}`}
              onClick={() => step(-1)}
              className={cx(edge, "left-0 justify-start")}
            >
              <ChevronLeft size={18} strokeWidth={2.4} aria-hidden className={cx(chevron, "group-hover/edge:-translate-x-0.5")} />
            </button>
            <button
              type="button"
              aria-label={`다음: ${names[(index + 1) % count] ?? ""}`}
              onClick={() => step(1)}
              className={cx(edge, "right-0 justify-end")}
            >
              <ChevronRight size={18} strokeWidth={2.4} aria-hidden className={cx(chevron, "group-hover/edge:translate-x-0.5")} />
            </button>
          </>
        )}
      </div>

      {loop && (
        <div className="mt-2 flex items-center justify-center gap-1 md:hidden">
          <button type="button" aria-label={`이전: ${names[(index - 1 + count) % count] ?? ""}`} onClick={() => step(-1)} className={arrow}>
            <ChevronLeft size={18} aria-hidden />
          </button>
          <div className="flex items-center gap-1">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`${names[i] ?? `${i + 1}번째`} 보기`}
                aria-current={i === index ? "true" : undefined}
                onClick={() => {
                  stop();
                  to(i + 1, true);
                }}
                className="grid size-8 place-items-center"
              >
                <span className={cx("h-2 rounded-full transition-all duration-300 ease-[var(--ease-out-expo)]", i === index ? "w-6 bg-du-deep" : "w-2 bg-[#b9c6c2]")} />
              </button>
            ))}
          </div>
          <button type="button" aria-label={`다음: ${names[(index + 1) % count] ?? ""}`} onClick={() => step(1)} className={arrow}>
            <ChevronRight size={18} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={paused ? "자동 넘김 다시 시작" : "자동 넘김 일시정지"}
            title={paused ? "자동 넘김 다시 시작" : "자동 넘김 일시정지"}
            onClick={() => setPaused((p) => !p)}
            className="ml-1 grid size-8 place-items-center rounded-full border border-line bg-surface text-[#3d4744] transition-colors duration-150 hover:bg-canvas"
          >
            {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
          </button>
        </div>
      )}
    </section>
  );
}
