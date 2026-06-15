export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { overpassQuery, vworldParcelParams, parseVworldRings, fetchElevGrid, bilinear, GEO_GRID_N } from "@/lib/geo-fetch";

const M_PER_LAT  = 111320;
const GRID_N = GEO_GRID_N;

// ── 반환 타입 (MassPreview3D에서 사용) ────────────────────────────────────────

export type TerrainGrid = {
  grid:    number[][];
  rows:    number;
  cols:    number;
  minElev: number;
  maxElev: number;
};

export type MassBuilding = { pts: [number, number][]; height: number; baseElev: number };
export type MassParcel   = { pts: [number, number][] };
export type MassRoad     = { pts: [number, number][]; isSidewalk: boolean };

export type MassPreviewData = {
  buildings: MassBuilding[];
  parcels:   MassParcel[];
  roads:     MassRoad[];
  radius:    number;
  terrain:   TerrainGrid | null;
};

// ── GET /api/masspreview?lat=&lng=&radius= ───────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat    = parseFloat(searchParams.get("lat") ?? "0");
  const lng    = parseFloat(searchParams.get("lng") ?? "0");
  const radius = Math.min(Math.max(parseInt(searchParams.get("radius") ?? "30"), 10), 200);
  if (!lat || !lng) return NextResponse.json({ error: "lat/lng 필요" }, { status: 400 });

  const mPerLng = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat    = radius / M_PER_LAT;
  const dLng    = radius / mPerLng;
  const toLocal = ([lon, la]: number[]): [number, number] => [
    (lon - lng) * mPerLng,
    (la  - lat) * M_PER_LAT,
  ];

  const SIDEWALK_TAGS = new Set(["footway", "pedestrian", "path", "steps", "cycleway"]);

  // ── 병렬 fetch: terrain + Vworld + OSM ───────────────────────────────────

  const vwParams = vworldParcelParams(lng, lat, dLng, dLat, radius);
  const obbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
  const osmQuery =
    `[out:json][timeout:${radius <= 50 ? 12 : 18}];` +
    `(way["building"](${obbox});` +
    `way["highway"~"primary|secondary|tertiary|residential|pedestrian|footway|unclassified|service|living_street|path|steps|cycleway"](${obbox}););` +
    `out geom tags;`;

  const [elevGrid, vwData, osmData] = await Promise.all([
    fetchElevGrid(lat, lng, dLat, dLng),
    fetch(`https://api.vworld.kr/req/data?${vwParams}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json()).catch(() => null),
    overpassQuery("data=" + encodeURIComponent(osmQuery))
      .then(t => JSON.parse(t)).catch(() => null),
  ]);

  // ── Terrain ───────────────────────────────────────────────────────────────

  let terrain: TerrainGrid | null = null;
  if (elevGrid) {
    const flat = elevGrid.flat();
    terrain = {
      grid:    elevGrid,
      rows:    GRID_N,
      cols:    GRID_N,
      minElev: Math.min(...flat),
      maxElev: Math.max(...flat),
    };
  }

  // ── Vworld 필지 ───────────────────────────────────────────────────────────

  const parcels: MassParcel[] = parseVworldRings(vwData, toLocal).map(pts => ({ pts }));

  // ── OSM 건물 + 도로 ───────────────────────────────────────────────────────

  const buildings: MassBuilding[] = [];
  const roads:     MassRoad[]     = [];

  for (const el of (osmData?.elements ?? []) as any[]) {
    if (!el.geometry?.length) continue;
    const localPts: [number, number][] = el.geometry.map(
      ({ lat: y, lon: x }: { lat: number; lon: number }) => toLocal([x, y])
    );
    if (el.tags?.building) {
      const last = localPts[localPts.length - 1];
      if (Math.abs(localPts[0][0] - last[0]) < 1e-6 && Math.abs(localPts[0][1] - last[1]) < 1e-6)
        localPts.pop();
      if (localPts.length < 3) continue;
      const rawH   = parseFloat(el.tags.height ?? "");
      const levels = parseInt(el.tags["building:levels"] ?? "");
      const height = Number.isFinite(rawH) && rawH > 0 ? rawH
        : Number.isFinite(levels) && levels > 0 ? levels * 3.5 : 10.5;

      // 건물 중심 elevation → baseElev (terrain 없으면 0)
      let baseElev = 0;
      if (terrain) {
        let sx = 0, sy = 0;
        for (const [x, y] of localPts) { sx += x; sy += y; }
        const cx = sx / localPts.length, cy = sy / localPts.length;
        const gr = (cy / radius + 1) / 2 * (GRID_N - 1);
        const gc = (cx / radius + 1) / 2 * (GRID_N - 1);
        baseElev = bilinear(terrain.grid, gr, gc) - terrain.minElev;
      }

      buildings.push({ pts: localPts, height, baseElev });
    } else if (el.tags?.highway) {
      roads.push({ pts: localPts, isSidewalk: SIDEWALK_TAGS.has(el.tags.highway) });
    }
  }

  return NextResponse.json({ buildings, parcels, roads, radius, terrain } satisfies MassPreviewData);
}
