export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import https from "https";

const VWORLD_KEY = process.env.LURIS_KEY!;
const M_PER_LAT  = 111320;
const OVERPASS_HOSTS = ["overpass-api.de", "overpass.kumi.systems", "z.overpass-api.de"];
const GRID_N = 5;

function httpsPost(host: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: "/api/interpreter", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "law-review-web/1.0 (contact:soggon@naver.com)",
          "Accept": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) reject(new Error(`Overpass ${res.statusCode}`));
          else resolve(Buffer.concat(chunks).toString("utf-8"));
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(new Error("timeout")); });
    req.write(body); req.end();
  });
}

async function fallbackPost(body: string): Promise<string> {
  let last: Error | null = null;
  for (const h of OVERPASS_HOSTS) { try { return await httpsPost(h, body); } catch (e: any) { last = e; } }
  throw last ?? new Error("Overpass unreachable");
}

// ── Open-Elevation 5×5 grid ───────────────────────────────────────────────────

async function fetchElevGrid(
  lat: number, lng: number, dLat: number, dLng: number,
): Promise<number[][] | null> {
  const locations: { latitude: number; longitude: number }[] = [];
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      locations.push({
        latitude:  lat + dLat * ((2 * r) / (GRID_N - 1) - 1),
        longitude: lng + dLng * ((2 * c) / (GRID_N - 1) - 1),
      });
    }
  }
  try {
    const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ locations }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const results: { elevation: number }[] = json.results ?? [];
    if (results.length !== GRID_N * GRID_N) return null;
    const grid: number[][] = [];
    for (let r = 0; r < GRID_N; r++) {
      grid.push(results.slice(r * GRID_N, (r + 1) * GRID_N).map(x => x.elevation));
    }
    return grid;
  } catch {
    return null;
  }
}

function bilinear(grid: number[][], r: number, c: number): number {
  const rows = grid.length, cols = grid[0].length;
  const r0 = Math.max(0, Math.min(rows - 2, Math.floor(r)));
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(c)));
  const dr = r - r0, dc = c - c0;
  return (
    grid[r0][c0]           * (1 - dr) * (1 - dc) +
    grid[r0][c0 + 1]       * (1 - dr) * dc +
    grid[r0 + 1][c0]       * dr       * (1 - dc) +
    grid[r0 + 1][c0 + 1]   * dr       * dc
  );
}

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

  const vwSize = radius <= 30 ? 50 : radius <= 50 ? 100 : 200;
  const vwParams = new URLSearchParams({
    service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN",
    key: VWORLD_KEY, domain: "localhost", size: String(vwSize), page: "1",
    geomFilter: `BOX(${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat})`,
    crs: "EPSG:4326", format: "json",
  });

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
    fallbackPost("data=" + encodeURIComponent(osmQuery))
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

  const parcels: MassParcel[] = [];
  for (const f of (vwData?.response?.result?.featureCollection?.features ?? []) as any[]) {
    const geom = f.geometry; if (!geom) continue;
    const rings: number[][][] = geom.type === "Polygon" ? geom.coordinates
      : geom.type === "MultiPolygon" ? (geom.coordinates as number[][][][]).flat() : [];
    for (const ring of rings) {
      const pts = ring.map(toLocal);
      if (pts.length > 1) {
        const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
        if (Math.abs(fx - lx) < 1e-6 && Math.abs(fy - ly) < 1e-6) pts.pop();
      }
      if (pts.length >= 3) parcels.push({ pts });
    }
  }

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
