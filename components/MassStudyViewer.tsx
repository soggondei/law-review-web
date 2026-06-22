"use client";
import { useRef, useState, useEffect } from "react";

interface FloorData { floor: number; area: number; svg: string; }
interface Stats {
  건축면적: number;
  연면적: number;
  층수: number;
  층고: number;
  총높이: number;
  is공동주택?: boolean;
  용도지역?: string;
  달성건폐율?: number;
  달성용적률?: number;
  주차대수?: number;
  정북영향층?: number | null;
  northRoadOffset?: number;
  northSectionSvg?: string;
}

export default function MassStudyViewer({ floors, stats }: { floors: FloorData[]; stats: Stats }) {
  const [activeFloor, setActiveFloor] = useState(0);
  const [activeView, setActiveView] = useState<"plan" | "section">("plan");
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const isDragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const pinchRef = useRef<{ id0: number; id1: number; dist: number } | null>(null);
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());

  useEffect(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, [activeFloor, activeView]);

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

  const hasSectionSvg = !!stats.northSectionSvg;

  return (
    <div className="mt-2">
      {/* 뷰 전환 탭 */}
      <div className="flex items-center gap-1 mb-2">
        <button
          onClick={() => setActiveView("plan")}
          className={`px-3 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
            activeView === "plan" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200 hover:border-blue-300"
          }`}
        >
          평면도
        </button>
        {hasSectionSvg && (
          <button
            onClick={() => setActiveView("section")}
            className={`px-3 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
              activeView === "section" ? "bg-amber-600 text-white border-amber-600" : "bg-white text-gray-600 border-gray-200 hover:border-amber-300"
            }`}
          >
            정북 단면도
          </button>
        )}
      </div>

      {activeView === "plan" && (
        <>
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

          {/* 2열 레이아웃: 왼쪽 SVG, 오른쪽 표 */}
          <div className="flex gap-3 items-stretch">
            {/* 왼쪽: SVG 뷰어 */}
            <div
              className="flex-1 min-w-0 relative bg-slate-50 rounded-xl border border-gray-200 overflow-hidden cursor-grab active:cursor-grabbing select-none"
              style={{ height: 420, touchAction: "none" }}
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

            {/* 오른쪽: 정북일조 표 */}
            <div className="w-52 shrink-0 flex flex-col gap-2">
              {!stats.is공동주택 ? (
                <div className="border border-gray-200 rounded-xl overflow-hidden flex flex-col" style={{ height: 420 }}>
                  <div className="bg-slate-50 px-2 py-1.5 border-b border-gray-200">
                    <div className="text-[10px] font-semibold text-slate-700">정북일조 이격거리</div>
                    <div className="text-[8px] text-slate-400">건축법시행령 §86① (10m 기준)</div>
                    {stats.용도지역 && (
                      <div className="text-[8px] text-blue-500 mt-0.5 truncate">{stats.용도지역}</div>
                    )}
                    {(stats.northRoadOffset ?? 0) > 0.5 && (
                      <div className="text-[8px] text-emerald-600 mt-0.5">§86⑥ 북측도로 {(stats.northRoadOffset ?? 0).toFixed(1)}m 적용</div>
                    )}
                  </div>

                  {/* 미적용 안내 */}
                  {stats.용도지역 && !(stats.용도지역.includes("전용주거") || stats.용도지역.includes("일반주거")) ? (
                    <div className="flex-1 flex items-center justify-center px-3">
                      <div className="text-center">
                        <div className="text-[10px] font-semibold text-amber-700 mb-1">정북일조 미적용</div>
                        <div className="text-[9px] text-amber-600">{stats.용도지역}</div>
                        <div className="text-[8px] text-gray-400 mt-1">전용·일반주거지역만 적용</div>
                      </div>
                    </div>
                  ) : (
                    <div className="overflow-y-auto flex-1">
                      <table className="w-full text-[10px]">
                        <thead className="sticky top-0">
                          <tr className="bg-blue-50 text-blue-700 font-semibold">
                            <th className="px-2 py-1.5 text-center">층</th>
                            <th className="px-2 py-1.5 text-center">높이</th>
                            <th className="px-2 py-1.5 text-center">이격</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: stats.층수 }, (_, fi) => {
                            const topH = (fi + 1) * stats.층고;
                            // §86①: 높이 10m 이하 → 1.5m, 10m 초과 → 높이/2
                            const rawSetback = topH <= 10 ? 1.5 : topH / 2;
                            // §86⑥: 북측 도로가 있으면 실효이격 = max(0, rawSetback - roadOffset)
                            const roadOff = stats.northRoadOffset ?? 0;
                            const effectiveSetback = Math.max(0, rawSetback - roadOff);
                            const coveredByRoad = roadOff > 0.5 && effectiveSetback === 0;
                            const isCurrent = fi === activeFloor;
                            const isWarn = effectiveSetback > 1.5;
                            const isImpact = stats.정북영향층 != null && fi + 1 >= stats.정북영향층;
                            return (
                              <tr
                                key={fi}
                                className={`border-t border-gray-100 ${isCurrent ? "bg-blue-50" : isImpact ? "bg-amber-50" : ""}`}
                              >
                                <td className={`px-2 py-1 text-center font-medium ${isCurrent ? "text-blue-600" : "text-gray-700"}`}>
                                  {fi + 1}F
                                  {isImpact && <span className="ml-0.5 text-[7px] text-amber-500">↓</span>}
                                </td>
                                <td className={`px-2 py-1 text-center ${isCurrent ? "text-blue-600" : "text-gray-500"}`}>
                                  {topH.toFixed(1)}m
                                </td>
                                <td className={`px-2 py-1 text-center font-semibold`}>
                                  {coveredByRoad ? (
                                    <span className="text-gray-400 line-through text-[9px]">{rawSetback.toFixed(2)}m</span>
                                  ) : (
                                    <span className={isCurrent ? "text-blue-700" : isWarn ? "text-amber-600" : "text-gray-700"}>
                                      {effectiveSetback.toFixed(2)}m
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="px-2 py-1.5 bg-slate-50 border-t border-gray-100 text-[8px] text-slate-400 space-y-0.5">
                    <div>* 10m 이하: 1.5m 이상 (§86①)</div>
                    <div>* 10m 초과: 높이×1/2 (§86①)</div>
                    <div>* 북측 도로시: 도로폭 차감 (§86⑥)</div>
                  </div>
                </div>
              ) : (
                <div className="bg-orange-50 border border-orange-200 rounded-xl px-3 py-2 text-[10px] text-orange-700">
                  <span className="font-semibold">공동주택</span> — 정북일조 미적용 · 채광기준(제61조 제2항) 별도 검토
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* 정북 단면도 뷰 */}
      {activeView === "section" && stats.northSectionSvg && (
        <div
          className="relative bg-slate-50 rounded-xl border border-amber-200 overflow-hidden cursor-grab active:cursor-grabbing select-none"
          style={{ height: 420, touchAction: "none" }}
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
            dangerouslySetInnerHTML={{ __html: stats.northSectionSvg }}
          />
          <div className="absolute bottom-2 right-2 pointer-events-none">
            <span className="text-[10px] text-gray-500 bg-white/90 rounded-md px-1.5 py-0.5 shadow-sm">
              {(scale * 100).toFixed(0)}%
            </span>
          </div>
          <button
            onClick={reset}
            className="absolute top-2 right-2 px-2 py-1 rounded-lg text-[10px] text-gray-400 border border-gray-200 bg-white/90 hover:bg-gray-50"
          >
            리셋
          </button>
        </div>
      )}

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

      {/* 달성률 + 주차 부가 정보 */}
      {(stats.달성건폐율 != null || stats.주차대수 != null) && (
        <div className="mt-1 grid grid-cols-4 gap-1">
          {stats.달성건폐율 != null && (
            <div className="bg-green-50 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-green-600">달성 건폐율</div>
              <div className="text-[11px] font-bold text-green-700">{stats.달성건폐율}%</div>
            </div>
          )}
          {stats.달성용적률 != null && (
            <div className="bg-green-50 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-green-600">달성 용적률</div>
              <div className="text-[11px] font-bold text-green-700">{stats.달성용적률}%</div>
            </div>
          )}
          {stats.주차대수 != null && (
            <div className="bg-slate-50 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-slate-500">주차 (개요)</div>
              <div className="text-[11px] font-bold text-slate-700">{stats.주차대수}대</div>
            </div>
          )}
          {stats.정북영향층 != null && (
            <div className="bg-amber-50 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-amber-600">정북일조↓시작</div>
              <div className="text-[11px] font-bold text-amber-700">{stats.정북영향층}F</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
