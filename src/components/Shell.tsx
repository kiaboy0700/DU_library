"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Armchair, BellRing, ChartNoAxesColumn, ChevronDown, ClipboardList, House, Inbox, LayoutGrid, LogOut, Megaphone, MonitorDot, QrCode, ScanLine, Settings, TriangleAlert, UserRound, Users, X } from "lucide-react";
import { NotificationBell } from "./NotificationBell";
import { QrScanner } from "./QrScanner";
import { useApp } from "./Providers";
import { rpc } from "@/lib/supabase";
import { cx, fmtRemain, fmtTime } from "@/lib/util";
import { useNow } from "./ui";

const NAV = [
  { href: "/", label: "홈", icon: House, match: (p: string) => p === "/" },
  { href: "/rooms", label: "열람실", icon: LayoutGrid, match: (p: string) => p.startsWith("/rooms") },
  { href: "/me", label: "내 좌석", icon: Armchair, match: (p: string) => p.startsWith("/me") || p.startsWith("/s/") },
  { href: "/stats", label: "혼잡도", icon: ChartNoAxesColumn, match: (p: string) => p.startsWith("/stats") },
];
// 관리자는 좌석을 쓰지 않으므로 메뉴가 다르다
const ADMIN_NAV = [
  { href: "/admin", label: "관제", icon: MonitorDot, match: (p: string) => p.startsWith("/admin") && !p.startsWith("/admin/reports") && !p.startsWith("/admin/users") },
  { href: "/admin/reports", label: "처리 대기", icon: Inbox, match: (p: string) => p.startsWith("/admin/reports") },
  { href: "/admin/users", label: "학생", icon: Users, match: (p: string) => p.startsWith("/admin/users") },
  { href: "/notices", label: "공지", icon: Megaphone, match: (p: string) => p.startsWith("/notices") },
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
  // 여러 건이 와도 화면을 덮지 않게 가장 최근 한 건만 펼치고, 나머지는 건수로 알린다
  const shown = open.slice(-1);

  return (
    <div role="region" aria-label="새 처리 대기 알림" aria-live="assertive" className="no-print fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[360px]">
      {shown.map((i) => (
        <div key={i.key} className="rise rounded-[var(--radius-panel)] border border-danger/40 bg-surface p-3.5 shadow-[var(--shadow-float)]">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-danger-tint text-danger">
              <BellRing size={16} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-danger">
                새 {i.kind}
                {open.length > 1 && <span className="tabular"> · 외 {open.length - 1}건</span>}
              </p>
              <p className="font-bold leading-snug">{i.title}</p>
              <p className="tabular truncate text-[13px] text-muted">{i.sub}</p>
            </div>
            <button type="button" aria-label="알림 모두 닫기" onClick={() => close(open.map((x) => x.key))} className="-m-1.5 grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-canvas">
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
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { status, pulse } = useApp();
  const bare = path === "/login";
  const isAdmin = status?.profile.role === "admin";
  const [scan, setScan] = useState(false);
  const pendingItems = usePending(isAdmin, pulse);
  const pending = pendingItems.length;
  // 관리자가 학생용 화면(홈·좌석 선택·내 좌석)에 들어오면 관제로 보낸다
  const studentOnly = path === "/" || path.startsWith("/rooms") || path.startsWith("/me");
  useEffect(() => {
    if (isAdmin && studentOnly) router.replace("/admin");
  }, [isAdmin, studentOnly, router]);
  // 학생이 관리자 화면 주소로 들어오면 (직접 입력하든 링크로 오든) 홈으로 돌려보낸다
  const adminOnly = path.startsWith("/admin");
  const intruding = !!status && !isAdmin && adminOnly;
  useEffect(() => {
    if (intruding) router.replace("/");
  }, [intruding, router]);

  // 모든 화면은 로그인 후에 볼 수 있다
  useEffect(() => {
    if (status === null && !bare) router.replace("/login");
  }, [status, bare, path, router]);
  const items = isAdmin ? ADMIN_NAV : NAV;
  // 관리자 화면은 넓게, 좌석 배치도 화면은 중간 너비로
  const width = path.startsWith("/admin") ? "max-w-7xl" : path.startsWith("/rooms") ? "max-w-5xl" : "max-w-3xl";
  const active = status?.reservation;

  if (bare) return <>{children}</>;
  if (!status || (isAdmin && studentOnly) || intruding)
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
      <header className="no-print sticky top-0 z-40 border-b border-line bg-surface pt-[env(safe-area-inset-top)] text-du-black">
        <div className={cx("mx-auto flex h-[60px] items-center gap-2 px-4", isAdmin ? "max-w-7xl" : "max-w-5xl")}>
          <Link href={isAdmin ? "/admin" : "/"} aria-label="대구대학교 창파도서관 좌석예약, 처음 화면으로" className="flex shrink-0 items-center gap-3 rounded-md">
            <Image src="/brand/signature.png" alt="대구대학교" width={500} height={147} priority className="h-9 w-auto" />
            <span className="hidden border-l border-line pl-3 text-[15px] font-bold tracking-[-0.02em] text-[#3d4744] lg:block">창파도서관 좌석예약</span>
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
                    "relative flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors duration-150",
                    on ? "bg-du-tint text-du-deep-dark" : "text-[#3d4744] hover:bg-canvas",
                  )}
                >
                  <it.icon size={16} aria-hidden />
                  {it.label}
                  {it.href === "/me" && active && <span className="size-1.5 rounded-full bg-du-green" aria-label="이용 중" />}
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
            <div className="ml-auto flex items-center sm:ml-1">
              <button type="button" aria-label="좌석 QR 스캔" title="좌석 QR 스캔" onClick={() => setScan(true)} className="grid size-11 place-items-center rounded-lg transition-colors duration-150 hover:bg-canvas">
                <ScanLine size={24} strokeWidth={1.9} aria-hidden />
              </button>
              <NotificationBell />
            </div>
          )}
          <ProfileMenu pending={pending} />
        </div>
      </header>

      {scan && (
        <QrScanner
          onToken={(t) => {
            setScan(false);
            router.push(`/s/${t}`);
          }}
          onClose={() => setScan(false)}
          seat={status.move ? { label: status.move.seat_label, room: `${status.move.room_name} · 옮길 좌석` } : active ? { label: active.seat_label, room: active.room_name } : undefined}
          deadline={status.move ? { label: "이동 마감까지", at: status.move.expires_at } : undefined}
        />
      )}

      {status.move && <MoveBar onScan={() => setScan(true)} />}

      {active?.report_deadline && !path.startsWith("/me") && (
        <Link href="/me" className="no-print flex items-center justify-center gap-2 bg-danger px-4 py-2.5 text-sm font-semibold text-white">
          <TriangleAlert size={16} aria-hidden />
          자리 확인 요청이 왔습니다. 좌석 QR을 스캔해 주세요.
        </Link>
      )}

      {isAdmin && <AdminAlerts items={pendingItems} hidden={path.startsWith("/admin/reports")} />}

      <main id="main" className={cx("mx-auto w-full flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-5 sm:pb-12", width)}>
        {children}
      </main>

      <nav
        aria-label="주 메뉴"
        className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[max(env(safe-area-inset-bottom),6px)] sm:hidden"
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

/** 자리 이동 중: 맡아 둔 좌석과 남은 시간. 그 좌석의 QR을 찍으면 이동이 끝난다 */
function MoveBar({ onScan }: { onScan: () => void }) {
  const { status, refresh, toast } = useApp();
  const now = useNow();
  const m = status?.move;
  if (!m) return null;
  const left = new Date(m.expires_at).getTime() - now;
  return (
    <div className="no-print border-b border-du-deep/25 bg-du-tint">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <p className="min-w-0 flex-1 basis-52 text-sm">
          <strong className="font-bold">
            {m.room_name} {m.seat_label}
          </strong>
          로 이동 중 · <span className="tabular font-semibold">{fmtRemain(left)}</span> 안에 그 좌석의 QR을 찍으세요
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={onScan} className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-du-deep px-3.5 text-sm font-semibold text-white hover:bg-du-deep-dark">
            <ScanLine size={16} aria-hidden />
            QR 찍기
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await rpc("cancel_move");
                await refresh();
                toast("자리 이동을 취소했습니다.");
              } catch {
                toast("취소하지 못했습니다. 다시 시도해 주세요.", "error");
              }
            }}
            className="min-h-10 rounded-[var(--radius-ctl)] border border-line bg-surface px-3.5 text-sm font-semibold hover:bg-canvas"
          >
            취소
          </button>
        </div>
      </div>
    </div>
  );
}

