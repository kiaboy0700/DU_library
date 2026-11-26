import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { GUIDE_TEMPLATE } from "@/lib/guideTemplate";

// 팀원용 가이드. 주소 끝의 키를 아는 사람만 볼 수 있다 (키는 저장소에 없고 배포 환경 변수에만 있다).
// 이름·학번·좌석 QR은 파일로 두지 않고, 열릴 때마다 DB에서 읽어 채운다.

const SITE = "https://du-library-ruddy.vercel.app";

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface Account {
  student_id: string;
  name: string;
  department: string | null;
  role: string;
  is_virtual: boolean;
}
interface SeatRow {
  label: string;
  zone: string;
  qr_token: string;
  rooms: { floor: number; name: string } | { floor: number; name: string }[] | null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const secret = process.env.GUIDE_KEY;
  if (!secret || key !== secret) return new Response("Not found", { status: 404 });

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const [acc, seats] = await Promise.all([
    admin.from("profiles").select("student_id,name,department,role,is_virtual").order("student_id").limit(2000),
    admin.from("seats").select("label,zone,qr_token,rooms(floor,name)").order("label").limit(2000),
  ]);
  if (acc.error || seats.error) return new Response("가이드를 만들지 못했습니다.", { status: 500 });

  const accounts = (acc.data ?? []) as Account[];
  const admins = accounts.filter((x) => x.role === "admin");
  const team = accounts.filter((x) => x.role !== "admin" && !x.is_virtual);
  // 팀원의 관리자 계정은 학번 앞에 a 를 붙인 것
  const adminIdOf = new Map(admins.filter((x) => x.student_id !== "admin").map((x) => [x.name, x.student_id]));
  const virtual = accounts.filter((x) => x.is_virtual && !x.student_id.startsWith("2599"));
  const row3 = (xs: Account[]) => xs.map((x) => `<tr><td>${esc(x.student_id)}</td><td>${esc(x.name)}</td><td>${esc(x.department || "-")}</td></tr>`).join("\n");
  const pairRows = team.map((t) => `<tr><td class="nm">${esc(t.name)}</td><td>${esc(t.student_id)}</td><td>${esc(adminIdOf.get(t.name) ?? "-")}</td></tr>`).join("\n");

  // 좌석 QR: 무늬만 압축해서 넣고, 화면에서 그린다
  const rooms: { floor: number; name: string; zones: { zone: string; seats: [string, string, number, string][] }[] }[] = [];
  for (const s of (seats.data ?? []) as SeatRow[]) {
    const r = Array.isArray(s.rooms) ? s.rooms[0] : s.rooms;
    if (!r) continue;
    let room = rooms.find((x) => x.floor === r.floor && x.name === r.name);
    if (!room) rooms.push((room = { floor: r.floor, name: r.name, zones: [] }));
    let zone = room.zones.find((z) => z.zone === s.zone);
    if (!zone) room.zones.push((zone = { zone: s.zone, seats: [] }));
    const qr = QRCode.create(`${SITE}/s/${s.qr_token}`, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const bits = qr.modules.data;
    const bytes = Buffer.alloc(Math.ceil((n * n) / 8));
    for (let i = 0; i < n * n; i++) if (bits[i]) bytes[i >> 3] |= 128 >> (i & 7);
    zone.seats.push([s.label, s.qr_token, n, bytes.toString("base64")]);
  }
  rooms.sort((a, b) => a.floor - b.floor);
  for (const r of rooms) r.zones.sort((a, b) => a.zone.localeCompare(b.zone));

  const fill: Record<string, string> = {
    "{{PAIR_ROWS}}": pairRows,
    "{{SHARED_ROWS}}": row3(admins.filter((x) => x.student_id === "admin")),
    "{{VIRT_ROWS}}": row3(virtual),
    "{{VIRT_COUNT}}": String(virtual.length),
    "{{SEATS}}": JSON.stringify({ origin: SITE, rooms }).replace(/</g, "\\u003c"),
  };
  const html = GUIDE_TEMPLATE.replace(/\{\{(PAIR_ROWS|SHARED_ROWS|VIRT_ROWS|VIRT_COUNT|SEATS)\}\}/g, (m) => fill[m]);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 검색에 잡히지 않게, 다른 사이트로 넘어갈 때 이 주소가 따라가지 않게
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  });
}
