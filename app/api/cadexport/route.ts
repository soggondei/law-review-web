export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import iconv from "iconv-lite";

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

/**
 * WGS84 bbox로 주변 필지를 EPSG:4326으로 조회한 뒤,
 * 대상 필지 EPSG:5186 중심(cx5186, cy5186)을 기준으로 미터 좌표로 변환.
 * VWorld API가 WGS84 geomFilter + EPSG:5186 crs 조합 시
 * 좌표를 실제로 EPSG:4326으로 반환하는 경우가 있어 명시적으로 변환.
 */
async function fetchByBBox(
  lat: number,
  lng: number,
  radius: number,
  cx5186: number,
  cy5186: number,
  excludePnu?: string,
): Promise<Parcel[]> {
  const M_PER_LAT = 111320;
  const mPerLng = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat = radius / M_PER_LAT;
  const dLng = radius / mPerLng;
  const geomFilter = `BOX(${(lng - dLng).toFixed(6)},${(lat - dLat).toFixed(6)},${(lng + dLng).toFixed(6)},${(lat + dLat).toFixed(6)})`;
  const params = new URLSearchParams({
    service: "data",
    request: "GetFeature",
    data: "LP_PA_CBND_BUBUN",
    key: vkey(),
    domain: "localhost",
    geomFilter,
    format: "json",
    crs: "EPSG:4326",   // WGS84로 확실하게 받기
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
      .map((f) => {
        const parcel = parseFeature(f);
        // WGS84(lng, lat) → EPSG:5186 근사 변환
        // 대상 필지 중심(lat, lng) ↔ (cx5186, cy5186) 를 기준으로 선형 변환
        return {
          ...parcel,
          polygons: parcel.polygons.map((poly) =>
            poly.map((ring) =>
              ring.map(([lngP, latP]) => [
                cx5186 + (lngP - lng) * mPerLng,
                cy5186 + (latP - lat) * M_PER_LAT,
              ] as [number, number]),
            ),
          ),
        };
      });
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

// 한글은 CP949 인코딩으로 출력하므로 문자열 그대로 사용
function dxfStr(str: string): string {
  return str;
}

// AC1009(R12) 호환 폴리라인 — LWPOLYLINE은 R2000+ 전용이므로 사용 불가
function lwPolyline(
  layer: string,
  pts: [number, number][],
  closed: boolean,
): string {
  const lines: string[] = [
    g(0, "POLYLINE"),
    g(8, layer),
    g(66, 1),           // vertices follow
    g(10, "0.0"),       // dummy origin required by R12
    g(20, "0.0"),
    g(30, "0.0"),
    g(70, closed ? 1 : 0),
  ];
  for (const [x, y] of pts) {
    lines.push(
      g(0, "VERTEX"),
      g(8, layer),
      g(10, x.toFixed(3)),
      g(20, y.toFixed(3)),
      g(30, "0.0"),     // Z coordinate required in R12
      g(70, 0),         // vertex flags
    );
  }
  lines.push(g(0, "SEQEND"), g(8, layer));
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
    g(1, dxfStr(text)),
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

  // bbox 중심을 원점(0,0)으로 이동
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const tx = (x: number) => x - cx;
  const ty = (y: number) => y - cy;

  const layers: { name: string; color: number }[] = [
    { name: "0",              color: 7 },
    { name: "TARGET_PARCEL",    color: 1 },
    { name: "TARGET_LABEL",     color: 1 },
    { name: "NEIGHBOR_PARCELS", color: 5 },
    { name: "NEIGHBOR_LABEL",   color: 5 },
    { name: "SOURCE_NOTE",      color: 3 },
  ];

  const entities: string[] = [];

  // 주변 필지 (먼저 그려 대상 필지가 위에 덮이게)
  for (const nb of neighbors) {
    for (const polygon of nb.polygons) {
      for (const ring of polygon) {
        const pts = ring.map(([x, y]) => [tx(x), ty(y)] as [number, number]);
        if (pts.length >= 3)
          entities.push(lwPolyline("NEIGHBOR_PARCELS", pts, true));
      }
    }
    const c = outerCentroid(nb.polygons);
    if (c && nb.jibun)
      entities.push(
        dxfText("NEIGHBOR_LABEL", tx(c[0]), ty(c[1]), neighborLabelH, nb.jibun),
      );
  }

  // 대상 필지 (마지막에 그려서 위에 표시)
  for (const polygon of target.polygons) {
    for (const ring of polygon) {
      const pts = ring.map(([x, y]) => [tx(x), ty(y)] as [number, number]);
      if (pts.length >= 3)
        entities.push(lwPolyline("TARGET_PARCEL", pts, true));
    }
  }
  const tc = outerCentroid(target.polygons);
  if (tc)
    entities.push(
      dxfText(
        "TARGET_LABEL",
        tx(tc[0]),
        ty(tc[1]),
        targetLabelH,
        target.jibun || target.pnu,
      ),
    );

  // 출처 문구 (원점 기준 bbox 하단 아래)
  const noteH = Math.max(targetLabelH * 0.4, 0.15);
  const today = new Date().toISOString().slice(0, 10);
  const note = `출처: VWorld(국토교통부) / 좌표계: EPSG:5186(원점이동) / ${today} / ${addr} / 참고용`;
  const noteX = 0;
  const noteY = ty(bbox.minY) - targetLabelH * 1.5;
  entities.push(dxfText("SOURCE_NOTE", noteX, noteY, noteH, note));

  // 레이어 테이블
  const layerDefs = layers
    .map((l) =>
      [
        g(0, "LAYER"),
        g(2, l.name),
        g(70, 0),
        g(62, l.color),
        g(6, "Continuous"),
      ].join("\n"),
    )
    .join("\n");

  // 원점 이동된 bbox 범위
  const extMinX = tx(bbox.minX).toFixed(3);
  const extMinY = ty(bbox.minY).toFixed(3);
  const extMaxX = tx(bbox.maxX).toFixed(3);
  const extMaxY = ty(bbox.maxY).toFixed(3);

  const header = [
    g(0, "SECTION"),
    g(2, "HEADER"),
    g(9, "$ACADVER"),
    g(1, "AC1009"),
    g(9, "$DWGCODEPAGE"),
    g(3, "KS_C_5601-1987"),   // CP949 한국어 코드페이지
    g(9, "$EXTMIN"),
    g(10, extMinX),
    g(20, extMinY),
    g(30, "0.000"),
    g(9, "$EXTMAX"),
    g(10, extMaxX),
    g(20, extMaxY),
    g(30, "0.000"),
    g(0, "ENDSEC"),
  ].join("\n");

  // VPORT 테이블 (빈 테이블 — 없으면 일부 CAD가 거부)
  const vportTable = [
    g(0, "TABLE"), g(2, "VPORT"), g(70, 0),
    g(0, "ENDTAB"),
  ].join("\n");

  // LTYPE 테이블 — ByBlock, ByLayer, Continuous 모두 정의
  const ltypeTable = [
    g(0, "TABLE"), g(2, "LTYPE"), g(70, 3),
    g(0, "LTYPE"), g(2, "ByBlock"), g(70, 0), g(3, ""), g(72, 65), g(73, 0), g(40, "0.0"),
    g(0, "LTYPE"), g(2, "ByLayer"), g(70, 0), g(3, ""), g(72, 65), g(73, 0), g(40, "0.0"),
    g(0, "LTYPE"), g(2, "Continuous"), g(70, 0), g(3, "Solid line"), g(72, 65), g(73, 0), g(40, "0.0"),
    g(0, "ENDTAB"),
  ].join("\n");

  // STYLE 테이블 — TEXT 엔티티가 있으면 반드시 필요
  const styleTable = [
    g(0, "TABLE"), g(2, "STYLE"), g(70, 1),
    g(0, "STYLE"), g(2, "Standard"), g(70, 0), g(40, "0.0"), g(41, "1.0"),
    g(50, "0.0"), g(71, 0), g(42, "2.5"), g(3, "txt"), g(4, ""),
    g(0, "ENDTAB"),
  ].join("\n");

  // VIEW, UCS 빈 테이블
  const viewTable  = [g(0, "TABLE"), g(2, "VIEW"),  g(70, 0), g(0, "ENDTAB")].join("\n");
  const ucsTable   = [g(0, "TABLE"), g(2, "UCS"),   g(70, 0), g(0, "ENDTAB")].join("\n");

  // APPID 테이블 — ACAD 앱 등록
  const appidTable = [
    g(0, "TABLE"), g(2, "APPID"), g(70, 1),
    g(0, "APPID"), g(2, "ACAD"), g(70, 0),
    g(0, "ENDTAB"),
  ].join("\n");

  // DIMSTYLE 빈 테이블
  const dimstyleTable = [g(0, "TABLE"), g(2, "DIMSTYLE"), g(70, 0), g(0, "ENDTAB")].join("\n");

  const tables = [
    g(0, "SECTION"),
    g(2, "TABLES"),
    vportTable,
    ltypeTable,
    g(0, "TABLE"), g(2, "LAYER"), g(70, layers.length),
    layerDefs,
    g(0, "ENDTAB"),
    styleTable,
    viewTable,
    ucsTable,
    appidTable,
    dimstyleTable,
    g(0, "ENDSEC"),
  ].join("\n");

  // BLOCKS 섹션 — AC1009에서 필수 (비어 있더라도)
  const blocks = [
    g(0, "SECTION"),
    g(2, "BLOCKS"),
    g(0, "ENDSEC"),
  ].join("\n");

  const entSection = [
    g(0, "SECTION"),
    g(2, "ENTITIES"),
    ...entities,
    g(0, "ENDSEC"),
    g(0, "EOF"),
  ].join("\n");

  return [header, tables, blocks, entSection].join("\n");
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

  // 3. bbox 계산 및 주변 필지 조회
  const bbox = computeBBox(target, radius);
  const cx5186 = (bbox.minX + bbox.maxX) / 2;
  const cy5186 = (bbox.minY + bbox.maxY) / 2;
  const neighbors = await fetchByBBox(lat, lng, radius, cx5186, cy5186, target.pnu);

  // ?debug=1 → JSON으로 파이프라인 상태 반환 (주변 필지 문제 진단용)
  if (searchParams.get("debug") === "1") {
    return NextResponse.json({
      targetPnu,
      target: { jibun: target.jibun, polygons: target.polygons.length },
      bbox,
      cx5186, cy5186,
      neighborsCount: neighbors.length,
      firstNeighbor: neighbors[0]
        ? { jibun: neighbors[0].jibun, firstPt: neighbors[0].polygons[0]?.[0]?.[0] }
        : null,
    });
  }

  // 4. DXF 생성
  const dxf = buildDxf(target, neighbors, bbox, addr);
  const safe = addr.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");
  const filename = `지적도_${safe}.dxf`;

  // CP949로 인코딩 — $DWGCODEPAGE KS_C_5601-1987와 일치, 한글 텍스트 정상 표시
  const dxfBuffer = iconv.encode(dxf, "cp949");

  return new NextResponse(dxfBuffer, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
