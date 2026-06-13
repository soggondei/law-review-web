"use client";

import { Suspense, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const from   = useSearchParams().get("from") ?? "/";

  const [pw,      setPw]      = useState("");
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        router.push(from);
        router.refresh();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "인증 실패");
      }
    } catch {
      setError("네트워크 오류");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 w-80">
        {/* 로고 영역 */}
        <div className="mb-6">
          <p className="text-[11px] font-semibold tracking-widest text-gray-400 uppercase mb-1">
            Law Review
          </p>
          <h1 className="text-xl font-bold text-gray-900">건축 법규 검토</h1>
          <p className="text-sm text-gray-400 mt-1">접근 암호를 입력하세요</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            value={pw}
            onChange={e => { setPw(e.target.value); setError(""); }}
            placeholder="암호"
            autoFocus
            className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          />
          {error && (
            <p className="text-xs text-red-500 px-1">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !pw}
            className="w-full py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "확인 중…" : "입장"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
