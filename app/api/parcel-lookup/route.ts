export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";
import { fetchAddressInfo, fetchLandUseInfo, fetchBuildingInfo } from "@/lib/api";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address 필요" }, { status: 400 });

  const addrInfo = await fetchAddressInfo(address).catch(() => null);
  if (!addrInfo) return NextResponse.json({ error: "주소를 찾을 수 없습니다" }, { status: 404 });

  let 대지면적: number | null = null;
  let 용도지역: string | null = null;

  const [bldgInfo, land] = await Promise.allSettled([
    addrInfo.admCd && addrInfo.bun
      ? fetchBuildingInfo(addrInfo.admCd.slice(0, 5), addrInfo.admCd.slice(5, 10), addrInfo.bun, addrInfo.ji || "0000")
      : Promise.resolve(null),
    addrInfo.pnu ? fetchLandUseInfo(addrInfo.pnu) : Promise.resolve(null),
  ]);

  if (bldgInfo.status === "fulfilled" && bldgInfo.value?.대지면적) {
    대지면적 = bldgInfo.value.대지면적;
  }
  if (land.status === "fulfilled" && land.value) {
    용도지역 = land.value.용도지역?.[0] ?? null;
    if (!대지면적 && land.value.면적) {
      대지면적 = parseFloat(land.value.면적) || null;
    }
  }

  return NextResponse.json({
    roadAddr: addrInfo.roadAddr,
    용도지역,
    대지면적,
    siNm: addrInfo.siNm,
  });
}
