export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";

// lt_c_lsmd01 WFS 레이어가 현재 API 키 등급으로 지원되지 않음.
// 즉시 404 반환 → 프론트에서 대지면적 기반 정사각형 폴백을 바로 사용.
// VWorld 기관 인증 키로 업그레이드되면 아래 주석 처리된 GET 구현으로 교체.
export async function GET(_req: NextRequest) {
  return NextResponse.json({ error: "지적 폴리곤 API 미지원" }, { status: 404 });
}

/* ───── API 키 업그레이드 시 복구 코드 ─────────────────────────────────────
const VWORLD_KEY = process.env.LURIS_KEY!;
const M_PER_LAT  = 111320;

function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}
function openRing(raw: number[][]): number[][] {
  const last = raw[raw.length - 1], first = raw[0];
  if (last[0] === first[0] && last[1] === first[1]) return raw.slice(0, -1);
  return raw;
}
function fixAxis5179(raw: number[][]): number[][] {
  if (Math.abs(raw[0][0]) > 1_500_000 && Math.abs(raw[0][1]) < 1_500_000)
    return raw.map(([a, b]) => [b, a]);
  return raw;
}

export async function GET(req: NextRequest) {
  const pnu = new URL(req.url).searchParams.get("pnu");
  if (!pnu) return NextResponse.json({ error: "pnu 필요" }, { status: 400 });
  const params = new URLSearchParams({
    SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature",
    TYPENAME: "lt_c_lsmd01", CQL_FILTER: `pnu='${pnu}'`,
    OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326",
    KEY: VWORLD_KEY, DOMAIN: process.env.VERCEL_URL ?? "localhost",
  });
  const res = await fetch(`https://api.vworld.kr/req/wfs?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return NextResponse.json({ error: "WFS 요청 실패" }, { status: 502 });
  const data  = await res.json();
  const feature = data.features?.[0];
  if (!feature) return NextResponse.json({ error: "필지 데이터 없음" }, { status: 404 });
  const geom = feature.geometry;
  let raw: number[][] = [];
  if (geom.type === "Polygon") raw = geom.coordinates[0];
  else if (geom.type === "MultiPolygon") raw = geom.coordinates[0][0];
  if (!raw.length) return NextResponse.json({ error: "좌표 없음" }, { status: 500 });
  const isWGS84 = Math.abs(raw[0][0]) <= 180;
  let local: [number, number][];
  if (isWGS84) {
    const pts = openRing(raw);
    const refLng = pts.reduce((s, c) => s + c[0], 0) / pts.length;
    const refLat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
    const mPerLng = M_PER_LAT * Math.cos((refLat * Math.PI) / 180);
    local = pts.map(([lng, lat]) => [(lng - refLng) * mPerLng, (lat - refLat) * M_PER_LAT]) as [number, number][];
  } else {
    const pts = openRing(fixAxis5179(raw));
    const cx = pts.reduce((s, c) => s + c[0], 0) / pts.length;
    const cy = pts.reduce((s, c) => s + c[1], 0) / pts.length;
    local = pts.map(([x, y]) => [x - cx, y - cy]) as [number, number][];
  }
  if (signedArea(local) < 0) local.reverse();
  const xs = local.map(p => p[0]), ys = local.map(p => p[1]);
  return NextResponse.json({
    localCoords: local,
    bboxAspect: (Math.max(...xs) - Math.min(...xs)) / Math.max(Math.max(...ys) - Math.min(...ys), 0.1),
  });
}
──────────────────────────────────────────────────────────────────────────── */
