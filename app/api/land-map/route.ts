export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";

const LURIS_KEY = process.env.LURIS_KEY!;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat  = parseFloat(searchParams.get("lat") || "0");
  const lng  = parseFloat(searchParams.get("lng") || "0");
  const w    = parseInt(searchParams.get("w") || "600");
  const h    = parseInt(searchParams.get("h") || "480");

  if (!lat || !lng) return NextResponse.json({ error: "lat/lng 필요" }, { status: 400 });

  // ±0.003도 ≈ ±330m
  const delta = 0.003;
  // WMS 1.3.0 + EPSG:4326 → BBOX: minLat,minLng,maxLat,maxLng
  const bbox = `${lat - delta},${lng - delta},${lat + delta},${lng + delta}`;

  const params = new URLSearchParams({
    SERVICE:     "WMS",
    REQUEST:     "GetMap",
    VERSION:     "1.3.0",
    // lt_c_uq111: 토지이용계획 전체 (용도지역 색상 + 지적 + 교육환경보호구역 등 통합)
    LAYERS:      "lt_c_uq111",
    STYLES:      "",
    CRS:         "EPSG:4326",
    BBOX:        bbox,
    WIDTH:       String(w),
    HEIGHT:      String(h),
    FORMAT:      "image/png",
    TRANSPARENT: "TRUE",
    KEY:         LURIS_KEY,
    DOMAIN:      process.env.VERCEL_URL ? "law-review-web.vercel.app" : "localhost",
  });

  try {
    const res = await fetch(`https://api.vworld.kr/req/wms?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NextResponse.json({ error: "WMS 요청 실패" }, { status: 502 });

    const contentType = res.headers.get("content-type") || "";
    // WMS가 에러 XML을 반환하는 경우도 있음
    if (contentType.includes("xml") || contentType.includes("text")) {
      const text = await res.text();
      return NextResponse.json({ error: "WMS 에러: " + text.slice(0, 200) }, { status: 502 });
    }

    const buf = await res.arrayBuffer();
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
