// 시연 시나리오 점검: node scripts/demo-test.mjs [결과파일]
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const sid = process.env.SEED_TEAM.split(",")[3].split(":")[0];
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
{
  const { error } = await admin.auth.signInWithPassword({ email: "admin@du-library.app", password: process.env.SEED_PASSWORD });
  if (error) throw error;
}
const out = [];
const demo = async (action, extra = {}) => {
  const { data, error } = await admin.rpc("admin_demo", { p_action: action, p_student: sid, p_room: 2, ...extra });
  const st = data?.state;
  out.push(
    `${error ? "FAIL" : "OK  "} ${action.padEnd(15)} ${error ? error.message : data.message}` +
      (st ? `\n       → ${st.res ? `${st.res.status} ${st.res.room_name} ${st.res.seat_label}${st.res.on_hold ? " (멈춤)" : ""}${st.res.report_deadline ? " (신고 접수)" : ""}` : "좌석 없음"} · 벌점 ${st.points}점${st.banned_until ? " · 정지" : ""}` : ""),
  );
};
await demo("reset");
for (const a of ["reserved", "checkin_soon", "no_show", "in_use", "end_soon", "expire", "away", "away_soon", "away_timeout", "report", "report_timeout", "help", "reset"]) await demo(a);
await demo("penalty", { p_arg: "3" });
await demo("reset");

// 층별 혼잡도
for (const [room, pct] of [[2, 90], [1, 90], [2, 30], [1, 60]]) {
  const { data, error } = await admin.rpc("admin_demo_fill", { p_room: room, p_pct: pct });
  const { data: occ } = await admin.rpc("home_summary");
  const r = (occ?.rooms ?? []).find((x) => x.id === room);
  out.push(`${error ? "FAIL " + error.message : "OK  "} fill room ${room} → ${pct}% : 채움 ${data}, 실제 ${r ? r.pct : "?"}%`);
}
for (const m of ["exam", "vacation", "auto"]) {
  const { data, error } = await admin.rpc("admin_demo", { p_action: "mode", p_arg: m });
  out.push(`${error ? "FAIL " + error.message : "OK  "} mode ${m} → ${data?.mode}`);
}
fs.writeFileSync(process.argv[2] ?? "demo-test.out", out.join("\n") + "\n");
process.exit(0);
