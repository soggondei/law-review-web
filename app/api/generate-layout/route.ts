export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { vworldParcelParams, parseVworldRings, parseVworldFeatures } from "@/lib/geo-fetch";

interface AdjacentParcel {
  polygon: [number, number][];
  jimok: string;  // 지목: '도'=도로, '대'=대지, etc.
  jibun: string;
}

interface LayoutInput {
  대지면적: number;
  건폐율: number;
  용적률: number;
  층수: number;
  용도: string;
  최대연면적: number;
  용도지역?: string;  // 정북일조 적용 여부 판단용
  대지가로?: number;
  대지세로?: number;
  lat?: number;
  lng?: number;
}

// ── glTF 2.0 기반 매스 모델 JSON 생성 (Hypar Elements 출력 포맷 호환) ──────────
function buildHyparJson(input: LayoutInput, 가로: number, 세로: number, 층고: number) {
  const 층수 = input.층수;
  const meshes: object[] = [];
  const nodes: object[] = [];
  const accessors: object[] = [];
  const bufferViews: object[] = [];
  const buffers: Buffer[] = [];

  // 각 층을 Box 메시로 표현 (바닥면 + 두께 0.15m)
  for (let i = 0; i < 층수; i++) {
    const z0 = i * 층고;
    const z1 = z0 + 0.15; // 슬래브 두께
    const t = i / Math.max(층수 - 1, 1);
    const r = 0.2 + t * 0.2;
    const g = 0.45 + t * 0.2;
    const b = 0.85;

    // Box geometry: 8 vertices
    const verts = new Float32Array([
      0, 0, z0,    가로, 0, z0,    가로, 세로, z0,    0, 세로, z0,
      0, 0, z1,    가로, 0, z1,    가로, 세로, z1,    0, 세로, z1,
    ]);
    // 6면 × 2삼각형 = 12 triangles
    const indices = new Uint16Array([
      0,1,2, 0,2,3, // 바닥
      4,6,5, 4,7,6, // 천장
      0,4,1, 4,5,1, // 앞
      1,5,2, 5,6,2, // 오른쪽
      2,6,3, 6,7,3, // 뒤
      3,7,0, 7,4,0, // 왼쪽
    ]);

    const vertBuf = Buffer.from(verts.buffer);
    const idxBuf  = Buffer.from(indices.buffer);
    const vertOffset = buffers.reduce((s, b) => s + b.length, 0);
    buffers.push(vertBuf, idxBuf);

    bufferViews.push(
      { buffer: 0, byteOffset: vertOffset, byteLength: vertBuf.length, target: 34962 },
      { buffer: 0, byteOffset: vertOffset + vertBuf.length, byteLength: idxBuf.length, target: 34963 },
    );
    const bvBase = bufferViews.length - 2;

    accessors.push(
      { bufferView: bvBase,     byteOffset: 0, componentType: 5126, count: 8,  type: "VEC3",
        min: [0, 0, z0], max: [가로, 세로, z1] },
      { bufferView: bvBase + 1, byteOffset: 0, componentType: 5123, count: 36, type: "SCALAR" },
    );
    const accBase = accessors.length - 2;

    meshes.push({
      name: `Floor_${i + 1}`,
      primitives: [{ attributes: { POSITION: accBase }, indices: accBase + 1,
        material: i, mode: 4 }],
    });
    nodes.push({ mesh: i, name: `Floor_${i + 1}` });

    void [r, g, b]; // 나중에 material에서 사용
  }

  const allBuf = Buffer.concat(buffers);
  // 실제 bufferViews의 byteOffset을 단일 buffer 기준으로 재계산
  let offset = 0;
  const fixedBVs = bufferViews.map((bv: any) => {
    const fixed = { ...bv, buffer: 0, byteOffset: offset };
    offset += bv.byteLength;
    return fixed;
  });

  const materials = Array.from({ length: 층수 }, (_, i) => {
    const t = i / Math.max(층수 - 1, 1);
    return {
      name: `Floor_${i + 1}_Mat`,
      pbrMetallicRoughness: {
        baseColorFactor: [0.2 + t * 0.2, 0.45 + t * 0.2, 0.85, 0.65],
        metallicFactor: 0, roughnessFactor: 0.6,
      },
      alphaMode: "BLEND",
    };
  });

  return JSON.stringify({
    asset: { version: "2.0", generator: "law-review-web / Hypar-compatible" },
    scene: 0,
    scenes: [{ nodes: Array.from({ length: 층수 }, (_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: fixedBVs,
    buffers: [{ byteLength: allBuf.length, uri: `data:application/octet-stream;base64,${allBuf.toString("base64")}` }],
  });
}

// ── 폴리곤 유틸리티 ──────────────────────────────────────────────────────────

function signedArea2D(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

function lineIntersect2D(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): [number, number] | null {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-10) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/** 폴리곤을 dist(m)만큼 안쪽으로 축소. 로컬 좌표 Y=북 기준. */
function insetPolygon(pts: [number, number][], dist: number): [number, number][] {
  const n = pts.length;
  if (n < 3 || dist <= 0) return pts;
  const ordered = signedArea2D(pts) > 0 ? pts : [...pts].reverse(); // CCW 보장
  const oe: Array<[[number, number], [number, number]]> = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x1, y1] = ordered[i], [x2, y2] = ordered[j];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-10) continue;
    const nx = -(y2 - y1) / len, ny = (x2 - x1) / len; // 내향 법선 (CCW)
    oe.push([[x1 + nx * dist, y1 + ny * dist], [x2 + nx * dist, y2 + ny * dist]]);
  }
  if (oe.length < 3) return pts;
  const result: [number, number][] = [];
  for (let i = 0; i < oe.length; i++) {
    const j = (i + 1) % oe.length;
    const [[ax1, ay1], [ax2, ay2]] = oe[i];
    const [[bx1, by1], [bx2, by2]] = oe[j];
    const pt = lineIntersect2D(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2);
    if (pt) result.push(pt);
  }
  return result.length >= 3 ? result : pts;
}

function bboxOf(pts: [number, number][]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/** 폴리곤을 y 수평선으로 스캔해 정렬된 내부 [minX, maxX] 구간 배열을 반환.
 *  비볼록 폴리곤에서 여러 내부 구간이 생길 수 있으므로 bbox 대신 구간 배열 사용. */
function polyIntervalsAtY(poly: [number, number][], y: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const [x1, y1] = poly[i], [x2, y2] = poly[j];
    if (Math.abs(y2 - y1) < 1e-9) continue;
    // 하단 꼭짓점 포함, 상단 꼭짓점 제외 → 각 꼭짓점을 정확히 1회 계수
    const yMin = Math.min(y1, y2), yMax = Math.max(y1, y2);
    if (y < yMin || y >= yMax) continue;
    xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
  }
  xs.sort((a, b) => a - b);
  const result: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] > xs[i]) result.push([xs[i], xs[i + 1]]);
  }
  return result;
}

// ── 정북일조 이격거리 계산 (건축법 시행령 §86①) ─────────────────────────────
// §86①: 전용/일반주거지역, 비공동주택(다세대 포함)
//   높이 10m 이하 → 1.5m, 10m 초과 → 높이/2
// §86③ 공동주택(아파트·연립·기숙사, 다세대 제외): 채광기준 → 0 반환
//   채광기준 setback은 buildFloorSvg에서 별도 계산
// §86⑥: 북측에 도로 등 공지가 있으면 기준선이 이동 → buildFloorSvg에서 roadOffset 차감
function calcNorthSetback(floorTopH: number, 용도: string, 용도지역?: string): number {
  const is채광공동주택 = ["아파트","연립주택","기숙사"].some(k => 용도.includes(k));
  if (is채광공동주택) return 0;
  if (용도지역 && !(용도지역.includes("전용주거") || 용도지역.includes("일반주거"))) return 0;
  // §86① 이격 기준: 높이 10m 이하 1.5m, 10m 초과 높이/2
  return floorTopH <= 10 ? 1.5 : floorTopH / 2;
}

// ── Point-in-polygon (ray casting) ───────────────────────────────────────────
function pip([px, py]: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ── Vworld에서 대상 필지 폴리곤 가져오기 ────────────────────────────────────
async function fetchTargetParcel(lat: number, lng: number): Promise<[number, number][] | null> {
  try {
    const M_PER_LAT = 111320;
    const mPerLng   = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
    const radius    = 80;
    const dLat      = radius / M_PER_LAT;
    const dLng      = radius / mPerLng;
    const toLocal   = ([lon, la]: number[]): [number, number] => [
      (lon - lng) * mPerLng,
      (la  - lat) * M_PER_LAT,
    ];

    const params = vworldParcelParams(lng, lat, dLng, dLat, radius);
    const res    = await fetch(`https://api.vworld.kr/req/data?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data  = await res.json();
    const rings = parseVworldRings(data, toLocal);
    if (!rings.length) return null;

    // 중심점(0,0)을 포함하는 링 우선, 없으면 가장 가까운 링
    const target = rings.find(r => pip([0, 0], r))
      ?? rings.sort((a, b) => {
          const dist = (r: [number,number][]) =>
            Math.min(...r.map(([x, y]) => Math.hypot(x, y)));
          return dist(a) - dist(b);
        })[0];

    return target ?? null;
  } catch {
    return null;
  }
}

// ── 인접 필지 일괄 조회 (정북일조 검증용) ────────────────────────────────────
async function fetchAdjacentParcels(lat: number, lng: number): Promise<AdjacentParcel[]> {
  try {
    const M_PER_LAT = 111320;
    const mPerLng   = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
    const radius    = 130; // 대상 필지 + 인접 필지까지 커버
    const dLat      = radius / M_PER_LAT;
    const dLng      = radius / mPerLng;
    const toLocal   = ([lon, la]: number[]): [number, number] => [
      (lon - lng) * mPerLng,
      (la  - lat) * M_PER_LAT,
    ];
    const params = vworldParcelParams(lng, lat, dLng, dLat, radius);
    const res    = await fetch(`https://api.vworld.kr/req/data?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return parseVworldFeatures(data, toLocal).map(({ polygon, props }) => {
      // LP_PA_CBND_BUBUN에는 JIMOK 필드 없음
      // jibun이 가장 신뢰도 높음: "803대"→"대", "707도"→"도", "526-2대"→"대"
      // bonbun은 단독 필지에서 "707도"처럼 jimok 포함하기도 하나,
      // "803"처럼 jimok 없는 경우도 있어서 jibun을 우선
      const jibun  = props.jibun  ?? props.JIBUN  ?? '';
      const bubun  = props.bubun  ?? props.BUBUN  ?? '';
      const bonbun = props.bonbun ?? props.BONBUN ?? '';
      const jimokSrc = jibun || bubun || bonbun;
      const jimokMatch = jimokSrc.match(/([가-힣]+)$/);
      return {
        polygon,
        jimok: props.JIMOK ?? props.jimok ?? (jimokMatch ? jimokMatch[1] : ''),
        jibun,
      };
    });
  } catch {
    return [];
  }
}

