"use client";

// 工作台右边的「这次查七样」（ADR-031）：没开始时是一张清单，跑起来以后每道题一格，按判定盖章——
// 合格朱红框、不合格墨色实块、不确定淡墨虚线框、没出结果空框（和 ui.tsx 的判定徽标一个意思）；点格子看那道题。
// 每一样的说明照断言的意思用大白话写（components/wording.ts 的 PLAIN，体检单和考点卡同一句），不另加口径；
// 后五样标上对照《办法》的哪几条（评审 R05）。
// ADR-049（学妹：「信息太繁杂」）：开头那段说明换成两个小标题（我们加的两样 / 对照法规的五样）；每样的说明默认收起，
// 点「每样查什么」才展开（鼠标停在名字上也看得到）；格子的意思画成一排小格子，不再写一长串。
// 字不小于 12px；对照法规的那个小标题用正文色（比灰字深一档）：顶上一行之外，这里也点名对照哪部法规（R05）。

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { ENGINEERING_FAMILIES, FAMILY_LABEL, type Family, type Verdict } from "@/lib/domain/types";
import { familyClauses, LAW_FULL, PLAIN } from "./wording";

const VERDICT_LABEL: Record<Verdict, string> = { pass: "合格", fail: "不合格", uncertain: "不确定", not_applicable: "不适用" };

const ORDER = Object.keys(FAMILY_LABEL) as Family[];

/** 前两样是我们自己加的稳定性测试，和法规无关；后五样对照《人工智能拟人化互动服务管理暂行办法》 */
const GROUPS: { key: string; label: string; families: Family[] }[] = [
  { key: "ours", label: "我们加的稳定性测试 · 和法规无关", families: ORDER.filter((f) => ENGINEERING_FAMILIES.includes(f)) },
  { key: "law", label: `对照${LAW_FULL}`, families: ORDER.filter((f) => !ENGINEERING_FAMILIES.includes(f)) },
];

type CellState = { status?: string; verdict?: string };

// 格子（评审 R44，和 R19 的章法一致）：合格朱红框、不合格墨块带 ✕、不确定虚线框带 ?、不适用细框带一道斜线、
// 没出结果（出错、平台拒答、终止、没跑）灰格、还没跑的空框（边框用 muted，看得见）
function cellClass(s: CellState | undefined) {
  if (s?.status === "completed") {
    if (s.verdict === "pass") return "border-2 border-primary";
    if (s.verdict === "fail") return "bg-foreground text-surface";
    if (s.verdict === "uncertain") return "border border-dashed border-warn text-warn";
    return "border border-muted text-muted";
  }
  if (s?.status === "running") return "border border-primary bg-primary-soft motion-safe:animate-pulse";
  if (s?.status) return "border border-muted bg-sunken"; // 出错、平台拒答、终止、没跑
  return "border border-muted";
}

function cellMark(s: CellState | undefined): string {
  if (s?.status !== "completed") return "";
  return s.verdict === "fail" ? "✕" : s.verdict === "uncertain" ? "?" : s.verdict === "not_applicable" ? "／" : "";
}

/** 格子的说明。读屏念的名字不带题号（题号在左边的列表按钮里，免得同一道题有两个同名按钮），鼠标悬停时带题号 */
function cellLabel(who: string, s: CellState | undefined) {
  if (s?.status === "completed" && s.verdict) return `${who}：${VERDICT_LABEL[s.verdict as Verdict] ?? s.verdict}`;
  if (s?.status === "running") return `${who}：正在跑`;
  return `${who}：${s?.status ? "没出结果" : "还没跑"}`;
}

/** 格子的意思：画一排和真格子一样的小格子（ADR-049：原来是一长串字） */
const LEGEND: { s: CellState; label: string; hint?: string }[] = [
  { s: { status: "completed", verdict: "pass" }, label: "合格" },
  { s: { status: "completed", verdict: "fail" }, label: "不合格" },
  { s: { status: "completed", verdict: "uncertain" }, label: "不确定" },
  { s: { status: "completed", verdict: "not_applicable" }, label: "不适用" },
  { s: { status: "error" }, label: "没出结果", hint: "出错、平台拒答、终止或没跑" },
  { s: {}, label: "还没跑" },
];

