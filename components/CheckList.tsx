// 工作台右边的「这次查七样」（ADR-031）：没开始时是一张说明，跑起来以后每道题一格，按判定盖章——
// 合格朱红框、不合格墨色实块、不确定淡墨虚线框、没出结果空框（和 ui.tsx 的判定徽标一个意思）；点格子看那道题。
// 每一样的说明照断言的意思用大白话写（components/wording.ts 的 PLAIN，体检单和考点卡同一句），不另加口径；
// 后五样标上对照《办法》的哪几条（评审 R05）。

import { FAMILY_LABEL, type Family, type Verdict } from "@/lib/domain/types";
import { familyClauses, LAW_FULL, PLAIN } from "./wording";

const VERDICT_LABEL: Record<Verdict, string> = { pass: "合格", fail: "不合格", uncertain: "不确定", not_applicable: "不适用" };

const ORDER = Object.keys(FAMILY_LABEL) as Family[];

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
  return (
    <div className={compact ? "mb-2 border-b border-border pb-2" : ""} data-testid="check-list">
      {!compact && (
        <p className="mb-1 text-xs text-muted">
          前两样是我们自己加的稳定性测试，和法规无关；后五样对照{LAW_FULL}。
          {started ? "每道题一格，点格子看那道题。" : "开始体检后，每道题在这里占一格，跑完盖章。"}
        </p>
      )}
      <ul className={compact ? "space-y-0.5" : "divide-y divide-border"}>
        {ORDER.map((f) => {
          const mine = cases.filter((c) => c.family === f);
          if (compact && mine.length === 0) return null; // 收起来时只留这套题里有的
          return (
            <li key={f} className={compact ? "" : "py-1.5"}>
              <div className={compact ? "grid grid-cols-[8.5rem_1fr] items-center gap-2" : "flex items-center justify-between gap-2"}>
                <span className={compact ? "truncate text-xs" : "text-sm font-medium"}>
                  {FAMILY_LABEL[f]}
                  {!compact && familyClauses(f) && <span className="ml-1 text-[11px] font-normal text-muted">{familyClauses(f)}</span>}
                </span>
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
              </div>
              {!compact && <p className="mt-0.5 text-xs text-muted">{PLAIN[f](name)}</p>}
            </li>
          );
        })}
      </ul>
      {!compact && started && (
        <p className="mt-2 text-[11px] text-muted">
          朱红框：合格 · 墨块 ✕：不合格 · 虚线框 ?：不确定 · 斜线：不适用 · 灰格：没出结果（出错、平台拒答、终止或没跑）· 空框：还没跑
        </p>
      )}
    </div>
  );
}
