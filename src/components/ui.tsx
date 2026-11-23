"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Info, LoaderCircle } from "lucide-react";
import { cx, fmtLeft } from "@/lib/util";

type Variant = "primary" | "secondary" | "danger" | "quiet" | "soft" | "softDanger" | "softNeutral";

const VARIANT: Record<Variant, string> = {
  primary: "bg-du-deep text-white hover:bg-du-deep-dark active:bg-du-deep-dark disabled:bg-[#a9c9c2]",
  secondary: "border border-line bg-surface text-du-black hover:border-[#b9c6c2] hover:bg-canvas active:bg-[#e9eeec] disabled:text-[#9aa5a2]",
  danger: "border border-danger/35 bg-surface text-danger hover:bg-danger-tint active:bg-danger-tint disabled:opacity-50",
  quiet: "text-du-deep-dark hover:bg-du-tint active:bg-du-tint disabled:text-[#9aa5a2]",
  // 옅게 채운 버튼: 채운 버튼(primary) 옆에서 흰 버튼보다 눈에 잘 들어온다
  soft: "bg-du-tint text-du-deep-dark hover:bg-[#d8ede8] active:bg-[#d8ede8] disabled:opacity-50",
  softDanger: "bg-danger-tint text-danger hover:bg-[#f9dcd9] active:bg-[#f9dcd9] disabled:opacity-50",
  softNeutral: "bg-[#e9eeec] text-du-black hover:bg-[#dde4e1] active:bg-[#dde4e1] disabled:opacity-50",
};

export function Button({
  variant = "secondary",
  size = "md",
  busy,
  className,
  children,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-ctl)] font-semibold transition-colors duration-150",
        size === "sm" && "min-h-9 px-3 text-[13px]",
        size === "md" && "min-h-11 px-4 text-sm",
        size === "lg" && "min-h-[52px] px-5 text-base",
        VARIANT[variant],
        className,
      )}
    >
      {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** 누르는 동안 자동으로 busy 처리하고, 실패는 onError 로 넘긴다 */
export function useAction(onError: (msg: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  async function run(key: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : "오류가 발생했습니다.");
    } finally {
      setBusy(null);
    }
  }
  return { busy, run };
}

export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={cx("rounded-[var(--radius-panel)] border border-line bg-surface", className)}>
      {children}
    </section>
  );
}

