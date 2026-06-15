"use client";

type ScheduleItem = {
  name: string;
  category: string;
  phaseLabel: string;
  duration_months: { min: number; max: number };
  startMonth: number;
  endMonth: number;
  agency: string;
};

const PHASE_COLORS: Record<string, string> = {
  "건축심의 접수 前": "bg-orange-100 text-orange-800",
  "건축심의 완료 後~건축허가 前": "bg-yellow-100 text-yellow-800",
  "건축허가 완료 後": "bg-green-100 text-green-800",
  "착공신고 前": "bg-blue-100 text-blue-800",
  "공사 중": "bg-gray-100 text-gray-700",
};

export function ScheduleTable({ items, total }: { items: ScheduleItem[]; total: number }) {
  if (!items?.length) return null;

  const grouped: Record<string, ScheduleItem[]> = {};
  for (const item of items) {
    (grouped[item.phaseLabel] = grouped[item.phaseLabel] || []).push(item);
  }

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
        <span className="text-sm font-medium text-blue-700">⏱ 예상 총 소요기간: </span>
        <span className="text-lg font-bold text-blue-800">약 {total}개월</span>
        <span className="text-sm text-blue-600 ml-2">/ {items.length}개 항목</span>
      </div>
      {Object.entries(grouped).map(([phase, pi]) => (
        <div key={phase}>
          <div className="flex items-center gap-2 mb-2">
            <span className={`px-3 py-1 rounded-full text-[12px] font-medium ${PHASE_COLORS[phase] || "bg-gray-100 text-gray-700"}`}>{phase}</span>
            {pi.length > 1 && <span className="text-[11px] text-blue-500">🔀 동시 진행</span>}
          </div>
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-[#2E75B6] text-white">
                  <th className="px-3 py-1.5 text-left">항목</th>
                  <th className="px-2 py-1.5 text-center w-16">구분</th>
                  <th className="px-2 py-1.5 text-center w-20">기간</th>
                  <th className="px-2 py-1.5 text-center w-20">시기</th>
                  <th className="px-3 py-1.5 text-left">담당기관</th>
                </tr>
              </thead>
              <tbody>
                {pi.map((item, j) => (
                  <tr key={j} className={j % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                    <td className="px-3 py-2 font-medium text-gray-700">{item.name}</td>
                    <td className="px-2 py-2 text-center text-gray-500">{item.category}</td>
                    <td className="px-2 py-2 text-center">{item.duration_months?.min}~{item.duration_months?.max}개월</td>
                    <td className="px-2 py-2 text-center text-blue-600">D+{item.startMonth}~D+{item.endMonth}</td>
                    <td className="px-3 py-2 text-gray-500 text-[11px]">{(item.agency || "").split("\n")[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
