/**
 * 화면을 바로 띄우기 위한 작은 저장소.
 * 마지막으로 받은 값을 브라우저에 남겨 두었다가, 다음에 열 때 먼저 보여 주고 뒤에서 새 값으로 바꾼다.
 * 좌석 현황처럼 금방 바뀌는 값이라 오래된 것은 쓰지 않는다.
 */
const PREFIX = "du-cache:";

export function readCache<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { at, value } = JSON.parse(raw) as { at: number; value: T };
    return Date.now() - at <= maxAgeMs ? value : null;
  } catch {
    return null;
  }
}

export function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {}
}

export function clearCache() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch {}
}
