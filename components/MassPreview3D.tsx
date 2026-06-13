"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { MassPreviewData } from "@/app/api/masspreview/route";

// ── 레이어 설정 ────────────────────────────────────────────────────────────────

type LayerKey = "BUILDINGS" | "PARCELS" | "ROADS" | "SIDEWALK";

const LAYER_CONFIG: Record<LayerKey, { label: string; faceHex: number; edgeHex: number }> = {
  BUILDINGS: { label: "건물 매스",  faceHex: 0xffffff, edgeHex: 0x222222 },
  PARCELS:   { label: "지적 필지", faceHex: 0xfff8ee, edgeHex: 0xaa8855 },
  ROADS:     { label: "차도",      faceHex: 0xe8e8e8, edgeHex: 0x555555 },
  SIDEWALK:  { label: "보도",      faceHex: 0xf4f4f4, edgeHex: 0x999999 },
};
const LAYER_KEYS: LayerKey[] = ["BUILDINGS", "PARCELS", "ROADS", "SIDEWALK"];

// ── 컴포넌트 Props ─────────────────────────────────────────────────────────────

interface Props {
  lat: number;
  lng: number;
  radius: number;
}

// ── iOS 스타일 토글 ────────────────────────────────────────────────────────────

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative inline-flex h-[28px] w-[50px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
        on ? "bg-[#34C759]" : "bg-[#C7C7CC]"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-[24px] w-[24px] transform rounded-full bg-white shadow-md transition duration-200 ease-in-out ${
          on ? "translate-x-[22px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function MassPreview3D({ lat, lng, radius }: Props) {
  const canvasRef  = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const groupsRef  = useRef<Partial<Record<LayerKey, import("three").Group>>>({});

  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [bldCount, setBldCount] = useState(0);
  const [layers, setLayers]   = useState<Record<LayerKey, boolean>>({
    BUILDINGS: true, PARCELS: true, ROADS: true, SIDEWALK: true,
  });

  // 레이어 토글 → Three.js 그룹 visibility 직접 변경 (리렌더 없음)
  const toggleLayer = useCallback((key: LayerKey) => {
    setLayers(prev => {
      const next = { ...prev, [key]: !prev[key] };
      const g = groupsRef.current[key];
      if (g) g.visible = next[key];
      return next;
    });
  }, []);

  // Three.js 씬 구성
  useEffect(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    groupsRef.current = {};
    setLoading(true);
    setError(null);

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

        const W = canvasRef.current.clientWidth  || 680;
        const H = canvasRef.current.clientHeight || 440;

        // ── Scene ─────────────────────────────────────────────────
        const scene    = new THREE.Scene();
        scene.background = new THREE.Color(0xffffff);
        // 미세한 안개로 원거리 페이드
        scene.fog = new THREE.FogExp2(0xffffff, 0.004);

        // ── Camera (투시, 좁은 FOV → 아이소메트릭 느낌) ──────────
        const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 2000);
        const d      = radius * 1.8;
        camera.position.set(d * 0.8, -d * 0.9, d * 0.7);
        camera.lookAt(0, 0, 0);

        // ── Renderer ──────────────────────────────────────────────
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(W, H);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        canvasRef.current.appendChild(renderer.domElement);

        // ── 조명 ──────────────────────────────────────────────────
        scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const sun = new THREE.DirectionalLight(0xffffff, 0.9);
        sun.position.set(radius * 1.2, -radius * 0.5, radius * 2);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.camera.left   = -radius * 1.5;
        sun.shadow.camera.right  =  radius * 1.5;
        sun.shadow.camera.top    =  radius * 1.5;
        sun.shadow.camera.bottom = -radius * 1.5;
        scene.add(sun);
        // 반사광 (건물 반대면)
        const fill = new THREE.DirectionalLight(0xddeeff, 0.3);
        fill.position.set(-radius, radius * 0.5, radius * 0.5);
        scene.add(fill);

        // ── 지면 그리드 ────────────────────────────────────────────
        const groundGeo = new THREE.PlaneGeometry(radius * 2, radius * 2);
        const groundMat = new THREE.MeshLambertMaterial({ color: 0xf8f8f8, side: THREE.DoubleSide });
        const ground    = new THREE.Mesh(groundGeo, groundMat);
        ground.receiveShadow = true;
        scene.add(ground);

        // 격자선
        const gridHelper = new THREE.GridHelper(radius * 2, Math.ceil(radius / 5) * 2, 0xcccccc, 0xdddddd);
        gridHelper.rotation.x = Math.PI / 2;
        gridHelper.position.z  = -0.05;
        scene.add(gridHelper);

        // ── 헬퍼 함수들 ───────────────────────────────────────────

        function addMesh(
          group: import("three").Group,
          geo: import("three").BufferGeometry,
          faceHex: number,
          edgeHex: number,
          castShadow = false,
        ) {
          const mat  = new THREE.MeshLambertMaterial({ color: faceHex, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.castShadow    = castShadow;
          mesh.receiveShadow = true;
          group.add(mesh);

          // 엣지 라인 오버레이
          const edgesGeo = new THREE.EdgesGeometry(geo, 10);
          const edgeMat  = new THREE.LineBasicMaterial({ color: edgeHex, linewidth: 1 });
          group.add(new THREE.LineSegments(edgesGeo, edgeMat));
        }

        function buildingGeo(pts: [number, number][], h: number) {
          const pos: number[] = [], idx: number[] = [];
          const n = pts.length;
          // 바닥
          for (const [x, y] of pts) pos.push(x, y, 0);
          for (let i = 1; i < n - 1; i++) idx.push(0, i + 1, i);
          // 지붕
          const t = n;
          for (const [x, y] of pts) pos.push(x, y, h);
          for (let i = 1; i < n - 1; i++) idx.push(t, t + i, t + i + 1);
          // 측면
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const a = i, b = j, c = t + i, d = t + j;
            idx.push(a, b, d, a, d, c);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          geo.setIndex(idx);
          geo.computeVertexNormals();
          return geo;
        }

        function flatPolyGeo(pts: [number, number][]) {
          const pos: number[] = [], idx: number[] = [];
          for (const [x, y] of pts) pos.push(x, y, 0);
          for (let i = 1; i < pts.length - 1; i++) idx.push(0, i, i + 1);
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          geo.setIndex(idx);
          geo.computeVertexNormals();
          return geo;
        }

        function stripGeo(pts: [number, number][], hw: number) {
          const pos: number[] = [], idx: number[] = [];
          let vi = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
            const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
            if (len < 0.01) continue;
            const nx = (-dy / len) * hw, ny = (dx / len) * hw;
            pos.push(x1+nx, y1+ny, 0.02, x1-nx, y1-ny, 0.02, x2-nx, y2-ny, 0.02, x2+nx, y2+ny, 0.02);
            idx.push(vi, vi+1, vi+2, vi, vi+2, vi+3);
            vi += 4;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          geo.setIndex(idx);
          geo.computeVertexNormals();
          return geo;
        }

        // ── 레이어 그룹 생성 ──────────────────────────────────────
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
          addMesh(bGroup, buildingGeo(b.pts, b.height), LAYER_CONFIG.BUILDINGS.faceHex, LAYER_CONFIG.BUILDINGS.edgeHex, true);
          cnt++;
        }
        setBldCount(cnt);

        // 원점 마커 (대상 대지)
        const markerGeo = new THREE.CylinderGeometry(2, 2, 0.4, 24);
        markerGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        const markerMesh = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xff3333 }));
        markerMesh.position.z = 0.2;
        scene.add(markerMesh);

        // ── 마우스 궤도 회전 ──────────────────────────────────────
        let isDragging = false, lastX = 0, lastY = 0;
        let theta = Math.atan2(d * 0.8, -d * 0.9);
        let phi   = Math.atan2(d * 0.7, Math.hypot(d * 0.8, d * 0.9));
        const R   = Math.sqrt(d*d*0.8*0.8 + d*d*0.9*0.9 + d*d*0.7*0.7);

        function updateCamera() {
          const cosP = Math.cos(phi);
          camera.position.set(
            R * Math.cos(theta) * cosP,
            R * Math.sin(theta) * cosP,
            R * Math.sin(phi),
          );
          camera.lookAt(0, 0, 0);
        }
        updateCamera();

        const dom  = renderer.domElement;
        const down = (e: MouseEvent) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; };
        const up   = () => { isDragging = false; };
        const move = (e: MouseEvent) => {
          if (!isDragging) return;
          theta -= (e.clientX - lastX) * 0.008;
          phi    = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, phi + (e.clientY - lastY) * 0.006));
          lastX  = e.clientX; lastY = e.clientY;
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

        // ── 렌더 루프 ─────────────────────────────────────────────
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
    <div className="flex gap-0 w-full rounded-xl overflow-hidden border border-gray-200" style={{ height: 440 }}>
      {/* ── 3D 뷰포트 ───────────────────────────────────────────── */}
      <div className="relative flex-1 bg-white">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-white">
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              <span className="text-[12px] text-gray-400">주변 데이터 로딩 중…</span>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-white">
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
      <div className="w-[180px] shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-y-auto">
        {/* 패널 헤더 */}
        <div className="px-3 py-2.5 bg-[#F2F2F7] border-b border-gray-200">
          <p className="text-[11px] font-bold text-gray-700 leading-tight">레이어</p>
          {!loading && !error && (
            <p className="text-[10px] text-gray-400 mt-0.5">건물 {bldCount}동</p>
          )}
        </div>

        {/* 레이어 목록 */}
        <div className="flex-1">
          {LAYER_KEYS.map((key, i) => {
            const cfg = LAYER_CONFIG[key];
            return (
              <div
                key={key}
                className={`flex items-center justify-between px-3 py-2.5 ${
                  i < LAYER_KEYS.length - 1 ? "border-b border-gray-100" : ""
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {/* 레이어 색상 인디케이터 */}
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

        {/* 안내 */}
        <div className="px-3 py-2.5 border-t border-gray-100 bg-[#F2F2F7]">
          <p className="text-[10px] text-gray-400 leading-relaxed">
            레이어는 미리보기 전용<br />DAE 파일에 모두 포함
          </p>
        </div>
      </div>
    </div>
  );
}
