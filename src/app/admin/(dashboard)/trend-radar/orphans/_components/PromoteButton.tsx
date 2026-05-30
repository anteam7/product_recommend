"use client";

import { useState, useTransition } from "react";
import { promoteOrphan } from "../actions";

export function PromoteButton({
  keyword,
  category,
}: {
  keyword: string;
  category: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (done) {
    return <span className="text-xs font-medium text-emerald-600">승격됨 ✓</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await promoteOrphan(keyword, category);
            if (res.ok) setDone(true);
            else setErr(res.error ?? "실패");
          })
        }
        className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
      >
        {pending ? "승격 중…" : "캔버스로 승격"}
      </button>
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </div>
  );
}
