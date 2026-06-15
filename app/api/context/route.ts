export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { overpassQuery } from "@/lib/geo-fetch";

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
    const text = await overpassQuery("data=" + encodeURIComponent(query));
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
