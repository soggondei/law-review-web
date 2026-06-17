export type MassPoint = [number, number];

export type MassFootprintResult = {
  footprint: MassPoint[];
  requestedArea: number;
  actualArea: number;
  fitsRequestedArea: boolean;
  clearance: number;
  edgeClearances: number[];
};

export type MassRoad = {
  coords: MassPoint[];
  width?: number;
};

const EPS = 1e-7;

function isFinitePoint(point: MassPoint | undefined): point is MassPoint {
  return !!point && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

export function sanitizePolygon(points: MassPoint[]): MassPoint[] {
  const cleaned = points.filter(isFinitePoint);
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first[0] - last[0]) < EPS && Math.abs(first[1] - last[1]) < EPS) {
      cleaned.pop();
    }
  }
  return cleaned;
}

export function polygonArea(points: MassPoint[]): number {
  const pts = sanitizePolygon(points);
  let area = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

function signedArea(points: MassPoint[]): number {
  const pts = sanitizePolygon(points);
  let area = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return area / 2;
}

export function bboxOf(points: MassPoint[]) {
  const pts = sanitizePolygon(points);
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}

function pointOnSegment(point: MassPoint, a: MassPoint, b: MassPoint): boolean {
  const cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > EPS) return false;
  const dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]);
  if (dot < -EPS) return false;
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot <= lenSq + EPS;
}

export function pointInPolygon(point: MassPoint, polygon: MassPoint[]): boolean {
  const pts = sanitizePolygon(polygon);
  if (pts.length < 3) return false;

  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    if (pointOnSegment(point, pts[j], pts[i])) return true;
    const yi = pts[i][1];
    const yj = pts[j][1];
    const crosses = yi > point[1] !== yj > point[1];
    if (!crosses) continue;
    const xAtY = ((pts[j][0] - pts[i][0]) * (point[1] - yi)) / (yj - yi) + pts[i][0];
    if (point[0] < xAtY) inside = !inside;
  }
  return inside;
}

function orientation(a: MassPoint, b: MassPoint, c: MassPoint): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < EPS) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(a1: MassPoint, a2: MassPoint, b1: MassPoint, b2: MassPoint): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && pointOnSegment(b1, a1, a2)) return true;
  if (o2 === 0 && pointOnSegment(b2, a1, a2)) return true;
  if (o3 === 0 && pointOnSegment(a1, b1, b2)) return true;
  if (o4 === 0 && pointOnSegment(a2, b1, b2)) return true;
  return false;
}

export function distancePointToSegment(point: MassPoint, a: MassPoint, b: MassPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return Math.hypot(point[0] - x, point[1] - y);
}

function nearestBoundary(point: MassPoint, polygon: MassPoint[]): { distance: number; edgeIndex: number } {
  const pts = sanitizePolygon(polygon);
  let min = Infinity;
  let edgeIndex = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const distance = distancePointToSegment(point, pts[i], pts[(i + 1) % pts.length]);
    if (distance < min) {
      min = distance;
      edgeIndex = i;
    }
  }
  return { distance: min, edgeIndex };
}

function hasRequiredClearance(point: MassPoint, container: MassPoint[], edgeClearances: number[]): boolean {
  const nearest = nearestBoundary(point, container);
  const required = edgeClearances[nearest.edgeIndex] ?? 0;
  return nearest.distance >= required - EPS;
}