/** 상단 바 오른쪽의 내 프로필. 누르면 내 정보와 로그아웃이 열린다 */
function ProfileMenu({ pending }: { pending: number }) {
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
  const admin = p.role === "admin";
  const sub = admin ? (major ?? "관리자") : `${major ? `${major} · ` : ""}${p.student_id}`;
  const item = "flex min-h-11 items-center gap-2.5 px-4 text-sm font-semibold hover:bg-canvas";

  return (
    <div ref={box} className={cx("relative min-w-0 shrink-0 sm:max-w-72", admin && "ml-auto sm:ml-2")}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${admin ? "관리자 메뉴" : "내 프로필"}: ${p.name}, ${sub}`}
        onClick={() => setOpen((o) => !o)}
        className={cx("flex w-full min-w-0 items-center gap-2 rounded-lg p-1 transition-colors duration-150 hover:bg-canvas sm:pr-1.5", open && "bg-canvas")}
      >
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-du-deep text-sm font-bold text-white">
          {p.name.slice(0, 1)}
        </span>
        <span className="hidden min-w-0 text-left leading-tight md:block">
          <span className="block truncate text-[13px] font-bold">{p.name}</span>
          <span className="tabular block truncate text-[11px] text-muted">{sub}</span>
        </span>
        <ChevronDown size={14} aria-hidden className={cx("hidden shrink-0 text-muted transition-transform duration-150 sm:block", open && "rotate-180")} />
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
            </>
          ) : (
            <>
              <Link role="menuitem" href="/me" onClick={() => setOpen(false)} className={item}>
                <UserRound size={16} aria-hidden />
                내 좌석·벌점
              </Link>
              <Link role="menuitem" href="/notices" onClick={() => setOpen(false)} className={item}>
                <Megaphone size={16} aria-hidden />
                공지
              </Link>
            </>
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
