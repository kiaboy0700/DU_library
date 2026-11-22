import type { Metadata, Viewport } from "next";
// 글꼴은 글자 묶음별로 잘게 나뉜 파일을 쓴다. 화면에 실제로 나온 글자가 들어 있는 묶음만 내려받는다
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = {
  title: { default: "창파도서관 좌석예약", template: "%s · 창파도서관 좌석예약" },
  description: "대구대학교 창파도서관 열람실의 빈자리를 확인하고 좌석을 예약하세요.",
  appleWebApp: { capable: true, title: "창파 좌석예약", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  // 화면 끝까지 쓰겠다고 알려야 아이폰의 아래 홈 막대 높이(safe-area)를 알 수 있다
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        <link rel="preconnect" href={process.env.NEXT_PUBLIC_SUPABASE_URL} crossOrigin="anonymous" />
      </head>
      <body className="min-h-full">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
