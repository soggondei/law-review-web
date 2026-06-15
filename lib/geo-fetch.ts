import https from "https";

// ── Overpass API ──────────────────────────────────────────────────────────────

const OVERPASS_HOSTS = [
  "overpass-api.de",
  "overpass.kumi.systems",
  "z.overpass-api.de",
];

function httpsPost(host: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path: "/api/interpreter",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "law-review-web/1.0 (contact:soggon@naver.com)",
          "Accept": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400)
            reject(new Error(`Overpass ${res.statusCode}`));
          else resolve(Buffer.concat(chunks).toString("utf-8"));
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

/** Overpass QL POST with automatic host fallback */
export async function overpassQuery(body: string): Promise<string> {
  let last: Error | null = null;
  for (const host of OVERPASS_HOSTS) {
    try { return await httpsPost(host, body); }
    catch (e: unknown) { last = e instanceof Error ? e : new Error(String(e)); }
  }
  throw last ?? new Error("Overpass unreachable");
}

// ── Vworld WFS ────────────────────────────────────────────────────────────────

/** Build URLSearchParams for Vworld LP_PA_CBND_BUBUN (parcel boundary) WFS request */
export function vworldParcelParams(
  lng: number, lat: number, dLng: number, dLat: number, radius: number,
): URLSearchParams {
  const size = radius <= 30 ? 50 : radius <= 50 ? 100 : 200;
  return new URLSearchParams({
    service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN",
    key: process.env.LURIS_KEY!, domain: "localhost",
    size: String(size), page: "1",
    geomFilter: `BOX(${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat})`,
    crs: "EPSG:4326", format: "json",
  });
}

/** Parse Vworld parcel GeoJSON into local-coordinate polygon rings.
 *  Closing duplicate vertex is removed; rings with < 3 points are dropped. */
export function parseVworldRings(
  vwData: unknown,
  toLocal: (pt: number[]) => [number, number],
): [number, number][][] {
  const data = vwData as { response?: { result?: { featureCollection?: { features?: unknown[] } } } };
  const features = data?.response?.result?.featureCollection?.features ?? [];
  const rings: [number, number][][] = [];

  for (const f of features as Array<{ geometry?: { type?: string; coordinates?: unknown } }>) {
    const geom = f.geometry;
    if (!geom) continue;
    const rawRings: number[][][] =
      geom.type === "Polygon" ? (geom.coordinates as number[][][])
      : geom.type === "MultiPolygon" ? (geom.coordinates as number[][][][]).flat()
      : [];

    for (const ring of rawRings) {
      const pts = ring.map(toLocal);
      if (pts.length > 1) {
        const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
        if (Math.abs(fx - lx) < 1e-6 && Math.abs(fy - ly) < 1e-6) pts.pop();
      }
      if (pts.length >= 3) rings.push(pts);
    }
  }
  return rings;
}

// ── Open-Elevation (SRTM) with Open-Topo-Data fallback ───────────────────────

export const GEO_GRID_N = 5;

type LatLng = { latitude: number; longitude: number };

async function tryOpenElevation(locations: LatLng[]): Promise<number[] | null> {
  try {
    const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ locations }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { results?: { elevation: number }[] };
    const results = json.results ?? [];
    if (results.length !== locations.length) return null;
    return results.map((x) => x.elevation);
  } catch { return null; }
}

async function tryOpenTopoData(locations: LatLng[]): Promise<number[] | null> {
  try {
    // Open-Topo-Data: max 100 points per request, SRTM30m dataset
    const locStr = locations.map(l => `${l.latitude},${l.longitude}`).join("|");
    const res = await fetch(
      `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locStr)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { results?: { elevation: number | null }[] };
    const results = json.results ?? [];
    if (results.length !== locations.length) return null;
    return results.map((x) => x.elevation ?? 0);
  } catch { return null; }
}

/** Fetch a GEO_GRID_N × GEO_GRID_N elevation grid centered on (lat, lng).
 *  Tries Open-Elevation first, falls back to Open-Topo-Data.
 *  Returns null only if both sources fail. */
export async function fetchElevGrid(
  lat: number, lng: number, dLat: number, dLng: number,
): Promise<number[][] | null> {
  const N = GEO_GRID_N;
  const locations: LatLng[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      locations.push({
        latitude:  lat + dLat * ((2 * r) / (N - 1) - 1),
        longitude: lng + dLng * ((2 * c) / (N - 1) - 1),
      });
    }
  }

  const elevations = (await tryOpenElevation(locations)) ?? (await tryOpenTopoData(locations));
  if (!elevations) return null;

  const grid: number[][] = [];
  for (let r = 0; r < N; r++) {
    grid.push(elevations.slice(r * N, (r + 1) * N));
  }
  return grid;
}

/** Bilinear interpolation on a 2D grid at fractional row/column position */
export function bilinear(grid: number[][], r: number, c: number): number {
  const rows = grid.length, cols = grid[0].length;
  const r0 = Math.max(0, Math.min(rows - 2, Math.floor(r)));
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(c)));
  const dr = r - r0, dc = c - c0;
  return (
    grid[r0][c0]         * (1 - dr) * (1 - dc) +
    grid[r0][c0 + 1]     * (1 - dr) * dc +
    grid[r0 + 1][c0]     * dr       * (1 - dc) +
    grid[r0 + 1][c0 + 1] * dr       * dc
  );
}