export function Tag({ tone = "neutral", children }: { tone?: "neutral" | "deep" | "warn" | "danger"; children: React.ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-semibold",
        tone === "neutral" && "bg-[#eaefed] text-[#3d4744]",
        tone === "deep" && "bg-du-tint text-du-deep-dark",
        tone === "warn" && "bg-warn-tint text-warn",
        tone === "danger" && "bg-danger-tint text-danger",
      )}
    >
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "block min-h-11 w-full rounded-[var(--radius-ctl)] border border-[#c3cfcb] bg-surface px-3 text-[15px] placeholder:text-[#6f7b77] hover:border-[#9fb0ab] focus:border-du-deep focus:outline-2 focus:outline-offset-0 focus:outline-du-deep/25 disabled:bg-canvas";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("skeleton", className)} />;
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-[#8b9794]">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "info", icon, children }: { tone?: "info" | "warn" | "danger"; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cx(
        "flex items-start gap-2.5 rounded-[var(--radius-ctl)] px-3.5 py-3 text-sm",
        tone === "info" && "bg-du-tint text-[#0b4f45]",
        tone === "warn" && "bg-warn-tint text-[#5c3d00]",
        tone === "danger" && "bg-danger-tint text-[#7d1a14]",
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 1초마다 갱신되는 현재 시각(ms). 카운트다운용 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** 남은 시간. 1분 넘게 남았으면 분 단위, 마지막 1분은 초 단위로 줄어든다 */
export function TimeLeft({ at }: { at: string }) {
  const now = useNow(1000);
  return <>{fmtLeft(new Date(at).getTime() - now)}</>;
}

/** 확인 창: 되돌릴 수 없거나 불이익이 따르는 동작 앞에 한 번 묻는다 */
export function Confirm({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center bg-du-black/45 p-5" onClick={onClose}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-h" className="pop w-full max-w-[340px] rounded-2xl bg-surface p-5 shadow-[0_16px_40px_-12px_rgb(0_40_34/0.45)]" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-h" className="flex items-center gap-1.5 text-lg font-bold">
          {title}
        </h2>
        {children && <div className="mt-2 text-[15px] leading-relaxed">{children}</div>}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button onClick={onClose}>닫기</Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} autoFocus onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 계속 쌓이는 목록을 접어 둔다. 처음에는 limit 개만 보여 주고, 아래 버튼으로 펼치고 접는다.
 * shown 을 그리고, 목록 바로 아래에 toggle 을 둔다.
 */
export function useFold<T>(items: T[], limit = 3) {
  const [open, setOpen] = useState(false);
  const extra = items.length - limit;
  const shown = open || extra <= 0 ? items : items.slice(0, limit);
  const toggle =
    extra > 0 ? (
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center justify-center gap-1 border-t border-line text-sm font-semibold text-du-deep-dark transition-colors duration-150 hover:bg-canvas"
      >
        {open ? "접기" : `${extra}건 더 보기`}
        <ChevronDown size={16} aria-hidden className={cx("transition-transform duration-150", open && "rotate-180")} />
      </button>
    ) : null;
  return { shown, toggle };
}

/** 시간 연장: 분은 관리자가 정한다. left 를 주면 지금 남은 시간을 함께 보여 준다 */
export function GraceControl({
  label,
  busy,
  onGive,
  className,
  initial = 15,
  max = 180,
  left,
}: {
  label: string;
  busy?: boolean;
  onGive: (minutes: number) => void;
  className?: string;
  initial?: number;
  max?: number;
  /** 지금 남은 시간(밀리초) */
  left?: number;
}) {
  const [m, setM] = useState(initial);
  return (
    <div className={className}>
      {left !== undefined && (
        <p className="mb-1 text-[13px]">
          {label} <b className={cx("tabular", left < 3 * 60_000 && "text-danger")}>{left > 0 ? `${fmtLeft(left)} 남음` : "지남"}</b>
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          max={max}
          inputMode="numeric"
          aria-label={`${label} 연장할 시간(분)`}
          value={m}
          onChange={(e) => setM(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
          className="tabular h-11 w-16 shrink-0 rounded-[var(--radius-ctl)] border border-[#c3cfcb] bg-surface px-2 text-right text-[15px]"
        />
        <Button className="min-w-0 flex-1" busy={busy} onClick={() => onGive(m)}>
          {label} {m}분 연장
        </Button>
      </div>
    </div>
  );
}

/** 접히는 카드: 여러 건이 쌓여도 한 줄씩만 보이고, 누른 것만 펼쳐진다 */
export function FoldPanel({ head, children, defaultOpen = false }: { head: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Panel className="overflow-hidden">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-[52px] w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-canvas">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{head}</span>
        <ChevronDown size={18} aria-hidden className={cx("shrink-0 text-muted transition-transform duration-150", open && "rotate-180")} />
      </button>
      {open && <div className="border-t border-line p-4">{children}</div>}
    </Panel>
  );
}

/** 버튼 줄: 한 줄에 놓인 버튼들을 같은 너비·높이로 맞춘다. 좁은 화면에서는 두 개씩 */
export function ActionRow({ children, className, wide = 4 }: { children: React.ReactNode; className?: string; wide?: 2 | 3 | 4 }) {
  return <div className={cx("grid grid-cols-2 gap-2 [&>*]:w-full [&>*]:min-w-0", wide === 4 ? "sm:grid-cols-4" : wide === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", className)}>{children}</div>;
}

/** 조건 한 줄: 규칙을 한곳에 모아 설명하지 않고, 그 행동을 하려는 자리에서 그 행동의 조건만 알려 준다 */
export function Hint({ children, className, tone = "muted" }: { children: React.ReactNode; className?: string; tone?: "muted" | "danger" }) {
  return (
    <p className={cx("flex items-start gap-1.5 text-[13px] leading-snug", tone === "danger" ? "text-danger" : "text-[#3d4744]", className)}>
      <Info size={14} className="mt-[2px] shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
