"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { judgeScaleItems, judgeDesignItems, judgePermitItems, calcAreas, calcParking, type Confidence } from "@/lib/judge";
import { generateSchedule } from "@/lib/schedule";
import type { PdfExtractResult } from "@/app/api/pdf-extract/route";

const BuildingViewer3D = dynamic(() => import("@/components/BuildingViewer3D"), {
  ssr: false,
  loading: () => (
    <div className="w-full rounded-xl bg-gray-100 flex items-center justify-center" style={{ height: 360 }}>
      <span className="text-[12px] text-gray-400 animate-pulse">3D 모델 로딩 중...</span>
    </div>
  ),
});

const LandUseMap = dynamic(() => import("@/components/LandUseMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200" style={{ height: 320 }}>
      <span className="text-[12px] text-gray-400 animate-pulse">지도 로딩 중...</span>
    </div>
  ),
});

const PdfExtractPanel = dynamic(() => import("@/components/PdfExtractPanel"), { ssr: false });

const MassPreview3D = dynamic(() => import("@/components/MassPreview3D"), {
  ssr: false,
  loading: () => (
    <div className="w-full rounded-xl bg-[#1a1a2e] flex items-center justify-center" style={{ height: 380 }}>
      <span className="text-[12px] text-gray-400 animate-pulse">매스 미리보기 로딩 중…</span>
    </div>
  ),
});

type Item = { category: string; 항목: string; 법령: string; 내용: string; 해당여부: string; 설계기준?: string | null; confidence?: Confidence; };

const USE_LIST: { group: string; items: string[] }[] = [
  { group: "단독주택",          items: ["단독주택", "다중주택", "다가구주택"] },
  { group: "공동주택",          items: ["아파트", "연립주택", "다세대주택", "기숙사"] },
  { group: "제1종근린생활시설", items: ["제1종근린생활시설", "슈퍼마켓·일용품점", "의원·치과의원·한의원", "탁구장·체육도장(1종)", "동네세탁소·이용원·미용원", "독서실·사무소(30㎡ 미만)"] },
  { group: "제2종근린생활시설", items: ["제2종근린생활시설", "일반음식점", "학원(500㎡ 미만)", "노래연습장", "단란주점", "안마시술소", "인터넷컴퓨터게임시설", "고시원", "사무소(500㎡ 미만)"] },
  { group: "문화및집회시설",    items: ["문화및집회시설", "공연장", "집회장", "관람장", "전시장", "동·식물원"] },
  { group: "종교시설",          items: ["종교시설", "종교집회장"] },
  { group: "판매시설",          items: ["판매시설", "도매시장", "소매시장·상점"] },
  { group: "운수시설",          items: ["운수시설", "여객자동차터미널", "철도시설", "공항시설", "항만시설"] },
  { group: "의료시설",          items: ["의료시설", "종합병원", "병원", "치과병원", "한방병원", "요양병원", "정신병원"] },
  { group: "교육연구시설",      items: ["교육연구시설", "학교", "교육원", "직업훈련소", "학원(500㎡ 이상)", "연구소", "도서관"] },
  { group: "노유자시설",        items: ["노유자시설", "아동관련시설", "노인복지시설", "사회복지시설"] },
  { group: "수련시설",          items: ["수련시설", "생활권수련시설", "자연권수련시설"] },
  { group: "운동시설",          items: ["운동시설", "체력단련장", "수영장", "볼링장·당구장", "골프연습장"] },
  { group: "업무시설",          items: ["업무시설", "오피스텔", "공공업무시설"] },
  { group: "숙박시설",          items: ["숙박시설", "생활숙박시설", "관광숙박시설", "호텔", "모텔"] },
  { group: "위락시설",          items: ["위락시설", "유흥주점", "무도장·무도학원"] },
  { group: "공장",              items: ["공장", "지식산업센터"] },
  { group: "창고시설",          items: ["창고시설", "물류터미널", "집배송시설"] },
  { group: "위험물저장및처리시설", items: ["위험물저장및처리시설", "주유소", "액화석유가스충전소"] },
  { group: "자동차관련시설",    items: ["자동차관련시설", "주차장", "세차장", "폐차장", "자동차영업소"] },
  { group: "동물및식물관련시설", items: ["동물및식물관련시설", "축사", "온실"] },
  { group: "관광휴게시설",      items: ["관광휴게시설", "야외음악당", "휴게소"] },
  { group: "장례시설",          items: ["장례시설", "장례식장"] },
];

function badgeColor(val: string) {
  if (!val) return "bg-gray-100 text-gray-500";
  if (val.startsWith("✅")) return "bg-green-50 text-green-700 border border-green-200";
  if (val.startsWith("⚠️")) return "bg-yellow-50 text-yellow-700 border border-yellow-200";
  if (val.startsWith("❌")) return "bg-gray-50 text-gray-400 border border-gray-200";
  return "bg-blue-50 text-blue-700 border border-blue-200";
}

