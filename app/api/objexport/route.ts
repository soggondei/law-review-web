export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { buildObj, type ObjGroup } from "@/lib/objexport";
import { overpassQuery, vworldParcelParams, parseVworldRings } from "@/lib/geo-fetch";

const M_PER_LAT  = 111320;

// ── GET handler ──────────────────────────────────────────────────────────────

type Pt2 = [number, number];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat    = parseFloat(searchParams.get("lat") ?? "0");
  const lng    = parseFloat(searchParams.get("lng") ?? "0");
  const addr   = searchParams.get("addr") ?? "site";
  const radius = Math.min(Math.max(parseInt(searchParams.get("radius") ?? "30"), 10), 200);
  if (!lat || !lng) return NextResponse.json({ error: "lat/lng 필요" }, { status: 400 });

  const mPerLng = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat    = radius / M_PER_LAT;
  const dLng    = radius / mPerLng;

  const toLocal = ([lon, la]: number[]): Pt2 => [
    (lon - lng) * mPerLng,
    (la  - lat) * M_PER_LAT,
  ];

  const parcels:   Pt2[][] = [];
  const buildings: Pt2[][] = [];
  const roads:     Pt2[][] = [];
  const sidewalks: Pt2[][] = [];

  const SIDEWALK_TAGS = new Set(["footway", "pedestrian", "path", "steps", "cycleway"]);

  // ── 1. Vworld 지적 필지 ──────────────────────────────────────────────────
  try {
    const vwParams = vworldParcelParams(lng, lat, dLng, dLat, radius);
    const vwRes = await fetch(`https://api.vworld.kr/req/data?${vwParams}`, { signal: AbortSignal.timeout(8000) });
    const vwData = await vwRes.json();
    for (const pts of parseVworldRings(vwData, toLocal)) parcels.push(pts);
  } catch { /* 필지 레이어 생략 */ }

  // ── 2. OSM 건물·도로·보도 ────────────────────────────────────────────────
  const obbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
  const query =
    `[out:json][timeout:${radius <= 50 ? 10 : 15}];` +
    `(way["building"](${obbox});` +
    `way["highway"~"primary|secondary|tertiary|residential|pedestrian|footway|unclassified|service|living_street|path|steps|cycleway"](${obbox}););` +
    `out geom;`;
  try {
    const text = await overpassQuery("data=" + encodeURIComponent(query));
    const osmData = JSON.parse(text);
    for (const el of (osmData.elements ?? []) as any[]) {
      if (!el.geometry?.length) continue;
      const localPts: Pt2[] = el.geometry.map(
        ({ lat: y, lon: x }: { lat: number; lon: number }) => toLocal([x, y])
      );
      if (el.tags?.building) {
        const last = localPts[localPts.length - 1];
        const first = localPts[0];
        if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6)
          localPts.pop();
        if (localPts.length >= 3) buildings.push(localPts);
      } else if (el.tags?.highway) {
        const hw: string = el.tags.highway;
        if (SIDEWALK_TAGS.has(hw)) sidewalks.push(localPts);
        else roads.push(localPts);
      }
    }
  } catch { /* OSM 레이어 생략 */ }

  // ── OBJ 생성 (lib/objexport.ts) ─────────────────────────────────────────
  const groups: ObjGroup[] = [
    { name: "PARCEL",    polygons: parcels },
    { name: "BUILDINGS", polygons: buildings },
    { name: "ROADS",     polylines: roads,     polylineWidth: 1.5 },  // 반폭 1.5m = 폭 3m
    { name: "SIDEWALK",  polylines: sidewalks, polylineWidth: 0.75 }, // 반폭 0.75m = 폭 1.5m
  ];
  const obj  = buildObj(groups, { addr, radius });
  const safe = addr.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");

  return new NextResponse(obj, {
    headers: {
      "Content-Type": "model/obj",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`지적도_${safe}_${radius}m.obj`)}`,
    },
  });
}
