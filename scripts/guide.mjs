// 가이드 만들기
//   node scripts/guide.mjs            docs/guide.src.html → src/lib/guideTemplate.ts (사이트의 /g/<키> 가 쓰는 틀)
//   node scripts/guide.mjs --file <폴더>   실행 중인 로컬 서버의 /g/<키> 를 받아, 사진을 파일 안에 넣은 한 장짜리 HTML 두 가지를 만든다
//                                         docs/창파도서관-좌석예약-가이드.html (그대로 여는 파일), <폴더>/seat-guide.html (본문 조각)
// 이름·학번·좌석 QR은 틀에 들어가지 않는다. 사이트가 열릴 때 DB에서 채운다.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const TEAM = `            <div class="tablebox mini"><table>
              <thead><tr><th>이름</th><th>학생으로</th><th>관리자로</th></tr></thead>
              <tbody>
{{PAIR_ROWS}}
              </tbody>
            </table></div>
            <p class="more">학번 칸에 <code>admin</code>을 넣는 공용 관리자 계정은 발표용으로 남겨 둡니다. 테스트에는 쓰지 않습니다.</p>`;

const VIEWS = `<div id="view-accounts" hidden>
  <div class="page">
    <a class="back" href="#start" data-back><span aria-hidden="true">←</span> 가이드로</a>
    <h1>전체 계정</h1>
    <p class="sub">비밀번호는 모두 <code>eorneo1234!</code> 입니다.</p>
    <div class="stack acct">
      <div class="card">
        <h3>팀원</h3>
        <div class="tablebox mini"><table>
          <thead><tr><th>이름</th><th>학생으로</th><th>관리자로</th></tr></thead>
          <tbody>
{{PAIR_ROWS}}
          </tbody>
        </table></div>
        <h4>발표용 공용 관리자</h4>
        <div class="tablebox mini"><table>
          <thead><tr><th>학번 칸에 입력</th><th>이름</th><th>소속</th></tr></thead>
          <tbody>
{{SHARED_ROWS}}
          </tbody>
        </table></div>
      </div>
      <div class="card">
        <h3>가상 학생 <span class="count" id="acct-n">{{VIRT_COUNT}}명</span></h3>
        <input class="search" id="acct-q" type="search" placeholder="학번 · 이름 · 학과" aria-label="가상 학생 찾기" autocomplete="off">
        <div class="tablebox mini" id="acct-virtual"><table>
          <thead><tr><th>학번</th><th>이름</th><th>학과</th></tr></thead>
          <tbody>
{{VIRT_ROWS}}
          </tbody>
        </table></div>
      </div>
    </div>
  </div>
</div>

<div id="view-qr" hidden>
  <div class="page">
    <a class="back" href="#user" data-back><span aria-hidden="true">←</span> 가이드로</a>
    <h1>좌석 QR</h1>
    <p class="sub">좌석을 누르면 QR이 크게 뜹니다.</p>
    <div class="seg" id="qr-rooms"></div>
    <input class="search" id="qr-q" type="search" placeholder="좌석 번호" aria-label="좌석 찾기" autocomplete="off">
    <div id="qr-zones"></div>
    <p class="note">이 QR을 찍으면 실제로 체크인·신고가 됩니다. 팀 밖으로 보내지 마세요.</p>
  </div>
  <dialog class="qr" id="qr-dlg" aria-label="좌석 QR">
    <h2></h2>
    <p class="where"></p>
    <div class="code"></div>
    <div class="row">
      <button type="button" data-prev aria-label="이전 좌석">‹</button>
      <button type="button" class="open">이 기기에서 좌석 열기</button>
      <button type="button" data-next aria-label="다음 좌석">›</button>
    </div>
    <p class="qr-hint"><b>기기가 한 대일 때 쓰는 버튼</b> 같은 화면에 뜬 QR은 찍을 수 없어서, 이 버튼이 QR을 대신합니다. 누르면 앱이 열리고 QR을 찍은 것과 똑같이 바로 처리됩니다.</p>
    <div class="row"><button type="button" data-close>닫기</button></div>
  </dialog>
  <dialog class="qr ask" id="qr-ask" aria-labelledby="qr-ask-h">
    <h2 id="qr-ask-h"></h2>
    <p class="ask-txt">기본 브라우저에서 열리고, QR을 찍은 것과 똑같이 <b>바로 처리</b>됩니다. 로그인 화면이 나오면 로그인만 하면 됩니다.</p>
    <div class="row2">
      <button type="button" data-no>취소</button>
      <a class="open" data-yes target="_blank" rel="noopener">확인</a>
    </div>
  </dialog>
</div>
<script type="application/json" id="seat-data">{{SEATS}}</script>`;

const IMG_DIR = "public/guide-img";

function template() {
  const src = fs.readFileSync("docs/guide.src.html", "utf8");
  for (const k of ["{{TEAM}}", "{{VIEWS}}"]) if (src.split(k).length !== 2) throw new Error(k + " 자리가 하나여야 합니다");
  let body = src.replace("{{TEAM}}", () => TEAM).replace("{{VIEWS}}", () => VIEWS);
  for (const m of body.matchAll(/\{\{IMG:(\w+)\}\}/g)) if (!fs.existsSync(path.join(IMG_DIR, m[1] + ".jpg"))) throw new Error("사진 없음: " + m[1]);
  body = body.replace(/\{\{IMG:(\w+)\}\}/g, "/guide-img/$1.jpg");
  const [head, rest] = [body.slice(0, body.indexOf("</style>")), body.slice(body.indexOf("</style>") + "</style>".length)];
  return (
    '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<meta name="robots" content="noindex, nofollow, noarchive">\n<meta name="referrer" content="no-referrer">\n' +
    head +
    "\n  img { max-width: 100%; }\n  body { margin: 0; }\n</style>\n</head>\n<body>\n" +
    rest +
    "\n</body>\n</html>\n"
  );
}

const tpl = template();
fs.writeFileSync(
  "src/lib/guideTemplate.ts",
  "// scripts/guide.mjs 가 docs/guide.src.html 에서 만든 파일입니다. 직접 고치지 마세요.\n// 이름·학번·좌석 QR은 들어 있지 않습니다. /g/<키> 가 열릴 때 DB에서 채웁니다.\nexport const GUIDE_TEMPLATE = " +
    JSON.stringify(tpl) +
    ";\n",
);
console.log("틀", Math.round(tpl.length / 1024), "KB");

const fi = process.argv.indexOf("--file");
if (fi > 0) {
  const outDir = process.argv[fi + 1];
  const key = process.env.GUIDE_KEY;
  if (!key) throw new Error("GUIDE_KEY 가 .env.local 에 없습니다");
  const res = await fetch(`http://localhost:3000/g/${key}`);
  if (!res.ok) throw new Error("로컬 서버 응답 " + res.status);
  let html = await res.text();
  html = html.replace(/\/guide-img\/(\w+)\.jpg/g, (_, n) => "data:image/jpeg;base64," + fs.readFileSync(path.join(IMG_DIR, n + ".jpg")).toString("base64"));
  fs.writeFileSync("docs/창파도서관-좌석예약-가이드.html", html);
  // 본문 조각: <title>~</style> 과 <body> 안쪽
  const title = html.slice(html.indexOf("<title>"), html.indexOf("</style>") + "</style>".length);
  const inner = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
  if (outDir) fs.writeFileSync(path.join(outDir, "seat-guide.html"), title + inner);
  console.log("파일", Math.round(html.length / 1024), "KB");
}
