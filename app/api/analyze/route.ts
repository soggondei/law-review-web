export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { fetchAddressInfo, fetchBuildingInfo, fetchBuildingFloors, fetchLandUseInfo, fetchZoneRates, getOrdinanceRates, fetchCoordinates, fetchEducationZone } from "@/lib/api";
import { judgeScaleItems, judgeDesignItems, judgePermitItems, calcAreas, PERMITTED_USES, judgeUseChangeItems } from "@/lib/judge";
import { generateSchedule } from "@/lib/schedule";
import { analyzeRemodel } from "@/lib/remodel";
import { getContacts, 서울시청부서, 구청표준부서 } from "@/lib/contacts";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { address, 용도, 행위 = "신축", 층수입력, 지하층입력 = 0, 세대수입력 = 0, 용도변경옵션 } = body;
    if (!address) return NextResponse.json({ error: "주소를 입력해주세요" }, { status: 400 });

    // STEP 0: 주소 검증
    const addrInfo = await fetchAddressInfo(address);
    if (!addrInfo) return NextResponse.json({ error: "주소를 찾을 수 없습니다" }, { status: 404 });

    // 건축물대장 — 법정동코드(bdMgtSn 기반 sigunguCd/bjdongCd) 사용
    // admCd는 행정동코드이므로 법정동코드와 다를 수 있어 bdMgtSn에서 추출한 값을 사용
    let bldgInfo = null;
    if (addrInfo.sigunguCd && addrInfo.bjdongCd && addrInfo.bun) {
      bldgInfo = await fetchBuildingInfo(addrInfo.sigunguCd, addrInfo.bjdongCd, addrInfo.bun, addrInfo.ji || "0000").catch(()=>null);
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
    // 조례 미등록 지역은 국토계획법 법정 상한으로 fallback (densityRuleStatus로 구분)
    const effectiveRule = ordinanceRule
      ?? (legalRates ? { 건폐율: legalRates.건폐율법정최대, 용적률: legalRates.용적률법정최대 } : null);
    const densityRuleStatus = ordinanceRule
      ? "지자체 조례 기준 적용"
      : legalRates
        ? "법정 기준 잠정 적용 (조례 미등록 — 실제 조례 확인 필요)"
        : "용도지역 기준 미확인";

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

    // 건축물대장에서 가져온 값이 있으면 우선 사용
    const 지하층 = parseInt(String(지하층입력)) || bldgInfo?.지하층수 || 0;
    const 추정층수 = parseInt(층수입력) || bldgInfo?.층수 || areas?.추정층수 || 0;
    const 최대연면적 = areas?.최대연면적 ?? 0;
    const 세대수 = parseInt(String(세대수입력)) || bldgInfo?.세대수 || 0;
    // 구조: 건축물대장 문자열 → 약식 코드 변환
    const 구조코드 = (() => {
      const s = bldgInfo?.구조 ?? "";
      if (s.includes("철근콘크리트") || s.includes("RC") || s.includes("SRC")) return "RC";
      if (s.includes("철골") || s.includes("강구조")) return "철골";
      if (s.includes("목구조") || s.includes("목조")) return "목조";
      if (s.includes("조적") || s.includes("벽돌")) return "조적";
      return "RC"; // 기본
    })();

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
    const designItems = judgeDesignItems({ 연면적: 최대연면적, 층수: 추정층수, 용도: 용도||"", 대지면적: 대지면적_val, 지하층, 세대수, 기타지구: land.기타지구, 시도: addrInfo.siNm || "", 높이: bldgInfo?.높이 ?? undefined, 구조: 구조코드, 구조출처: bldgInfo?.구조 ? "대장확인" : "추정" });
    const permitItems = judgePermitItems({
      연면적: 최대연면적, 층수: 추정층수, 용도: 용도||"",
      대지면적: 대지면적_val, 기타지구: land.기타지구, 시도: addrInfo.siNm||"", 지하층, 세대수,
      지목: land.지목,
      교육환경구역: educationZone,
    });

    // 스케줄
    const { schedule: scheduleItems, totalMonths: scheduleTotalMonths } = generateSchedule({
      용도: 용도||"", 연면적: 최대연면적, 층수: 추정층수,
      대지면적: 대지면적_val, 지하굴착깊이: 지하층 * 4, 세대수,
      기타지구: land.기타지구, 시도: addrInfo.siNm||"",
    });

    const 허용용도 = zoneName ? PERMITTED_USES[zoneName] ?? null : null;

    // 층별행위 기반 분석 (새 UI) + 레거시 옵션 fallback
    const 층별행위: any[] = body.층별행위 ?? [];
    const 용도변경층들 = 층별행위.filter((f: any) => f.용도변경);
    const 대수선층들   = 층별행위.filter((f: any) => f.대수선);

    // 층별개요: 용도변경 또는 대수선 모드 시 항상 조회 (법정동코드 사용)
    const 기존용도 = 용도변경옵션?.기존용도 || bldgInfo?.주용도 || "";
    let 층별개요: Awaited<ReturnType<typeof fetchBuildingFloors>> = [];
    if ((행위 === "용도변경" || 행위 === "대수선") && addrInfo.sigunguCd && addrInfo.bjdongCd && addrInfo.bun) {
      층별개요 = await fetchBuildingFloors(addrInfo.sigunguCd, addrInfo.bjdongCd, addrInfo.bun, addrInfo.ji || "0000").catch(() => []);
    }

    // 용도변경 결과
    const 변경대상면적 = 용도변경층들.length > 0
      ? 용도변경층들.reduce((sum: number, f: any) => sum + (f.변경면적전체 !== false ? (f.면적 || 0) : (f.변경면적값 || f.면적 || 0)), 0)
      : 0;
    const 용도변경여부 = 행위 === "용도변경" || 용도변경층들.length > 0;
    const 용도변경결과 = 용도변경여부 && (기존용도 || 용도) ? judgeUseChangeItems({
      기존용도,
      변경용도: 용도 || "",
      연면적: bldgInfo?.연면적 ?? 최대연면적,
      변경대상면적: 변경대상면적 > 0 ? 변경대상면적 : undefined,
      시도: addrInfo.siNm || "",
      용도지역: zoneName || "",
      기존주차대수: bldgInfo?.주차대수 ?? null,
      층별개요: 층별개요.length > 0 ? 층별개요 : undefined,
    }) : null;

    // 대수선 결과
    const 대수선여부 = 행위 === "대수선" || 대수선층들.length > 0;
    let 대수선결과 = null;
    if (대수선여부) {
      const 합산항목: number[] = 대수선층들.length > 0
        ? [...new Set(대수선층들.flatMap((f: any) => f.대수선항목 ?? []))]
        : (body.대수선옵션?.체크항목 ?? []);
      const 대수선면적 = 대수선층들.length > 0
        ? 대수선층들.reduce((sum: number, f: any) => sum + (f.면적 || 0), 0)
        : 최대연면적;
      대수선결과 = analyzeRemodel({
        연면적: 대수선면적 > 0 ? 대수선면적 : 최대연면적,
        층수: 추정층수, 용도: 용도 || "",
        준공연도: body.준공연도 || body.대수선옵션?.준공연도 || "",
        해체: body.해체 ?? body.대수선옵션?.해체 ?? false,
        전체해체: body.전체해체 ?? body.대수선옵션?.전체해체 ?? false,
        리모델링활성화: body.리모델링활성화 ?? body.대수선옵션?.리모델링활성화 ?? false,
        체크항목: 합산항목,
      });
    }
    const 연락처 = getContacts(addrInfo.siNm ?? "", addrInfo.sggNm ?? "");
    const 시청부서 = addrInfo.siNm?.includes("서울") ? 서울시청부서 : null;
    const 구청부서 = 구청표준부서;

    return NextResponse.json({
      addrInfo, land, zoneName, bldgInfo,
      coords, educationZone,
      effectiveRule, legalRates, densityRuleStatus, areas,
      추정층수, 최대연면적, 지하층, 세대수,
      대지면적출처: bldgInfo?.대지면적 ? "건축물대장" : (parseFloat(body.면적) ? "직접입력" : luris면적 ? "LURIS(공시)" : "미확인"),
      scaleItems, designItems, permitItems,
      scheduleItems, scheduleTotalMonths,
      허용용도,
      용도, 행위,
      연락처, 시청부서, 구청부서,
      층별개요,
      대수선결과,
      용도변경결과,
      // 클라이언트 재계산에 필요한 고정 데이터
      baseData: {
        대지면적: 대지면적_val,
        effectiveRule,
        densityRuleStatus,
        기타지구: land.기타지구,
        siNm: addrInfo.siNm || "",
        zoneName,
        세대수,
        지목: land.지목,
        교육환경구역: educationZone,
        준공일: bldgInfo?.준공일 ?? null,
        구조: 구조코드,
        구조출처: bldgInfo?.구조 ? "대장확인" : "추정",
        높이: bldgInfo?.높이 ?? null,
        지하층수: bldgInfo?.지하층수 ?? null,
      },
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message ?? "분석 중 오류가 발생했습니다" }, { status: 500 });
  }
}
