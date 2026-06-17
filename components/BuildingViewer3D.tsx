"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls, Html, Line, ContactShadows, Sky, Edges } from "@react-three/drei";
import * as THREE from "three";
import { useMemo, useRef, useEffect, useState } from "react";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { createSafeMassFootprint, createSetbackEdgeClearances } from "@/lib/mass-study";

export interface ContextBuilding { coords: [number, number][]; height: number; }
export interface ContextRoad    { coords: [number, number][]; width: number; }
export interface SurroundingContext {
  buildings: ContextBuilding[];
  roads:     ContextRoad[];
}

export interface BuildingViewer3DProps {
  localCoords: [number, number][];
  건축면적: number;
  층수: number;
  대지면적: number;
  bboxAspect: number;
  setbackMeters?: number;
  setbackRules?: {
    buildingLine: number;
    adjacent: number;
  };
  surroundings?: SurroundingContext;
  zoneName?: string;
  lat?: number;
  lng?: number;
}

const FLOOR_H = 3.3;
const ROT_X   = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

// ── 정북일조 적용 여부
function isSunZone(z?: string) {
  return !!z && /전용주거|일반주거|주거지역/.test(z);
}

// ── 유틸 ────────────────────────────────────────────────────────
function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}
// Sutherland-Hodgman: 북측(y > maxY) 부분 클리핑
function clipNorth(pts: [number, number][], maxY: number): [number, number][] {
  const out: [number, number][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const cur = pts[i], nxt = pts[(i + 1) % n];
    const cIn = cur[1] <= maxY, nIn = nxt[1] <= maxY;
    if (cIn) out.push(cur);
    if (cIn !== nIn) {
      const t = (maxY - cur[1]) / (nxt[1] - cur[1]);
      out.push([cur[0] + t * (nxt[0] - cur[0]), maxY]);
    }
  }
  return out;
}
function bboxOf(pts: [number,number][]) {
  return {
    minX: Math.min(...pts.map(p => p[0])),
    maxX: Math.max(...pts.map(p => p[0])),
    minY: Math.min(...pts.map(p => p[1])),
    maxY: Math.max(...pts.map(p => p[1])),
  };
}
function roadToQuad(pts: [number, number][], halfW: number): [number, number][] {
  const n = pts.length;
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = (-dy / len) * halfW, ny = (dx / len) * halfW;
    left.push([pts[i][0] + nx, pts[i][1] + ny]);
    right.push([pts[i][0] - nx, pts[i][1] - ny]);
  }
  return [...left, ...right.reverse()];
}

// ── 필지 바닥면 ─────────────────────────────────────────────────
function ParcelMesh({ pts }: { pts: [number, number][] }) {
  const geo = useMemo(() => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ShapeGeometry(shape, 12);
  }, [pts]);
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} receiveShadow>
      <meshStandardMaterial color="#f5d87c" side={THREE.DoubleSide} roughness={0.75} />
    </mesh>
  );
}

// ── 필지 5m 격자 (스케일 파악용) ────────────────────────────────
function ParcelGrid({ pts }: { pts: [number, number][] }) {
  const bb = bboxOf(pts);
  const cx = (bb.maxX + bb.minX) / 2;
  const cy = (bb.maxY + bb.minY) / 2;
  const size = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 20) * 1.4;
  const divs = Math.round(size / 5) * 2;
  return (
    <gridHelper
      args={[size, divs, "#c8b060", "#d8c878"]}
      position={[cx, 0.03, -cy]}
    />
  );
}

// ── 필지 외곽선 (TOP VIEW에서 명확히 보이도록) ─────────────────
function ParcelOutline({ pts }: { pts: [number, number][] }) {
  const points = useMemo(
    () => [...pts, pts[0]].map(([x, y]) => new THREE.Vector3(x, 0.12, -y)),
    [pts],
  );
  return <Line points={points} color="#ef4444" lineWidth={2} />;
}

