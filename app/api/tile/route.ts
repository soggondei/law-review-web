export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";

const VWORLD_KEY = process.env.LURIS_KEY!;

// VWorld WMTS Base 타일 프록시 — API 키를 서버에서 관리
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const z = searchParams.get("z");
  const x = searchParams.get("x");
  const y = searchParams.get("y");

  if (!z || !x || !y) return new NextResponse("z/x/y 필요", { status: 400 });

  const layer = searchParams.get("layer") === "satellite" ? "Satellite" : "Base";
  const ext   = layer === "Satellite" ? "jpeg" : "png";

  // VWorld WMTS URL: /{key}/{layer}/{TileMatrix}/{TileRow}/{TileCol}.{ext}
  const url = `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/${layer}/${z}/${y}/${x}.${ext}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return new NextResponse(null, { status: res.status });
    const buf = await res.arrayBuffer();
    return new NextResponse(buf, {
      headers: {
        "Content-Type": layer === "Satellite" ? "image/jpeg" : "image/png",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new NextResponse(null, { status: 504 });
  }
}
