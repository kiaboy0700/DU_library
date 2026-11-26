import type { Metadata, Viewport } from "next";
// 글꼴은 글자 묶음별로 잘게 나뉜 파일을 쓴다. 화면에 실제로 나온 글자가 들어 있는 묶음만 내려받는다
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Shell } from "@/components/Shell";

const SPLASH_CSS = '#splash { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; background: #fff; transition: opacity 0.3s ease, visibility 0.3s; } #splash img { width: 96px; height: 96px; } #splash p { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; color: #231f20; } #splash span { position: relative; width: 120px; height: 4px; overflow: hidden; border-radius: 2px; background: #e3ebe8; } #splash span::after { content: ""; position: absolute; inset: 0; width: 40%; border-radius: 2px; background: #00826f; animation: splash-bar 1.1s ease-in-out infinite; } @keyframes splash-bar { from { left: -40%; } to { left: 100%; } } body[data-ready] #splash { opacity: 0; visibility: hidden; pointer-events: none; } @media (prefers-reduced-motion: reduce) { #splash span::after { animation: none; width: 100%; } }';

export const metadata: Metadata = {
  title: { default: "DU-library", template: "%s · DU-library" },
  description: "대구대학교 창파도서관 열람실의 빈자리를 확인하고 좌석을 예약하세요.",
  appleWebApp: { capable: true, title: "DU-library", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  // 앱처럼 쓰는 화면이라 두 손가락·두 번 누르기 확대를 막는다
  maximumScale: 1,
  userScalable: false,
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
        {/* 로딩 화면: 첫 화면이 준비되면 Providers 가 걷어 낸다 */}
        <style dangerouslySetInnerHTML={{ __html: SPLASH_CSS }} />
        <div id="splash" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/symbol.png" alt="" width={96} height={96} />
          <p>창파도서관 좌석예약</p>
          <span />
        </div>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