// ── 대지 북측 클리핑: parcel을 Y≥yMin 영역으로 자름 ─────────────────────────
function clipPolygonNorthOf(poly: [number,number][], yMin: number): [number,number][] {
  if (poly.length < 3) return [];
  const out: [number,number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const next = poly[(i + 1) % poly.length];
    const cIn  = curr[1] >= yMin;
    const nIn  = next[1] >= yMin;
    if (cIn) out.push(curr);
    if (cIn !== nIn) {
      const t = (yMin - curr[1]) / (next[1] - curr[1]);
      out.push([curr[0] + t * (next[0] - curr[0]), yMin]);
    }
  }
  return out;
}

// ── 남측 클리핑: parcel을 Y≤yMax 영역으로 자름 (인접 필지 표시 제한용) ───────
function clipPolygonSouthOf(poly: [number,number][], yMax: number): [number,number][] {
  if (poly.length < 3) return [];
  const out: [number,number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const next = poly[(i + 1) % poly.length];
    const cIn  = curr[1] <= yMax;
    const nIn  = next[1] <= yMax;
    if (cIn) out.push(curr);
    if (cIn !== nIn) {
      const t = (yMax - curr[1]) / (next[1] - curr[1]);
      out.push([curr[0] + t * (next[0] - curr[0]), yMax]);
    }
  }
  return out;
}

