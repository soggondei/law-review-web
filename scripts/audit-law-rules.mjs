import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8");
const judge = readFileSync(resolve(root, "lib/judge.ts"), "utf8");
const api = readFileSync(resolve(root, "lib/api.ts"), "utf8");
const daylight = readFileSync(resolve(root, "lib/daylight.ts"), "utf8");
const zoneOrdinances = readFileSync(resolve(root, "lib/data/zone-ordinances.json"), "utf8");
const setbackOrdinances = readFileSync(resolve(root, "lib/data/setback-ordinances.json"), "utf8");

function readMarkdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
    if (entry.isDirectory()) out.push(...readMarkdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md") && statSync(path).size < 500_000) out.push(readFileSync(path, "utf8"));
  }
  return out;
}

const auditCorpus = [agents, judge, api, daylight, zoneOrdinances, setbackOrdinances, ...readMarkdownFiles(resolve(root, "docs"))].join("\n");

const failures = [];

function requireText(text, message) {
  if (!judge.includes(text)) failures.push(message);
}

function requireIn(source, text, message) {
  if (!source.includes(text)) failures.push(message);
}

function forbidText(text, message) {
  if (judge.includes(text)) failures.push(message);
}

function forbidIn(source, text, message) {
  if (source.includes(text)) failures.push(message);
}

requireText('ruleId: "site-egress-fire-access-path"', "대지안의 피난통로 ruleId 누락");
requireText('ruleId: "dead-end-corridor"', "막힌 복도 ruleId 누락");
requireText('ruleId:"corridor-width"', "복도너비 ruleId 누락");
requireText("auditLawReviewItems", "법규 항목 감사 함수 누락");
requireText("finalizeReviewItems(items)", "법규 항목 메타데이터 finalize 흐름 누락");
requireText('export type ReviewIntent = "compliance" | "design_reference" | "requires_verification"', "검토 의도 타입 누락");
requireText('ruleId:"north-daylight-reference"', "정북일조 참고값 ruleId 누락");
requireIn(daylight, "10m 이하 구간", "정북일조 10m 이하 구간 기준 누락");
requireText('reviewIntent:"design_reference"', "설계 참고 항목 메타데이터 누락");
requireText("classifyFireOccupancy", "소방 특정소방대상물 분류 보조 함수 누락");
requireText("calcNorthDaylightReference", "정북일조 계산 모듈 연결 누락");
requireText("SETBACK_ORDINANCES", "대지안의 공지 조례 DB 연결 누락");
requireIn(agents, 'confidence: "confirmed"', "AGENTS.md 법령 confirmed 검증 규칙 누락");
requireIn(agents, "law.go.kr 원문", "AGENTS.md law.go.kr 원문 대조 규칙 누락");
requireIn(agents, "조문·항·호·목", "AGENTS.md 조문·항·호·목 인용 규칙 누락");
requireIn(api, "zone-ordinances.json", "건폐율·용적률 조례 JSON 연결 누락");
requireIn(zoneOrdinances, "서울특별시 도시계획 조례", "서울 도시계획 조례 근거 누락");
requireIn(zoneOrdinances, "\"confidence\": \"unverified\"", "미검증 조례 confidence 누락");
requireIn(setbackOrdinances, "서울특별시 건축 조례 별표4", "대지안의 공지 서울 조례 근거 누락");
requireIn(daylight, "10m 이하 구간", "정북일조 10m 이하 구간 모듈 기준 누락");
requireIn(daylight, "northSetback < 1.5", "정북일조 1.5m 최소 이격 검토 누락");

forbidText('항목:"대지안의 피난통로", 법령:"건축법 시행령 제90조의2"', "대지안의 피난통로가 제90조의2에 다시 연결됨");
forbidText('항목:"대지안의 피난통로", 법령:"건축법 시행령 제90조의2",\n    내용:"막힌 복도', "대지안의 피난통로와 막힌 복도 기준이 다시 혼재됨");
forbidText('해당여부: Y("막힌 복도 너비 1.2m↑, 길이 10m↓ 확보")', "막힌 복도 도면 치수 없이 확정 판정");
forbidText('해당여부: Y(`${복도기준} 이상 확보`)', "복도너비 도면 치수 없이 확정 판정");
forbidText("9m 이하 구간", "정북일조 기준이 9m로 잘못 입력됨");
forbidText("9m 초과 구간", "정북일조 기준이 9m로 잘못 입력됨");
forbidIn(auditCorpus, "연면적 합계 2,000㎡ 이상 건축물 (모든 용도)", "검증되지 않은 대지안의 피난통로 적용 대상 문구가 남아 있음");
forbidIn(auditCorpus, "건축물 주위에 너비 3m 이상 소화·피난 통로 확보", "검증되지 않은 3m 소화·피난 통로 기준 문구가 남아 있음");
forbidIn(auditCorpus, "주요구조부 내화구조 + 불연재 마감 시 1.5m로 완화 가능", "원문 미확인 완화 조건 문구가 남아 있음");

if (failures.length) {
  console.error("법규 항목 감사 실패");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("법규 항목 감사 통과");
