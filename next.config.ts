import type { NextConfig } from "next";

// 로그인 사용자별 실시간 화면이라 페이지는 전부 클라이언트에서 데이터를 가져온다.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
