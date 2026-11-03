// 前后对比（ADR-022）：开发者改了一处（人设、边界提示、配置、护栏），再测一遍，看「改了什么」和「结果怎么变」。
// 只比同一套件版本、同一数据等级的两次运行；三层（角色原话 / 护栏处理 / 最终播出）分开比。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import { RawBadge } from "@/components/Layers";
import { Badge, CaseBadge, TallySeal } from "@/components/ui";
import { caseLayers, passTally } from "@/lib/domain/layers";
import { DEFAULT_PERSONA, lineDiff } from "@/lib/domain/persona";
import { FAMILY_LABEL, GUARDED_VARIANTS, POLICY_LABEL, type RunManifest, VARIANT_LABEL } from "@/lib/domain/types";
import { compatibility, getReport, type ReportModel } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

function configRows(A: RunManifest, B: RunManifest): { label: string; a: string; b: string }[] {
  const pa = A.config.persona ?? DEFAULT_PERSONA;
  const pb = B.config.persona ?? DEFAULT_PERSONA;
  return [
    { label: "被测配置", a: VARIANT_LABEL[A.config.variant], b: VARIANT_LABEL[B.config.variant] },
    { label: "放行策略", a: POLICY_LABEL[A.config.policy], b: POLICY_LABEL[B.config.policy] },
    { label: "角色名", a: pa.name, b: pb.name },
    { label: "人设 + 边界指纹", a: A.hashes.persona, b: B.hashes.persona },
    { label: "护栏规则版本", a: A.hashes.guard_rules, b: B.hashes.guard_rules },
    { label: "裁判先查条文", a: A.config.judge_rag ? "是" : "否", b: B.config.judge_rag ? "是" : "否" },
    { label: "护栏固定延迟", a: `${A.config.guard_delay_ms ?? 0} ms`, b: `${B.config.guard_delay_ms ?? 0} ms` },
    {
      label: "模型",
      a: Object.entries(A.models)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
      b: Object.entries(B.models)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    },
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
            className={l.kind === "add" ? "block bg-primary-soft" : l.kind === "del" ? "block text-muted line-through" : "block"}
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
        <Link className="text-primary underline" href="/runs">
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
  const ids = [...new Set([...A.results.map((r) => r.case_id), ...B.results.map((r) => r.case_id)])];
  const crossed = (m: ReportModel, g: boolean) => m.results.filter((r) => caseLayers(r, g).raw.status === "crossed").length;

  return (
    <AppShell active="/runs">
      <article className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <header className="space-y-1">
          <h1 className="text-2xl">前后对比</h1>
          <p className="font-mono text-xs text-muted">
            A（改之前）
            <Link className="text-primary underline" href={`/reports/${a}`}>
              {a}
            </Link>{" "}
            → B（改之后）
            <Link className="text-primary underline" href={`/reports/${b}`}>
              {b}
            </Link>
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={A.manifest.data_level === "live" ? "ok" : "warn"}>
              {A.manifest.data_level === "live" ? "真实模型数据" : "模拟数据：只说明流程，不能当实验结果"}
            </Badge>
            {(A.manifest.preview || B.manifest.preview) && <Badge tone="warn">含草稿用例：预览</Badge>}
          </div>
        </header>

        {reason ? (
          <p className="rounded-sm border border-warn/50 bg-warn-soft p-3">{reason}</p>
        ) : (
          <>
            <section className="flex flex-wrap items-center gap-6 rounded-sm border border-border bg-surface p-3">
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs text-muted">A 改之前</span>
                <TallySeal pass={ta.pass} total={ta.total} />
                <span className="text-xs text-muted">角色原话越界 {crossed(A, ga)} 例</span>
              </div>
              <span className="text-2xl text-muted" aria-hidden>
                →
              </span>
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs text-muted">B 改之后</span>
                <TallySeal pass={tb.pass} total={tb.total} />
                <span className="text-xs text-muted">角色原话越界 {crossed(B, gb)} 例</span>
              </div>
              <p className="max-w-md text-xs text-muted">
                「本次通过」看最终播出；「角色原话越界」看角色本身。护栏把越界拦住时，通过数会涨，但原话越界数不变——要让角色本身更稳，改人设或边界提示再测。
              </p>
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
                    <tr key={r.label} className={`border-t border-border ${r.a !== r.b ? "bg-primary-soft/50" : ""}`}>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {r.label}
                        {r.a !== r.b && <span className="ml-1 text-primary">改了</span>}
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
              <h2 className="mb-2 font-semibold">结果怎么变</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="compare-table">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="py-1">用例</th>
                      <th>角色原话 A → B</th>
                      <th>护栏处理 A → B</th>
                      <th>最终播出 A → B</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ids.map((id) => {
                      const ra = A.results.find((r) => r.case_id === id);
                      const rb = B.results.find((r) => r.case_id === id);
                      const la = ra ? caseLayers(ra, ga) : undefined;
                      const lb = rb ? caseLayers(rb, gb) : undefined;
                      const changed =
                        la?.raw.status !== lb?.raw.status ||
                        la?.guard.summary !== lb?.guard.summary ||
                        (ra?.verdict ?? ra?.status) !== (rb?.verdict ?? rb?.status);
                      return (
                        <tr key={id} className={`border-t border-border align-top ${changed ? "bg-primary-soft/40" : ""}`}>
                          <td className="py-1 pr-2">
                            <span className="block font-mono">{id}</span>
                            <span className="text-muted">{FAMILY_LABEL[(ra ?? rb)?.family ?? "CANARY"]}</span>
                          </td>
                          <td className="pr-2">
                            {la ? <RawBadge status={la.raw.status} /> : "—"} → {lb ? <RawBadge status={lb.raw.status} /> : "—"}
                          </td>
                          <td className="pr-2">
                            <span className="block text-muted">A：{la?.guard.summary ?? "—"}</span>
                            <span className="block">B：{lb?.guard.summary ?? "—"}</span>
                          </td>
                          <td>
                            {ra ? <CaseBadge status={ra.status} verdict={ra.verdict} /> : "—"} →{" "}
                            {rb ? <CaseBadge status={rb.status} verdict={rb.verdict} /> : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </article>
    </AppShell>
  );
}
