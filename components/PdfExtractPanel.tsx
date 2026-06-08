"use client";

import { useRef, useState } from "react";
import type { FloorData, PdfExtractResult } from "@/app/api/pdf-extract/route";

interface Props {
  onApply: (result: PdfExtractResult) => void;
}

export default function PdfExtractPanel({ onApply }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<PdfExtractResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragging, setDragging] = useState(false);

  async function process(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setErrorMsg("PDF 파일만 지원합니다");
      setStatus("error");
      return;
    }
    setStatus("loading");
    setResult(null);
    setErrorMsg("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/pdf-extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "추출 실패");
      setResult(data);
      setStatus("done");
    } catch (e: any) {
      setErrorMsg(e.message);
      setStatus("error");
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) process(file);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) process(file);
  }

  return (
    <div className="mt-3 border border-dashed border-blue-300 rounded-xl bg-blue-50/40 p-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-[12px] font-bold text-blue-700">PDF 도면 면적 추출</span>
          <span className="ml-2 text-[10px] text-blue-500">설계도서 PDF를 업로드하면 층별 면적을 자동으로 읽어옵니다</span>
        </div>
        {status === "done" && result && (
          <button
            onClick={() => onApply(result)}
            className="px-3 py-1.5 bg-blue-600 text-white text-[11px] font-bold rounded-lg hover:bg-blue-700 transition-colors"
          >
            검토에 적용 →
          </button>
        )}
      </div>

      {/* 드롭존 */}
      {status !== "done" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed cursor-pointer transition-colors py-6 ${
            dragging ? "border-blue-500 bg-blue-100" : "border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50"
          }`}
        >
          <input ref={inputRef} type="file" accept=".pdf" className="hidden" onChange={onFileChange} />
          {status === "idle" && (
            <>
              <div className="text-2xl text-gray-300">📄</div>
              <p className="text-[12px] text-gray-500">PDF 파일을 드래그하거나 클릭해서 업로드</p>
              <p className="text-[10px] text-gray-400">건축 설계도서 PDF (평면도, 면적표 포함)</p>
            </>
          )}
          {status === "loading" && (
            <div className="flex flex-col items-center gap-2">
              <div className="w-7 h-7 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
              <p className="text-[12px] text-blue-600 font-medium">OCR 분석 중… (30~60초)</p>
              <p className="text-[10px] text-gray-400">층별 면적을 이미지에서 읽는 중입니다</p>
            </div>
          )}
          {status === "error" && (
            <div className="flex flex-col items-center gap-1">
              <div className="text-2xl">⚠️</div>
              <p className="text-[12px] text-red-600">{errorMsg}</p>
              <p className="text-[10px] text-gray-400">클릭하여 다시 시도</p>
            </div>
          )}
        </div>
      )}

      {/* 결과 테이블 */}
      {status === "done" && result && (
        <div className="space-y-3">
          {/* 설계개요 요약 */}
          {(result.주소 || result.대지면적 || result.건축면적) && (
            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2">
              <div className="text-[10px] font-bold text-gray-500 mb-1.5">설계개요 (OCR 추출)</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                {result.주소 && <span className="text-gray-600 col-span-2">📍 {result.주소}</span>}
                {result.대지면적 && <span><span className="text-gray-400">대지</span> <b>{result.대지면적}㎡</b></span>}
                {result.건축면적 && <span><span className="text-gray-400">건축</span> <b>{result.건축면적}㎡</b></span>}
                {result.건폐율 && <span><span className="text-gray-400">건폐율</span> <b>{result.건폐율}%</b></span>}
                {result.용적률 && <span><span className="text-gray-400">용적률</span> <b>{result.용적률}%</b></span>}
                {result.최고높이 && <span><span className="text-gray-400">높이</span> <b>{result.최고높이}M</b></span>}
                {result.지상층수 && <span><span className="text-gray-400">지상</span> <b>{result.지상층수}층</b></span>}
              </div>
            </div>
          )}

          {/* 층별 면적 테이블 */}
          {result.floors.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-[#1F4E79] text-white">
                    <th className="px-3 py-2 text-left">층</th>
                    <th className="px-3 py-2 text-right">전용면적 (㎡)</th>
                    <th className="px-3 py-2 text-right">공용면적 (㎡)</th>
                    <th className="px-3 py-2 text-right">중면적 (㎡)</th>
                    <th className="px-3 py-2 text-center text-[10px] text-blue-200">검증</th>
                  </tr>
                </thead>
                <tbody>
                  {result.floors.map((f, i) => {
                    const sum = (f.전용면적 ?? 0) + (f.공용면적 ?? 0);
                    const 중 = f.중면적 ?? 0;
                    const ok = Math.abs(sum - 중) < 0.5;
                    return (
                      <tr key={f.층} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                        <td className="px-3 py-2 font-semibold text-gray-700">{f.층}</td>
                        <td className="px-3 py-2 text-right">{f.전용면적?.toFixed(2) ?? "—"}</td>
                        <td className="px-3 py-2 text-right">{(f.공용면적 ?? 0) > 0 ? f.공용면적?.toFixed(2) : "—"}</td>
                        <td className="px-3 py-2 text-right font-semibold">{f.중면적?.toFixed(2) ?? "—"}</td>
                        <td className="px-3 py-2 text-center text-[11px]">{ok ? "✅" : "⚠️"}</td>
                      </tr>
                    );
                  })}
                  {/* 합계 */}
                  <tr className="bg-blue-50 border-t border-gray-200 font-semibold">
                    <td className="px-3 py-2 text-blue-700">합계</td>
                    <td className="px-3 py-2 text-right text-blue-700">
                      {result.floors.reduce((s, f) => s + (f.전용면적 ?? 0), 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right text-blue-700">
                      {result.floors.reduce((s, f) => s + (f.공용면적 ?? 0), 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right text-blue-700">
                      {result.floors.reduce((s, f) => s + (f.중면적 ?? 0), 0).toFixed(2)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {result.floors.length === 0 && (
            <div className="text-center py-4 text-[12px] text-gray-400">
              층별 면적을 추출하지 못했습니다. 도면 PDF인지 확인해주세요.
            </div>
          )}

          {/* 다시 업로드 */}
          <button
            onClick={() => { setStatus("idle"); setResult(null); }}
            className="text-[11px] text-gray-400 hover:text-gray-600 underline"
          >
            다른 PDF 업로드
          </button>
        </div>
      )}
    </div>
  );
}