// ── 건물 매스 (정북일조 사선 적용 시 층별 북측 클리핑) ───────────
// 건축법 시행령 §86:
//   topH ≤ 10m → 북경계에서 1.5m 이상 (수직 허용)
//   topH > 10m → 북경계에서 topH/2 이상 (사선 적용)
function BuildingMass({ sitePts, footprint, 층수, sunApplicable }: {
  sitePts: [number, number][]; footprint: [number, number][]; 층수: number; sunApplicable: boolean;
}) {
  const parcelNorthY = useMemo(() => Math.max(...sitePts.map(p => p[1])), [sitePts]);

  const { floorGeos, slabGeos } = useMemo(() => {
    const buildPts = footprint;
    const slabPts = footprint;

    // 층 상단 높이에 따른 북측 최대 Y (일조 적용 시)
    // 10m 이하: 1.5m 고정 (수직벽 허용), 10m 초과: 높이/2
    const allowedNorthY = (topH: number): number => {
      if (!sunApplicable || topH <= 0) return Infinity;
      return parcelNorthY - (topH <= 10 ? 1.5 : topH / 2);
    };

    const makeGeo = (fp: [number, number][], topH: number, depth: number) => {
      const limit = allowedNorthY(topH);
      const clipped = limit < Infinity ? clipNorth(fp, limit) : fp;
      if (clipped.length < 3) return null;
      return new THREE.ExtrudeGeometry(
        new THREE.Shape(clipped.map(([x, y]) => new THREE.Vector2(x, y))),
        { depth, bevelEnabled: false },
      );
    };

    return {
      floorGeos: Array.from({ length: 층수 }, (_, i) =>
        makeGeo(buildPts, (i + 1) * FLOOR_H, FLOOR_H - 0.15)),
      slabGeos: Array.from({ length: 층수 + 1 }, (_, i) =>
        makeGeo(slabPts, i * FLOOR_H, 0.12)),
    };
  }, [footprint, 층수, sunApplicable, parcelNorthY]);

  // 아래층→위층으로 살짝 밝아지는 그라데이션 (건축 다이어그램 스타일)
  const floorColor = (i: number) => {
    const t = 층수 > 1 ? i / (층수 - 1) : 0;
    const r = Math.round(0xe8 + t * (0xf8 - 0xe8)).toString(16).padStart(2, "0");
    const g = Math.round(0xed + t * (0xfa - 0xed)).toString(16).padStart(2, "0");
    const b = Math.round(0xf4 + t * (0xff - 0xf4)).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  };

  return (
    <>
      {floorGeos.map((geo, i) => geo && (
        <mesh key={`fl-${i}`} geometry={geo}
          rotation={[-Math.PI / 2, 0, 0]} position={[0, i * FLOOR_H, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={floorColor(i)} roughness={0.25} metalness={0.08} />
          <Edges threshold={25} color="#8aacc8" lineWidth={1.2} />
        </mesh>
      ))}
      {slabGeos.map((geo, i) => geo && (
        <mesh key={`sl-${i}`} geometry={geo}
          rotation={[-Math.PI / 2, 0, 0]} position={[0, i * FLOOR_H - 0.06, 0]} receiveShadow>
          <meshStandardMaterial color="#8fa8c0" roughness={0.6} metalness={0.1} />
        </mesh>
      ))}
    </>
  );
}

// ── 법적 최대 볼륨 가이드라인 (엣지 와이어프레임) ──────────────
function VolumeGuide({ pts, 층수 }: { pts: [number, number][]; 층수: number }) {
  const geo = useMemo(() => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ExtrudeGeometry(shape, { depth: 층수 * FLOOR_H, bevelEnabled: false });
  }, [pts, 층수]);
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]}>
      <meshBasicMaterial color="#3366bb" transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
      <Edges threshold={15} color="#3366bb" />
    </mesh>
  );
}

function MassFootprintOutline({ pts }: { pts: [number, number][] }) {
  const points = useMemo(
    () => [...pts, pts[0]].map(([x, y]) => new THREE.Vector3(x, 0.18, -y)),
    [pts],
  );
  return <Line points={points} color="#16a34a" lineWidth={2.2} />;
}

