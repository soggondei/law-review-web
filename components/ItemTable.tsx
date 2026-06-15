"use client";

import type { Confidence } from "@/lib/judge";

export type LawItem = {
  category: string;
  항목: string;
  법령: string;
  내용: string;
  해당여부: string;
  설계기준?: string | null;
  confidence?: Confidence;
};

export function badgeColor(val: string) {
  if (!val) return "bg-gray-100 text-gray-500";
  if (val.startsWith("✅")) return "bg-green-50 text-green-700 border border-green-200";
  if (val.startsWith("⚠️")) return "bg-yellow-50 text-yellow-700 border border-yellow-200";
  if (val.startsWith("❌")) return "bg-gray-50 text-gray-400 border border-gray-200";
  return "bg-blue-50 text-blue-700 border border-blue-200";
}

const LAWS: [RegExp, string][] = [
  [/건축법 시행규칙/, "건축법 시행규칙"],
  [/건축법 시행령/, "건축법 시행령"],
  [/건축법/, "건축법"],
  [/주차장법 시행령/, "주차장법 시행령"],
  [/주차장법/, "주차장법"],
  [/국토계획법 시행령|국토의 계획/, "국토의 계획 및 이용에 관한 법률 시행령"],
  [/국토계획법/, "국토의 계획 및 이용에 관한 법률"],
  [/소방시설법/, "소방시설 설치 및 관리에 관한 법률"],
  [/화재예방법/, "화재의 예방 및 안전관리에 관한 법률"],
  [/장애인편의법|장애인노인임산부/, "장애인·노인·임산부 등의 편의증진 보장에 관한 법률"],
  [/녹색건축물법/, "녹색건축물 조성 지원법"],
  [/건설산업기본법/, "건설산업기본법"],
  [/건축물관리법/, "건축물관리법"],
  [/지하안전법/, "지하안전관리에 관한 특별법"],
  [/에너지이용합리화법/, "에너지이용 합리화법"],
  [/문화재보호법/, "문화재보호법"],
  [/경관법/, "경관법"],
  [/도시교통정비/, "도시교통정비 촉진법"],
  [/재난안전법/, "재난 및 안전관리 기본법"],
  [/환경영향평가법/, "환경영향평가법"],
  [/매장문화재/, "매장문화재 보호 및 조사에 관한 법률"],
  [/문화예술진흥법/, "문화예술진흥법"],
  [/신에너지법|신에너지 및 재생에너지/, "신에너지 및 재생에너지 개발·이용·보급 촉진법"],
  [/학교시설안전관리법/, "학교시설안전관리에 관한 법률"],
];

export function getLawUrl(법령: string): string | null {
  for (const [re, name] of LAWS) {
    if (re.test(법령)) return `https://www.law.go.kr/법령/${encodeURIComponent(name)}`;
  }
  return null;
}

export function ItemTable({ items }: { items: LawItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 mt-2">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="bg-[#1F4E79] text-white">
            <th className="px-3 py-2 text-left w-[110px]">구분</th>
            <th className="px-3 py-2 text-left">법규 내용</th>
            <th className="px-2 py-2 text-center w-[130px]">해당여부</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
              <td className="px-3 py-2 bg-blue-50/50 border-r border-gray-100 align-top">
                <div className="text-[10px] text-blue-500">{item.category}.</div>
                <div className="font-medium text-slate-700">{item.항목}</div>
                <div className="text-[10px] text-gray-400 mt-0.5 leading-tight">
                  {(() => {
                    const url = getLawUrl(item.법령);
                    return url
                      ? <a href={url} target="_blank" rel="noreferrer" className="hover:text-blue-500 hover:underline">{item.법령} ↗</a>
                      : item.법령;
                  })()}
                </div>
              </td>
              <td className="px-3 py-2 text-gray-600 align-top">
                <div>{item.내용}</div>
                {item.설계기준 && (
                  <div className="mt-1 text-[11px] text-blue-600 bg-blue-50 rounded px-2 py-1">↳ 설계기준: {item.설계기준}</div>
                )}
              </td>
              <td className="px-2 py-2 align-top">
                <span className={`inline-block px-2 py-1 rounded text-[11px] font-medium ${badgeColor(item.해당여부)}`}>{item.해당여부}</span>
                {item.confidence === "estimated" && <span className="block mt-1 text-[10px] text-amber-600 bg-amber-50 rounded px-1.5 py-0.5">🟡 추정값</span>}
                {item.confidence === "unverified" && <span className="block mt-1 text-[10px] text-red-500 bg-red-50 rounded px-1.5 py-0.5">🔴 미확인</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
