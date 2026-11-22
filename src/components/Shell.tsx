"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Armchair, ChartNoAxesColumn, ChevronDown, House, LogOut, ShieldCheck, TriangleAlert, UserRound } from "lucide-react";
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
  const router = useRouter();
  const { status } = useApp();
  const bare = path === "/login";

  // 모든 화면은 로그인 후에 볼 수 있다
  useEffect(() => {
    if (status === null && !bare) router.replace(path === "/" ? "/login" : `/login?next=${encodeURIComponent(path)}`);
  }, [status, bare, path, router]);
  const items = status?.profile.role === "admin" ? [...NAV, ADMIN] : NAV;
  const wide = path.startsWith("/admin");
  const active = status?.reservation;

  if (bare) return <>{children}</>;
  if (!status)
    return (
      <div className="grid min-h-dvh place-items-center" role="status" aria-label="불러오는 중">
        <span className="skeleton size-12 !rounded-full" />
      </div>
    );

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
            <span className="truncate text-[17px] font-bold tracking-[-0.02em]">
              <span className="max-[430px]:hidden">창파도서관 </span>좌석예약
            </span>
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
          <ProfileMenu />
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

/** 상단 바 오른쪽의 내 프로필. 누르면 내 정보와 로그아웃이 열린다 */
function ProfileMenu() {
  const { status, signOut } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!status) return null;
  const p = status.profile;
  // 상단에는 전공만 짧게: 괄호 안의 전공명, 없으면 단과대학 이름을 뺀 학과명
  const major = p.department ? (p.department.match(/\(([^)]+)\)/)?.[1] ?? p.department.replace(/^\S+\s+/, "")) : null;
  const sub = `${major ? `${major} · ` : ""}${p.student_id}`;

  return (
    <div ref={box} className="relative ml-auto min-w-0 max-w-[62%] shrink-0 sm:ml-2 sm:max-w-72">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`내 프로필: ${p.name}, ${sub}`}
        onClick={() => setOpen((o) => !o)}
        className={cx("flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 transition-colors duration-150 hover:bg-white/15", open && "bg-white/15")}
      >
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-white/20 text-sm font-bold">
          {p.name.slice(0, 1)}
        </span>
        <span className="min-w-0 text-left leading-tight">
          <span className="block truncate text-[13px] font-bold">{p.name}</span>
          <span className="tabular block truncate text-[11px] text-white/85">{sub}</span>
        </span>
        <ChevronDown size={14} aria-hidden className={cx("shrink-0 transition-transform duration-150", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="rise absolute right-0 top-[calc(100%+8px)] w-60 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-du-black shadow-[var(--shadow-float)]">
          <div className="border-b border-line px-4 py-3">
            <p className="font-bold">{p.name}</p>
            <p className="tabular text-[13px] text-muted">{p.student_id}</p>
            <p className="text-[13px] text-muted">
              {p.department ?? "학과 미등록"}
              {p.grade && ` · ${p.grade}학년`}
              {p.role === "admin" && " · 관리자"}
            </p>
          </div>
          <Link role="menuitem" href="/me" onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-2.5 px-4 text-sm font-semibold hover:bg-canvas">
            <UserRound size={16} aria-hidden />
            내 좌석·벌점
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={async () => {
              setOpen(false);
              await signOut();
              router.replace("/login");
            }}
            className="flex min-h-11 w-full items-center gap-2.5 border-t border-line px-4 text-sm font-semibold text-danger hover:bg-danger-tint"
          >
            <LogOut size={16} aria-hidden />
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
