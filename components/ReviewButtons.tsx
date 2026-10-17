"use client";

// 人工复核按钮：确认，或改判为合格/不合格。复核后刷新报告页。

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Verdict } from "@/lib/domain/types";
import { Button } from "./ui";

export default function ReviewButtons({ runId, findingId, verdict }: { runId: string; findingId: string; verdict: Verdict }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (decision: "confirm" | "overturn", overturn_to?: Verdict) => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/runs/${runId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finding_id: findingId, decision, overturn_to }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "复核失败");
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {verdict !== "uncertain" && (
        <Button disabled={busy} onClick={() => send("confirm")}>
          确认结论
        </Button>
      )}
      {verdict !== "pass" && (
        <Button disabled={busy} onClick={() => send("overturn", "pass")}>
          改判合格
        </Button>
      )}
      {verdict !== "fail" && (
        <Button disabled={busy} onClick={() => send("overturn", "fail")}>
          改判不合格
        </Button>
      )}
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}
