/**
 * 외부 API 호출 모듈 (서버 전용 — Next.js API Route에서만 사용)
 */

const JUSO_KEY    = process.env.JUSO_KEY!;
const LURIS_KEY   = process.env.LURIS_KEY!;
const BLDRGST_KEY = process.env.BLDG_KEY!;
const LAW_OC      = process.env.LAW_OC!;
const LAW_BASE    = "https://www.law.go.kr/DRF";

// ── 도로명주소 ────────────────────────────────────────────────────────────────
export async function fetchAddressInfo(keyword: string) {
  const params = new URLSearchParams({
    confmKey: JUSO_KEY, currentPage: "1", countPerPage: "1",
    keyword, resultType: "json",
  });
  const res  = await fetch(`https://www.juso.go.kr/addrlink/addrLinkApi.do?${params}`);
  const data = await res.json();
  const juso = data?.results?.juso?.[0];
  if (!juso) return null;

  // bdMgtSn = 법정동코드(10) + 산여부(1:일반=1,산=2) + 본번(4) + 부번(4) + 건물순번(6)
  // 건축물대장 API는 법정동코드 기반 sigunguCd/bjdongCd를 사용해야 함
  // admCd(행정동코드)의 뒤 5자리는 법정동코드와 다를 수 있으므로 bdMgtSn에서 추출
  const bd  = juso.bdMgtSn ?? "";
  const pnu = bd.length >= 19 ? bd.slice(0, 19) : null;
  const bun = bd.length >= 15 ? bd.slice(11, 15) : "0000";
  const ji  = bd.length >= 19 ? bd.slice(15, 19) : "0000";
  // 법정동코드 기반 시군구·동 코드 (건축물대장 API용)
  const sigunguCd = bd.length >= 5  ? bd.slice(0, 5)  : juso.admCd?.slice(0, 5) ?? "";
  const bjdongCd  = bd.length >= 10 ? bd.slice(5, 10) : juso.admCd?.slice(5, 10) ?? "";

  return {
    roadAddr:  juso.roadAddr,
    jibunAddr: juso.jibunAddr,
    siNm:      juso.siNm,
    sggNm:     juso.sggNm,
    emdNm:     juso.emdNm,
    admCd:     juso.admCd,
    rnMgtSn:   juso.rnMgtSn,
    bdMgtSn:   bd,
    pnu,
    bun,
    ji,
    sigunguCd,  // 법정동코드 기반 시군구코드 (건축물대장 API용)
    bjdongCd,   // 법정동코드 기반 법정동코드 (건축물대장 API용)
  };
}

