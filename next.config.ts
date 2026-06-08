import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse / tesseract.js는 워커 파일을 자체 처리 → Turbopack 번들링 제외
  serverExternalPackages: ["pdf-parse", "tesseract.js"],
};

export default nextConfig;
