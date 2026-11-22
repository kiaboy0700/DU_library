import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
);

/** 학번 로그인은 내부적으로 가상 이메일을 쓴다 */
export const emailOf = (studentId: string) => `${studentId.trim().toLowerCase()}@du-library.app`;

/** RPC 호출: 실패하면 한국어 오류 메시지를 담아 throw */
export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