// ── 정북일조 필수 이격 표시선 ────────────────────────────────────
// 건축법 시행령 §86: 10m 이하 → 1.5m, 10m 초과 → 높이/2
function SunLimitLine({ localCoords, totalH }: {
  localCoords: [number, number][]; totalH: number;
}) {
  const bb = bboxOf(localCoords);
  const northZ = -bb.maxY;
  const x0 = bb.minX, x1 = bb.maxX;
  // 10m 이하: 1.5m 고정, 10m 초과: 높이/2
  const reqD = totalH <= 10 ? 1.5 : totalH / 2;
  const has사선 = totalH > 10;

  return (
    <>
      {/* 하단 1.5m 고정 이격선 (10m 이하 구간) */}
      <Line
        points={[new THREE.Vector3(x0, 0.2, northZ + 1.5), new THREE.Vector3(x1, 0.2, northZ + 1.5)]}
        color="#f97316" lineWidth={has사선 ? 1 : 2} dashed dashScale={3}
      />
      {!has사선 && (
        <Html position={[(x0 + x1) / 2, 0.5, northZ + 1.5]} center>
          <div style={{
            background: "#fff7ed", border: "1px solid #f97316",
            borderRadius: 4, padding: "2px 6px", fontSize: 10, color: "#c2410c",
            whiteSpace: "nowrap", fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,.15)"
          }}>
            정북일조 1.5m (10m↓)
          </div>
        </Html>
      )}
      {/* 10m 초과 시: 상단 사선 이격선 추가 */}
      {has사선 && (
        <>
          <Line
            points={[new THREE.Vector3(x0, 0.2, northZ + reqD), new THREE.Vector3(x1, 0.2, northZ + reqD)]}
            color="#dc2626" lineWidth={2} dashed dashScale={3}
          />
          <Html position={[(x0 + x1) / 2, 0.5, northZ + reqD]} center>
            <div style={{
              background: "#fef2f2", border: "1px solid #dc2626",
              borderRadius: 4, padding: "2px 6px", fontSize: 10, color: "#991b1b",
              whiteSpace: "nowrap", fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,.15)"
            }}>
              정북일조 {reqD.toFixed(1)}m (높이÷2)
            </div>
          </Html>
          <Html position={[(x0 + x1) / 2, 0.5, northZ + 1.5 + (reqD - 1.5) / 2]} center>
            <div style={{
              background: "#fff7ed", border: "1px solid #f97316",
              borderRadius: 4, padding: "2px 6px", fontSize: 10, color: "#c2410c",
              whiteSpace: "nowrap", fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,.15)"
            }}>
              ← 1.5m (10m↓)
            </div>
          </Html>
        </>
      )}
    </>
  );
}

// ── TOP VIEW 치수선 ─────────────────────────────────────────────
function DimensionLine({ p1, p2, label, col = "#1d4ed8" }: {
  p1: THREE.Vector3; p2: THREE.Vector3; label: string; col?: string;
}) {
  const mid = new THREE.Vector3().lerpVectors(p1, p2, 0.5);
  return (
    <group>
      <Line points={[p1, p2]} color={col} lineWidth={1.5} dashed dashScale={4} />
      <Html position={[mid.x, mid.y, mid.z]} center>
        <div style={{
          background: "white", borderRadius: 3, padding: "1px 5px",
          fontSize: 10, fontWeight: 700, color: col,
          boxShadow: "0 1px 3px rgba(0,0,0,.2)", whiteSpace: "nowrap",
        }}>{label}</div>
      </Html>
    </group>
  );
}

