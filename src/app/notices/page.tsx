"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, PenLine, Trash2 } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Empty, Field, Panel, Skeleton, Tag, inputClass, useAction, useNow, useFold } from "@/components/ui";
import { rpc, supabase } from "@/lib/supabase";
import type { Room } from "@/lib/types";
import { NOTICE_SEEN_KEY, cx, fmtDateTime } from "@/lib/util";

interface Announcement {
  id: number;
  title: string;
  body: string;
  room_id: number | null;
  until: string | null;
  created_at: string;
}

/** 공지: 학생은 읽고, 관리자는 이 화면에서 바로 쓰고 지운다 */
export default function NoticesPage() {
  const { status, toast } = useApp();
  const admin = status?.profile.role === "admin";
  const now = useNow(60000);
  const [list, setList] = useState<Announcement[] | null>(null);
  const [rooms, setRooms] = useState<Pick<Room, "id" | "name">[]>([]);
  const [writing, setWriting] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", room: "", hours: 24, push: true });
  const { busy, run } = useAction((m) => toast(m, "error"));

  const load = useCallback(async () => {
    const { data } = await supabase.from("announcements").select("*").order("created_at", { ascending: false }).limit(50);
    setList((data as Announcement[]) ?? []);
    // 읽은 곳까지 기억해 두면 홈에서 새 공지 표시가 사라진다
    try {
      if (data?.[0]) localStorage.setItem(NOTICE_SEEN_KEY, String(data[0].id));
    } catch {}
  }, []);
  useEffect(() => {
    load();
    supabase
      .from("rooms")
      .select("id,name")
      .order("floor")
      .then(({ data }) => setRooms(data ?? []));
  }, [load]);

  // 관제의 '공지 쓰기'로 들어오면 바로 쓰기 창을 연다
  useEffect(() => {
    if (admin && new URLSearchParams(window.location.search).has("write")) setWriting(true);
  }, [admin]);

  const roomName = (id: number | null) => (id ? (rooms.find((r) => r.id === id)?.name ?? "열람실") : "전체");
  const live = (a: Announcement) => !a.until || new Date(a.until).getTime() > now;
  const current = list?.filter(live) ?? [];
  const past = list?.filter((a) => !live(a)) ?? [];
  const pastFold = useFold(past, 3);

  const item = (a: Announcement, old: boolean) => (
    <li key={a.id} className={cx("flex items-start gap-3 px-4 py-3.5 sm:px-5", old && "opacity-70")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Tag tone={a.room_id ? "neutral" : "deep"}>{roomName(a.room_id)}</Tag>
          <h3 className="text-base font-bold">{a.title}</h3>
        </div>
        {a.body && <p className="mt-1 whitespace-pre-line text-[15px] text-[#3d4744]">{a.body}</p>}
        <p className="tabular mt-1 text-xs text-muted">
          {fmtDateTime(a.created_at)}
          {old ? " · 게시 종료" : a.until ? ` · ${fmtDateTime(a.until)}까지` : ""}
        </p>
      </div>
      {admin && (
        <button
          type="button"
          aria-label={`공지 "${a.title}" 삭제`}
          className="-mr-1 grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-danger-tint hover:text-danger"
          onClick={() => {
            if (!window.confirm(`"${a.title}" 공지를 삭제할까요?`)) return;
            run(`d${a.id}`, async () => {
              const { error } = await supabase.from("announcements").delete().eq("id", a.id);
              if (error) throw new Error(error.message);
              toast("공지를 삭제했습니다.", "ok");
              await load();
            });
          }}
        >
          <Trash2 size={16} aria-hidden />
        </button>
      )}
    </li>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">공지</h1>
        {admin && !writing && (
          <Button variant="primary" onClick={() => setWriting(true)}>
            <PenLine size={16} aria-hidden />
            공지 쓰기
          </Button>
        )}
      </div>

      {admin && writing && (
        <Panel className="rise p-4 sm:p-5">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run("post", async () => {
                await rpc("admin_announce", { p_title: form.title, p_body: form.body, p_room: form.room ? Number(form.room) : null, p_hours: form.hours, p_push: form.push });
                toast("공지를 올렸습니다.", "ok");
                setForm({ ...form, title: "", body: "" });
                setWriting(false);
                await load();
              });
            }}
          >
            <Field label="제목">
              <input className={inputClass} required maxLength={60} autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="예: 오늘 18시 조기 폐관" />
            </Field>
            <Field label="내용 (선택)">
              <textarea className={cx(inputClass, "py-2.5")} rows={3} maxLength={500} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="대상">
                <select className={inputClass} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })}>
                  <option value="">전체</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="게시 기간">
                <select className={inputClass} value={form.hours} onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}>
                  <option value={6}>6시간</option>
                  <option value={24}>하루</option>
                  <option value={72}>3일</option>
                  <option value={168}>일주일</option>
                  <option value={0}>삭제할 때까지</option>
                </select>
              </Field>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="size-[18px]" checked={form.push} onChange={(e) => setForm({ ...form, push: e.target.checked })} />
              푸시 알림으로도 보내기
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" busy={busy === "post"}>
                공지 올리기
              </Button>
              <Button onClick={() => setWriting(false)}>취소</Button>
            </div>
          </form>
        </Panel>
      )}

      {list === null ? (
        <Skeleton className="h-48 !rounded-[var(--radius-panel)]" />
      ) : list.length === 0 ? (
        <Panel>
          <Empty icon={<Megaphone size={36} strokeWidth={1.6} aria-hidden />} title="공지가 없습니다" />
        </Panel>
      ) : (
        <>
          <Panel className="overflow-hidden">
            {current.length === 0 ? <p className="px-4 py-6 text-sm text-muted sm:px-5">게시 중인 공지가 없습니다</p> : <ul className="divide-y divide-line">{current.map((a) => item(a, false))}</ul>}
          </Panel>
          {past.length > 0 && (
            <section aria-labelledby="past-h">
              <h2 id="past-h" className="mb-2 text-[17px] font-bold">
                지난 공지
              </h2>
              <Panel className="overflow-hidden">
                <ul className="divide-y divide-line">{pastFold.shown.map((a) => item(a, true))}</ul>
                {pastFold.toggle}
              </Panel>
            </section>
          )}
        </>
      )}
    </div>
  );
}
