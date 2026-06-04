import { NextRequest, NextResponse } from "next/server";

const JUSO_KEY = process.env.JUSO_KEY!;

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json([]);
  try {
    const params = new URLSearchParams({
      confmKey: JUSO_KEY, currentPage: "1", countPerPage: "5",
      keyword: q, resultType: "json",
    });
    const res  = await fetch(`https://www.juso.go.kr/addrlink/addrLinkApi.do?${params}`);
    const data = await res.json();
    const list = data?.results?.juso ?? [];
    return NextResponse.json(
      list.map((j: any) => ({ roadAddr: j.roadAddr, jibunAddr: j.jibunAddr, zipNo: j.zipNo }))
    );
  } catch {
    return NextResponse.json([]);
  }
}