function TopViewDimensions({ localCoords, footprint }: {
  localCoords: [number, number][]; footprint: [number, number][];
}) {
  const bb       = bboxOf(localCoords);
  const buildPts = footprint;
  const bb2      = bboxOf(buildPts);

  // local(x,y) → world(x, height, -y)
  const W = (x: number, y: number, h = 0.15): THREE.Vector3 => new THREE.Vector3(x, h, -y);

  const gap  = (bb.maxX - bb.minX) * 0.15 + 1.5; // dimension line offset
  const gapY = (bb.maxY - bb.minY) * 0.15 + 1.5;

  const nSb = (bb.maxY - bb2.maxY).toFixed(1);
  const sSb = (bb2.minY - bb.minY).toFixed(1);
  const eSb = (bb.maxX - bb2.maxX).toFixed(1);
  const wSb = (bb2.minX - bb.minX).toFixed(1);
  const bdW = (bb2.maxX - bb2.minX).toFixed(1);
  const bdD = (bb2.maxY - bb2.minY).toFixed(1);

  return (
    <group>
      {/* North setback */}
      <DimensionLine
        p1={W(bb.maxX + gap, bb.maxY)} p2={W(bb.maxX + gap, bb2.maxY)}
        label={`N: ${nSb}m`} col="#ef4444"
      />
      {/* South setback */}
      <DimensionLine
        p1={W(bb.maxX + gap, bb2.minY)} p2={W(bb.maxX + gap, bb.minY)}
        label={`S: ${sSb}m`} col="#6366f1"
      />
      {/* East setback */}
      <DimensionLine
        p1={W(bb2.maxX, bb.minY - gapY)} p2={W(bb.maxX, bb.minY - gapY)}
        label={`E: ${eSb}m`} col="#0891b2"
      />
      {/* West setback */}
      <DimensionLine
        p1={W(bb.minX, bb.minY - gapY)} p2={W(bb2.minX, bb.minY - gapY)}
        label={`W: ${wSb}m`} col="#0891b2"
      />
      {/* Building size */}
      <DimensionLine
        p1={W(bb2.minX, bb.minY - gapY * 2)} p2={W(bb2.maxX, bb.minY - gapY * 2)}
        label={`건물 ${bdW}m`} col="#15803d"
      />
      <DimensionLine
        p1={W(bb.maxX + gap * 2, bb2.minY)} p2={W(bb.maxX + gap * 2, bb2.maxY)}
        label={`건물 ${bdD}m`} col="#15803d"
      />
      {/* North arrow */}
      <Html position={[0, 0.3, -(bb.maxY + gapY * 0.6)]} center>
        <div style={{ fontSize: 14, fontWeight: 900, color: "#ef4444", textShadow: "0 0 4px white" }}>↑ N</div>
      </Html>
    </group>
  );
}

// ── 주변 건물 (병합 geometry) ────────────────────────────────────
function SurroundingBuildings({ buildings }: { buildings: ContextBuilding[] }) {
  const geo = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    for (const { coords, height } of buildings) {
      if (coords.length < 3 || height <= 0 || height > 300) continue;
      try {
        const pts = signedArea(coords) < 0 ? [...coords].reverse() : coords;
        const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
        const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
        g.applyMatrix4(ROT_X);
        g.translate(0, 0.02, 0);
        geos.push(g);
      } catch { /* skip */ }
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, false);
    geos.forEach(g => g.dispose());
    return merged;
  }, [buildings]);

  if (!geo) return null;
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial color="#b8bec6" roughness={0.85} transparent opacity={0.75} />
    </mesh>
  );
}

// ── 도로 (병합 geometry) ─────────────────────────────────────────
function Roads({ roads }: { roads: ContextRoad[] }) {
  const geo = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    for (const { coords, width } of roads) {
      if (coords.length < 2) continue;
      try {
        const quad = roadToQuad(coords, width / 2);
        if (quad.length < 3) continue;
        const shape = new THREE.Shape(quad.map(([x, y]) => new THREE.Vector2(x, y)));
        const g = new THREE.ShapeGeometry(shape, 1);
        g.applyMatrix4(ROT_X);
        g.translate(0, 0.015, 0);
        geos.push(g);
      } catch { /* skip */ }
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, false);
    geos.forEach(g => g.dispose());
    return merged;
  }, [roads]);

  if (!geo) return null;
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial color="#6e7068" roughness={0.95} />
    </mesh>
  );
}

// ── 지적도 지면 텍스처 (VWorld WMS lt_c_ais001) ─────────────────
const M_PER_LAT = 111320;

