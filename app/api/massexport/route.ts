export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import https from "https";

const VWORLD_KEY = process.env.LURIS_KEY!;
const M_PER_LAT  = 111320;
const OVERPASS_HOSTS = ["overpass-api.de", "overpass.kumi.systems", "z.overpass-api.de"];

// ── Collada 빌더 (inline — Codex PR 머지 후 lib/collada.ts로 교체 예정) ──────

type Pt2 = [number, number];

function fan(pts: Pt2[], z: number, vOff: number, ccw: boolean): { verts: string[]; tris: number[][] } {
  const verts = pts.map(([x, y]) => `${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
  const tris: number[][] = [];
  for (let i = 1; i < pts.length - 1; i++)
    tris.push(ccw ? [vOff, vOff + i, vOff + i + 1] : [vOff, vOff + i + 1, vOff + i]);
  return { verts, tris };
}

function extrude(pts: Pt2[], h: number, baseOff: number): { verts: string[]; tris: number[][] } {
  const verts: string[] = [];
  const tris: number[][] = [];
  const n = pts.length;
  // 바닥 (CW = 법선 아래)
  const bot = fan(pts, 0, baseOff, false);
  verts.push(...bot.verts); tris.push(...bot.tris);
  // 지붕 (CCW = 법선 위)
  const top = fan(pts, h, baseOff + n, true);
  verts.push(...top.verts); tris.push(...top.tris);
  // 측면
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = baseOff + i, b = baseOff + j, c = baseOff + n + i, d = baseOff + n + j;
    tris.push([a, b, d], [a, d, c]);
  }
  return { verts, tris };
}

function strip(pts: Pt2[], hw: number, baseOff: number): { verts: string[]; tris: number[][] } {
  const verts: string[] = [];
  const tris: number[][] = [];
  let vi = baseOff;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const nx = (-dy / len) * hw, ny = (dx / len) * hw;
    verts.push(`${(x1+nx).toFixed(4)} ${(y1+ny).toFixed(4)} 0`, `${(x1-nx).toFixed(4)} ${(y1-ny).toFixed(4)} 0`,
               `${(x2-nx).toFixed(4)} ${(y2-ny).toFixed(4)} 0`, `${(x2+nx).toFixed(4)} ${(y2+ny).toFixed(4)} 0`);
    tris.push([vi, vi+1, vi+2], [vi, vi+2, vi+3]);
    vi += 4;
  }
  return { verts, tris };
}

function makeGeometry(id: string, allVerts: string[], allTris: number[][]): string {
  if (allTris.length === 0) return "";
  const posArr = allVerts.map(v => v.split(" ").join(" ")).join(" ");
  const pArr   = allTris.flatMap(t => t).join(" ");
  return `<geometry id="geo-${id}" name="${id}">
  <mesh>
    <source id="geo-${id}-pos">
      <float_array id="geo-${id}-pos-arr" count="${allVerts.length * 3}">${posArr}</float_array>
      <technique_common><accessor source="#geo-${id}-pos-arr" count="${allVerts.length}" stride="3">
        <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
      </accessor></technique_common>
    </source>
    <vertices id="geo-${id}-vtx"><input semantic="POSITION" source="#geo-${id}-pos"/></vertices>
    <triangles count="${allTris.length}">
      <input semantic="VERTEX" source="#geo-${id}-vtx" offset="0"/>
      <p>${pArr}</p>
    </triangles>
  </mesh>
</geometry>`;
}

type BldInput = { pts: Pt2[]; height: number };

function buildDae(
  buildings: BldInput[], parcels: Pt2[][], roads: Pt2[][], sidewalks: Pt2[][],
  addr: string, radius: number,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const geos: string[] = [], nodes: string[] = [];

  // BUILDINGS
  { const verts: string[] = []; const tris: number[][] = [];
    for (const b of buildings) {
      const { verts: v, tris: t } = extrude(b.pts, b.height, verts.length);
      verts.push(...v); tris.push(...t);
    }
    const g = makeGeometry("BUILDINGS", verts, tris);
    if (g) { geos.push(g); nodes.push(`<node id="BUILDINGS" name="BUILDINGS" type="NODE"><instance_geometry url="#geo-BUILDINGS"/></node>`); }
  }
  // PARCELS
  { const verts: string[] = []; const tris: number[][] = [];
    for (const p of parcels) {
      const { verts: v, tris: t } = fan(p, 0, verts.length, true);
      verts.push(...v); tris.push(...t);
    }
    const g = makeGeometry("PARCELS", verts, tris);
    if (g) { geos.push(g); nodes.push(`<node id="PARCELS" name="PARCELS" type="NODE"><instance_geometry url="#geo-PARCELS"/></node>`); }
  }
  // ROADS
  { const verts: string[] = []; const tris: number[][] = [];
    for (const r of roads) { const { verts: v, tris: t } = strip(r, 1.5, verts.length); verts.push(...v); tris.push(...t); }
    const g = makeGeometry("ROADS", verts, tris);
    if (g) { geos.push(g); nodes.push(`<node id="ROADS" name="ROADS" type="NODE"><instance_geometry url="#geo-ROADS"/></node>`); }
  }
  // SIDEWALK
  { const verts: string[] = []; const tris: number[][] = [];
    for (const s of sidewalks) { const { verts: v, tris: t } = strip(s, 0.75, verts.length); verts.push(...v); tris.push(...t); }
    const g = makeGeometry("SIDEWALK", verts, tris);
    if (g) { geos.push(g); nodes.push(`<node id="SIDEWALK" name="SIDEWALK" type="NODE"><instance_geometry url="#geo-SIDEWALK"/></node>`); }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${addr} | 생성: ${today} | 범위: ${radius}m -->
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><created>${today}</created><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
  <library_geometries>${geos.join("\n")}</library_geometries>
  <library_visual_scenes><visual_scene id="Scene" name="Scene">${nodes.join("\n")}</visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;
}

// ── Overpass HTTPS ───────────────────────────────────────────────────────────

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
  const buildings: BldInput[] = [];
  const parcels:   Pt2[][] = [];
  const roads:     Pt2[][] = [];
  const sidewalks: Pt2[][] = [];

  // Vworld 필지
  const vwSize = radius <= 30 ? 50 : radius <= 50 ? 100 : 200;
  const vwParams = new URLSearchParams({
    service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN",
    key: VWORLD_KEY, domain: "localhost", size: String(vwSize), page: "1",
    geomFilter: `BOX(${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat})`,
    crs: "EPSG:4326", format: "json",
  });
  try {
    const vw = await fetch(`https://api.vworld.kr/req/data?${vwParams}`, { signal: AbortSignal.timeout(8000) });
    const vwData = await vw.json();
    for (const f of (vwData.response?.result?.featureCollection?.features ?? []) as any[]) {
      const geom = f.geometry; if (!geom) continue;
      const rings: number[][][] = geom.type === "Polygon" ? geom.coordinates
        : geom.type === "MultiPolygon" ? (geom.coordinates as number[][][][]).flat() : [];
      for (const ring of rings) {
        const pts = ring.map(toLocal);
        if (pts.length > 1) {
          const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
          if (Math.abs(fx - lx) < 1e-6 && Math.abs(fy - ly) < 1e-6) pts.pop();
        }
        if (pts.length >= 3) parcels.push(pts);
      }
    }
  } catch { /* 생략 */ }

  // OSM 건물(높이 포함) + 도로
  const obbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
  const query =
    `[out:json][timeout:${radius <= 50 ? 12 : 18}];` +
    `(way["building"](${obbox});` +
    `way["highway"~"primary|secondary|tertiary|residential|pedestrian|footway|unclassified|service|living_street|path|steps|cycleway"](${obbox}););` +
    `out geom tags;`;
  try {
    const text = await fallbackPost("data=" + encodeURIComponent(query));
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

  const dae  = buildDae(buildings, parcels, roads, sidewalks, addr, radius);
  const safe = addr.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");

  return new NextResponse(dae, {
    headers: {
      "Content-Type": "model/vnd.collada+xml",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`매스_${safe}_${radius}m.dae`)}`,
    },
  });
}