function Accordion({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-200">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-4 text-left hover:bg-gray-50 transition-colors">
        <span className="font-medium text-gray-800 text-[15px]">{title}</span>
        <div className="flex items-center gap-2">
          {badge && <span className="text-sm text-blue-600 font-medium">{badge}</span>}
          <span className="text-gray-400">{open ? "▼" : "▶"}</span>
        </div>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function classify용도(용도: string): string {
  if (!용도) return "기타";
  if (["단독주택","다가구주택","아파트","연립주택","다세대주택","기숙사","공동주택"].some(k => 용도.includes(k))) return "주거";
  if (["근린생활시설","판매시설","숙박시설","위락시설","일반음식점","관광휴게시설"].some(k => 용도.includes(k))) return "상업";
  if (["업무시설","오피스텔"].some(k => 용도.includes(k))) return "업무";
  if (["공장","창고시설","위험물","지식산업센터"].some(k => 용도.includes(k))) return "공업";
  if (["의료시설","교육연구시설","노유자시설"].some(k => 용도.includes(k))) return "의료·교육";
  return "기타";
}

function classify규모(연면적: number | null): string {
  if (!연면적) return "미상";
  if (연면적 < 500) return "소규모";
  if (연면적 < 3000) return "중규모";
  return "대규모";
}

function getLawUrl(법령: string): string | null {
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
  for (const [re, name] of LAWS) {
    if (re.test(법령)) return `https://www.law.go.kr/법령/${encodeURIComponent(name)}`;
  }
  return null;
}

function ItemTable({ items }: { items: Item[] }) {
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
                  {(() => { const url = getLawUrl(item.법령); return url ? <a href={url} target="_blank" rel="noreferrer" className="hover:text-blue-500 hover:underline">{item.법령} ↗</a> : item.법령; })()}
                </div>
              </td>
              <td className="px-3 py-2 text-gray-600 align-top">
                <div>{item.내용}</div>
                {item.설계기준 && <div className="mt-1 text-[11px] text-blue-600 bg-blue-50 rounded px-2 py-1">↳ 설계기준: {item.설계기준}</div>}
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

function ScheduleTable({ items, total }: { items: any[]; total: number }) {
  if (!items?.length) return null;
  const grouped: Record<string, any[]> = {};
  for (const item of items) { (grouped[item.phaseLabel] = grouped[item.phaseLabel] || []).push(item); }
  const PC: Record<string, string> = {
    "건축심의 접수 前": "bg-orange-100 text-orange-800",
    "건축심의 완료 後~건축허가 前": "bg-yellow-100 text-yellow-800",
    "건축허가 완료 後": "bg-green-100 text-green-800",
    "착공신고 前": "bg-blue-100 text-blue-800",
    "공사 중": "bg-gray-100 text-gray-700",
  };
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
            <span className={`px-3 py-1 rounded-full text-[12px] font-medium ${PC[phase] || "bg-gray-100 text-gray-700"}`}>{phase}</span>
            {pi.length > 1 && <span className="text-[11px] text-blue-500">🔀 동시 진행</span>}
          </div>
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-[12px]">
              <thead><tr className="bg-[#2E75B6] text-white">
                <th className="px-3 py-1.5 text-left">항목</th>
                <th className="px-2 py-1.5 text-center w-16">구분</th>
                <th className="px-2 py-1.5 text-center w-20">기간</th>
                <th className="px-2 py-1.5 text-center w-20">시기</th>
                <th className="px-3 py-1.5 text-left">담당기관</th>
              </tr></thead>
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

// 점-다각형 내부 판정 (ray-casting)
function pipTest(pt: [number, number], poly: [number, number][]): boolean {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export default function Home() {
  const [address, setAddress] = useState("");
  const [용도목록, set용도목록] = useState<string[]>([]);
  const [용도입력, set용도입력] = useState("");
  const 용도 = 용도목록.join(" + "); // derived — judge 함수들의 .includes() 체크에 그대로 사용
  const [행위, set행위] = useState<"신축" | "대수선" | "용도변경">("신축");
  const [지하층입력, set지하층입력] = useState(0);
  const [세대수입력, set세대수입력] = useState(0);
  const [대수선옵션, set대수선옵션] = useState({ 체크항목: [] as number[], 해체: false, 전체해체: false, 준공연도: "", 리모델링활성화: false });
  const [용도변경옵션, set용도변경옵션] = useState({ 기존용도: "", 변경유형: "" as "" | "동일군" | "상위군" | "하위군" | "타군" });
  const [loading, setLoading] = useState(false);
  const [apiResult, setApiResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<{ roadAddr: string; jibunAddr: string }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showUseSuggestions, setShowUseSuggestions] = useState(false);
  const [층수입력폼, set층수입력폼] = useState(0);
  const [editParams, setEditParams] = useState({ 층수: 0, 층수직접입력: false, 대지면적: 0, 건축면적입력: 0, 연면적입력: 0, 지하층: 0, 필로티: false, 높이: 0, 구조: "RC", 북측이격: 0, 오피스텔전용면적: 0 });
  const [notionSaving, setNotionSaving] = useState(false);
  const [notionUrl, setNotionUrl] = useState<string | null>(null);
  const [showFolderPanel, setShowFolderPanel] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [inputStep, setInputStep] = useState<1|2>(1);
  const [용도별면적, set용도별면적] = useState<Record<string, number>>({});
  const [lawCheck, setLawCheck] = useState<{ laws: {name:string; amendDate:string|null; recent:boolean}[]; checkedAt:string; recentCount:number } | null>(null);
  const [lawCheckLoading, setLawCheckLoading] = useState(false);
  const [parcelData, setParcelData] = useState<{ localCoords: [number,number][]; bboxAspect: number } | null>(null);
  const [surroundings, setSurroundings] = useState<import("@/components/BuildingViewer3D").SurroundingContext | null>(null);
  const [siteFromOSM, setSiteFromOSM] = useState(false); // 대지 형상을 OSM에서 가져왔는지 여부
  const [pdfFloors, setPdfFloors] = useState<PdfExtractResult | null>(null);

  // ── 합필 시나리오 ──────────────────────────────────────────────────────────
  type MergePart = { id: number; address: string; 용도지역?: string; 대지면적?: number; status: 'idle'|'loading'|'ok'|'error' };
  const [합필모드, set합필모드] = useState(false);
  const [합필필지들, set합필필지들] = useState<MergePart[]>([]);
  const [합필주필지, set합필주필지] = useState<{ 용도지역?: string; 대지면적?: number; status: 'idle'|'loading'|'ok'|'error' }>({ status: 'idle' });
  const 합필id카운터 = useRef(0);
  const 합필타이머들 = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  async function lookupParcelInfo(addr: string) {
    const res = await fetch(`/api/parcel-lookup?address=${encodeURIComponent(addr)}`);
    if (!res.ok) throw new Error();
    return res.json() as Promise<{ 용도지역: string | null; 대지면적: number | null }>;
  }

  async function enable합필모드() {
    set합필모드(true);
    if (!address) return;
    set합필주필지({ status: 'loading' });
    try {
      const d = await lookupParcelInfo(address);
      set합필주필지({ 용도지역: d.용도지역 ?? undefined, 대지면적: d.대지면적 ?? undefined, status: 'ok' });
    } catch {
      set합필주필지({ status: 'error' });
    }
  }

  function add합필필지() {
    const id = ++합필id카운터.current;
    set합필필지들(prev => [...prev, { id, address: "", status: 'idle' }]);
  }

  function update합필Address(id: number, addr: string) {
    set합필필지들(prev => prev.map(p => p.id === id ? { ...p, address: addr, status: 'idle' as const, 용도지역: undefined, 대지면적: undefined } : p));
    if (합필타이머들.current[id]) clearTimeout(합필타이머들.current[id]);
    if (!addr || addr.length < 4) return;
    합필타이머들.current[id] = setTimeout(async () => {
      set합필필지들(prev => prev.map(p => p.id === id ? { ...p, status: 'loading' as const } : p));
      try {
        const d = await lookupParcelInfo(addr);
        set합필필지들(prev => prev.map(p => p.id === id ? { ...p, 용도지역: d.용도지역 ?? undefined, 대지면적: d.대지면적 ?? undefined, status: 'ok' as const } : p));
      } catch {
        set합필필지들(prev => prev.map(p => p.id === id ? { ...p, status: 'error' as const } : p));
      }
    }, 700);
  }

  const 합필총면적 = 합필모드
    ? (합필주필지.대지면적 ?? 0) + 합필필지들.filter(p => p.status === 'ok').reduce((s, p) => s + (p.대지면적 ?? 0), 0)
    : 0;

  const filteredUseGroups = USE_LIST.map(g => ({
    group: g.group,
    items: 용도입력.trim() ? g.items.filter(i => i.includes(용도입력.trim())) : g.items,
  })).filter(g => g.items.length > 0 && !용도목록.includes(g.group));

  const searchAddress = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); setShowSuggestions(false); return; }
    try {
      const res = await fetch(`/api/address-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setSuggestions(data);
      setShowSuggestions(data.length > 0);
    } catch { setSuggestions([]); }
  }, []);

  // 클라이언트 실시간 재계산
  const computed = useMemo(() => {
    if (!apiResult?.baseData) return null;
    const { effectiveRule, 기타지구, siNm, zoneName } = apiResult.baseData;
    const { 층수, 대지면적, 지하층, 필로티 } = editParams;
    const areas = effectiveRule && 대지면적
      ? calcAreas(대지면적, effectiveRule.건폐율, effectiveRule.용적률, 필로티)
      : null;
    const 최대연면적 = areas?.최대연면적 ?? 0;
    const 건축면적v = editParams.건축면적입력;
    const 연면적v = editParams.연면적입력;
    // 우선순위: 연면적 직접입력 > 건축면적×층수 > 대지×용적률
    const 계획연면적 = 연면적v > 0 ? 연면적v
      : 건축면적v > 0 ? Math.floor(건축면적v * 층수 * 100) / 100
      : 최대연면적;
    const 건폐율초과 = 건축면적v > 0 && !!areas && 건축면적v > areas.최대건축면적;
    const 용적률초과 = 연면적v > 0 && 연면적v > 최대연면적;
    // OSM 도로 데이터에서 가장 가까운 도로 폭 추출 (parcel 중심 기준 30m 이내)
    const 인접도로폭 = (() => {
      if (!surroundings?.roads?.length) return undefined;
      // 로컬 좌표 [0,0]에서 가장 가까운 도로의 폭 반환
      let minDist = Infinity, closestWidth = 0;
      for (const road of surroundings.roads) {
        for (const [rx, ry] of road.coords) {
          const d = Math.sqrt(rx * rx + ry * ry);
          if (d < minDist) { minDist = d; closestWidth = road.width; }
        }
      }
      return minDist < 30 ? closestWidth : undefined;
    })();
    const scaleItems = judgeScaleItems({
      대지면적, 연면적: 계획연면적, 층수,
      용도: apiResult.용도 || "", 용도지역: zoneName || "", 기타지구,
      건폐율: effectiveRule?.건폐율, 용적률: effectiveRule?.용적률,
      최대건축면적: areas?.최대건축면적, 최대연면적,
      세대수: apiResult.baseData?.세대수 ?? 0,
      북측이격: editParams.북측이격 || undefined,
      인접도로폭,
    });
    const 층수추정 = !editParams.층수직접입력;
    const designItems = judgeDesignItems({ 연면적: 계획연면적, 층수, 용도: apiResult.용도 || "", 대지면적, 지하층, 세대수: apiResult.baseData?.세대수 ?? 0, 기타지구, 높이: editParams.높이 || undefined, 구조: editParams.구조, 시도: siNm, 층수추정, 오피스텔전용면적: editParams.오피스텔전용면적 || undefined });
    const permitItems = judgePermitItems({ 연면적: 계획연면적, 층수, 용도: apiResult.용도 || "", 대지면적, 기타지구, 시도: siNm, 지하층, 세대수: apiResult.baseData?.세대수 ?? 0, 층수추정, 지목: apiResult.baseData?.지목 ?? "", 교육환경구역: apiResult.baseData?.교육환경구역 ?? null });
    const { schedule: scheduleItems, totalMonths: scheduleTotalMonths } = generateSchedule({
      용도: apiResult.용도 || "", 연면적: 계획연면적, 층수, 대지면적,
      지하굴착깊이: 지하층 * 4, 기타지구, 시도: siNm,
    });
    // ── 복합용도 면적 배분 → 주차 재계산 ──────────────────────────────────────
    let 복합주차: { details: {용도:string; 면적:number; 대수:number; 근거:string}[]; 총대수:number } | null = null;
    if (용도목록.length > 1 && Object.values(용도별면적).some(v => v > 0)) {
      const details: {용도:string; 면적:number; 대수:number; 근거:string}[] = [];
      let 총 = 0;
      for (const u of 용도목록) {
        const area = 용도별면적[u] || 0;
        if (area <= 0) continue;
        const 공동 = ["아파트","연립주택","다세대주택","기숙사"].some(k => u.includes(k));
        const pk = calcParking(u, area, 공동 ? (apiResult.baseData?.세대수 ?? 0) : 0, siNm);
        if (typeof pk?.대수 === "number") { details.push({ 용도: u, 면적: area, 대수: pk.대수, 근거: pk.근거 }); 총 += pk.대수; }
      }
      if (details.length > 0) {
        복합주차 = { details, 총대수: 총 };
        // 부설주차장 항목 오버라이드
        const idx = designItems.findIndex((i: any) => i.항목 === "부설주차장");
        if (idx >= 0) {
          const 장애인 = Math.max(1, Math.ceil(총 * 0.02));
          designItems[idx] = {
            ...designItems[idx],
            내용: `복합용도 용도별 합산 → 최소 **${총}대** (장애인 **${장애인}면**)\n${details.map(d => `· ${d.용도} ${d.면적}㎡: ${d.대수}대 (${d.근거})`).join("\n")}`,
            해당여부: `✅ 합산 ${총}대, 장애인 ${장애인}면 이상`,
            설계기준: "용도별 면적 배분 재산정. 일반 2.5m×5.0m, 장애인 3.3m×5.0m",
          };
        }
      }
    }

    return { areas, scaleItems, designItems, permitItems, scheduleItems, scheduleTotalMonths, 건폐율초과, 용적률초과, 계획연면적, 복합주차 };
  }, [apiResult, editParams, 용도별면적, 용도목록, surroundings]);

  async function handleAnalyze() {
    if (!address) { setError("주소를 입력해주세요"); return; }
    setLoading(true); setError(""); setApiResult(null);
    try {
      const body: Record<string, unknown> = { address, 용도, 행위, 지하층입력, 세대수입력, 대수선옵션: 행위 === "대수선" ? 대수선옵션 : null };
      if (합필모드 && 합필총면적 > 0) body.면적 = 합필총면적;
      const res = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "분석 실패");
      setApiResult(data);
      setEditParams({
        층수: data.추정층수 || 0,
        층수직접입력: false,
        대지면적: data.baseData?.대지면적 || 0,
        지하층: data.지하층 || 0,
        필로티: false,
        건축면적입력: 0,
        연면적입력: 0,
        높이: 0,
        구조: data.baseData?.구조 ?? "RC",
        북측이격: 0,
        오피스텔전용면적: 0,
      });
      // 대수선: 건축물대장 준공일 자동 입력
      if (행위 === "대수선" && data.baseData?.준공일 && !대수선옵션.준공연도) {
        const 연도 = String(data.baseData.준공일).slice(0, 4);
        if (연도.length === 4) set대수선옵션(o => ({ ...o, 준공연도: 연도 }));
      }
      // 필지 폴리곤 비동기 조회
      setParcelData(null);
      setSiteFromOSM(false);
      if (data.addrInfo?.pnu) {
        fetch(`/api/parcel?pnu=${data.addrInfo.pnu}`)
          .then(r => r.json())
          .then(d => { if (!d.error) setParcelData(d); })
          .catch(() => {});
      }
      // 주변 건물·도로 컨텍스트 비동기 조회 (OSM)
      setSurroundings(null);
      setSiteFromOSM(false);
      if (data.coords?.lat && data.coords?.lng) {
        fetch(`/api/context?lat=${data.coords.lat}&lng=${data.coords.lng}`)
          .then(r => r.json())
          .then(d => {
            if (d.error) {
              setSurroundings({ buildings: [], roads: [] });
              return;
            }
            // ── 대지 형상: 조회 좌표를 포함하는 건물 폴리곤을 찾아 사용
            const siteBldg = d.buildings.find((b: { coords: [number,number][] }) =>
              pipTest([0, 0], b.coords)
            );
            if (siteBldg) {
              const cx = siteBldg.coords.reduce((s: number, p: [number,number]) => s + p[0], 0) / siteBldg.coords.length;
              const cy = siteBldg.coords.reduce((s: number, p: [number,number]) => s + p[1], 0) / siteBldg.coords.length;
              const centered: [number,number][] = siteBldg.coords.map(([x, y]: [number,number]) => [x - cx, y - cy]);
              const xs = centered.map((p: [number,number]) => p[0]);
              const ys = centered.map((p: [number,number]) => p[1]);
              setParcelData({
                localCoords: centered,
                bboxAspect: (Math.max(...xs) - Math.min(...xs)) / Math.max(Math.max(...ys) - Math.min(...ys), 0.1),
              });
              setSiteFromOSM(true);
              // 대지 건물은 주변 건물 목록에서 제외하고 좌표를 parcel 기준으로 통일
              const offsetBldgs = d.buildings
                .filter((b: unknown) => b !== siteBldg)
                .map((b: { coords: [number,number][]; height: number }) => ({
                  ...b,
                  coords: b.coords.map(([x, y]: [number,number]) => [x - cx, y - cy] as [number,number]),
                }));
              const offsetRoads = d.roads.map((r: { coords: [number,number][]; width: number }) => ({
                ...r,
                coords: r.coords.map(([x, y]: [number,number]) => [x - cx, y - cy] as [number,number]),
              }));
              setSurroundings({ buildings: offsetBldgs, roads: offsetRoads });
            } else {
              setSurroundings(d);
            }
          })
          .catch(() => { setSurroundings({ buildings: [], roads: [] }); });
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function openFolderPanel() {
    if (!apiResult || !computed) return;
    const 구군 = apiResult.addrInfo?.sggNm ?? apiResult.baseData?.siNm ?? "";
    const 주용도 = 용도목록[0] ?? 용도 ?? "";
    if (!folderName) setFolderName([구군, 행위, 주용도].filter(Boolean).join(" "));
    setShowFolderPanel(true);
  }

  async function handleNotionSave(folder: string) {
    if (!apiResult || !computed) return;
    setNotionSaving(true);
    setShowFolderPanel(false);
    try {
      if (!localStorage.getItem("notionSetupDone")) {
        await fetch("/api/notion/setup", { method: "POST" });
        localStorage.setItem("notionSetupDone", "1");
      }
      const res = await fetch("/api/notion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...apiResult, computed, address, folderName: folder }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "저장 실패");
      setNotionUrl(data.url);
    } catch (e: any) {
      alert(`Notion 저장 실패: ${e.message}`);
    } finally {
      setNotionSaving(false);
    }
  }

  async function checkLaws() {
    setLawCheckLoading(true);
    try {
      const res = await fetch("/api/law-check");
      const data = await res.json();
      setLawCheck(data);
    } catch { /* ignore */ }
    finally { setLawCheckLoading(false); }
  }

  const [cadLoading, setCadLoading] = useState(false);
  const [cadRadius, setCadRadius] = useState<30 | 50 | 100>(30);
  const [objLoading, setObjLoading] = useState(false);
  const [daeLoading, setDaeLoading] = useState(false);

  async function handleCadDownload() {
    if (!r?.coords?.lat || !r?.coords?.lng) return;
    setCadLoading(true);
    try {
      const params = new URLSearchParams({
        lat: String(r.coords.lat),
        lng: String(r.coords.lng),
        addr: address,
        radius: String(cadRadius),
      });
      const res = await fetch(`/api/cadexport?${params}`);
      if (!res.ok) { alert("CAD 생성 실패"); return; }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `지적도_${address.slice(0, 15)}_${cadRadius}m.dxf`;
      a.click();
    } catch { alert("CAD 다운로드 오류"); }
    finally { setCadLoading(false); }
  }

  async function handleObjDownload() {
    if (!r?.coords?.lat || !r?.coords?.lng) return;
    setObjLoading(true);
    try {
      const params = new URLSearchParams({
        lat: String(r.coords.lat),
        lng: String(r.coords.lng),
        addr: address,
        radius: String(cadRadius),
      });
      const res = await fetch(`/api/objexport?${params}`);
      if (!res.ok) { alert("OBJ 생성 실패"); return; }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `지적도_${address.slice(0, 15)}_${cadRadius}m.obj`;
      a.click();
    } catch { alert("OBJ 다운로드 오류"); }
    finally { setObjLoading(false); }
  }

  async function handleDaeDownload() {
    if (!r?.coords?.lat || !r?.coords?.lng) return;
    setDaeLoading(true);
    try {
      const params = new URLSearchParams({
        lat: String(r.coords.lat), lng: String(r.coords.lng),
        addr: address, radius: String(cadRadius),
      });
      const res = await fetch(`/api/massexport?${params}`);
      if (!res.ok) { alert("DAE 생성 실패"); return; }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `매스_${address.slice(0, 15)}_${cadRadius}m.dae`;
      a.click();
    } catch { alert("DAE 다운로드 오류"); }
    finally { setDaeLoading(false); }
  }

  async function handleDownload() {
    if (!apiResult || !computed) return;
    const res = await fetch("/api/docx", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...apiResult,
        areas: computed.areas,
        scaleItems: computed.scaleItems,
        designItems: computed.designItems,
        permitItems: computed.permitItems,
        scheduleItems: computed.scheduleItems,
        scheduleTotalMonths: computed.scheduleTotalMonths,
        연락처: apiResult.연락처,
        구청부서: apiResult.구청부서,
        시청부서: apiResult.시청부서,
        address,
      }),
    });
    if (!res.ok) { alert("DOCX 생성 실패"); return; }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `법규검토서_${address.slice(0, 15)}.docx`;
    a.click();
  }

  const r = apiResult;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* ── 헤더 ── */}
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200 px-4 flex items-center justify-between shadow-sm h-14 shrink-0">
        <div>
          <h1 className="text-[15px] font-bold text-[#1F4E79]">건축 법규검토</h1>
          <p className="text-[10px] text-gray-400">자동화 분석 시스템</p>
        </div>
        {r && computed && (
          <div className="flex items-center gap-2">
            <button onClick={handleDownload} className="bg-[#2E75B6] text-white text-[12px] px-3 py-1.5 rounded-lg font-medium hover:bg-[#1F4E79] transition-colors">📄 DOCX</button>
            {r?.coords?.lat && (
              <div className="flex items-center gap-1">
                <div className="flex rounded-lg overflow-hidden border border-[#4E7B3C]">
                  {([30, 50, 100] as const).map(v => (
                    <button key={v} onClick={() => setCadRadius(v)}
                      className={`text-[11px] px-2 py-1.5 font-medium transition-colors ${cadRadius === v ? "bg-[#4E7B3C] text-white" : "bg-white text-[#4E7B3C] hover:bg-green-50"}`}>
                      {v}m
                    </button>
                  ))}
                </div>
                <button onClick={handleCadDownload} disabled={cadLoading} className="bg-[#4E7B3C] text-white text-[12px] px-3 py-1.5 rounded-lg font-medium hover:bg-[#3A5C2C] disabled:opacity-60 transition-colors">
                  {cadLoading ? "생성 중…" : "📐 CAD"}
                </button>
                <button onClick={handleObjDownload} disabled={objLoading} className="bg-[#5B4E8C] text-white text-[12px] px-3 py-1.5 rounded-lg font-medium hover:bg-[#47396E] disabled:opacity-60 transition-colors">
                  {objLoading ? "생성 중…" : "📦 OBJ"}
                </button>
                <button onClick={handleDaeDownload} disabled={daeLoading} className="bg-[#7B3C3C] text-white text-[12px] px-3 py-1.5 rounded-lg font-medium hover:bg-[#5C2C2C] disabled:opacity-60 transition-colors">
                  {daeLoading ? "생성 중…" : "🏗 DAE"}
                </button>
              </div>
            )}
            <button onClick={openFolderPanel} disabled={notionSaving} className="bg-black text-white text-[12px] px-3 py-1.5 rounded-lg font-medium hover:bg-gray-800 disabled:opacity-60 transition-colors">
              {notionSaving ? "저장 중…" : "🗒 Notion"}
            </button>
            <button onClick={() => window.print()} className="bg-gray-100 text-gray-600 text-[12px] px-3 py-1.5 rounded-lg font-medium hover:bg-gray-200 transition-colors">🖨</button>
          </div>
        )}
      </header>

      {/* ── 2열 본문 ── */}
      <div className="flex flex-1">

      {/* ──────────────── 사이드바 ──────────────── */}
      <aside className="w-72 shrink-0 sticky top-14 self-start h-[calc(100vh-56px)] bg-white border-r border-gray-200 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* ── 사업 개요 입력 ── */}
          <div>
            <h2 className="text-[11px] font-bold text-gray-400 uppercase tracking-wide mb-3">사업 개요</h2>
            {/* 단계 표시 */}
            <div className="flex items-center gap-2 mb-3">
              <div className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${inputStep === 1 ? "bg-[#1F4E79] text-white" : "bg-green-100 text-green-700"}`}>
                <span>{inputStep > 1 ? "✓" : "1"}</span><span className="ml-0.5">기본 정보</span>
              </div>
              <div className="flex-1 h-px bg-gray-200" />
              <div className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${inputStep === 2 ? "bg-[#1F4E79] text-white" : "bg-gray-100 text-gray-400"}`}>
                <span>2</span><span className="ml-0.5">상세 설정</span>
              </div>
            </div>

          {/* ── STEP 1: 기본 정보 ── */}
          {inputStep === 1 && <>
          <div className="relative">
            <label className="text-[12px] text-gray-500 mb-1 block">위치 (주소 검색)</label>
            <input value={address}
              onChange={e => {
                setAddress(e.target.value);
                if (debounceRef.current) clearTimeout(debounceRef.current);
                debounceRef.current = setTimeout(() => searchAddress(e.target.value), 300);
              }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder="도로명 또는 지번 주소"
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-[14px] text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              onKeyDown={e => { if (e.key === "Enter") { if (address && 용도목록.length > 0) { setError(""); setInputStep(2); } else setError("주소와 용도를 입력해주세요"); } }} />
            {showSuggestions && suggestions.length > 0 && (
              <ul className="absolute z-20 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                {suggestions.map((s, i) => (
                  <li key={i}
                    onMouseDown={() => { setAddress(s.roadAddr); setSuggestions([]); setShowSuggestions(false); }}
                    className="px-3 py-2.5 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-0">
                    <div className="text-[13px] text-gray-800">{s.roadAddr}</div>
                    <div className="text-[11px] text-gray-400">{s.jibunAddr}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── 합필 시나리오 ── */}
          <div className="flex justify-end mt-1.5">
            <button
              type="button"
              onClick={() => { if (합필모드) { set합필모드(false); set합필필지들([]); set합필주필지({ status: 'idle' }); } else { enable합필모드(); } }}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${합필모드 ? 'bg-amber-100 border-amber-400 text-amber-800 font-semibold' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700'}`}
            >
              {합필모드 ? '✕ 합필 해제' : '합필 필지 추가 +'}
            </button>
          </div>

          {합필모드 && (
            <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2.5">
              <div className="text-[11px] font-bold text-amber-800 tracking-wide">합필 시나리오</div>

              {/* 주 필지 (읽기 전용) */}
              <div className="flex items-center justify-between text-[12px]">
                <div className="flex items-center gap-1 flex-1 min-w-0">
                  <span className="text-[10px] bg-amber-200 text-amber-800 rounded px-1 shrink-0">주</span>
                  <span className="text-gray-700 truncate">{address || "주소 미입력"}</span>
                </div>
                <span className="text-gray-600 font-medium ml-2 shrink-0">
                  {합필주필지.status === 'loading' ? <span className="text-gray-400 animate-pulse">조회 중…</span> :
                   합필주필지.status === 'ok' ? `${합필주필지.대지면적 != null ? 합필주필지.대지면적.toFixed(0) : '?'}㎡` :
                   합필주필지.status === 'error' ? <span className="text-red-400 text-[11px]">조회 실패</span> : '—'}
                </span>
              </div>

              {/* 추가 필지들 */}
              {합필필지들.map(part => (
                <div key={part.id} className="space-y-1">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] bg-gray-200 text-gray-600 rounded px-1 shrink-0">인접</span>
                    <input
                      value={part.address}
                      onChange={e => update합필Address(part.id, e.target.value)}
                      placeholder="인접 필지 주소"
                      className="flex-1 text-[12px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-100"
                    />
                    <button type="button" onClick={() => set합필필지들(prev => prev.filter(p => p.id !== part.id))} className="text-gray-300 hover:text-red-400 text-[16px] px-0.5 leading-none">×</button>
                  </div>
                  {part.status === 'loading' && <div className="text-[11px] text-gray-400 pl-6 animate-pulse">조회 중…</div>}
                  {part.status === 'ok' && (
                    <div className="flex items-center gap-1.5 pl-6 text-[11px]">
                      <span className="text-green-700 font-medium">{part.대지면적 != null ? `${part.대지면적.toFixed(0)}㎡` : '면적 미확인'}</span>
                      {part.용도지역 && <span className="text-gray-400">{part.용도지역}</span>}
                      {합필주필지.용도지역 && part.용도지역 && part.용도지역 !== 합필주필지.용도지역 && (
                        <span className="text-red-600 bg-red-50 border border-red-200 rounded px-1">⚠ 용도지역 상이</span>
                      )}
                    </div>
                  )}
                  {part.status === 'error' && <div className="text-[11px] text-red-400 pl-6">주소 조회 실패 — 직접 확인 필요</div>}
                </div>
              ))}

              <button type="button" onClick={add합필필지} className="text-[11px] text-amber-700 hover:text-amber-800 font-semibold">+ 인접 필지 추가</button>

              {/* 합계 */}
              {(합필주필지.status === 'ok' || 합필필지들.some(p => p.status === 'ok')) && (
                <div className="border-t border-amber-200 pt-2 flex items-center justify-between">
                  <span className="text-[11px] font-bold text-amber-800">합필 총 대지면적</span>
                  <span className="text-[13px] font-bold text-amber-900">
                    {합필총면적 > 0 ? `${합필총면적.toFixed(0)}㎡` : '—'}
                  </span>
                </div>
              )}
              <p className="text-[10px] text-amber-600">용도지역이 동일한 연접 필지에 한해 합필 가능. 분석 시 합필 면적 기준으로 건폐율·용적률을 재산정합니다.</p>
            </div>
          )}

          <div className="relative">
            <label className="text-[12px] text-gray-500 mb-1 block">
              검토 용도
              {용도목록.length > 1 && <span className="ml-2 text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-semibold">복합용도</span>}
            </label>
            {/* 선택된 용도 칩 */}
            {용도목록.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {용도목록.map((u, i) => (
                  <span key={i} className="flex items-center gap-1 bg-[#1F4E79] text-white text-[12px] font-medium px-2.5 py-1 rounded-full">
                    {u}
                    <button type="button" onMouseDown={e => { e.preventDefault(); set용도목록(l => l.filter((_, j) => j !== i)); }}
                      className="ml-0.5 text-blue-200 hover:text-white leading-none text-[14px]">×</button>
                  </span>
                ))}
              </div>
            )}
            <input value={용도입력}
              onChange={e => { set용도입력(e.target.value); setShowUseSuggestions(true); }}
              onFocus={() => setShowUseSuggestions(true)}
              onBlur={() => setTimeout(() => setShowUseSuggestions(false), 150)}
              placeholder={용도목록.length > 0 ? "+ 용도 추가 (복합용도)" : "예: 제2종근린생활시설, 아파트"}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-[14px] text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
            {showUseSuggestions && filteredUseGroups.length > 0 && (
              <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden max-h-64 overflow-y-auto">
                {filteredUseGroups.map(g => (
                  <div key={g.group}>
                    <div className="px-3 py-1.5 text-[10px] font-bold text-[#1F4E79] bg-blue-50 sticky top-0">{g.group}</div>
                    {g.items.filter(item => !용도목록.includes(item)).map(item => (
                      <div key={item}
                        onMouseDown={() => { set용도목록(l => [...l, item]); set용도입력(""); setShowUseSuggestions(false); }}
                        className="px-4 py-2 text-[13px] text-gray-700 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-0">
                        {item}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-[12px] text-gray-500 mb-2 block">행위</label>
            <div className="flex gap-2">
              {(["신축", "대수선", "용도변경"] as const).map(b => (
                <button key={b} onClick={() => set행위(b)}
                  className={`flex-1 py-2 rounded-xl text-[13px] font-medium transition-colors ${행위 === b ? "bg-[#1F4E79] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{b}</button>
              ))}
            </div>
          </div>
          {error && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-[13px] text-red-600">{error}</div>}
          <div className="pt-3">
            <button onClick={() => { if (!address) { setError("주소를 입력해주세요"); return; } if (용도목록.length === 0) { setError("용도를 하나 이상 선택해주세요"); return; } setError(""); setInputStep(2); }}
              className="w-full bg-[#1F4E79] text-white py-3 rounded-xl font-semibold text-[15px] hover:bg-[#1a3f63] transition-colors">
              다음 단계 →
            </button>
          </div>
          </>}

          {/* ── STEP 2: 상세 설정 ── */}
          {inputStep === 2 && <>
          <div className="bg-blue-50 rounded-xl px-3 py-2 text-[12px] text-blue-700 flex items-center justify-between">
            <span className="truncate">{address} · <strong>{용도 || "용도 미지정"}</strong> · {행위}</span>
            <button onClick={() => setInputStep(1)} className="shrink-0 ml-2 text-[11px] text-blue-500 hover:underline">수정</button>
          </div>

          {행위 !== "신축" && (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              {/* 내부 탭 헤더 */}
              <div className="flex border-b border-gray-200 bg-gray-50">
                {(["대수선", "용도변경"] as const).map(tab => (
                  <button key={tab} onClick={() => set행위(tab)}
                    className={`flex-1 py-2.5 text-[12px] font-semibold transition-colors ${
                      행위 === tab
                        ? tab === "대수선"
                          ? "bg-amber-50 text-amber-700 border-b-2 border-amber-500"
                          : "bg-blue-50 text-blue-700 border-b-2 border-blue-500"
                        : "text-gray-400 hover:text-gray-600"
                    }`}>
                    {tab === "대수선" ? "🔧 대수선 상세" : "🔄 용도변경 상세"}
                  </button>
                ))}
              </div>

              {/* 대수선 탭 */}
              {행위 === "대수선" && (
                <div className="p-3 space-y-3 bg-amber-50/40">
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1.5">해당 항목 선택 (건축법 시행령 제3조의2)</div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      {["①내력벽","②기둥","③보","④지붕틀","⑤방화벽","⑥계단","⑦경계벽","⑧높이변경","⑨외벽마감"].map((항목, idx) => (
                        <label key={idx} className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={대수선옵션.체크항목.includes(idx+1)}
                            onChange={e => set대수선옵션(o => ({
                              ...o, 체크항목: e.target.checked ? [...o.체크항목, idx+1] : o.체크항목.filter(n => n !== idx+1)
                            }))}
                            className="w-3.5 h-3.5 accent-amber-600" />
                          <span className="text-[12px] text-gray-700">{항목}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3 pt-1 border-t border-amber-100">
                    {[
                      { key: "해체", label: "해체 포함" },
                      { key: "전체해체", label: "전체 해체" },
                      { key: "리모델링활성화", label: "리모델링 활성화 구역" },
                    ].map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox"
                          checked={대수선옵션[key as keyof typeof 대수선옵션] as boolean}
                          onChange={e => set대수선옵션(o => ({ ...o, [key]: e.target.checked }))}
                          className="accent-amber-600" />
                        <span className="text-[12px] text-gray-700">{label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <div>
                      <label className="text-[11px] text-gray-500 mb-1 block">준공연도</label>
                      <input type="number" placeholder="예: 2005" value={대수선옵션.준공연도}
                        onChange={e => set대수선옵션(o => ({ ...o, 준공연도: e.target.value }))}
                        className="border border-gray-300 rounded-lg px-2 py-1.5 text-[13px] text-gray-900 placeholder:text-gray-400 w-24 focus:outline-none focus:border-amber-400 bg-white" />
                    </div>
                    {대수선옵션.체크항목.length > 0 && (
                      <div className="text-[11px] text-amber-700 bg-amber-100 rounded-lg px-2 py-1.5 mt-4">
                        {대수선옵션.체크항목.length}개 항목 선택됨
                        {대수선옵션.체크항목.length >= 1 ? " → 대수선 허가/신고 대상" : ""}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 용도변경 탭 */}
              {행위 === "용도변경" && (
                <div className="p-3 space-y-3 bg-blue-50/40">
                  <div className="relative">
                    <label className="text-[11px] text-gray-500 mb-1 block">기존 건물 용도</label>
                    <input value={용도변경옵션.기존용도}
                      onChange={e => set용도변경옵션(o => ({ ...o, 기존용도: e.target.value }))}
                      placeholder="예: 제1종근린생활시설, 단독주택"
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] text-gray-900 placeholder:text-gray-400 bg-white focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-500 mb-1.5 block">변경 유형 (건축법 시행령 별표1 시설군 기준)</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { key: "동일군", label: "같은 시설군 내", desc: "신고 대상" },
                        { key: "하위군", label: "하위군으로 변경", desc: "신고 대상" },
                        { key: "상위군", label: "상위군으로 변경", desc: "허가 대상" },
                        { key: "타군", label: "다른 시설군으로", desc: "허가 대상" },
                      ].map(({ key, label, desc }) => (
                        <button key={key}
                          onClick={() => set용도변경옵션(o => ({ ...o, 변경유형: o.변경유형 === key ? "" : key as typeof o.변경유형 }))}
                          className={`text-left px-2.5 py-2 rounded-lg border text-[12px] transition-colors ${
                            용도변경옵션.변경유형 === key
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white text-gray-700 border-gray-200 hover:border-blue-300"
                          }`}>
                          <div className="font-medium">{label}</div>
                          <div className={`text-[10px] mt-0.5 ${용도변경옵션.변경유형 === key ? "text-blue-100" : "text-gray-400"}`}>{desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  {용도변경옵션.변경유형 && (
                    <div className="bg-white border border-blue-200 rounded-lg px-3 py-2 text-[11px] text-blue-700">
                      {용도변경옵션.변경유형 === "동일군" && "✅ 같은 시설군 내 변경 — 건축주 신고, 설계도서 구비"}
                      {용도변경옵션.변경유형 === "하위군" && "✅ 하위군으로 변경 — 건축주 신고, 설계도서 구비"}
                      {용도변경옵션.변경유형 === "상위군" && "⚠️ 상위군으로 변경 — 건축허가 필요, 주차·피난 기준 재검토"}
                      {용도변경옵션.변경유형 === "타군" && "⚠️ 다른 시설군으로 변경 — 건축허가 필요, 용도별 설치기준 전면 재검토"}
                      <div className="mt-1 text-gray-500">건축법 제19조 · 시행령 제14조 별표1 시설군 기준</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-[12px] text-gray-500 mb-1 block">
              지상층수
              <span className="ml-1 text-[10px] text-gray-400">(미입력 시 자동 추정)</span>
            </label>
            <div className="flex items-center gap-3">
              <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden">
                <button onClick={() => set층수입력폼(v => Math.max(0, v - 1))}
                  className="px-3 py-2 text-gray-600 hover:bg-gray-100 text-[16px] font-bold">−</button>
                <span className="px-4 py-2 text-[14px] font-semibold text-gray-800 min-w-[52px] text-center">
                  {층수입력폼 === 0 ? "자동" : `${층수입력폼}층`}
                </span>
                <button onClick={() => set층수입력폼(v => Math.min(50, v + 1))}
                  className="px-3 py-2 text-gray-600 hover:bg-gray-100 text-[16px] font-bold">+</button>
              </div>
              {층수입력폼 === 0 && (
                <span className="text-[10px] text-amber-600">⚠️ 소방·피난 기준 추정 적용</span>
              )}
            </div>
          </div>
          <div>
            <label className="text-[12px] text-gray-500 mb-1 block">지하층 수</label>
            <div className="flex items-center gap-3">
              <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden">
                <button onClick={() => set지하층입력(v => Math.max(0, v - 1))}
                  className="px-3 py-2 text-gray-600 hover:bg-gray-100 text-[16px] font-bold">−</button>
                <span className="px-4 py-2 text-[14px] font-semibold text-gray-800 min-w-[48px] text-center">
                  {지하층입력 === 0 ? "없음" : `B${지하층입력}`}
                </span>
                <button onClick={() => set지하층입력(v => Math.min(5, v + 1))}
                  className="px-3 py-2 text-gray-600 hover:bg-gray-100 text-[16px] font-bold">+</button>
              </div>
              {지하층입력 > 0 && (
                <span className="text-[11px] text-blue-600">≈ 굴착깊이 {지하층입력 * 4}m 추정</span>
              )}
            </div>
          </div>
          {(["아파트","연립주택","다세대주택","공동주택","기숙사"].some(u => 용도.includes(u))) && (
            <div>
              <label className="text-[12px] text-gray-500 mb-1 block">세대수</label>
              <div className="flex items-center gap-3">
                <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden">
                  <button onClick={() => set세대수입력(v => Math.max(0, v - 1))}
                    className="px-3 py-2 text-gray-600 hover:bg-gray-100 text-[16px] font-bold">−</button>
                  <input type="number" value={세대수입력 || ""}
                    onChange={e => set세대수입력(Math.max(0, parseInt(e.target.value) || 0))}
                    placeholder="0"
                    className="w-16 text-center py-2 text-[14px] text-gray-900 font-semibold focus:outline-none border-x border-gray-200" />
                  <button onClick={() => set세대수입력(v => v + 1)}
                    className="px-3 py-2 text-gray-600 hover:bg-gray-100 text-[16px] font-bold">+</button>
                </div>
                <span className="text-[11px] text-gray-400">세대</span>
              </div>
            </div>
          )}

          {error && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-[12px] text-red-600">{error}</div>}
          <div className="flex gap-2 mt-4">
            <button onClick={() => setInputStep(1)} className="px-3 py-2.5 bg-gray-100 text-gray-600 rounded-xl font-medium text-[13px] hover:bg-gray-200 transition-colors">← 이전</button>
            <button onClick={handleAnalyze} disabled={loading}
              className="flex-1 bg-[#1F4E79] text-white py-2.5 rounded-xl font-semibold text-[13px] hover:bg-[#1a3f63] transition-colors disabled:opacity-60">
              {loading ? "분석 중..." : "법규검토 시작"}
            </button>
          </div>
          </>}
          </div>{/* end 사업 개요 입력 */}

          {/* ── 분석 결과 요약 (사이드바 — 분석 완료 후) ── */}
          {r && computed && (<>
            {/* 주소·용도 요약 */}
            <div className="bg-blue-50 rounded-xl px-3 py-2.5">
              <div className="text-[12px] font-bold text-blue-800 truncate">{address}</div>
              <div className="text-[11px] text-blue-600 mt-0.5">{용도 || "용도 미지정"} · {행위}</div>
              <button onClick={() => { setApiResult(null); setInputStep(1); setPdfFloors(null); setParcelData(null); setSurroundings(null); setSiteFromOSM(false); setLawCheck(null); setNotionUrl(null); }}
                className="text-[10px] text-blue-400 hover:text-blue-600 underline mt-1">재검토</button>
            </div>

            {/* 4개 KPI */}
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { label: "용도지역", value: r.zoneName ?? "미확인", color: "text-blue-700" },
                { label: (editParams.건축면적입력 > 0 || editParams.연면적입력 > 0) ? "계획연면적" : "최대연면적", value: (editParams.건축면적입력 > 0 || editParams.연면적입력 > 0) ? `${computed.계획연면적.toLocaleString()}㎡` : (computed.areas?.최대연면적 ? `${computed.areas.최대연면적.toLocaleString()}㎡` : "—"), color: "text-indigo-700" },
                { label: "최대건축면적", value: computed.areas?.최대건축면적 ? `${computed.areas.최대건축면적}㎡` : "—", color: "text-purple-700" },
                { label: "지상/지하", value: `${editParams.층수}층 / B${editParams.지하층}`, color: "text-teal-700" },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-2">
                  <div className="text-[9px] text-gray-400 mb-0.5">{label}</div>
                  <div className={`text-[13px] font-bold ${color} leading-tight`}>{value}</div>
                </div>
              ))}
            </div>

            {/* 수치 조정 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] font-bold text-gray-600">수치 조정</div>
                {(editParams.층수 !== r.추정층수 || editParams.대지면적 !== r.baseData?.대지면적 || editParams.건축면적입력 > 0 || editParams.연면적입력 > 0 || editParams.지하층 !== r.지하층 || editParams.필로티 || editParams.높이 > 0 || editParams.구조 !== "RC") && (
                  <button onClick={() => setEditParams({ 층수: r.추정층수 || 0, 층수직접입력: false, 대지면적: r.baseData?.대지면적 || 0, 건축면적입력: 0, 연면적입력: 0, 지하층: r.지하층 || 0, 필로티: false, 높이: 0, 구조: r.baseData?.구조 ?? "RC", 북측이격: 0, 오피스텔전용면적: 0 })}
                    className="text-[10px] text-gray-400 hover:text-gray-600 underline">초기화</button>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500 flex items-center gap-1">
                    지상층수
                    {!editParams.층수직접입력 && <span className="text-[9px] bg-amber-100 text-amber-700 px-1 py-0.5 rounded font-medium">추정</span>}
                  </span>
                  <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden bg-white">
                    <button onClick={() => setEditParams(p => ({ ...p, 층수: Math.max(1, p.층수 - 1), 층수직접입력: true }))} className="px-2 py-1 text-gray-600 hover:bg-gray-100 text-[13px]">−</button>
                    <span className="px-2.5 py-1 text-[12px] font-semibold text-gray-900 min-w-[36px] text-center">{editParams.층수}층</span>
                    <button onClick={() => setEditParams(p => ({ ...p, 층수: p.층수 + 1, 층수직접입력: true }))} className="px-2 py-1 text-gray-600 hover:bg-gray-100 text-[13px]">+</button>
                  </div>
                </div>
                {!editParams.층수직접입력 && (
                  <div className="text-[10px] text-amber-600 text-right -mt-0.5">
                    소방·피난 기준이 추정값 기준으로 산정됨. +/−로 조정하세요
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">지하층수</span>
                  <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden bg-white">
                    <button onClick={() => setEditParams(p => ({ ...p, 지하층: Math.max(0, p.지하층 - 1) }))} className="px-2 py-1 text-gray-600 hover:bg-gray-100 text-[13px]">−</button>
                    <span className="px-2.5 py-1 text-[12px] font-semibold text-gray-900 min-w-[36px] text-center">{editParams.지하층 === 0 ? "없음" : `B${editParams.지하층}`}</span>
                    <button onClick={() => setEditParams(p => ({ ...p, 지하층: Math.min(5, p.지하층 + 1) }))} className="px-2 py-1 text-gray-600 hover:bg-gray-100 text-[13px]">+</button>
                  </div>
                </div>
                {[
                  { key: "대지면적" as const, label: "대지면적", warn: false },
                  { key: "건축면적입력" as const, label: "건축면적", warn: computed.건폐율초과 },
                  { key: "연면적입력" as const, label: "연면적", warn: computed.용적률초과 },
                ].map(({ key, label, warn }) => (
                  <div key={key}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-gray-500 shrink-0">{label}</span>
                      <div className="flex items-center gap-1">
                        <input type="number" value={editParams[key] || ""} onChange={e => setEditParams(p => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))} placeholder="최대"
                          className={`border rounded-lg px-2 py-1 text-[11px] text-gray-900 w-20 bg-white focus:outline-none ${warn ? "border-red-400 bg-red-50" : "border-gray-200 focus:border-blue-400"}`} />
                        <span className="text-[10px] text-gray-400">㎡</span>
                      </div>
                    </div>
                    {key === "건축면적입력" && computed.건폐율초과 && <div className="text-[10px] text-red-500 text-right">최대 {computed.areas?.최대건축면적}㎡ 초과</div>}
                    {key === "연면적입력" && computed.용적률초과 && <div className="text-[10px] text-red-500 text-right">최대 {computed.areas?.최대연면적?.toLocaleString()}㎡ 초과</div>}
                  </div>
                ))}
                {용도.includes("오피스텔") && (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-gray-500 shrink-0">오피스텔 전용면적</span>
                      <div className="flex items-center gap-1">
                        <input type="number" value={editParams.오피스텔전용면적 || ""} onChange={e => setEditParams(p => ({ ...p, 오피스텔전용면적: parseFloat(e.target.value) || 0 }))} placeholder="예: 28"
                          className="border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-900 w-20 bg-white focus:outline-none focus:border-blue-400" />
                        <span className="text-[10px] text-gray-400">㎡</span>
                      </div>
                    </div>
                    <div className="text-[9px] text-gray-400 text-right mt-0.5">30㎡ 이하 → 200㎡당 1대, 초과 → 120㎡당 1대</div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">필로티</span>
                  <button onClick={() => setEditParams(p => ({ ...p, 필로티: !p.필로티 }))}
                    className={`px-3 py-1 rounded-lg text-[11px] font-medium border transition-colors ${editParams.필로티 ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200"}`}>
                    {editParams.필로티 ? "적용 중" : "미적용"}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-gray-500 shrink-0">높이</span>
                  <div className="flex items-center gap-1">
                    <input type="number" value={editParams.높이 || ""} onChange={e => setEditParams(p => ({ ...p, 높이: parseFloat(e.target.value) || 0 }))} placeholder="추정"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-900 w-20 bg-white focus:outline-none focus:border-blue-400" />
                    <span className="text-[10px] text-gray-400">m</span>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-gray-500 shrink-0">북측이격</span>
                  <div className="flex items-center gap-1">
                    <input type="number" value={editParams.북측이격 || ""} onChange={e => setEditParams(p => ({ ...p, 북측이격: parseFloat(e.target.value) || 0 }))} placeholder="미입력"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-900 w-20 bg-white focus:outline-none focus:border-blue-400" />
                    <span className="text-[10px] text-gray-400">m</span>
                  </div>
                </div>
                {editParams.북측이격 > 0 && apiResult?.zoneName?.includes("주거") && (() => {
                  const 지역 = apiResult.zoneName ?? "";
                  const 배율 = 지역.includes("전용주거") || 지역.includes("1종일반") ? 2 : 4;
                  const 가산 = 지역.includes("전용주거") || 지역.includes("1종일반") ? 0 : 지역.includes("2종일반") ? 4 : 8;
                  const 허용 = Math.round((editParams.북측이격 * 배율 + 가산) * 10) / 10;
                  return (
                    <div className="text-[10px] text-blue-600 text-right -mt-0.5">
                      정북사선 허용높이 ≤ {허용}m
                    </div>
                  );
                })()}
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">구조</span>
                  <select value={editParams.구조} onChange={e => setEditParams(p => ({ ...p, 구조: e.target.value }))}
                    className="border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-900 bg-white focus:outline-none">
                    {["RC", "철골", "목조", "조적"].map(v => <option key={v}>{v}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* 복합용도 면적 배분 */}
            {용도목록.length > 1 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-blue-700">복합용도 배분</span>
                  {Object.values(용도별면적).some(v => v > 0) && (
                    <button onClick={() => set용도별면적({})} className="text-[10px] text-gray-400 hover:text-gray-600 underline">초기화</button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {용도목록.map(u => (
                    <div key={u} className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-gray-600 truncate flex-1">{u}</span>
                      <div className="flex items-center gap-1">
                        <input type="number" value={용도별면적[u] || ""} onChange={e => set용도별면적(p => ({ ...p, [u]: parseFloat(e.target.value) || 0 }))} placeholder="면적"
                          className="border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-900 w-16 bg-white focus:outline-none" />
                        <span className="text-[10px] text-gray-400">㎡</span>
                      </div>
                    </div>
                  ))}
                </div>
                {Object.values(용도별면적).some(v => v > 0) && (() => {
                  const 합계 = Object.values(용도별면적).reduce((a, b) => a + b, 0);
                  const 초과 = 합계 > computed.계획연면적;
                  return (
                    <div className={`mt-1.5 text-[10px] font-medium ${초과 ? "text-red-600" : "text-blue-600"}`}>
                      합계 {합계.toLocaleString()}㎡{computed.복합주차 && ` · 주차 ${computed.복합주차.총대수}대`}
                      {초과 && " ⚠️ 초과"}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* PDF 도면 추출 */}
            <PdfExtractPanel
              onApply={(res) => {
                setPdfFloors(res);
                if (res.지상층수) setEditParams(p => ({ ...p, 층수: res.지상층수! }));
                if (res.대지면적)  setEditParams(p => ({ ...p, 대지면적: res.대지면적! }));
                if (res.건축면적)  setEditParams(p => ({ ...p, 건축면적입력: res.건축면적! }));
              }}
            />
          </>)}
        </div>{/* end flex-1 overflow-y-auto */}

        {/* 사이드바 하단 고정 버튼 */}
        {r && computed && (
          <div className="border-t border-gray-200 p-3 space-y-2 shrink-0">
            <div className="flex gap-1.5">
              <button onClick={() => window.print()} className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-xl text-[11px] font-medium hover:bg-gray-200">🖨 인쇄</button>
              <button onClick={() => { setApiResult(null); setNotionUrl(null); setAddress(""); set용도목록([]); set용도입력(""); set용도별면적({}); setInputStep(1); setLawCheck(null); setShowFolderPanel(false); setFolderName(""); setParcelData(null); setSurroundings(null); setSiteFromOSM(false); setPdfFloors(null); }}
                className="flex-1 py-2 bg-gray-100 text-gray-500 rounded-xl text-[11px] hover:bg-gray-200">초기화</button>
            </div>
            {notionUrl && (
              <a href={notionUrl} target="_blank" rel="noreferrer" className="block text-center text-[11px] text-blue-600 bg-blue-50 rounded-lg py-2 hover:bg-blue-100">
                ✅ Notion 저장됨 — 열기 →
              </a>
            )}
          </div>
        )}
      </aside>

      {/* ──────────────── 메인 콘텐츠 ──────────────── */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="p-4 max-w-4xl">

          {/* 로딩 */}
          {loading && (
            <div className="text-center py-16">
              <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-3"></div>
              <p className="text-[13px] text-gray-500">주소 검증 → 용도지역 조회 → 법규 분석 중...</p>
            </div>
          )}

          {/* 초기 안내 */}
          {!r && !loading && (
            <div className="flex flex-col items-center justify-center py-28 text-center">
              <div className="text-[52px] mb-4">🏛</div>
              <p className="text-[15px] font-medium text-gray-400">왼쪽에서 사업 개요를 입력하고</p>
              <p className="text-[15px] font-medium text-gray-400">법규검토를 시작하세요</p>
              <p className="text-[12px] text-gray-300 mt-3">주소 · 용도 · 행위 입력 후 분석하면<br/>이 영역에 결과가 표시됩니다</p>
            </div>
          )}

        {r && computed && (
          <div className="space-y-3">

          {/* 주요 이슈 상단 고정 */}
          {(() => {
            const issues = [
              ...computed.scaleItems.filter((i: any) => i.해당여부 && !i.해당여부.startsWith("❌")).map((i: any) => ({ tag: "규모", text: `${i.항목}: ${i.해당여부.replace(/^[✅⚠️❌]\s*/, "")}` })),
              ...computed.designItems.filter((i: any) => i.해당여부?.startsWith("✅")).map((i: any) => ({ tag: "설계", text: `${i.항목}: ${i.해당여부.replace("✅ ", "")}` })),
              ...computed.permitItems.filter((i: any) => i.해당여부 === "✅ 해당").map((i: any) => ({ tag: "인허가", text: i.항목 })),
            ];
            if (!issues.length) return null;
            return (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded-2xl p-3">
                <div className="text-[11px] font-bold text-amber-700 mb-2">주요 검토 이슈 ({issues.length}개)</div>
                <div className="flex flex-wrap gap-1.5">
                  {issues.map((issue, i) => (
                    <div key={i} className="flex items-center gap-1 bg-white border border-amber-200 rounded-lg px-2 py-1">
                      <span className="text-[9px] font-bold bg-amber-200 text-amber-800 px-1 py-0.5 rounded">{issue.tag}</span>
                      <span className="text-[11px] text-gray-700">{issue.text.length > 20 ? issue.text.slice(0,20)+"…" : issue.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {r?.coords?.lat && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <Accordion title="주변 매스 미리보기" badge={`${cadRadius}m 범위`}>
                <div className="mt-2">
                  <MassPreview3D lat={r.coords.lat} lng={r.coords.lng} radius={cadRadius} />
                  <p className="mt-1.5 text-[10px] text-gray-400">
                    OSM 건물(높이 포함) · Vworld 필지 · 도로/보도 — 🏗 DAE 버튼으로 SketchUp에서 열 수 있는 파일 다운로드
                  </p>
                </div>
              </Accordion>
            </div>
          )}

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <Accordion title="3D 법적 볼륨" badge={computed.areas ? `${editParams.층수}층 · 건축면적 ${computed.areas.최대건축면적}㎡` : ""}>
              {(() => {
                const 건축면적 = computed.areas?.최대건축면적 ?? 0;
                const 대지면적 = editParams.대지면적;
                const 층수 = Math.max(editParams.층수, 1);
                // parcel 없으면 대지면적 기반 정사각형으로 폴백
                const s = Math.sqrt(대지면적) / 2;
                const fallbackCoords: [number, number][] = [[-s, -s], [s, -s], [s, s], [-s, s]];
                const coords = parcelData?.localCoords ?? fallbackCoords;
                const aspect = parcelData?.bboxAspect ?? 1.0;
                return (
                  <div className="mt-2">
                    <BuildingViewer3D
                      localCoords={coords}
                      건축면적={건축면적}
                      층수={층수}
                      대지면적={대지면적}
                      bboxAspect={aspect}
                      surroundings={surroundings ?? undefined}
                      zoneName={r.baseData?.zoneName ?? r.zoneName ?? undefined}
                      lat={r.coords?.lat}
                      lng={r.coords?.lng}
                    />
                    <div className="flex items-center justify-between mt-1.5">
                      <p className="text-[10px] text-gray-400">
                        {surroundings
                          ? `주변 건물 ${surroundings.buildings.length}동 · 도로 ${surroundings.roads.length}개 반영`
                          : "주변 현황 불러오는 중…"}
                      </p>
                      <p className={`text-[10px] ${siteFromOSM ? "text-green-600" : "text-amber-500"}`}>
                        대지 형상: {siteFromOSM ? "OSM 건물 윤곽 사용" : "면적 기반 추정 (폴백)"}
                      </p>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1.5">
                      {[
                        { label: "대지면적", value: `${대지면적.toLocaleString()}㎡` },
                        { label: "건축면적", value: `${건축면적.toLocaleString()}㎡` },
                        { label: "최대연면적", value: computed.areas ? `${computed.areas.최대연면적.toLocaleString()}㎡` : "—" },
                        { label: `${층수}층 높이`, value: `${(층수 * 3.3).toFixed(1)}m` },
                      ].map(({ label, value }) => (
                        <div key={label} className="bg-blue-50 rounded-lg p-2 text-center">
                          <div className="text-[10px] text-blue-500">{label}</div>
                          <div className="text-[12px] font-bold text-blue-700">{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* PDF 층별 면적 결과 표시 */}
                    {pdfFloors && pdfFloors.floors.length > 0 && (
                      <div className="mt-3 rounded-xl border border-green-200 bg-green-50 overflow-hidden">
                        <div className="px-3 py-2 bg-green-700 text-white text-[11px] font-bold flex items-center justify-between">
                          <span>PDF 추출 — 층별 면적표</span>
                          <button onClick={() => setPdfFloors(null)} className="text-green-200 hover:text-white text-[13px] leading-none">×</button>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-[12px]">
                            <thead>
                              <tr className="bg-green-100">
                                <th className="px-3 py-1.5 text-left text-green-800">층</th>
                                <th className="px-3 py-1.5 text-right text-green-800">전용 (㎡)</th>
                                <th className="px-3 py-1.5 text-right text-green-800">공용 (㎡)</th>
                                <th className="px-3 py-1.5 text-right text-green-800">계 (㎡)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pdfFloors.floors.map((f, i) => (
                                <tr key={f.층} className={i % 2 === 0 ? "bg-white" : "bg-green-50/60"}>
                                  <td className="px-3 py-1.5 font-medium text-gray-700">{f.층}</td>
                                  <td className="px-3 py-1.5 text-right">{f.전용면적?.toFixed(2) ?? "—"}</td>
                                  <td className="px-3 py-1.5 text-right">{(f.공용면적 ?? 0) > 0 ? f.공용면적?.toFixed(2) : "—"}</td>
                                  <td className="px-3 py-1.5 text-right font-semibold text-green-700">{f.중면적?.toFixed(2) ?? "—"}</td>
                                </tr>
                              ))}
                              <tr className="bg-green-100 border-t border-green-200 font-bold text-green-800">
                                <td className="px-3 py-1.5">합계</td>
                                <td className="px-3 py-1.5 text-right">{pdfFloors.floors.reduce((s,f) => s+(f.전용면적??0),0).toFixed(2)}</td>
                                <td className="px-3 py-1.5 text-right">{pdfFloors.floors.reduce((s,f) => s+(f.공용면적??0),0).toFixed(2)}</td>
                                <td className="px-3 py-1.5 text-right">{pdfFloors.floors.reduce((s,f) => s+(f.중면적??0),0).toFixed(2)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </Accordion>
            <Accordion title="기본 대지 정보">
              <div className="rounded-lg border border-gray-200 overflow-hidden mt-2">
                <table className="w-full text-[13px]">
                  <tbody>
                    {[
                      ["대지위치 (지번)", r.addrInfo?.jibunAddr],
                      ["대지위치 (도로명)", r.addrInfo?.roadAddr],
                      ["용도지역", r.zoneName ?? "확인 필요"],
                      ["기타지구", r.land?.기타지구?.join(", ") || "없음"],
                      ["교육환경보호구역", r.educationZone ? `⚠️ ${r.educationZone.구역명} (${r.educationZone.시군구})` : "해당 없음"],
                      ["대지면적", `${editParams.대지면적}㎡${editParams.대지면적 !== r.baseData?.대지면적 ? " (수정됨)" : ""}${합필모드 && 합필총면적 > 0 ? ` — 합필 ${합필필지들.filter(p=>p.status==='ok').length + 1}필지 합산` : r.대지면적출처 && r.대지면적출처 !== "건축물대장" ? ` — 출처: ${r.대지면적출처}` : ""}`],
                      ["기존건물", r.bldgInfo?.층수 ? `지상${r.bldgInfo.층수}층 / ${r.bldgInfo.주용도} / ${r.bldgInfo.연면적}㎡` : "미등록"],
                      ["검토용도", r.용도 || "미지정"],
                      ["행위", r.행위],
                    ].map(([label, val], i) => (
                      <tr key={label as string} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                        <td className="px-3 py-2 font-medium text-slate-600 bg-blue-50/50 w-[120px] border-r border-gray-100">{label}</td>
                        <td className="px-3 py-2 text-gray-700">{val}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* 토지이용계획도 */}
              {r.coords && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-bold text-gray-600">토지이용계획도</span>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-gray-400">스크롤: 줌 · 드래그: 이동</span>
                      <a
                        href={`https://www.eum.go.kr/web/am/amMain.jsp`}
                        target="_blank" rel="noreferrer"
                        className="text-[10px] text-blue-500 hover:underline"
                      >토지이음 전체보기 →</a>
                    </div>
                  </div>
                  <LandUseMap
                    lat={r.coords.lat}
                    lng={r.coords.lng}
                    zoneName={r.baseData?.zoneName ?? r.zoneName}
                  />
                  <div className="flex gap-3 mt-1.5 flex-wrap items-center">
                    {[
                      { color: "bg-[#FFFF99]", label: "전용주거" },
                      { color: "bg-[#FFCC66]", label: "일반주거" },
                      { color: "bg-[#FF66CC]", label: "준주거·상업" },
                      { color: "bg-[#CCCCCC]", label: "공업" },
                      { color: "bg-[#99CC66]", label: "녹지" },
                    ].map(({ color, label }) => (
                      <div key={label} className="flex items-center gap-1">
                        <div className={`w-3 h-3 rounded-sm border border-gray-300 ${color}`} />
                        <span className="text-[10px] text-gray-500">{label}</span>
                      </div>
                    ))}
                    <span className="text-[10px] text-gray-400 ml-1">· 빨간 원: 학교환경보호구역</span>
                  </div>
                </div>
              )}
            </Accordion>

            <Accordion title="1. 용도 / 행위">
              {r.허용용도 && (
                <div className="space-y-2 mt-2">
                  <div className="rounded-lg border border-gray-200 overflow-hidden text-[13px]">
                    <div className="bg-[#1F4E79] text-white px-3 py-1.5 text-[12px]">허용 용도 ({r.zoneName})</div>
                    <div className="p-3 bg-green-50 text-green-700">{r.허용용도.허용?.slice(0, 6).join(" · ")}</div>
                    <div className="bg-gray-600 text-white px-3 py-1.5 text-[12px]">불허 용도</div>
                    <div className="p-3 bg-red-50 text-red-600">{r.허용용도.불허?.slice(0, 6).join(" · ")}</div>
                  </div>
                </div>
              )}
            </Accordion>

            <Accordion title="2. 규모" badge={r.effectiveRule ? `건폐율 ${r.effectiveRule.건폐율}% / 용적률 ${r.effectiveRule.용적률}%` : ""}>
              {computed.areas && (
                <div className="grid grid-cols-3 gap-2 mt-2 mb-3">
                  {[
                    { label: `최대건축면적${editParams.건축면적입력 > 0 ? ` (계획 ${editParams.건축면적입력}㎡)` : ""}`, value: `${computed.areas.최대건축면적}㎡` },
                    { label: (editParams.건축면적입력 > 0 || editParams.연면적입력 > 0) ? "계획연면적" : "최대연면적", value: `${computed.계획연면적.toLocaleString()}㎡${editParams.필로티 ? " (+필로티)" : ""}${(editParams.건축면적입력 > 0 || editParams.연면적입력 > 0) ? ` (최대 ${computed.areas.최대연면적.toLocaleString()}㎡)` : ""}` },
                    { label: "지상/지하", value: `${editParams.층수}F / B${editParams.지하층}` },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-blue-50 rounded-lg p-2 text-center">
                      <div className="text-[10px] text-blue-500">{label}</div>
                      <div className="text-[13px] font-bold text-blue-700">{value}</div>
                    </div>
                  ))}
                </div>
              )}
              <ItemTable items={computed.scaleItems} />
            </Accordion>

            <Accordion title="3. 설계사항" badge={`${computed.designItems.filter((i: any) => i.해당여부?.startsWith("✅")).length}개 해당`}>
              <ItemTable items={computed.designItems} />
            </Accordion>

            <Accordion title="4. 인허가 / 심의" badge={`${computed.permitItems.filter((i: any) => i.해당여부 === "✅ 해당").length}개 해당`}>
              <div className="overflow-x-auto rounded-lg border border-gray-200 mt-2">
                <table className="w-full text-[12px]">
                  <thead><tr className="bg-[#1F4E79] text-white">
                    <th className="px-3 py-2 text-left w-[130px]">항목</th>
                    <th className="px-3 py-2 text-left">내용</th>
                    <th className="px-2 py-2 text-center w-[90px]">해당여부</th>
                  </tr></thead>
                  <tbody>
                    {computed.permitItems.map((item: any, i: number) => (
                      <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                        <td className="px-3 py-2 bg-blue-50/50 border-r border-gray-100 align-top">
                          <div className="font-medium text-slate-700">{item.항목}</div>
                          {item.법령 && <div className="text-[10px] text-gray-400 mt-0.5 leading-tight">{(() => { const url = getLawUrl(item.법령); return url ? <a href={url} target="_blank" rel="noreferrer" className="hover:text-blue-500 hover:underline">{item.법령} ↗</a> : item.법령; })()}</div>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{item.내용}{item.비고 && <span className="block text-[11px] text-blue-500">↳ {item.비고}</span>}</td>
                        <td className="px-2 py-2 text-center"><span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${badgeColor(item.해당여부)}`}>{item.해당여부}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Accordion>

            <Accordion title="인허가·심의 스케줄표" badge={computed.scheduleTotalMonths ? `약 ${computed.scheduleTotalMonths}개월` : ""}>
              <ScheduleTable items={computed.scheduleItems} total={computed.scheduleTotalMonths} />
            </Accordion>

            <Accordion title="주요 이슈">
              <div className="mt-2 space-y-1.5">
                {[
                  ...computed.scaleItems.filter((i: any) => i.해당여부 && !i.해당여부.startsWith("❌")).map((i: any) => ({ tag: "규모", text: `${i.항목}: ${i.해당여부.replace(/^[✅⚠️❌]\s*/, "")}` })),
                  ...computed.designItems.filter((i: any) => i.해당여부?.startsWith("✅")).map((i: any) => ({ tag: "설계", text: `${i.항목}: ${i.해당여부.replace("✅ ", "")}` })),
                  ...computed.permitItems.filter((i: any) => i.해당여부 === "✅ 해당").map((i: any) => ({ tag: "인허가", text: i.항목 })),
                ].map((issue, i) => (
                  <div key={i} className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    <span className="shrink-0 text-[10px] font-bold bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded">{issue.tag}</span>
                    <span className="text-[13px] text-gray-700">{issue.text}</span>
                  </div>
                ))}
              </div>
            </Accordion>

            {r.대수선결과 && (
              <Accordion
                title="대수선 법규 분석"
                badge={`${r.대수선결과.요약.허가신고} · 주의 ${r.대수선결과.요약.주의사항수}건`}
              >
                {/* 요약 박스 */}
                <div className={`mt-2 rounded-xl px-4 py-3 border ${r.대수선결과.요약.대수선해당 ? "bg-amber-50 border-amber-200" : "bg-gray-50 border-gray-200"}`}>
                  <div className="flex flex-wrap gap-3 text-[12px]">
                    <span><span className="text-gray-500">대수선 해당</span> <strong className={r.대수선결과.요약.대수선해당 ? "text-amber-700" : "text-gray-500"}>{r.대수선결과.요약.대수선해당 ? "✅ 해당" : "— 미해당"}</strong></span>
                    <span>·</span>
                    <span><span className="text-gray-500">인허가</span> <strong className={r.대수선결과.요약.허가신고 === "허가" ? "text-red-600" : "text-blue-600"}>{r.대수선결과.요약.허가신고}</strong></span>
                    <span>·</span>
                    <span><span className="text-gray-500">체크항목</span> <strong className="text-gray-800">{r.대수선결과.요약.해당항목수}개</strong></span>
                    <span>·</span>
                    <span><span className="text-gray-500">주의사항</span> <strong className="text-amber-700">{r.대수선결과.요약.주의사항수}건</strong></span>
                  </div>
                </div>

                {/* 항목별 결과 테이블 */}
                <div className="mt-3 space-y-2">
                  {r.대수선결과.분석결과.map((item: any, idx: number) => {
                    const stateStyle: Record<string, string> = {
                      danger:  "bg-red-50 border-red-200 text-red-700",
                      warning: "bg-amber-50 border-amber-200 text-amber-700",
                      info:    "bg-blue-50 border-blue-200 text-blue-700",
                      ok:      "bg-green-50 border-green-200 text-green-700",
                      check:   "bg-gray-50 border-gray-200 text-gray-500",
                    };
                    const stateIcon: Record<string, string> = { danger:"🔴", warning:"🟡", info:"🔵", ok:"✅", check:"⬜" };
                    const style = stateStyle[item.상태] ?? stateStyle.check;
                    return (
                      <div key={idx} className={`rounded-xl border px-3 py-2.5 ${style}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="text-[11px] mr-1">{stateIcon[item.상태]}</span>
                            <span className="text-[13px] font-semibold">{item.항목}</span>
                            <span className="text-[10px] ml-2 opacity-70">{item.법령}</span>
                          </div>
                          <span className="text-[12px] font-medium shrink-0">{item.결과}</span>
                        </div>
                        {/* 대수선 해당 여부 항목: 9개 체크 테이블 */}
                        {item.항목 === "대수선 해당 여부" && Array.isArray(item.내용) && (
                          <div className="mt-2 overflow-x-auto">
                            <table className="w-full text-[11px]">
                              <thead><tr className="bg-[#1F4E79] text-white">
                                <th className="px-2 py-1 text-left w-6">No</th>
                                <th className="px-2 py-1 text-left">항목</th>
                                <th className="px-2 py-1 text-left">기준</th>
                                <th className="px-2 py-1 text-center w-12">해당</th>
                              </tr></thead>
                              <tbody>
                                {item.내용.map((c: any, i: number) => (
                                  <tr key={i} className={`${c.해당 ? "bg-amber-50" : "bg-white"} border-b border-gray-100`}>
                                    <td className="px-2 py-1 text-gray-500">{c.no}</td>
                                    <td className="px-2 py-1 font-medium text-gray-800">{c.항목}</td>
                                    <td className="px-2 py-1 text-gray-600">{c.기준}</td>
                                    <td className="px-2 py-1 text-center">{c.해당 ? "✅" : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {/* 면적 기반 서류: 서류 목록 */}
                        {item.항목 === "면적 기반 필요 서류" && item.내용?.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {item.내용.map((s: any, i: number) => (
                              <span key={i} className="bg-white border border-amber-200 rounded px-2 py-0.5 text-[10px] text-amber-800">{s.서류}</span>
                            ))}
                          </div>
                        )}
                        {/* 그 외 항목: 조건 목록 */}
                        {item.항목 !== "대수선 해당 여부" && item.항목 !== "면적 기반 필요 서류" && item.항목 !== "기존 건축물 특례" && item.내용?.filter((c: any) => c.해당)?.length > 0 && (
                          <div className="mt-1 text-[11px] opacity-80">
                            {item.내용.filter((c: any) => c.해당).map((c: any, i: number) => (
                              <span key={i} className="mr-2">· {c.조건}{c.값 ? ` (${c.값})` : ""}</span>
                            ))}
                          </div>
                        )}
                        {item.비고 && <div className="mt-1 text-[10px] opacity-60">ℹ️ {item.비고}</div>}
                      </div>
                    );
                  })}
                </div>
              </Accordion>
            )}

            <Accordion title="협의기관 연락처">
              <div className="mt-2 space-y-3">
                {r.연락처 && (
                  <div className="bg-blue-50 rounded-lg px-3 py-2 text-[12px]">
                    <span className="font-semibold text-blue-700">{r.addrInfo?.sggNm} 구청</span>
                    <span className="mx-2 text-gray-400">·</span>
                    <span>건축과: {r.연락처.건축과 ?? "—"}</span>
                    <span className="mx-2 text-gray-400">·</span>
                    <span>도시계획과: {r.연락처.도시계획과 ?? "—"}</span>
                  </div>
                )}
                {r.구청부서 && (
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-[12px]">
                      <thead><tr className="bg-[#1F4E79] text-white">
                        <th className="px-3 py-1.5 text-left">부서</th>
                        <th className="px-3 py-1.5 text-left">팀</th>
                        <th className="px-3 py-1.5 text-left">협의사항</th>
                      </tr></thead>
                      <tbody>
                        {r.구청부서.map((d: any, i: number) => (
                          <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                            <td className="px-3 py-2 font-medium text-slate-700">{d.부서}</td>
                            <td className="px-3 py-2 text-gray-500">{d.팀}</td>
                            <td className="px-3 py-2 text-gray-600">{d.협의}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {r.시청부서 && (
                  <>
                    <div className="text-[11px] font-bold text-[#1F4E79] mt-2">서울시청 유관부서</div>
                    <div className="overflow-x-auto rounded-lg border border-gray-200">
                      <table className="w-full text-[12px]">
                        <thead><tr className="bg-[#2E75B6] text-white">
                          <th className="px-3 py-1.5 text-left">국/본부</th>
                          <th className="px-3 py-1.5 text-left">부서·팀</th>
                          <th className="px-3 py-1.5 text-left">협의사항</th>
                        </tr></thead>
                        <tbody>
                          {r.시청부서.map((d: any, i: number) => (
                            <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                              <td className="px-3 py-2 text-[11px] text-gray-500">{d.국}</td>
                              <td className="px-3 py-2 font-medium text-slate-700">{d.부서}</td>
                              <td className="px-3 py-2 text-gray-600">{d.협의}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </Accordion>

            <Accordion title="법령 최신화 현황" badge={lawCheck ? (lawCheck.recentCount > 0 ? `⚠️ ${lawCheck.recentCount}개 최근 개정` : "✅ 이상 없음") : ""}>
              <div className="mt-2 space-y-2">
                {!lawCheck && (
                  <div className="text-center py-4">
                    <p className="text-[12px] text-gray-500 mb-3">법제처 Open API를 통해 주요 법령의 최근 개정 여부를 확인합니다.</p>
                    <button onClick={checkLaws} disabled={lawCheckLoading}
                      className="bg-[#1F4E79] text-white px-4 py-2 rounded-lg text-[13px] font-medium hover:bg-[#1a3f63] disabled:opacity-60">
                      {lawCheckLoading ? "확인 중..." : "법령 개정 현황 확인"}
                    </button>
                  </div>
                )}
                {lawCheck && (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] text-gray-400">확인일시: {new Date(lawCheck.checkedAt).toLocaleString("ko-KR")}</span>
                      <button onClick={checkLaws} disabled={lawCheckLoading} className="text-[11px] text-blue-500 hover:underline disabled:opacity-60">
                        {lawCheckLoading ? "확인 중..." : "새로고침"}
                      </button>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-gray-200">
                      <table className="w-full text-[12px]">
                        <thead><tr className="bg-[#1F4E79] text-white">
                          <th className="px-3 py-2 text-left">법령명</th>
                          <th className="px-3 py-2 text-center w-[110px]">최근 공포일</th>
                          <th className="px-2 py-2 text-center w-[80px]">상태</th>
                        </tr></thead>
                        <tbody>
                          {lawCheck.laws.map((l, i) => (
                            <tr key={i} className={`${l.recent ? "bg-amber-50" : i % 2 === 0 ? "bg-white" : "bg-slate-50"}`}>
                              <td className="px-3 py-2 font-medium text-gray-700">{l.name}</td>
                              <td className="px-3 py-2 text-center text-gray-500">{l.amendDate ?? "—"}</td>
                              <td className="px-2 py-2 text-center">
                                {l.amendDate === null
                                  ? <span className="text-gray-400 text-[10px]">조회 실패</span>
                                  : l.recent
                                    ? <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded">⚠️ 180일↓</span>
                                    : <span className="text-green-600 text-[11px]">✅</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {lawCheck.recentCount > 0 && (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[11px] text-amber-700">
                        ⚠️ 180일 이내 개정된 법령이 {lawCheck.recentCount}개 있습니다. 해당 법령 조문을 직접 확인하세요.
                      </div>
                    )}
                  </>
                )}
              </div>
            </Accordion>

          </div>
          </div>
        )}

          <p className="text-center py-4 text-[11px] text-gray-400">법규검토 자동화 · 법제처·LURIS·건축물대장 API 기반</p>
        </div>{/* end max-w-4xl */}
      </main>

      {/* Notion 저장 모달 */}
      {showFolderPanel && r && computed && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowFolderPanel(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-gray-700">Notion 저장 — 폴더 분류</div>
            <div className="flex flex-wrap gap-1.5">
              {행위 && <span className="text-[11px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">{행위}</span>}
              {r.baseData?.siNm && <span className="text-[11px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">{r.baseData.siNm}</span>}
              {용도 && <span className="text-[11px] bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">{classify용도(용도)}</span>}
              {computed.areas?.최대연면적 && <span className="text-[11px] bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">{classify규모(computed.areas.최대연면적)}</span>}
            </div>
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">프로젝트 폴더명</label>
              <input
                value={folderName}
                onChange={e => setFolderName(e.target.value)}
                placeholder="예: 강남구 신축 아파트 프로젝트"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-[13px] text-gray-900 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />
              <div className="text-[10px] text-gray-400 mt-1">Notion DB에서 이 값으로 필터링하여 폴더처럼 관리합니다</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowFolderPanel(false)}
                className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-xl text-[13px] font-medium hover:bg-gray-200">취소</button>
              <button onClick={() => handleNotionSave(folderName)} disabled={notionSaving}
                className="flex-1 py-2.5 bg-black text-white rounded-xl text-[13px] font-semibold hover:bg-gray-800 disabled:opacity-60">
                {notionSaving ? "저장 중…" : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
  );
}
