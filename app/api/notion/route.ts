export const preferredRegion = ["icn1"];
import { NextRequest, NextResponse } from "next/server";

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const LAW_REVIEW_DB = "36f9ff7b-382c-81c2-ba5b-eff9aa2e2624";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { addrInfo, zoneName, areas, effectiveRule, 용도, 행위, computed, address } = body;

    const today = new Date().toISOString().slice(0, 10);
    const 건폐율val = effectiveRule?.건폐율 ? effectiveRule.건폐율 / 100 : null;
    const 용적률val = effectiveRule?.용적률 ? effectiveRule.용적률 / 100 : null;

    const properties: Record<string, any> = {
      "검토명": { title: [{ text: { content: `법규검토 — ${addrInfo?.jibunAddr ?? address ?? ""}` } }] },
      "대지 위치": { rich_text: [{ text: { content: addrInfo?.jibunAddr ?? address ?? "" } }] },
      "검토일": { date: { start: today } },
      "건물 용도": { rich_text: [{ text: { content: 용도 ?? "" } }] },
      "결론": { select: { name: "검토중" } },
    };

    if (zoneName) properties["용도지역"] = { select: { name: zoneName } };
    if (areas?.대지면적) properties["대지면적 (㎡)"] = { number: areas.대지면적 };
    if (computed?.areas?.최대건축면적) properties["건축면적 (㎡)"] = { number: computed.areas.최대건축면적 };
    if (computed?.areas?.최대연면적) properties["연면적 (㎡)"] = { number: computed.areas.최대연면적 };
    if (건폐율val !== null) properties["건폐율 (%)"] = { number: 건폐율val };
    if (용적률val !== null) properties["용적률 (%)"] = { number: 용적률val };

    // 주요 검토사항: 해당 인허가 항목 요약
    const 주요이슈 = [
      ...(computed?.permitItems ?? []).filter((i: any) => i.해당여부 === "✅ 해당").map((i: any) => i.항목),
    ].slice(0, 5).join(", ");
    if (주요이슈) properties["주요 검토사항"] = { rich_text: [{ text: { content: 주요이슈 } }] };

    const res = await fetch(`https://api.notion.com/v1/pages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: LAW_REVIEW_DB },
        properties,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json({ error: err.message ?? "Notion 저장 실패" }, { status: 500 });
    }

    const page = await res.json();
    return NextResponse.json({ url: page.url, id: page.id });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
