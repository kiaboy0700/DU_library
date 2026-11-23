/** 알림 종류. 제목만 보고 정한다: 푸시(이모지)와 알림 목록(아이콘·색)이 같은 규칙을 쓴다 */
export type NoticeKind = "penalty" | "report" | "time" | "seat" | "help" | "notice" | "ok" | "etc";

const RULES: [NoticeKind, RegExp][] = [
  ["penalty", /벌점|정지되었|허위 신고로|신고 전에/],
  ["ok", /승인|해제|취소되었|처리 완료|확인 완료/],
  ["report", /자리 확인 요청|자리비움 신고|신고자 메시지|허위 신고|신고 결과/],
  ["time", /분 전|분 뒤|연장|시간 종료|운영 종료|시간이 지났/],
  ["seat", /빈자리|반납|좌석이 변경|배정|체크인|복귀|사용이 중지|폐쇄|우선 예약/],
  ["help", /도움 요청|관리자 메시지|이의신청|반려/],
  ["notice", /공지/],
];

export const NOTICE_EMOJI: Record<NoticeKind, string> = { penalty: "⚠️", report: "🚨", time: "⏰", seat: "💺", help: "💬", notice: "📢", ok: "✅", etc: "🔔" };
export const NOTICE_LABEL: Record<NoticeKind, string> = { penalty: "벌점·제재", report: "신고", time: "시간", seat: "좌석", help: "도움 요청", notice: "공지", ok: "처리 결과", etc: "알림" };

export function noticeKind(title: string): NoticeKind {
  for (const [k, re] of RULES) if (re.test(title)) return k;
  return "etc";
}
