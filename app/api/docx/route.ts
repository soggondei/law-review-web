import { NextRequest, NextResponse } from "next/server";
import {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, WidthType, AlignmentType, ShadingType, BorderStyle,
  HeadingLevel, PageOrientation,
} from "docx";

const C_HEADER = "1F4E79";
const C_SUB    = "2E75B6";
const C_LABEL  = "D6E4F0";
const C_EVEN   = "F7FBFF";
const C_GOOD   = "E8F5E9";
const C_WARN   = "FFF3CD";
const C_NONE   = "F5F5F5";

function bg(hex: string) {
  return { fill: hex, type: ShadingType.CLEAR, color: "auto" };
}

function headerRow(headers: string[]) {
  return new TableRow({
    children: headers.map(h => new TableCell({
      shading: bg(C_HEADER),
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 18, font: "맑은 고딕" })], alignment: AlignmentType.CENTER })],
    })),
  });
}

function dataRow(cells: string[], isEven: boolean) {
  return new TableRow({
    children: cells.map((c, ci) => new TableCell({
      shading: bg(ci === 0 ? C_LABEL : isEven ? C_EVEN : "FFFFFF"),
      children: [new Paragraph({ children: [new TextRun({ text: String(c ?? ""), size: 18, font: "맑은 고딕" })] })],
    })),
  });
}

function resultRow(cells: string[], hv: string, isEven: boolean) {
  const hvBg = hv?.startsWith("✅") ? C_GOOD : hv?.startsWith("⚠️") ? C_WARN : hv?.startsWith("❌") ? C_NONE : "FFFFFF";
  return new TableRow({
    children: [
      new TableCell({ shading: bg(C_LABEL), children: [new Paragraph({ children: [new TextRun({ text: cells[0] ?? "", bold: true, size: 18, font: "맑은 고딕" })] })] }),
      new TableCell({ shading: bg(isEven ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: cells[1] ?? "", size: 18, font: "맑은 고딕" })] })] }),
      new TableCell({ shading: bg(hvBg), children: [new Paragraph({ children: [new TextRun({ text: hv ?? "", size: 18, font: "맑은 고딕" })], alignment: AlignmentType.CENTER })] }),
    ],
  });
}

