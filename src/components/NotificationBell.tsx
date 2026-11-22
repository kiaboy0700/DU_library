"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { useApp } from "./Providers";
import { disablePush, enablePush, pushEnabled } from "@/lib/push";
import { supabase } from "@/lib/supabase";
import type { Notice } from "@/lib/types";
import { cx, errMsg, fmtDateTime } from "@/lib/util";

/** 상단 바의 알림 종. 읽지 않은 알림 수를 배지로 보여 주고, 누르면 알림 목록이 열린다 */
export function NotificationBell() {
  const { status, refresh, toast, pulse } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[] | null>(null);
  const [push, setPush] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const uid = status?.profile.id;
  const unread = status?.unread ?? 0;

  const load = useCallback(async () => {
    if (!uid) return;
    const { data } = await supabase.from("notifications").select("id,title,body,url,created_at,read_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20);
    setItems((data as Notice[]) ?? []);
    // 목록을 열어 본 알림은 읽음 처리 (배지가 사라진다)
    if (data?.some((n) => !n.read_at)) {
      await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", uid).is("read_at", null);
      refresh();
    }
  }, [uid, refresh]);

  // 열려 있는 동안 새 알림이 오면 바로 반영
  useEffect(() => {
    if (open) load();
  }, [open, load, pulse]);

  useEffect(() => {
    pushEnabled().then(setPush);
  }, []);

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

  async function togglePush() {
    if (busy || !uid) return;
    setBusy(true);
    try {
      if (push) {
        await disablePush();
        setPush(false);
        toast("이 기기의 푸시 알림을 껐습니다.");
      } else {
        await enablePush(uid);
        setPush(true);
        toast("푸시 알림을 켰습니다. 사이트를 닫아도 알려 드립니다.", "ok");
      }
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `알림, 읽지 않은 알림 ${unread}개` : "알림"}
        onClick={() => setOpen((o) => !o)}
        className={cx("relative grid size-10 place-items-center rounded-lg transition-colors duration-150 hover:bg-white/15", open && "bg-white/15")}
      >
        {unread > 0 ? <BellRing size={21} aria-hidden /> : <Bell size={21} aria-hidden />}
        {unread > 0 && (
          <span className="tabular absolute right-0.5 top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white ring-2 ring-du-deep">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="알림"
          className="rise fixed inset-x-3 top-[60px] z-50 flex max-h-[min(72vh,560px)] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-du-black shadow-[var(--shadow-float)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+8px)] sm:w-[380px]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="font-bold">알림</h2>
            {push !== null && (
              <button
                type="button"
                aria-pressed={push}
                disabled={busy}
                onClick={togglePush}
                className={cx(
                  "flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors duration-150",
                  push ? "border-du-deep/40 bg-du-tint text-du-deep-dark" : "border-line hover:bg-canvas",
                )}
              >
                {push ? <BellRing size={14} aria-hidden /> : <BellOff size={14} aria-hidden />}
                {push ? "푸시 켜짐" : "푸시 알림 켜기"}
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {items === null ? (
              <div className="space-y-2 p-4">
                <div className="skeleton h-12" />
                <div className="skeleton h-12" />
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">알림이 없습니다</p>
            ) : (
              <ul className="divide-y divide-line">
                {items.map((n) => (
                  <li key={n.id}>
                    <Link href={n.url || "/me"} onClick={() => setOpen(false)} className={cx("flex gap-3 px-4 py-3 hover:bg-canvas", !n.read_at && "bg-du-tint/60")}>
                      <span aria-hidden className={cx("mt-2 size-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-danger")} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">
                          {!n.read_at && <span className="sr-only">새 알림: </span>}
                          {n.title}
                        </span>
                        <span className="block text-sm text-[#3d4744]">{n.body}</span>
                        <span className="tabular mt-0.5 block text-xs text-muted">{fmtDateTime(n.created_at)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
