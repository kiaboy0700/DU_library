// 도움 요청 중 불이익 멈춤과 '시간 더 주기' 점검: node scripts/help-test.mjs [결과파일]
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const [sidA] = process.env.SEED_TEAM.split(",").map((p) => p.split(":")[0]);
async function login(sid) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: `${sid}@du-library.app`, password: process.env.SEED_PASSWORD });
  if (error) throw error;
  return c;
}
const out = [];
const call = async (name, p) => {
  const { data, error } = await p;
  out.push(`${error ? "FAIL" : "OK  "} ${name}${error ? ": " + error.message : ""}`);
  return data;
};
const a = await login(sidA);
const admin = await login("admin");
const uid = (await db.query("select id from profiles where student_id = $1", [sidA])).rows[0].id;
const reset = () => db.query("update reservations set status='cancelled', ended_at=now(), on_hold=false where status in ('reserved','in_use','away') and user_id = $1", [uid]);
const state = async () => (await db.query("select r.id, r.status, r.on_hold, r.checkin_deadline > now() as ci_future, r.away_deadline > now() as aw_future, (select count(*)::int from penalties p where p.user_id = r.user_id) as pen from reservations r where r.user_id = $1 order by r.id desc limit 1", [uid])).rows[0];
await reset();
await db.query("update help_requests set status='resolved' where user_id = $1 and status='open'", [uid]);
await db.query("delete from penalties where user_id = $1", [uid]);
const seat = (await db.query("select s.id, s.qr_token, s.label from seats s join seat_state ss on ss.seat_id = s.id where ss.state = 'free' and s.is_active and s.room_id = 2 order by s.id limit 1")).rows[0];

// 1) 체크인 전에 QR 문제 → 도움 요청 → 마감이 지나도 취소·벌점 없음
await call("예약", a.rpc("reserve_seat", { p_seat: seat.id }));
await call("도움 요청", a.rpc("request_help", { p_reason: "QR이 인식되지 않아요" }));
await db.query("update reservations set checkin_deadline = now() - interval '1 minute' where user_id = $1 and status = 'reserved'", [uid]);
await db.query("select tick()");
let s = await state();
out.push(`     마감이 지난 뒤: 상태 ${s.status} (reserved 여야 함), 멈춤 ${s.on_hold}, 벌점 ${s.pen}점 (0 이어야 함)`);

// 2) 관리자가 먼저 시간을 더 준다
await call("관리자: 시간 15분 더 주기", admin.rpc("admin_res_action", { p_res: s.id, p_action: "grace", p_reason: "QR 문제", p_arg: 15 }));
s = await state();
out.push(`     체크인 마감이 다시 미래: ${s.ci_future}`);

// 3) 관리자가 요청을 완료 → 멈춤이 풀리고 마감은 넉넉히 남아 있음
const help = (await db.query("select id from help_requests where user_id = $1 and status = 'open'", [uid])).rows[0];
await call("관리자: 도움 요청 완료", admin.rpc("admin_resolve_help", { p_help: help.id, p_resolution: "QR 교체" }));
await db.query("select tick()");
s = await state();
out.push(`     완료 뒤: 상태 ${s.status} (reserved), 멈춤 ${s.on_hold} (false), 마감 미래 ${s.ci_future}, 벌점 ${s.pen}점`);

// 4) 외출 중에 복귀 QR 을 못 찍는 경우
await call("체크인", a.rpc("check_in", { p_token: seat.qr_token }));
await call("외출", a.rpc("go_away"));
await call("도움 요청(외출 중)", a.rpc("request_help", { p_reason: "QR이 인식되지 않아요" }));
await db.query("update reservations set away_deadline = now() - interval '1 minute' where user_id = $1 and status = 'away'", [uid]);
await db.query("select tick()");
s = await state();
out.push(`     외출 마감이 지난 뒤: 상태 ${s.status} (away 여야 함), 벌점 ${s.pen}점 (0 이어야 함)`);

// 5) 도움 요청 없이 같은 상황이면 원래대로 자동 반납 + 벌점
const help2 = (await db.query("select id from help_requests where user_id = $1 and status = 'open'", [uid])).rows[0];
await db.query("update help_requests set status='resolved' where id = $1", [help2.id]);
await db.query("update reservations set on_hold = false, away_deadline = now() - interval '1 minute' where user_id = $1 and status = 'away'", [uid]);
await db.query("select tick()");
s = await state();
out.push(`     도움 요청이 없을 때: 상태 ${s.status} (ended), 벌점 ${s.pen}점 (1 이어야 함)`);

await reset();
await db.query("delete from penalties where user_id = $1", [uid]);
await db.query("update profiles set banned_until = null, ban_reason = null where id = $1", [uid]);
await db.query("delete from notifications where user_id = $1", [uid]);
await db.end();
fs.writeFileSync(process.argv[2] ?? "help-test.out", out.join("\n") + "\n");
