// 前后对比（ADR-022）：开发者改了一处（人设、边界提示、配置、护栏），再测一遍，看「改了什么」和「结果怎么变」。
// 只比同一套件版本、同一数据等级的两次运行；三层（角色原话 / 护栏处理 / 最终播出）分开比。
// 评审第二批（ADR-035）：两个通过数之间写一句差异摘要，逐题标「变好 / 变差」并把有变化的排前面，只有判定或原话层变了才算变化（R24）；
// 两次跑的题不一样时只比都跑了的题（R23）；模拟模式下说清改设定结果不会变（R16）；改动行不再用朱红（R19）。
// 端到端测试认的留着：标题「前后对比」、「人设 + 边界指纹 … 改了」单元格、「边界提示（按行比较）」、testid compare-table、
// 两个 tally-seal、页头里以运行编号为名的链接。摘要里不写「改了」（巡检脚本数这两个字）。

import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { RawBadge } from "@/components/Layers";
import { Badge, CaseBadge, TallySeal } from "@/components/ui";
import { modelsLine, POLICY_SHORT, VARIANT_SHORT } from "@/components/wording";
import { caseSets, compareRows, compareSummary } from "@/lib/domain/compare";
import { caseLayers, passTally } from "@/lib/domain/layers";
import { DEFAULT_PERSONA, lineDiff } from "@/lib/domain/persona";
import { FAMILY_LABEL, GUARDED_VARIANTS, type RunManifest } from "@/lib/domain/types";
import { compatibility, getReport, type ReportModel } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

function configRows(A: RunManifest, B: RunManifest): { label: string; a: string; b: string }[] {
  const pa = A.config.persona ?? DEFAULT_PERSONA;
  const pb = B.config.persona ?? DEFAULT_PERSONA;
  return [
    { label: "被测配置", a: VARIANT_SHORT[A.config.variant], b: VARIANT_SHORT[B.config.variant] },
    { label: "放行策略", a: POLICY_SHORT[A.config.policy], b: POLICY_SHORT[B.config.policy] },
    { label: "角色名", a: pa.name, b: pb.name },
    { label: "人设 + 边界指纹", a: A.hashes.persona, b: B.hashes.persona },
    { label: "护栏规则版本", a: A.hashes.guard_rules, b: B.hashes.guard_rules },
    { label: "裁判先查条文", a: A.config.judge_rag ? "是" : "否", b: B.config.judge_rag ? "是" : "否" },
    { label: "护栏固定延迟", a: `${A.config.guard_delay_ms ?? 0} ms`, b: `${B.config.guard_delay_ms ?? 0} ms` },
    { label: "模型", a: modelsLine(A.models), b: modelsLine(B.models) },
  ];
}

