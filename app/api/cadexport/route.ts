export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";

const VWORLD_BASE = "https://api.vworld.kr/req/data";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Parcel {
  pnu: string;
  jibun: string;
  polygons: number[][][][]; // [polygon][ring][point] = [x, y]
}

// ── VWorld LP_PA_CBND_BUBUN API ───────────────────────────────────────────────

function vkey(): string {
  return process.env.LURIS_KEY!;
}

function parseFeature(f: {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, string>;
}): Parcel {
  const geom = f.geometry;
  const polygons: number[][][][] =
    geom?.type === "MultiPolygon"
      ? (geom.coordinates as number[][][][])
      : geom?.type === "Polygon"
        ? [(geom.coordinates as number[][][])]
        : [];
  return {
    pnu: f.properties?.pnu ?? "",
    jibun: f.properties?.jibun ?? "",
    polygons,
  };
}

/** PNU로 단일 필지 조회 — EPSG:5186 좌표 반환 */
async function fetchByPnu(pnu: string): Promise<Parcel | null> {
  const params = new URLSearchParams({
    service: "data",
    request: "GetFeature",
    data: "LP_PA_CBND_BUBUN",
    key: vkey(),
    domain: "localhost",
    attrFilter: `pnu:=:${pnu}`,
    format: "json",
    crs: "EPSG:5186",
  });
  try {
    const res = await fetch(`${VWORLD_BASE}?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (json?.response?.status !== "OK") return null;
    const f = json?.response?.result?.featureCollection?.features?.[0];
    return f ? parseFeature(f) : null;
  } catch {
    return null;
  }
}

/** EPSG:5186 BOX(미터 단위)로 주변 필지 조회 */
async function fetchByBBox(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  excludePnu?: string,
): Promise<Parcel[]> {
  const geomFilter = `BOX(${minX},${minY},${maxX},${maxY})`;
  const params = new URLSearchParams({
    service: "data",
    request: "GetFeature",
    data: "LP_PA_CBND_BUBUN",
    key: vkey(),
    domain: "localhost",
    geomFilter,
    format: "json",
    crs: "EPSG:5186",
    size: "1000",
    page: "1",
  });
  try {
    const res = await fetch(`${VWORLD_BASE}?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (json?.response?.status !== "OK") return [];
    const features =
      (json?.response?.result?.featureCollection?.features ?? []) as Array<{
        geometry?: { type?: string; coordinates?: unknown };
        properties?: Record<string, string>;
      }>;
    return features
      .filter((f) => !excludePnu || f.properties?.pnu !== excludePnu)
      .map(parseFeature);
  } catch {
    return [];
  }
}

/**
 * WGS84(EPSG:4326) BOX로 필지 목록 조회 후 중심점에서 가장 가까운 필지의 PNU 반환.
 * pnu 파라미터가 없을 때 대상 필지를 자동 식별하는 용도로만 사용.
 */
async function findPnuByLatLng(
  lat: number,
  lng: number,
  radius: number,
): Promise<string | null> {
  const M_PER_LAT = 111320;
  const mPerLng = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat = radius / M_PER_LAT;
  const dLng = radius / mPerLng;

  const geomFilter = `BOX(${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat})`;
  const params = new URLSearchParams({
    service: "data",
    request: "GetFeature",
    data: "LP_PA_CBND_BUBUN",
    key: vkey(),
    domain: "localhost",
    geomFilter,
    format: "json",
    crs: "EPSG:4326", // WGS84 좌표로 BOX 필터 — PNU 식별 목적
    size: "200",
  });
  try {
    const res = await fetch(`${VWORLD_BASE}?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (json?.response?.status !== "OK") return null;

    const features = (json?.response?.result?.featureCollection?.features ??
      []) as Array<{
      geometry?: {
        type?: string;
        coordinates?: number[][][] | number[][][][];
      };
      properties?: Record<string, string>;
    }>;
    if (features.length === 0) return null;

    let minDist = Infinity;
    let targetPnu: string | null = null;

    for (const f of features) {
      const pnu = f.properties?.pnu;
      if (!pnu) continue;
      const geom = f.geometry;
      if (!geom) continue;

      const rings: number[][][] =
        geom.type === "Polygon"
          ? (geom.coordinates as number[][][])
          : geom.type === "MultiPolygon"
            ? (geom.coordinates as number[][][][]).flat()
            : [];
      if (!rings[0]) continue;

      const ring = rings[0];
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const dist = Math.hypot(cx - lng, cy - lat);

      if (dist < minDist) {
        minDist = dist;
        targetPnu = pnu;
      }
    }

    return targetPnu;
  } catch {
    return null;
  }
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function computeBBox(
  parcel: Parcel,
  buffer: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const polygon of parcel.polygons)
    for (const ring of polygon)
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return {
    minX: minX - buffer,
    minY: minY - buffer,
    maxX: maxX + buffer,
    maxY: maxY + buffer,
  };
}

function ringCentroid(ring: number[][]): [number, number] {
  return [
    ring.reduce((s, p) => s + p[0], 0) / ring.length,
    ring.reduce((s, p) => s + p[1], 0) / ring.length,
  ];
}

function outerCentroid(polygons: number[][][][]): [number, number] | null {
  const outer = polygons.map((p) => p[0]).filter(Boolean);
  if (!outer.length) return null;
  const largest = outer.reduce((a, b) => (a.length >= b.length ? a : b));
  return ringCentroid(largest);
}

// ── Raw DXF builder ───────────────────────────────────────────────────────────

function g(code: number, value: string | number): string {
  return `${code}\n${value}`;
}

function lwPolyline(
  layer: string,
  pts: [number, number][],
  closed: boolean,
  width?: number,
): string {
  const lines: string[] = [
    g(0, "LWPOLYLINE"),
    g(8, layer),
    g(90, pts.length),
    g(70, closed ? 1 : 0),
  ];
  if (width !== undefined) lines.push(g(43, width.toFixed(3)));
  for (const [x, y] of pts) {
    lines.push(g(10, x.toFixed(3)));
    lines.push(g(20, y.toFixed(3)));
  }
  return lines.join("\n");
}

function dxfText(
  layer: string,
  x: number,
  y: number,
  height: number,
  text: string,
): string {
  return [
    g(0, "TEXT"),
    g(8, layer),
    g(10, x.toFixed(3)),
    g(20, y.toFixed(3)),
    g(30, 0),
    g(40, height.toFixed(3)),
    g(1, text),
    g(72, 1),          // horizontal: center
    g(11, x.toFixed(3)), // second alignment point
    g(21, y.toFixed(3)),
    g(31, 0),
    g(73, 2),          // vertical: middle
  ].join("\n");
}

function buildDxf(
  target: Parcel,
  neighbors: Parcel[],
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  addr: string,
): string {
  const extent = Math.max(
    bbox.maxX - bbox.minX,
    bbox.maxY - bbox.minY,
  );
  const targetLabelH = Math.max(extent * 0.025, 0.3);
  const neighborLabelH = Math.max(targetLabelH * 0.6, 0.2);
  const targetLineWidth = Math.max(extent * 0.002, 0.1);

  const layers: { name: string; color: number }[] = [
    { name: "TARGET_PARCEL",    color: 1 }, // 빨강 — 대상 필지
    { name: "TARGET_LABEL",     color: 1 }, // 빨강 — 대상 지번
    { name: "NEIGHBOR_PARCELS", color: 5 }, // 파랑 — 주변 필지
    { name: "NEIGHBOR_LABEL",   color: 5 }, // 파랑 — 주변 지번
    { name: "SOURCE_NOTE",      color: 3 }, // 초록 — 출처
  ];

  const entities: string[] = [];

  // 주변 필지 (먼저 그려 대상 필지가 위에 덮이게)
  for (const nb of neighbors) {
    for (const polygon of nb.polygons) {
      for (const ring of polygon) {
        const pts = ring.map(([x, y]) => [x, y] as [number, number]);
        if (pts.length >= 3)
          entities.push(lwPolyline("NEIGHBOR_PARCELS", pts, true));
      }
    }
    const c = outerCentroid(nb.polygons);
    if (c && nb.jibun)
      entities.push(
        dxfText("NEIGHBOR_LABEL", c[0], c[1], neighborLabelH, nb.jibun),
      );
  }

  // 대상 필지 (굵은 선, 마지막에 그려서 위에 표시)
  for (const polygon of target.polygons) {
    for (const ring of polygon) {
      const pts = ring.map(([x, y]) => [x, y] as [number, number]);
      if (pts.length >= 3)
        entities.push(
          lwPolyline("TARGET_PARCEL", pts, true, targetLineWidth),
        );
    }
  }
  const tc = outerCentroid(target.polygons);
  if (tc)
    entities.push(
      dxfText(
        "TARGET_LABEL",
        tc[0],
        tc[1],
        targetLabelH,
        target.jibun || target.pnu,
      ),
    );

  // 출처 문구
  const noteX = (bbox.minX + bbox.maxX) / 2;
  const noteY = bbox.minY - targetLabelH * 1.5;
  const noteH = Math.max(targetLabelH * 0.4, 0.15);
  const today = new Date().toISOString().slice(0, 10);
  const note =
    `출처: 브이월드(국토교통부) LP_PA_CBND_BUBUN / 좌표계: EPSG:5186 / 생성: ${today} / ${addr} / 참고용 — 법적 효력 없음`;
  entities.push(dxfText("SOURCE_NOTE", noteX, noteY, noteH, note));

  // 레이어 테이블
  const layerDefs = layers
    .map((l) =>
      [
        g(0, "LAYER"),
        g(2, l.name),
        g(70, 0),
        g(62, l.color),
        g(6, "CONTINUOUS"),
      ].join("\n"),
    )
    .join("\n");

  const header = [
    g(0, "SECTION"),
    g(2, "HEADER"),
    g(9, "$ACADVER"),
    g(1, "AC1015"),
    g(9, "$INSUNITS"),
    g(70, 6),  // 6 = meters
    g(9, "$MEASUREMENT"),
    g(70, 1),  // 1 = metric
    g(9, "$EXTMIN"),
    g(10, bbox.minX.toFixed(3)),
    g(20, bbox.minY.toFixed(3)),
    g(30, 0),
    g(9, "$EXTMAX"),
    g(10, bbox.maxX.toFixed(3)),
    g(20, bbox.maxY.toFixed(3)),
    g(30, 0),
    g(0, "ENDSEC"),
  ].join("\n");

  const tables = [
    g(0, "SECTION"),
    g(2, "TABLES"),
    g(0, "TABLE"),
    g(2, "LAYER"),
    g(70, layers.length),
    layerDefs,
    g(0, "ENDTAB"),
    g(0, "ENDSEC"),
  ].join("\n");

  const entSection = [
    g(0, "SECTION"),
    g(2, "ENTITIES"),
    ...entities,
    g(0, "ENDSEC"),
    g(0, "EOF"),
  ].join("\n");

  return [header, tables, entSection].join("\n");
}

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = parseFloat(searchParams.get("lat") ?? "0");
  const lng = parseFloat(searchParams.get("lng") ?? "0");
  const addr = searchParams.get("addr") ?? "site";
  const radius = Math.min(
    Math.max(parseInt(searchParams.get("radius") ?? "50"), 10),
    300,
  );
  const pnuParam = searchParams.get("pnu") ?? "";

  if (!lat || !lng)
    return NextResponse.json({ error: "lat/lng 필요" }, { status: 400 });

  // 1. 대상 필지 PNU 확인
  //    - pnu 파라미터 제공 시 그대로 사용
  //    - 없으면 WGS84 BOX 조회로 중심점에서 가장 가까운 필지 PNU 탐색
  let targetPnu = pnuParam;
  if (!targetPnu) {
    targetPnu = (await findPnuByLatLng(lat, lng, radius)) ?? "";
  }

  if (!targetPnu) {
    return NextResponse.json(
      { error: "해당 위치에서 필지를 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  // 2. 대상 필지 EPSG:5186 좌표 조회
  const target = await fetchByPnu(targetPnu);
  if (!target || target.polygons.length === 0) {
    return NextResponse.json(
      { error: `PNU ${targetPnu} 필지 경계 데이터를 찾을 수 없습니다` },
      { status: 404 },
    );
  }

  // 3. EPSG:5186 bbox 계산 후 주변 필지 조회
  const bbox = computeBBox(target, radius);
  const neighbors = await fetchByBBox(
    bbox.minX,
    bbox.minY,
    bbox.maxX,
    bbox.maxY,
    target.pnu,
  );

  // 4. DXF 생성
  const dxf = buildDxf(target, neighbors, bbox, addr);
  const safe = addr.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");
  const filename = `지적도_${safe}.dxf`;

  return new NextResponse(dxf, {
    headers: {
      "Content-Type": "application/dxf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
