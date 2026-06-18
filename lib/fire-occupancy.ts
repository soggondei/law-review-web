export type FireOccupancyProfile = {
  matchedUses: string[];
  requiresDetailedUse: boolean;
  note: string;
};

const FIRE_USE_CANDIDATES = [
  "공동주택",
  "근린생활",
  "판매",
  "업무",
  "의료",
  "문화집회",
  "숙박",
  "노유자",
  "수련",
  "창고",
  "공장",
  "교육연구"
];

export function classifyFireOccupancy(용도: string, 복합용도: boolean): FireOccupancyProfile {
  const matchedUses = FIRE_USE_CANDIDATES.filter((candidate) => 용도.includes(candidate));
  const genericUse = matchedUses.length === 0 || 용도.includes("근린생활") || 용도.includes("복합");
  return {
    matchedUses,
    requiresDetailedUse: 복합용도 || genericUse,
    note: matchedUses.length
      ? `소방 용도 후보: ${matchedUses.join(", ")}`
      : "소방 특정소방대상물 세부 용도 미분류",
  };
}
