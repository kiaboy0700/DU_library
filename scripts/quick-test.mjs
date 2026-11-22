// 빠른 예약 동시성 점검: 가상 학생 12명이 동시에 누르고, 한 명은 두 번 누른다. node scripts/quick-test.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows } = await db.query(`select p.id, p.student_id from profiles p where p.is_virtual
  and not exists (select 1 from reservations r where r.user_id = p.id and r.status in ('reserved','in_use','away')) order by p.student_id limit 12`);
const clients = await Promise.all(rows.map(async (r) => {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: `${r.student_id}@du-library.app`, password: process.env.SEED_PASSWORD });
  if (error) throw error;
  return c;
}));
const calls = [...clients, clients[0], clients[0]].map((c) => c.rpc("quick_reserve", { p_room: 2 }));
const res = await Promise.all(calls);
const ok = res.filter((r) => !r.error).map((r) => r.data.seat_label);
const errs = res.filter((r) => r.error).map((r) => r.error.message);
console.log(`성공 ${ok.length}건, 서로 다른 좌석 ${new Set(ok).size}개:`, ok.join(" "));
console.log(`거부 ${errs.length}건:`, [...new Set(errs)].join(" | "));
const dup = await db.query(`select count(*)::int n from (select seat_id from reservations where status in ('reserved','in_use','away') group by seat_id having count(*) > 1) x`);
console.log("중복 배정된 좌석:", dup.rows[0].n);
await db.query(`update reservations set status='cancelled', ended_at=now(), end_reason='user' where status='reserved' and user_id = any($1::uuid[])`, [rows.map((r) => r.id)]);
await db.end();
