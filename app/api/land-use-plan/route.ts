import { NextRequest, NextResponse } from "next/server";
import {
  fetchAddressInfo,
  fetchLandUseInfo,
  fetchLandRegistry,
  fetchLandPrice,
  fetchZoneRates,
  getOrdinanceRates,
} from "@/lib/api";

export const preferredRegion = ["icn1"];

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address 파라미터 필요" }, { status: 400 });
  }

  try {
    // 1. 주소 → pnu, siNm
    const addrInfo = await fetchAddressInfo(address);
    if (!addrInfo?.pnu) {
      return NextResponse.json({ error: "주소를 찾을 수 없습니다" }, { status: 404 });
    }
    const { pnu, jibunAddr, siNm } = addrInfo;

    // 2. 병렬 호출
    const [landUse, registry, price] = await Promise.all([
      fetchLandUseInfo(pnu),
      fetchLandRegistry(pnu),
      fetchLandPrice(pnu),
    ]);

    const 용도지역목록 = landUse?.용도지역 ?? [];
    const 기타지구 = landUse?.기타지구 ?? [];
    const zoneName = 용도지역목록[0] ?? "";

    // 3. 건폐율·용적률 (법정 + 조례)
    const [zoneRates, ordinanceRates] = await Promise.all([
      zoneName ? fetchZoneRates(zoneName) : Promise.resolve(null),
      (siNm && zoneName) ? Promise.resolve(getOrdinanceRates(siNm, zoneName)) : Promise.resolve(null),
    ]);

    return NextResponse.json({
      pnu,
      jibunAddr: jibunAddr ?? "",
      지목: registry?.지목 ?? landUse?.지목 ?? null,
      면적: registry?.면적 ?? landUse?.면적 ?? null,
      소유구분: registry?.소유구분 ?? null,
      용도지역: 용도지역목록,
      기타지구,
      개별공시지가: price ?? null,
      건폐율: zoneRates
        ? {
            법정최대: zoneRates.건폐율법정최대,
            조례: ordinanceRates?.건폐율 ?? null,
          }
        : null,
      용적률: zoneRates
        ? {
            법정최소: zoneRates.용적률법정최소,
            법정최대: zoneRates.용적률법정최대,
            조례: ordinanceRates?.용적률 ?? null,
          }
        : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "서버 오류" }, { status: 500 });
  }
}
