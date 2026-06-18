import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const judge = readFileSync(resolve(root, "lib/judge.ts"), "utf8");

const failures = [];

function requireText(text, message) {
  if (!judge.includes(text)) failures.push(message);
}

function forbidText(text, message) {
  if (judge.includes(text)) failures.push(message);
}

requireText('ruleId: "site-egress-fire-access-path"', "대지안의 피난통로 ruleId 누락");
requireText('ruleId: "dead-end-corridor"', "막힌 복도 ruleId 누락");
requireText('ruleId:"corridor-width"', "복도너비 ruleId 누락");
requireText("auditLawReviewItems", "법규 항목 감사 함수 누락");
requireText("finalizeReviewItems(items)", "법규 항목 메타데이터 finalize 흐름 누락");
requireText('export type ReviewIntent = "compliance" | "design_reference" | "requires_verification"', "검토 의도 타입 누락");
requireText('ruleId:"north-daylight-reference"', "정북일조 참고값 ruleId 누락");
requireText("10m 이하 구간", "정북일조 10m 이하 구간 기준 누락");
requireText('reviewIntent:"design_reference"', "설계 참고 항목 메타데이터 누락");
requireText("classifyFireOccupancy", "소방 특정소방대상물 분류 보조 함수 누락");

forbidText('항목:"대지안의 피난통로", 법령:"건축법 시행령 제90조의2"', "대지안의 피난통로가 제90조의2에 다시 연결됨");
forbidText('항목:"대지안의 피난통로", 법령:"건축법 시행령 제90조의2",\n    내용:"막힌 복도', "대지안의 피난통로와 막힌 복도 기준이 다시 혼재됨");
forbidText('해당여부: Y("막힌 복도 너비 1.2m↑, 길이 10m↓ 확보")', "막힌 복도 도면 치수 없이 확정 판정");
forbidText('해당여부: Y(`${복도기준} 이상 확보`)', "복도너비 도면 치수 없이 확정 판정");
forbidText("9m 이하 구간", "정북일조 기준이 9m로 잘못 입력됨");
forbidText("9m 초과 구간", "정북일조 기준이 9m로 잘못 입력됨");

if (failures.length) {
  console.error("법규 항목 감사 실패");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("법규 항목 감사 통과");
