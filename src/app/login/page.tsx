"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Field, inputClass } from "@/components/ui";
import { emailOf, rpc, supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const { status, refresh } = useApp();
  const [sid, setSid] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 로그인 전에도 지금 빈자리 수는 보여 준다
  const [rooms, setRooms] = useState<{ id: number; name: string; total: number; free: number; pct: number; is_open: boolean }[]>([]);
  useEffect(() => {
    rpc<typeof rooms>("public_rooms")
      .then(setRooms)
      .catch(() => {});
  }, []);

  useEffect(() => {
    // 로그인하면 이전에 보던 화면과 상관없이 처음 화면으로 간다
    if (status) router.replace(status.profile.role === "admin" ? "/admin" : "/");
  }, [status, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sid.trim() || !pw) {
      setError("학번과 비밀번호를 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: emailOf(sid), password: pw });
    if (error) {
      setBusy(false);
      setError(
        error.message.includes("Invalid login") ? "학번 또는 비밀번호가 맞지 않습니다. 다시 확인해 주세요." : "로그인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    await refresh();
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[#003d34] lg:flex-row lg:bg-surface">
      {/* 창파도서관 사진. 글자가 읽히도록 아래쪽을 초록으로 덮는다 */}
      <div className="on-deep relative isolate flex flex-col overflow-hidden px-5 pb-6 pt-[max(2.75rem,env(safe-area-inset-top))] text-white lg:min-h-dvh lg:flex-1 lg:justify-between lg:p-14">
        <Image src="/brand/changpa.webp" alt="" fill priority sizes="(min-width: 1024px) 60vw, 100vw" className="-z-20 object-cover object-[68%_100%]" />
        <span aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-t from-[#003d34] via-[#003d34]/65 to-[#003d34]/15" />
        <div>
          <span className="grid size-16 place-items-center rounded-full bg-white shadow-[0_4px_14px_-4px_rgb(0_0_0/0.4)]">
            <Image src="/brand/symbol.png" alt="대구대학교" width={56} height={56} priority />
          </span>
          <h1 className="mt-4 text-[30px] font-bold leading-tight drop-shadow-[0_1px_8px_rgb(0_40_34/0.6)] lg:text-[44px]">
            창파도서관
            <br />
            좌석예약
          </h1>
        </div>
        {/* 지금 빈자리 */}
        <div className="mt-8 grid min-h-[92px] grid-cols-2 gap-2.5 lg:mt-0 lg:max-w-lg" aria-label="지금 빈자리">
          {rooms.map((r) => (
            <div key={r.id} className="rounded-xl border border-white/25 bg-white/15 px-3.5 py-3 backdrop-blur-md">
              <p className="text-[13px] font-semibold text-white/90">{r.name}</p>
              {r.is_open ? (
                <>
                  <p className="tabular mt-0.5 flex items-baseline gap-1">
                    <span className="text-[26px] font-bold leading-none">{r.free}</span>
                    <span className="text-[13px] text-white/90">석 남음</span>
                  </p>
                  <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-white/25" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.pct} aria-label={`이용률 ${r.pct}퍼센트`}>
                    <span className={r.pct >= 80 ? "block h-full rounded-full bg-[#ffb4ab]" : r.pct >= 50 ? "block h-full rounded-full bg-du-light" : "block h-full rounded-full bg-white"} style={{ width: `${Math.max(r.pct, 3)}%` }} />
                  </span>
                </>
              ) : (
                <p className="mt-1 text-[15px] font-semibold">운영 종료</p>
              )}
            </div>
          ))}
        </div>
      </div>
      <main className="flex flex-1 flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:w-[440px] lg:flex-none lg:justify-center lg:px-10">
        <form onSubmit={submit} noValidate className="relative mx-auto w-full max-w-sm rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[var(--shadow-float)] sm:p-6 lg:border-0 lg:p-0 lg:shadow-none">
          <h2 className="text-lg font-bold">로그인</h2>
          <div className="mt-5 space-y-4">
            <Field label="학번">
              <input
                className={inputClass}
                value={sid}
                onChange={(e) => setSid(e.target.value)}
                inputMode="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="예: 22123456"
                aria-invalid={!!error}
              />
            </Field>
            <Field label="비밀번호">
              <input className={inputClass} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" aria-invalid={!!error} />
            </Field>
          </div>
          {error && (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-[var(--radius-ctl)] bg-danger-tint px-3 py-2.5 text-sm text-[#7d1a14]">
              <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" busy={busy} className="mt-5 w-full">
            로그인
          </Button>
          <p className="mt-4 text-[13px] text-muted">비밀번호 문의: 도서관 안내 데스크</p>
        </form>
      </main>
    </div>
  );
}
