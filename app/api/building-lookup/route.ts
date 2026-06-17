export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { fetchAddressInfo, fetchBuildingInfo, fetchBuildingFloors } from "@/lib/api";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "주소를 입력해주세요" }, { status: 400 });

  const addrInfo = await fetchAddressInfo(address);
  if (!addrInfo) return NextResponse.json({ error: "주소를 찾을 수 없습니다" }, { status: 404 });

  let bldgInfo = null;
  let floors: Awaited<ReturnType<typeof fetchBuildingFloors>> = [];

  // 법정동코드(bdMgtSn 기반) 사용 — admCd(행정동코드)는 법정동코드와 다를 수 있음
  const ji = addrInfo.ji || "0000";
  if (addrInfo.sigunguCd && addrInfo.bjdongCd && addrInfo.bun) {
    console.log("[building-lookup] params", {
      sigunguCd: addrInfo.sigunguCd,
      bjdongCd: addrInfo.bjdongCd,
      bun: addrInfo.bun,
      ji,
      bdMgtSn: addrInfo.bdMgtSn,
    });
    [bldgInfo, floors] = await Promise.all([
      fetchBuildingInfo(addrInfo.sigunguCd, addrInfo.bjdongCd, addrInfo.bun, ji).catch(() => null),
      fetchBuildingFloors(addrInfo.sigunguCd, addrInfo.bjdongCd, addrInfo.bun, ji).catch(() => []),
    ]);
    console.log("[building-lookup] result", { bldgInfo: !!bldgInfo, floors: floors.length });
  } else {
    console.log("[building-lookup] skip — missing params", {
      sigunguCd: addrInfo.sigunguCd,
      bjdongCd: addrInfo.bjdongCd,
      bun: addrInfo.bun,
    });
  }

  return NextResponse.json({ bldgInfo, floors, addrInfo });
}
