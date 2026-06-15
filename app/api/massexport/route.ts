export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { buildDae, type DaeBuilding } from "@/lib/collada";
import { overpassQuery, vworldParcelParams, parseVworldRings } from "@/lib/geo-fetch";

const M_PER_LAT  = 111320;
type Pt2 = [number, number];

// ── GET handler ──────────────────────────────────────────────────────────────

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
  const toLocal = ([lon, la]: number[]): Pt2 => [(lon - lng) * mPerLng, (la - lat) * M_PER_LAT];

  const SIDEWALK_TAGS = new Set(["footway", "pedestrian", "path", "steps", "cycleway"]);
  const buildings: DaeBuilding[] = [];
  const parcels:   Pt2[][] = [];
  const roads:     Pt2[][] = [];
  const sidewalks: Pt2[][] = [];

  // Vworld 필지
  try {
    const vwParams = vworldParcelParams(lng, lat, dLng, dLat, radius);
    const vw = await fetch(`https://api.vworld.kr/req/data?${vwParams}`, { signal: AbortSignal.timeout(8000) });
    const vwData = await vw.json();
    for (const pts of parseVworldRings(vwData, toLocal)) parcels.push(pts);
  } catch { /* 생략 */ }

  // OSM 건물(높이 포함) + 도로
  const obbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
  const query =
    `[out:json][timeout:${radius <= 50 ? 12 : 18}];` +
    `(way["building"](${obbox});` +
    `way["highway"~"primary|secondary|tertiary|residential|pedestrian|footway|unclassified|service|living_street|path|steps|cycleway"](${obbox}););` +
    `out geom tags;`;
  try {
    const text = await overpassQuery("data=" + encodeURIComponent(query));
    const osmData = JSON.parse(text);
    for (const el of (osmData.elements ?? []) as any[]) {
      if (!el.geometry?.length) continue;
      const localPts: Pt2[] = el.geometry.map(({ lat: y, lon: x }: any) => toLocal([x, y]));
      if (el.tags?.building) {
        const last = localPts[localPts.length - 1];
        if (Math.abs(localPts[0][0] - last[0]) < 1e-6 && Math.abs(localPts[0][1] - last[1]) < 1e-6) localPts.pop();
        if (localPts.length < 3) continue;
        const rawH  = parseFloat(el.tags.height ?? "");
        const lvls  = parseInt(el.tags["building:levels"] ?? "");
        const height = Number.isFinite(rawH) && rawH > 0 ? rawH : Number.isFinite(lvls) && lvls > 0 ? lvls * 3.5 : 10.5;
        buildings.push({ pts: localPts, height });
      } else if (el.tags?.highway) {
        (SIDEWALK_TAGS.has(el.tags.highway) ? sidewalks : roads).push(localPts);
      }
    }
  } catch { /* 생략 */ }

  const dae = buildDae({
    buildings,
    parcels:   parcels.map(pts => ({ pts })),
    roads:     roads.map(pts => ({ pts, width: 3 })),
    sidewalks: sidewalks.map(pts => ({ pts, width: 1.5 })),
    addr,
    radius,
  });
  const safe = addr.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");

  return new NextResponse(dae, {
    headers: {
      "Content-Type": "model/vnd.collada+xml",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`매스_${safe}_${radius}m.dae`)}`,
    },
  });
}
