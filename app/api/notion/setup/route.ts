export const preferredRegion = ["icn1"];
import { NextResponse } from "next/server";

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const LAW_REVIEW_DB = "36f9ff7b-382c-81c2-ba5b-eff9aa2e2624";

export async function POST() {
  const res = await fetch(`https://api.notion.com/v1/databases/${LAW_REVIEW_DB}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      properties: {
        "프로젝트 폴더": { rich_text: {} },
        "행위 유형": { select: {} },
        "지역": { select: {} },
        "용도 분류": { select: {} },
        "규모": { select: {} },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    return NextResponse.json({ error: err.message ?? "DB 설정 실패" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
