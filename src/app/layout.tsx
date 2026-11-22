import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Shell } from "@/components/Shell";

const pretendard = localFont({
  src: "../fonts/PretendardVariable.woff2",
  variable: "--font-kr",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "창파도서관 좌석예약", template: "%s · 창파도서관 좌석예약" },
  description: "대구대학교 창파도서관 열람실의 빈자리를 확인하고 좌석을 예약하세요.",
  appleWebApp: { capable: true, title: "창파 좌석예약", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${pretendard.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
