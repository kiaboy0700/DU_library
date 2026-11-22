"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase";
import type { MyStatus } from "@/lib/types";
import { cx } from "@/lib/util";

type ToastKind = "ok" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}
interface AppCtx {
  /** undefined: 확인 중, null: 로그아웃 상태 */
  status: MyStatus | null | undefined;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  toast: (text: string, kind?: ToastKind) => void;
  /** 좌석·알림 등 서버 상태가 바뀔 때마다 증가. 화면들이 다시 불러오는 신호 */
  pulse: number;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("Providers 밖에서 useApp 을 사용했습니다.");
  return c;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<MyStatus | null | undefined>(undefined);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pulse, setPulse] = useState(0);
  const nextId = useRef(1);

  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 4000);
  }, []);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await rpc<MyStatus>("my_status"));
    } catch {
      setStatus(null);
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setStatus(null);
  }, []);

  useEffect(() => {
    refresh();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "TOKEN_REFRESHED") setTimeout(refresh, 0);
    });
    return () => data.subscription.unsubscribe();
  }, [refresh]);

  // 내 예약·알림의 실시간 반영 + 주기적 보정
  const uid = status?.profile.id;
  useEffect(() => {
    if (!uid) return;
    const ch = supabase
      .channel(`me-${uid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations", filter: `user_id=eq.${uid}` }, () => {
        refresh();
        setPulse((p) => p + 1);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid}` }, (payload) => {
        const n = payload.new as { title: string; url: string };
        // 관리자용 알림은 닫을 때까지 남는 팝업(Shell의 AdminAlerts)으로 보여 준다
        if (!n.url?.startsWith("/admin")) toast(n.title, "info");
        refresh();
        setPulse((p) => p + 1);
      })
      .subscribe();
    const timer = setInterval(refresh, 30000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [uid, refresh, toast]);

  // 푸시 수신용 서비스 워커
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  const value = useMemo(() => ({ status, refresh, signOut, toast, pulse }), [status, refresh, signOut, toast, pulse]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="no-print pointer-events-none fixed inset-x-0 top-16 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "rise pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-[var(--radius-ctl)] border bg-surface px-3.5 py-3 text-sm shadow-[var(--shadow-float)]",
              t.kind === "error" ? "border-danger/40" : "border-line",
            )}
          >
            {t.kind === "ok" && <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-du-deep" aria-hidden />}
            {t.kind === "error" && <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />}
            {t.kind === "info" && <Info size={18} className="mt-0.5 shrink-0 text-du-deep" aria-hidden />}
            <p className="min-w-0 flex-1 font-medium">{t.text}</p>
            <button
              type="button"
              aria-label="알림 닫기"
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              className="-m-1.5 grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-canvas"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