// ── 건축물대장 표제부 ─────────────────────────────────────────────────────────
export async function fetchBuildingInfo(sigunguCd: string, bjdongCd: string, bun: string, ji: string) {
  const params = new URLSearchParams({
    serviceKey: BLDRGST_KEY,
    sigunguCd, bjdongCd, bun: bun.padStart(4,"0"), ji: ji.padStart(4,"0"),
    numOfRows: "5", pageNo: "1", _type: "json",
  });
  try {
    const res  = await fetch(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?${params}`);
    const data = await res.json();
    const item = data?.response?.body?.items?.item;
    if (!item) return null;
    // 복수 결과 중 주건물(mainAtchGbCd=0) 우선, 없으면 첫 번째
    const arr = Array.isArray(item) ? item : [item];
    const it  = arr.find((x: any) => x.mainAtchGbCd === "0" || x.mainAtchGbCdNm === "주건물") ?? arr[0];
    if (!it) return null;
    return {
      대지면적:   parseFloat(it.platArea)   || null,
      연면적:     parseFloat(it.totArea)    || null,
      층수:       parseInt(it.grndFlrCnt)   || null,
      지하층수:   parseInt(it.ugrndFlrCnt)  || null,
      세대수:     parseInt(it.hhldCnt)      || null,
      높이:       parseFloat(it.heit)       || null,
      구조:       it.strctCdNm              ?? null,
      주용도:     (it.mainPurpsCdNm || it.etcPurps || null), // etcPurps fallback
      준공일:     it.useAprDay ? String(it.useAprDay) : null,
      주차대수:   parseInt(it.totPkngCnt)   || null,
      승용엘리베이터: parseInt(it.rideUseElvtCnt) || null,
      건물명:     it.bldNm                  || null,
      대장종류:   it.regstrKindCdNm         || null,  // "일반건축물대장" | "집합건축물대장"
      건폐율:     parseFloat(it.bcRat)      || null,  // 대장 기재 건폐율
      용적률:     parseFloat(it.vlRat)      || null,  // 대장 기재 용적률
      지번:       it.platPlc                || null,  // 대지위치(지번주소)
    };
  } catch { return null; }
}

// ── 좌표 조회 (VWORLD 지오코딩) ───────────────────────────────────────────────
export async function fetchCoordinates(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://api.vworld.kr/req/address?service=address&request=getcoord&version=2.0&crs=epsg:4326&address=${encodeURIComponent(address)}&refine=false&format=json&type=road&key=${LURIS_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    const pt   = data?.response?.result?.point;
    if (!pt) return null;
    return { lat: parseFloat(pt.y), lng: parseFloat(pt.x) };
  } catch { return null; }
}

// ── 교육환경보호구역 (VWORLD req/data — LT_C_UQ111) ──────────────────────────
export async function fetchEducationZone(lng: number, lat: number): Promise<{
  구역명: string; 시도: string; 시군구: string;
} | null> {
  try {
    // geomFilter: WKT POINT 형식, EPSG:4326 (경도 위도 순서)
    const params = new URLSearchParams({
      service:    "data",
      request:    "GetFeature",
      data:       "LT_C_UQ111",
      key:        LURIS_KEY,
      geomFilter: `POINT(${lng} ${lat})`,
      crs:        "EPSG:4326",
      geometry:   "false",
      size:       "10",
      format:     "json",
    });
    const res  = await fetch(`https://api.vworld.kr/req/data?${params}`);
    const body = await res.json();
    if (body?.response?.status !== "OK") return null;
    const features = body?.response?.result?.featureCollection?.features;
    if (!features?.length) return null;
    // 절대정화구역 우선, 없으면 상대정화구역
    const 절대 = features.find((f: any) => f.properties?.uname?.includes("절대"));
    const hit  = 절대 ?? features[0];
    const 구역명 = hit.properties?.uname?.trim();
    if (!구역명) return null;   // uname 없으면 실제 구역 미해당
    return {
      구역명,
      시도:   hit.properties?.sido_name ?? "",
      시군구: hit.properties?.sigg_name ?? "",
    };
  } catch { return null; }
}

// ── LURIS 용도지역 ────────────────────────────────────────────────────────────
export async function fetchLandUseInfo(pnu: string) {
  let page = 1;
  const allItems: any[] = [];
  while (true) {
    const url = `https://api.vworld.kr/ned/data/getLandUseAttr?key=${LURIS_KEY}&pnu=${pnu}&numOfRows=100&pageNo=${page}`;
    const res  = await fetch(url);
    const body = await res.json();
    // 응답 형식: { landUses: { field: [...] } } 또는 { landUseAttr: { field: [...] } }
    const raw = body?.landUses?.field ?? body?.landUseAttr?.field;
    if (!raw) break;
    const arr = Array.isArray(raw) ? raw : [raw];
    allItems.push(...arr);
    if (arr.length < 100) break;
    page++;
  }

  const 용도지역: string[] = [], 기타지구: string[] = [];
  let 지구단위 = "미해당", 지목 = "", 면적 = "", 공시지가 = "";

  for (const f of allItems) {
    const nm = f.prposAreaDstrcCodeNm ?? f.prposAreaDstrcNm ?? "";
    const cd = f.prposAreaDstrcCode   ?? f.prposAreaDstrc   ?? "";
    // UQA01X = 도시지역(광역) 제외, UQA3XX = 공업지역, UQA1XX = 주거, UQA2XX = 상업, UQA4XX = 녹지
    if (cd.startsWith("UQA") && cd !== "UQA01X" && cd !== "UQA010") {
      if (!용도지역.includes(nm)) 용도지역.push(nm);
    } else if (!cd.startsWith("UQA")) {
      // 기타지구: UQA 아닌 모든 항목
      if (nm && !기타지구.includes(nm)) 기타지구.push(nm);
    }
    if (nm.includes("지구단위")) 지구단위 = "해당";
    if (f.jimok) 지목 = f.jimok;
    if (f.lndpclAr) 면적 = f.lndpclAr;
    if (f.pblntfPclnd) 공시지가 = f.pblntfPclnd;
  }

  return { 용도지역, 기타지구, 지구단위계획: 지구단위, 지목, 면적, 공시지가 };
}

// ── 법제처 건폐율·용적률 ───────────────────────────────────────────────────────
const LAW_IDS: Record<string, string> = {
  "국토의계획및이용에관한법률시행령": "197",
};

export async function fetchZoneRates(zoneName: string) {
  const ZONE_RATES: Record<string, {건폐율법정최대:number, 용적률법정최소:number, 용적률법정최대:number}> = {
    "제1종전용주거지역":  { 건폐율법정최대:50, 용적률법정최소:50,  용적률법정최대:100 },
    "제2종전용주거지역":  { 건폐율법정최대:50, 용적률법정최소:100, 용적률법정최대:150 },
    "제1종일반주거지역":  { 건폐율법정최대:60, 용적률법정최소:100, 용적률법정최대:200 },
    "제2종일반주거지역":  { 건폐율법정최대:60, 용적률법정최소:150, 용적률법정최대:250 },
    "제3종일반주거지역":  { 건폐율법정최대:50, 용적률법정최소:200, 용적률법정최대:300 },
    "준주거지역":         { 건폐율법정최대:70, 용적률법정최소:200, 용적률법정최대:500 },
    "근린상업지역":       { 건폐율법정최대:70, 용적률법정최소:200, 용적률법정최대:900 },
    "일반상업지역":       { 건폐율법정최대:80, 용적률법정최소:300, 용적률법정최대:1300 },
    "중심상업지역":       { 건폐율법정최대:90, 용적률법정최소:400, 용적률법정최대:1500 },
    "유통상업지역":       { 건폐율법정최대:80, 용적률법정최소:200, 용적률법정최대:1100 },
    "전용공업지역":       { 건폐율법정최대:70, 용적률법정최소:150, 용적률법정최대:300 },
    "일반공업지역":       { 건폐율법정최대:70, 용적률법정최소:200, 용적률법정최대:350 },
    "준공업지역":         { 건폐율법정최대:70, 용적률법정최소:200, 용적률법정최대:400 },
    "보전녹지지역":       { 건폐율법정최대:20, 용적률법정최소:50,  용적률법정최대:80 },
    "생산녹지지역":       { 건폐율법정최대:20, 용적률법정최소:50,  용적률법정최대:100 },
    "자연녹지지역":       { 건폐율법정최대:20, 용적률법정최소:50,  용적률법정최대:100 },
    "계획관리지역":       { 건폐율법정최대:40, 용적률법정최소:50,  용적률법정최대:100 },
    "생산관리지역":       { 건폐율법정최대:20, 용적률법정최소:50,  용적률법정최대:80 },
    "보전관리지역":       { 건폐율법정최대:20, 용적률법정최소:50,  용적률법정최대:80 },
  };
  return ZONE_RATES[zoneName] ?? null;
}

// ── 지자체별 조례 건폐율·용적률 ───────────────────────────────────────────────
type ZoneRate = { 건폐율: number; 용적률: number };
type OrdinanceDB = Record<string, ZoneRate>;

const ORDINANCES: Record<string, OrdinanceDB> = {
  "서울특별시": {
    "제1종전용주거지역": { 건폐율:50, 용적률:100 },
    "제2종전용주거지역": { 건폐율:40, 용적률:120 },
    "제1종일반주거지역": { 건폐율:60, 용적률:150 },
    "제2종일반주거지역": { 건폐율:60, 용적률:200 },
    "제3종일반주거지역": { 건폐율:50, 용적률:250 },
    "준주거지역":        { 건폐율:60, 용적률:400 },
    "근린상업지역":      { 건폐율:60, 용적률:600 },
    "일반상업지역":      { 건폐율:60, 용적률:800 },
    "중심상업지역":      { 건폐율:60, 용적률:1000 },
    "유통상업지역":      { 건폐율:60, 용적률:600 },
    "전용공업지역":      { 건폐율:60, 용적률:200 },
    "일반공업지역":      { 건폐율:60, 용적률:300 },
    "준공업지역":        { 건폐율:60, 용적률:400 },
    "보전녹지지역":      { 건폐율:20, 용적률:80 },
    "생산녹지지역":      { 건폐율:20, 용적률:100 },
    "자연녹지지역":      { 건폐율:20, 용적률:100 },
  },
  "부산광역시": {
    "제1종전용주거지역": { 건폐율:50, 용적률:100 },
    "제2종전용주거지역": { 건폐율:50, 용적률:150 },
    "제1종일반주거지역": { 건폐율:60, 용적률:200 },
    "제2종일반주거지역": { 건폐율:60, 용적률:250 },
    "제3종일반주거지역": { 건폐율:50, 용적률:300 },
    "준주거지역":        { 건폐율:70, 용적률:500 },
    "근린상업지역":      { 건폐율:70, 용적률:900 },
    "일반상업지역":      { 건폐율:80, 용적률:1300 },
    "중심상업지역":      { 건폐율:90, 용적률:1500 },
    "준공업지역":        { 건폐율:70, 용적률:400 },
    "자연녹지지역":      { 건폐율:20, 용적률:100 },
  },
  "인천광역시": {
    "제1종일반주거지역": { 건폐율:60, 용적률:200 },
    "제2종일반주거지역": { 건폐율:60, 용적률:250 },
    "제3종일반주거지역": { 건폐율:50, 용적률:300 },
    "준주거지역":        { 건폐율:70, 용적률:500 },
    "일반상업지역":      { 건폐율:80, 용적률:1300 },
    "준공업지역":        { 건폐율:70, 용적률:400 },
    "자연녹지지역":      { 건폐율:20, 용적률:100 },
  },
  "대구광역시": {
    "제1종일반주거지역": { 건폐율:60, 용적률:200 },
    "제2종일반주거지역": { 건폐율:60, 용적률:250 },
    "제3종일반주거지역": { 건폐율:50, 용적률:300 },
    "준주거지역":        { 건폐율:70, 용적률:500 },
    "일반상업지역":      { 건폐율:80, 용적률:1300 },
    "준공업지역":        { 건폐율:70, 용적률:400 },
    "자연녹지지역":      { 건폐율:20, 용적률:100 },
  },
  "광주광역시": {
    "제3종일반주거지역": { 건폐율:50, 용적률:250 },
  },
  "경기도": {
    "제1종전용주거지역": { 건폐율:50, 용적률:100 },
    "제2종전용주거지역": { 건폐율:50, 용적률:150 },
    "제1종일반주거지역": { 건폐율:60, 용적률:200 },
    "제2종일반주거지역": { 건폐율:60, 용적률:250 },
    "제3종일반주거지역": { 건폐율:50, 용적률:300 },
    "준주거지역":        { 건폐율:70, 용적률:500 },
    "근린상업지역":      { 건폐율:70, 용적률:900 },
    "일반상업지역":      { 건폐율:80, 용적률:1300 },
    "준공업지역":        { 건폐율:70, 용적률:400 },
    "자연녹지지역":      { 건폐율:20, 용적률:100 },
    "계획관리지역":      { 건폐율:40, 용적률:100 },
  },
  "대전광역시": {},
  "울산광역시": {},
  "세종특별자치시": {},
  "강원특별자치도": {},
  "충청북도": {},
  "충청남도": {},
  "전북특별자치도": {},
  "전라남도": {},
  "경상북도": {},
  "경상남도": {},
  "제주특별자치도": {},
};

const REGION_ALIASES: Record<string, string[]> = {
  "서울특별시":     ["서울", "서울특별시"],
  "부산광역시":     ["부산", "부산광역시"],
  "인천광역시":     ["인천", "인천광역시"],
  "대구광역시":     ["대구", "대구광역시"],
  "광주광역시":     ["광주", "광주광역시"],
  "대전광역시":     ["대전", "대전광역시"],
  "울산광역시":     ["울산", "울산광역시"],
  "세종특별자치시": ["세종", "세종특별자치시"],
  "경기도":         ["경기", "경기도"],
  "강원특별자치도": ["강원", "강원특별자치도"],
  "충청북도":       ["충북", "충청북도"],
  "충청남도":       ["충남", "충청남도"],
  "전북특별자치도": ["전북", "전북특별자치도", "전라북도"],
  "전라남도":       ["전남", "전라남도"],
  "경상북도":       ["경북", "경상북도"],
  "경상남도":       ["경남", "경상남도"],
  "제주특별자치도": ["제주", "제주특별자치도"],
};

function findOrdinanceRegion(siNm: string) {
  return Object.keys(ORDINANCES).find(region =>
    REGION_ALIASES[region]?.some(alias => siNm.includes(alias))
  );
}

/** 시도명 + 용도지역으로 조례 건폐율·용적률 반환. 없으면 null */
export function getOrdinanceRates(siNm: string, zoneName: string): ZoneRate | null {
  const key = findOrdinanceRegion(siNm);
  const db = key ? ORDINANCES[key] : null;
  return db?.[zoneName] ?? null;
}

// 하위 호환
export function getSeoulOrdinance(zoneName: string) {
  return ORDINANCES["서울특별시"]?.[zoneName] ?? null;
}

// ── 건축물대장 층별개요 ────────────────────────────────────────────────────────
export type BuildingFloor = {
  층: string;
  층수: number;
  용도: string;
  면적: number;
};

function formatFloorName(flrNoNm: string | undefined, flrNo: string | number): string {
  const raw = (flrNoNm ?? "").trim();
  if (raw) return raw;
  const n = parseInt(String(flrNo)) || 0;
  if (n < 0) return `지${-n}층`;
  if (n === 0) return "지상층";
  return `${n}층`;
}

export async function fetchBuildingFloors(
  sigunguCd: string, bjdongCd: string, bun: string, ji: string,
): Promise<BuildingFloor[]> {
  const all: BuildingFloor[] = [];
  let page = 1;
  // 페이지네이션: 층별개요가 100건 초과하는 건물 대응
  while (page <= 5) {
    const params = new URLSearchParams({
      serviceKey: BLDRGST_KEY,
      sigunguCd, bjdongCd,
      bun: bun.padStart(4, "0"), ji: ji.padStart(4, "0"),
      numOfRows: "100", pageNo: String(page), _type: "json",
    });
    let data: any;
    try {
      const res = await fetch(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrFlrOulnInfo?${params}`);
      data = await res.json();
    } catch { break; }
    const body = data?.response?.body;
    const totalCount = body?.totalCount ?? 0;
    const raw = body?.items?.item;
    if (page === 1) {
      console.log("[fetchBuildingFloors] totalCount:", totalCount, "| items:", raw ? (Array.isArray(raw) ? raw.length : 1) : 0, "| resultCode:", data?.response?.header?.resultCode);
    }
    if (!raw) break;
    const arr = Array.isArray(raw) ? raw : [raw];
    const mapped = arr.map((it: any) => ({
      층:  formatFloorName(it.flrNoNm, it.flrNo),
      층수: parseInt(it.flrNo) || 0,
      용도: ((it.mainPurpsCdNm || it.etcPurps) ?? "").trim(),
      // strArea(구조면적)가 0이면 flrArea(층면적) fallback
      면적: parseFloat(it.strArea) || parseFloat(it.flrArea) || 0,
    }));
    if (page === 1 && mapped.length > 0) {
      console.log("[fetchBuildingFloors] sample[0]:", JSON.stringify(mapped[0]));
    }
    all.push(...mapped);
    if (arr.length < 100) break;
    page++;
  }
  // 면적이 0인 경우도 포함 — 층 목록 자체는 표시해야 하며 면적은 표제부 연면적으로 fallback
  return all.sort((a, b) => a.층수 - b.층수);
}
