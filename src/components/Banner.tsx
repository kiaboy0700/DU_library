"use client";

import { Children, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { cx } from "@/lib/util";

/**
 * 좌우로 넘겨 보는 배너. 한 번에 한 장만 보이고, 건드리지 않으면 자동으로 다음 장으로 넘어간다.
 *  - 손가락으로 밀거나, 양옆의 화살표·아래 점·키보드 좌우 키로 넘긴다
 *  - 마우스를 올리고 있는 동안에는 잠깐 멈추고, 누르거나 밀면 자동 넘김이 꺼진다 (재생 버튼으로 다시 켠다)
 *  - 화살표는 마우스가 있는 기기에서만 보이며, 배너에 마우스를 올리면 또렷해진다
 */
export function Banner({ label, names, interval = 5000, children }: { label: string; names: string[]; interval?: number; children: React.ReactNode }) {
  const slides = Children.toArray(children);
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const hovering = useRef(false);
  const count = slides.length;

  const go = useCallback(
    (i: number) => {
      const el = scroller.current;
      const n = ((i % count) + count) % count;
      const target = el?.children[n] as HTMLElement | undefined;
      if (!el || !target) return;
      el.scrollTo({ left: target.offsetLeft - el.offsetLeft, behavior: "smooth" });
    },
    [count],
  );
  const current = () => {
    const el = scroller.current;
    return el ? Math.round(el.scrollLeft / Math.max(1, el.clientWidth)) : 0;
  };

  // 자동 넘김: 움직임 줄이기를 켜지 않았고, 탭이 보이고, 마우스가 올라가 있지 않을 때만
  useEffect(() => {
    if (paused || count < 2) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const t = setInterval(() => {
      if (calm.matches || document.hidden || hovering.current) return;
      go(current() + 1);
    }, interval);
    return () => clearInterval(t);
  }, [paused, count, interval, go]);

  const stop = () => setPaused(true);
  const step = (d: number) => {
    stop();
    go(current() + d);
  };

  const arrow = "absolute top-1/2 z-10 hidden size-10 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface text-du-black shadow-[var(--shadow-float)] transition-[opacity,transform] duration-200 ease-[var(--ease-out-expo)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:scale-110 active:scale-95 [@media(hover:hover)]:grid";

  return (
    <section
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      className="group relative"
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
      <div
        ref={scroller}
        onScroll={() => setIndex(Math.min(count - 1, current()))}
        onPointerDown={stop}
        onTouchStart={stop}
        onFocusCapture={stop}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-4"
      >
        {slides.map((s, i) => (
          <div key={i} role="group" aria-roledescription="slide" aria-label={`${names[i] ?? ""} (${i + 1} / ${count})`} className="w-full shrink-0 snap-center">
            {s}
          </div>
        ))}
      </div>

      {count > 1 && (
        <>
          {/* 양옆 화살표: 마우스를 올리면 나타난다 */}
          <button type="button" aria-label={`이전: ${names[(index - 1 + count) % count] ?? ""}`} onClick={() => step(-1)} className={cx(arrow, "-left-3 sm:-left-5")}>
            <ChevronLeft size={20} aria-hidden />
          </button>
          <button type="button" aria-label={`다음: ${names[(index + 1) % count] ?? ""}`} onClick={() => step(1)} className={cx(arrow, "-right-3 sm:-right-5")}>
            <ChevronRight size={20} aria-hidden />
          </button>

          <div className="mt-3 flex items-center justify-center gap-3">
            <div className="flex items-center gap-1">
              {slides.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`${names[i] ?? `${i + 1}번째`} 보기`}
                  aria-current={i === index ? "true" : undefined}
                  onClick={() => {
                    stop();
                    go(i);
                  }}
                  className="grid size-8 place-items-center"
                >
                  <span className={cx("h-2 rounded-full transition-all duration-300 ease-[var(--ease-out-expo)]", i === index ? "w-6 bg-du-deep" : "w-2 bg-[#b9c6c2]")} />
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label={paused ? "자동 넘김 다시 시작" : "자동 넘김 일시정지"}
              title={paused ? "자동 넘김 다시 시작" : "자동 넘김 일시정지"}
              onClick={() => setPaused((p) => !p)}
              className="grid size-8 place-items-center rounded-full border border-line bg-surface text-[#3d4744] transition-colors duration-150 hover:bg-canvas"
            >
              {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
