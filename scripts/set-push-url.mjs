// 배포 주소를 DB에 등록해 tick()이 푸시 발송을 요청할 수 있게 한다: node scripts/set-push-url.mjs https://<배포주소>
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base.startsWith("https://")) throw new Error("배포 주소(https://...)를 인자로 주세요.");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
for (const [k, v] of [["push_flush_url", base + "/api/push/flush"], ["push_flush_secret", process.env.PUSH_FLUSH_SECRET]]) {
  await db.query("insert into private_config(key, value) values ($1,$2) on conflict (key) do update set value = excluded.value", [k, v]);
}
await db.end();
const bad = await fetch(base + "/api/push/flush", { method: "POST" });
const ok = await fetch(base + "/api/push/flush", { method: "POST", headers: { "x-flush-secret": process.env.PUSH_FLUSH_SECRET } });
console.log("등록 완료. 시크릿 없이:", bad.status, "/ 시크릿 포함:", ok.status, await ok.text());
