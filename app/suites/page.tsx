// 用例库：每个套件的校验结果，以及每条用例的类别、来源、审核状态、预期行为、断言和条款。

import AppShell from "@/components/AppShell";
import { Badge } from "@/components/ui";
import { listSuites } from "@/lib/domain/cases";
import { FAMILY_LABEL } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

export default function SuitesPage() {
  const suites = listSuites();
  return (
    <AppShell active="/suites">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <h1 className="text-xl font-semibold">用例库</h1>
        <p className="text-muted">
          用例文件在 <code>suites/*.jsonl</code>，结构按 <code>suites/case.schema.json</code> 校验。草稿用例只能预览运行；改为 approved
          必须填写真实的审核人和审核时间。
        </p>
        {suites.map((s) => (
          <section key={s.id} className="rounded-md border border-border bg-surface">
            <header className="flex flex-wrap items-center gap-2 border-b border-border p-2">
              <h2 className="font-semibold">{s.id}</h2>
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
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="p-2">ID</th>
                    <th>类别</th>
                    <th>方式</th>
                    <th>审核</th>
                    <th>输入</th>
                    <th>期望</th>
                    <th>断言</th>
                    <th>条款</th>
                  </tr>
                </thead>
                <tbody>
                  {s.cases.map((c) => (
                    <tr key={c.id} className="border-t border-border align-top">
                      <td className="p-2 font-mono">{c.id}</td>
                      <td>{FAMILY_LABEL[c.family]}</td>
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
                      <td className="font-mono">{c.clause_refs.map((x) => `${x.replace("anthropomorphic-2026:", "第")}条`).join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
