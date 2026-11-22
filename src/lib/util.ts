const KST = "Asia/Seoul";

export const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: KST, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", weekday: "short" }).format(new Date(iso));

/** 남은 시간을 "1시간 05분" / "12:34" 형태로 */
export function fmtRemain(ms: number) {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}시간 ${String(m).padStart(2, "0")}분`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** 남은 시간을 분 단위로: "1시간 20분", "35분" */
export function fmtLeft(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m >= 60) return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 60)}시간`;
  return `${m}분`;
}

/** 혼잡도 단계: 색과 이름 */
export function level(pct: number) {
  if (pct >= 80) return { name: "혼잡", color: "#b3261e", bg: "#fbeceb" };
  if (pct >= 50) return { name: "보통", color: "#8a5a00", bg: "#fbf3df" };
  return { name: "여유", color: "#006a5b", bg: "#e9f5f2" };
}

/** 브라우저 위치. 실패하면 null (서버가 데모 모드가 아니면 오류로 안내) */
export function getPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.");

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
