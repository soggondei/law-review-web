export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import https from "https";

const VWORLD_KEY = process.env.LURIS_KEY!;
const M_PER_LAT = 111320;
const OVERPASS_HOSTS = [
  "overpass-api.de",
  "overpass.kumi.systems",
  "z.overpass-api.de",
];

// ── DXF builder ──────────────────────────────────────────────────────────────

function g(code: number, value: string | number): string {
  return `${code}\n${value}`;
}

function lwPolyline(layer: string, pts: [number, number][], closed: boolean): string {
  const lines = [
    g(0, "LWPOLYLINE"),
    g(8, layer),
    g(90, pts.length),
    g(70, closed ? 1 : 0),
  ];
  for (const [x, y] of pts) {
    lines.push(g(10, x.toFixed(4)));
    lines.push(g(20, y.toFixed(4)));
  }
  return lines.join("\n");
}

function buildDxf(entities: string[]): string {
  const layers: { name: string; color: number }[] = [
    { name: "PARCEL",    color: 1 },  // red   — 지적 필지
    { name: "BUILDINGS", color: 7 },  // white — 주변 건물
    { name: "ROADS",     color: 2 },  // yellow — 도로
  ];

  const header = [
    g(0, "SECTION"), g(2, "HEADER"),
    g(9, "$ACADVER"),  g(1, "AC1015"),
    g(9, "$INSUNITS"), g(70, 6),   // 6 = meters
    g(9, "$MEASUREMENT"), g(70, 1), // 1 = metric
    g(0, "ENDSEC"),
  ].join("\n");

  const layerDefs = layers.map(l => [
    g(0, "LAYER"),
    g(2, l.name),
    g(70, 0),
    g(62, l.color),
    g(6, "CONTINUOUS"),
  ].join("\n")).join("\n");

  const tables = [
    g(0, "SECTION"), g(2, "TABLES"),
    g(0, "TABLE"), g(2, "LAYER"), g(70, layers.length),
    layerDefs,
    g(0, "ENDTAB"),
    g(0, "ENDSEC"),
  ].join("\n");

  const entSection = [
    g(0, "SECTION"), g(2, "ENTITIES"),
    ...entities,
    g(0, "ENDSEC"),
    g(0, "EOF"),
  ].join("\n");

  return [header, tables, entSection].join("\n");
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
  const lat = parseFloat(searchParams.get("lat") ?? "0");
  const lng = parseFloat(searchParams.get("lng") ?? "0");
  const addr = searchParams.get("addr") ?? "site";
  if (!lat || !lng) return NextResponse.json({ error: "lat/lng 필요" }, { status: 400 });

  const mPerLng = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
  const radius = 30; // 30m
  const dLat = radius / M_PER_LAT;
  const dLng = radius / mPerLng;

  const entities: string[] = [];

  // ── 1. Vworld LP_PA_CBND_BUBUN (지적 필지 경계) ──────────────────────────
  const vwParams = new URLSearchParams({
    service: "data",
    request: "GetFeature",
    data: "LP_PA_CBND_BUBUN",
    key: VWORLD_KEY,
    domain: "localhost",
    size: "50",
    page: "1",
    geomFilter: `BOX(${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat})`,
    crs: "EPSG:4326",
    format: "json",
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
        const pts: [number, number][] = ring.map(([lon, la]: number[]) => [
          (lon - lng) * mPerLng,
          (la  - lat) * M_PER_LAT,
        ]);
        // drop closing duplicate
        if (pts.length > 1) {
          const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
          if (Math.abs(fx - lx) < 1e-6 && Math.abs(fy - ly) < 1e-6) pts.pop();
        }
        if (pts.length >= 2) entities.push(lwPolyline("PARCEL", pts, true));
      }
    }
  } catch { /* Vworld 실패 시 필지 레이어 생략 */ }

  // ── 2. OSM 주변 건물·도로 (30m radius) ──────────────────────────────────
  const obbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
  const query =
    `[out:json][timeout:10];` +
    `(way["building"](${obbox});` +
    `way["highway"~"primary|secondary|tertiary|residential|pedestrian|footway|unclassified|service"](${obbox}););` +
    `out geom;`;

  try {
    const text = await httpsPostWithFallback("data=" + encodeURIComponent(query));
    const osmData = JSON.parse(text);

    for (const el of (osmData.elements ?? []) as any[]) {
      if (!el.geometry?.length) continue;
      const localPts: [number, number][] = el.geometry.map(
        ({ lat: y, lon: x }: { lat: number; lon: number }) => [
          (x - lng) * mPerLng,
          (y - lat) * M_PER_LAT,
        ]
      );

      if (el.tags?.building) {
        // drop closing point
        const last = localPts[localPts.length - 1];
        const first = localPts[0];
        if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6)
          localPts.pop();
        if (localPts.length >= 2) entities.push(lwPolyline("BUILDINGS", localPts, true));
      } else if (el.tags?.highway) {
        if (localPts.length >= 2) entities.push(lwPolyline("ROADS", localPts, false));
      }
    }
  } catch { /* OSM 실패 시 주변 레이어 생략 */ }

  const dxf = buildDxf(entities);
  const safe = addr.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");
  const filename = `지적도_${safe}.dxf`;

  return new NextResponse(dxf, {
    headers: {
      "Content-Type": "application/dxf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
