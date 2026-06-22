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

// ── 정북일조 이격거리 계산 (건축법 제61조·시행령 제86조 제1항) ─────────────────
// 적용대상: 전용주거지역·일반주거지역만. 준주거·상업·공업 등 미적용.
// 비공동주택: 높이 9m 이하 → 1.5m, 9m 초과 → 높이/2 (§86①의 기준값)
// 공동주택(아파트·연립·다세대·기숙사): 채광기준(제61조제2항) 별도 적용 → 0 반환
function calcNorthSetback(floorTopH: number, 용도: string, 용도지역?: string): number {
  const is공동주택 = ["아파트","연립주택","다세대주택","기숙사"].some(k => 용도.includes(k));
  if (is공동주택) return 0;
  // 용도지역이 명시된 경우 전용·일반주거지역이 아니면 미적용
  if (용도지역 && !(용도지역.includes("전용주거") || 용도지역.includes("일반주거"))) return 0;
  return floorTopH <= 9 ? 1.5 : floorTopH / 2;
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
): { svg: string; area: number; _northDist: number; _bldgDepth: number; _parcelDepth: number; _roadOffset: number; _northRef: number } {
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

  // ── northRef 결정: 실제 인접대지경계선 ──────────────────────────────────────
  let northRef: number;
  {
    if (northRoad) {
      northRef = bboxOf(northRoad.polygon).maxY;
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
  const roadOffset = northRef - parcelBox.maxY; // 도로 폭 (0이면 도로 없음)

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

  // 정북일조 제한선: 항상 우리 필지 북향 에지(northFacingEdges)에서 setback
  // §86①: 인접대지경계선(우리 필지 북단)에서 이격
  // §86③: 8m 이상 도로 → 도로폭만큼 완화 (setback - roadOffset, 최소 0)
  // northRef(bbox.maxY)는 기울어진 도로에서 실제보다 훨씬 크므로 직접 사용 금지
  const effectiveSetback = (northRoad && roadOffset >= 8)
    ? Math.max(0, northSetbackM - roadOffset)
    : northSetbackM;

  const restrictionSegs: [[number,number],[number,number]][] = northFacingEdges.map(([A, B]) => [
    [A[0], A[1] - effectiveSetback],
    [B[0], B[1] - effectiveSetback],
  ] as [[number,number],[number,number]]);

  // 건물 북단 한계: restrictionSegs와 일치 (기울어진 도로에서 northRef 오차 방지)
  const bldgNorthLimit = restrictionSegs.length > 0
    ? Math.min(...restrictionSegs.flatMap(([rA, rB]) => [rA[1], rB[1]]))
    : parcelBox.maxY - effectiveSetback;

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
  // 북쪽으로 보여줄 범위: 정북이격 + 여유 1m (최소 3m, 최대 5m)
  // 북쪽 표시 범위: 도로 폭 포함, 인접대지경계선이 보이도록
  const northShow = Math.max(3, Math.min(Math.max(northSetbackM, roadOffset) + 2, 12));
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

  const is공동주택 = ["아파트","연립주택","다세대주택","기숙사"].some(k => input.용도.includes(k));

  // ── hatch 패턴 정의 ─────────────────────────────────────────────────
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
  // 북측 필지 지목 라벨
  for (const ap of northAdj) {
    const ab = bboxOf(ap.polygon);
    if (ab.minY > parcelBox.maxY + northShow) continue;
    const isRoad = ap.jimok === '도';
    const labelY = Math.min((ab.minY + ab.maxY) / 2, parcelBox.maxY + northShow * 0.7);
    const [lax, lay] = toSvg((ab.minX + ab.maxX) / 2, labelY);
    els += `<text x="${lax.toFixed(0)}" y="${(lay + 4).toFixed(0)}" text-anchor="middle" font-size="7" fill="${isRoad ? '#92400e' : '#64748b'}">${isRoad ? '도로' : (ap.jimok || '인접대지')}</text>`;
  }

  // 인접대지경계선 강조 — 우리 필지 북향 에지(이격 기준선) 표시
  if (!is공동주택) {
    // ① 우리 필지 북향 에지: 이격 기준선 (굵은 갈색 실선)
    for (const [nbA, nbB] of northFacingEdges) {
      const [ax, ay] = toSvg(nbA[0], nbA[1]);
      const [bx, by] = toSvg(nbB[0], nbB[1]);
      els += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#b45309" stroke-width="2.2"/>`;
    }
    // ② 도로 반대편 경계선: 참고용 (얇은 갈색 점선, SVG 범위 내만)
    if (northRoad && roadOffset > 0.5) {
      for (const [nbA, nbB] of northBoundarySegs) {
        const maxSegY = Math.max(nbA[1], nbB[1]);
        if (maxSegY > parcelBox.maxY + northShow + 0.5) continue;
        const [ax, ay] = toSvg(nbA[0], nbA[1]);
        const [bx, by] = toSvg(nbB[0], nbB[1]);
        els += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#92400e" stroke-width="1.2" stroke-dasharray="3,2" opacity="0.7"/>`;
      }
    }
    // 라벨: 우리 필지 북향 에지 중점 기준
    const allNbPts = northFacingEdges.flatMap(([A, B]) => [A, B]);
    if (allNbPts.length > 0) {
      const nrLblX = allNbPts.reduce((s, p) => s + p[0], 0) / allNbPts.length;
      const nrLblY = allNbPts.reduce((s, p) => s + p[1], 0) / allNbPts.length;
      const [nrSvgX, nrSvgY] = toSvg(nrLblX, nrLblY);
      els += `<rect x="${(nrSvgX - 54).toFixed(0)}" y="${(nrSvgY - 11).toFixed(0)}" width="108" height="9" fill="white" fill-opacity="0.85" rx="1"/>`;
      els += `<text x="${nrSvgX.toFixed(0)}" y="${(nrSvgY - 4).toFixed(0)}" text-anchor="middle" font-size="6.5" fill="#b45309">인접대지경계선 (기준)</text>`;
    }
  }

  // ② 필지 경계 (이점쇄선) — 가장 굵게 (위계 1)
  els += `<polygon points="${ptStr(parcel)}" fill="#fefce8" stroke="#6b7280" stroke-width="2.5" stroke-dasharray="12,3,2,3,2,3"/>`;

  // ③ 건축가능영역 배경
  els += `<polygon points="${ptStr(buildableRect)}" fill="#eff6ff" fill-opacity="0.4" stroke="none"/>`;

  // ④ 정북일조 이격대: 실제 필지 북측 형상을 따라 해칭 (clipPolygonNorthOf)
  if (!is공동주택 && bldgNorthLimit < parcelBox.maxY) {
    const restrictZone = clipPolygonNorthOf(parcel, bldgNorthLimit);
    if (restrictZone.length >= 3) {
      els += `<polygon points="${ptStr(restrictZone)}" fill="url(#northHatch)" stroke="none"/>`;
      els += `<polygon points="${ptStr(restrictZone)}" fill="#fef3c7" fill-opacity="0.35" stroke="none"/>`;
    }
    // 도로 있을 경우: 도로~우리 필지 북단 구간도 연한 표시
    if (northRoad) {
      const roadBands: [number,number][] = [
        [parcelBox.minX, parcelBox.maxY], [parcelBox.maxX, parcelBox.maxY],
        [parcelBox.maxX, northRef],       [parcelBox.minX, northRef],
      ];
      els += `<polygon points="${ptStr(roadBands)}" fill="#d1d5db" fill-opacity="0.3" stroke="none"/>`;
    }
  }

  // ⑤ 건물 매스 — 가장 굵은 실선 (위계 최상)
  const bPts: [number,number][] = [[bMinX,bMinY],[bMaxX,bMinY],[bMaxX,bMaxY],[bMinX,bMaxY]];
  els += `<polygon points="${ptStr(bPts)}" fill="#3b82f6" fill-opacity="0.30" stroke="#2563eb" stroke-width="3"/>`;

  // ⑥ 건축가능영역 테두리 (건물 위) — 위계 2
  els += `<polygon points="${ptStr(buildableRect)}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-dasharray="5,3"/>`;

  // ⑦ 정북일조제한선 + 북측 기준경계선 + 치수선
  if (!is공동주택) {

    // ⑦-a 정북일조제한선: 인접대지경계선 형태를 따르는 폴리선
    if (northSetbackM > 0 && restrictionSegs.length > 0) {
      for (const [rA, rB] of restrictionSegs) {
        const [ax, ay] = toSvg(rA[0], rA[1]);
        const [bx, by] = toSvg(rB[0], rB[1]);
        els += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#d97706" stroke-width="2" stroke-dasharray="6,3"/>`;
      }

      // 라벨: 이격대 중간 (제한선 세그먼트 중앙 ~ northRef 중점)
      const allRPts = restrictionSegs.flatMap(([rA, rB]) => [rA, rB]);
      const rMidX   = allRPts.reduce((s, p) => s + p[0], 0) / allRPts.length;
      const rMidY   = allRPts.reduce((s, p) => s + p[1], 0) / allRPts.length;
      const [lmSvgX, ] = toSvg(rMidX, 0);
      const [, lmSvgY] = toSvg(0, (rMidY + northRef) / 2);
      const lbl = `정북일조제한선 (h=${floorTopH.toFixed(1)}m → ${northSetbackM.toFixed(2)}m)`;
      els += `<rect x="${(lmSvgX - 78).toFixed(0)}" y="${(lmSvgY - 8).toFixed(0)}" width="156" height="10" fill="white" fill-opacity="0.85" rx="1"/>`;
      els += `<text x="${lmSvgX.toFixed(0)}" y="${lmSvgY.toFixed(0)}" text-anchor="middle" font-size="6.5" fill="#b45309">${lbl}</text>`;

      // ⑦-b 치수선: 우리 필지 북향 에지 → 제한선 (northRef bbox.maxY는 기울어진 도로에서 오차 큼)
      const northFacingMaxY = northFacingEdges.length > 0
        ? Math.max(...northFacingEdges.flatMap(([A, B]) => [A[1], B[1]]))
        : parcelBox.maxY;
      const dimRefY   = northFacingMaxY;
      const dimLimitY = northFacingMaxY - effectiveSetback;
      const [, dimRefSvgY  ] = toSvg(0, dimRefY);
      const [, dimLimitSvgY] = toSvg(0, dimLimitY);
      const [dimSvgXbase,  ] = toSvg(parcelBox.minX, 0);
      const dimX = Math.max(8, dimSvgXbase - 16);

      els += `<line x1="${dimX}" y1="${dimRefSvgY.toFixed(1)}" x2="${dimX}" y2="${dimLimitSvgY.toFixed(1)}" stroke="#d97706" stroke-width="0.8" stroke-dasharray="2,2"/>`;
      // 인접대지경계선 틱
      els += `<line x1="${(dimX-3).toFixed(0)}" y1="${dimRefSvgY.toFixed(1)}" x2="${(dimX+3).toFixed(0)}" y2="${dimRefSvgY.toFixed(1)}" stroke="#d97706" stroke-width="1.2"/>`;
      // 제한선 틱
      els += `<line x1="${(dimX-3).toFixed(0)}" y1="${dimLimitSvgY.toFixed(1)}" x2="${(dimX+3).toFixed(0)}" y2="${dimLimitSvgY.toFixed(1)}" stroke="#d97706" stroke-width="0.8"/>`;
      // 치수 텍스트
      const midDimSvgY = ((dimRefSvgY + dimLimitSvgY) / 2).toFixed(0);
      els += `<rect x="${(dimX - 21).toFixed(0)}" y="${(Number(midDimSvgY) - 8).toFixed(0)}" width="20" height="10" fill="white" fill-opacity="0.9" rx="1"/>`;
      els += `<text x="${(dimX - 11).toFixed(0)}" y="${midDimSvgY}" text-anchor="middle" font-size="7" fill="#b45309">${northSetbackM.toFixed(2)}m</text>`;
    }
  }

  // 필지 경계 재드로우 (인접 필지 위에 덮어 선명하게) — 위계 1
  els += `<polygon points="${ptStr(parcel)}" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-dasharray="12,3,2,3,2,3"/>`;

  // 층·면적 라벨
  const [lcx, lcy] = toSvg(0, (bMinY + bMaxY) / 2);
  els += `<text x="${lcx.toFixed(0)}" y="${(lcy-7).toFixed(0)}" text-anchor="middle" font-size="18" font-weight="bold" fill="#1d4ed8">${floorIdx + 1}F</text>`;
  els += `<text x="${lcx.toFixed(0)}" y="${(lcy+12).toFixed(0)}" text-anchor="middle" font-size="12" fill="#1e3a5f">${area.toFixed(1)} ㎡</text>`;

  // EL 라벨 — 좌하단 고정 표시
  els += `<text x="8" y="${H - 14}" font-size="7.5" fill="#64748b">${floorIdx + 1}F = EL+${floorBottomH.toFixed(1)}m</text>`;

  // 범례 — 수평으로 제목 아래 배치
  {
    const legendItems: { fill: string; stroke: string; dash: string; label: string }[] = [
      { fill: '#fefce8', stroke: '#6b7280', dash: '4,2', label: '대지경계선' },
      { fill: '#eff6ff', stroke: '#93c5fd', dash: '3,2', label: '건축가능영역' },
      ...(!is공동주택 ? [{ fill: '#fef3c7', stroke: '#d97706', dash: '', label: '정북이격대' }] : []),
      ...(allNearby.some(a => a.jimok !== '도') ? [{ fill: '#f1f5f9', stroke: '#cbd5e1', dash: '', label: '주변대지' }] : []),
      ...(allNearby.some(a => a.jimok === '도') ? [{ fill: '#e5e7eb', stroke: '#cbd5e1', dash: '', label: '도로' }] : []),
    ];
    const itemWidths = legendItems.map(it => 10 + it.label.length * 5.5 + 8);
    const totalW = itemWidths.reduce((s, w) => s + w, 0);
    let lx = Math.max(8, (W - totalW) / 2);
    const LY2 = 30;
    for (let k = 0; k < legendItems.length; k++) {
      const { fill, stroke, dash, label } = legendItems[k];
      els += `<rect x="${lx.toFixed(0)}" y="${LY2-8}" width="8" height="8" fill="${fill}" stroke="${stroke}" stroke-width="0.8" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
      els += `<text x="${(lx+10).toFixed(0)}" y="${LY2}" font-size="6.5" fill="#374151">${label}</text>`;
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
  const dX = Math.max(btr_x, bbr2_x) + 14;
  const dimMidY = (btr_y + bbr2_y) / 2;
  els += `<line x1="${dX.toFixed(0)}" y1="${btr_y.toFixed(1)}" x2="${dX.toFixed(0)}" y2="${bbr2_y.toFixed(1)}" stroke="#cbd5e1" stroke-width="0.8"/>`;
  els += `<line x1="${(dX-3).toFixed(0)}" y1="${btr_y.toFixed(1)}" x2="${(dX+3).toFixed(0)}" y2="${btr_y.toFixed(1)}" stroke="#cbd5e1" stroke-width="0.8"/>`;
  els += `<line x1="${(dX-3).toFixed(0)}" y1="${bbr2_y.toFixed(1)}" x2="${(dX+3).toFixed(0)}" y2="${bbr2_y.toFixed(1)}" stroke="#cbd5e1" stroke-width="0.8"/>`;
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

  if (용도.includes("단독주택") || 용도.includes("단독") || 용도.includes("주택")) {
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
  roadOffset: number,
): string {
  const totalH = 층수 * 층고;
  const is공동주택 = ["아파트","연립주택","다세대주택","기숙사"].some(k => 용도.includes(k));
  const applyNorth = !is공동주택 && (!용도지역 || 용도지역.includes("전용주거") || 용도지역.includes("일반주거"));

  const W = 400, H = 270;
  const PAD_L = 52, PAD_R = 18, PAD_T = 36, PAD_B = 42;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // X축: northRef=0, 남쪽이 양수 방향
  const maxDistRight = roadOffset + parcelDepth;
  const domainLeft   = -(roadOffset + 1); // 도로 서측 약간 더 보임
  const domainRight  = maxDistRight + 1;
  const domainH      = totalH * 1.15;

  const scX = plotW / (domainRight - domainLeft);
  const scY = plotH / domainH;

  const sx = (d: number) => PAD_L + (d - domainLeft) * scX;
  const sy = (h: number) => H - PAD_B - h * scY;

  let els = '';

  // 제목
  els += `<text x="${W/2}" y="18" text-anchor="middle" font-size="10" font-weight="bold" fill="#1e3a5f">정북일조 N-S 단면도</text>`;
  els += `<text x="${W/2}" y="29" text-anchor="middle" font-size="7.5" fill="#6b7280">인접대지경계선 기준 · ${용도지역 ?? '용도지역 미확인'}</text>`;

  // 배경: 도로 + 필지
  if (roadOffset > 0.5) {
    els += `<rect x="${sx(-roadOffset).toFixed(1)}" y="${PAD_T}" width="${(roadOffset*scX).toFixed(1)}" height="${plotH}" fill="#e5e7eb" fill-opacity="0.7"/>`;
  }
  els += `<rect x="${sx(0).toFixed(1)}" y="${PAD_T}" width="${(parcelDepth*scX).toFixed(1)}" height="${plotH}" fill="#fefce8" fill-opacity="0.5"/>`;

  // 지면선
  els += `<line x1="${PAD_L}" y1="${sy(0).toFixed(1)}" x2="${(W-PAD_R)}" y2="${sy(0).toFixed(1)}" stroke="#92400e" stroke-width="2"/>`;

  // 인접대지경계선 (northRef)
  const nx = sx(0);
  els += `<line x1="${nx.toFixed(1)}" y1="${PAD_T}" x2="${nx.toFixed(1)}" y2="${sy(0).toFixed(1)}" stroke="#b45309" stroke-width="1.8" stroke-dasharray="5,3"/>`;
  els += `<text x="${nx.toFixed(0)}" y="${PAD_T-4}" text-anchor="middle" font-size="6.5" fill="#b45309">인접대지경계선</text>`;

  if (applyNorth) {
    // 정북일조 제한 zone (해칭)
    const h9y = sy(9); const h0y = sy(0); const htopY = sy(domainH);
    const envelope9x = sx(1.5);
    const envelopeTopX = sx(totalH > 9 ? totalH / 2 : 1.5);
    const envelopeTopY = sy(totalH);

    const zonePts: string[] = [];
    zonePts.push(`${nx.toFixed(1)},${htopY.toFixed(1)}`);
    zonePts.push(`${nx.toFixed(1)},${h0y.toFixed(1)}`);
    zonePts.push(`${envelope9x.toFixed(1)},${h0y.toFixed(1)}`);
    if (totalH > 9) {
      zonePts.push(`${envelope9x.toFixed(1)},${h9y.toFixed(1)}`);
      zonePts.push(`${envelopeTopX.toFixed(1)},${envelopeTopY.toFixed(1)}`);
      zonePts.push(`${nx.toFixed(1)},${envelopeTopY.toFixed(1)}`);
    } else {
      zonePts.push(`${envelopeTopX.toFixed(1)},${envelopeTopY.toFixed(1)}`);
      zonePts.push(`${nx.toFixed(1)},${envelopeTopY.toFixed(1)}`);
    }

    els += `<defs><pattern id="sh" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#d97706" stroke-width="1.2" opacity="0.45"/>
    </pattern></defs>`;
    els += `<polygon points="${zonePts.join(' ')}" fill="url(#sh)"/>`;
    els += `<polygon points="${zonePts.join(' ')}" fill="#fef3c7" fill-opacity="0.3"/>`;

    // 제한선: 수직부(0~9m) + 사선부(9m~top)
    els += `<line x1="${envelope9x.toFixed(1)}" y1="${h0y.toFixed(1)}" x2="${envelope9x.toFixed(1)}" y2="${h9y.toFixed(1)}" stroke="#d97706" stroke-width="1.6" stroke-dasharray="5,2"/>`;
    if (totalH > 9) {
      els += `<line x1="${envelope9x.toFixed(1)}" y1="${h9y.toFixed(1)}" x2="${envelopeTopX.toFixed(1)}" y2="${envelopeTopY.toFixed(1)}" stroke="#d97706" stroke-width="1.6" stroke-dasharray="5,2"/>`;
    }
    els += `<text x="${(envelope9x+6).toFixed(0)}" y="${(h9y-3).toFixed(0)}" font-size="6.5" fill="#d97706">9m (기준)</text>`;
  }

  // 건물 매스 (층별 계단형)
  for (let i = 0; i < 층수; i++) {
    const meta = floorMeta[i];
    if (!meta) continue;
    const fBot = sy(i * 층고);
    const fTop = sy((i + 1) * 층고);
    const fLeft  = sx(meta.northDist);
    const fRight = sx(meta.northDist + meta.bldgDepth);
    const w = Math.max(0, fRight - fLeft);
    const h = Math.max(0, fBot - fTop);
    els += `<rect x="${fLeft.toFixed(1)}" y="${fTop.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#3b82f6" fill-opacity="0.28" stroke="#2563eb" stroke-width="1"/>`;
    // 층 번호
    if (w > 20) {
      const mid = ((fLeft + fRight) / 2).toFixed(0);
      const vmid = ((fTop + fBot) / 2 + 3).toFixed(0);
      els += `<text x="${mid}" y="${vmid}" text-anchor="middle" font-size="6.5" fill="#1d4ed8">${i+1}F</text>`;
    }
  }

  // 도로 라벨
  if (roadOffset > 0.5) {
    const roadMidX = sx(-roadOffset / 2);
    els += `<text x="${roadMidX.toFixed(0)}" y="${(sy(0)+13).toFixed(0)}" text-anchor="middle" font-size="7" fill="#6b7280">도로 ${roadOffset.toFixed(1)}m</text>`;
  }

  // 치수: 최상층 정북이격
  if (applyNorth && floorMeta.length > 0) {
    const topMeta = floorMeta[floorMeta.length - 1];
    const topH = 층수 * 층고;
    const reqSetback = topH <= 9 ? 1.5 : topH / 2;
    const dimY = sy(0) + 22;
    const x0 = sx(0); const x1 = sx(topMeta.northDist);
    els += `<line x1="${x0.toFixed(1)}" y1="${dimY}" x2="${x1.toFixed(1)}" y2="${dimY}" stroke="#b45309" stroke-width="0.9"/>`;
    els += `<line x1="${x0.toFixed(1)}" y1="${(dimY-3)}" x2="${x0.toFixed(1)}" y2="${(dimY+3)}" stroke="#b45309" stroke-width="0.9"/>`;
    els += `<line x1="${x1.toFixed(1)}" y1="${(dimY-3)}" x2="${x1.toFixed(1)}" y2="${(dimY+3)}" stroke="#b45309" stroke-width="0.9"/>`;
    const midX = ((x0+x1)/2).toFixed(0);
    els += `<rect x="${(Number(midX)-18)}" y="${dimY+3}" width="36" height="11" fill="white" fill-opacity="0.9" rx="1"/>`;
    els += `<text x="${midX}" y="${dimY+12}" text-anchor="middle" font-size="7.5" fill="#b45309">${reqSetback.toFixed(2)}m</text>`;
  }

  // 공동주택 / 비주거 안내
  if (!applyNorth) {
    const note = is공동주택 ? "공동주택: 채광기준(§61②) 적용" : `정북일조 미적용 (${용도지역 || '용도지역 미입력'})`;
    els += `<rect x="${PAD_L+4}" y="${PAD_T+4}" width="${plotW-8}" height="22" fill="#fef9c3" fill-opacity="0.85" rx="3"/>`;
    els += `<text x="${PAD_L + plotW/2}" y="${PAD_T+18}" text-anchor="middle" font-size="8.5" fill="#92400e">${note}</text>`;
  }

  // Y축 (높이 눈금)
  const hTicks = Array.from({ length: Math.ceil(totalH / 3) + 1 }, (_, k) => k * 3).filter(h => h <= domainH);
  for (const h of hTicks) {
    const y = sy(h);
    els += `<line x1="${PAD_L-4}" y1="${y.toFixed(1)}" x2="${PAD_L}" y2="${y.toFixed(1)}" stroke="#9ca3af" stroke-width="0.8"/>`;
    els += `<text x="${(PAD_L-6)}" y="${(y+3).toFixed(0)}" text-anchor="end" font-size="7" fill="#6b7280">${h}m</text>`;
  }
  // Y축 라벨
  const ymid = ((PAD_T + H - PAD_B) / 2).toFixed(0);
  els += `<text x="10" y="${ymid}" text-anchor="middle" font-size="7.5" fill="#374151" transform="rotate(-90 10 ${ymid})">높이(m)</text>`;

  // X축 눈금
  const xTicks = [0, 2, 4, 6, 8, 10, 15, 20].filter(d => d >= domainLeft && d <= domainRight);
  for (const d of xTicks) {
    const x = sx(d);
    const gy = sy(0);
    els += `<line x1="${x.toFixed(1)}" y1="${gy.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(gy+4).toFixed(0)}" stroke="#9ca3af" stroke-width="0.8"/>`;
    els += `<text x="${x.toFixed(0)}" y="${(gy+13).toFixed(0)}" text-anchor="middle" font-size="7" fill="#6b7280">${d}m</text>`;
  }
  els += `<text x="${((PAD_L + W - PAD_R)/2).toFixed(0)}" y="${(H-3)}" text-anchor="middle" font-size="7.5" fill="#374151">← 북 / 남 → (m)</text>`;

  // 북 화살표
  els += `<line x1="18" y1="${PAD_T+20}" x2="18" y2="${PAD_T+8}" stroke="#ef4444" stroke-width="1.8"/>`;
  els += `<polygon points="18,${PAD_T+8} 14,${PAD_T+16} 22,${PAD_T+16}" fill="#ef4444"/>`;
  els += `<text x="18" y="${PAD_T+30}" text-anchor="middle" font-size="8" font-weight="bold" fill="#ef4444">N</text>`;

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
  const 최대연면적cap = input.최대연면적 ?? input.대지면적 * (input.용적률 / 100);
  let 누적연면적 = 0;
  const floors = floorResults.map((r, i) => {
    const 남은용량 = 최대연면적cap - 누적연면적;
    const cappedArea = Math.max(0, Math.min(r.area, 남은용량));
    누적연면적 += cappedArea;
    return { floor: i + 1, area: parseFloat(cappedArea.toFixed(2)), svg: r.svg };
  });
  const gltfJson = buildHyparJson(input, 가로, 세로, 층고);
  const dxf      = buildDxf(input, 가로, 세로, 층고);

  const 연면적     = floors.reduce((s, f) => s + f.area, 0);
  const 건축면적실  = floors[0]?.area ?? 건축면적목표;

  // 단면도 데이터 (층별 northDist, bldgDepth)
  const floorMeta = floorResults.map(r => ({ northDist: r._northDist, bldgDepth: r._bldgDepth }));
  const f0 = floorResults[0];
  const parcelDepth = f0?._parcelDepth ?? Math.sqrt(input.대지면적);
  const roadOffset  = f0?._roadOffset  ?? 0;

  const northSectionSvg = buildNorthSectionSvg(
    input.층수, 층고, input.용도, input.용도지역,
    floorMeta, parcelDepth, roadOffset,
  );

  // 정북일조 영향층 (northDist가 1층보다 증가하기 시작하는 층)
  const 정북영향층 = floorResults.findIndex((r, i) => i > 0 && r._northDist > floorResults[0]._northDist + 0.1) + 1;

  // 주차대수
  const 주차대수 = calcParkingCount(input.용도, 연면적);

  const is공동주택 = ["아파트","연립주택","다세대주택","기숙사"].some(k => input.용도.includes(k));
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
      northSectionSvg,  // 단면도 SVG
    },
  });
}
