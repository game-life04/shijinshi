"use client";

// 人工复核按钮：确认，或改判为合格/不合格；复核过的可以撤销（回到待复核）。复核后刷新报告页。
// 评审 R31：改之前确认一次（体检单的结论和通过数会跟着变）；谁复核的、什么时候，服务端记下，体检单上写出来。

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toLoginIfExpired } from "@/lib/client/session-expired";
import type { Verdict } from "@/lib/domain/types";
import { Button } from "./ui";

const LABEL: Record<Verdict, string> = { pass: "合格", fail: "不合格", uncertain: "不确定", not_applicable: "不适用" };

export default function ReviewButtons({
  runId,
  findingId,
  verdict,
  reviewed = false,
}: {
  runId: string;
  findingId: string;
  verdict: Verdict;
  /** 这条已经复核过：只给「撤销这次复核」 */
  reviewed?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (decision: "confirm" | "overturn" | "undo", overturn_to?: Verdict) => {
    const ask =
      decision === "undo"
        ? "撤销这次复核？这条结论会回到「待复核」，这道题的判定和通过数跟着变回去。"
        : decision === "confirm"
          ? `确认这条结论是「${LABEL[verdict]}」？体检单会按它计分，复核人和时间会记下来。`
          : `把这条结论改判成「${LABEL[overturn_to ?? "pass"]}」？这道题的判定和通过数会跟着变，复核人和时间会记下来。`;
    if (!window.confirm(ask)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/runs/${runId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finding_id: findingId, decision, overturn_to }),
    });
    setBusy(false);
    if (!res.ok) {
      if (toLoginIfExpired(res.status)) return;
      setError((await res.json().catch(() => ({}))).error ?? "复核失败");
      return;
    }
    router.refresh();
  };

  if (reviewed) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Button disabled={busy} onClick={() => send("undo")}>
          撤销这次复核
        </Button>
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>
    );
  }
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