function polygonInsidePolygon(candidate: MassPoint[], container: MassPoint[], edgeClearances: number[]): boolean {
  const subject = sanitizePolygon(candidate);
  const clip = sanitizePolygon(container);
  if (subject.length < 3 || clip.length < 3) return false;

  for (const point of subject) {
    if (!pointInPolygon(point, clip)) return false;
    if (!hasRequiredClearance(point, clip, edgeClearances)) return false;
  }

  for (let i = 0; i < subject.length; i += 1) {
    const a1 = subject[i];
    const a2 = subject[(i + 1) % subject.length];
    const mid: MassPoint = [(a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2];
    if (!pointInPolygon(mid, clip)) return false;
    if (!hasRequiredClearance(mid, clip, edgeClearances)) return false;

    for (let j = 0; j < clip.length; j += 1) {
      if (segmentsIntersect(a1, a2, clip[j], clip[(j + 1) % clip.length])) return false;
    }
  }

  return true;
}

function rectangleFromCenter(center: MassPoint, halfW: number, halfH: number): MassPoint[] {
  const [x, y] = center;
  return [
    [x - halfW, y - halfH],
    [x + halfW, y - halfH],
    [x + halfW, y + halfH],
    [x - halfW, y + halfH],
  ];
}

function maxRectangleScale(
  site: MassPoint[],
  center: MassPoint,
  halfW: number,
  halfH: number,
  edgeClearances: number[]
): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i += 1) {
    const mid = (lo + hi) / 2;
    const rect = rectangleFromCenter(center, halfW * mid, halfH * mid);
    if (polygonInsidePolygon(rect, site, edgeClearances)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function distancePointToPolyline(point: MassPoint, polyline: MassPoint[]): number {
  const pts = sanitizePolygon(polyline);
  if (pts.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) {
    min = Math.min(min, distancePointToSegment(point, pts[i], pts[i + 1]));
  }
  return min;
}

function distanceSegmentToPolyline(a: MassPoint, b: MassPoint, polyline: MassPoint[]): number {
  const pts = sanitizePolygon(polyline);
  if (pts.length < 2) return Infinity;
  const mid: MassPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let min = distancePointToPolyline(mid, pts);
  for (let i = 0; i < pts.length - 1; i += 1) {
    if (segmentsIntersect(a, b, pts[i], pts[i + 1])) return 0;
    min = Math.min(
      min,
      distancePointToSegment(a, pts[i], pts[i + 1]),
      distancePointToSegment(b, pts[i], pts[i + 1]),
      distancePointToSegment(pts[i], a, b),
      distancePointToSegment(pts[i + 1], a, b)
    );
  }
  return min;
}

export function createSetbackEdgeClearances(
  sitePolygon: MassPoint[],
  roads: MassRoad[],
  setbacks: { buildingLine: number; adjacent: number }
): number[] {
  const site = sanitizePolygon(sitePolygon);
  const buildingLine = Math.max(0, setbacks.buildingLine || 0);
  const adjacent = Math.max(0, setbacks.adjacent || 0);
  if (site.length < 3) return [];

  return site.map((point, index) => {
    const next = site[(index + 1) % site.length];
    const touchesRoad = roads.some((road) => {
      const width = Math.max(road.width ?? 3, 1);
      const threshold = Math.max(width / 2 + 2, buildingLine + 3, 5);
      return distanceSegmentToPolyline(point, next, road.coords) <= threshold;
    });
    return touchesRoad ? buildingLine : adjacent;
  });
}

function centroid(points: MassPoint[]): MassPoint {
  const pts = sanitizePolygon(points);
  if (!pts.length) return [0, 0];
  return [
    pts.reduce((sum, point) => sum + point[0], 0) / pts.length,
    pts.reduce((sum, point) => sum + point[1], 0) / pts.length,
  ];
}

export function createSafeMassFootprint(
  sitePolygon: MassPoint[],
  requestedArea: number,
  options: { minClearance?: number; edgeClearances?: number[]; gridSteps?: number } = {}
): MassFootprintResult {
  const site = sanitizePolygon(sitePolygon);
  const siteArea = polygonArea(site);
  const targetArea = Math.max(1, Math.min(requestedArea || siteArea * 0.7, siteArea * 0.98));
  const minClearance = Math.max(0, options.minClearance ?? 0);
  const edgeClearances = site.map((_, index) =>
    Math.max(0, options.edgeClearances?.[index] ?? minClearance)
  );
  const gridSteps = Math.max(5, options.gridSteps ?? 17);

  if (site.length < 3 || siteArea <= 0) {
    return {
      footprint: [],
      requestedArea: targetArea,
      actualArea: 0,
      fitsRequestedArea: false,
      clearance: minClearance,
      edgeClearances,
    };
  }

  const bb = bboxOf(site);
  const width = Math.max(bb.maxX - bb.minX, 1);
  const depth = Math.max(bb.maxY - bb.minY, 1);
  const ratio = Math.min(2.5, Math.max(0.4, width / depth));
  const desiredW = Math.sqrt(targetArea * ratio);
  const desiredH = Math.sqrt(targetArea / ratio);
  const halfW = desiredW / 2;
  const halfH = desiredH / 2;

  const candidates: MassPoint[] = [centroid(site)];
  for (let ix = 0; ix < gridSteps; ix += 1) {
    for (let iy = 0; iy < gridSteps; iy += 1) {
      candidates.push([
        bb.minX + (width * (ix + 0.5)) / gridSteps,
        bb.minY + (depth * (iy + 0.5)) / gridSteps,
      ]);
    }
  }

  let best: MassPoint[] = [];
  let bestArea = 0;

  for (const center of candidates) {
    if (!pointInPolygon(center, site)) continue;
    if (!hasRequiredClearance(center, site, edgeClearances)) continue;
    const scale = maxRectangleScale(site, center, halfW, halfH, edgeClearances);
    if (scale <= 0.02) continue;
    const rect = rectangleFromCenter(center, halfW * scale, halfH * scale);
    const area = polygonArea(rect);
    if (area > bestArea) {
      best = rect;
      bestArea = area;
    }
  }

  if (!best.length) {
    const fallback = sanitizePolygon(signedArea(site) < 0 ? [...site].reverse() : site);
    return {
      footprint: fallback,
      requestedArea: targetArea,
      actualArea: siteArea,
      fitsRequestedArea: siteArea >= targetArea,
      clearance: minClearance,
      edgeClearances,
    };
  }

  return {
    footprint: best,
    requestedArea: targetArea,
    actualArea: bestArea,
    fitsRequestedArea: bestArea >= targetArea * 0.995,
    clearance: minClearance,
    edgeClearances,
  };
}
