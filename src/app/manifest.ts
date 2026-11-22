import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "창파도서관 좌석예약",
    short_name: "창파 좌석예약",
    description: "대구대학교 창파도서관 열람실 좌석 예약",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#00826f",
    lang: "ko",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