function CadastralGround({ lat, lng }: { lat: number; lng: number }) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    const mPerLng = M_PER_LAT * Math.cos((lat * Math.PI) / 180);
    const radius = 200;
    const dLat = radius / M_PER_LAT;
    const dLng = radius / mPerLng;

    // WMS 1.1.1 EPSG:4326: BBOX = minLon,minLat,maxLon,maxLat
    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.1.1",
      REQUEST: "GetMap",
      LAYERS: "lt_c_ais001",
      STYLES: "",
      SRS: "EPSG:4326",
      BBOX: `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`,
      WIDTH: "1024",
      HEIGHT: "1024",
      FORMAT: "image/png",
      TRANSPARENT: "true",
    });

    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      `/api/wms?${params}`,
      (tex) => {
        if (cancelled) { tex.dispose(); return; }
        setTexture(old => { old?.dispose(); return tex; });
      },
      undefined,
      () => {},
    );
    return () => { cancelled = true; };
  }, [lat, lng]);

  if (!texture) return null;

  // PlaneGeometry(400,400) rotated -90° around X:
  //   local(x,y) → world(x, 0, -y)  ← UV V=0=south, V=1=north after flipY
  //   matches WMS BBOX centered on the same lat/lng origin
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
      <planeGeometry args={[400, 400]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}

// ── 씬 ─────────────────────────────────────────────────────────
interface SceneProps extends BuildingViewer3DProps {
  topView: boolean;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

function Scene({ localCoords, 건축면적, 층수, 대지면적, setbackMeters = 0, setbackRules, surroundings, zoneName, lat, lng, topView, controlsRef }: SceneProps) {
  const totalH = 층수 * FLOOR_H;
  const sc     = Math.sqrt(대지면적) * 1.8;
  const sunApplicable = isSunZone(zoneName);
  const roads = surroundings?.roads;
  const edgeClearances = useMemo(() => {
    if (!setbackRules || !roads?.length) return undefined;
    return createSetbackEdgeClearances(localCoords, roads, setbackRules);
  }, [localCoords, setbackRules, roads]);
  const massResult = useMemo(
    () => createSafeMassFootprint(localCoords, 건축면적 || 대지면적 * 0.7, {
      gridSteps: 21,
      minClearance: setbackMeters,
      edgeClearances,
    }),
    [localCoords, 건축면적, 대지면적, setbackMeters, edgeClearances],
  );

  // OrbitControls ref이 마운트된 후 카메라 초기 위치도 설정
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    if (topView) {
      c.object.position.set(0, Math.max(sc * 2.5, 80), 0.001);
      c.target.set(0, 0, 0);
    } else {
      // 남동쪽 아래에서 건물 북서면을 바라보는 앵글 (정북일조 제한 잘 보임)
      c.object.position.set(sc * 0.8, sc * 0.7 + totalH * 0.4, sc * 1.2);
      c.target.set(0, totalH * 0.4, 0);
    }
    c.update();
  }, [controlsRef, topView, sc, totalH]);

  // 최초 마운트 시 카메라 타겟 설정 (OrbitControls가 렌더 후 ref에 연결됨)
  useEffect(() => {
    const timer = setTimeout(() => {
      const c = controlsRef.current;
      if (!c) return;
      c.target.set(0, totalH / 2, 0);
      c.update();
    }, 50);
    return () => clearTimeout(timer);
  }, [controlsRef, totalH]);

  return (
    <>
      {/* ── 배경 / 조명 ── */}
      {topView
        ? <color attach="background" args={["#f0f4f8"]} />
        : <Sky sunPosition={[80, 60, 50]} turbidity={5} rayleigh={0.4}
            mieCoefficient={0.004} mieDirectionalG={0.85} />
      }
      <ambientLight intensity={topView ? 1.4 : 0.5} color="#ffffff" />
      {!topView && (
        <>
          {/* 남측 햇빛 (한국 기준 남향 = +Z 방향에서 비침) */}
          <directionalLight
            position={[20, 80, 60]} intensity={1.4} color="#fff8ee" castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-near={1} shadow-camera-far={500}
            shadow-camera-left={-150} shadow-camera-right={150}
            shadow-camera-top={150} shadow-camera-bottom={-150}
            shadow-bias={-0.0005}
          />
          {/* 보조 채광 (북서측 fill light) */}
          <directionalLight position={[-40, 40, -30]} intensity={0.35} color="#ddeeff" />
          {/* 반구광: 하늘(위)→지면(아래) 앰비언트 — 외부 HDR 불필요 */}
          <hemisphereLight args={["#b8d4f0", "#c8b890", 0.6]} />
        </>
      )}

      {/* ── 지면 ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[800, 800]} />
        <meshStandardMaterial
          color={topView ? "#e4eaf0" : "#b0aca6"}
          roughness={topView ? 0.9 : 1}
        />
      </mesh>

      {lat && lng && <CadastralGround lat={lat} lng={lng} />}

      {surroundings?.roads     && <Roads     roads={surroundings.roads} />}
      {surroundings?.buildings && <SurroundingBuildings buildings={surroundings.buildings} />}

      <ParcelMesh pts={localCoords} />
      <ParcelGrid pts={localCoords} />
      {topView && <ParcelOutline pts={localCoords} />}
      <VolumeGuide pts={massResult.footprint} 층수={층수} />
      {topView && <MassFootprintOutline pts={massResult.footprint} />}
      <BuildingMass sitePts={localCoords} footprint={massResult.footprint} 층수={층수} sunApplicable={sunApplicable} />

      {/* 정북일조 필수 이격선 (TOP VIEW 전용) */}
      {sunApplicable && topView && <SunLimitLine localCoords={localCoords} totalH={totalH} />}

      {/* TOP VIEW 치수선 */}
      {topView && (
        <TopViewDimensions localCoords={localCoords} footprint={massResult.footprint} />
      )}

      {!topView && (
        <ContactShadows position={[0, 0.02, 0]} opacity={0.55} scale={140} blur={2.5} far={25} />
      )}

      <OrbitControls ref={controlsRef}
        enablePan minDistance={6} maxDistance={600}
        maxPolarAngle={topView ? Math.PI / 2 : Math.PI / 2.05}
      />
    </>
  );
}

