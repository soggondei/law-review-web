export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";

const VWORLD_KEY = process.env.LURIS_KEY!;

// VWorld WMS 범용 프록시 — API 키를 서버에서 추가
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // 클라이언트에서 받은 파라미터 그대로 전달 + 키 추가
  searchParams.set("KEY", VWORLD_KEY);
  searchParams.set("DOMAIN", process.env.VERCEL_URL ? "law-review-web.vercel.app" : "localhost");

  try {
    const res = await fetch(`https://api.vworld.kr/req/wms?${searchParams}`, {
      signal: AbortSignal.timeout(8000),
    });
    const contentType = res.headers.get("content-type") ?? "image/png";
    const buf = await res.arrayBuffer();
    return new NextResponse(buf, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse(null, { status: 504 });
  }
}
