"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Field, inputClass } from "@/components/ui";
import { emailOf, supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const { status, refresh } = useApp();
  const [sid, setSid] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="flex min-h-dvh flex-col bg-surface sm:bg-canvas">
      <div className="on-deep bg-du-deep px-6 pb-16 pt-12 text-white sm:pb-24">
        <div className="mx-auto max-w-sm">
          <span className="grid size-16 place-items-center rounded-full bg-white">
            <Image src="/brand/symbol.png" alt="대구대학교" width={56} height={56} priority />
          </span>
          <h1 className="mt-5 text-[28px] font-bold leading-tight">
            창파도서관
            <br />
            좌석예약
          </h1>
          <p className="mt-2 text-[15px] text-white/85">도서관에 오기 전에 빈자리를 확인하세요.</p>
        </div>
      </div>
      <main className="-mt-8 flex-1 px-4 pb-10 sm:-mt-14">
        <form onSubmit={submit} noValidate className="mx-auto max-w-sm rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[var(--shadow-float)] sm:p-6">
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