// ── 범례 ─────────────────────────────────────────────────────────
const LEGEND_3D = [
  { color: "#f5d87c", h: 1.5, label: "검토 대지" },
  { color: "#edf2fa", h: 12,  label: "계획 건물" },
  { color: "#3366bb", h: 12,  label: "안전 건축범위", opacity: 0.35 },
];
const LEGEND_SURR = [
  { color: "#b8bec6", h: 12, label: "주변 건물", opacity: 0.75 },
  { color: "#6e7068", h: 4,  label: "도로" },
];

// ── 공개 컴포넌트 ─────────────────────────────────────────────────
export default function BuildingViewer3D(props: BuildingViewer3DProps) {
  const { localCoords, 건축면적, 대지면적, 층수, setbackMeters = 0, setbackRules, surroundings, zoneName } = props;
  const sc     = Math.sqrt(대지면적) * 1.8;
  const totalH = 층수 * FLOOR_H;
  const hasSurr = !!(surroundings?.buildings.length || surroundings?.roads.length);
  const isSun  = isSunZone(zoneName);
  const roads = surroundings?.roads;
  const edgeClearances = useMemo(() => {
    if (!setbackRules || !roads?.length) return undefined;
    return createSetbackEdgeClearances(localCoords, roads, setbackRules);
  }, [localCoords, setbackRules, roads]);
  const massResult = useMemo(
    () => createSafeMassFootprint(localCoords, 건축면적 || 대지면적 * 0.7, {
      gridSteps: 21,
      minClearance: setbackMeters,
      edgeClearances,
    }),
    [localCoords, 건축면적, 대지면적, setbackMeters, edgeClearances],
  );

  const [topView, setTopView] = useState(false);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const legend = [
    ...LEGEND_3D,
    ...(hasSurr ? LEGEND_SURR : []),
  ];

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-200 relative" style={{ height: 500 }}>
      <Canvas shadows
        camera={{ position: [sc * 0.8, sc * 0.7 + totalH * 0.4, sc * 1.2], fov: 40 }}
        gl={{ antialias: true }}
      >
        <Scene {...props} topView={topView} controlsRef={controlsRef} />
      </Canvas>

      {/* ── 뷰 전환 버튼 ── */}
      <div className="absolute top-3 right-3 flex rounded-lg overflow-hidden shadow-md border border-white/30">
        {[
          { label: "3D",    active: !topView, onClick: () => setTopView(false) },
          { label: "평면도", active: topView,  onClick: () => setTopView(true)  },
        ].map(({ label, active, onClick }) => (
          <button key={label} onClick={onClick}
            className={`px-3 py-1.5 text-[11px] font-bold tracking-wide transition-colors ${
              active
                ? "bg-[#1F4E79] text-white"
                : "bg-white/80 backdrop-blur text-gray-600 hover:bg-white"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 나침반 (3D 뷰 전용) ── */}
      {!topView && (
        <div className="absolute top-3 left-3 pointer-events-none select-none">
          <div className="w-10 h-10 rounded-full bg-black/30 backdrop-blur flex items-center justify-center relative border border-white/20">
            <div className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[9px] font-black text-red-400">N</div>
            <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[9px] font-black text-white/50">S</div>
            <div className="absolute left-0.5 top-1/2 -translate-y-1/2 text-[8px] font-bold text-white/50">W</div>
            <div className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[8px] font-bold text-white/50">E</div>
            {/* 북쪽 화살표 */}
            <div className="w-px h-3 bg-red-400 absolute top-2 left-1/2 -translate-x-1/2 rounded-full" />
            <div className="w-px h-2.5 bg-white/40 absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full" />
          </div>
        </div>
      )}

      {/* ── 건물 정보 배지 ── */}
      <div className="absolute top-3 left-3 pointer-events-none select-none flex flex-col gap-1"
        style={{ marginLeft: !topView ? "52px" : "0" }}>
        <div className="bg-[#1F4E79]/80 backdrop-blur text-white text-[10px] font-semibold rounded-md px-2.5 py-1.5 shadow leading-snug">
          <div className="text-white/60 text-[9px] font-normal mb-0.5">계획 건물</div>
          <div>{층수}층 · {totalH.toFixed(1)}m</div>
          <div className="text-emerald-200 text-[9px] mt-0.5">
            footprint {massResult.actualArea.toFixed(0)}㎡
          </div>
          {setbackMeters > 0 && (
            <div className="text-blue-100 text-[9px] mt-0.5">공지 이격 {setbackMeters.toFixed(1)}m 반영</div>
          )}
          {edgeClearances && (
            <div className="text-blue-100 text-[9px] mt-0.5">도로변/인접대지 변별 적용</div>
          )}
          {!massResult.fitsRequestedArea && (
            <div className="text-amber-200 text-[9px] mt-0.5">대지 내 안전범위로 축소</div>
          )}
          {isSun && <div className="text-orange-300 text-[9px] mt-0.5">⚡ 정북일조 적용</div>}
        </div>
      </div>

      {/* ── 범례 ── */}
      <div className="absolute bottom-8 left-3 flex flex-col gap-0.5 pointer-events-none select-none">
        {legend.map(({ color, h, label, opacity }) => (
          <div key={label} className="flex items-center gap-1.5 bg-black/25 backdrop-blur rounded px-2 py-0.5">
            <div className="w-2.5 rounded-sm border border-white/20 shrink-0"
              style={{ height: Math.min(h, 8), background: color, opacity: opacity ?? 1 }} />
            <span className="text-[9px] text-white/85">{label}</span>
          </div>
        ))}
      </div>

      {/* ── 조작 안내 + 격자 스케일 ── */}
      <div className="absolute bottom-2 right-3 flex items-center gap-2 pointer-events-none select-none">
        <span className="text-[9px] text-white/50">격자 5m</span>
        <span className="text-[10px] bg-black/25 text-white/75 rounded px-2 py-0.5">
          {topView ? "드래그 이동 · 스크롤 줌" : "드래그 회전 · 스크롤 줌"}
        </span>
      </div>

      {/* ── 지번/주소 라벨 (평면도 전용) ── */}
      {topView && (
        <div className="absolute bottom-2 left-3 text-[9px] bg-white/70 text-gray-600 rounded px-2 py-0.5 pointer-events-none select-none border border-gray-200">
          평면도 · 이격거리 표기
        </div>
      )}
    </div>
  );
}
