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

// ── 정북일조 이격거리 계산 (건축법 제61조·시행령 제86조) ─────────────────────
// 비공동주택: 층 상단 높이 기준 — h≤9m: 1.5m / h>9m: h/2
// 공동주택(아파트·연립·다세대·기숙사): 채광기준(제61조제2항) 별도 적용 → 0 반환
function calcNorthSetback(floorTopH: number, 용도: string): number {
  const is공동주택 = ["아파트","연립주택","다세대주택","기숙사"].some(k => 용도.includes(k));
  if (is공동주택) return 0;
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
    return parseVworldFeatures(data, toLocal).map(({ polygon, props }) => ({
      polygon,
      jimok: props.JIMOK ?? props.jimok ?? '',
      jibun: props.JIBUN ?? props.jibun ?? '',
    }));
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

// ── 층별 평면도 SVG — 법적 이격 기반 건축가능영역 ─────────────────────────────
function buildFloorSvg(
  floorIdx: number,
  input: LayoutInput,
  가로: number,
  세로: number,
  층고: number,
  parcelPts: [number, number][] | null,
  adjParcelsRaw: AdjacentParcel[] = [],
): { svg: string; area: number } {
  const W = 530, H = 360;
  const floorBottomH = floorIdx * 층고;
  const floorTopH    = (floorIdx + 1) * 층고;
  const northSetbackM = calcNorthSetback(floorTopH, input.용도);

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

  // 북측 인접 필지: 남단 bbox가 우리 필지 북단(parcelBox.maxY)에서 ±4m 이내이면서
  // X축 겹침이 있는 필지만 선택 (지적 오차 허용). 너무 멀리 있는 필지 제외.
  const parcelNS = parcelBox.maxY - parcelBox.minY; // 우리 필지 남북 폭
  const adjTol = Math.max(2, parcelNS * 0.08);       // 최소 2m, 필지 폭의 8% 허용
  const northAdj = adjParcels.filter(ap => {
    const ab = bboxOf(ap.polygon);
    const xOverlap = Math.min(ab.maxX, parcelBox.maxX) - Math.max(ab.minX, parcelBox.minX);
    // 필지 남단이 우리 필지 북단에 근접 (±adjTol)
    const southEdgeTouchesNorth = Math.abs(ab.minY - parcelBox.maxY) <= adjTol;
    return xOverlap > 0.5 && southEdgeTouchesNorth;
  });
  // 북측 도로 필지 (지목='도')
  const northRoad = northAdj.find(ap => ap.jimok === '도');
  // 정북 이격 기준선: 도로가 있으면 도로 반대편(북단) 경계, 없으면 우리 필지 북단
  const northRef = northRoad ? bboxOf(northRoad.polygon).maxY : parcelBox.maxY;

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

  // 정북일조 이격 적용
  // northRef = 우리 필지 북단(도로 없음) 또는 북측 도로 반대편 경계선
  const bldgNorthLimit = northRef - northSetbackM;
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
  // 필지가 (0,0) 중심. 드로잉 영역은 좌측 400px, 우측 130px = 이격거리 표
  // northAdj 폴리곤도 화면 안에 들어오도록 북쪽 extent 계산 (최대 20m)
  const PAD = 3;
  const northExtent = northAdj.length > 0
    ? Math.min(parcelBox.maxY + 20, Math.max(...northAdj.map(ap => bboxOf(ap.polygon).maxY)))
    : parcelBox.maxY;
  const dataW = parcelBox.maxX - parcelBox.minX + PAD * 2;
  const dataH = northExtent - parcelBox.minY + PAD * 2;
  const sc    = Math.min(240 / dataW, 230 / dataH);
  const SVG_CX = 200; // 드로잉 영역(0-400) 중앙
  // 데이터 중심을 드로잉 영역 중앙에 맞춤
  const drawingMidY = 44 + (H - 44 - 30) / 2;
  const dataCenterY = (northExtent + parcelBox.minY) / 2;
  const SVG_CY = drawingMidY + dataCenterY * sc;

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
  els += `<text x="200" y="16" text-anchor="middle" font-size="10.5" font-weight="bold" fill="#1e3a5f">${input.용도} · 대지 ${input.대지면적.toFixed(0)}㎡</text>`;

  // ① 북측 인접 필지 배경 (우리 필지보다 먼저 그려 아래에 깔림)
  for (const ap of northAdj) {
    const isRoad = ap.jimok === '도';
    const fill   = isRoad ? '#fef9c3' : '#f3f4f6';
    const stroke = isRoad ? '#ca8a04' : '#9ca3af';
    els += `<polygon points="${ptStr(ap.polygon)}" fill="${fill}" fill-opacity="0.7" stroke="${stroke}" stroke-width="1" stroke-dasharray="4,2"/>`;
    // 지목 라벨
    const ab = bboxOf(ap.polygon);
    const [lax, lay] = toSvg((ab.minX + ab.maxX) / 2, (ab.minY + ab.maxY) / 2);
    els += `<text x="${lax.toFixed(0)}" y="${lay.toFixed(0)}" text-anchor="middle" font-size="7" fill="${isRoad ? '#92400e' : '#6b7280'}">${isRoad ? '도로' : ap.jimok || '인접대지'}</text>`;
  }

  // ② 필지 경계 (이점쇄선)
  els += `<polygon points="${ptStr(parcel)}" fill="#fefce8" stroke="#a3a3a3" stroke-width="1.5" stroke-dasharray="12,3,2,3,2,3"/>`;

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
      els += `<polygon points="${ptStr(roadBands)}" fill="#fef9c3" fill-opacity="0.3" stroke="none"/>`;
    }
  }

  // ⑤ 건물 매스
  const bPts: [number,number][] = [[bMinX,bMinY],[bMaxX,bMinY],[bMaxX,bMaxY],[bMinX,bMaxY]];
  els += `<polygon points="${ptStr(bPts)}" fill="#3b82f6" fill-opacity="0.30" stroke="#2563eb" stroke-width="2"/>`;

  // ⑥ 건축가능영역 테두리 (건물 위)
  els += `<polygon points="${ptStr(buildableRect)}" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="5,3"/>`;

  // ⑦ 정북일조제한선 + 북측 기준경계선 + 치수선
  if (!is공동주택) {
    // 기준 경계선: northRef (도로 있으면 도로 북단, 없으면 우리 필지 북단)
    const [rx1, ry1] = toSvg(parcelBox.minX, northRef);
    const [rx2,    ] = toSvg(parcelBox.maxX, northRef);
    const refColor   = northRoad ? '#ca8a04' : '#b45309';
    const refLabel   = northRoad ? '도로 반대편 경계선 (기준)' : '인접대지경계선 (기준)';
    els += `<line x1="${rx1.toFixed(1)}" y1="${ry1.toFixed(1)}" x2="${rx2.toFixed(1)}" y2="${ry1.toFixed(1)}" stroke="${refColor}" stroke-width="2.2"/>`;
    els += `<text x="${((rx1+rx2)/2).toFixed(0)}" y="${(ry1-3).toFixed(0)}" text-anchor="middle" font-size="6.5" fill="${refColor}">${refLabel}</text>`;
    // 정북일조제한선 (bldgNorthLimit)
    if (bldgNorthLimit < parcelBox.maxY) {
      // Y값을 northAdj가 있어도 우리 필지 X 범위 내에서만 그림
      const [lx1, ly1] = toSvg(parcelBox.minX, bldgNorthLimit);
      const [lx2,    ] = toSvg(parcelBox.maxX, bldgNorthLimit);
      els += `<line x1="${lx1.toFixed(1)}" y1="${ly1.toFixed(1)}" x2="${lx2.toFixed(1)}" y2="${ly1.toFixed(1)}" stroke="#d97706" stroke-width="1.8"/>`;
      // 치수선 (왼쪽 바깥)
      const dimX = Math.max(8, rx1 - 12);
      els += `<line x1="${dimX}" y1="${ry1.toFixed(1)}" x2="${dimX}" y2="${ly1.toFixed(1)}" stroke="#d97706" stroke-width="0.8"/>`;
      els += `<line x1="${dimX-3}" y1="${ry1.toFixed(1)}" x2="${dimX+3}" y2="${ry1.toFixed(1)}" stroke="#d97706" stroke-width="0.8"/>`;
      els += `<line x1="${dimX-3}" y1="${ly1.toFixed(1)}" x2="${dimX+3}" y2="${ly1.toFixed(1)}" stroke="#d97706" stroke-width="0.8"/>`;
      const midDimY = ((ry1 + ly1) / 2 + 3).toFixed(0);
      els += `<text x="${dimX-4}" y="${midDimY}" text-anchor="end" font-size="7" fill="#b45309">${northSetbackM.toFixed(2)}m</text>`;
      // 라벨
      const labX = ((lx1 + lx2) / 2).toFixed(0);
      els += `<text x="${labX}" y="${(ly1-3).toFixed(0)}" text-anchor="middle" font-size="6.8" fill="#b45309">정북일조제한선 (h=${floorTopH.toFixed(1)}m→${northSetbackM.toFixed(2)}m)</text>`;
    }
  }

  // 필지 경계 재드로우 (인접 필지 위에 덮어 선명하게)
  els += `<polygon points="${ptStr(parcel)}" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="12,3,2,3,2,3"/>`;

  // 층·면적 라벨
  const [lcx, lcy] = toSvg(0, (bMinY + bMaxY) / 2);
  els += `<text x="${lcx.toFixed(0)}" y="${(lcy-7).toFixed(0)}" text-anchor="middle" font-size="18" font-weight="bold" fill="#1d4ed8">${floorIdx + 1}F</text>`;
  els += `<text x="${lcx.toFixed(0)}" y="${(lcy+12).toFixed(0)}" text-anchor="middle" font-size="12" fill="#1e3a5f">${area.toFixed(1)} ㎡</text>`;

  // EL 라벨
  const [elX, elY] = toSvg(0, bMaxY);
  els += `<text x="${elX.toFixed(0)}" y="${(elY-4).toFixed(0)}" text-anchor="middle" font-size="8.5" fill="#64748b">EL+${floorBottomH.toFixed(1)}m</text>`;

  // 범례 (드로잉 영역 우상단)
  const LX = 298, LY = 20;
  const legend = [
    { fill: '#fefce8', stroke: '#a3a3a3', dash: '12,3,2,3,2,3', label: '대지 경계선' },
    { fill: '#eff6ff', stroke: '#93c5fd', dash: '3,2', label: `건축가능영역 (${BASE_SB}m 이격)` },
    ...(!is공동주택 ? [{ fill: '#fef3c7', stroke: '#d97706', dash: '4,2', label: '정북일조 이격대' }] : []),
    ...(northAdj.length > 0 && !northAdj.every(a => a.jimok === '도')
      ? [{ fill: '#f3f4f6', stroke: '#9ca3af', dash: '4,2', label: '인접대지' }] : []),
    ...(northRoad
      ? [{ fill: '#fef9c3', stroke: '#ca8a04', dash: '4,2', label: '북측도로 (이격 완화)' }] : []),
    ...(needsParking   ? [{ fill: '#f1f5f9', stroke: '#94a3b8', dash: '', label: '주차 계획영역' }] : []),
    ...(needsLandscape ? [{ fill: '#d1fae5', stroke: '#6ee7b7', dash: '', label: `조경 ${landscapeArea.toFixed(0)}㎡` }] : []),
  ];
  legend.forEach(({ fill, stroke, dash, label }, i) => {
    const y = LY + i * 13;
    els += `<rect x="${LX}" y="${y}" width="9" height="9" fill="${fill}" stroke="${stroke}" stroke-width="0.8" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
    els += `<text x="${LX+13}" y="${y+7}" font-size="7" fill="#374151">${label}</text>`;
  });

  // 북 화살표
  els += `<line x1="18" y1="68" x2="18" y2="52" stroke="#ef4444" stroke-width="2"/>`;
  els += `<polygon points="18,52 14,60 22,60" fill="#ef4444"/>`;
  els += `<text x="18" y="78" text-anchor="middle" font-size="9" font-weight="bold" fill="#ef4444">N</text>`;

  // 치수선 — 가로 (건물 폭)
  const [bbl_x, bbl_y] = toSvg(bMinX, bMinY);
  const [bbr_x, bbr_y] = toSvg(bMaxX, bMinY);
  const dY = Math.max(bbl_y, bbr_y) + 9;
  els += `<line x1="${bbl_x.toFixed(1)}" y1="${dY}" x2="${bbr_x.toFixed(1)}" y2="${dY}" stroke="#94a3b8" stroke-width="0.8"/>`;
  els += `<line x1="${bbl_x.toFixed(1)}" y1="${dY-3}" x2="${bbl_x.toFixed(1)}" y2="${dY+3}" stroke="#94a3b8" stroke-width="0.8"/>`;
  els += `<line x1="${bbr_x.toFixed(1)}" y1="${dY-3}" x2="${bbr_x.toFixed(1)}" y2="${dY+3}" stroke="#94a3b8" stroke-width="0.8"/>`;
  els += `<text x="${((bbl_x+bbr_x)/2).toFixed(0)}" y="${dY+10}" text-anchor="middle" font-size="8.5" fill="#64748b">${fW.toFixed(1)}m</text>`;

  // 치수선 — 세로 (건물 깊이)
  const [btr_x, btr_y] = toSvg(bMaxX, bMaxY);
  const [bbr2_x, bbr2_y] = toSvg(bMaxX, bMinY);
  const dX = Math.max(btr_x, bbr2_x) + 9;
  els += `<line x1="${dX}" y1="${btr_y.toFixed(1)}" x2="${dX}" y2="${bbr2_y.toFixed(1)}" stroke="#94a3b8" stroke-width="0.8"/>`;
  els += `<line x1="${dX-3}" y1="${btr_y.toFixed(1)}" x2="${dX+3}" y2="${btr_y.toFixed(1)}" stroke="#94a3b8" stroke-width="0.8"/>`;
  els += `<line x1="${dX-3}" y1="${bbr2_y.toFixed(1)}" x2="${dX+3}" y2="${bbr2_y.toFixed(1)}" stroke="#94a3b8" stroke-width="0.8"/>`;
  els += `<text x="${dX+4}" y="${((btr_y+bbr2_y)/2+3).toFixed(0)}" font-size="8.5" fill="#64748b">${fH.toFixed(1)}m</text>`;

  // ── 우측 패널: 정북일조 이격거리 표 ───────────────────────────────────────
  els += `<line x1="402" y1="14" x2="402" y2="${H-8}" stroke="#e2e8f0" stroke-width="0.8"/>`;
  const TBX = 407;
  let ty = 22;

  if (is공동주택) {
    els += `<text x="${TBX}" y="${ty}" font-size="8" font-weight="bold" fill="#1e3a5f">■ 채광기준 적용</text>`;
    ty += 11;
    els += `<text x="${TBX}" y="${ty}" font-size="6.5" fill="#6b7280">건축법 제61조 제2항</text>`;
    ty += 14;
    els += `<rect x="${TBX}" y="${ty}" width="116" height="42" fill="#fff7ed" rx="2" stroke="#fed7aa" stroke-width="0.5"/>`;
    ty += 12;
    els += `<text x="${TBX+5}" y="${ty}" font-size="7" fill="#92400e">공동주택: 채광기준 별도 적용</text>`;
    ty += 10;
    els += `<text x="${TBX+5}" y="${ty}" font-size="7" fill="#92400e">정북일조 사선 미적용</text>`;
    ty += 10;
    els += `<text x="${TBX+5}" y="${ty}" font-size="7" fill="#92400e">인동간격 별도 검토 요</text>`;
  } else {
    els += `<text x="${TBX}" y="${ty}" font-size="8" font-weight="bold" fill="#1e3a5f">■ 정북일조 이격거리</text>`;
    ty += 11;
    els += `<text x="${TBX}" y="${ty}" font-size="6.5" fill="#6b7280">건축법시행령 제86조 제1항</text>`;
    ty += 12;
    // 표 헤더
    els += `<rect x="${TBX}" y="${ty-8}" width="116" height="11" fill="#dbeafe" rx="1"/>`;
    els += `<text x="${TBX+13}" y="${ty}" text-anchor="middle" font-size="6.5" font-weight="bold" fill="#1e40af">층</text>`;
    els += `<text x="${TBX+56}" y="${ty}" text-anchor="middle" font-size="6.5" font-weight="bold" fill="#1e40af">층상단높이</text>`;
    els += `<text x="${TBX+100}" y="${ty}" text-anchor="middle" font-size="6.5" font-weight="bold" fill="#1e40af">이격거리</text>`;
    ty += 12;
    for (let fi = 0; fi < Math.min(input.층수, 10); fi++) {
      const topH = (fi + 1) * 층고;
      const sb   = topH <= 9 ? 1.5 : topH / 2;
      const isCurrent = fi === floorIdx;
      if (isCurrent) {
        els += `<rect x="${TBX}" y="${ty-8}" width="116" height="11" fill="#eff6ff" rx="0"/>`;
      }
      const txtFill = isCurrent ? "#1d4ed8" : (sb > 1.5 ? "#b45309" : "#374151");
      const fw = isCurrent ? "bold" : "normal";
      els += `<text x="${TBX+13}" y="${ty}" text-anchor="middle" font-size="6.5" fill="${txtFill}" font-weight="${fw}">${fi+1}F</text>`;
      els += `<text x="${TBX+56}" y="${ty}" text-anchor="middle" font-size="6.5" fill="${txtFill}">${topH.toFixed(1)}m</text>`;
      els += `<text x="${TBX+100}" y="${ty}" text-anchor="middle" font-size="6.5" fill="${txtFill}" font-weight="${fw}">${sb.toFixed(2)}m</text>`;
      ty += 11;
      if (fi < input.층수 - 1 && fi < 9) {
        els += `<line x1="${TBX}" y1="${ty-2}" x2="${TBX+116}" y2="${ty-2}" stroke="#e2e8f0" stroke-width="0.3"/>`;
      }
    }
    ty += 5;
    els += `<line x1="${TBX}" y1="${ty}" x2="${TBX+116}" y2="${ty}" stroke="#e2e8f0" stroke-width="0.5"/>`;
    ty += 9;
    els += `<text x="${TBX}" y="${ty}" font-size="6" fill="#6b7280">* 9m 이하: 1.5m 이상</text>`;
    ty += 8;
    els += `<text x="${TBX}" y="${ty}" font-size="6" fill="#6b7280">* 9m 초과: 높이×1/2</text>`;
    ty += 8;
    if (northRoad) {
      const roadW = (bboxOf(northRoad.polygon).maxY - bboxOf(northRoad.polygon).minY).toFixed(1);
      els += `<rect x="${TBX}" y="${ty+2}" width="116" height="20" fill="#fef3c7" rx="1" stroke="#d97706" stroke-width="0.5"/>`;
      ty += 10;
      els += `<text x="${TBX+3}" y="${ty}" font-size="6" fill="#92400e">★ 북측 도로 감지 (약 ${roadW}m)</text>`;
      ty += 9;
      els += `<text x="${TBX+3}" y="${ty}" font-size="6" fill="#92400e">  기준: 도로 반대편 경계선</text>`;
    } else {
      els += `<text x="${TBX}" y="${ty}" font-size="6" fill="#6b7280">* 북측 도로시: 반대편</text>`;
      ty += 8;
      els += `<text x="${TBX}" y="${ty}" font-size="6" fill="#6b7280">  경계선 기준 (도로 완화)</text>`;
    }
  }

  // 푸터
  els += `<text x="200" y="${H-14}" text-anchor="middle" font-size="8" fill="#9ca3af">대지안의 공지 ${BASE_SB}m · 건폐율 ${input.건폐율}% · 용적률 ${input.용적률}%</text>`;
  els += `<text x="200" y="${H-3}" text-anchor="middle" font-size="8" fill="#9ca3af">층고 ${층고.toFixed(1)}m · 총높이 ${(input.층수*층고).toFixed(1)}m</text>`;

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="auto" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
  <rect width="${W}" height="${H}" fill="#f8fafc"/>
  ${els}
</svg>`,
    area,
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

export async function POST(req: NextRequest) {
  const input: LayoutInput = await req.json();
  if (!input.대지면적 || !input.건폐율 || !input.층수) {
    return NextResponse.json({ error: "대지면적·건폐율·층수가 필요합니다." }, { status: 400 });
  }

  const 건축면적 = input.대지면적 * (input.건폐율 / 100);
  const 가로 = input.대지가로 && input.대지가로 > 0 ? input.대지가로 : Math.sqrt(건축면적);
  const 세로 = input.대지세로 && input.대지세로 > 0 ? input.대지세로 : 건축면적 / 가로;
  const 층고  = input.용도.includes("주거") || input.용도.includes("아파트") ? 2.9 : 3.3;

  // 실제 필지 폴리곤 + 인접 필지 조회 (lat/lng가 있는 경우)
  const [parcelPts, adjParcels] = (input.lat && input.lng)
    ? await Promise.all([
        fetchTargetParcel(input.lat, input.lng),
        fetchAdjacentParcels(input.lat, input.lng),
      ])
    : [null, [] as AdjacentParcel[]];

  const floors = Array.from({ length: input.층수 }, (_, i) => {
    const { svg, area } = buildFloorSvg(i, input, 가로, 세로, 층고, parcelPts, adjParcels);
    return { floor: i + 1, area, svg };
  });
  const gltfJson  = buildHyparJson(input, 가로, 세로, 층고);
  const dxf       = buildDxf(input, 가로, 세로, 층고);

  const 연면적 = floors.reduce((s, f) => s + f.area, 0);

  return NextResponse.json({
    floors,
    gltfJson,
    dxf,
    stats: {
      건축면적:  Math.round(건축면적 * 10) / 10,
      연면적:    Math.round(연면적 * 10) / 10,
      층수:      input.층수,
      층고,
      총높이:    Math.round(input.층수 * 층고 * 10) / 10,
    },
  });
}
