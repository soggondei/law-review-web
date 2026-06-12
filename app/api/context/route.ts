export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import https from "https";

const OVERPASS_HOSTS = [
  "overpass-api.de",
  "overpass.kumi.systems",
  "z.overpass-api.de",
];
const M_PER_LAT = 111320;

const ROAD_WIDTHS: Record<string, number> = {
  motorway: 12, trunk: 10, primary: 9, secondary: 7, tertiary: 5,
  residential: 4, unclassified: 3.5, service: 2.5, pedestrian: 3, footway: 2,
};

export interface ContextBuilding {
  coords: [number, number][];
  height: number;
}
export interface ContextRoad {
  coords: [number, number][];
  width: number;
}

function httpsPost(host: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: "/api/interpreter",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "law-review-web/1.0 (contact:soggon@naver.com)",
        "Accept": "application/json",
      },
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Overpass ${res.statusCode}`));
        } else {
          resolve(Buffer.concat(chunks).toString("utf-8"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(18000, () => { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function httpsPostWithFallback(body: string): Promise<string> {
  let lastErr: Error | null = null;
  for (const host of OVERPASS_HOSTS) {
    try {
      return await httpsPost(host, body);
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Overpass unreachable");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = parseFloat(searchParams.get("lat") ?? "0");
  const lng = parseFloat(searchParams.get("lng") ?? "0");
  if (!lat || !lng) return NextResponse.json({ error: "lat/lng 필요" }, { status: 400 });

  const radius = 200; // meters
  const mPerLng = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat = radius / M_PER_LAT;
  const dLng = radius / mPerLng;
  const bbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;

  const query =
    `[out:json][timeout:15];` +
    `(way["building"](${bbox});` +
    `way["highway"~"primary|secondary|tertiary|residential|pedestrian|footway|unclassified|service"](${bbox}););` +
    `out geom;`;

  try {
    const text = await httpsPostWithFallback("data=" + encodeURIComponent(query));
    const data = JSON.parse(text);
    const elements: any[] = data.elements ?? [];

    const buildings: ContextBuilding[] = [];
    const roads: ContextRoad[] = [];

    for (const el of elements) {
      if (!el.geometry?.length) continue;

      const geom: { lat: number; lon: number }[] = el.geometry;
      const localPts = geom.map(({ lat: y, lon: x }) => [
        (x - lng) * mPerLng,
        (y - lat) * M_PER_LAT,
      ] as [number, number]);

      if (el.tags?.building) {
        // OSM closed ways repeat first point at end — drop it
        const openPts = localPts.length > 1 &&
          localPts[0][0] === localPts[localPts.length - 1][0] &&
          localPts[0][1] === localPts[localPts.length - 1][1]
          ? localPts.slice(0, -1) : localPts;
        if (openPts.length < 3) continue;
        const levels = parseInt(el.tags["building:levels"] ?? "0") || 2;
        const explicitH = parseFloat(el.tags.height ?? "0");
        const height = explicitH > 0 ? explicitH : levels * 3.3;
        buildings.push({ coords: openPts, height });
      } else if (el.tags?.highway) {
        if (localPts.length < 2) continue;
        const type: string = el.tags.highway;
        const width = ROAD_WIDTHS[type] ?? 3;
        roads.push({ coords: localPts, width });
      }
    }

    return NextResponse.json({ buildings, roads });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
