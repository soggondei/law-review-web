import type { Confidence } from "@/lib/judge";

export type NorthDaylightInput = {
  zoneName: string;
  northSetback?: number;
};

export type NorthDaylightResult = {
  applies: boolean;
  referenceHeight?: number;
  segment: string;
  summary: string;
  designStandard?: string;
  confidence: Confidence;
  sourceUrl: string;
  requiresInput: string[];
};

const SOURCE_URL = "https://www.law.go.kr/법령/건축법시행령/제86조";

export function calcNorthDaylightReference(input: NorthDaylightInput): NorthDaylightResult {
  const applies = input.zoneName.includes("주거");
  const requiresInput = ["정북 방향 인접대지 경계선", "해당 용도지역 세부 분류", "도로·공원·하천 접면 예외", "지자체 조례"];
  if (!applies) {
    return {
      applies,
      segment: "비주거지역",
      summary: "채광창 방향 기준 사선제한. 가로구역별 최고높이 우선",
      confidence: "unverified",
      sourceUrl: SOURCE_URL,
      requiresInput,
    };
  }

  const northSetback = input.northSetback;
  if (!northSetback || northSetback <= 0) {
    return {
      applies,
      segment: "정북 이격 미입력",
      summary: "전용·일반 주거지역 정북방향 이격 기준: 10m 이하 구간과 10m 초과 구간을 나누어 검토. 도로·공원·하천 접면 예외는 별도 확인",
      designStandard: "10m 이하 구간: 1.5m 이격. 10m 초과 구간: 초과분 1/2 이격. 관할 조례와 도면으로 재확인",
      confidence: "unverified",
      sourceUrl: SOURCE_URL,
      requiresInput,
    };
  }

  const referenceHeight = northSetback < 1.5 ? 0 : Math.round((10 + (northSetback - 1.5) * 2) * 10) / 10;
  const segment = northSetback < 1.5 ? "10m 이하 구간 최소 이격(1.5m) 미달" : "10m 초과분 1/2 이격 개략 역산";

  return {
    applies,
    referenceHeight,
    segment,
    summary: `정북 방향 인접 경계까지 ${northSetback}m (${segment}) -> 참고 허용 높이 ${referenceHeight}m. 현재 값은 개략치이며 도로·공원·하천 예외와 지자체 조례 확인 필요`,
    designStandard: "10m 이하 구간: 1.5m 이격. 10m 초과 구간: 초과분 1/2 이격 개략 반영. 전용주거/1·2종 일반주거와 접면 예외는 조례·도면으로 재확인",
    confidence: "estimated",
    sourceUrl: SOURCE_URL,
    requiresInput,
  };
}
