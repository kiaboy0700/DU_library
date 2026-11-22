// 초기 데이터: 설정값, 열람실·좌석 배치, 운영 기간, 계정(관리자·팀원·가상 학생), 가상 혼잡도 기록
// 실행: node scripts/seed.mjs      (여러 번 실행해도 안전)
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const PASSWORD = process.env.SEED_PASSWORD;
if (!process.env.DATABASE_URL || !PASSWORD) {
  console.error(".env.local 에 DATABASE_URL 과 SEED_PASSWORD 가 필요합니다.");
  process.exit(1);
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// 재현 가능한 난수
let seed = 20261122;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// ---------- 1. 설정 ----------
const settings = {
  max_minutes: 240, extend_minutes: 120, extend_window_min: 30, max_extends: 2, checkin_minutes: 15,
  occ_high: 80, occ_mid: 50,
  away_high: 20, away_mid: 40, away_low: 60,
  report_high: 10, report_mid: 15, report_low: 20,
  report_min_after_checkin: 10, report_cooldown: 30, report_hourly_limit: 3,
  pen_no_show: 1, pen_away: 1, pen_report: 2, pen_report_busy: 3,
  ban1_points: 3, ban1_days: 3, ban2_points: 6, ban2_days: 14, penalty_window_days: 30,
  semester_open: 9, semester_close: 22, vacation_open: 9, vacation_close: 17,
  // 창파도서관 대략 위치. 관리자 설정에서 '현재 위치로 설정'으로 정확히 맞출 수 있음
  library_lat: 35.9013, library_lng: 128.8487, gps_radius_m: 200,
  gps_disabled: true,   // 데모 모드: 위치 확인 끔
  force_open: true,     // 데모 모드: 운영시간과 무관하게 항상 예약 가능
  incident_mode: false, // 장애 모드: 자동 취소·반납·벌점 일시 정지
};
for (const [k, v] of Object.entries(settings)) {
  await db.query("insert into settings(key, value) values ($1, $2) on conflict (key) do nothing", [k, JSON.stringify(v)]);
}

// ---------- 2. 열람실과 좌석 ----------
// 좌표는 격자 칸 단위. 블록 = 책상을 사이에 두고 마주 보는 두 줄
const rooms = [];
const seats = [];
let seatId = 0;
const counters = {};
function addSeat(roomId, zone, type, x, y) {
  const key = roomId + zone;
  counters[key] = (counters[key] ?? 0) + 1;
  seatId += 1;
  seats.push({ id: roomId * 1000 + seatId, room_id: roomId, zone, label: `${zone}-${String(counters[key]).padStart(3, "0")}`, seat_type: type, x, y });
}
function block(roomId, zone, type, x, y, n, decor) {
  for (let i = 0; i < n; i++) addSeat(roomId, zone, type, x + i, y);
  for (let i = 0; i < n; i++) addSeat(roomId, zone, type, x + i, y + 2);
  decor.push({ t: "table", x, y: y + 1, w: n, h: 1 });
}

// 5층: 기둥이 있는 대형 열람실. 왼쪽 일반석, 가운데·오른쪽 칸막이석
{
  const decor = [];
  seatId = 0;
  const ys = [3, 8, 13, 18];
  for (const cx of [2, 10]) for (const y of ys) block(5, "A", "general", cx, y, 6, decor);
  for (const cx of [20, 27, 34]) for (const y of ys) block(5, "B", "partition", cx, y, 5, decor);
  for (const cx of [43, 50]) for (const y of ys) block(5, "C", "partition", cx, y, 5, decor);
  for (const [x, y] of [[17, 6], [17, 16], [40, 6], [40, 16]]) decor.push({ t: "pillar", x, y, w: 1, h: 1 });
  decor.push({ t: "label", x: 2, y: 1, w: 14, h: 1, text: "A구역 · 일반석" });
  decor.push({ t: "label", x: 20, y: 1, w: 19, h: 1, text: "B구역 · 칸막이석" });
  decor.push({ t: "label", x: 43, y: 1, w: 12, h: 1, text: "C구역 · 칸막이석" });
  decor.push({ t: "door", x: 26, y: 23, w: 6, h: 1, text: "출입구" });
  rooms.push({ id: 5, floor: 5, name: "5층 열람실", description: "일반석과 칸막이석이 있는 대형 열람실", layout_w: 57, layout_h: 25, decor });
}

// 2층: 리모델링된 복합 공간
{
  const decor = [];
  seatId = 0;
  for (let i = 0; i < 16; i++) addSeat(2, "W", "window", 3 + i, 2);            // 창가 바 테이블
  decor.push({ t: "table", x: 3, y: 1, w: 16, h: 1 });
  for (const cx of [3, 9]) for (const y of [6, 11]) block(2, "T", "general", cx, y, 4, decor); // 오픈 테이블
  for (const cx of [17, 24]) for (const y of [6, 11, 16]) block(2, "N", "laptop", cx, y, 4, decor); // 노트북존
  for (const cx of [33, 35]) for (let i = 0; i < 12; i++) addSeat(2, "P", "partition", cx, 4 + i); // 칸막이 1인석
  for (let i = 0; i < 10; i++) addSeat(2, "S", "booth", 3 + i * 2 - (i > 4 ? 0 : 0), 21); // 1인 부스 (한 칸씩 띄움)
  decor.push({ t: "label", x: 3, y: 0, w: 16, h: 1, text: "W · 창가석" });
  decor.push({ t: "label", x: 3, y: 4, w: 10, h: 1, text: "T · 오픈 테이블" });
  decor.push({ t: "label", x: 17, y: 4, w: 11, h: 1, text: "N · 노트북존" });
  decor.push({ t: "label", x: 31, y: 2, w: 7, h: 1, text: "P · 칸막이석" });
  decor.push({ t: "label", x: 3, y: 19, w: 12, h: 1, text: "S · 1인 부스" });
  decor.push({ t: "lounge", x: 24, y: 20, w: 12, h: 3, text: "라운지 (자유석)" });
  decor.push({ t: "door", x: 14, y: 23, w: 6, h: 1, text: "출입구" });
  rooms.push({ id: 2, floor: 2, name: "2층 열람실", description: "노트북존·오픈 테이블·창가석·1인 부스가 있는 복합 공간", layout_w: 38, layout_h: 25, decor });
}

for (const r of rooms) {
  await db.query(
    `insert into rooms(id, floor, name, description, layout_w, layout_h, decor) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set floor=excluded.floor, name=excluded.name, description=excluded.description,
       layout_w=excluded.layout_w, layout_h=excluded.layout_h, decor=excluded.decor`,
    [r.id, r.floor, r.name, r.description, r.layout_w, r.layout_h, JSON.stringify(r.decor)]);
}
await db.query(
  `insert into seats(id, room_id, zone, label, seat_type, x, y)
   select * from jsonb_to_recordset($1::jsonb) as t(id int, room_id int, zone text, label text, seat_type text, x int, y int)
   on conflict (id) do update set zone=excluded.zone, label=excluded.label, seat_type=excluded.seat_type, x=excluded.x, y=excluded.y`,
  [JSON.stringify(seats)]);
await db.query("delete from seats where id <> all($1::int[])", [seats.map((s) => s.id)]);
await db.query("insert into seat_state(seat_id, room_id) select id, room_id from seats on conflict do nothing");
console.log("좌석:", rooms.map((r) => `${r.name} ${seats.filter((s) => s.room_id === r.id).length}석`).join(", "));

// ---------- 3. 운영 기간 ----------
const { rows: per } = await db.query("select count(*)::int n from operating_periods");
if (per[0].n === 0) {
  await db.query(`insert into operating_periods(mode, label, start_date, end_date) values
    ('semester', '2026학년도 2학기', '2026-09-01', '2026-12-18'),
    ('exam', '2학기 기말고사', '2026-12-07', '2026-12-18'),
    ('vacation', '겨울방학', '2026-12-19', '2027-02-28')`);
  await db.query(`insert into closed_days(day, reason) values ('2026-12-25', '성탄절'), ('2027-01-01', '신정') on conflict do nothing`);
}

// ---------- 4. 계정 ----------
// 가상 학생의 학과는 2026학년도 대구대학교 학부·학과 편제를 따른다 (나무위키 '대구대학교/학부' 참고, 공식 표기와 다를 수 있음)
const { rows: cols } = await db.query("select 1 from information_schema.columns where table_name='profiles' and column_name='is_virtual'");
if (cols.length === 0) await db.query("alter table profiles add column is_virtual boolean not null default false");

async function account(sid, name, dept, grade, role, virtual) {
  const { rows } = await db.query("select 1 from profiles where student_id = $1", [sid]);
  if (rows.length) return false;
  const r = await db.query("select create_account($1,$2,$3,$4,$5,$6) id", [sid, name, dept, grade, PASSWORD, role]);
  if (virtual) await db.query("update profiles set is_virtual = true where id = $1", [r.rows[0].id]);
  return true;
}
await account("admin", "정서윤", "창파도서관 열람실 관리자", null, "admin", false);
// 팀원 등 실제 사용자 계정은 저장소에 남기지 않도록 .env.local 의 SEED_TEAM 에서 읽는다 (형식: 학번:이름,학번:이름)
for (const pair of (process.env.SEED_TEAM ?? "").split(",").filter(Boolean)) {
  const [sid, name] = pair.split(":").map((v) => v.trim());
  await account(sid, name, process.env.SEED_TEAM_DEPT ?? null, Number(process.env.SEED_TEAM_GRADE ?? 3), "student", false);
}

const depts = [
  ["IT·공과대학 컴퓨터정보공학부(컴퓨터소프트웨어전공)", "221"], ["IT·공과대학 컴퓨터정보공학부(사이버보안전공)", "222"], ["IT·공과대학 전자전기공학부(반도체전자공학전공)", "223"], ["IT·공과대학 기계공학부(기계공학전공)", "224"], ["IT·공과대학 건축공학과", "225"], ["IT·공과대학 화학공학과", "226"],
  ["글로벌경영대학 경영학부(경영학전공)", "121"], ["글로벌경영대학 경영학부(회계학전공)", "122"], ["글로벌경영대학 경제·금융보험·통상학과", "123"], ["글로벌경영대학 호텔관광경영학부(관광경영전공)", "124"],
  ["공공인재대학 공공안전학부(소방·행정학전공)", "131"], ["공공인재대학 경찰학부(경찰행정학전공)", "132"], ["공공인재대학 부동산·지적학과", "133"],
  ["사회과학대학 사회복지학과", "311"], ["사회과학대학 심리학과", "312"], ["사회과학대학 문헌정보학과", "313"],
  ["사범대학 특수교육학부(특수교육전공)", "411"], ["사범대학 특수교육학부(초등특수교육전공)", "412"], ["사범대학 국어교육과", "413"], ["사범대학 영어교육과", "414"],
  ["간호대학 간호학과", "511"], ["재활과학대학 물리치료학과", "512"], ["IT·공과대학 식품영양학과", "513"],
  ["디자인예술대학 시각디자인융합학부(시각디자인전공)", "611"], ["IT·공과대학 조경·정원디자인학과", "612"],
];
const surnames = "김김김김김이이이이박박박최최정정강조윤장임한오서신권황안송류홍전고문양손배백허남심노하곽성차주우구민".split("");
const given1 = "민서지하도예수현준유은채시연우승건태주소다윤재성영정가나동혜".split("");
const given2 = "준우윤서연아현진호민원빈은영희수정훈경석린율찬혁환솔람결".split("");
const used = new Set();
let created = 0;
for (let i = 0; i < 300; i++) {
  const yy = pick([20, 21, 22, 22, 23, 23, 24, 24, 24, 25, 25, 25, 26, 26, 26]);
  const [dept, code] = pick(depts);
  let sid;
  do { sid = `${yy}${code}${String(Math.floor(rnd() * 999) + 1).padStart(3, "0")}`; } while (used.has(sid));
  used.add(sid);
  const name = pick(surnames) + pick(given1) + pick(given2);
  const grade = Math.min(4, 27 - yy);
  if (await account(sid, name, dept, grade, "student", true)) created += 1;
}
const { rows: cnt } = await db.query("select count(*)::int n, count(*) filter (where is_virtual)::int v from profiles");
console.log(`계정: 전체 ${cnt[0].n}명 (가상 학생 ${cnt[0].v}명, 이번에 새로 만든 가상 학생 ${created}명)`);

// ---------- 5. 가상 혼잡도 기록 (최근 4주, 1시간 단위) ----------
const { rows: sn } = await db.query("select count(*)::int n from occupancy_snapshots");
if (sn[0].n === 0) {
  const snaps = [];
  const curve = [0.02, 0.01, 0.01, 0.01, 0.01, 0.02, 0.04, 0.08, 0.18, 0.35, 0.5, 0.58, 0.5, 0.62, 0.74, 0.78, 0.72, 0.6, 0.55, 0.66, 0.7, 0.55, 0.3, 0.1];
  const dowFactor = [0, 1.0, 1.05, 1.1, 1.0, 0.8, 0.35, 0.4]; // 1=월 … 7=일
  const now = Date.now();
  for (const r of rooms) {
    const total = seats.filter((s) => s.room_id === r.id).length;
    for (let h = 24 * 28; h >= 1; h--) {
      const t = new Date(now - h * 3600_000);
      const kst = new Date(t.getTime() + 9 * 3600_000);
      const dow = kst.getUTCDay() === 0 ? 7 : kst.getUTCDay();
      const ratio = Math.min(0.98, Math.max(0, curve[kst.getUTCHours()] * dowFactor[dow] * (r.id === 2 ? 1.1 : 1) + (rnd() - 0.5) * 0.12));
      snaps.push({ room_id: r.id, taken_at: t.toISOString(), occupied: Math.round(total * ratio), total });
    }
  }
  await db.query(
    `insert into occupancy_snapshots(room_id, taken_at, occupied, total)
     select * from jsonb_to_recordset($1::jsonb) as t(room_id int, taken_at timestamptz, occupied int, total int)`,
    [JSON.stringify(snaps)]);
  console.log("혼잡도 기록:", snaps.length, "건");
}

await db.end();
console.log("시드 완료");
