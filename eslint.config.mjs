import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 이 앱의 화면은 모두 로그인 사용자별 데이터를 effect 안에서 불러와(비동기) 상태에 넣는다.
      // 규칙이 비동기 로드와 동기 setState를 구분하지 못해 전부 오탐이 되므로 끈다.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".claude/**", "public/sw.js"]),
]);

export default eslintConfig;
