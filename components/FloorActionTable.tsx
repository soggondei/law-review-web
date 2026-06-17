"use client";
import { Fragment } from "react";

const 대수선항목목록 = [
  "①내력벽", "②기둥", "③보", "④지붕틀",
  "⑤방화벽", "⑥계단", "⑦경계벽", "⑧높이변경", "⑨외벽마감",
];

export interface FloorSelection {
  층: string;
  면적: number;
  현재용도: string;
  용도변경: boolean;
  변경면적전체: boolean;
  변경면적값: number;
  대수선: boolean;
  대수선항목: number[];
}

interface Props {
  selections: FloorSelection[];
  onChange: (s: FloorSelection[]) => void;
  변경후용도?: string;
}

function upd(arr: FloorSelection[], idx: number, patch: Partial<FloorSelection>): FloorSelection[] {
  return arr.map((s, i) => (i === idx ? { ...s, ...patch } : s));
}

export function FloorActionTable({ selections, onChange, 변경후용도 = "" }: Props) {
  if (selections.length === 0) return null;

  const ucCount = selections.filter(s => s.용도변경).length;
  const rmCount = selections.filter(s => s.대수선).length;
  const ucArea = selections
    .filter(s => s.용도변경)
    .reduce((sum, s) => sum + (s.변경면적전체 ? s.면적 : s.변경면적값 || s.면적), 0);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-[#1F4E79] text-white">
              <th className="px-2 py-1.5 text-left w-10">층</th>
              <th className="px-2 py-1.5 text-left">현재 용도 (대장)</th>
              <th className="px-2 py-1.5 text-right w-16">면적㎡</th>
              <th className="px-2 py-1.5 text-center w-14 text-blue-200">용도변경</th>
              <th className="px-2 py-1.5 text-center w-12 text-amber-200">대수선</th>
            </tr>
          </thead>
          <tbody>
            {selections.map((sel, idx) => (
              <Fragment key={sel.층}>
                <tr className={`border-b border-gray-100 ${sel.용도변경 || sel.대수선 ? "bg-blue-50/40" : idx % 2 === 0 ? "bg-white" : "bg-gray-50/70"}`}>
                  <td className="px-2 py-1.5 font-semibold text-gray-700">{sel.층}</td>
                  <td className="px-2 py-1.5 text-gray-500 max-w-[90px] truncate text-[10px]">{sel.현재용도 || "—"}</td>
                  <td className="px-2 py-1.5 text-right text-gray-700">{sel.면적.toFixed(1)}</td>
                  <td className="px-2 py-1.5">
                    <button
                      onClick={() => onChange(upd(selections, idx, { 용도변경: !sel.용도변경 }))}
                      className={`w-5 h-5 rounded border mx-auto flex items-center justify-center text-[10px] font-bold transition-colors ${sel.용도변경 ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 bg-white hover:border-blue-400 text-transparent"}`}
                    >✓</button>
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      onClick={() => onChange(upd(selections, idx, { 대수선: !sel.대수선, 대수선항목: sel.대수선 ? [] : sel.대수선항목 }))}
                      className={`w-5 h-5 rounded border mx-auto flex items-center justify-center text-[10px] font-bold transition-colors ${sel.대수선 ? "bg-amber-500 border-amber-500 text-white" : "border-gray-300 bg-white hover:border-amber-400 text-transparent"}`}
                    >✓</button>
                  </td>
                </tr>

                {sel.용도변경 && (
                  <tr className="bg-blue-50 border-b border-blue-100">
                    <td colSpan={5} className="px-3 py-1.5">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="text-blue-700 font-semibold shrink-0">→ 변경 후:</span>
                        <span className="bg-white border border-blue-200 text-blue-800 rounded px-2 py-0.5 font-medium text-[10px]">
                          {변경후용도 || <span className="text-gray-400 italic">용도 미선택</span>}
                        </span>
                        <div className="flex items-center gap-2 ml-1">
                          <label className="flex items-center gap-1 text-gray-600 cursor-pointer">
                            <input type="radio" name={`fa-area-${sel.층}`} checked={sel.변경면적전체}
                              onChange={() => onChange(upd(selections, idx, { 변경면적전체: true }))}
                              className="accent-blue-600 w-3 h-3" />
                            <span>전체 ({sel.면적.toFixed(0)}㎡)</span>
                          </label>
                          <label className="flex items-center gap-1 text-gray-600 cursor-pointer">
                            <input type="radio" name={`fa-area-${sel.층}`} checked={!sel.변경면적전체}
                              onChange={() => onChange(upd(selections, idx, { 변경면적전체: false }))}
                              className="accent-blue-600 w-3 h-3" />
                            <span>일부</span>
                            <input type="number"
                              value={sel.변경면적값 || ""}
                              onChange={e => onChange(upd(selections, idx, { 변경면적전체: false, 변경면적값: parseFloat(e.target.value) || 0 }))}
                              disabled={sel.변경면적전체}
                              className="border border-blue-200 rounded px-1.5 py-0.5 w-14 text-[11px] text-center bg-white disabled:opacity-40"
                              placeholder="㎡" />
                          </label>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}

                {sel.대수선 && (
                  <tr className="bg-amber-50/80 border-b border-amber-100">
                    <td colSpan={5} className="px-3 py-1.5">
                      <div className="text-[10px] text-amber-700 font-semibold mb-1">대수선 해당 항목 (건축법 시행령 제3조의2):</div>
                      <div className="grid grid-cols-3 gap-x-3 gap-y-0.5">
                        {대수선항목목록.map((항목, itemIdx) => (
                          <label key={itemIdx} className="flex items-center gap-1 cursor-pointer">
                            <input type="checkbox"
                              checked={sel.대수선항목.includes(itemIdx + 1)}
                              onChange={e => {
                                const next = e.target.checked
                                  ? [...sel.대수선항목, itemIdx + 1]
                                  : sel.대수선항목.filter(n => n !== itemIdx + 1);
                                onChange(upd(selections, idx, { 대수선항목: next }));
                              }}
                              className="w-3 h-3 accent-amber-600" />
                            <span className="text-[10px] text-gray-700">{항목}</span>
                          </label>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {(ucCount > 0 || rmCount > 0) && (
            <tfoot>
              {ucCount > 0 && (
                <tr className="bg-blue-100/70 text-[11px] font-semibold">
                  <td colSpan={2} className="px-2 py-1.5 text-blue-700">용도변경 {ucCount}개층</td>
                  <td className="px-2 py-1.5 text-right text-blue-700">{ucArea.toFixed(1)}㎡</td>
                  <td colSpan={2} />
                </tr>
              )}
              {rmCount > 0 && (
                <tr className="bg-amber-100/70 text-[11px] font-semibold">
                  <td colSpan={4} className="px-2 py-1.5 text-amber-700">
                    대수선 {rmCount}개층 · {[...new Set(selections.filter(s => s.대수선).flatMap(s => s.대수선항목))].length}개 항목 선택
                  </td>
                  <td />
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>
      {ucCount === 0 && rmCount === 0 && (
        <p className="text-[11px] text-gray-400 text-center py-1">용도변경 또는 대수선을 적용할 층을 선택하세요</p>
      )}
    </div>
  );
}
