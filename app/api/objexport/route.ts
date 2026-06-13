export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { buildObj, type ObjGroup } from "@/lib/objexport";

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
    catch (e: any) { lastErr = e; }
  }
  throw lastErr ?? new Error("Overpass unreachable");
}

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
    const vwData = await vwRes.json();
    const features: any[] = vwData.response?.result?.featureCollection?.features ?? [];
    for (const feature of features) {
      const geom = feature.geometry;
      if (!geom) continue;
      let rings: number[][][] = [];
      if (geom.type === "Polygon") rings = geom.coordinates;
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
