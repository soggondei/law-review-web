export type DaeBuilding = {
  pts: [number, number][];
  height: number;
};

export type DaePolygon = {
  pts: [number, number][];
};

export type DaePolyline = {
  pts: [number, number][];
  width: number;
};

export type DaeInput = {
  buildings: DaeBuilding[];
  parcels: DaePolygon[];
  roads: DaePolyline[];
  sidewalks: DaePolyline[];
  addr: string;
  radius: number;
};

type Point2 = [number, number];
type Point3 = [number, number, number];
type Geometry = {
  name: string;
  positions: Point3[];
  triangles: [number, number, number][];
};

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(4) : "0.0000";
}

function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isUsablePoint(point: Point2 | undefined): point is Point2 {
  return !!point && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function sanitizePoints(points: Point2[]) {
  return points.filter(isUsablePoint);
}

function signedArea(points: Point2[]) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function asCounterClockwise(points: Point2[]) {
  return signedArea(points) >= 0 ? points : [...points].reverse();
}

function addVertex(geometry: Geometry, point: Point3) {
  geometry.positions.push(point);
  return geometry.positions.length - 1;
}

function addFan(geometry: Geometry, points: Point2[], z: number, clockwise: boolean) {
  if (points.length < 3) return;
  const ccw = asCounterClockwise(points);
  const ordered = clockwise ? [...ccw].reverse() : ccw;
  const start = geometry.positions.length;

  for (const [x, y] of ordered) {
    addVertex(geometry, [x, y, z]);
  }

  for (let i = 1; i < ordered.length - 1; i += 1) {
    geometry.triangles.push([start, start + i, start + i + 1]);
  }
}

function addBuilding(geometry: Geometry, building: DaeBuilding) {
  const pts = sanitizePoints(building.pts);
  const height = building.height;
  if (pts.length < 3 || !Number.isFinite(height) || height <= 0) return;

  const ccw = asCounterClockwise(pts);
  addFan(geometry, ccw, 0, true);
  addFan(geometry, ccw, height, false);

  for (let i = 0; i < ccw.length; i += 1) {
    const current = ccw[i];
    const next = ccw[(i + 1) % ccw.length];
    const v0 = addVertex(geometry, [current[0], current[1], 0]);
    const v1 = addVertex(geometry, [next[0], next[1], 0]);
    const v2 = addVertex(geometry, [next[0], next[1], height]);
    const v3 = addVertex(geometry, [current[0], current[1], height]);
    geometry.triangles.push([v0, v1, v2]);
    geometry.triangles.push([v0, v2, v3]);
  }
}

function addFlatPolygon(geometry: Geometry, polygon: DaePolygon) {
  const pts = sanitizePoints(polygon.pts);
  if (pts.length < 3) return;
  addFan(geometry, pts, 0, false);
}

function addPolylineStrip(geometry: Geometry, polyline: DaePolyline) {
  const pts = sanitizePoints(polyline.pts);
  const width = polyline.width;
  if (pts.length < 2 || !Number.isFinite(width) || width <= 0) return;

  const halfWidth = width / 2;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;

    const nx = (-dy / len) * halfWidth;
    const ny = (dx / len) * halfWidth;
    const v0 = addVertex(geometry, [p1[0] + nx, p1[1] + ny, 0]);
    const v1 = addVertex(geometry, [p1[0] - nx, p1[1] - ny, 0]);
    const v2 = addVertex(geometry, [p2[0] - nx, p2[1] - ny, 0]);
    const v3 = addVertex(geometry, [p2[0] + nx, p2[1] + ny, 0]);
    geometry.triangles.push([v0, v1, v2]);
    geometry.triangles.push([v0, v2, v3]);
  }
}

function createGeometry(name: string) {
  return { name, positions: [], triangles: [] };
}

function geometryXml(geometry: Geometry) {
  const id = `geo-${geometry.name}`;
  const positions = geometry.positions
    .flatMap(([x, y, z]) => [formatNumber(x), formatNumber(y), formatNumber(z)])
    .join(" ");
  const triangles = geometry.triangles.flatMap((tri) => tri).join(" ");

  return [
    `    <geometry id="${id}" name="${geometry.name}">`,
    "      <mesh>",
    `        <source id="${id}-pos">`,
    `          <float_array id="${id}-pos-arr" count="${geometry.positions.length * 3}">${positions}</float_array>`,
    "          <technique_common>",
    `            <accessor source="#${id}-pos-arr" count="${geometry.positions.length}" stride="3">`,
    '              <param name="X" type="float"/>',
    '              <param name="Y" type="float"/>',
    '              <param name="Z" type="float"/>',
    "            </accessor>",
    "          </technique_common>",
    "        </source>",
    `        <vertices id="${id}-vtx">`,
    `          <input semantic="POSITION" source="#${id}-pos"/>`,
    "        </vertices>",
    `        <triangles count="${geometry.triangles.length}">`,
    `          <input semantic="VERTEX" source="#${id}-vtx" offset="0"/>`,
    `          <p>${triangles}</p>`,
    "        </triangles>",
    "      </mesh>",
    "    </geometry>",
  ].join("\n");
}

function nodeXml(geometry: Geometry) {
  return [
    `      <node id="${geometry.name}" name="${geometry.name}" type="NODE">`,
    `        <instance_geometry url="#geo-${geometry.name}"/>`,
    "      </node>",
  ].join("\n");
}

function buildGeometries(input: DaeInput) {
  const buildings = createGeometry("BUILDINGS");
  for (const building of input.buildings) addBuilding(buildings, building);

  const parcels = createGeometry("PARCELS");
  for (const parcel of input.parcels) addFlatPolygon(parcels, parcel);

  const roads = createGeometry("ROADS");
  for (const road of input.roads) addPolylineStrip(roads, road);

  const sidewalks = createGeometry("SIDEWALK");
  for (const sidewalk of input.sidewalks) addPolylineStrip(sidewalks, sidewalk);

  return [buildings, parcels, roads, sidewalks].filter(
    (geometry) => geometry.triangles.length > 0
  );
}

export function buildDae(input: DaeInput): string {
  const geometries = buildGeometries(input);
  const geometrySection = geometries.map(geometryXml).join("\n");
  const nodeSection = geometries.map(nodeXml).join("\n");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">',
    "  <asset>",
    `    <created>${formatDate()}</created>`,
    `    <keywords>${escapeXml(input.addr)} radius ${formatNumber(input.radius)}m</keywords>`,
    '    <unit name="meter" meter="1"/>',
    "    <up_axis>Z_UP</up_axis>",
    "  </asset>",
    "  <library_geometries>",
    geometrySection,
    "  </library_geometries>",
    "  <library_visual_scenes>",
    '    <visual_scene id="Scene" name="Scene">',
    nodeSection,
    "    </visual_scene>",
    "  </library_visual_scenes>",
    "  <scene>",
    '    <instance_visual_scene url="#Scene"/>',
    "  </scene>",
    "</COLLADA>",
    "",
  ].join("\n");
}
