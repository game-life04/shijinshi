// 运行记录：时间、配置、模型、各类结果数、调用量；可选两次兼容的运行做比较。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import { Badge } from "@/components/ui";
import { VARIANT_LABEL } from "@/lib/domain/types";
import { compareRuns, listRuns } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

export default async function RunsPage({ searchParams }: PageProps<"/runs">) {
  const sp = await searchParams;
  const runs = listRuns();
  const a = typeof sp.a === "string" ? sp.a : undefined;
  const b = typeof sp.b === "string" ? sp.b : undefined;
  let comparison: ReturnType<typeof compareRuns> | null = null;
  let compareError: string | null = null;
  if (a && b) {
    try {
      comparison = compareRuns(a, b);
    } catch (e) {
      compareError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <AppShell active="/runs">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <h1 className="text-xl font-semibold">运行记录</h1>
        {!runs.length && <p className="text-muted">还没有运行记录。到「体检工作台」开始一次体检。</p>}
        {runs.length > 0 && (
          <form className="overflow-x-auto rounded-md border border-border bg-surface">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="p-2">比较 A</th>
                  <th>比较 B</th>
                  <th>运行</th>
                  <th>配置</th>
                  <th>数据</th>
                  <th>状态</th>
                  <th>计划 / 完成</th>
                  <th>合格 / 不合格 / 不确定</th>
                  <th>拦截 / 出错 / 取消 / 未执行</th>
                  <th>模型调用</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id} className="border-t border-border">
                    <td className="p-2">
                      <input type="radio" name="a" value={r.run_id} defaultChecked={a === r.run_id} aria-label={`选 ${r.run_id} 为 A`} />
                    </td>
                    <td>
                      <input type="radio" name="b" value={r.run_id} defaultChecked={b === r.run_id} aria-label={`选 ${r.run_id} 为 B`} />
                    </td>
                    <td>
                      <Link className="font-mono text-primary underline" href={`/reports/${r.run_id}`}>
                        {r.run_id}
                      </Link>
                    </td>
                    <td>
                      {VARIANT_LABEL[r.config.variant].split("（")[0]} · {r.config.policy} · {r.config.suite}
                    </td>
                    <td>
                      {r.data_level === "live" ? <Badge tone="ok">实时</Badge> : <Badge tone="warn">模拟</Badge>}
                      {r.preview && <Badge tone="warn">预览</Badge>}
                    </td>
                    <td>{r.state}</td>
                    <td className="font-mono">
                      {r.counts.planned} / {r.counts.completed}
                    </td>
                    <td className="font-mono">
                      {r.counts.pass} / {r.counts.fail} / {r.counts.uncertain}
                    </td>
                    <td className="font-mono">
                      {r.counts.provider_blocked} / {r.counts.error} / {r.counts.cancelled} / {r.counts.not_run}
                    </td>
                    <td className="font-mono">{r.usage.llm_calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-border p-2">
              <button type="submit" className="h-8 rounded border border-border px-3 hover:bg-background">
                比较选中的 A 和 B
              </button>
            </div>
          </form>
        )}
        {compareError && <p className="text-bad">{compareError}</p>}
        {comparison && (
          <section className="rounded-md border border-border bg-surface p-3">
            <h2 className="mb-1 font-semibold">
              比较 {a} → {b}
            </h2>
            {!comparison.compatible ? (
              <p className="text-warn">{comparison.reason}</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1">用例</th>
                    <th>A</th>
                    <th>B</th>
                    <th>变化</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((row) => (
                    <tr key={row.case_id} className="border-t border-border">
                      <td className="py-1 font-mono">{row.case_id}</td>
                      <td>{row.a ?? "—"}</td>
                      <td>{row.b ?? "—"}</td>
                      <td>{row.changed ? <Badge tone="primary">有变化</Badge> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}
