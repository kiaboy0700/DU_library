# 창파도서관 좌석예약

대구대학교 창파도서관 열람실(2층·5층) 좌석 예약 웹. 창의문제해결 과제의 최종 아이디어 **"붐빌수록 더 엄격해지는 스마트 좌석 예약 웹"** 을 구현했습니다.

- 실시간 좌석맵과 당일 예약 (1회 최대 4시간, 연장)
- 좌석 QR 하나로 체크인·외출 복귀·연장·반납·자리비움 신고 (키오스크 없음)
- 혼잡도 연동 규칙: 이용률이 높을수록 외출 허용 시간과 신고 응답 시간이 짧아짐
- 노쇼·외출 초과·자리비움 자동 회수와 벌점, 예약 정지, 이의신청
- 웹 푸시 알림(PWA), 요일·시간대별 혼잡도
- 관리자: 실시간 관제, 대리 배정·체크인, 신고·도움 요청 처리, 제재, 좌석·열람실·운영 기간 설정, 좌석 QR 인쇄

## 기술
Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Supabase (Auth, Postgres, Realtime, pg_cron, pg_net) · Vercel

모든 규칙(예약, 체크인, 벌점, 자동 반납)은 Postgres 함수 안에 있습니다. `supabase/migrations/0002_functions.sql` 의 `tick()` 이 pg_cron 으로 1분마다 실행되어 시간 기반 처리를 합니다.

## 로컬 실행
1. `.env.example` 을 `.env.local` 로 복사해 값을 채웁니다.
2. DB 준비
   ```bash
   node scripts/db.mjs supabase/migrations/0001_schema.sql supabase/migrations/0002_functions.sql supabase/migrations/0003_admin.sql
   node scripts/seed.mjs
   node scripts/db.mjs supabase/migrations/0004_demo.sql supabase/migrations/0005_settings_log.sql
   ```
3. `npm run dev` 후 http://localhost:3000

계정은 회원가입 없이 시드로 만듭니다(학번 로그인). 관리자 학번은 `admin`, 비밀번호는 `.env.local` 의 `SEED_PASSWORD` 입니다.

## 점검
```bash
node scripts/smoke.mjs   # 로그인부터 예약·체크인·신고·자동 반납까지 한 번에 확인
```

## 시연할 때
관리자 > 운영 설정의 "운영시간 무시"와 "위치 확인 끄기"가 켜져 있으면 언제 어디서나 예약과 QR 체크인이 됩니다. 실제 운영에서는 둘 다 끕니다. 관리자 > 관제의 "발표·시연용 도구"로 열람실을 원하는 이용률까지 채울 수 있습니다.

디자인 기준은 `DESIGN.md`, 제품 맥락은 `PRODUCT.md` 에 있습니다.
