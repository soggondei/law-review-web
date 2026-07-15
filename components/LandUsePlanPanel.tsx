"use client";

import { useEffect, useState } from "react";

type LandUsePlanData = {
  pnu: string;
  jibunAddr: string;
  지목: string | null;
  면적: string | null;
  소유구분: string | null;
  용도지역: string[];
  기타지구: string[];
  개별공시지가: { 기준연도: string; 공시지가: string } | null;
  건폐율: { 법정최대: number; 조례: number | null } | null;
  용적률: { 법정최소: number; 법정최대: number; 조례: number | null } | null;
};

function formatPrice(val: string | null | undefined): string {
  if (!val) return "—";
  const n = parseInt(val.replace(/,/g, ""), 10);
  if (isNaN(n)) return val;
  return n.toLocaleString("ko-KR") + " 원/㎡";
}

export default function LandUsePlanPanel({ address }: { address: string }) {
  const [data, setData] = useState<LandUsePlanData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);

    fetch(`/api/land-use-plan?address=${encodeURIComponent(address)}`, {
      signal: ctrl.signal,
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.error) {
          setError(json.error);
        } else {
          setData(json);
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError("조회 실패");
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [address]);

  if (!address) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mt-3">
      <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wide mb-3">
        토지이용계획
      </div>

      {loading && (
        <div className="text-[12px] text-gray-400 animate-pulse py-4 text-center">
          토지이용계획 조회 중...
        </div>
      )}

      {error && (
        <div className="text-[12px] text-red-500 py-2">{error}</div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-3">
          {/* 왼쪽: 토지대장 */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-gray-500 border-b border-gray-100 pb-1">
              토지대장
            </div>
            <Row label="지번" value={data.jibunAddr || "—"} />
            <Row label="지목" value={data.지목 ?? "—"} />
            <Row label="면적" value={data.면적 ? `${parseFloat(data.면적).toLocaleString("ko-KR")} ㎡` : "—"} />
            <Row label="소유구분" value={data.소유구분 ?? "—"} />
            {data.개별공시지가 && (
              <Row
                label={`공시지가 (${data.개별공시지가.기준연도})`}
                value={formatPrice(data.개별공시지가.공시지가)}
              />
            )}
          </div>

          {/* 오른쪽: 용도지역/지구 + 건폐율/용적률 */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-gray-500 border-b border-gray-100 pb-1">
              용도지역 · 지구
            </div>
            <div>
              {data.용도지역.length > 0 ? (
                data.용도지역.map((z) => (
                  <span
                    key={z}
                    className="inline-block bg-blue-100 text-blue-800 text-[11px] font-medium px-2 py-0.5 rounded mr-1 mb-1"
                  >
                    {z}
                  </span>
                ))
              ) : (
                <span className="text-[12px] text-gray-400">—</span>
              )}
            </div>
            {data.기타지구.length > 0 && (
              <div>
                {data.기타지구.map((g) => (
                  <span
                    key={g}
                    className="inline-block bg-amber-100 text-amber-800 text-[11px] px-2 py-0.5 rounded mr-1 mb-1"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {(data.건폐율 || data.용적률) && (
              <>
                <div className="text-[11px] font-semibold text-gray-500 border-b border-gray-100 pb-1 mt-3">
                  건폐율 · 용적률
                </div>
                <table className="w-full text-[11px] text-gray-700 border-separate border-spacing-y-1">
                  <thead>
                    <tr>
                      <th className="text-left font-medium text-gray-400 w-16" />
                      <th className="text-right font-medium text-gray-400">법정</th>
                      <th className="text-right font-medium text-gray-400">조례</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.건폐율 && (
                      <tr>
                        <td className="text-gray-500">건폐율</td>
                        <td className="text-right font-semibold">
                          {data.건폐율.법정최대}% 이하
                        </td>
                        <td className="text-right font-semibold text-blue-700">
                          {data.건폐율.조례!= null ? `${data.건폐율.조례}%` : "—"}
                        </td>
                      </tr>
                    )}
                    {data.용적률 && (
                      <tr>
                        <td className="text-gray-500">용적률</td>
                        <td className="text-right font-semibold">
                          {data.용적률.법정최소}~{data.용적률.법정최대}%
                        </td>
                        <td className="text-right font-semibold text-blue-700">
                          {data.용적률.조례 != null ? `${data.용적률.조례}%` : "—"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-gray-400 shrink-0">{label}</span>
      <span className="text-[12px] text-gray-800 font-medium text-right break-all">{value}</span>
    </div>
  );
}
