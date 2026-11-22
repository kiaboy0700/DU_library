// 브라우저 콘솔용 점검: 짧은 글자가 여러 줄로 깨진 곳, 넘친 글자, 한 줄에서 높이가 다른 버튼을 찾는다.
// 사용: 페이지에서 이 파일 내용을 실행하면 문제 목록(JSON)을 돌려준다.
(() => {
  const out = [];
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
  };
  const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
  const scrollable = (e) => e.closest('[class*="overflow-auto"],[class*="overflow-x-auto"],[class*="overflow-y-auto"]');
  // 1) 짧은 글자가 줄바꿈된 곳 (이름표·버튼·표 머리글·태그)
  for (const e of document.querySelectorAll("main dt, main th, main button, main a, main label > span, main h1, main h2, main h3, main summary, main [class*='rounded-md'], header a, header button, nav a")) {
    if (!vis(e)) continue;
    const t = (e.innerText || "").trim();
    if (!t || t.length > 14 || t.includes("\n")) continue;
    const cs = getComputedStyle(e);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const range = document.createRange();
    range.selectNodeContents(e);
    const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    if (lines > 1 && e.getBoundingClientRect().height - pad > lh * 1.6) out.push({ type: "짧은 글 줄바꿈", text: t, tag: e.tagName.toLowerCase(), w: Math.round(e.getBoundingClientRect().width) });
  }
  // 2) 글자가 잘리거나 넘친 곳
  for (const e of document.querySelectorAll("main *, header *")) {
    if (!vis(e) || scrollable(e) || !own(e)) continue;
    const cs = getComputedStyle(e);
    if (cs.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1) out.push({ type: "말줄임", text: own(e).slice(0, 30), tag: e.tagName.toLowerCase() });
    else if (e.scrollWidth > e.clientWidth + 2 && cs.overflowX === "visible" && e.clientWidth > 0 && cs.display !== "inline") out.push({ type: "넘침", text: own(e).slice(0, 30), tag: e.tagName.toLowerCase(), over: e.scrollWidth - e.clientWidth });
  }
  // 3) 같은 줄에 있는데 높이가 다른 버튼
  const rows = new Map();
  for (const e of document.querySelectorAll("main button, main a[class*='min-h'], main input, main select")) {
    if (!vis(e) || e.type === "checkbox" || e.type === "radio" || e.type === "range") continue;
    const r = e.getBoundingClientRect();
    const p = e.parentElement;
    if (!rows.has(p)) rows.set(p, []);
    rows.get(p).push({ h: Math.round(r.height), top: Math.round(r.top), t: (e.innerText || e.placeholder || e.getAttribute("aria-label") || "").trim().slice(0, 12) });
  }
  for (const list of rows.values()) {
    const sameRow = list.filter((x) => Math.abs(x.top - list[0].top) < 8);
    if (sameRow.length > 1 && new Set(sameRow.map((x) => x.h)).size > 1) out.push({ type: "높이 다름", items: sameRow.map((x) => `${x.t}:${x.h}`).join(" | ") });
  }
  // 4) 화면 가로 넘침
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push({ type: "페이지 가로 넘침", over: document.documentElement.scrollWidth - innerWidth });
  const seen = new Set();
  return JSON.stringify(out.filter((o) => !seen.has(JSON.stringify(o)) && seen.add(JSON.stringify(o))).slice(0, 40));
})();
