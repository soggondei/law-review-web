export type ObjPolygon = [number, number][];
export type ObjPolyline = [number, number][];

export type ObjGroup = {
  name: string;
  polygons?: ObjPolygon[];
  polylines?: ObjPolyline[];
  polylineWidth?: number;
};

type Point = [number, number];

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(4) : "0.0000";
}

function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emitVertex(lines: string[], point: Point) {
  lines.push(`v ${formatNumber(point[0])} ${formatNumber(point[1])} 0`);
}

function isUsablePoint(point: Point | undefined): point is Point {
  return !!point && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function sanitizePoints(points: Point[]) {
  return points.filter(isUsablePoint);
}

export function buildObj(
  groups: ObjGroup[],
  meta: { addr: string; radius: number }
): string {
  const lines: string[] = [
    `# Wavefront OBJ — ${meta.addr} — 생성: ${formatDate()} — 범위: ${meta.radius}m`,
  ];
  let vertexIndex = 1;

  for (const group of groups) {
    lines.push(`g ${group.name}`);

    for (const polygon of group.polygons ?? []) {
      const pts = sanitizePoints(polygon);
      if (pts.length < 3) continue;

      const start = vertexIndex;
      for (const point of pts) {
        emitVertex(lines, point);
        vertexIndex += 1;
      }

      for (let i = 1; i < pts.length - 1; i += 1) {
        lines.push(`f ${start} ${start + i} ${start + i + 1}`);
      }
    }

    const halfWidth = group.polylineWidth ?? 1.5;
    for (const polyline of group.polylines ?? []) {
      const pts = sanitizePoints(polyline);
      if (pts.length < 2) continue;

      for (let i = 0; i < pts.length - 1; i += 1) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.01) continue;

        const nx = (-dy / len) * halfWidth;
        const ny = (dx / len) * halfWidth;
        const quad: Point[] = [
          [p1[0] + nx, p1[1] + ny],
          [p1[0] - nx, p1[1] - ny],
          [p2[0] - nx, p2[1] - ny],
          [p2[0] + nx, p2[1] + ny],
        ];

        const start = vertexIndex;
        for (const point of quad) {
          emitVertex(lines, point);
          vertexIndex += 1;
        }
        lines.push(`f ${start} ${start + 1} ${start + 2}`);
        lines.push(`f ${start} ${start + 2} ${start + 3}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
