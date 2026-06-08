import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export interface FloorData {
  층: string;
  층수: number;
  전용면적: number | null;
  공용면적: number | null;
  중면적: number | null;
}

export interface PdfExtractResult {
  주소?: string;
  대지면적?: number;
  건축면적?: number;
  건폐율?: number;
  용적률?: number;
  최고높이?: number;
  지상층수?: number;
  floors: FloorData[];
  pageCount: number;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

function extractNum(text: string, pattern: RegExp): number | null {
  const m = text.match(pattern);
  if (!m?.[1]) return null;
  const v = parseFloat(m[1]);
  return isNaN(v) ? null : v;
}

/** 정상 소수 + OCR 소수점 탈락 정수(예: 4537→45.37)를 모두 추출 */
function collectAreaNums(text: string, label: string): number[] {
  const results: number[] = [];
  for (const m of text.matchAll(new RegExp(label + "\\s+([\\d.]+)", "g"))) {
    const v = parseFloat(m[1]);
    if (v >= 1 && v <= 999) results.push(v);
  }
  // 소수점 탈락된 3~5자리 정수 보완
  for (const m of text.matchAll(new RegExp(label + "\\s+(\\d{3,5})(?:[^.\\d]|$)", "g"))) {
    const v = parseInt(m[1]) / 100;
    if (v >= 1 && v <= 999 && !results.some(r => Math.abs(r - v) < 0.02)) results.push(v);
  }
  return results;
}

/** 페이지 전체에서 유효한 면적 값으로 보이는 모든 소수 숫자 추출 */
function allAreaDecimals(text: string): number[] {
  const nums: number[] = [];
  for (const m of text.matchAll(/(\d+\.\d{1,2})/g)) {
    const v = parseFloat(m[1]);
    if (v >= 1 && v <= 500) nums.push(v);
  }
  return nums;
}

/** 페이지 텍스트에서 층 레이블과 면적을 파싱. 1페이지 2열 레이아웃 대응 */
function parsePageFloors(text: string): FloorData[] {
  // ① 페이지 앞 400자 내 층 레이블만 '계획 층'으로 인정 (주변 건물 주석 제외)
  const header = text.slice(0, 400);
  const floorNums: number[] = [];
  for (const m of header.matchAll(/지상\s*(\d+)[층증]/g)) {
    const n = parseInt(m[1]);
    if (!floorNums.includes(n)) floorNums.push(n);
  }
  if (floorNums.length === 0) return [];

  // ② 레이블 기반으로 각 면적 값을 순서대로 수집
  const 전용All = collectAreaNums(text, "전용면적");
  const 공용All = collectAreaNums(text, "공용면적");
  const 중All   = collectAreaNums(text, "중면적");

  // ③ 레이블 없이 위치 기반 보완 (단일 층 페이지에서 레이블이 OCR에서 누락된 경우)
  // 전용이 찾혔으나 중이 없을 때: 페이지 모든 소수 중에서 전용보다 큰 값을 중으로 추정
  const allNums = allAreaDecimals(text);

  // ③ 초기 층 데이터 생성
  const floors: FloorData[] = floorNums.map((floorNum, i) => ({
    층: `지상${floorNum}층`,
    층수: floorNum,
    전용면적: 전용All[i] ?? null,
    공용면적: 공용All[i] ?? null,
    중면적:   중All[i]   ?? null,
  }));

  // ④ 중면적 누락 시: allNums에서 전용보다 큰 미사용 숫자를 중면적으로 추정
  const usedAsJeon = new Set(floors.map(f => f.전용면적).filter((v): v is number => v !== null));
  for (const f of floors) {
    if (f.전용면적 !== null && f.중면적 === null) {
      const candidates = allNums
        .filter(n => n > f.전용면적! + 0.5 && !usedAsJeon.has(n))
        .sort((a, b) => a - b);
      if (candidates.length > 0) {
        f.중면적 = candidates[0];
        usedAsJeon.add(candidates[0]);
      }
    }
  }

  // ⑤ 나머지 누락 값 수식 보완
  for (const f of floors) {
    if (f.전용면적 !== null) {
      if (f.중면적 === null && f.공용면적 !== null) f.중면적 = round2(f.전용면적 + f.공용면적);
      if (f.공용면적 === null && f.중면적 !== null) f.공용면적 = round2(f.중면적 - f.전용면적);
      if (f.공용면적 === null && f.중면적 === null) { f.공용면적 = 0; f.중면적 = f.전용면적; }
    }
  }

  return floors;
}

function parseDoc(pages: { page: number; text: string }[]): PdfExtractResult {
  // 설계개요 페이지 (index 1)
  const overview = pages.find(p => p.page === 1)?.text ?? "";
  const 대지면적 = extractNum(overview, /대지면적\s+([\d.]+)/);
  let 건축면적 = extractNum(overview, /건축면적\s+([\d.]+)/);

  // 폴백: "건축면적" 레이블이 OCR 오인식된 경우
  // 대지면적 ~ 건폐율 사이 구간에서 소수 1개만 있는 라인의 값을 건축면적으로 추정
  // (대지면적 라인은 "105.50 ... 98.73" 처럼 복수이고, 건축면적 라인은 "HEHE 58.55" 처럼 단수)
  if (건축면적 === null && 대지면적 !== null) {
    const idxLand = overview.indexOf("대지면적");
    const idxBcr  = overview.search(/건폐율/);
    if (idxLand >= 0 && idxBcr > idxLand) {
      const section = overview.slice(idxLand + 4, idxBcr);
      for (const line of section.split("\n")) {
        const nums = [...line.matchAll(/(\d+\.\d{1,2})/g)].map(m => parseFloat(m[1]));
        // 한 라인에 소수 하나 + 합리적 건축면적 범위
        // 건폐율 법적 상한 90% 기준: 건축면적 < 대지면적*0.9 (제외지 합계 값 제외)
        if (nums.length === 1 && nums[0] >= 10 && nums[0] < 대지면적! * 0.9) {
          건축면적 = nums[0];
          break;
        }
      }
    }
  }

  const 건폐율   = extractNum(overview, /건폐율\s+([\d.]+)/);
  const 용적률Arr = [...overview.matchAll(/용적률\s+([\d.]+)/g)];
  const 용적률   = 용적률Arr.length > 0 ? parseFloat(용적률Arr[용적률Arr.length - 1][1]) : null;
  const 최고높이  = extractNum(overview, /최고높이\s+([\d.]+)/);
  const 주소m = overview.match(/대지위치\s+(.+)/);
  const 주소 = 주소m?.[1]?.trim().replace(/\s+/g, " ") ?? undefined;

  // 층별 평면도 페이지에서 추출
  const floors: FloorData[] = [];
  const seenNums = new Set<number>();

  for (const { page, text } of pages) {
    if (page <= 1) continue;
    for (const f of parsePageFloors(text)) {
      if (!seenNums.has(f.층수)) {
        seenNums.add(f.층수);
        floors.push(f);
      }
    }
  }

  floors.sort((a, b) => a.층수 - b.층수);

  return {
    주소,
    대지면적: 대지면적 ?? undefined,
    건축면적: 건축면적 ?? undefined,
    건폐율:   건폐율 ?? undefined,
    용적률:   용적률 ?? undefined,
    최고높이: 최고높이 ?? undefined,
    지상층수: floors.length > 0 ? Math.max(...floors.map(f => f.층수)) : undefined,
    floors,
    pageCount: pages.length,
  };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "PDF 파일이 필요합니다" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());

    // pdf-parse v2: 페이지 PNG 렌더링
    const { PDFParse } = await import("pdf-parse");
    const pdfParser = new (PDFParse as any)({ data: buffer });
    const shots = await pdfParser.getScreenshot({ scale: 3.0 });
    await pdfParser.destroy();

    // 커버 제외한 페이지만 OCR (index 1~)
    const pageKeys = Object.keys(shots.pages).filter((k) => k !== "0");

    // Tesseract.js — 병렬 처리
    const Tesseract = (await import("tesseract.js")).default;
    const ocrResults = await Promise.all(
      pageKeys.map(async (key) => {
        const imgBuf = Buffer.from(shots.pages[key].data);
        const { data: { text } } = await Tesseract.recognize(imgBuf, "kor+eng", {
          logger: () => {},
        } as any);
        return { page: parseInt(key), text };
      }),
    );

    const result = parseDoc(ocrResults);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[pdf-extract]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