function TextDiff({ title, a, b }: { title: string; a: string; b: string }) {
  if (a === b) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold">{title}</h3>
      <pre className="mt-1 overflow-x-auto rounded-sm bg-background p-2 text-xs leading-relaxed whitespace-pre-wrap">
        {lineDiff(a, b).map((l, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 行号就是这一行在对比结果里的位置，不会重排
            key={i}
            className={l.kind === "add" ? "block bg-sunken font-medium" : l.kind === "del" ? "block text-muted line-through" : "block"}
          >
            {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
            {l.text || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}

function Missing({ text }: { text: string }) {
  return (
    <AppShell active="/runs">
      <div className="mx-auto w-full max-w-5xl space-y-2 p-4 text-sm">
        <h1 className="text-xl font-semibold">前后对比</h1>
        <p className="text-muted">{text}</p>
        <Link className="link" href="/runs">
          去运行记录选两次运行
        </Link>
      </div>
    </AppShell>
  );
}

export default async function ComparePage({ searchParams }: PageProps<"/compare">) {
  const sp = await searchParams;
  const a = typeof sp.a === "string" ? sp.a : undefined;
  const b = typeof sp.b === "string" ? sp.b : undefined;
  if (!a || !b) return <Missing text="要先选两次运行：改之前的一次（A）和改之后的一次（B）。" />;
  let A: ReportModel | null = null;
  let B: ReportModel | null = null;
  try {
    A = getReport(a);
    B = getReport(b);
  } catch {
    // 编号不合法时当成找不到
  }
  if (!A || !B) return <Missing text="找不到其中一次运行，可能已被删除。" />;
  const reason = compatibility(A.manifest, B.manifest);
  const pa = A.manifest.config.persona ?? DEFAULT_PERSONA;
  const pb = B.manifest.config.persona ?? DEFAULT_PERSONA;
  const rows = configRows(A.manifest, B.manifest);
  const ta = passTally(A.results, A.manifest.counts.planned);
  const tb = passTally(B.results, B.manifest.counts.planned);
  const ga = GUARDED_VARIANTS.includes(A.manifest.config.variant);
  const gb = GUARDED_VARIANTS.includes(B.manifest.config.variant);
  const sets = caseSets(A.results, B.results);
  const results = compareRows(A.results, B.results, ga, gb);
  const summary = compareSummary(results, { guardedA: ga, guardedB: gb });
  const crossed = (m: ReportModel, g: boolean) => m.results.filter((r) => caseLayers(r, g).raw.status === "crossed").length;
  const simulated = A.manifest.data_level !== "live";

  return (
    <AppShell active="/runs">
      <article className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <header className="space-y-1">
          <h1 className="text-2xl">前后对比</h1>
          <p className="font-mono text-xs text-muted">
            A（改之前）
            <Link className="link" href={`/reports/${a}`}>
              {a}
            </Link>{" "}
            → B（改之后）
            <Link className="link" href={`/reports/${b}`}>
              {b}
            </Link>
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={A.manifest.data_level === "live" ? "ok" : "warn"}>
              {A.manifest.data_level === "live" ? "真实模型数据" : "模拟数据：只说明流程，不能当实验结果"}
            </Badge>
            {(A.manifest.preview || B.manifest.preview) && <Badge tone="warn">含草稿用例：预览</Badge>}
            <Link className="link no-print ml-2 text-xs" href="/workbench?persona=open">
              改一处再测 →
            </Link>
          </div>
        </header>

        {reason ? (
          <p className="rounded-sm border border-warn/50 bg-warn-soft p-3">{reason}</p>
        ) : (
          <>
            {!sets.same && (
              <p className="rounded-sm border border-dashed border-warn px-3 py-2 text-xs">
                这两次跑的题不一样（A {A.results.length} 题、B {B.results.length} 题），下面印章上的通过数不能直接比；逐题只比两次都跑了的{" "}
                {sets.both.length} 题。
              </p>
            )}
            <section className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-sm border border-border bg-surface p-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">A 改之前</span>
                <TallySeal pass={ta.pass} total={ta.total} />
                <span className="text-xs text-muted">角色原话越界 {crossed(A, ga)} 例</span>
              </div>
              <span className="text-2xl text-muted" aria-hidden>
                →
              </span>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">B 改之后</span>
                <TallySeal pass={tb.pass} total={tb.total} />
                <span className="text-xs text-muted">角色原话越界 {crossed(B, gb)} 例</span>
              </div>
              <div className="min-w-0 max-w-md flex-1 space-y-1">
                <p className="font-medium" data-testid="compare-summary">
                  {summary}
                </p>
                <p className="text-xs text-muted">
                  「本次通过」看最终播出；「角色原话越界」看角色本身。护栏把越界拦住时，通过数会涨，但原话越界数不变——要让角色本身更稳，改人设或边界提示再测。
                </p>
              </div>
            </section>

            <section className="space-y-2 rounded-sm border border-border bg-surface p-3">
              <h2 className="font-semibold">改了什么</h2>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1">项目</th>
                    <th>A</th>
                    <th>B</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className={`border-t border-border ${r.a !== r.b ? "bg-sunken" : ""}`}>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {r.label}
                        {r.a !== r.b && <span className="ml-1 font-semibold">改了</span>}
                      </td>
                      <td className="pr-2 break-all">{r.a}</td>
                      <td className="break-all">{r.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <TextDiff title="人设（按行比较：+ 新加，- 删掉）" a={pa.persona} b={pb.persona} />
              <TextDiff title="边界提示（按行比较）" a={pa.boundaries} b={pb.boundaries} />
            </section>

            <section className="rounded-sm border border-border bg-surface p-3">
              <h2 className="mb-1 font-semibold">结果怎么变</h2>
              {simulated && (
                <p className="mb-2 text-xs text-warn">
                  模拟模式：角色用固定的句子回答，不读设定，改人设或边界提示，结果不会变；要看改设定的效果，需要接真实模型。
                </p>
              )}
              <p className="mb-2 text-xs text-muted">
                有变化的排在前面。只有最终播出的判定或角色原话层变了才算变化；护栏处理的说法不一样（比如换了配置），用小字标出。
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="compare-table">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-2">变化</th>
                      <th>用例</th>
                      <th>角色原话 A → B</th>
                      <th>护栏处理 A → B</th>
                      <th>最终播出 A → B</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((x) => {
                      const changed = x.verdictChanged || x.rawChanged;
                      return (
                        <tr key={x.case_id} className={`border-t border-border align-top ${changed ? "bg-sunken" : ""}`}>
                          <td className="py-1 pr-2 whitespace-nowrap">
                            {x.trend === "better" ? (
                              <span className="inline-flex items-center gap-0.5 font-semibold">
                                <ArrowUp size={12} aria-hidden />
                                变好
                              </span>
                            ) : x.trend === "worse" ? (
                              <span className="inline-flex items-center gap-0.5 font-semibold text-primary">
                                <ArrowDown size={12} aria-hidden />
                                变差
                              </span>
                            ) : (
                              <span className="text-muted">{changed ? "不一样" : "没变"}</span>
                            )}
                          </td>
                          <td className="py-1 pr-2">
                            <span className="block font-mono">{x.case_id}</span>
                            <span className="text-muted">{FAMILY_LABEL[x.family]}</span>
                          </td>
                          <td className="pr-2">
                            {x.la ? <RawBadge status={x.la.raw.status} /> : "—"} → {x.lb ? <RawBadge status={x.lb.raw.status} /> : "—"}
                          </td>
                          <td className="pr-2">
                            {x.guardChanged ? (
                              <>
                                <span className="block text-muted">A：{x.la?.guard.summary ?? "—"}</span>
                                <span className="block text-muted">B：{x.lb?.guard.summary ?? "—"}</span>
                              </>
                            ) : (
                              <span className="text-muted">{x.la?.guard.summary ?? "—"}</span>
                            )}
                          </td>
                          <td>
                            {x.a ? <CaseBadge status={x.a.status} verdict={x.a.verdict} /> : "—"} →{" "}
                            {x.b ? <CaseBadge status={x.b.status} verdict={x.b.verdict} /> : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!sets.same && (sets.onlyA.length > 0 || sets.onlyB.length > 0) && (
                <p className="mt-2 text-xs text-muted">
                  只在一边跑了的题（不比）：{[...sets.onlyA.map((id) => `A ${id}`), ...sets.onlyB.map((id) => `B ${id}`)].join("、")}
                </p>
              )}
            </section>
          </>
        )}
      </article>
    </AppShell>
  );
}
