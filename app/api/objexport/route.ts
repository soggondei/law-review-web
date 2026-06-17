export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { buildObj, type ObjGroup } from "@/lib/objexport";
import {
  createSafeMassFootprint,
  createSetbackEdgeClearances,
  type MassPoint,
  type MassRoad,
} from "@/lib/mass-study";

const VWORLD_KEY = process.env.LURIS_KEY!;
const M_PER_LAT  = 111320;
const OVERPASS_HOSTS = [
  "overpass-api.de",
  "overpass.kumi.systems",
  "z.overpass-api.de",
];

// ── Overpass HTTPS ───────────────────────────────────────────────────────────

function httpsPost(host: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path: "/api/interpreter",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "law-review-web/1.0 (contact:soggon@naver.com)",
          "Accept": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400)
            reject(new Error(`Overpass ${res.statusCode}`));
          else resolve(Buffer.concat(chunks).toString("utf-8"));
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function httpsPostWithFallback(body: string): Promise<string> {
  let lastErr: Error | null = null;
  for (const host of OVERPASS_HOSTS) {
    try { return await httpsPost(host, body); }
    catch (e: unknown) { lastErr = e instanceof Error ? e : new Error(String(e)); }
  }
  throw lastErr ?? new Error("Overpass unreachable");
}

// ── GET handler ──────────────────────────────────────────────────────────────

type Pt2 = [number, number];
type VworldFeature = {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
};
type VworldResponse = {
  response?: {
    result?: {
      featureCollection?: {
        features?: VworldFeature[];
      };
    };
  };
};
type OsmElement = {
  geometry?: { lat: number; lon: number }[];
  tags?: {
    building?: string;
    highway?: string;
  };
};
type OsmResponse = {
  elements?: OsmElement[];
};

function translatePolygon(points: Pt2[], dx: number, dy: number): Pt2[] {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

function parseSitePolygon(value: string | null): MassPoint[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((point): MassPoint[] => {
      if (!Array.isArray(point) || point.length < 2) return [];
      const x = Number(point[0]);
      const y = Number(point[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? [[x, y]] : [];
    });
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat    = parseFloat(searchParams.get("lat") ?? "0");
  const lng    = parseFloat(searchParams.get("lng") ?? "0");
  const addr   = searchParams.get("addr") ?? "site";
  const radius = Math.min(Math.max(parseInt(searchParams.get("radius") ?? "30"), 10), 200);
  const offsetX = parseFloat(searchParams.get("offsetX") ?? "0") || 0;
  const offsetY = parseFloat(searchParams.get("offsetY") ?? "0") || 0;
  const buildingArea = parseFloat(searchParams.get("buildingArea") ?? "0") || 0;
  const floors = Math.max(0, parseInt(searchParams.get("floors") ?? "0"));
  const setback = Math.max(0, parseFloat(searchParams.get("setback") ?? "0") || 0);
  const buildingLineSetback = Math.max(0, parseFloat(searchParams.get("buildingLineSetback") ?? "0") || setback);
  const adjacentSetback = Math.max(0, parseFloat(searchParams.get("adjacentSetback") ?? "0") || setback);
  const sitePolygon = parseSitePolygon(searchParams.get("site"));
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
  const vwSize = radius <= 30 ? 50 : radius <= 50 ? 100 : 200;
  const vwParams = new URLSearchParams({
    service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN",
    key: VWORLD_KEY, domain: "localhost", size: String(vwSize), page: "1",
    geomFilter: `BOX(${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat})`,
    crs: "EPSG:4326", format: "json",
  });
  try {
    const vwRes = await fetch(`https://api.vworld.kr/req/data?${vwParams}`, {
      signal: AbortSignal.timeout(8000),
    });
    const vwData = await vwRes.json() as VworldResponse;
    const features = vwData.response?.result?.featureCollection?.features ?? [];
    for (const feature of features) {
      const geom = feature.geometry;
      if (!geom) continue;
      let rings: number[][][] = [];
      if (geom.type === "Polygon") rings = geom.coordinates as number[][][];
      else if (geom.type === "MultiPolygon") rings = (geom.coordinates as number[][][][]).flat();
      for (const ring of rings) {
        const pts = ring.map(toLocal);
        if (pts.length > 1) {
          const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
          if (Math.abs(fx - lx) < 1e-6 && Math.abs(fy - ly) < 1e-6) pts.pop();
        }
        if (pts.length >= 3) parcels.push(pts);
      }
    }
  } catch { /* 필지 레이어 생략 */ }

  // ── 2. OSM 건물·도로·보도 ────────────────────────────────────────────────
  const obbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
  const query =
    `[out:json][timeout:${radius <= 50 ? 10 : 15}];` +
    `(way["building"](${obbox});` +
    `way["highway"~"primary|secondary|tertiary|residential|pedestrian|footway|unclassified|service|living_street|path|steps|cycleway"](${obbox}););` +
    `out geom;`;
  try {
    const text = await httpsPostWithFallback("data=" + encodeURIComponent(query));
    const osmData = JSON.parse(text) as OsmResponse;
    for (const el of osmData.elements ?? []) {
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

  const dx = -offsetX;
  const dy = -offsetY;
  const shiftedParcels = parcels.map((polygon) => translatePolygon(polygon, dx, dy));
  const shiftedBuildings = buildings.map((polygon) => translatePolygon(polygon, dx, dy));
  const shiftedRoads = roads.map((polyline) => translatePolygon(polyline, dx, dy));
  const shiftedSidewalks = sidewalks.map((polyline) => translatePolygon(polyline, dx, dy));
  const massRoads: MassRoad[] = shiftedRoads.map((coords) => ({ coords, width: 3 }));
  const edgeClearances = sitePolygon.length >= 3 && massRoads.length
    ? createSetbackEdgeClearances(sitePolygon, massRoads, {
      buildingLine: buildingLineSetback,
      adjacent: adjacentSetback,
    })
    : undefined;

  const plannedMass = sitePolygon.length >= 3 && buildingArea > 0 && floors > 0
    ? createSafeMassFootprint(sitePolygon, buildingArea, {
      gridSteps: 21,
      minClearance: setback,
      edgeClearances,
    })
    : null;

  // ── OBJ 생성 (lib/objexport.ts) ─────────────────────────────────────────
  const groups: ObjGroup[] = [
    { name: "PARCEL",       polygons: shiftedParcels },
    { name: "BUILDINGS",    polygons: shiftedBuildings },
    { name: "ROADS",        polylines: shiftedRoads,     polylineWidth: 1.5 },  // 반폭 1.5m = 폭 3m
    { name: "SIDEWALK",     polylines: shiftedSidewalks, polylineWidth: 0.75 }, // 반폭 0.75m = 폭 1.5m
    ...(plannedMass ? [{
      name: "PLANNED_MASS",
      polygons: [sitePolygon],
      extrusions: [{ footprint: plannedMass.footprint, height: floors * 3.3 }],
    } satisfies ObjGroup] : []),
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
