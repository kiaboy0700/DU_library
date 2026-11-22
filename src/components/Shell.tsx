"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Armchair, BellRing, ChartNoAxesColumn, ChevronDown, ClipboardList, House, Inbox, LogOut, MonitorDot, QrCode, Settings, TriangleAlert, UserRound, Users, X } from "lucide-react";
import { NotificationBell } from "./NotificationBell";
import { useApp } from "./Providers";
import { useSettings } from "@/lib/hooks";
import { rpc } from "@/lib/supabase";
import { cx, fmtTime } from "@/lib/util";

const NAV = [
  { href: "/", label: "홈", icon: House, match: (p: string) => p === "/" || p.startsWith("/rooms") },
  { href: "/me", label: "내 좌석", icon: Armchair, match: (p: string) => p.startsWith("/me") || p.startsWith("/s/") },
  { href: "/stats", label: "혼잡도", icon: ChartNoAxesColumn, match: (p: string) => p.startsWith("/stats") },
];
// 관리자는 좌석을 쓰지 않으므로 메뉴가 다르다
const ADMIN_NAV = [
  { href: "/admin", label: "관제", icon: MonitorDot, match: (p: string) => p.startsWith("/admin") && !p.startsWith("/admin/reports") && !p.startsWith("/admin/users") },
  { href: "/admin/reports", label: "처리 대기", icon: Inbox, match: (p: string) => p.startsWith("/admin/reports") },
  { href: "/admin/users", label: "학생", icon: Users, match: (p: string) => p.startsWith("/admin/users") },
  { href: "/stats", label: "혼잡도", icon: ChartNoAxesColumn, match: (p: string) => p.startsWith("/stats") },
];

interface PendingItem {
  key: string;
  kind: "신고" | "도움 요청" | "이의신청";
  title: string;
  sub: string;
}

/** 관리자의 처리 대기 목록 (신고·도움 요청·이의신청). 알림이 오면 바로 다시 불러온다 */
function usePending(enabled: boolean, pulse: number) {
  const [items, setItems] = useState<PendingItem[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      rpc<{
        reports: { id: number; room_name: string; seat_label: string; owner_name: string; respond_deadline: string }[];
        helps: { id: number; name: string; student_id: string; reason: string }[];
        appeals: { id: number; name: string; student_id: string; points: number }[];
      }>("admin_overview")
        .then((o) => {
          if (!live) return;
          setItems([
            ...o.reports.map((r) => ({ key: `r${r.id}`, kind: "신고" as const, title: `${r.room_name} ${r.seat_label} 자리비움 신고`, sub: `이용자 ${r.owner_name} · 응답 기한 ${fmtTime(r.respond_deadline)}` })),
            ...o.helps.map((h) => ({ key: `h${h.id}`, kind: "도움 요청" as const, title: h.reason, sub: `${h.name} ${h.student_id}` })),
            ...o.appeals.map((x) => ({ key: `a${x.id}`, kind: "이의신청" as const, title: `벌점 ${x.points}점 이의신청`, sub: `${x.name} ${x.student_id}` })),
          ]);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [enabled, pulse]);
  return items;
}

const SEEN_KEY = "du-admin-alerts-closed";
const readClosed = () => {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]"));
  } catch {
    return new Set<string>();
  }
};

/**
 * 관리자 팝업 알림: 신고·도움 요청·이의신청이 들어오면 화면 구석에 떠서 닫을 때까지 남는다.
 * 닫아도 '처리 대기' 화면과 메뉴의 숫자에는 그대로 남아 있다.
 */