// ── 층별 평면도 SVG — 법적 이격 기반 건축가능영역 ─────────────────────────────
function buildFloorSvg(
  floorIdx: number,
  input: LayoutInput,
  가로: number,
  세로: number,
  층고: number,
  parcelPts: [number, number][] | null,
  adjParcelsRaw: AdjacentParcel[] = [],
): { svg: string; area: number; _northDist: number; _bldgDepth: number; _parcelDepth: number; _roadOffset: number; _northRef: number; _trueRoadWidth: number } {
  const W = 400, H = 360;
  const floorBottomH = floorIdx * 층고;
  const floorTopH    = (floorIdx + 1) * 층고;
  const northSetbackM = calcNorthSetback(floorTopH, input.용도, input.용도지역);

  // ── 법적 이격 상수 ─────────────────────────────────────────────────────
  const BASE_SB   = 0.5;    // 대지안의 공지 (인접 대지경계선, 기본 0.5m)

  // 주차·조경은 매스 볼륨 최대화 단계에서 제외 (별도 단계에서 검토)
  const needsParking   = false;
  const needsLandscape = false;
  const landscapeArea  = 0;

  // ── 기준 필지 + 원점 정규화 ──────────────────────────────────────────
  // rawParcel 원점 = 쿼리 lat/lng (필지 중심 아닐 수 있음) → 필지 중심으로 이동
  const rawParcel: [number, number][] = (parcelPts && parcelPts.length >= 3)
    ? parcelPts
    : (() => { const h = Math.sqrt(input.대지면적) / 2; return [[-h,-h],[h,-h],[h,h],[-h,h]] as [number,number][]; })();

  const rawBox = bboxOf(rawParcel);
  const pCX    = (rawBox.minX + rawBox.maxX) / 2;
  const pCY    = (rawBox.minY + rawBox.maxY) / 2;
  // 정규화: 필지 중심 → (0, 0)
  const parcel: [number, number][] = rawParcel.map(([x, y]) => [x - pCX, y - pCY]);
  const parcelBox = bboxOf(parcel);

  // ── 인접 필지 정규화 (동일 원점으로 이동) ────────────────────────────────
  // adjParcelsRaw는 query lat/lng 중심 좌표. 우리 필지와 같은 계 → pCX/pCY 빼면 됨.
  const adjParcels = adjParcelsRaw
    .map(ap => ({
      ...ap,
      polygon: ap.polygon.map(([x, y]) => [x - pCX, y - pCY] as [number, number]),
    }))
    .filter(ap => {
      // 우리 필지 자신 제거: bbox가 우리 필지 bbox와 80%↑ 겹치면 제외
      const ab = bboxOf(ap.polygon);
      const ox = Math.max(0, Math.min(ab.maxX, parcelBox.maxX) - Math.max(ab.minX, parcelBox.minX));
      const oy = Math.max(0, Math.min(ab.maxY, parcelBox.maxY) - Math.max(ab.minY, parcelBox.minY));
      const apArea = Math.max(1e-6, (ab.maxX - ab.minX) * (ab.maxY - ab.minY));
      return (ox * oy) / apArea < 0.75;
    });

  // ── 주변 필지 전체 수집 (표시 + 정북일조 기준 탐지용) ──────────────────────
  const parcelW = parcelBox.maxX - parcelBox.minX;
  const parcelD = parcelBox.maxY - parcelBox.minY;
  const adjTol  = Math.max(2, parcelD * 0.08);

  // 북쪽 30m, 동서남 15m 이내 X축 겹침 필지 (도로 건너편 포함)
  const allNearby = adjParcels.filter(ap => {
    const ab = bboxOf(ap.polygon);
    const xOv = Math.min(ab.maxX, parcelBox.maxX + 15) - Math.max(ab.minX, parcelBox.minX - 15);
    return xOv > 0 && ab.minY < parcelBox.maxY + 30 && ab.maxY > parcelBox.minY - 15;
  });

  // northAdj: 북쪽 관련 필지 — 광역/복잡 도로망 폴리곤 두 조건으로 제외
  const parcelEstArea = parcelW * parcelD;
  const northAdj = allNearby.filter(ap => {
    const ab = bboxOf(ap.polygon);
    const apBboxArea = (ab.maxX - ab.minX) * (ab.maxY - ab.minY);
    // ① bbox 면적이 필지 면적 80배 초과: 광역 도로망/행정 폴리곤
    if (apBboxArea > parcelEstArea * 80) return false;
    // ② 폴리곤 하단이 우리 필지 남단에서 2×parcelD 이상 남쪽: 복잡 커브 도로 폴리곤
    if (ab.minY < parcelBox.minY - parcelD * 2) return false;
    const xOv = Math.min(ab.maxX, parcelBox.maxX + adjTol) - Math.max(ab.minX, parcelBox.minX - adjTol);
    return xOv > 0.5 && ab.maxY > parcelBox.maxY + 0.5 && ab.minY < parcelBox.maxY + 30;
  }).sort((a, b) => bboxOf(a.polygon).minY - bboxOf(b.polygon).minY);

  // 도로 필지 탐지: jimok='도' 또는 동서 방향으로 길고 좁은 띠(깊이<12m)
  const northRoad = northAdj.find(ap => {
    if (ap.jimok === '도') return true;
    const ab = bboxOf(ap.polygon);
    const apW = ab.maxX - ab.minX;
    const apD = ab.maxY - ab.minY;
    return apW > apD * 2.5 && apD < 12;
  });

  // ── 우리 필지 주요 북향 엣지 탐지 (도로 폭 계산 기준) ─────────────────────
  // CCW 폴리곤에서 westward 엣지(북향 외향법선) 중 가장 긴 것을 주요 북측 경계로 사용
  const ccwParcelPre = signedArea2D(parcel) > 0 ? parcel : [...parcel].reverse();
  let mainNorthEdge: { A: [number,number]; B: [number,number]; len: number; midX: number; avgY: number } | null = null;
  for (let i = 0; i < ccwParcelPre.length; i++) {
    const A = ccwParcelPre[i] as [number,number], B = ccwParcelPre[(i+1) % ccwParcelPre.length] as [number,number];
    const len = Math.hypot(B[0]-A[0], B[1]-A[1]);
    if (len < 0.5) continue;
    if ((A[0]-B[0])/len > 0.15) {
      if (!mainNorthEdge || len > mainNorthEdge.len) {
        mainNorthEdge = { A, B, len,
          midX: (A[0]+B[0])/2,
          avgY: (A[1]+B[1])/2,
        };
      }
    }
  }
  const lotMainNorthY   = mainNorthEdge?.avgY  ?? parcelBox.maxY;
  const lotMainNorthXMin = mainNorthEdge ? Math.min(mainNorthEdge.A[0], mainNorthEdge.B[0]) : parcelBox.minX;
  const lotMainNorthXMax = mainNorthEdge ? Math.max(mainNorthEdge.A[0], mainNorthEdge.B[0]) : parcelBox.maxX;
  const lotMainNorthMidX = mainNorthEdge?.midX ?? (parcelBox.minX + parcelBox.maxX) / 2;

  // ── northRef 결정: 실제 인접대지경계선 ──────────────────────────────────────
  let northRef: number;
  {
    if (northRoad) {
      // 도로 폴리곤의 EW 방향 북향 엣지 중 우리 필지 북향 주엣지 X 범위와 겹치는 것의
      // 우리 필지 midX 위치 interpolated Y → 실제 도로 북단 위치
      const ccwR = signedArea2D(northRoad.polygon) > 0 ? northRoad.polygon : [...northRoad.polygon].reverse();
      const candidates: number[] = [];
      for (let i = 0; i < ccwR.length; i++) {
        const A = ccwR[i] as [number,number], B = ccwR[(i+1)%ccwR.length] as [number,number];
        const len = Math.hypot(B[0]-A[0], B[1]-A[1]);
        if (len < 0.5) continue;
        const dx = B[0]-A[0], dy = B[1]-A[1];
        if ((A[0]-B[0])/len <= 0.15) continue;  // 북향 아님
        if (Math.abs(dx) < Math.abs(dy)) continue; // NS 위주 엣지 제외 (도로 동서 측면)
        const sXMin = Math.min(A[0], B[0]);
        const sXMax = Math.max(A[0], B[0]);
        if (sXMax < lotMainNorthXMin - 1 || sXMin > lotMainNorthXMax + 1) continue;
        // 우리 필지 midX에서 Y 보간 (clamp to segment range)
        const cX = Math.max(sXMin, Math.min(sXMax, lotMainNorthMidX));
        const t = sXMax > sXMin ? (cX - A[0]) / (B[0] - A[0]) : 0.5;
        const yHere = A[1] + t * (B[1] - A[1]);
        if (yHere > lotMainNorthY + 0.3) candidates.push(yHere); // 우리 필지 북단보다 북쪽이어야 함
      }
      if (candidates.length > 0) {
        // 도로 북단 = 가장 가까운(낮은) 북측 경계 Y
        const roadNorthY = Math.min(...candidates);
        // northRef: 도로 폭을 parcelBox.maxY 기준으로 환산
        // roadWidth = roadNorthY - lotMainNorthY, roadOffset = roadWidth - (parcelBox.maxY - lotMainNorthY)는 음수가 될 수 있음
        // → northRef = roadNorthY, roadOffset = roadNorthY - parcelBox.maxY
        northRef = roadNorthY;
      } else {
        northRef = bboxOf(northRoad.polygon).maxY; // fallback
      }
    } else {
      const directCands = northAdj.filter(ap => bboxOf(ap.polygon).minY <= parcelBox.maxY + adjTol);
      if (directCands.length > 0) {
        const directMaxY = Math.max(...directCands.map(ap => bboxOf(ap.polygon).maxY));
        const beyondDirect = northAdj.filter(ap => bboxOf(ap.polygon).minY > directMaxY + 0.5);
        northRef = beyondDirect.length > 0 ? directMaxY : parcelBox.maxY;
      } else {
        northRef = northAdj.length > 0 ? bboxOf(northAdj[0].polygon).minY : parcelBox.maxY;
      }
    }
  }
  // roadOffset: northRef(도로 북단)에서 parcelBox.maxY(필지 bbox 북단)까지의 거리
  // ※ 도로 폭(§86⑥용) = northRef - lotMainNorthY (실제 주요 북향 엣지 기준)
  const roadOffset = northRef - parcelBox.maxY;
  const trueRoadWidth = Math.max(0, northRef - lotMainNorthY); // §86⑥ 실제 도로 폭

  // ── 인접대지경계선 세그먼트: 도로 북단 실제 경계선 형상 ───────────────────────
  // northRoad 폴리곤의 북향 엣지를 추출해 실제 경계선 형상을 그대로 사용
  const northBoundarySegs: [[number,number],[number,number]][] = [];
  if (northRoad && roadOffset > 0.5) {
    const poly = northRoad.polygon;
    const ccwRoad = signedArea2D(poly) > 0 ? poly : [...poly].reverse();
    for (let i = 0; i < ccwRoad.length; i++) {
      const A = ccwRoad[i], B = ccwRoad[(i + 1) % ccwRoad.length];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (len < 0.1) continue;
      if ((A[0] - B[0]) / len > 0.15) northBoundarySegs.push([A as [number,number], B as [number,number]]);
    }
  }
  // fallback: northRef Y 기준 수평선
  if (northBoundarySegs.length === 0) {
    northBoundarySegs.push([[parcelBox.minX, northRef], [parcelBox.maxX, northRef]]);
  }

  // ── 우리 필지의 북향 엣지 탐지 (인접대지경계선 형상) ───────────────────────
  // CCW 폴리곤: outward normal Y = (A.x − B.x)/len > 0 이면 북향
  const ccwParcel = signedArea2D(parcel) > 0 ? parcel : [...parcel].reverse();
  const northFacingEdges: [[number,number],[number,number]][] = [];
  for (let i = 0; i < ccwParcel.length; i++) {
    const A = ccwParcel[i];
    const B = ccwParcel[(i + 1) % ccwParcel.length];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (len < 0.05) continue;
    if ((A[0] - B[0]) / len > 0.15) northFacingEdges.push([A, B]);
  }

  // ── ① 건축가능영역: 실제 필지 폴리곤 인셋(BASE_SB) ─────────────────────
  // bbox 직사각형 인셋 대신 폴리곤 인셋을 사용해 불규칙(사다리꼴 등) 필지도
  // 건축가능영역이 실제 필지 경계선 밖으로 나가지 않도록 정확히 처리
  const insetParcel = insetPolygon(parcel, BASE_SB);
  const insetBox    = bboxOf(insetParcel);
  const bzMinX = insetBox.minX;
  const bzMaxX = insetBox.maxX;
  const bzMinY = insetBox.minY;
  const bzMaxY = insetBox.maxY;
  // 건축가능영역 시각화: 실제 인셋 폴리곤 (bbox 직사각형이 아님)
  const buildableRect = insetParcel;

  // ── ③ 건물 배치: 인셋 폴리곤 내부 최적 직사각형 탐색 ────────────────────
  const targetArea = input.대지면적 * (input.건폐율 / 100);
  const EPS = 5e-4;
  const STEPS = 80;

  // 건물 X 범위를 Y 방향으로 스윕하며 교집합을 구하는 공통 함수
  function shrinkX(rMinX0: number, rMaxX0: number, yLevels: number[]): [number, number] {
    let rMinX = rMinX0, rMaxX = rMaxX0;
    for (const yChk of yLevels) {
      const intervals = polyIntervalsAtY(insetParcel, yChk);
      let bestOvlp = -Infinity;
      let nMin = rMinX, nMax = rMinX;
      for (const [iMin, iMax] of intervals) {
        const oMin = Math.max(rMinX, iMin + EPS);
        const oMax = Math.min(rMaxX, iMax - EPS);
        if (oMax > oMin && oMax - oMin > bestOvlp) {
          bestOvlp = oMax - oMin; nMin = oMin; nMax = oMax;
        }
      }
      rMinX = nMin; rMaxX = nMax;
      if (rMaxX <= rMinX) return [rMinX, rMinX];
    }
    return [rMinX, rMaxX];
  }

  // 후보 [minX, maxX] × [minY, minY+height] 에서 건폐율 상한까지 최대 면적 직사각형
  // 폭 최대 유지, 건폐율 초과 시 높이만 줄임
  function evalRect(rMinX: number, rMaxX: number, minY: number, height: number): {
    area: number; minX: number; maxX: number; minY: number; maxY: number;
  } {
    const cW = Math.max(0, rMaxX - rMinX);
    if (cW <= 0 || height <= 0) return { area: 0, minX: rMinX, maxX: rMinX, minY, maxY: minY };
    const cH = cW * height > targetArea ? targetArea / cW : height;
    return { area: cW * cH, minX: rMinX, maxX: rMaxX, minY, maxY: minY + cH };
  }

  // 남쪽·북쪽 모두 자유로운 2D 스윕 — 폴리곤 내부 최대 직사각형 탐색
  // 기존 함수들(findBestRect/findBestRectFromTop)은 항상 폴리곤 팁(폭=0)을 검사해 0㎡ 반환 →
  // Y 샘플을 팁 제외 내부로만 한정해 두 끝을 동시에 스윕
  function findMaxRect(southBound: number, northBound: number): {
    area: number; minX: number; maxX: number; minY: number; maxY: number;
  } {
    let best = { area: 0, minX: bzMinX, maxX: bzMinX, minY: southBound, maxY: southBound };

    // Y 샘플: 균등 분할 + 폴리곤 꼭짓점 Y (폭 급변 지점), 양 끝 팁 제외
    const ySet = new Set<number>();
    for (let i = 1; i < STEPS; i++) {
      ySet.add(southBound + (i / STEPS) * (northBound - southBound));
    }
    for (const [, vy] of insetParcel) {
      if (vy > southBound + EPS && vy < northBound - EPS) ySet.add(vy);
    }
    const yArr = [...ySet].sort((a, b) => a - b);
    if (yArr.length < 2) return best;

    // 상단 Y 고정 → 하단 Y 하향 스윕
    for (let ti = yArr.length - 1; ti >= 1; ti--) {
      const topY = yArr[ti];
      const topIntvs = polyIntervalsAtY(insetParcel, topY);
      if (!topIntvs.length) continue;

      // topY에서 가장 넓은 구간을 초기 X 범위로
      let rMinX = topIntvs[0][0] + EPS, rMaxX = topIntvs[0][1] - EPS;
      for (const [iMin, iMax] of topIntvs) {
        if (iMax - iMin > rMaxX - rMinX) { rMinX = iMin + EPS; rMaxX = iMax - EPS; }
      }
      if (rMaxX <= rMinX) continue;

      for (let bi = ti - 1; bi >= 0; bi--) {
        const botY = yArr[bi];
        const height = topY - botY;
        if (height <= EPS) continue;

        // botY에서 폴리곤 구간 → 현재 X 범위와 교집합
        const botIntvs = polyIntervalsAtY(insetParcel, botY);
        if (!botIntvs.length) break;

        let bestOvlpW = 0, newMin = rMinX, newMax = rMinX;
        for (const [iMin, iMax] of botIntvs) {
          const oMin = Math.max(rMinX, iMin + EPS);
          const oMax = Math.min(rMaxX, iMax - EPS);
          if (oMax > oMin && oMax - oMin > bestOvlpW) {
            bestOvlpW = oMax - oMin; newMin = oMin; newMax = oMax;
          }
        }
        if (bestOvlpW <= 0) break;
        rMinX = newMin; rMaxX = newMax;

        // botY ~ topY 사이 꼭짓점 Y에서 추가 X 축소
        const innerYs = insetParcel
          .filter(([, vy]) => vy > botY + EPS && vy < topY - EPS)
          .map(([, vy]) => vy);
        const [fMinX, fMaxX] = shrinkX(rMinX, rMaxX, innerYs);
        if (fMaxX <= fMinX) continue;

        const cand = evalRect(fMinX, fMaxX, botY, height);
        if (cand.area > best.area) best = cand;
      }
    }
    return best;
  }

  // ── 정북일조 이격 계산 (§86① + §86③ + §86⑥) ────────────────────────────────
  // §86⑥: 북측에 도로 등 공지가 있으면 인접대지경계선이 이동
  //   비공동주택: 인접대지경계선 = 우리 필지 북단 + roadOffset (도로 반대편)
  //              → 우리 필지 내 이격 = max(0, setback - roadOffset)
  //   공동주택:  인접대지경계선 = 우리 필지 북단 + roadOffset/2 (도로 중심선)
  //              → 채광 setback = 높이/2, 우리 필지 내 이격 = max(0, 높이/2 - roadOffset/2)
  const hasNorthRoad = northRoad !== undefined && trueRoadWidth > 0.5;
  const is채광공동주택 = ["아파트","연립주택","기숙사"].some(k => input.용도.includes(k));

  const effectiveSetback: number = (() => {
    if (is채광공동주택) {
      // §86③ 채광기준: 높이 ≤ 인접대지경계선까지 거리 × 2
      // → 우리 필지에서의 이격 = max(0, 높이/2 - trueRoadWidth/2)
      const refDist = hasNorthRoad ? trueRoadWidth / 2 : 0;
      return Math.max(0, floorTopH / 2 - refDist);
    }
    // §86①: 비공동주택 + 다세대주택
    // 기준선이 도로 반대편(+trueRoadWidth)으로 이동 → 우리 필지 이격 차감
    return Math.max(0, northSetbackM - trueRoadWidth);
  })();

  // 도로 중심선 Y (공동주택 §86③ 기준선 표시용)
  const roadCenterY = hasNorthRoad ? parcelBox.maxY + roadOffset / 2 : parcelBox.maxY;

  // 정북일조제한선 세그먼트: effectiveSetback > 0인 경우만
  // northFacingEdges가 비어있으면 필지 bbox 북단 수평선을 fallback으로 사용
  const northFacingBase: [[number,number],[number,number]][] = northFacingEdges.length > 0
    ? northFacingEdges
    : [[[parcelBox.minX, parcelBox.maxY], [parcelBox.maxX, parcelBox.maxY]]];
  const restrictionSegs: [[number,number],[number,number]][] = effectiveSetback > 0
    ? northFacingBase.map(([A, B]) => [
        [A[0], A[1] - effectiveSetback],
        [B[0], B[1] - effectiveSetback],
      ] as [[number,number],[number,number]])
    : [];
  // 기준선 라벨 Y (SVG 좌표) — 정북제한선 라벨 겹침 방지용
  const _northBaseAllPts = northFacingBase.flatMap(([A, B]) => [A, B]);
  const _northBaseMidY   = _northBaseAllPts.reduce((s, p) => s + p[1], 0) / _northBaseAllPts.length;
  const [, northEdgeSvgY] = toSvg(0, _northBaseMidY);

  // 건물 북단 한계: 이격 없으면 필지 북단까지 (BASE_SB 인셋이 실제 한계)
  const bldgNorthLimit = restrictionSegs.length > 0
    ? Math.min(...restrictionSegs.flatMap(([rA, rB]) => [rA[1], rB[1]]))
    : parcelBox.maxY;

  const northLimit = Math.max(bzMinY + EPS, Math.min(bldgNorthLimit, bzMaxY - EPS));
  const bestRes = findMaxRect(bzMinY, northLimit);

  const bMinX = bestRes.minX;
  const bMaxX = bestRes.maxX;
  const bMinY = bestRes.minY;
  const bMaxY = bestRes.maxY;
  const fW    = bMaxX - bMinX;
  const fH    = bMaxY - bMinY;
  const area  = parseFloat((fW * fH).toFixed(2));

  // ── SVG 좌표 변환 ─────────────────────────────────────────────────────
  // 우리 필지가 화면 주인공. 북측 인접대지는 최대 5m 폭 노출만.
  const PAD       = 3;
  const parcelNS  = parcelBox.maxY - parcelBox.minY;
  // 북쪽 표시 범위: 도로가 있으면 도로 폭, 없으면 이격거리 기준 + 여유
  const northShow = Math.max(3, Math.min((hasNorthRoad ? roadOffset : effectiveSetback) + 3, 12));
  // 스케일: 우리 필지 + 북쪽 노출 범위를 기준으로 계산
  const dataW = parcelBox.maxX - parcelBox.minX + PAD * 2;
  const dataH = parcelNS + northShow + PAD * 2;
  const sc    = Math.min(190 / dataW, 260 / dataH);
  const SVG_CX = 185;
  // 우리 필지 북단이 drawingTop + northShow*sc 위치에 오도록 SVG_CY 결정
  const drawingTop = 44;
  const SVG_CY = drawingTop + (northShow + parcelBox.maxY) * sc;

  const toSvg = (x: number, y: number): [number, number] =>
    [SVG_CX + x * sc, SVG_CY - y * sc];
  const ptStr = (pts: [number, number][]) =>
    pts.map(([x, y]) => toSvg(x, y).map(v => v.toFixed(1)).join(",")).join(" ");

  // 다세대주택은 §86① 정북이격 적용 대상 — is채광공동주택(§86③)과 같은 범위로만 한정
  const is공동주택 = ["아파트","연립주택","기숙사"].some(k => input.용도.includes(k));

  // ── hatch 패턴 정의 ──────────────────────────────────────────────────
  let els = `<defs>
  <pattern id="northHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="8" stroke="#d97706" stroke-width="1.5" opacity="0.35"/>
  </pattern>
</defs>`;

  // 헤더
  els += `<text x="185" y="16" text-anchor="middle" font-size="10.5" font-weight="bold" fill="#1e3a5f">${input.용도} · 대지 ${input.대지면적.toFixed(0)}㎡</text>`;

  // ① 주변 모든 필지 지적선 표시 (배경 레이어)
  for (const ap of allNearby) {
    const isRoad = ap.jimok === '도';
    const fill   = isRoad ? '#e5e7eb' : '#f1f5f9';
    els += `<polygon points="${ptStr(ap.polygon)}" fill="${fill}" fill-opacity="0.6" stroke="#cbd5e1" stroke-width="0.7"/>`;
  }
  // 북측 필지 지목 라벨 (흰 배경 + font-size 9)
  for (const ap of northAdj) {
    const ab = bboxOf(ap.polygon);
    if (ab.minY > parcelBox.maxY + northShow) continue;
    const isRoad = ap.jimok === '도';
    const labelY = Math.min((ab.minY + ab.maxY) / 2, parcelBox.maxY + northShow * 0.7);
    const [lax, lay] = toSvg((ab.minX + ab.maxX) / 2, labelY);
    const lbl = isRoad ? '도로' : (ap.jimok || '인접대지');
    const lw = lbl.length * 6.5 + 6;
    els += `<rect x="${(lax - lw/2).toFixed(0)}" y="${(lay - 1).toFixed(0)}" width="${lw.toFixed(0)}" height="11" fill="white" fill-opacity="0.85" rx="2"/>`;
    els += `<text x="${lax.toFixed(0)}" y="${(lay + 8).toFixed(0)}" text-anchor="middle" font-size="9" fill="${isRoad ? '#92400e' : '#475569'}">${lbl}</text>`;
  }

  // 기준선 표시
  if (effectiveSetback > 0) {
    if (is채광공동주택) {
      // §86③ 공동주택: 인접대지경계선 = 도로 중심선(도로 있을 때) or 우리 필지 북단
      const refY = roadCenterY; // 도로 없을 때는 parcelBox.maxY
      const [cx1, cy1] = toSvg(parcelBox.minX, refY);
      const [cx2, cy2] = toSvg(parcelBox.maxX, refY);
      els += `<line x1="${cx1.toFixed(1)}" y1="${cy1.toFixed(1)}" x2="${cx2.toFixed(1)}" y2="${cy2.toFixed(1)}" stroke="#7c3aed" stroke-width="1.8" stroke-dasharray="6,3"/>`;
      const [rdcX, rdcY] = toSvg(0, refY);
      const lbl = hasNorthRoad ? `도로 중심선 (§86③⑥)` : `인접대지경계선 (§86③)`;
      const lblW2 = lbl.length * 8 + 16;
      const clampedLbl2X = Math.max(lblW2/2 + 4, Math.min(W - lblW2/2 - 4, rdcX));
      els += `<rect x="${(clampedLbl2X - lblW2/2).toFixed(0)}" y="${(rdcY - 11).toFixed(0)}" width="${lblW2.toFixed(0)}" height="10" fill="white" fill-opacity="0.88" rx="2"/>`;
      els += `<text x="${clampedLbl2X.toFixed(0)}" y="${(rdcY - 3).toFixed(0)}" text-anchor="middle" font-size="7.5" fill="#7c3aed">${lbl}</text>`;
    } else {
      // §86① 비공동주택: 우리 필지 북향 에지 = 기준선 표시 (실선, 위계 3)
      for (const [nbA, nbB] of northFacingBase) {
        const [ax, ay] = toSvg(nbA[0], nbA[1]);
        const [bx, by] = toSvg(nbB[0], nbB[1]);
        els += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#b45309" stroke-width="1.5"/>`;
      }
      const allNbPts = northFacingBase.flatMap(([A, B]) => [A, B]);
      const nrLblX = allNbPts.reduce((s, p) => s + p[0], 0) / allNbPts.length;
      const nrLblY = allNbPts.reduce((s, p) => s + p[1], 0) / allNbPts.length;
      const [nrSvgX, nrSvgY] = toSvg(nrLblX, nrLblY);
      const lbl = hasNorthRoad ? `우리 필지 북단 (§86⑥)` : `인접대지경계선 (§86①)`;
      const lblW = lbl.length * 8 + 16;
      const clampedLblX = Math.max(lblW/2 + 4, Math.min(W - lblW/2 - 4, nrSvgX));
      els += `<rect x="${(clampedLblX - lblW/2).toFixed(0)}" y="${(nrSvgY - 11).toFixed(0)}" width="${lblW.toFixed(0)}" height="10" fill="white" fill-opacity="0.88" rx="2"/>`;
      els += `<text x="${clampedLblX.toFixed(0)}" y="${(nrSvgY - 3).toFixed(0)}" text-anchor="middle" font-size="7.5" fill="#b45309">${lbl}</text>`;
    }
  }

  // ② 필지 경계 (이점쇄선) — 가장 굵게 (위계 1)
  els += `<polygon points="${ptStr(parcel)}" fill="#fefce8" stroke="#6b7280" stroke-width="2.5" stroke-dasharray="12,3,2,3"/>`;

  // ③ 건축가능영역 배경
  els += `<polygon points="${ptStr(buildableRect)}" fill="#eff6ff" fill-opacity="0.4" stroke="none"/>`;

  // ④ 정북일조 이격대: 실제 필지 북측 형상을 따라 해칭
  // effectiveSetback > 0: 비공동주택 + 북측 대지인 경우만 표시
  if (effectiveSetback > 0 && bldgNorthLimit < parcelBox.maxY) {
    const restrictZone = clipPolygonNorthOf(parcel, bldgNorthLimit);
    if (restrictZone.length >= 3) {
      els += `<polygon points="${ptStr(restrictZone)}" fill="url(#northHatch)" stroke="none"/>`;
      els += `<polygon points="${ptStr(restrictZone)}" fill="#fef3c7" fill-opacity="0.35" stroke="none"/>`;
    }
  }

  // ⑤ 건물 매스 — 가장 굵은 실선 (위계 최상)
  const bPts: [number,number][] = [[bMinX,bMinY],[bMaxX,bMinY],[bMaxX,bMaxY],[bMinX,bMaxY]];
  els += `<polygon points="${ptStr(bPts)}" fill="#3b82f6" fill-opacity="0.30" stroke="#2563eb" stroke-width="3"/>`;

  // ⑥ 건축가능영역 테두리 — 얇은 점선 (위계 4)
  els += `<polygon points="${ptStr(buildableRect)}" fill="none" stroke="#3b82f6" stroke-width="1.0" stroke-dasharray="4,3"/>`;

  // ⑦ 정북일조제한선 + 치수선
  // 비공동주택 + 북측 대지(effectiveSetback > 0)인 경우만 표시
  if (effectiveSetback > 0 && restrictionSegs.length > 0) {

    // ⑦-a 정북일조제한선 — 중간 파선 (위계 3, 굵기 1.2)
    for (const [rA, rB] of restrictionSegs) {
      const [ax, ay] = toSvg(rA[0], rA[1]);
      const [bx, by] = toSvg(rB[0], rB[1]);
      els += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#d97706" stroke-width="1.2" stroke-dasharray="6,3"/>`;
    }

    // 라벨: 제한선 중간에 표시
    const allRPts = restrictionSegs.flatMap(([rA, rB]) => [rA, rB]);
    const rMidX   = allRPts.reduce((s, p) => s + p[0], 0) / allRPts.length;
    const rMidY   = allRPts.reduce((s, p) => s + p[1], 0) / allRPts.length;
    const [lmSvgX, lmSvgYraw] = toSvg(rMidX, rMidY + effectiveSetback * 0.4);
    // 기준선 라벨(northEdgeSvgY) 아래로 최소 12px 확보
    const lmSvgY = Math.max(lmSvgYraw, northEdgeSvgY + 12);
    const rlbl = is채광공동주택
      ? `채광제한선 §86③ (${effectiveSetback.toFixed(2)}m)`
      : `정북제한선 §86① (${effectiveSetback.toFixed(2)}m)`;
    const rlblW = rlbl.length * 8 + 16;
    const clampedRlblX = Math.max(rlblW/2 + 4, Math.min(W - rlblW/2 - 4, lmSvgX));
    els += `<rect x="${(clampedRlblX - rlblW/2).toFixed(0)}" y="${(lmSvgY - 8).toFixed(0)}" width="${rlblW.toFixed(0)}" height="10" fill="white" fill-opacity="0.88" rx="2"/>`;
    els += `<text x="${clampedRlblX.toFixed(0)}" y="${lmSvgY.toFixed(0)}" text-anchor="middle" font-size="7.5" fill="#b45309">${rlbl}</text>`;

    // ⑦-b 치수선: 인접대지경계선(우리 필지 북단) → 정북일조제한선
    const northFacingMaxY = Math.max(...northFacingBase.flatMap(([A, B]) => [A[1], B[1]]));
    const dimRefY   = northFacingMaxY;
    const dimLimitY = northFacingMaxY - effectiveSetback;
    const [, dimRefSvgY  ] = toSvg(0, dimRefY);
    const [, dimLimitSvgY] = toSvg(0, dimLimitY);
    const [dimSvgXbase,  ] = toSvg(parcelBox.minX, 0);
    const dimX = Math.max(8, dimSvgXbase - 16);

    els += `<line x1="${dimX}" y1="${dimRefSvgY.toFixed(1)}" x2="${dimX}" y2="${dimLimitSvgY.toFixed(1)}" stroke="#d97706" stroke-width="0.8" stroke-dasharray="2,2"/>`;
    els += `<line x1="${(dimX-3).toFixed(0)}" y1="${dimRefSvgY.toFixed(1)}" x2="${(dimX+3).toFixed(0)}" y2="${dimRefSvgY.toFixed(1)}" stroke="#d97706" stroke-width="1.2"/>`;
    els += `<line x1="${(dimX-3).toFixed(0)}" y1="${dimLimitSvgY.toFixed(1)}" x2="${(dimX+3).toFixed(0)}" y2="${dimLimitSvgY.toFixed(1)}" stroke="#d97706" stroke-width="0.8"/>`;
    const midDimSvgY = ((dimRefSvgY + dimLimitSvgY) / 2).toFixed(0);
    els += `<rect x="${(dimX - 21).toFixed(0)}" y="${(Number(midDimSvgY) - 8).toFixed(0)}" width="20" height="10" fill="white" fill-opacity="0.9" rx="1"/>`;
    els += `<text x="${(dimX - 11).toFixed(0)}" y="${midDimSvgY}" text-anchor="middle" font-size="7" fill="#b45309">${effectiveSetback.toFixed(2)}m</text>`;
  }

  // 필지 경계 재드로우 (인접 필지 위에 덮어 선명하게) — 위계 1
  els += `<polygon points="${ptStr(parcel)}" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-dasharray="12,3,2,3"/>`;

  // 층·면적 라벨 — 건물 SVG 크기에 맞게 폰트 동적 조정
  const [lcx, lcy] = toSvg(0, (bMinY + bMaxY) / 2);
  const bldgSvgH = Math.abs(toSvg(bMinX, bMaxY)[1] - toSvg(bMinX, bMinY)[1]);
  const bldgSvgW = Math.abs(toSvg(bMaxX, bMinY)[0] - toSvg(bMinX, bMinY)[0]);
  const floorFs  = Math.max(9, Math.min(18, bldgSvgH * 0.28, bldgSvgW * 0.22));
  const areaFs   = Math.max(7, Math.min(12, floorFs * 0.67));
  els += `<text x="${lcx.toFixed(0)}" y="${(lcy - floorFs*0.3).toFixed(0)}" text-anchor="middle" font-size="${floorFs.toFixed(0)}" font-weight="bold" fill="#1d4ed8">${floorIdx + 1}F</text>`;
  els += `<text x="${lcx.toFixed(0)}" y="${(lcy + floorFs*0.7).toFixed(0)}" text-anchor="middle" font-size="${areaFs.toFixed(0)}" fill="#1e3a5f">${area.toFixed(1)} ㎡</text>`;

  // EL 라벨 — 좌하단 고정 표시
  els += `<text x="8" y="${H - 14}" font-size="7.5" fill="#64748b">${floorIdx + 1}F = EL+${floorBottomH.toFixed(1)}m</text>`;

  // 범례 — 수평으로 제목 아래 배치
  {
    const legendItems: { fill: string; stroke: string; dash: string; label: string }[] = [
      { fill: '#fefce8', stroke: '#6b7280', dash: '4,2', label: '대지경계선' },
      { fill: '#eff6ff', stroke: '#93c5fd', dash: '3,2', label: '건축가능영역' },
      ...(effectiveSetback > 0 ? [{ fill: '#fef3c7', stroke: '#d97706', dash: '', label: '정북이격대' }] : []),
      ...(allNearby.some(a => a.jimok !== '도') ? [{ fill: '#f1f5f9', stroke: '#cbd5e1', dash: '', label: '주변대지' }] : []),
      ...(allNearby.some(a => a.jimok === '도') ? [{ fill: '#e5e7eb', stroke: '#cbd5e1', dash: '', label: '도로' }] : []),
    ];
    const itemWidths = legendItems.map(it => 10 + it.label.length * 6.5 + 8);
    const totalW = itemWidths.reduce((s, w) => s + w, 0);
    let lx = Math.max(8, (W - totalW) / 2);
    const LY2 = 30;
    for (let k = 0; k < legendItems.length; k++) {
      const { fill, stroke, dash, label } = legendItems[k];
      els += `<rect x="${lx.toFixed(0)}" y="${LY2-8}" width="9" height="9" fill="${fill}" stroke="${stroke}" stroke-width="0.8" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
      els += `<text x="${(lx+11).toFixed(0)}" y="${LY2}" font-size="7.5" fill="#374151">${label}</text>`;
      lx += itemWidths[k];
    }
  }

  // 북 화살표
  els += `<line x1="14" y1="66" x2="14" y2="52" stroke="#ef4444" stroke-width="2"/>`;
  els += `<polygon points="14,52 10,60 18,60" fill="#ef4444"/>`;
  els += `<text x="14" y="76" text-anchor="middle" font-size="9" font-weight="bold" fill="#ef4444">N</text>`;

  // 치수선 — 가로 (건물 폭), 흰 배경 포함
  const [bbl_x, bbl_y] = toSvg(bMinX, bMinY);
  const [bbr_x, bbr_y] = toSvg(bMaxX, bMinY);
  const dY = Math.max(bbl_y, bbr_y) + 14;
  const dimMidX = (bbl_x + bbr_x) / 2;
  els += `<line x1="${bbl_x.toFixed(1)}" y1="${dY.toFixed(0)}" x2="${bbr_x.toFixed(1)}" y2="${dY.toFixed(0)}" stroke="#cbd5e1" stroke-width="0.8"/>`;
  els += `<line x1="${bbl_x.toFixed(1)}" y1="${(dY-3).toFixed(0)}" x2="${bbl_x.toFixed(1)}" y2="${(dY+3).toFixed(0)}" stroke="#cbd5e1" stroke-width="0.8"/>`;
  els += `<line x1="${bbr_x.toFixed(1)}" y1="${(dY-3).toFixed(0)}" x2="${bbr_x.toFixed(1)}" y2="${(dY+3).toFixed(0)}" stroke="#cbd5e1" stroke-width="0.8"/>`;
  els += `<rect x="${(dimMidX-14).toFixed(0)}" y="${(dY+2).toFixed(0)}" width="28" height="11" fill="white" fill-opacity="0.9" rx="1"/>`;
  els += `<text x="${dimMidX.toFixed(0)}" y="${(dY+11).toFixed(0)}" text-anchor="middle" font-size="8.5" fill="#64748b">${fW.toFixed(1)}m</text>`;

  // 치수선 — 세로 (건물 깊이), 흰 배경 포함
  const [btr_x, btr_y] = toSvg(bMaxX, bMaxY);
  const [bbr2_x, bbr2_y] = toSvg(bMaxX, bMinY);
  // dX를 SVG 경계 안으로 클램핑 (텍스트까지 포함해 W-16 이내)
  const dX = Math.min(W - 32, Math.max(btr_x, bbr2_x) + 14);
  const dimMidY = (btr_y + bbr2_y) / 2;
  els += `<line x1="${dX.toFixed(0)}" y1="${btr_y.toFixed(1)}" x2="${dX.toFixed(0)}" y2="${bbr2_y.toFixed(1)}" stroke="#cbd5e1" stroke-width="0.8"/>`;
  els += `<line x1="${(dX-4).toFixed(0)}" y1="${btr_y.toFixed(1)}" x2="${(dX+4).toFixed(0)}" y2="${btr_y.toFixed(1)}" stroke="#cbd5e1" stroke-width="1"/>`;
  els += `<line x1="${(dX-4).toFixed(0)}" y1="${bbr2_y.toFixed(1)}" x2="${(dX+4).toFixed(0)}" y2="${bbr2_y.toFixed(1)}" stroke="#cbd5e1" stroke-width="1"/>`;
  els += `<rect x="${(dX+2).toFixed(0)}" y="${(dimMidY-6).toFixed(0)}" width="26" height="11" fill="white" fill-opacity="0.9" rx="1"/>`;
  els += `<text x="${(dX+15).toFixed(0)}" y="${(dimMidY+3).toFixed(0)}" text-anchor="middle" font-size="8.5" fill="#64748b">${fH.toFixed(1)}m</text>`;

  // 푸터
  els += `<text x="185" y="${H-14}" text-anchor="middle" font-size="8" fill="#9ca3af">대지안의 공지 ${BASE_SB}m · 건폐율 ${input.건폐율}% · 용적률 ${input.용적률}%</text>`;
  els += `<text x="185" y="${H-3}" text-anchor="middle" font-size="8" fill="#9ca3af">층고 ${층고.toFixed(1)}m · 총높이 ${(input.층수*층고).toFixed(1)}m</text>`;

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="auto" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
  <rect width="${W}" height="${H}" fill="#f8fafc"/>
  ${els}
</svg>`,
    area,
    _northDist: northRef - bMaxY,           // northRef → 건물 북단 실거리(m)
    _bldgDepth: bMaxY - bMinY,               // 건물 남북 깊이(m)
    _parcelDepth: parcelBox.maxY - parcelBox.minY,
    _roadOffset: roadOffset,
    _northRef: northRef,
    _trueRoadWidth: trueRoadWidth,
  };
}

// ── 용도별 실 레이아웃 생성 ──────────────────────────────────────────────────
interface Room { label: string; x: number; y: number; w: number; h: number; }

function generateFloorRooms(용도: string, 가로: number, 세로: number, 층: number, 총층수: number): Room[] {
  const rooms: Room[] = [];
  const coreW = Math.min(Math.max(2.4, 가로 * 0.18), 3.6);
  const coreH = Math.min(Math.max(3.0, 세로 * 0.22), 5.5);

  rooms.push({ label: "계단·EV", x: 0, y: 0, w: coreW, h: coreH });
  if (coreH < 세로 - 0.5) {
    rooms.push({ label: 층 === 1 ? "창고" : "설비실", x: 0, y: coreH, w: coreW, h: 세로 - coreH });
  }

  const rx = coreW, rw = 가로 - coreW;

  if (용도.includes("다세대주택") || 용도.includes("연립주택")) {
    // 다세대/연립: 호별 분리 레이아웃 (층마다 2호)
    const unitW = rw / 2;
    for (let u = 0; u < 2; u++) {
      const ux = rx + u * unitW;
      rooms.push({ label: `${층}0${u+1}호 거실`, x: ux, y: 0, w: unitW, h: 세로 * 0.45 });
      rooms.push({ label: `침실`, x: ux, y: 세로 * 0.45, w: unitW * 0.60, h: 세로 * 0.30 });
      rooms.push({ label: `욕실`, x: ux + unitW * 0.60, y: 세로 * 0.45, w: unitW * 0.40, h: 세로 * 0.30 });
      rooms.push({ label: `주방`, x: ux, y: 세로 * 0.75, w: unitW, h: 세로 * 0.25 });
    }
  } else if (용도.includes("단독주택") || 용도.includes("단독") || 용도.includes("주택")) {
    if (층 === 1) {
      rooms.push({ label: "거실", x: rx, y: 0, w: rw, h: 세로 * 0.52 });
      rooms.push({ label: "주방·식당", x: rx, y: 세로 * 0.52, w: rw * 0.58, h: 세로 * 0.28 });
      rooms.push({ label: "욕실", x: rx + rw * 0.58, y: 세로 * 0.52, w: rw * 0.42, h: 세로 * 0.28 });
      rooms.push({ label: "다용도실", x: rx, y: 세로 * 0.80, w: rw, h: 세로 * 0.20 });
    } else if (층 === 총층수) {
      rooms.push({ label: "침실(마스터)", x: rx, y: 0, w: rw, h: 세로 * 0.50 });
      rooms.push({ label: "욕실(전용)", x: rx, y: 세로 * 0.50, w: rw * 0.38, h: 세로 * 0.28 });
      rooms.push({ label: "드레스룸", x: rx + rw * 0.38, y: 세로 * 0.50, w: rw * 0.62, h: 세로 * 0.28 });
      rooms.push({ label: "다락", x: rx, y: 세로 * 0.78, w: rw, h: 세로 * 0.22 });
    } else {
      rooms.push({ label: "침실", x: rx, y: 0, w: rw * 0.50, h: 세로 * 0.52 });
      rooms.push({ label: "침실", x: rx + rw * 0.50, y: 0, w: rw * 0.50, h: 세로 * 0.52 });
      rooms.push({ label: "욕실", x: rx, y: 세로 * 0.52, w: rw * 0.30, h: 세로 * 0.24 });
      rooms.push({ label: "세탁실", x: rx + rw * 0.30, y: 세로 * 0.52, w: rw * 0.36, h: 세로 * 0.24 });
      rooms.push({ label: "드레스룸", x: rx + rw * 0.66, y: 세로 * 0.52, w: rw * 0.34, h: 세로 * 0.24 });
      rooms.push({ label: "복도", x: rx, y: 세로 * 0.76, w: rw, h: 세로 * 0.24 });
    }
  } else if (용도.includes("업무") || 용도.includes("사무") || 용도.includes("오피스")) {
    rooms.push({ label: "사무공간", x: rx, y: 0, w: rw, h: 세로 * 0.62 });
    rooms.push({ label: "회의실", x: rx, y: 세로 * 0.62, w: rw * 0.52, h: 세로 * 0.22 });
    rooms.push({ label: "탕비실", x: rx + rw * 0.52, y: 세로 * 0.62, w: rw * 0.48, h: 세로 * 0.22 });
    rooms.push({ label: "화장실(남)", x: rx, y: 세로 * 0.84, w: rw * 0.50, h: 세로 * 0.16 });
    rooms.push({ label: "화장실(여)", x: rx + rw * 0.50, y: 세로 * 0.84, w: rw * 0.50, h: 세로 * 0.16 });
  } else if (용도.includes("근린") || 용도.includes("상가") || 용도.includes("판매") || 용도.includes("소매")) {
    if (층 === 1) {
      rooms.push({ label: "영업공간", x: rx, y: 0, w: rw, h: 세로 * 0.72 });
      rooms.push({ label: "창고", x: rx, y: 세로 * 0.72, w: rw * 0.58, h: 세로 * 0.16 });
      rooms.push({ label: "화장실", x: rx + rw * 0.58, y: 세로 * 0.72, w: rw * 0.42, h: 세로 * 0.16 });
      rooms.push({ label: "후면 동선", x: rx, y: 세로 * 0.88, w: rw, h: 세로 * 0.12 });
    } else {
      rooms.push({ label: "영업공간A", x: rx, y: 0, w: rw * 0.50, h: 세로 * 0.68 });
      rooms.push({ label: "영업공간B", x: rx + rw * 0.50, y: 0, w: rw * 0.50, h: 세로 * 0.68 });
      rooms.push({ label: "공용화장실", x: rx, y: 세로 * 0.68, w: rw, h: 세로 * 0.32 });
    }
  } else {
    rooms.push({ label: "주공간", x: rx, y: 0, w: rw, h: 세로 * 0.70 });
    rooms.push({ label: "부공간", x: rx, y: 세로 * 0.70, w: rw * 0.58, h: 세로 * 0.18 });
    rooms.push({ label: "화장실", x: rx + rw * 0.58, y: 세로 * 0.70, w: rw * 0.42, h: 세로 * 0.18 });
    rooms.push({ label: "기계·창고", x: rx, y: 세로 * 0.88, w: rw, h: 세로 * 0.12 });
  }

  return rooms;
}

// ── 정북일조 N-S 단면도 SVG ────────────────────────────────────────────────────
function buildNorthSectionSvg(
  층수: number,
  층고: number,
  용도: string,
  용도지역: string | undefined,
  floorMeta: { northDist: number; bldgDepth: number }[],
  parcelDepth: number,
  trueRoadWidth: number,   // 실제 도로 폭 (§86⑥ 기준, lotMainNorthY 기준)
  lotNorthOffset: number,  // northRef → parcelBox.maxY 거리 (= 구 roadOffset)
): string {
  const totalH = 층수 * 층고;
  const is채광공동주택 = ["아파트","연립주택","기숙사"].some(k => 용도.includes(k));
  const applyNorth = !용도지역 || 용도지역.includes("전용주거") || 용도지역.includes("일반주거");

  // §86① + §86⑥ 실효이격 (단면도 치수선용)
  const secNorthSetback = (!applyNorth || is채광공동주택) ? 0 : (totalH <= 10 ? 1.5 : totalH / 2);
  const secEffSetback   = Math.max(0, secNorthSetback - trueRoadWidth);

  // ── 좌표계 ─────────────────────────────────────────────────────────────────
  // d=0: northRef (인접대지경계선 = 도로 북단), 양수=남쪽
  // 실제 도로: d = -trueRoadWidth ~ 0
  // 필지 bbox 북단: d = lotNorthOffset
  // 필지 남단:      d = lotNorthOffset + parcelDepth

  const W = 420, H = 300;
  const PAD_L = 56, PAD_R = 20, PAD_T = 52, PAD_B = 52;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const lotSouth   = lotNorthOffset + parcelDepth;  // 필지 남단 d 값
  const domainLeft  = -(trueRoadWidth + 1);
  const domainRight = lotSouth + 1;
  const domainH     = totalH * 1.18;

  const scX = plotW / (domainRight - domainLeft);
  const scY = plotH / domainH;
  const sx = (d: number) => PAD_L + (d - domainLeft) * scX;
  const sy = (h: number) => H - PAD_B - h * scY;

  let els = '';

  // ── 제목 (PAD_T 공간 활용) ──────────────────────────────────────────────
  els += `<text x="${W/2}" y="16" text-anchor="middle" font-size="10" font-weight="bold" fill="#1e3a5f">정북일조 N-S 단면도 (§86)</text>`;
  els += `<text x="${W/2}" y="27" text-anchor="middle" font-size="7.5" fill="#6b7280">${용도지역 ?? '용도지역 미확인'} · 총높이 ${totalH.toFixed(1)}m</text>`;

  // ── 배경: 도로(회색) + 필지(노란) ────────────────────────────────────────
  if (trueRoadWidth > 0.5) {
    els += `<rect x="${sx(-trueRoadWidth).toFixed(1)}" y="${PAD_T}" width="${(trueRoadWidth*scX).toFixed(1)}" height="${plotH}" fill="#e5e7eb" fill-opacity="0.75"/>`;
  }
  // 필지 배경: lotNorthOffset ~ lotSouth (bbox 기준)
  els += `<rect x="${sx(lotNorthOffset).toFixed(1)}" y="${PAD_T}" width="${(parcelDepth*scX).toFixed(1)}" height="${plotH}" fill="#fefce8" fill-opacity="0.55"/>`;

  // ── 지면선 ─────────────────────────────────────────────────────────────
  const groundY = sy(0);
  els += `<line x1="${PAD_L}" y1="${groundY.toFixed(1)}" x2="${W-PAD_R}" y2="${groundY.toFixed(1)}" stroke="#92400e" stroke-width="2"/>`;

  // ── 경계선들 (플롯 내부 세로선) ──────────────────────────────────────────
  const lineTop = PAD_T, lineBot = groundY;

  // 인접대지경계선 (d=0, 도로 북단, 주황 점선)
  const adjX = sx(0);
  els += `<line x1="${adjX.toFixed(1)}" y1="${lineTop}" x2="${adjX.toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#b45309" stroke-width="1.8" stroke-dasharray="5,3"/>`;

  // 우리 필지 bbox 북단 (d=lotNorthOffset, 회색 점선) — 도로 내에 있을 수 있음
  if (trueRoadWidth > 0.5 && lotNorthOffset > 0.1) {
    const lotNX = sx(lotNorthOffset);
    els += `<line x1="${lotNX.toFixed(1)}" y1="${lineTop}" x2="${lotNX.toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>`;
  }

  // 도로 남단 = 필지 주요 북향엣지 (d=trueRoadWidth, 남색 점선)
  if (trueRoadWidth > 0.5) {
    const roadSX = sx(trueRoadWidth);
    els += `<line x1="${roadSX.toFixed(1)}" y1="${lineTop}" x2="${roadSX.toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#2563eb" stroke-width="1.2" stroke-dasharray="4,2"/>`;
  }

  // ── 레이블 (흰 배경 + 가독성 개선) ─────────────────────────────────────
  const labelY1 = PAD_T + 12;  // 첫 번째 레이블 Y
  const labelY2 = PAD_T + 23;  // 두 번째 레이블 Y

  if (trueRoadWidth > 0.5) {
    const roadMidX = sx(-trueRoadWidth / 2);
    // 도로 폭 텍스트 (지면선 아래, 흰 배경)
    els += `<rect x="${(roadMidX - 16).toFixed(0)}" y="${(groundY + 3).toFixed(0)}" width="32" height="22" fill="white" fill-opacity="0.9" rx="2"/>`;
    els += `<text x="${roadMidX.toFixed(0)}" y="${(groundY + 13).toFixed(0)}" text-anchor="middle" font-size="8" fill="#6b7280">도로</text>`;
    els += `<text x="${roadMidX.toFixed(0)}" y="${(groundY + 23).toFixed(0)}" text-anchor="middle" font-size="8" fill="#6b7280">${trueRoadWidth.toFixed(1)}m</text>`;
    // 인접대지경계선 레이블 (흰 배경, 두 줄)
    els += `<rect x="${(adjX + 2).toFixed(0)}" y="${(labelY1 - 9)}" width="68" height="24" fill="white" fill-opacity="0.92" rx="2"/>`;
    els += `<text x="${(adjX + 4).toFixed(0)}" y="${labelY1}" font-size="7.5" fill="#b45309">인접대지경계선</text>`;
    els += `<text x="${(adjX + 4).toFixed(0)}" y="${labelY2}" font-size="7.5" fill="#b45309">(§86⑥)</text>`;
    // 필지 북단 레이블 (흰 배경)
    const roadSX = sx(trueRoadWidth);
    els += `<rect x="${(roadSX + 2).toFixed(0)}" y="${(labelY1 - 9)}" width="56" height="13" fill="white" fill-opacity="0.92" rx="2"/>`;
    els += `<text x="${(roadSX + 4).toFixed(0)}" y="${labelY1}" font-size="7.5" fill="#2563eb">우리 필지 북단</text>`;
  } else {
    // 도로 없음: 인접대지경계선 = 필지 북단 (흰 배경)
    els += `<rect x="${(adjX + 2).toFixed(0)}" y="${(labelY1 - 9)}" width="88" height="13" fill="white" fill-opacity="0.92" rx="2"/>`;
    els += `<text x="${(adjX + 4).toFixed(0)}" y="${labelY1}" font-size="7.5" fill="#b45309">인접대지경계선 (§86①)</text>`;
  }

  // ── §86① 정북일조 제한 zone ──────────────────────────────────────────────
  if (applyNorth && !is채광공동주택) {
    // zone 기준점: 인접대지경계선(d=0)에서 남쪽으로 1.5m / h/2
    const h0y = sy(0), h10y = sy(10), htopY = sy(domainH);
    const env10x  = sx(1.5);
    const envTopX = sx(totalH > 10 ? totalH / 2 : 1.5);
    const envTopY = sy(totalH);

    const pts: string[] = [
      `${adjX.toFixed(1)},${htopY.toFixed(1)}`,
      `${adjX.toFixed(1)},${h0y.toFixed(1)}`,
      `${env10x.toFixed(1)},${h0y.toFixed(1)}`,
    ];
    if (totalH > 10) {
      pts.push(`${env10x.toFixed(1)},${h10y.toFixed(1)}`);
      pts.push(`${envTopX.toFixed(1)},${envTopY.toFixed(1)}`);
      pts.push(`${adjX.toFixed(1)},${envTopY.toFixed(1)}`);
    } else {
      pts.push(`${envTopX.toFixed(1)},${envTopY.toFixed(1)}`);
      pts.push(`${adjX.toFixed(1)},${envTopY.toFixed(1)}`);
    }
    els += `<defs><pattern id="sh" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#d97706" stroke-width="1.2" opacity="0.4"/>
    </pattern></defs>`;
    els += `<polygon points="${pts.join(' ')}" fill="url(#sh)"/>`;
    els += `<polygon points="${pts.join(' ')}" fill="#fef3c7" fill-opacity="0.28"/>`;

    // 제한선 (주황 파선)
    els += `<line x1="${env10x.toFixed(1)}" y1="${h0y.toFixed(1)}" x2="${env10x.toFixed(1)}" y2="${h10y.toFixed(1)}" stroke="#d97706" stroke-width="1.5" stroke-dasharray="5,2"/>`;
    if (totalH > 10) {
      els += `<line x1="${env10x.toFixed(1)}" y1="${h10y.toFixed(1)}" x2="${envTopX.toFixed(1)}" y2="${envTopY.toFixed(1)}" stroke="#d97706" stroke-width="1.5" stroke-dasharray="5,2"/>`;
    }
    // 10m 눈금선 (수평 회색 점선)
    if (totalH > 10) {
      els += `<line x1="${PAD_L}" y1="${h10y.toFixed(1)}" x2="${(W-PAD_R)}" y2="${h10y.toFixed(1)}" stroke="#d97706" stroke-width="0.6" stroke-dasharray="2,4" opacity="0.4"/>`;
    }
    // "10m" 라벨은 Y축에 표시하므로 별도 불필요
  }

  // ── 건물 매스 (층별, 남측 기준 = 최대 면적) ────────────────────────────────
  for (let i = 0; i < 층수; i++) {
    const meta = floorMeta[i];
    if (!meta) continue;
    const fBot  = sy(i * 층고);
    const fTop  = sy((i + 1) * 층고);
    // northDist는 northRef(d=0) 기준 → 건물 남쪽은 d=northDist+bldgDepth
    const fLeft  = sx(meta.northDist);
    const fRight = sx(meta.northDist + meta.bldgDepth);
    const fw = Math.max(0, fRight - fLeft);
    const fh = Math.max(0, fBot  - fTop);
    if (fw < 1 || fh < 1) continue;
    els += `<rect x="${fLeft.toFixed(1)}" y="${fTop.toFixed(1)}" width="${fw.toFixed(1)}" height="${fh.toFixed(1)}" fill="#3b82f6" fill-opacity="0.3" stroke="#2563eb" stroke-width="1.2"/>`;
    if (fw > 18) {
      const mx = ((fLeft + fRight) / 2).toFixed(0);
      const my = ((fTop + fBot) / 2 + 4).toFixed(0);
      els += `<text x="${mx}" y="${my}" text-anchor="middle" font-size="7" fill="#1d4ed8">${i+1}F</text>`;
    }
  }

  // ── 치수선: effectiveSetback > 0 시 — 최상층 지붕선 바로 위 플롯 내부 ──────
  if (applyNorth && !is채광공동주택 && secEffSetback > 0.05 && floorMeta.length > 0) {
    const topMeta = floorMeta[floorMeta.length - 1];
    const startD  = trueRoadWidth > 0.5 ? trueRoadWidth : 0;
    const x0 = sx(startD);
    const x1 = sx(topMeta.northDist);
    if (x1 > x0 + 6) {
      const color   = trueRoadWidth > 0.5 ? "#1d4ed8" : "#b45309";
      const roofY   = sy(층수 * 층고);
      // 치수선: 지붕선 +5px 아래 (플롯 내부). 레이블은 선 위(white bg)에 배치
      const dimY    = Math.max(PAD_T + 30, roofY + 5);
      const midX    = ((x0 + x1) / 2).toFixed(0);

      // 수평 치수선 + 끝 마커
      els += `<line x1="${x0.toFixed(1)}" y1="${dimY}" x2="${x1.toFixed(1)}" y2="${dimY}" stroke="${color}" stroke-width="1.2"/>`;
      els += `<line x1="${x0.toFixed(1)}" y1="${dimY-5}" x2="${x0.toFixed(1)}" y2="${dimY+5}" stroke="${color}" stroke-width="1.2"/>`;
      els += `<line x1="${x1.toFixed(1)}" y1="${dimY-5}" x2="${x1.toFixed(1)}" y2="${dimY+5}" stroke="${color}" stroke-width="1.2"/>`;

      // 레이블: 선 위(지붕선 방향)에 흰 배경으로 표시
      const lblY = dimY - 4;
      els += `<rect x="${(Number(midX)-26)}" y="${lblY-9}" width="52" height="12" fill="white" fill-opacity="0.95" rx="2"/>`;
      els += `<text x="${midX}" y="${lblY}" text-anchor="middle" font-size="7.5" fill="${color}">이격 ${secEffSetback.toFixed(2)}m</text>`;
    }
  }

  // ── 공동주택 / 비주거 안내 ────────────────────────────────────────────────
  if (!applyNorth || is채광공동주택) {
    const note = is채광공동주택
      ? "공동주택: 채광기준(§86③) 적용 — 정북일조(§86①) 비적용"
      : `정북일조 미적용 (${용도지역 || '미입력'})`;
    els += `<rect x="${PAD_L+4}" y="${PAD_T+4}" width="${plotW-8}" height="20" fill="#fef9c3" fill-opacity="0.88" rx="3"/>`;
    els += `<text x="${PAD_L+plotW/2}" y="${PAD_T+17}" text-anchor="middle" font-size="8" fill="#92400e">${note}</text>`;
  }

  // ── Y축 (높이) ────────────────────────────────────────────────────────────
  const hMax = Math.ceil(totalH);
  const hStep = hMax <= 12 ? 3 : hMax <= 20 ? 4 : 5;
  for (let h = 0; h <= hMax; h += hStep) {
    if (h > domainH) break;
    const y = sy(h);
    els += `<line x1="${PAD_L-4}" y1="${y.toFixed(1)}" x2="${PAD_L}" y2="${y.toFixed(1)}" stroke="#9ca3af" stroke-width="0.8"/>`;
    els += `<text x="${(PAD_L-6)}" y="${(y+3).toFixed(0)}" text-anchor="end" font-size="8" fill="#6b7280">${h}</text>`;
  }
  const ymid = ((PAD_T + H - PAD_B) / 2).toFixed(0);
  els += `<text x="10" y="${ymid}" text-anchor="middle" font-size="8" fill="#374151" transform="rotate(-90 10 ${ymid})">높이(m)</text>`;

  // ── X축 (거리, 지면선 아래) ───────────────────────────────────────────────
  const xStep = (lotSouth < 10) ? 2 : (lotSouth < 20) ? 4 : 5;
  for (let d = 0; d <= Math.ceil(lotSouth); d += xStep) {
    if (d < domainLeft || d > domainRight) continue;
    const x = sx(d);
    const gy = sy(0);
    els += `<line x1="${x.toFixed(1)}" y1="${gy.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(gy+4)}" stroke="#9ca3af" stroke-width="0.8"/>`;
    els += `<text x="${x.toFixed(0)}" y="${(gy+13).toFixed(0)}" text-anchor="middle" font-size="8" fill="#6b7280">${d}</text>`;
  }
  els += `<text x="${((PAD_L+W-PAD_R)/2).toFixed(0)}" y="${(H-3)}" text-anchor="middle" font-size="8" fill="#374151">← 북 / 남 → (northRef 기준 거리·m)</text>`;

  // ── 북 화살표 ─────────────────────────────────────────────────────────────
  const arX = 22, arTop = PAD_T + 8, arBot = PAD_T + 22;
  els += `<line x1="${arX}" y1="${arBot}" x2="${arX}" y2="${arTop}" stroke="#ef4444" stroke-width="1.8"/>`;
  els += `<polygon points="${arX},${arTop} ${arX-4},${arTop+8} ${arX+4},${arTop+8}" fill="#ef4444"/>`;
  els += `<text x="${arX}" y="${arBot+11}" text-anchor="middle" font-size="8" font-weight="bold" fill="#ef4444">N</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="auto" viewBox="0 0 ${W} ${H}" font-family="sans-serif">${els}</svg>`;
}

// ── DXF (R2007 / AC1021) 생성 — 층별 3D LINE + 실 레이아웃 ──────────────────
function buildDxf(input: LayoutInput, 가로: number, 세로: number, 층고: number): string {
  const out: string[] = [];
  const p = (...args: (string | number)[]) => args.forEach(a => out.push(String(a)));

  const 층수 = input.층수;
  const ACI = [1, 3, 4, 5, 6, 2, 30, 40]; // AutoCAD Color Index

  // ── HEADER ──
  p("0","SECTION","2","HEADER");
  p("9","$ACADVER","1","AC1021");   // R2007 — UTF-8 지원
  p("9","$INSUNITS","70","6");      // 6 = 미터
  p("9","$MEASUREMENT","70","1");   // 1 = 미터계
  p("0","ENDSEC");

  // ── TABLES (레이어 정의) ──
  p("0","SECTION","2","TABLES");
  p("0","TABLE","2","LAYER","70",String(층수 * 2 + 2));
  p("0","LAYER","2","SITE",  "70","0","62","8", "6","CONTINUOUS");
  p("0","LAYER","2","LABEL", "70","0","62","7", "6","CONTINUOUS");
  for (let i = 0; i < 층수; i++) {
    const c = String(ACI[i % ACI.length]);
    p("0","LAYER","2",`F${i+1}`,     "70","0","62",c,"6","CONTINUOUS");
    p("0","LAYER","2",`F${i+1}_RM`,  "70","0","62",c,"6","DASHED");
  }
  p("0","ENDTAB","0","ENDSEC");

  // ── ENTITIES ──
  p("0","SECTION","2","ENTITIES");

  // LINE 하나 그리기 (3D 좌표)
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number, z: number) => {
    p("0","LINE","8",layer,
      "10",x1.toFixed(3),"20",y1.toFixed(3),"30",z.toFixed(3),
      "11",x2.toFixed(3),"21",y2.toFixed(3),"31",z.toFixed(3));
  };

  // 닫힌 사각형 = 4개 LINE
  const rect = (layer: string, x1: number, y1: number, x2: number, y2: number, z: number) => {
    line(layer,x1,y1,x2,y1,z); line(layer,x2,y1,x2,y2,z);
    line(layer,x2,y2,x1,y2,z); line(layer,x1,y2,x1,y1,z);
  };

  // TEXT 엔티티 (중앙 정렬)
  const text = (layer: string, x: number, y: number, z: number, txt: string, h = 0.35) => {
    p("0","TEXT","8",layer,
      "10",x.toFixed(3),"20",y.toFixed(3),"30",z.toFixed(3),
      "40",h.toFixed(3),"1",txt,
      "72","1","73","2",
      "11",x.toFixed(3),"21",y.toFixed(3),"31",z.toFixed(3));
  };

  // 대지 경계 (Z=0)
  const 대지변 = Math.sqrt(input.대지면적);
  rect("SITE", 0, 0, 대지변, 대지변, 0);
  text("LABEL", 대지변/2, -1.2, 0, `대지 ${input.대지면적.toFixed(0)}m² (${대지변.toFixed(1)}×${대지변.toFixed(1)}m)`, 0.45);

  // 건물 위치 (대지 중앙)
  const ox = (대지변 - 가로) / 2;
  const oy = (대지변 - 세로) / 2;

  for (let i = 0; i < 층수; i++) {
    const z = i * 층고;
    const fl = `F${i+1}`;
    const rm = `F${i+1}_RM`;

    // 층 외곽선
    rect(fl, ox, oy, ox+가로, oy+세로, z);

    // 수직 모서리 기둥선 (3D 높이 표현)
    if (i === 0) {
      [[ox,oy],[ox+가로,oy],[ox+가로,oy+세로],[ox,oy+세로]].forEach(([cx,cy]) => {
        line("SITE", cx!, cy!, cx!, cy!, 0);
        line("SITE", cx!, cy!, cx!, cy!, 층수 * 층고);
      });
    }

    // 층 번호 라벨
    text("LABEL", ox+가로/2, oy+세로/2, z+층고*0.5, `${i+1}F  EL+${z.toFixed(1)}m`, 0.55);

    // 실 레이아웃
    const rooms = generateFloorRooms(input.용도, 가로, 세로, i+1, 층수);
    for (const r of rooms) {
      const rx1=ox+r.x, ry1=oy+r.y, rx2=rx1+r.w, ry2=ry1+r.h;
      rect(rm, rx1, ry1, rx2, ry2, z);
      const cx=(rx1+rx2)/2, cy=(ry1+ry2)/2;
      const fh = Math.max(0.20, Math.min(0.40, Math.min(r.w, r.h)*0.14));
      text(rm, cx, cy+fh*0.7, z, r.label, fh);
      text(rm, cx, cy-fh*0.7, z, `${(r.w*r.h).toFixed(1)}m²`, fh*0.75);
    }
  }

  // 최상층 지붕선
  rect("SITE", ox, oy, ox+가로, oy+세로, 층수*층고);

  p("0","ENDSEC","0","EOF");
  return out.join("\n");
}

