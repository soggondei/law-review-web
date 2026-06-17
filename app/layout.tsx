import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "건축 법규검토",
  description: "주소·용도·행위 입력 → 법제처·LURIS·건축물대장 API 기반 자동 법규검토",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
