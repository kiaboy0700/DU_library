"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ShieldX } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Empty, Skeleton } from "@/components/ui";
import { cx } from "@/lib/util";

const TABS = [
  { href: "/admin", label: "관제" },
  { href: "/admin/reports", label: "처리 대기" },
  { href: "/admin/users", label: "학생·제재" },
  { href: "/admin/seats", label: "좌석·열람실" },
  { href: "/admin/qr", label: "좌석 QR" },
  { href: "/admin/settings", label: "운영 설정" },
  { href: "/admin/stats", label: "통계·기록" },
  { href: "/admin/demo", label: "시연" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { status } = useApp();
  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === null) router.replace("/login");
  }, [status, router, path]);

  if (status === undefined || status === null) return <Skeleton className="h-64 !rounded-[var(--radius-panel)]" />;
  if (status.profile.role !== "admin")
    return (
      <Empty icon={<ShieldX size={36} strokeWidth={1.6} aria-hidden />} title="관리자만 볼 수 있는 화면입니다">
        <Link href="/" className="font-semibold text-du-deep-dark underline underline-offset-4">
          홈으로 돌아가기
        </Link>
      </Empty>
    );

  return (
    <div>
      <nav aria-label="관리 메뉴" className="no-print -mx-4 mb-5 overflow-x-auto border-b border-line px-4">
        <ul className="flex gap-1">
          {TABS.map((t) => {
            const on = t.href === "/admin" ? path === "/admin" : path.startsWith(t.href);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={on ? "page" : undefined}
                  className={cx(
                    "flex h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-semibold transition-colors duration-150",
                    on ? "border-du-deep text-du-deep-dark" : "border-transparent text-muted hover:text-du-black",
                  )}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {children}
    </div>
  );
}
