"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, TileLayer, Polyline as LeafletPolyline, CircleMarker } from "leaflet";
import "leaflet/dist/leaflet.css";

interface LandUseMapProps {
  lat: number;
  lng: number;
  zoneName?: string;
  buildingHeight?: number;
}

const SHADOW_TIMES = [
  { label: "08:00", hour: 8  },
  { label: "10:00", hour: 10 },
  { label: "12:00", hour: 12 },
  { label: "14:00", hour: 14 },
  { label: "16:00", hour: 16 },
];
const SHADOW_COLORS = ["#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6"];

export default function LandUseMap({ lat, lng, zoneName, buildingHeight }: LandUseMapProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const mapRef         = useRef<LeafletMap | null>(null);
  const baseTileRef    = useRef<TileLayer | null>(null);
  const shadowLayerRef = useRef<(LeafletPolyline | CircleMarker)[]>([]);
  const [satellite, setSatellite] = useState(false);
  const [showShadow, setShowShadow] = useState(false);

  // ── 지도 초기화 ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current) return;

      const map = L.map(containerRef.current, {
        center: [lat, lng],
        zoom: 17,
        scrollWheelZoom: false,
        attributionControl: false,
        zoomControl: true,
      });
      mapRef.current = map;

      const baseLayer = L.tileLayer("/api/tile?z={z}&x={x}&y={y}", {
        maxZoom: 19,
        tileSize: 256,
        updateWhenZooming: false,
      });
      baseLayer.addTo(map);
      baseTileRef.current = baseLayer;

      (L.tileLayer.wms as Function)("/api/wms", {
        layers:      "lt_c_uq111",
        format:      "image/png",
        transparent: true,
        opacity:     0.55,
        version:     "1.3.0",
        uppercase:   true,
        tileSize:    256,
      } as any).addTo(map);

      L.circleMarker([lat, lng], {
        radius:      9,
        color:       "#1d4ed8",
        weight:      2.5,
        fillColor:   "#3b82f6",
        fillOpacity: 0.85,
      })
        .bindPopup(zoneName ? `<b>${zoneName}</b>` : "대상 대지", { offset: [0, -6] })
        .addTo(map);

      L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [lat, lng, zoneName]);

  // ── 좌표 변경 시 지도 이동 ────────────────────────────────────────────────
  useEffect(() => {
    mapRef.current?.setView([lat, lng], 17);
  }, [lat, lng]);

  // ── 위성/지도 토글 ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = baseTileRef.current;
    if (!map || !layer) return;
    const url = satellite
      ? "/api/tile?layer=satellite&z={z}&x={x}&y={y}"
      : "/api/tile?z={z}&x={x}&y={y}";
    (layer as any).setUrl(url);
  }, [satellite]);

  // ── 동지 그림자 오버레이 ─────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;

    // 기존 레이어 제거
    shadowLayerRef.current.forEach(l => l.remove());
    shadowLayerRef.current = [];

    if (!map || !showShadow || !buildingHeight || buildingHeight <= 0) return;

    (async () => {
      const [L, SunCalc] = await Promise.all([
        import("leaflet").then(m => m.default),
        import("suncalc"),
      ]);

      if (!mapRef.current) return;

      const year   = new Date().getFullYear();
      const latRad = lat * (Math.PI / 180);
      const layers: (LeafletPolyline | CircleMarker)[] = [];

      SHADOW_TIMES.forEach(({ label, hour }, i) => {
        const date   = new Date(`${year}-12-21T${String(hour).padStart(2, "0")}:00:00+09:00`);
        const sunPos = SunCalc.getPosition(date, lat, lng);

        // suncalc v3: altitude/azimuth 모두 도(°), azimuth 0=북(나침반 기준)
        // 태양 고도 2° 미만 → 그림자 의미 없음
        if (sunPos.altitude < 2) return;

        const altRad      = sunPos.altitude * (Math.PI / 180);
        const shadowLen   = buildingHeight / Math.tan(altRad);
        // 그림자 방향 = 태양 방위각 + 180° (반대 방향)
        const shadowAzRad = ((sunPos.azimuth + 180) % 360) * (Math.PI / 180);
        const shadowEast  = Math.sin(shadowAzRad);
        const shadowNorth = Math.cos(shadowAzRad);

        const endLat = lat + (shadowLen * shadowNorth) / 111320;
        const endLng = lng + (shadowLen * shadowEast) / (111320 * Math.cos(latRad));

        const color = SHADOW_COLORS[i];

        const line = L.polyline([[lat, lng], [endLat, endLng]], {
          color,
          weight:    3,
          opacity:   0.85,
          dashArray: "7 4",
        })
          .bindTooltip(
            `${label} (동지) — 그림자 ${Math.round(shadowLen)}m · 태양고도 ${Math.round(sunPos.altitude)}°`,
            { sticky: true },
          )
          .addTo(mapRef.current!);

        const dot = L.circleMarker([endLat, endLng], {
          radius:      5,
          color,
          fillColor:   color,
          fillOpacity: 0.9,
          weight:      1,
        }).addTo(mapRef.current!);

        layers.push(line, dot);
      });

      shadowLayerRef.current = layers;
    })();

    return () => {
      shadowLayerRef.current.forEach(l => l.remove());
      shadowLayerRef.current = [];
    };
  }, [showShadow, buildingHeight, lat, lng]);

  return (
    <div className="relative w-full">
      <div
        ref={containerRef}
        className="w-full rounded-lg overflow-hidden border border-gray-200"
        style={{ height: 320 }}
      />

      {/* 우상단 버튼 */}
      <div className="absolute top-2 right-2 z-[1000] flex gap-1.5">
        {!!buildingHeight && buildingHeight > 0 && (
          <button
            onClick={() => setShowShadow(s => !s)}
            title="동지(12/21) 시간대별 그림자 — 8·10·12·14·16시"
            className={`text-[11px] px-2 py-1 rounded font-medium shadow transition-colors ${
              showShadow
                ? "bg-orange-500 text-white"
                : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            {showShadow ? "☀ 그림자 ON" : "☀ 그림자"}
          </button>
        )}
        <button
          onClick={() => setSatellite(s => !s)}
          className={`text-[11px] px-2 py-1 rounded font-medium shadow transition-colors ${
            satellite ? "bg-[#1F4E79] text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
          }`}
        >
          {satellite ? "🛰 위성" : "🗺 지도"}
        </button>
      </div>

      {/* 그림자 범례 */}
      {showShadow && !!buildingHeight && buildingHeight > 0 && (
        <div className="absolute bottom-8 left-2 z-[1000] bg-white/90 rounded px-2.5 py-2 text-[10px] shadow border border-gray-200">
          <div className="font-semibold text-gray-700 mb-1.5">
            동지 그림자 · 건물 {buildingHeight}m
          </div>
          {SHADOW_TIMES.map(({ label }, i) => (
            <div key={label} className="flex items-center gap-1.5 mb-0.5">
              <span
                className="inline-block w-5 h-[2px] rounded"
                style={{ background: SHADOW_COLORS[i] }}
              />
              <span className="text-gray-600">{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
