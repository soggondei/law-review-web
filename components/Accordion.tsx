"use client";

import { useState } from "react";

export function Accordion({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-200">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-4 text-left hover:bg-gray-50 transition-colors">
        <span className="font-medium text-gray-800 text-[15px]">{title}</span>
        <div className="flex items-center gap-2">
          {badge && <span className="text-sm text-blue-600 font-medium">{badge}</span>}
          <span className="text-gray-400">{open ? "▼" : "▶"}</span>
        </div>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
