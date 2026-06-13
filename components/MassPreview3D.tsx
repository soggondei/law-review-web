"use client";

import { useEffect, useRef, useState } from "react";
import type { MassPreviewData } from "@/app/api/masspreview/route";

interface Props {
  lat: number;
  lng: number;
  radius: number;
}

export default function MassPreview3D({ lat, lng, radius }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
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

        // ── Scene 설정 ───────────────────────────────────────────
        const W = canvasRef.current.clientWidth || 600;
        const H = 380;

        const scene    = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);

        const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 2000);
        // 비스듬한 사선 뷰 (SketchUp 기본과 유사)
        const eye = radius * 1.6;
        camera.position.set(eye, -eye, eye * 0.8);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(W, H);
        renderer.shadowMap.enabled = true;
        canvasRef.current.appendChild(renderer.domElement);

        // ── 조명 ────────────────────────────────────────────────
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 1.0);
        sun.position.set(80, -60, 120);
        sun.castShadow = true;
        scene.add(sun);

        // ── 헬퍼: 폴리곤 → BufferGeometry (fan triangulation) ───
        function polygonGeom(pts: [number, number][], z0 = 0, z1 = 0): import("three").BufferGeometry {
          const positions: number[] = [];
          const indices:   number[] = [];
          const n = pts.length;
          // 바닥면
          for (const [x, y] of pts) positions.push(x, y, z0);
          for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1);
          if (z1 > z0) {
            // 지붕면
            const top = n;
            for (const [x, y] of pts) positions.push(x, y, z1);
            for (let i = 1; i < n - 1; i++) indices.push(top, top + i + 1, top + i);
            // 측면
            for (let i = 0; i < n; i++) {
              const j = (i + 1) % n;
              const a = i, b = j, c = top + i, d = top + j;
              indices.push(a, b, d, a, d, c);
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          geo.setIndex(indices);
          geo.computeVertexNormals();
          return geo;
        }

        // ── 폴리라인 → 평면 띠 ───────────────────────────────────
        function stripGeom(pts: [number, number][], hw: number): import("three").BufferGeometry {
          const positions: number[] = [];
          const indices:   number[] = [];
          let vi = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
            const dx = x2 - x1, dy = y2 - y1;
            const len = Math.hypot(dx, dy);
            if (len < 0.01) continue;
            const nx = (-dy / len) * hw, ny = (dx / len) * hw;
            positions.push(x1 + nx, y1 + ny, 0.01);
            positions.push(x1 - nx, y1 - ny, 0.01);
            positions.push(x2 - nx, y2 - ny, 0.01);
            positions.push(x2 + nx, y2 + ny, 0.01);
            indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
            vi += 4;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          geo.setIndex(indices);
          geo.computeVertexNormals();
          return geo;
        }

        const matBuilding  = new THREE.MeshLambertMaterial({ color: 0xc8d8e8 });
        const matParcel    = new THREE.MeshLambertMaterial({ color: 0xf0e8c8, side: THREE.DoubleSide });
        const matRoad      = new THREE.MeshLambertMaterial({ color: 0x888888, side: THREE.DoubleSide });
        const matSidewalk  = new THREE.MeshLambertMaterial({ color: 0xaaaaaa, side: THREE.DoubleSide });

        // 필지
        for (const p of data.parcels) {
          if (p.pts.length < 3) continue;
          scene.add(new THREE.Mesh(polygonGeom(p.pts), matParcel));
        }
        // 도로·보도
        for (const r of data.roads) {
          const hw = r.isSidewalk ? 0.75 : 1.5;
          const geo = stripGeom(r.pts, hw);
          if (geo.index?.count) scene.add(new THREE.Mesh(geo, r.isSidewalk ? matSidewalk : matRoad));
        }
        // 건물
        for (const b of data.buildings) {
          if (b.pts.length < 3) continue;
          const mesh = new THREE.Mesh(polygonGeom(b.pts, 0, b.height), matBuilding);
          mesh.castShadow = true;
          scene.add(mesh);
        }

        // 그리드
        const grid = new THREE.GridHelper(radius * 2, 10, 0x334455, 0x223344);
        grid.rotation.x = Math.PI / 2;
        scene.add(grid);

        // 원점 마커 (대상 필지)
        const markerGeo = new THREE.CylinderGeometry(1.5, 1.5, 0.5, 16);
        markerGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        scene.add(new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xff4444 })));

        // ── 마우스 궤도 회전 ─────────────────────────────────────
        let isDragging = false, lastX = 0, lastY = 0;
        let theta = -Math.PI / 4, phi = Math.PI / 4;
        const R = eye * Math.SQRT2;

        function updateCamera() {
          camera.position.set(
            R * Math.sin(theta) * Math.cos(phi),
            -R * Math.cos(theta) * Math.cos(phi),
            R * Math.sin(phi),
          );
          camera.lookAt(0, 0, 0);
        }
        updateCamera();

        const dom = renderer.domElement;
        const onDown = (e: MouseEvent) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; };
        const onUp   = () => { isDragging = false; };
        const onMove = (e: MouseEvent) => {
          if (!isDragging) return;
          theta += (e.clientX - lastX) * 0.01;
          phi    = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, phi - (e.clientY - lastY) * 0.01));
          lastX = e.clientX; lastY = e.clientY;
          updateCamera();
        };
        dom.addEventListener("mousedown", onDown);
        window.addEventListener("mouseup", onUp);
        window.addEventListener("mousemove", onMove);

        // ── 렌더 루프 ────────────────────────────────────────────
        let rafId = 0;
        function render() { rafId = requestAnimationFrame(render); renderer.render(scene, camera); }
        render();

        setLoading(false);

        cleanupRef.current = () => {
          cancelled = true;
          cancelAnimationFrame(rafId);
          dom.removeEventListener("mousedown", onDown);
          window.removeEventListener("mouseup", onUp);
          window.removeEventListener("mousemove", onMove);
          renderer.dispose();
          if (canvasRef.current?.contains(dom)) canvasRef.current.removeChild(dom);
        };
      } catch (e: any) {
        if (!cancelled) { setError(e.message ?? "오류"); setLoading(false); }
      }
    })();

    return () => { cleanupRef.current?.(); cleanupRef.current = null; };
  }, [lat, lng, radius]);

  return (
    <div className="relative w-full rounded-xl overflow-hidden border border-gray-700 bg-[#1a1a2e]" style={{ height: 380 }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <span className="text-[12px] text-gray-400 animate-pulse">매스 데이터 로딩 중…</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <span className="text-[12px] text-red-400">{error}</span>
        </div>
      )}
      <div ref={canvasRef} className="w-full h-full" />
      {!loading && !error && (
        <div className="absolute bottom-2 left-2 text-[10px] text-gray-500 pointer-events-none">
          드래그로 회전
        </div>
      )}
    </div>
  );
}
