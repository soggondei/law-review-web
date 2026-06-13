"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";

interface LandUseMapProps {
  lat: number;
  lng: number;
  zoneName?: string;
}

export default function LandUseMap({ lat, lng, zoneName }: LandUseMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<LeafletMap | null>(null);
  const baseTileRef  = useRef<TileLayer | null>(null);
  const [satellite, setSatellite] = useState(false);

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

      // ── VWorld 기본지도 (도로·건물·지적 배경) ──────────────────
      const baseLayer = L.tileLayer("/api/tile?z={z}&x={x}&y={y}", {
        maxZoom: 19,
        tileSize: 256,
        updateWhenZooming: false,
      });
      baseLayer.addTo(map);
      baseTileRef.current = baseLayer;

      // ── 토지이용계획 WMS 오버레이 ───────────────────────────────
      // lt_c_uq111: 용도지역·지구·구역 + 규제 구역 통합 레이어
      (L.tileLayer.wms as Function)("/api/wms", {
        layers:      "lt_c_uq111",
        format:      "image/png",
        transparent: true,
        opacity:     0.55,
        version:     "1.3.0",
        uppercase:   true,
        tileSize:    256,
      } as any).addTo(map);

      // ── 대상 필지 마커 ──────────────────────────────────────────
      L.circleMarker([lat, lng], {
        radius:      9,
        color:       "#1d4ed8",
        weight:      2.5,
        fillColor:   "#3b82f6",
        fillOpacity: 0.85,
      })
        .bindPopup(zoneName ? `<b>${zoneName}</b>` : "대상 대지", { offset: [0, -6] })
        .addTo(map);

      // ── 나침반/축척 ─────────────────────────────────────────────
      L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [lat, lng, zoneName]);

  // lat/lng 변경 시 지도 이동
  useEffect(() => {
    mapRef.current?.setView([lat, lng], 17);
  }, [lat, lng]);

  // 위성 토글 시 베이스 레이어 교체
  useEffect(() => {
    const map = mapRef.current;
    const layer = baseTileRef.current;
    if (!map || !layer) return;
    const url = satellite
      ? "/api/tile?layer=satellite&z={z}&x={x}&y={y}"
      : "/api/tile?z={z}&x={x}&y={y}";
    (layer as any).setUrl(url);
  }, [satellite]);

  return (
    <div className="relative w-full">
      <div
        ref={containerRef}
        className="w-full rounded-lg overflow-hidden border border-gray-200"
        style={{ height: 320 }}
      />
      <button
        onClick={() => setSatellite(s => !s)}
        className={`absolute top-2 right-2 z-[1000] text-[11px] px-2 py-1 rounded font-medium shadow transition-colors ${
          satellite ? "bg-[#1F4E79] text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
        }`}
      >
        {satellite ? "🛰 위성" : "🗺 지도"}
      </button>
    </div>
  );
}
