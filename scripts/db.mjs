// 사용법: node scripts/db.mjs <sql파일...>   |   node scripts/db.mjs -e "select 1"
import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL 이 .env.local 에 없습니다.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
const args = process.argv.slice(2);
try {
  if (args[0] === "-e") {
    const r = await client.query(args[1]);
    const rows = Array.isArray(r) ? r[r.length - 1].rows : r.rows;
    console.log(JSON.stringify(rows, null, 1));
  } else {
    for (const f of args) {
      await client.query(fs.readFileSync(f, "utf8"));
      console.log("applied", f);
    }
  }
} catch (e) {
  console.error("SQL 오류:", e.message, e.where ?? "", e.position ? "pos " + e.position : "");
  process.exitCode = 1;
} finally {
  await client.end();
}
