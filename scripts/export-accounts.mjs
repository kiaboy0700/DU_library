// 계정 목록을 한 장짜리 HTML로 내보낸다 (로컬 전용, 저장소에 올리지 않음): node scripts/export-accounts.mjs
import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows } = await db.query(
  `select student_id, name, department, grade, role, is_virtual from profiles
   order by (role = 'admin') desc, is_virtual, department, student_id`);
await db.end();

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const kind = (r) => (r.role === "admin" ? "관리자" : r.is_virtual ? "가상 학생" : "팀원");
const colleges = [...new Set(rows.filter((r) => r.is_virtual).map((r) => r.department.split(" ")[0]))].sort();
const body = rows
  .map((r) => {
    const [college, ...rest] = (r.department ?? "").split(" ");
    return `<tr data-kind="${kind(r)}" data-college="${esc(college)}"><td><span class="k k-${r.role === "admin" ? "a" : r.is_virtual ? "v" : "t"}">${kind(r)}</span></td><td class="id">${esc(r.student_id)}</td><td class="nm">${esc(r.name)}</td><td>${esc(r.role === "admin" ? r.department : college)}</td><td>${esc(r.role === "admin" ? "" : rest.join(" "))}</td><td class="g">${r.grade ? r.grade + "학년" : "–"}</td></tr>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>창파도서관 좌석예약 계정 목록</title>
<style>
:root{--deep:#00826f;--dark:#006a5b;--ink:#231f20;--muted:#5b6663;--line:#dbe3e0;--canvas:#f3f6f4;--tint:#e9f5f2}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 Pretendard,"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;word-break:keep-all}
header{background:var(--deep);color:#fff;padding:28px 20px 24px}header>div,main{max-width:1040px;margin:0 auto}
h1{margin:0;font-size:24px;letter-spacing:-.02em}header p{margin:6px 0 0;color:#e2f3ef}
main{padding:20px 16px 60px}
.login{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:grid;gap:10px 28px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.login dt{font-size:12px;color:var(--muted)}.login dd{margin:2px 0 0;font-weight:700;font-variant-numeric:tabular-nums}
code{font:600 14px ui-monospace,Consolas,monospace;background:var(--tint);color:var(--dark);padding:2px 7px;border-radius:6px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:18px 0 10px}
input,select{height:42px;border:1px solid #c3cfcb;border-radius:10px;padding:0 12px;font:inherit;background:#fff}
input{flex:1;min-width:200px}input:focus,select:focus{outline:2px solid var(--deep);outline-offset:1px}
#n{margin-left:auto;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.wrap{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:auto}
table{border-collapse:collapse;width:100%;min-width:680px}th{position:sticky;top:0;background:#fff;text-align:left;font-size:12px;color:var(--muted);font-weight:500;padding:10px 14px;border-bottom:1px solid var(--line)}
td{padding:9px 14px;border-bottom:1px solid #edf1f0}tr:last-child td{border-bottom:0}tbody tr:hover{background:#f8faf9}
.id{font-variant-numeric:tabular-nums;font-weight:700}.nm{font-weight:600}.g{white-space:nowrap}
.k{display:inline-block;font-size:12px;font-weight:700;padding:1px 7px;border-radius:6px;white-space:nowrap}.k-a{background:var(--deep);color:#fff}.k-t{background:var(--tint);color:var(--dark)}.k-v{background:#eaefed;color:#3d4744}
footer{margin-top:14px;font-size:13px;color:var(--muted)}
@media print{header{background:#fff;color:#000}.bar{display:none}}
</style></head><body>
<header><div><h1>창파도서관 좌석예약 계정 목록</h1><p>관리자 1명 · 팀원 ${rows.filter((r) => !r.is_virtual && r.role !== "admin").length}명 · 가상 학생 ${rows.filter((r) => r.is_virtual).length}명 · ${new Date().toLocaleDateString("ko-KR")} 기준</p></div></header>
<main>
<dl class="login">
<div><dt>접속 주소</dt><dd>https://du-library-ruddy.vercel.app</dd></div>
<div><dt>로그인</dt><dd>학번 + 비밀번호 (관리자 학번은 <code>admin</code>)</dd></div>
<div><dt>비밀번호 (모든 계정 공통)</dt><dd><code>${esc(process.env.SEED_PASSWORD)}</code></dd></div>
</dl>
<div class="bar">
<input id="q" type="search" placeholder="학번·이름·학과 검색" aria-label="학번, 이름, 학과 검색">
<select id="kind" aria-label="구분"><option value="">전체 구분</option><option>관리자</option><option>팀원</option><option>가상 학생</option></select>
<select id="college" aria-label="단과대학"><option value="">전체 단과대학</option>${colleges.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
<span id="n"></span>
</div>
<div class="wrap"><table><thead><tr><th>구분</th><th>학번</th><th>이름</th><th>단과대학 / 소속</th><th>학부·학과(전공)</th><th>학년</th></tr></thead><tbody>
${body}
</tbody></table></div>
<footer>가상 학생의 학과는 2026학년도 대구대학교 학부·학과 편제를 참고했습니다. 이름과 학번은 모두 지어낸 것이며 실제 인물과 관련이 없습니다. 이 파일에는 비밀번호가 들어 있으니 공개된 곳에 올리지 마세요.</footer>
</main>
<script>
const rows=[...document.querySelectorAll("tbody tr")],q=document.getElementById("q"),k=document.getElementById("kind"),c=document.getElementById("college"),n=document.getElementById("n");
function f(){const t=q.value.trim().toLowerCase();let m=0;for(const r of rows){const ok=(!t||r.textContent.toLowerCase().includes(t))&&(!k.value||r.dataset.kind===k.value)&&(!c.value||r.dataset.college===c.value);r.hidden=!ok;if(ok)m++}n.textContent=m+"명"}
q.oninput=k.onchange=c.onchange=f;f();
</script></body></html>`;
fs.writeFileSync("계정목록.html", html);
console.log("계정목록.html", rows.length, "명");