// ── 용도별 층고 기준 ──────────────────────────────────────────────────────────
function get층고(용도: string): number {
  if (["아파트","연립주택","다세대주택","기숙사","단독주택","주거"].some(k => 용도.includes(k))) return 2.9;
  if (["판매","의료","병원","위락","문화집회"].some(k => 용도.includes(k))) return 4.0;
  if (["업무","오피스","교육연구","학교"].some(k => 용도.includes(k))) return 3.5;
  return 3.3; // 근생·기타
}

// ── 주차대수 간이 산출 (연면적 기반) ────────────────────────────────────────
function calcParkingCount(용도: string, 연면적: number): number {
  if (["아파트","연립주택","다세대주택"].some(k => 용도.includes(k))) return Math.ceil(연면적 / 75);
  if (["업무","판매"].some(k => 용도.includes(k))) return Math.ceil(연면적 / 150);
  if (용도.includes("근린")) return Math.ceil(연면적 / 134);
  if (용도.includes("단독주택")) return 연면적 >= 50 ? 1 : 0;
  return Math.ceil(연면적 / 200);
}

export async function POST(req: NextRequest) {
  const input: LayoutInput = await req.json();
  if (!input.대지면적 || !input.건폐율 || !input.층수) {
    return NextResponse.json({ error: "대지면적·건폐율·층수가 필요합니다." }, { status: 400 });
  }

  const 건축면적목표 = input.대지면적 * (input.건폐율 / 100);
  const 가로 = input.대지가로 && input.대지가로 > 0 ? input.대지가로 : Math.sqrt(건축면적목표);
  const 세로 = input.대지세로 && input.대지세로 > 0 ? input.대지세로 : 건축면적목표 / 가로;
  const 층고  = get층고(input.용도);

  // 실제 필지 폴리곤 + 인접 필지 조회
  const [parcelPts, adjParcels] = (input.lat && input.lng)
    ? await Promise.all([
        fetchTargetParcel(input.lat, input.lng),
        fetchAdjacentParcels(input.lat, input.lng),
      ])
    : [null, [] as AdjacentParcel[]];

  const floorResults = Array.from({ length: input.층수 }, (_, i) =>
    buildFloorSvg(i, input, 가로, 세로, 층고, parcelPts, adjParcels)
  );

  // 용적률 상한 적용: 아래층부터 채우고 남은 용량만 위층에 배분
  // 용적률 cap: 비례 배분 방식
  // 아래 층부터 채우면 상위 층(정북이격으로 이미 작아진 층)이 0이 되는 문제 방지
  const 최대연면적cap = input.최대연면적 ?? input.대지면적 * (input.용적률 / 100);
  const rawTotal = floorResults.reduce((s, r) => s + r.area, 0);
  const scaleFactor = rawTotal > 0 && rawTotal > 최대연면적cap ? 최대연면적cap / rawTotal : 1;
  const floors = floorResults.map((r, i) => {
    const cappedArea = parseFloat((r.area * scaleFactor).toFixed(2));
    // SVG 내부 면적 텍스트를 cappedArea로 교체 (rawArea와 불일치 방지)
    const svg = scaleFactor < 0.999
      ? r.svg.replace(`${r.area.toFixed(1)} ㎡`, `${cappedArea.toFixed(1)} ㎡`)
      : r.svg;
    return { floor: i + 1, area: cappedArea, svg };
  });
  const gltfJson = buildHyparJson(input, 가로, 세로, 층고);
  const dxf      = buildDxf(input, 가로, 세로, 층고);

  const 연면적     = floors.reduce((s, f) => s + f.area, 0);
  const 건축면적실  = floors[0]?.area ?? 건축면적목표;

  // 단면도 데이터 (층별 northDist, bldgDepth)
  const floorMeta = floorResults.map(r => ({ northDist: r._northDist, bldgDepth: r._bldgDepth }));
  const f0 = floorResults[0];
  const parcelDepth = f0?._parcelDepth ?? Math.sqrt(input.대지면적);
  const roadOffset      = f0?._roadOffset      ?? 0;
  const trueRoadWidth   = f0?._trueRoadWidth   ?? roadOffset;

  const northSectionSvg = buildNorthSectionSvg(
    input.층수, 층고, input.용도, input.용도지역,
    floorMeta, parcelDepth, trueRoadWidth, roadOffset,
  );

  // 정북일조 영향층 (northDist가 1층보다 증가하기 시작하는 층)
  const 정북영향층 = floorResults.findIndex((r, i) => i > 0 && r._northDist > floorResults[0]._northDist + 0.1) + 1;

  // 주차대수
  const 주차대수 = calcParkingCount(input.용도, 연면적);

  // 다세대주택은 §86① 정북이격 적용 대상 — is채광공동주택(§86③)과 같은 범위로만 한정
  const is공동주택 = ["아파트","연립주택","기숙사"].some(k => input.용도.includes(k));
  const 달성건폐율 = Math.round(건축면적실 / input.대지면적 * 1000) / 10;
  const 달성용적률 = Math.round(연면적 / input.대지면적 * 1000) / 10;

  return NextResponse.json({
    floors,
    gltfJson,
    dxf,
    stats: {
      건축면적:    Math.round(건축면적실 * 10) / 10,
      연면적:      Math.round(연면적 * 10) / 10,
      층수:        input.층수,
      층고,
      총높이:      Math.round(input.층수 * 층고 * 10) / 10,
      is공동주택,
      용도지역:    input.용도지역 ?? "",
      달성건폐율,
      달성용적률,
      주차대수,
      정북영향층:  정북영향층 > 0 ? 정북영향층 : null,
      northRoadOffset: trueRoadWidth,  // §86⑥ 실제 도로 폭 (필지 북향 주엣지 기준)
      northSectionSvg,  // 단면도 SVG
    },
  });
}
