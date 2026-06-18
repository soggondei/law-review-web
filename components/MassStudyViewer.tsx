"use client";
import { useRef, useState, useEffect } from "react";

interface FloorData { floor: number; area: number; svg: string; }
interface Stats { 건축면적: number; 연면적: number; 층수: number; 층고: number; 총높이: number; is공동주택?: boolean; }

export default function MassStudyViewer({ floors, stats }: { floors: FloorData[]; stats: Stats }) {
  const [activeFloor, setActiveFloor] = useState(0);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const isDragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const pinchRef = useRef<{ id0: number; id1: number; dist: number } | null>(null);
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());

  useEffect(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, [activeFloor]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size === 1) {
      isDragging.current = true;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      pinchRef.current = null;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...activePointers.current.values()];

    if (pts.length === 2) {
      // 두 손가락 핀치 줌
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const ids = [...activePointers.current.keys()];
      if (pinchRef.current && pinchRef.current.id0 === ids[0] && pinchRef.current.id1 === ids[1]) {
        const ratio = dist / pinchRef.current.dist;
        setScale(s => Math.min(6, Math.max(0.2, s * ratio)));
      }
      pinchRef.current = { id0: ids[0], id1: ids[1], dist };
      isDragging.current = false;
    } else if (isDragging.current && pts.length === 1) {
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      setOffset(o => ({ x: o.x + dx, y: o.y + dy }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2) pinchRef.current = null;
    if (activePointers.current.size === 0) isDragging.current = false;
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    setScale(s => Math.min(6, Math.max(0.2, s * factor)));
  };

  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };

  const current = floors[activeFloor];
  if (!current) return null;

  return (
    <div className="mt-2">
      {/* 층 탭 */}
      <div className="flex items-center gap-1 mb-2 overflow-x-auto pb-0.5 select-none">
        {floors.map((f, i) => (
          <button
            key={f.floor}
            onClick={() => setActiveFloor(i)}
            className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
              i === activeFloor
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-600 border-gray-200 hover:border-blue-300"
            }`}
          >
            {f.floor}F
            <span className={`ml-1 text-[9px] ${i === activeFloor ? "text-blue-200" : "text-gray-400"}`}>
              {f.area.toFixed(0)}㎡
            </span>
          </button>
        ))}
        <button
          onClick={reset}
          className="ml-auto shrink-0 px-2 py-1 rounded-lg text-[10px] text-gray-400 border border-gray-200 hover:bg-gray-50"
        >
          리셋
        </button>
      </div>

      {/* 줌·패닝 SVG 박스 */}
      <div
        className="relative bg-slate-50 rounded-xl border border-gray-200 overflow-hidden cursor-grab active:cursor-grabbing select-none"
        style={{ height: 340, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        <div
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "center center",
            width: "100%",
            height: "100%",
            willChange: "transform",
          }}
          dangerouslySetInnerHTML={{ __html: current.svg }}
        />
        <div className="absolute bottom-2 right-2 pointer-events-none flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 bg-white/90 rounded-md px-1.5 py-0.5 shadow-sm">
            {(scale * 100).toFixed(0)}%
          </span>
          <span className="text-[9px] text-gray-400 bg-white/80 rounded-md px-1.5 py-0.5">
            스크롤 확대 · 드래그 이동
          </span>
        </div>
      </div>

      {/* 법적 규모 요약 */}
      <div className="mt-2 grid grid-cols-5 gap-1">
        {[
          { label: "건축면적", value: `${stats.건축면적}㎡` },
          { label: "연면적", value: `${stats.연면적}㎡` },
          { label: "총층수", value: `${stats.층수}층` },
          { label: "총높이", value: `${stats.총높이}m` },
          { label: "층고", value: `${stats.층고}m` },
        ].map(({ label, value }) => (
          <div key={label} className="bg-blue-50 rounded-lg p-1.5 text-center">
            <div className="text-[9px] text-blue-500">{label}</div>
            <div className="text-[11px] font-bold text-blue-700">{value}</div>
          </div>
        ))}
      </div>

      {/* 정북일조 이격거리 표 */}
      {!stats.is공동주택 ? (
        <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden">
          <div className="bg-slate-50 px-3 py-1.5 border-b border-gray-200 flex items-center gap-2">
            <span className="text-[10px] font-semibold text-slate-700">정북일조 이격거리</span>
            <span className="text-[9px] text-slate-400">건축법시행령 제86조 제1항</span>
          </div>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="bg-blue-50 text-blue-700 font-semibold">
                <th className="px-3 py-1.5 text-center">층</th>
                <th className="px-3 py-1.5 text-center">층상단높이</th>
                <th className="px-3 py-1.5 text-center">이격거리</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: stats.층수 }, (_, fi) => {
                const topH = (fi + 1) * stats.층고;
                const setback = topH <= 9 ? 1.5 : topH / 2;
                const isCurrent = fi === activeFloor;
                const isWarn = setback > 1.5;
                return (
                  <tr
                    key={fi}
                    className={`border-t border-gray-100 ${isCurrent ? "bg-blue-50" : ""}`}
                  >
                    <td className={`px-3 py-1 text-center font-medium ${isCurrent ? "text-blue-600" : "text-gray-700"}`}>
                      {fi + 1}F
                    </td>
                    <td className={`px-3 py-1 text-center ${isCurrent ? "text-blue-600" : "text-gray-500"}`}>
                      {topH.toFixed(1)}m
                    </td>
                    <td className={`px-3 py-1 text-center font-semibold ${isCurrent ? "text-blue-700" : isWarn ? "text-amber-600" : "text-gray-700"}`}>
                      {setback.toFixed(2)}m
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-3 py-1.5 bg-slate-50 border-t border-gray-100 text-[9px] text-slate-400 space-y-0.5">
            <div>* 9m 이하: 1.5m 이상 · 9m 초과: 높이×1/2</div>
            <div>* 북측에 도로가 있을 경우 도로 반대편 경계선 기준 (완화 적용)</div>
          </div>
        </div>
      ) : (
        <div className="mt-3 bg-orange-50 border border-orange-200 rounded-xl px-3 py-2 text-[10px] text-orange-700">
          <span className="font-semibold">공동주택</span> — 정북일조 사선 미적용 · 채광기준(건축법 제61조 제2항) 별도 검토
        </div>
      )}
    </div>
  );
}
