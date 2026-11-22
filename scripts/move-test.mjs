// 자리 이동 점검: node scripts/move-test.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const [sidA, sidB] = process.env.SEED_TEAM.split(",").map((p) => p.split(":")[0]);
async function login(sid) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: `${sid}@du-library.app`, password: process.env.SEED_PASSWORD });
  if (error) throw error;
  return c;
}
const out = [];
const step = async (name, p, expectFail = false) => {
  const { data, error } = await p;
  const ok = expectFail ? !!error : !error;
  out.push(`${ok ? "OK  " : "FAIL"} ${name}: ${error ? error.message : JSON.stringify(data)}`);
  return data;
};
const state = async (id) => (await db.query("select state from seat_state where seat_id = $1", [id])).rows[0].state;

const a = await login(sidA);
const b = await login(sidB);
await db.query("update reservations set status='cancelled', ended_at=now() where status in ('reserved','in_use','away') and user_id in (select id from profiles where not is_virtual)");
const free = (await db.query("select s.id, s.label, s.qr_token from seats s join seat_state ss on ss.seat_id = s.id where ss.state = 'free' and s.is_active and s.room_id = 2 order by s.id limit 3")).rows;
const [X, Y, Z] = free;

await step("A 예약", a.rpc("reserve_seat", { p_seat: X.id }));
await step("체크인 전 이동은 실패해야 함", a.rpc("request_move", { p_seat: Y.id }), true);
await step("A 체크인", a.rpc("check_in", { p_token: X.qr_token }));
await step(`A 가 ${Y.label} 을 골라 맡아 둠`, a.rpc("request_move", { p_seat: Y.id }));
out.push(`     맡아 둔 좌석 상태: ${await state(Y.id)} (reserved 여야 함)`);
await step("B 가 맡아 둔 좌석 예약은 실패해야 함", b.rpc("reserve_seat", { p_seat: Y.id }), true);
await step("my_move", a.rpc("my_move"));
await step(`A 가 ${Y.label} QR 을 찍어 이동`, a.rpc("move_seat", { p_token: Y.qr_token }));
out.push(`     이전 좌석 ${X.label}: ${await state(X.id)} (free), 새 좌석 ${Y.label}: ${await state(Y.id)} (in_use)`);
await step(`고르지 않고 ${Z.label} QR 을 바로 찍어 이동`, a.rpc("move_seat", { p_token: Z.qr_token }));
out.push(`     ${Y.label}: ${await state(Y.id)} (free), ${Z.label}: ${await state(Z.id)} (in_use)`);
await step("B 예약", b.rpc("reserve_seat", { p_seat: X.id }));
await step("B 체크인", b.rpc("check_in", { p_token: X.qr_token }));
await step("B 가 A 의 좌석으로 이동은 실패해야 함", b.rpc("move_seat", { p_token: Z.qr_token }), true);
await step(`A 가 ${Y.label} 을 고르고 시간 초과`, a.rpc("request_move", { p_seat: Y.id }));
await db.query("update seat_holds set expires_at = now() - interval '1 second'");
await db.query("select expire_moves()");
out.push(`     시간 초과 뒤 ${Y.label}: ${await state(Y.id)} (free), A 의 좌석 ${Z.label}: ${await state(Z.id)} (in_use)`);
const kept = (await db.query("select end_at, extend_count from reservations where status = 'in_use' and seat_id = $1", [Z.id])).rows[0];
out.push(`     이용 종료 시각 유지: ${kept ? "예" : "아니오"}`);

await db.query("update reservations set status='cancelled', ended_at=now() where status in ('reserved','in_use','away') and user_id in (select id from profiles where not is_virtual)");
await db.query("delete from notifications where user_id in (select id from profiles where not is_virtual)");
await db.end();
const fs = await import("node:fs");
fs.writeFileSync(process.argv[2] ?? "move-test.out", out.join("\n") + "\n");
