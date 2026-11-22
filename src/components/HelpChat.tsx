"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, LockOpen, SendHorizontal } from "lucide-react";
import { useApp } from "./Providers";
import { rpc, supabase } from "@/lib/supabase";
import { cx, errMsg, fmtTime } from "@/lib/util";

interface Message {
  id: number;
  body: string;
  created_at: string;
  mine: boolean;
  admin: boolean;
}
interface Thread {
  open: boolean;
  messages: Message[];
}

/**
 * 도움 요청 대화. 관리자가 대화를 열어야(또는 먼저 메시지를 보내야) 학생이 보낼 수 있다.
 * admin 이면 대화를 열고 막는 버튼이 함께 나온다.
 */
export function HelpChat({ helpId, admin, className }: { helpId: number; admin?: boolean; className?: string }) {
  const { toast, pulse } = useApp();
  const [thread, setThread] = useState<Thread>({ open: false, messages: [] });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(() => rpc<Thread>("help_thread", { p_help: helpId }).then(setThread).catch(() => {}), [helpId]);
  useEffect(() => {
    load();
  }, [load, pulse]);
  // 상대가 보낸 메시지와 대화 열림·막힘이 바로 보이도록
  useEffect(() => {
    const ch = supabase
      .channel(`help-${helpId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "help_messages", filter: `help_id=eq.${helpId}` }, () => load())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "help_requests", filter: `id=eq.${helpId}` }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [helpId, load]);
  const count = thread.messages.length;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [count]);

  const locked = !admin && !thread.open;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy || locked) return;
    setBusy(true);
    try {
      await rpc("send_help_message", { p_help: helpId, p_body: body });
      setText("");
      await load();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  }
  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      await rpc("admin_help_chat", { p_help: helpId, p_open: !thread.open });
      await load();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cx("overflow-hidden rounded-[var(--radius-ctl)] border border-line", className)}>
      {admin && (
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface py-1 pl-3 pr-1">
          <span className="text-[13px] font-semibold">학생과 대화</span>
          <button
            type="button"
            aria-pressed={thread.open}
            disabled={busy}
            onClick={toggle}
            className={cx("flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-semibold transition-colors duration-150", thread.open ? "bg-du-tint text-du-deep-dark" : "text-muted hover:bg-canvas")}
          >
            {thread.open ? <LockOpen size={14} aria-hidden /> : <Lock size={14} aria-hidden />}
            {thread.open ? "학생 입력 허용됨" : "학생 입력 막힘"}
          </button>
        </div>
      )}
      {count > 0 && (
        <div ref={list} role="log" aria-label="대화" className="flex max-h-64 flex-col gap-1.5 overflow-y-auto bg-canvas p-3">
          {thread.messages.map((m) => (
            <div key={m.id} className={cx("flex max-w-[85%] flex-col", m.mine ? "items-end self-end" : "items-start self-start")}>
              {!m.mine && <span className="mb-0.5 text-xs font-semibold text-muted">{m.admin ? "관리자" : "학생"}</span>}
              <p className={cx("whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm", m.mine ? "rounded-br-md bg-du-deep text-white" : "rounded-bl-md bg-surface")}>{m.body}</p>
              <span className="tabular mt-0.5 text-[11px] text-muted">{fmtTime(m.created_at)}</span>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={send} className={cx("flex items-center gap-1 p-1.5", locked ? "bg-canvas" : "bg-surface", count > 0 && "border-t border-line")}>
        {locked && <Lock size={15} className="ml-2 shrink-0 text-muted" aria-hidden />}
        <input
          aria-label="메시지"
          placeholder={locked ? "관리자가 대화를 열면 보낼 수 있습니다" : "메시지"}
          maxLength={500}
          disabled={locked}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-10 min-w-0 flex-1 rounded-md bg-transparent px-2.5 text-[15px] placeholder:text-[#6f7b77] focus:outline-none disabled:cursor-not-allowed"
        />
        <button type="submit" aria-label="보내기" disabled={busy || locked || !text.trim()} className="grid size-10 shrink-0 place-items-center rounded-md bg-du-deep text-white transition-colors duration-150 hover:bg-du-deep-dark disabled:bg-[#a9c9c2]">
          <SendHorizontal size={18} aria-hidden />
        </button>
      </form>
    </div>
  );
}
