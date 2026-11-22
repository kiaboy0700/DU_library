"use client";

import { Children, useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cx } from "@/lib/util";

/**
 * 좌우로 넘겨 보는 배너. 한 번에 한 장만 보이고, 건드리지 않으면 자동으로 다음 장으로 넘어간다.
 * 배너를 누르거나 밀거나 키보드로 들어오면 자동 넘김이 멈추고, 재생 버튼으로 다시 켤 수 있다.
 * 넓은 화면(sm 이상)에서는 넘길 필요 없이 나란히 놓인다.
 */
export function Banner({ label, names, interval = 5000, children }: { label: string; names: string[]; interval?: number; children: React.ReactNode }) {
  const slides = Children.toArray(children);
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = slides.length;

  const go = useCallback((i: number) => {
    const el = scroller.current;
    const target = el?.children[i] as HTMLElement | undefined;
    if (!el || !target) return;
    el.scrollTo({ left: target.offsetLeft - el.offsetLeft, behavior: "smooth" });
  }, []);

  // 자동 넘김: 좁은 화면에서, 움직임 줄이기를 켜지 않았고, 탭이 보일 때만
  useEffect(() => {
    if (paused || count < 2) return;
    const wide = window.matchMedia("(min-width: 640px)");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const t = setInterval(() => {
      if (wide.matches || calm.matches || document.hidden) return;
      const el = scroller.current;
      if (!el) return;
      const cur = Math.round(el.scrollLeft / el.clientWidth);
      go((cur + 1) % count);
    }, interval);
    return () => clearInterval(t);
  }, [paused, count, interval, go]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setIndex(Math.min(count - 1, Math.round(el.scrollLeft / Math.max(1, el.clientWidth))));
  };
  const touch = () => setPaused(true);

  return (
    <section role="region" aria-roledescription="carousel" aria-label={label}>
      <div
        ref={scroller}
        onScroll={onScroll}
        onPointerDown={touch}
        onTouchStart={touch}
        onWheel={touch}
        onFocusCapture={touch}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-4 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0"
      >
        {slides.map((s, i) => (
          <div key={i} role="group" aria-roledescription="slide" aria-label={`${names[i] ?? ""} (${i + 1} / ${count})`} className="w-full shrink-0 snap-center sm:w-auto sm:shrink">
            {s}
          </div>
        ))}
      </div>

      {count > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3 sm:hidden">
          <div className="flex items-center gap-1">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`${names[i] ?? `${i + 1}번째`} 보기`}
                aria-current={i === index ? "true" : undefined}
                onClick={() => {
                  setPaused(true);
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
      )}
    </section>
  );
}
