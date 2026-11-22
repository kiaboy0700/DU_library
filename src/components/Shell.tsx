"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Armchair, ChartNoAxesColumn, House, ShieldCheck, TriangleAlert } from "lucide-react";
import { useApp } from "./Providers";
import { cx } from "@/lib/util";

const NAV = [
  { href: "/", label: "홈", icon: House, match: (p: string) => p === "/" || p.startsWith("/rooms") },
  { href: "/me", label: "내 좌석", icon: Armchair, match: (p: string) => p.startsWith("/me") || p.startsWith("/s/") },
  { href: "/stats", label: "혼잡도", icon: ChartNoAxesColumn, match: (p: string) => p.startsWith("/stats") },
];
const ADMIN = { href: "/admin", label: "관리", icon: ShieldCheck, match: (p: string) => p.startsWith("/admin") };

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { status } = useApp();
  const bare = path === "/login";
  const items = status?.profile.role === "admin" ? [...NAV, ADMIN] : NAV;
  const wide = path.startsWith("/admin");
  const active = status?.reservation;

  if (bare) return <>{children}</>;

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-semibold">
        본문으로 건너뛰기
      </a>
      <header className="on-deep no-print sticky top-0 z-40 bg-du-deep text-white">
        <div className={cx("mx-auto flex h-14 items-center gap-3 px-4", wide ? "max-w-7xl" : "max-w-3xl")}>
          <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-md">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white">
              <Image src="/brand/symbol.png" alt="대구대학교" width={32} height={32} priority />
            </span>
            <span className="truncate text-[17px] font-bold tracking-[-0.02em]">창파도서관 좌석예약</span>
          </Link>
          <nav aria-label="주 메뉴" className="ml-auto hidden items-center gap-1 sm:flex">
            {items.map((it) => {
              const on = it.match(path);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  aria-current={on ? "page" : undefined}
                  className={cx(
                    "relative flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors duration-150",
                    on ? "bg-white text-du-deep-dark" : "text-white/90 hover:bg-white/15",
                  )}
                >
                  <it.icon size={16} aria-hidden />
                  {it.label}
                  {it.href === "/me" && active && <span className={cx("size-1.5 rounded-full", on ? "bg-du-deep" : "bg-du-light")} aria-label="이용 중" />}
                </Link>
              );
            })}
          </nav>
          {status === null && (
            <Link href="/login" className="ml-auto flex h-9 items-center rounded-lg bg-white px-3.5 text-sm font-bold text-du-deep-dark sm:ml-2">
              로그인
            </Link>
          )}
        </div>
      </header>

      {active?.report_deadline && !path.startsWith("/me") && (
        <Link href="/me" className="no-print flex items-center justify-center gap-2 bg-danger px-4 py-2.5 text-sm font-semibold text-white">
          <TriangleAlert size={16} aria-hidden />
          자리 확인 요청이 왔습니다. 좌석 QR을 스캔해 주세요.
        </Link>
      )}

      <main id="main" className={cx("mx-auto w-full flex-1 px-4 pb-28 pt-5 sm:pb-12", wide ? "max-w-7xl" : "max-w-3xl")}>
        {children}
      </main>

      <nav
        aria-label="주 메뉴"
        className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        <ul className="mx-auto flex max-w-3xl">
          {items.map((it) => {
            const on = it.match(path);
            return (
              <li key={it.href} className="flex-1">
                <Link
                  href={it.href}
                  aria-current={on ? "page" : undefined}
                  className={cx("relative flex h-[60px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold", on ? "text-du-deep-dark" : "text-muted")}
                >
                  <span className={cx("grid h-7 w-14 place-items-center rounded-full transition-colors duration-150", on && "bg-du-tint")}>
                    <it.icon size={20} strokeWidth={on ? 2.4 : 2} aria-hidden />
                  </span>
                  {it.label}
                  {it.href === "/me" && active && <span className="absolute right-[calc(50%-22px)] top-2 size-2 rounded-full bg-du-green ring-2 ring-surface" aria-label="이용 중" />}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
