// 로그인과 핵심 RPC 흐름 점검: node scripts/smoke.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const pw = process.env.SEED_PASSWORD;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

async function login(sid) {
  const c = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: `${sid}@du-library.app`, password: pw });
  if (error) throw new Error(`로그인 실패 ${sid}: ${error.message}`);
  return c;
}
const step = async (name, p) => {
  const { data, error } = await p;
  console.log(error ? `✗ ${name}: ${error.message}` : `✓ ${name}`, error ? "" : JSON.stringify(data)?.slice(0, 140) ?? "");
  return data;
};

const [sidA, sidB] = (process.env.SEED_TEAM ?? "").split(",").map((p) => p.split(":")[0]);
const a = await login(sidA);
const b = await login(sidB);
const admin = await login("admin");
await db.query("update reservations set status='cancelled', ended_at=now() where status in ('reserved','in_use','away') and user_id in (select id from profiles where not is_virtual)");

const home = await step("home_summary", a.rpc("home_summary"));
const seat = (await db.query("select id, qr_token from seats where room_id = 5 order by id limit 1")).rows[0];
await step("reserve", a.rpc("reserve_seat", { p_seat: seat.id }));
await step("같은 좌석 중복 예약은 실패해야 함", b.rpc("reserve_seat", { p_seat: seat.id }));
await step("seats 직접 조회(토큰 비공개: 0행이어야 함)", a.from("seats").select("qr_token").limit(1));
await step("seat_context", a.rpc("seat_context", { p_token: seat.qr_token }));
await step("check_in", a.rpc("check_in", { p_token: seat.qr_token }));
await step("연장은 종료 30분 전부터(실패해야 함)", a.rpc("extend_reservation"));
await step("방금 체크인 좌석 신고(실패해야 함)", b.rpc("report_seat", { p_token: seat.qr_token }));
await db.query("update reservations set checked_in_at = now() - interval '1 hour' where seat_id = $1 and status='in_use'", [seat.id]);
await step("report_seat", b.rpc("report_seat", { p_token: seat.qr_token }));
await step("신고 중 외출(실패해야 함)", a.rpc("go_away"));
await step("confirm_presence", a.rpc("confirm_presence", { p_token: seat.qr_token }));
await step("go_away", a.rpc("go_away"));
await db.query("update reservations set away_deadline = now() - interval '1 minute' where seat_id = $1 and status='away'", [seat.id]);
await db.query("select tick()");
const st = await step("my_status (외출 초과 → 반납·벌점 1)", a.rpc("my_status"));
console.log("  points:", st?.points, "reservation:", st?.reservation);
await step("admin_overview", admin.rpc("admin_overview"));
await step("admin_demo_fill 5층 85%", admin.rpc("admin_demo_fill", { p_room: 5, p_pct: 85 }));
await step("admin_demo_fill 2층 45%", admin.rpc("admin_demo_fill", { p_room: 2, p_pct: 45 }));
const h2 = await step("home_summary", a.rpc("home_summary"));
console.log("  ", h2?.rooms?.map((r) => `${r.name} ${r.pct}% 외출 ${r.away_minutes}분 신고응답 ${r.report_minutes}분`).join(" | "));
await step("학생이 관리자 함수 호출(실패해야 함)", a.rpc("admin_overview"));
await step("heatmap", a.rpc("occupancy_heatmap", { p_room: 5 }));
// 정리: 테스트로 생긴 벌점 제거
await db.query("delete from penalties where user_id in (select id from profiles where not is_virtual)");
await db.query("delete from notifications where user_id in (select id from profiles where not is_virtual)");
await db.end();
void home;
