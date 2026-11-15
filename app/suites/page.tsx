// 用例库：每个套件的校验结果，以及每条用例的类别、来源、审核状态、预期行为、断言和条款。
// 保留集封存（ADR-050）：只写一行题数、指纹、校验结果，不列题目。
// 按类别收起来（ADR-051，11-15 队员 B：用例库按类别整合，不用都摆出来）：每个套件里七类各一行（几题、依据哪条、举一句问法），
// 点开才是那一类的题目表；页面顶上那段「用例文件在 suites/*.jsonl…」的说明删了（结构说明在仓库 README 和第 4 章）。

import { ChevronRight } from "lucide-react";
import AppShell from "@/components/AppShell";
import { Badge } from "@/components/ui";
import { listSuites } from "@/lib/domain/cases";
import { type CaseV1, FAMILIES, FAMILY_LABEL } from "@/lib/domain/types";
import { publicSuites, sealedSuites } from "@/lib/server/sealed";

export const dynamic = "force-dynamic";

const clause = (x: string) => `${x.replace("anthropomorphic-2026:", "第")}条`;

/** 一类里引到的条款（去重，按出现顺序） */
const clausesOf = (cases: CaseV1[]) => [...new Set(cases.flatMap((c) => c.clause_refs))].map(clause);

export default function SuitesPage() {
  const all = listSuites();
  const suites = publicSuites(all);
  const sealed = sealedSuites(all);
  return (
    <AppShell active="/suites">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <h1 className="text-xl font-semibold">用例库</h1>
        {suites.map((s) => (
          <section key={s.id} className="rounded-sm border border-border bg-surface" data-testid="suite" data-suite={s.id}>
            <header className="flex flex-wrap items-center gap-2 border-b border-border p-2">
              <h2 className="font-semibold">{s.id}</h2>
              <span className="text-xs text-muted">{s.cases.length} 题</span>
              <code className="text-xs text-muted">{s.file}</code>
              <code className="text-xs text-muted">SHA-256 {s.sha256.slice(0, 16)}</code>
              {s.errors.length ? <Badge tone="bad">校验失败 {s.errors.length} 处</Badge> : <Badge tone="ok">校验通过</Badge>}
            </header>
            {s.errors.length > 0 && (
              <ul className="list-disc p-2 pl-6 text-xs text-bad">
                {s.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {FAMILIES.map((f) => {
              const cases = s.cases.filter((c) => c.family === f);
              if (!cases.length) return null;
              const approved = cases.filter((c) => c.approval === "approved").length;
              const refs = clausesOf(cases);
              return (
                <details
                  key={f}
                  className="group border-t border-border first-of-type:border-t-0"
                  data-testid="suite-family"
                  data-family={f}
                >
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 hover:bg-background [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={14} className="shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
                    <span className="font-medium">{FAMILY_LABEL[f]}</span>
                    <span className="text-xs text-muted">
                      {cases.length} 题{approved === cases.length ? " · 已审核" : approved ? ` · 已审核 ${approved}` : " · 草稿"}
                      {refs.length > 0 && ` · 依据${refs.join("、")}`}
                    </span>
                    <span className="min-w-0 flex-1 basis-[16rem] truncate text-xs text-muted">
                      {/* 举一句越界题的问法（第一题常常是测误拦的「正常请求」，看不出这一类在测什么） */}
                      比如：{(cases.find((c) => c.intent === "violation") ?? cases[0]).inputs[0]?.content}
                    </span>
                  </summary>
                  <div className="overflow-x-auto border-t border-dashed border-border">
                    <table className="w-full min-w-[52rem] text-xs">
                      <thead>
                        <tr className="text-left text-muted">
                          <th className="p-2">ID</th>
                          <th>方式</th>
                          <th>审核</th>
                          <th>输入</th>
                          <th>期望</th>
                          <th>断言</th>
                          <th>条款</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cases.map((c) => (
                          <tr key={c.id} className="border-t border-border align-top">
                            <td className="p-2 font-mono">{c.id}</td>
                            <td>{c.modality === "voice" ? "语音" : "文字"}</td>
                            <td>
                              {c.approval === "approved" ? (
                                <Badge tone="ok">已审核</Badge>
                              ) : (
                                <Badge tone="warn">{c.approval === "draft" ? "草稿" : "已拒绝"}</Badge>
                              )}
                            </td>
                            <td className="max-w-[16rem]">{c.inputs.map((i) => i.content).join(" ／ ")}</td>
                            <td className="max-w-[18rem] text-muted">{c.expected.observable_behavior}</td>
                            <td className="font-mono">{c.expected.assertion_ids.join(" ")}</td>
                            <td className="font-mono">{c.clause_refs.map(clause).join(" ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })}
          </section>
        ))}
        {sealed.map((s) => (
          <section key={s.id} className="rounded-sm border border-border bg-surface" data-testid="sealed-suite">
            <header className="flex flex-wrap items-center gap-2 p-2">
              <h2 className="font-semibold">{s.id}</h2>
              <code className="text-xs text-muted">{s.file}</code>
              <code className="text-xs text-muted">SHA-256 {s.sha256.slice(0, 16)}</code>
              {s.errors ? <Badge tone="bad">校验失败 {s.errors} 处</Badge> : <Badge tone="ok">校验通过</Badge>}
              <Badge tone="muted">封存</Badge>
            </header>
            <p className="border-t border-border p-2 text-muted">
              保留集{s.errors ? "" : ` ${s.count} 题`}：出正式结果用的，题目不在网页上显示，也不能在网页上跑。
            </p>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
