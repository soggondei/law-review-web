export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { fetchAddressInfo, fetchBuildingInfo, fetchLandUseInfo, fetchZoneRates, getOrdinanceRates, fetchCoordinates, fetchEducationZone } from "@/lib/api";
import { judgeScaleItems, judgeDesignItems, judgePermitItems, calcAreas, PERMITTED_USES } from "@/lib/judge";
import { generateSchedule } from "@/lib/schedule";
import { analyzeRemodel } from "@/lib/remodel";
import { getContacts, 서울시청부서, 구청표준부서 } from "@/lib/contacts";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { address, 용도, 행위 = "신축", 층수입력, 지하층입력 = 0, 세대수입력 = 0 } = body;
    if (!address) return NextResponse.json({ error: "주소를 입력해주세요" }, { status: 400 });

    // STEP 0: 주소 검증
    const addrInfo = await fetchAddressInfo(address);
    if (!addrInfo) return NextResponse.json({ error: "주소를 찾을 수 없습니다" }, { status: 404 });

    // 건축물대장 (bdMgtSn 기반 bun·ji 사용)
    let bldgInfo = null;
    if (addrInfo.admCd && addrInfo.bun) {
      const sigunguCd = addrInfo.admCd.slice(0,5);
      const bjdongCd  = addrInfo.admCd.slice(5,10);
      bldgInfo = await fetchBuildingInfo(sigunguCd, bjdongCd, addrInfo.bun, addrInfo.ji || "0000").catch(()=>null);
    }

    // STEP 1: LURIS
    let land = { 용도지역: [] as string[], 기타지구: [] as string[], 지구단위계획: "미해당", 지목: "", 면적: "", 공시지가: "" };
    if (addrInfo.pnu) {
      land = await fetchLandUseInfo(addrInfo.pnu).catch(() => land);
    }

    const zoneName = land.용도지역[0] ?? null;

    // STEP 2: 건폐율·용적률
    const legalRates    = zoneName ? await fetchZoneRates(zoneName) : null;
    const ordinanceRule = zoneName ? getOrdinanceRates(addrInfo.siNm ?? "", zoneName) : null;
    const effectiveRule = ordinanceRule ?? (legalRates ? {
      건폐율: legalRates.건폐율법정최대, 용적률: legalRates.용적률법정최대,
    } : null);

    // STEP 3: 면적 계산
    // 폴백 순서: 건축물대장 → 사용자 입력 → LURIS 공시지가 면적(나대지 대응)
    const luris면적 = land.면적 ? parseFloat(land.면적) : null;
    const 대지면적_val = bldgInfo?.대지면적
      ?? (parseFloat(body.면적) || null)
      ?? luris면적
      ?? 0;
    let areas = null;
    if (대지면적_val && effectiveRule) {
      const { 최대건축면적, 최대연면적, 추정층수 } = calcAreas(대지면적_val, effectiveRule.건폐율, effectiveRule.용적률);
      areas = { 대지면적: 대지면적_val, 최대건축면적, 최대연면적, 추정층수 };
    }

    const 지하층 = parseInt(String(지하층입력)) || 0;
    const 추정층수 = parseInt(층수입력) || areas?.추정층수 || 0;
    const 최대연면적 = areas?.최대연면적 ?? 0;
    const 세대수 = parseInt(String(세대수입력)) || 0;

    // 좌표·교육환경보호구역 (판단 전 선조회)
    const coords = await fetchCoordinates(addrInfo.roadAddr ?? address).catch(() => null);
    const educationZone = coords
      ? await fetchEducationZone(coords.lng, coords.lat).catch(() => null)
      : null;

    // 5대 분류 판단
    const scaleItems = judgeScaleItems({
      대지면적: 대지면적_val, 연면적: 최대연면적, 층수: 추정층수,
      용도: 용도||"", 용도지역: zoneName||"", 기타지구: land.기타지구,
      건폐율: effectiveRule?.건폐율, 용적률: effectiveRule?.용적률,
      최대건축면적: areas?.최대건축면적, 최대연면적,
    });
    const designItems = judgeDesignItems({ 연면적: 최대연면적, 층수: 추정층수, 용도: 용도||"", 대지면적: 대지면적_val, 지하층, 세대수, 기타지구: land.기타지구 });
    const permitItems = judgePermitItems({
      연면적: 최대연면적, 층수: 추정층수, 용도: 용도||"",
      대지면적: 대지면적_val, 기타지구: land.기타지구, 시도: addrInfo.siNm||"", 지하층, 세대수,
      교육환경구역: educationZone,
    });

    // 스케줄
    const { schedule: scheduleItems, totalMonths: scheduleTotalMonths } = generateSchedule({
      용도: 용도||"", 연면적: 최대연면적, 층수: 추정층수,
      대지면적: 대지면적_val, 지하굴착깊이: 지하층 * 4, 세대수,
      기타지구: land.기타지구, 시도: addrInfo.siNm||"",
    });

    const 허용용도 = zoneName ? PERMITTED_USES[zoneName] ?? null : null;

    // 대수선 분석
    const 대수선결과 = 행위 === "대수선" && body.대수선옵션 ? analyzeRemodel({
      연면적: 최대연면적, 층수: 추정층수, 용도: 용도 || "",
      준공연도: body.대수선옵션.준공연도 || "",
      해체: !!body.대수선옵션.해체,
      전체해체: !!body.대수선옵션.전체해체,
      리모델링활성화: !!body.대수선옵션.리모델링활성화,
      체크항목: body.대수선옵션.체크항목 || [],
    }) : null;
    const 연락처 = getContacts(addrInfo.siNm ?? "", addrInfo.sggNm ?? "");
    const 시청부서 = addrInfo.siNm?.includes("서울") ? 서울시청부서 : null;
    const 구청부서 = 구청표준부서;

    return NextResponse.json({
      addrInfo, land, zoneName, bldgInfo,
      coords, educationZone,
      effectiveRule, legalRates, areas,
      추정층수, 최대연면적, 지하층, 세대수,
      대지면적출처: bldgInfo?.대지면적 ? "건축물대장" : (parseFloat(body.면적) ? "직접입력" : luris면적 ? "LURIS(공시)" : "미확인"),
      scaleItems, designItems, permitItems,
      scheduleItems, scheduleTotalMonths,
      허용용도,
      용도, 행위,
      연락처, 시청부서, 구청부서,
      대수선결과,
      // 클라이언트 재계산에 필요한 고정 데이터
      baseData: {
        대지면적: 대지면적_val,
        effectiveRule,
        기타지구: land.기타지구,
        siNm: addrInfo.siNm || "",
        zoneName,
        세대수,
        교육환경구역: educationZone,
      },
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message ?? "분석 중 오류가 발생했습니다" }, { status: 500 });
  }
}