function AdminAlerts({ items, hidden }: { items: PendingItem[]; hidden: boolean }) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  useEffect(() => setClosed(readClosed()), []);
  const close = (keys: string[]) =>
    setClosed((c) => {
      const n = new Set([...c, ...keys]);
      try {
        sessionStorage.setItem(SEEN_KEY, JSON.stringify([...n].slice(-200)));
      } catch {}
      return n;
    });
  const open = items.filter((i) => !closed.has(i.key));
  if (hidden || open.length === 0) return null;
  const shown = open.slice(0, 3);

  return (
    <div role="region" aria-label="새 처리 대기 알림" aria-live="assertive" className="no-print fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[360px]">
      {shown.map((i) => (
        <div key={i.key} className="rise rounded-[var(--radius-panel)] border border-danger/40 bg-surface p-3.5 shadow-[var(--shadow-float)]">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-danger-tint text-danger">
              <BellRing size={16} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-danger">새 {i.kind}</p>
              <p className="font-bold leading-snug">{i.title}</p>
              <p className="tabular truncate text-[13px] text-muted">{i.sub}</p>
            </div>
            <button type="button" aria-label="알림 닫기" onClick={() => close([i.key])} className="-m-1.5 grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-canvas">
              <X size={16} aria-hidden />
            </button>
          </div>
          <Link
            href="/admin/reports"
            onClick={() => close(open.map((x) => x.key))}
            className="mt-3 flex min-h-10 items-center justify-center rounded-[var(--radius-ctl)] bg-du-deep text-sm font-semibold text-white hover:bg-du-deep-dark"
          >
            처리하러 가기
          </Link>
        </div>
      ))}
      {open.length > shown.length && (
        <Link href="/admin/reports" onClick={() => close(open.map((x) => x.key))} className="rounded-[var(--radius-ctl)] bg-du-black px-3 py-2 text-center text-sm font-semibold text-white">
          외 {open.length - shown.length}건 더 보기
        </Link>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { status, pulse } = useApp();
  const bare = path === "/login";
  const isAdmin = status?.profile.role === "admin";
  const pendingItems = usePending(isAdmin, pulse);
  const pending = pendingItems.length;
  // 관리자가 학생용 화면(홈·좌석 선택·내 좌석)에 들어오면 관제로 보낸다
  const studentOnly = path === "/" || path.startsWith("/rooms") || path.startsWith("/me");
  useEffect(() => {
    if (isAdmin && studentOnly) router.replace("/admin");
  }, [isAdmin, studentOnly, router]);

  // 모든 화면은 로그인 후에 볼 수 있다
  useEffect(() => {
    if (status === null && !bare) router.replace(path === "/" ? "/login" : `/login?next=${encodeURIComponent(path)}`);
  }, [status, bare, path, router]);
  const items = isAdmin ? ADMIN_NAV : NAV;
  // 관리자 화면은 넓게, 좌석 배치도 화면은 중간 너비로
  const width = path.startsWith("/admin") ? "max-w-7xl" : path.startsWith("/rooms") ? "max-w-5xl" : "max-w-3xl";
  const active = status?.reservation;

  if (bare) return <>{children}</>;
  if (!status || (isAdmin && studentOnly))
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
        <div className={cx("mx-auto flex h-14 items-center gap-3 px-4", width)}>
          <Link href={isAdmin ? "/admin" : "/"} className="flex min-w-0 items-center gap-2.5 rounded-md">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white">
              <Image src="/brand/symbol.png" alt="대구대학교" width={32} height={32} priority />
            </span>
            <span className="truncate text-[17px] font-bold tracking-[-0.02em] max-[430px]:sr-only">창파도서관 좌석예약</span>
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
                  {it.href === "/admin/reports" && pending > 0 && (
                    <span className="tabular grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white" aria-label={`${pending}건 대기`}>
                      {pending}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          {!isAdmin && (
            <div className="ml-auto sm:ml-1">
              <NotificationBell />
            </div>
          )}
          <ProfileMenu pending={pending} />
        </div>
      </header>

      {active?.report_deadline && !path.startsWith("/me") && (
        <Link href="/me" className="no-print flex items-center justify-center gap-2 bg-danger px-4 py-2.5 text-sm font-semibold text-white">
          <TriangleAlert size={16} aria-hidden />
          자리 확인 요청이 왔습니다. 좌석 QR을 스캔해 주세요.
        </Link>
      )}

      {isAdmin && <AdminAlerts items={pendingItems} hidden={path.startsWith("/admin/reports")} />}

      <main id="main" className={cx("mx-auto w-full flex-1 px-4 pb-28 pt-5 sm:pb-12", width)}>
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
                  {it.href === "/admin/reports" && pending > 0 && (
                    <span className="tabular absolute right-[calc(50%-26px)] top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white ring-2 ring-surface" aria-label={`${pending}건 대기`}>
                      {pending}
                    </span>
                  )}
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
function ProfileMenu({ pending }: { pending: number }) {
  const { status, signOut } = useApp();
  const { settings } = useSettings();
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
  const admin = p.role === "admin";
  const sub = admin ? (major ?? "관리자") : `${major ? `${major} · ` : ""}${p.student_id}`;
  const item = "flex min-h-11 items-center gap-2.5 px-4 text-sm font-semibold hover:bg-canvas";
  // 관리자가 켜 둔 특수 상태: 잊고 두면 안 되는 것들
  const flags =
    admin && settings
      ? (
          [
            ["incident_mode", "장애 모드"],
            ["force_open", "운영시간 무시"],
            ["gps_disabled", "위치 확인 끔"],
          ] as const
        ).filter(([k]) => settings[k])
      : [];

  return (
    <div ref={box} className={cx("relative min-w-0 max-w-[68%] shrink sm:max-w-72", admin && "ml-auto sm:ml-2")}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${admin ? "관리자 메뉴" : "내 프로필"}: ${p.name}, ${sub}`}
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
        <div role="menu" className="rise absolute right-0 top-[calc(100%+8px)] w-64 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-du-black shadow-[var(--shadow-float)]">
          <div className="border-b border-line px-4 py-3">
            <p className="font-bold">{p.name}</p>
            {admin ? (
              <p className="text-[13px] text-muted">{p.department ?? "관리자"}</p>
            ) : (
              <>
                <p className="tabular text-[13px] text-muted">{p.student_id}</p>
                <p className="text-[13px] text-muted">
                  {p.department ?? "학과 미등록"}
                  {p.grade && ` · ${p.grade}학년`}
                </p>
              </>
            )}
          </div>
          {admin ? (
            <>
              <Link role="menuitem" href="/admin/reports" onClick={() => setOpen(false)} className={item}>
                <Inbox size={16} aria-hidden />
                처리 대기
                <span className={cx("tabular ml-auto rounded-full px-2 py-0.5 text-xs font-bold", pending > 0 ? "bg-danger text-white" : "bg-[#eaefed] text-[#3d4744]")}>{pending}건</span>
              </Link>
              <Link role="menuitem" href="/admin/seats" onClick={() => setOpen(false)} className={item}>
                <Armchair size={16} aria-hidden />
                좌석·열람실 관리
              </Link>
              <Link role="menuitem" href="/admin/qr" onClick={() => setOpen(false)} className={item}>
                <QrCode size={16} aria-hidden />
                좌석 QR
              </Link>
              <Link role="menuitem" href="/admin/settings" onClick={() => setOpen(false)} className={item}>
                <Settings size={16} aria-hidden />
                운영 설정
              </Link>
              <Link role="menuitem" href="/admin/stats" onClick={() => setOpen(false)} className={item}>
                <ClipboardList size={16} aria-hidden />
                통계·처리 기록
              </Link>
              {flags.length > 0 && (
                <Link role="menuitem" href="/admin/settings" onClick={() => setOpen(false)} className="flex flex-wrap items-center gap-1.5 border-t border-line bg-warn-tint px-4 py-2.5 text-xs font-semibold text-[#5c3d00]">
                  켜져 있음
                  {flags.map(([k, label]) => (
                    <span key={k} className={cx("rounded-md px-1.5 py-0.5", k === "incident_mode" ? "bg-danger text-white" : "bg-white/70")}>
                      {label}
                    </span>
                  ))}
                </Link>
              )}
            </>
          ) : (
            <Link role="menuitem" href="/me" onClick={() => setOpen(false)} className={item}>
              <UserRound size={16} aria-hidden />
              내 좌석·벌점
            </Link>
          )}
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
