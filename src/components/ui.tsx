"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { cx } from "@/lib/util";

type Variant = "primary" | "secondary" | "danger" | "quiet";

const VARIANT: Record<Variant, string> = {
  primary: "bg-du-deep text-white hover:bg-du-deep-dark active:bg-du-deep-dark disabled:bg-[#a9c9c2]",
  secondary: "border border-line bg-surface text-du-black hover:border-[#b9c6c2] hover:bg-canvas active:bg-[#e9eeec] disabled:text-[#9aa5a2]",
  danger: "border border-danger/35 bg-surface text-danger hover:bg-danger-tint active:bg-danger-tint disabled:opacity-50",
  quiet: "text-du-deep-dark hover:bg-du-tint active:bg-du-tint disabled:text-[#9aa5a2]",
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
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-ctl)] font-semibold transition-colors duration-150",
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
