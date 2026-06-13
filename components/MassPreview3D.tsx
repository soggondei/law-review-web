"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { MassPreviewData, TerrainGrid } from "@/app/api/masspreview/route";

type LayerKey = "BUILDINGS" | "PARCELS" | "ROADS" | "SIDEWALK";

const LAYER_CONFIG: Record<LayerKey, { label: string; faceHex: number; edgeHex: number }> = {
  BUILDINGS: { label: "건물 매스",  faceHex: 0xfafafa, edgeHex: 0x1a1a1a },
  PARCELS:   { label: "지적 필지", faceHex: 0xfff6e0, edgeHex: 0xb8965c },
  ROADS:     { label: "차도",      faceHex: 0x787878, edgeHex: 0x303030 },
  SIDEWALK:  { label: "보도",      faceHex: 0xd4c8a8, edgeHex: 0x9c7c4a },
};
const LAYER_KEYS: LayerKey[] = ["BUILDINGS", "PARCELS", "ROADS", "SIDEWALK"];
const S_TERRAIN = 4; // 5×5 grid → 4× upsample → 16×16 stepped cells

interface Props { lat: number; lng: number; radius: number; }

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative inline-flex h-[28px] w-[50px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${on ? "bg-[#34C759]" : "bg-[#C7C7CC]"}`}
    >
      <span className={`pointer-events-none inline-block h-[24px] w-[24px] transform rounded-full bg-white shadow-md transition duration-200 ease-in-out ${on ? "translate-x-[22px]" : "translate-x-0"}`} />
    </button>
  );
}

export default function MassPreview3D({ lat, lng, radius }: Props) {
  const canvasRef  = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const groupsRef  = useRef<Partial<Record<LayerKey, import("three").Group>>>({});

  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [bldCount, setBldCount]   = useState(0);
  const [elevRange, setElevRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [layers, setLayers]       = useState<Record<LayerKey, boolean>>({
    BUILDINGS: true, PARCELS: true, ROADS: true, SIDEWALK: true,
  });

  const toggleLayer = useCallback((key: LayerKey) => {
    setLayers(prev => {
      const next = { ...prev, [key]: !prev[key] };
      const g = groupsRef.current[key];
      if (g) g.visible = next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    groupsRef.current = {};
    setLoading(true);
    setError(null);
    setElevRange(null);

    let cancelled = false;

    (async () => {
      try {
        const [THREE, res] = await Promise.all([
          import("three"),
          fetch(`/api/masspreview?lat=${lat}&lng=${lng}&radius=${radius}`),
        ]);
        if (cancelled) return;
        if (!res.ok) throw new Error("데이터 로드 실패");
        const data: MassPreviewData = await res.json();
        if (cancelled || !canvasRef.current) return;

        const terrain  = data.terrain;
        const elevDiff = terrain ? terrain.maxElev - terrain.minElev : 0;

        // 계단 간격 결정
        const STEP = !terrain ? 1
          : elevDiff <= 4  ? 1
          : elevDiff <= 12 ? 2
          : elevDiff <= 30 ? 5 : 10;

        if (terrain) setElevRange({ min: terrain.minElev, max: terrain.maxElev, step: STEP });

        function snapZ(z: number) { return Math.round(z / STEP) * STEP; }

        // terrain 셀 기반 getZ → parcels/roads가 terrain mesh와 정확히 맞춤
        function getZ(localX: number, localY: number): number {
          if (!terrain) return 0;
          const sR = (terrain.rows - 1) * S_TERRAIN;
          const sC = (terrain.cols - 1) * S_TERRAIN;
          const ci = Math.max(0, Math.min(sC - 1, Math.floor((localX + radius) / (2 * radius / sC))));
          const ri = Math.max(0, Math.min(sR - 1, Math.floor((localY + radius) / (2 * radius / sR))));
          const fr = (ri + 0.5) / S_TERRAIN;
          const fc = (ci + 0.5) / S_TERRAIN;
          const r0 = Math.max(0, Math.min(terrain.rows - 2, Math.floor(fr)));
          const c0 = Math.max(0, Math.min(terrain.cols - 2, Math.floor(fc)));
          const dr = fr - r0, dc = fc - c0;
          const e = (
            terrain.grid[r0][c0]           * (1-dr)*(1-dc) +
            terrain.grid[r0][c0+1]         * (1-dr)*dc     +
            terrain.grid[r0+1][c0]         * dr    *(1-dc) +
            terrain.grid[r0+1][c0+1]       * dr    *dc
          ) - terrain.minElev;
          return snapZ(e);
        }

        const W = canvasRef.current.clientWidth  || 680;
        const H = canvasRef.current.clientHeight || 440;

        // ── Scene ────────────────────────────────────────────────
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf8f8f5);
        scene.fog = new THREE.FogExp2(0xf8f8f5, 0.003);

        // ── Camera ───────────────────────────────────────────────
        const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 4000);
        const d  = radius * 1.8;
        const dz = d * 0.65 + elevDiff * 0.4;
        const centerElev = terrain
          ? snapZ(terrain.grid[Math.floor(terrain.rows/2)][Math.floor(terrain.cols/2)] - terrain.minElev)
          : 0;

        // ── Renderer ─────────────────────────────────────────────
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(W, H);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
        canvasRef.current.appendChild(renderer.domElement);

        // ── 조명 ─────────────────────────────────────────────────
        scene.add(new THREE.AmbientLight(0xffffff, 0.82));
        const sun = new THREE.DirectionalLight(0xfff5e0, 1.0);
        sun.position.set(radius * 0.8, -radius * 0.3, radius * 2.5 + elevDiff);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.camera.left   = -radius * 1.5;
        sun.shadow.camera.right  =  radius * 1.5;
        sun.shadow.camera.top    =  radius * 1.5;
        sun.shadow.camera.bottom = -radius * 1.5;
        sun.shadow.camera.far    = 4000;
        scene.add(sun);
        const fill = new THREE.DirectionalLight(0xd0e8ff, 0.35);
        fill.position.set(-radius, radius, radius * 0.5);
        scene.add(fill);

        // ── 지면 (계단형 terrain 또는 flat) ──────────────────────
        if (terrain) {
          const { grid, rows, cols, minElev } = terrain;
          const sR = (rows - 1) * S_TERRAIN;
          const sC = (cols - 1) * S_TERRAIN;

          function rawAtFrac(fr: number, fc: number): number {
            const r0 = Math.max(0, Math.min(rows-2, Math.floor(fr)));
            const c0 = Math.max(0, Math.min(cols-2, Math.floor(fc)));
            const dr = Math.min(1, fr - r0), dc = Math.min(1, fc - c0);
            return (
              grid[r0][c0]         * (1-dr)*(1-dc) +
              grid[r0][c0+1]       * (1-dr)*dc     +
              grid[r0+1][c0]       * dr    *(1-dc) +
              grid[r0+1][c0+1]     * dr    *dc
            ) - minElev;
          }

          function cellZ(ri: number, ci: number) {
            return snapZ(rawAtFrac((ri+0.5)/S_TERRAIN, (ci+0.5)/S_TERRAIN));
          }

          const tPos: number[] = [], tIdx: number[] = [];
          let vi = 0;

          for (let r = 0; r < sR; r++) {
            for (let c = 0; c < sC; c++) {
              const z  = cellZ(r, c);
              const x0 = -radius + (c   / sC) * 2 * radius;
              const x1 = -radius + ((c+1) / sC) * 2 * radius;
              const y0 = -radius + (r   / sR) * 2 * radius;
              const y1 = -radius + ((r+1) / sR) * 2 * radius;

              // 상면 (법선 +Z → CCW from above)
              tPos.push(x0,y0,z, x1,y0,z, x1,y1,z, x0,y1,z);
              tIdx.push(vi, vi+1, vi+2,  vi, vi+2, vi+3);
              vi += 4;

              // 우측 수직벽 (법선 +X)
              if (c + 1 < sC) {
                const zR = cellZ(r, c+1);
                if (zR !== z) {
                  const zlo = Math.min(z, zR), zhi = Math.max(z, zR);
                  tPos.push(x1,y0,zlo, x1,y1,zlo, x1,y1,zhi, x1,y0,zhi);
                  tIdx.push(vi, vi+1, vi+2,  vi, vi+2, vi+3);
                  vi += 4;
                }
              }
              // 상단 수직벽 (법선 +Y)
              if (r + 1 < sR) {
                const zT = cellZ(r+1, c);
                if (zT !== z) {
                  const zlo = Math.min(z, zT), zhi = Math.max(z, zT);
                  // CCW from +Y: zhi 순서로 반전
                  tPos.push(x0,y1,zhi, x1,y1,zhi, x1,y1,zlo, x0,y1,zlo);
                  tIdx.push(vi, vi+1, vi+2,  vi, vi+2, vi+3);
                  vi += 4;
                }
              }
            }
          }

          const tGeo = new THREE.BufferGeometry();
          tGeo.setAttribute("position", new THREE.Float32BufferAttribute(tPos, 3));
          tGeo.setIndex(tIdx);
          const tMesh = new THREE.Mesh(tGeo,
            new THREE.MeshLambertMaterial({ color: 0xe8e2d0, side: THREE.DoubleSide, flatShading: true }));
          tMesh.receiveShadow = true;
          scene.add(tMesh);
        } else {
          const gnd = new THREE.Mesh(
            new THREE.PlaneGeometry(radius * 2, radius * 2),
            new THREE.MeshLambertMaterial({ color: 0xf0efe8, side: THREE.DoubleSide }),
          );
          gnd.receiveShadow = true;
          scene.add(gnd);
        }

        // 격자선
        const gridHelper = new THREE.GridHelper(radius * 2, Math.ceil(radius / 5) * 2, 0xcccccc, 0xdddddd);
        gridHelper.rotation.x = Math.PI / 2;
        gridHelper.position.z = centerElev - 0.02;
        scene.add(gridHelper);

        // ── 헬퍼 ──────────────────────────────────────────────────

        function addMesh(
          group: import("three").Group,
          geo: import("three").BufferGeometry,
          faceHex: number, edgeHex: number,
          castShadow = false,
        ) {
          const mesh = new THREE.Mesh(geo,
            new THREE.MeshLambertMaterial({ color: faceHex, side: THREE.DoubleSide }));
          mesh.castShadow    = castShadow;
          mesh.receiveShadow = true;
          group.add(mesh);
          // EdgesGeometry 15° 이상 각도 엣지만 표시 (삼각분할 내부선 제거)
          group.add(new THREE.LineSegments(
            new THREE.EdgesGeometry(geo, 15),
            new THREE.LineBasicMaterial({ color: edgeHex }),
          ));
        }

        // 건물: ExtrudeGeometry → concave polygon 정상 처리
        function buildingGeo(pts: [number, number][], h: number, baseElev: number) {
          const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
          const geo   = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
          geo.translate(0, 0, baseElev);
          return geo;
        }

        // 필지: ShapeGeometry → concave polygon 정상 처리 + terrain z
        function flatPolyGeo(pts: [number, number][]) {
          const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
          const geo   = new THREE.ShapeGeometry(shape);
          const pos   = geo.getAttribute("position") as import("three").BufferAttribute;
          for (let i = 0; i < pos.count; i++) {
            pos.setZ(i, getZ(pos.getX(i), pos.getY(i)) + 0.06);
          }
          pos.needsUpdate = true;
          geo.computeVertexNormals();
          return geo;
        }

        // 도로 띠: terrain z 반영
        function stripGeo(pts: [number, number][], hw: number) {
          const pos: number[] = [], idx: number[] = [];
          let vi2 = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const [x1, y1] = pts[i], [x2, y2] = pts[i+1];
            const dx = x2-x1, dy = y2-y1, len = Math.hypot(dx, dy);
            if (len < 0.01) continue;
            const nx = (-dy/len)*hw, ny = (dx/len)*hw;
            const z1 = getZ(x1, y1) + 0.12, z2 = getZ(x2, y2) + 0.12;
            pos.push(x1+nx,y1+ny,z1, x1-nx,y1-ny,z1, x2-nx,y2-ny,z2, x2+nx,y2+ny,z2);
            idx.push(vi2, vi2+1, vi2+2,  vi2, vi2+2, vi2+3);
            vi2 += 4;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          geo.setIndex(idx);
          geo.computeVertexNormals();
          return geo;
        }

        // ── 레이어 그룹 ───────────────────────────────────────────
        for (const key of LAYER_KEYS) {
          const g = new THREE.Group();
          g.visible = layers[key];
          scene.add(g);
          groupsRef.current[key] = g;
        }

        // 필지
        const pGroup = groupsRef.current.PARCELS!;
        for (const p of data.parcels) {
          if (p.pts.length < 3) continue;
          addMesh(pGroup, flatPolyGeo(p.pts), LAYER_CONFIG.PARCELS.faceHex, LAYER_CONFIG.PARCELS.edgeHex);
        }

        // 도로 / 보도
        const rGroup = groupsRef.current.ROADS!;
        const sGroup = groupsRef.current.SIDEWALK!;
        for (const r of data.roads) {
          const hw  = r.isSidewalk ? 0.75 : 1.5;
          const cfg = r.isSidewalk ? LAYER_CONFIG.SIDEWALK : LAYER_CONFIG.ROADS;
          const grp = r.isSidewalk ? sGroup : rGroup;
          const geo = stripGeo(r.pts, hw);
          if ((geo.index?.count ?? 0) > 0) addMesh(grp, geo, cfg.faceHex, cfg.edgeHex);
        }

        // 건물
        const bGroup = groupsRef.current.BUILDINGS!;
        let cnt = 0;
        for (const b of data.buildings) {
          if (b.pts.length < 3) continue;
          addMesh(bGroup, buildingGeo(b.pts, b.height, snapZ(b.baseElev)),
            LAYER_CONFIG.BUILDINGS.faceHex, LAYER_CONFIG.BUILDINGS.edgeHex, true);
          cnt++;
        }
        setBldCount(cnt);

        // 원점 마커
        const mkGeo = new THREE.CylinderGeometry(2, 2, 0.5, 24);
        mkGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        const mk = new THREE.Mesh(mkGeo, new THREE.MeshBasicMaterial({ color: 0xff3333 }));
        mk.position.z = centerElev + 0.25;
        scene.add(mk);

        // ── 카메라 궤도 ───────────────────────────────────────────
        let isDragging = false, lastX = 0, lastY = 0;
        let theta = Math.atan2(d * 0.8, -d * 0.9);
        let phi   = Math.atan2(dz, Math.hypot(d * 0.8, d * 0.9));
        const R   = Math.sqrt((d*0.8)**2 + (d*0.9)**2 + dz**2);

        function updateCamera() {
          const cosP = Math.cos(phi);
          camera.position.set(R*Math.cos(theta)*cosP, R*Math.sin(theta)*cosP, R*Math.sin(phi));
          camera.lookAt(0, 0, centerElev);
        }
        updateCamera();

        const dom  = renderer.domElement;
        const down = (e: MouseEvent) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; };
        const up   = () => { isDragging = false; };
        const move = (e: MouseEvent) => {
          if (!isDragging) return;
          theta -= (e.clientX - lastX) * 0.008;
          phi    = Math.max(0.05, Math.min(Math.PI/2 - 0.05, phi + (e.clientY - lastY) * 0.006));
          lastX = e.clientX; lastY = e.clientY;
          updateCamera();
        };
        const wheel = (e: WheelEvent) => {
          e.preventDefault();
          camera.fov = Math.max(12, Math.min(60, camera.fov + e.deltaY * 0.03));
          camera.updateProjectionMatrix();
        };
        dom.addEventListener("mousedown", down);
        window.addEventListener("mouseup", up);
        window.addEventListener("mousemove", move);
        dom.addEventListener("wheel", wheel, { passive: false });

        let rafId = 0;
        function render() { rafId = requestAnimationFrame(render); renderer.render(scene, camera); }
        render();

        setLoading(false);

        cleanupRef.current = () => {
          cancelled = true;
          cancelAnimationFrame(rafId);
          dom.removeEventListener("mousedown", down);
          window.removeEventListener("mouseup", up);
          window.removeEventListener("mousemove", move);
          dom.removeEventListener("wheel", wheel);
          renderer.dispose();
          if (canvasRef.current?.contains(dom)) canvasRef.current.removeChild(dom);
          groupsRef.current = {};
        };
      } catch (e: any) {
        if (!cancelled) { setError(e.message ?? "오류"); setLoading(false); }
      }
    })();

    return () => { cleanupRef.current?.(); cleanupRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, radius]);

  return (
    <div className="flex gap-0 w-full rounded-xl overflow-hidden border border-gray-200" style={{ height: 460 }}>
      {/* ── 3D 뷰포트 ───────────────────────────────────────────── */}
      <div className="relative flex-1 bg-[#f8f8f5]">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#f8f8f5]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              <span className="text-[12px] text-gray-400">주변 데이터 로딩 중…</span>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#f8f8f5]">
            <span className="text-[12px] text-red-500">{error}</span>
          </div>
        )}
        <div ref={canvasRef} className="w-full h-full" />
        {!loading && !error && (
          <div className="absolute bottom-2 left-2 text-[10px] text-gray-400 pointer-events-none select-none">
            드래그 회전 · 스크롤 줌
          </div>
        )}
      </div>

      {/* ── 레이어 패널 ──────────────────────────────────────────── */}
      <div className="w-[180px] shrink-0 bg-white border-l border-gray-200 flex flex-col">
        <div className="px-3 py-2.5 bg-[#F2F2F7] border-b border-gray-200">
          <p className="text-[11px] font-bold text-gray-700 leading-tight">레이어</p>
          {!loading && !error && (
            <p className="text-[10px] text-gray-400 mt-0.5">건물 {bldCount}동</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {LAYER_KEYS.map((key, i) => {
            const cfg = LAYER_CONFIG[key];
            return (
              <div
                key={key}
                className={`flex items-center justify-between px-3 py-2.5 ${i < LAYER_KEYS.length - 1 ? "border-b border-gray-100" : ""}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm shrink-0 border"
                    style={{
                      backgroundColor: `#${cfg.faceHex.toString(16).padStart(6, "0")}`,
                      borderColor:     `#${cfg.edgeHex.toString(16).padStart(6, "0")}`,
                    }}
                  />
                  <span className="text-[12px] text-gray-700 truncate">{cfg.label}</span>
                </div>
                <Toggle on={layers[key]} onChange={() => toggleLayer(key)} />
              </div>
            );
          })}
        </div>

        <div className="px-3 py-2.5 border-t border-gray-100 bg-[#F2F2F7]">
          {elevRange ? (
            <>
              <p className="text-[11px] font-semibold text-gray-600 mb-0.5">지형 고도</p>
              <p className="text-[10px] text-gray-500 leading-relaxed">
                {elevRange.min}m ~ {elevRange.max}m<br />
                경사차 {elevRange.max - elevRange.min}m · 계단 {elevRange.step}m
              </p>
            </>
          ) : (
            <p className="text-[10px] text-gray-400 leading-relaxed">
              레이어는 미리보기 전용<br />DAE 파일에 모두 포함
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