function heading(text: string, level = 1) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: level === 1 ? 28 : 22, color: level === 1 ? C_HEADER : C_SUB, font: "맑은 고딕" })],
    spacing: { before: 200, after: 100 },
  });
}

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const { addrInfo, bldgInfo, land, zoneName, areas, effectiveRule, 용도, 행위, scaleItems = [], designItems = [], permitItems = [], scheduleItems = [], scheduleTotalMonths = 0, address, 연락처, 구청부서 = [], 시청부서 = [] } = data;

    const sections: any[] = [];

    // ── 1. 개요 ──────────────────────────────────────────────────────────────
    sections.push(heading("1. 개요"));
    const infoRows = [
      ["대지위치 (지번)",  addrInfo?.jibunAddr ?? address ?? ""],
      ["대지위치 (도로명)", addrInfo?.roadAddr ?? ""],
      ["용도지역",         zoneName ?? "확인 필요"],
      ["기타지구",         land?.기타지구?.join(", ") || "없음"],
      ["대지면적",         bldgInfo?.대지면적 ? `${bldgInfo.대지면적}㎡` : "—"],
      ["기존건물",         bldgInfo?.층수 ? `지상${bldgInfo.층수}층 / ${bldgInfo.주용도} / 연면적 ${bldgInfo.연면적}㎡` : "미등록"],
      ["검토용도",         용도 || "미지정"],
      ["행위",             행위 || "신축"],
      ["건폐율",           effectiveRule?.건폐율 ? `${effectiveRule.건폐율}%` : "—"],
      ["용적률",           effectiveRule?.용적률 ? `${effectiveRule.용적률}%` : "—"],
      ["최대건축면적",     areas?.최대건축면적 ? `${areas.최대건축면적}㎡` : "—"],
      ["최대연면적",       areas?.최대연면적 ? `${areas.최대연면적}㎡` : "—"],
      ["추정층수",         areas?.추정층수 ? `약 ${areas.추정층수}층` : "—"],
    ];
    sections.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow(["항  목", "법  규  내  용"]), ...infoRows.map((r, i) => dataRow(r, i % 2 === 0))],
    }));

    // ── 2. 규모 ──────────────────────────────────────────────────────────────
    sections.push(heading("2. 규모"));
    sections.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        headerRow(["구분", "법규 내용", "해당여부"]),
        ...scaleItems.map((item: any, i: number) => resultRow([`${item.category}. ${item.항목}\n${item.법령}`, item.내용 + (item.설계기준 ? `\n↳ ${item.설계기준}` : "")], item.해당여부 ?? "", i % 2 === 0)),
      ],
    }));

    // ── 3. 설계사항 ──────────────────────────────────────────────────────────
    sections.push(heading("3. 설계사항"));
    sections.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        headerRow(["구분", "법규 내용 / 설계기준", "해당여부"]),
        ...designItems.map((item: any, i: number) => resultRow([`${item.category}. ${item.항목}\n${item.법령}`, item.내용 + (item.설계기준 ? `\n↳ ${item.설계기준}` : "")], item.해당여부 ?? "", i % 2 === 0)),
      ],
    }));

    // ── 4. 인허가·심의 ───────────────────────────────────────────────────────
    sections.push(heading("4. 인허가 / 심의"));
    sections.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        headerRow(["항목", "법규 내용", "해당여부"]),
        ...permitItems.map((item: any, i: number) => resultRow([item.항목, item.내용 + (item.비고 ? `\n↳ ${item.비고}` : "")], item.해당여부 ?? "", i % 2 === 0)),
      ],
    }));

    // ── 5. 스케줄 ────────────────────────────────────────────────────────────
    if (scheduleItems.length) {
      sections.push(heading("5. 인허가·심의 스케줄표"));
      sections.push(new Paragraph({ children: [new TextRun({ text: `예상 총 소요기간: 약 ${scheduleTotalMonths}개월 / 적용 항목: ${scheduleItems.length}개`, bold: true, color: C_SUB, size: 20, font: "맑은 고딕" })] }));
      sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          headerRow(["항목", "구분", "소요기간", "시기", "담당기관"]),
          ...scheduleItems.map((item: any, i: number) => new TableRow({
            children: [
              new TableCell({ shading: bg(C_LABEL), children: [new Paragraph({ children: [new TextRun({ text: item.name, bold: true, size: 18, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: item.category || "", size: 18, font: "맑은 고딕" })], alignment: AlignmentType.CENTER })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: `${item.duration_months?.min}~${item.duration_months?.max}개월`, size: 18, font: "맑은 고딕" })], alignment: AlignmentType.CENTER })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: `D+${item.startMonth}~D+${item.endMonth}`, size: 18, font: "맑은 고딕" })], alignment: AlignmentType.CENTER })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: (item.agency || "").split("\n")[0], size: 16, font: "맑은 고딕" })] })] }),
            ],
          })),
        ],
      }));
    }

    // ── 6. 협의기관 연락처 ───────────────────────────────────────────────────
    if (구청부서.length || 시청부서.length) {
      sections.push(heading("6. 인허가 유관부서 및 담당자"));

      if (연락처) {
        const sggNm = addrInfo?.sggNm ?? "";
        sections.push(new Paragraph({
          children: [new TextRun({ text: `▶ ${sggNm} 구청`, bold: true, size: 20, color: C_SUB, font: "맑은 고딕" })],
          spacing: { before: 100, after: 60 },
        }));
        sections.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [
              new TableCell({ shading: bg(C_LABEL), children: [new Paragraph({ children: [new TextRun({ text: "건축과", bold: true, size: 18, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg("FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: 연락처.건축과 ?? "—", size: 18, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg(C_LABEL), children: [new Paragraph({ children: [new TextRun({ text: "도시계획과", bold: true, size: 18, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg("FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: 연락처.도시계획과 ?? "—", size: 18, font: "맑은 고딕" })] })] }),
            ]}),
          ],
        }));
      }

      if (구청부서.length) {
        sections.push(new Paragraph({ children: [new TextRun({ text: "▶ 구청 유관부서", bold: true, size: 20, color: C_SUB, font: "맑은 고딕" })], spacing: { before: 160, after: 60 } }));
        sections.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            headerRow(["부서", "팀", "협의사항"]),
            ...구청부서.map((d: any, i: number) => new TableRow({ children: [
              new TableCell({ shading: bg(i % 2 === 0 ? C_LABEL : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: d.부서, bold: true, size: 18, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: d.팀, size: 18, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: d.협의, size: 18, font: "맑은 고딕" })] })] }),
            ]})),
          ],
        }));
      }

      if (시청부서.length) {
        sections.push(new Paragraph({ children: [new TextRun({ text: "▶ 서울시청 유관부서", bold: true, size: 20, color: C_SUB, font: "맑은 고딕" })], spacing: { before: 160, after: 60 } }));
        sections.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            headerRow(["국/본부", "부서·팀", "협의사항"]),
            ...시청부서.map((d: any, i: number) => new TableRow({ children: [
              new TableCell({ shading: bg(i % 2 === 0 ? C_LABEL : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: d.국, size: 16, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: d.부서, bold: true, size: 18, font: "맑은 고딕" })] })] }),
              new TableCell({ shading: bg(i % 2 === 0 ? C_EVEN : "FFFFFF"), children: [new Paragraph({ children: [new TextRun({ text: d.협의, size: 18, font: "맑은 고딕" })] })] }),
            ]})),
          ],
        }));
      }
    }

    // ── 면책 ─────────────────────────────────────────────────────────────────
    sections.push(new Paragraph({
      children: [new TextRun({ text: "※ 본 법규검토서는 법제처 API 및 공개 정보 기반 자동 생성 참고용 자료입니다. 반드시 공인 건축사 및 관계 기관과 협의하여 최신 법령을 확인하시기 바랍니다.", size: 16, color: "808080", italics: true, font: "맑은 고딕" })],
      spacing: { before: 300 },
    }));

    const doc = new Document({
      sections: [{
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children: [
          new Paragraph({ children: [new TextRun({ text: "법  규  검  토  서", bold: true, size: 44, color: C_HEADER, font: "맑은 고딕" })], alignment: AlignmentType.CENTER, spacing: { before: 400, after: 200 } }),
          new Paragraph({ children: [new TextRun({ text: `대지위치: ${addrInfo?.jibunAddr ?? address ?? ""}`, size: 24, font: "맑은 고딕" })], alignment: AlignmentType.CENTER }),
          new Paragraph({ children: [new TextRun({ text: new Date().toLocaleDateString("ko-KR"), size: 22, color: "606060", font: "맑은 고딕" })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }),
          ...sections,
        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const uint8  = new Uint8Array(buffer);
    return new NextResponse(uint8, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("법규검토서")}.docx`,
      },
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
