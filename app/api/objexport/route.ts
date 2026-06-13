export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import https from "https";

const VWORLD_KEY = process.env.LURIS_KEY!;
const M_PER_LAT  = 111320;
const OVERPASS_HOSTS = [
  "overpass-api.de",
  "overpass.kumi.systems",
  "z.overpass-api.de",
];

// ── OBJ builder (inline — Codex PR 머지 후 lib/objexport.ts로 교체 예정) ──

type Pt2 = [number, number];

function emitPolygon(pts: Pt2[], vOffset: number, lines: string[]): number {
  if (pts.length < 3) return 0;
  for (const [x, y] of pts) lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} 0`);
  const n = pts.length;
  for (let i = 1; i < n - 1; i++)
    lines.push(`f ${vOffset + 1} ${vOffset + 1 + i} ${vOffset + 1 + i + 1}`);
  return n;
}

function emitPolylineStrip(pts: Pt2[], width: number, vOffset: number, lines: string[]): number {
  let added = 0;
  const hw = width / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const px = (-dy / len) * hw, py = (dx / len) * hw;
    lines.push(`v ${(x1 + px).toFixed(4)} ${(y1 + py).toFixed(4)} 0`);
    lines.push(`v ${(x1 - px).toFixed(4)} ${(y1 - py).toFixed(4)} 0`);
    lines.push(`v ${(x2 - px).toFixed(4)} ${(y2 - py).toFixed(4)} 0`);
    lines.push(`v ${(x2 + px).toFixed(4)} ${(y2 + py).toFixed(4)} 0`);
    const a = vOffset + added + 1, b = a + 1, c = b + 1, d = c + 1;
    lines.push(`f ${a} ${b} ${c}`);
    lines.push(`f ${a} ${c} ${d}`);
    added += 4;
  }
  return added;
}

function buildObj(
  parcels: Pt2[][],
  buildings: Pt2[][],
  roads: Pt2[][],
  sidewalks: Pt2[][],
  addr: string,
  radius: number,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# Wavefront OBJ — ${addr} — 생성: ${today} — 범위: ${radius}m`,
    `# 좌표계: WGS84 로컬(m) / 그룹: PARCEL BUILDINGS ROADS SIDEWALK`,
  ];
  let vOff = 0;

  lines.push("g PARCEL");
  for (const pg of parcels) vOff += emitPolygon(pg, vOff, lines);

  lines.push("g BUILDINGS");
  for (const pg of buildings) vOff += emitPolygon(pg, vOff, lines);

  lines.push("g ROADS");
  for (const pl of roads) vOff += emitPolylineStrip(pl, 3.0, vOff, lines);

  lines.push("g SIDEWALK");
  for (const pl of sidewalks) vOff += emitPolylineStrip(pl, 1.5, vOff, lines);

  return lines.join("\n");
}

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

  const obj  = buildObj(parcels, buildings, roads, sidewalks, addr, radius);
  const safe = addr.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");

  return new NextResponse(obj, {
    headers: {
      "Content-Type": "model/obj",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`지적도_${safe}_${radius}m.obj`)}`,
    },
  });
}
