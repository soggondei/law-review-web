import { NextResponse } from "next/server";

const LAWS = [
  { name: "건축법",           query: "건축법" },
  { name: "건축법 시행령",     query: "건축법 시행령" },
  { name: "건축법 시행규칙",   query: "건축법 시행규칙" },
  { name: "소방시설법",        query: "소방시설 설치 및 관리에 관한 법률" },
  { name: "화재예방법",        query: "화재의 예방 및 안전관리에 관한 법률" },
  { name: "주차장법",          query: "주차장법" },
  { name: "국토계획법",        query: "국토의 계획 및 이용에 관한 법률" },
  { name: "국토계획법 시행령", query: "국토의 계획 및 이용에 관한 법률 시행령" },
  { name: "주택법",            query: "주택법" },
  { name: "주택건설기준",      query: "주택건설기준 등에 관한 규정" },
  { name: "장애인편의법",      query: "장애인 노인 임산부 등의 편의증진 보장에 관한 법률" },
  { name: "녹색건축물법",      query: "녹색건축물 조성 지원법" },
  { name: "건설산업기본법",    query: "건설산업기본법" },
  { name: "승강기안전관리법",  query: "승강기 안전 관리법" },
];

// 날짜 포맷: "20240315" → "2024-03-15"
function fmtDate(d: string | null): string | null {
  if (!d || d.length < 8) return d;
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
}

function isRecent(dateStr: string | null, days = 180): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return (Date.now() - d.getTime()) < days * 86400_000;
}

export async function GET() {
  const OC = process.env.LAW_OC;
  if (!OC) return NextResponse.json({ error: "법제처 API 키(LAW_OC) 미설정" }, { status: 500 });

  const results = await Promise.allSettled(
    LAWS.map(async ({ name, query }) => {
      const url = `https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=law&type=JSON&query=${encodeURIComponent(query)}&display=1&page=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      // display=1 이면 배열 대신 단일 객체로 반환되는 경우 있음
      const rawLaw = data?.LawSearch?.law;
      const item = Array.isArray(rawLaw) ? rawLaw[0] : rawLaw ?? null;
      const raw = item?.공포일자 ?? null;
      const amendDate = fmtDate(raw);
      return { name, amendDate, 법령명: item?.법령명한글 ?? name, recent: isRecent(amendDate) };
    })
  );

  const laws = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { name: LAWS[i].name, 법령명: LAWS[i].name, amendDate: null, recent: false }
  );

  const recentCount = laws.filter(l => l.recent).length;
  return NextResponse.json({ laws, recentCount, checkedAt: new Date().toISOString() });
}