function Legend() {
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted" aria-label="格子的意思">
      {LEGEND.map((l) => (
        <li key={l.label} className="flex items-center gap-1" title={l.hint}>
          <span aria-hidden className={`grid h-3 w-3 place-items-center rounded-[2px] text-[8px] leading-none ${cellClass(l.s)}`}>
            {cellMark(l.s)}
          </span>
          {l.label}
          {l.hint && <span className="sr-only">（{l.hint}）</span>}
        </li>
      ))}
      <li>· 点格子看那道题</li>
    </ul>
  );
}

export default function CheckList({
  cases,
  state,
  name,
  started,
  selected,
  compact = false,
  onPick,
}: {
  cases: { id: string; family: Family }[];
  state: Map<string, CellState>;
  name: string;
  started: boolean;
  selected: string | null;
  /** 看某一道题的时候只留一行一样，不写说明 */
  compact?: boolean;
  onPick: (id: string) => void;
}) {
  /** 每样的大白话说明：默认收着，点「每样查什么」才展开（ADR-049） */
  const [explain, setExplain] = useState(false);
  const cells = (f: Family) => {
    const mine = cases.filter((c) => c.family === f);
    return (
      <span className={`flex shrink-0 flex-wrap gap-1.5 ${compact ? "" : "justify-end"}`}>
        {mine.length === 0 && <span className="text-[11px] text-muted">这套题里没有</span>}
        {mine.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c.id)}
            title={cellLabel(c.id, state.get(c.id))}
            aria-label={cellLabel(`${FAMILY_LABEL[f]}第 ${i + 1} 题`, state.get(c.id))}
            // 看着是 16px 的小格，点按的地方往外扩到 32px（手机上手指点得中）
            className={`relative grid h-4 w-4 place-items-center rounded-[2px] text-[10px] leading-none before:absolute before:-inset-2 before:content-[''] ${cellClass(state.get(c.id))} ${selected === c.id ? "outline-2 outline-offset-1 outline-foreground" : ""}`}
          >
            <span aria-hidden>{cellMark(state.get(c.id))}</span>
          </button>
        ))}
      </span>
    );
  };

  if (compact) {
    // 看某一道题的时候：只留这套题里有的几样，一样一行
    return (
      <div className="mb-2 border-b border-border pb-2" data-testid="check-list">
        <ul className="space-y-0.5">
          {ORDER.filter((f) => cases.some((c) => c.family === f)).map((f) => (
            <li key={f} className="grid grid-cols-[8.5rem_1fr] items-center gap-2">
              <span className="truncate text-xs">{FAMILY_LABEL[f]}</span>
              {cells(f)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div data-testid="check-list">
      <div className="space-y-2.5">
        {GROUPS.map((g, gi) => (
          <div key={g.key}>
            <div className="flex items-start justify-between gap-2">
              <h3 className={`min-w-0 text-xs leading-snug ${g.key === "law" ? "text-foreground/85" : "text-muted"}`}>{g.label}</h3>
              {gi === 0 && (
                <button
                  type="button"
                  onClick={() => setExplain((o) => !o)}
                  aria-expanded={explain}
                  className="-mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-xs text-muted hover:bg-background hover:text-foreground"
                >
                  每样查什么
                  <ChevronDown size={12} className={`transition-transform ${explain ? "rotate-180" : ""}`} aria-hidden />
                </button>
              )}
            </div>
            <ul className="divide-y divide-border">
              {g.families.map((f) => (
                <li key={f} className="py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 text-sm" title={explain ? undefined : PLAIN[f](name)}>
                      {FAMILY_LABEL[f]}
                      {familyClauses(f) && <span className="ml-1 whitespace-nowrap text-xs text-muted">{familyClauses(f)}</span>}
                    </span>
                    {cells(f)}
                  </div>
                  {explain && <p className="mt-0.5 text-xs text-muted">{PLAIN[f](name)}</p>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {started ? <Legend /> : <p className="mt-2 text-xs text-muted">一格一道题，开始体检后跑完一道盖一格。</p>}
    </div>
  );
}
