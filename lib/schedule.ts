import PERMIT_DB from "./permit-db.json";

function evalCondition(cond: any, params: any): boolean {
  if (cond.all) return cond.all.every((c: any) => evalCondition(c, params));
  if (cond.any) return cond.any.some((c: any) => evalCondition(c, params));
  const val = params[cond.field];
  if (val === undefined || val === null) return false;
  if (cond.includes) {
    const arr = Array.isArray(val) ? val : [val];
    return cond.includes.some((item: string) =>
      arr.some((v: any) => { const sv = String(v); if (!sv) return false; return sv.includes(item) || item.includes(sv); })
    );
  }
  const num = parseFloat(val);
  if (isNaN(num)) return false;
  switch (cond.op) {
    case ">=": return num >= cond.value;
    case "<=": return num <= cond.value;
    case ">":  return num >  cond.value;
    case "<":  return num <  cond.value;
    case "==": return num === cond.value;
  }
  return false;
}

const PHASES: Record<string, { order: number; label: string }> = {
  pre_review:   { order: 1, label: "건축심의 접수 前" },
  post_review:  { order: 2, label: "건축심의 완료 後~건축허가 前" },
  post_permit:  { order: 3, label: "건축허가 완료 後" },
  pre_const:    { order: 4, label: "착공신고 前" },
  construction: { order: 5, label: "공사 중" },
  pre_sale:     { order: 6, label: "분양·준공 前" },
};

export function generateSchedule(params: {
  용도: string; 연면적: number; 층수: number; 대지면적: number;
  세대수?: number; 지하굴착깊이?: number; 기타지구?: string[]; 시도?: string;
}) {
  const p = {
    연면적:       parseFloat(String(params.연면적))    || 0,
    층수:         parseInt(String(params.층수))         || 0,
    대지면적:     parseFloat(String(params.대지면적))   || 0,
    세대수:       parseInt(String(params.세대수 ?? 0))  || 0,
    지하굴착깊이: params.지하굴착깊이 != null ? parseFloat(String(params.지하굴착깊이)) : 0,
    학교거리:     9999,
    용도:         params.용도     || "",
    기타지구:     params.기타지구 || [],
    시도:         params.시도     || "",
    사업유형:     "",
    구조:         "",
  };

  const applicable = (PERMIT_DB as any[]).filter(
    permit => !permit.conditions || evalCondition(permit.conditions, p)
  );

  const byPhase: Record<string, any[]> = {};
  for (const item of applicable) {
    const phase = item.phase || "post_review";
    if (!byPhase[phase]) byPhase[phase] = [];
    byPhase[phase].push(item);
  }

  const result: any[] = [];
  let cumulative = 0;
  for (const phaseKey of Object.keys(PHASES).sort((a, b) => PHASES[a].order - PHASES[b].order)) {
    const items = byPhase[phaseKey] || [];
    if (!items.length) continue;
    const phaseStart = cumulative;
    let phaseMax = 0;
    for (const item of items) {
      const dur = item.duration_months?.max ?? 2;
      phaseMax = Math.max(phaseMax, dur);
      result.push({
        ...item,
        phaseKey,
        phaseLabel: PHASES[phaseKey].label,
        startMonth: phaseStart + 1,
        endMonth: phaseStart + dur,
      });
    }
    cumulative += phaseKey === "pre_review" ? phaseMax + 2 : phaseMax;
  }

  return { schedule: result, totalMonths: cumulative };
}
