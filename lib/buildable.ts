import * as turf from "@turf/turf";

export interface BuildableResult {
  totalArea: number;     // 대지면적 ㎡
  buildableArea: number; // 이격 후 건축 가능 영역 ㎡
  utilization: number;   // buildableArea / totalArea (0~1)
}

function localToGeoJson(
  x: number,
  y: number,
  refLat: number,
  refLng: number,
): [number, number] {
  const lat = refLat + y / 111320;
  const lng = refLng + x / (111320 * Math.cos(refLat * (Math.PI / 180)));
  return [lng, lat]; // GeoJSON order
}

/**
 * 필지 로컬 좌표(m) → 법정이격 적용 후 건축 가능 면적 산정
 * @param localCoords  로컬 좌표 [x_m, y_m][] — 동=+x, 북=+y
 * @param refLat       기준 위도
 * @param refLng       기준 경도
 * @param northSetback 정북 이격 m (건축법 §86)
 * @param sideSetback  기타 방향 이격 m (기본 0.5m)
 */
export function calcBuildableArea(
  localCoords: [number, number][],
  refLat: number,
  refLng: number,
  northSetback: number,
  sideSetback = 0.5,
): BuildableResult {
  if (localCoords.length < 3) return { totalArea: 0, buildableArea: 0, utilization: 0 };

  const ring = [...localCoords];
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push(ring[0]);

  const geoRing = ring.map(([x, y]) => localToGeoJson(x, y, refLat, refLng));
  const parcel = turf.polygon([geoRing]);
  const totalArea = Math.round(turf.area(parcel) * 10) / 10;

  // 보수적 산정: 모든 방향에 max(northSetback, sideSetback) 적용
  const setback = Math.max(northSetback, sideSetback);
  const buffered = turf.buffer(parcel, -setback / 1000, { units: "kilometers" });

  if (!buffered) return { totalArea, buildableArea: 0, utilization: 0 };

  const buildableArea = Math.max(0, Math.round(turf.area(buffered) * 10) / 10);
  const utilization = totalArea > 0 ? Math.round((buildableArea / totalArea) * 1000) / 1000 : 0;

  return { totalArea, buildableArea, utilization };
}
