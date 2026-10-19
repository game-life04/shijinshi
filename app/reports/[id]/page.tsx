// 证据报告：版本与范围、完整分母、分类结果、逐条原文证据与条文、待复核、不能用对话测的义务、局限、来源（规格 01 §3.6）。

import { notFound } from "next/navigation";
import AppShell from "@/components/AppShell";
import ReviewButtons from "@/components/ReviewButtons";
import { FindingView, TurnView } from "@/components/Transcript";
import { Badge, CaseBadge } from "@/components/ui";
import { FAMILY_LABEL, type Family, POLICY_LABEL, type UtteranceAudio, VARIANT_LABEL } from "@/lib/domain/types";
import { getClause } from "@/lib/server/rag";
import { getReport } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

const NOT_TESTABLE = [
  { id: "anthropomorphic-2026:13", what: "发现极端情境时及时联络监护人或紧急联系人", why: "属于服务运营能力，对话测试测不到" },
  { id: "anthropomorphic-2026:14", what: "识别未成年人身份、监护人同意、未成年人模式与相关设置", why: "首版只测自报未成年后的对话边界" },
  { id: "anthropomorphic-2026:16", what: "交互数据的加密、访问控制、复制删除与训练限制", why: "属于数据处理制度，不在对话测试范围" },
  { id: "anthropomorphic-2026:22", what: "特定情形下开展安全评估并报送", why: "本报告只是部分自查证据，不能替代规定的安全评估" },
];

export default async function ReportPage({ params }: PageProps<"/reports/[id]">) {
  const { id } = await params;
  let report: ReturnType<typeof getReport> = null;
  try {
    report = getReport(id);
  } catch {
    notFound();
  }
  if (!report) notFound();
  const { manifest: m, results, byFamily, pendingReview } = report;
  const c = m.counts;
  const clauseText = (cid: string) => getClause(cid)?.text;
  const finished = ["completed", "cancelled", "failed"].includes(m.state);
  const sourceClause = getClause("anthropomorphic-2026:18");
  // 语音计量汇总（只统计浏览器实际上报的轮次）
  const audioTurns = results.flatMap((r) => r.turns.flatMap((t) => (t.audio ? [{ case_id: r.case_id, turn: t, audio: t.audio }] : [])));
  const played = audioTurns.filter((x) => x.audio.status === "played");
  const cuts = played.flatMap((x) =>
    x.audio.utterances
      .filter((u): u is UtteranceAudio & { violation: [number, number][] } => Boolean(u.violation))
      .map((u) => ({ ...u, case_id: x.case_id })),
  );
  const firsts = played
    .map((x) => x.audio.first_audio_ms)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  const audioLevel = played[0]?.audio.level;

  return (
    <AppShell active="/runs">
      <article className="mx-auto w-full max-w-5xl space-y-4 p-4 text-sm">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">体检报告 · {m.run_id}</h1>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={m.data_level === "live" ? "ok" : "warn"}>
              {m.data_level === "live" ? "真实模型数据" : "模拟数据：不能作为实验结果"}
            </Badge>
            {m.preview && <Badge tone="warn">含草稿用例：预览，不计入正式统计</Badge>}
            <Badge tone="muted">AI 辅助生成；自查辅助，不是合规认证</Badge>
          </div>
        </header>

        <section className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">版本与范围</h2>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            <dt className="text-muted">被测配置</dt>
            <dd>{VARIANT_LABEL[m.config.variant]}</dd>
            <dt className="text-muted">放行策略</dt>
            <dd>{POLICY_LABEL[m.config.policy]}</dd>
            <dt className="text-muted">语音播放</dt>
            <dd>{m.config.voice ? `开（合成：${m.models.tts ?? "未知"}）` : "关（文字运行）"}</dd>
            {Boolean(m.config.guard_delay_ms) && (
              <>
                <dt className="text-muted">护栏固定延迟</dt>
                <dd>{m.config.guard_delay_ms} ms（实验设定，用来观察放行策略的差别，不代表真实模型的延迟）</dd>
              </>
            )}
            <dt className="text-muted">用例套件 / 版本</dt>
            <dd className="font-mono">
              {m.config.suite} / {m.hashes.suite}
            </dd>
            <dt className="text-muted">人设 / 护栏规则 / 条文库版本</dt>
            <dd className="font-mono">
              {m.hashes.persona} / {m.hashes.guard_rules} / {m.hashes.kb}
            </dd>
            <dt className="text-muted">模型</dt>
            <dd className="font-mono text-xs">
              {Object.entries(m.models)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ")}
            </dd>
            <dt className="text-muted">裁判检索条文</dt>
            <dd>{m.config.judge_rag ? "是" : "否"}</dd>
            <dt className="text-muted">时间</dt>
            <dd>
              {m.started_at ?? m.created_at} → {m.finished_at ?? "未结束"}（状态：{m.state}
              {m.failure_reason ? `，${m.failure_reason}` : ""}）
            </dd>
            <dt className="text-muted">模型调用 / tokens</dt>
            <dd className="font-mono">
              {m.usage.llm_calls} 次 / 入 {m.usage.prompt_tokens}、出 {m.usage.completion_tokens}
              {m.usage.tts_chars !== undefined ? ` / 语音合成 ${m.usage.tts_chars} 字` : ""}
            </dd>
          </dl>
        </section>

        <section className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">完整分母</h2>
          <p className="font-mono">
            计划 {c.planned} = 完成 {c.completed} + 平台拦截 {c.provider_blocked} + 出错 {c.error} + 取消 {c.cancelled} + 未执行 {c.not_run}
          </p>
          <p className="font-mono">
            完成 {c.completed} = 合格 {c.pass} + 不合格 {c.fail} + 不确定 {c.uncertain} + 不适用 {c.not_applicable}
          </p>
          <p className="mt-1 text-xs text-muted">
            「已判定合格比例」= 合格 ÷（合格 + 不合格）={" "}
            {c.pass + c.fail ? `${Math.round((c.pass / (c.pass + c.fail)) * 100)}%` : "无法计算（没有已判定项）"}
            。它只是局部可判定项的统计，不是整体合规率；出错不计作通过。
          </p>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1">类别</th>
                <th>合格</th>
                <th>不合格</th>
                <th>不确定</th>
                <th>不适用</th>
                <th>未完成（拦截/出错/取消/未执行）</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(byFamily).map(([fam, b]) => (
                <tr key={fam} className="border-t border-border">
                  <td className="py-1">{FAMILY_LABEL[fam as Family]}</td>
                  <td>{b.pass}</td>
                  <td>{b.fail}</td>
                  <td>{b.uncertain}</td>
                  <td>{b.not_applicable}</td>
                  <td>{b.other}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {m.config.voice && (
          <section className="rounded-md border border-border bg-surface p-3">
            <h2 className="mb-1 font-semibold">语音计量（浏览器渲染层）</h2>
            <p className="mb-2 text-xs text-muted">
              口径：违规音频渲染时长 = 违规内容的采样区间 ∩ 浏览器 AudioWorklet 实际渲染过的采样区间（规格 02
              §4.2），由服务端用浏览器上报的区间计算； 首声等待 = 浏览器收到本轮输入事件 → 第一个非静音采样被渲染；停止响应是「收到截断 →
              确认已丢弃旧音频」的上界。 都不是扬声器实听的数字。
              {audioLevel === "simulation" ? "本次是模拟发声，按字精确定位；数字只说明机制，不能当实验结果。" : ""}
            </p>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <dt className="text-muted">已计量的轮次</dt>
              <dd>
                {played.length} / {audioTurns.length}
                {audioTurns.length > played.length ? "（其余轮次没有浏览器上报，不计量）" : ""}
              </dd>
              <dt className="text-muted">首声等待</dt>
              <dd>
                {firsts.length
                  ? `中位数 ${firsts[firsts.length >> 1]} ms，最小 ${firsts[0]} ms，最大 ${firsts.at(-1)} ms（${firsts.length} 轮）`
                  : "待测"}
              </dd>
              <dt className="text-muted">截断次数</dt>
              <dd>{cuts.length}</dd>
            </dl>
            {cuts.length > 0 && (
              <table className="mt-2 w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1">句子</th>
                    <th>违规音频渲染</th>
                    <th>定位精度</th>
                    <th>截断前已渲染</th>
                    <th>停止响应</th>
                    <th>口型归零</th>
                  </tr>
                </thead>
                <tbody>
                  {cuts.map((u) => (
                    <tr key={u.utterance_id} className="border-t border-border">
                      <td className="py-1 font-mono">{u.utterance_id}</td>
                      <td>{u.leak_rendered_ms ?? "—"} ms</td>
                      <td>{u.violation_level === "char" ? "按字精确" : "句级上界"}</td>
                      <td>{u.rendered_ms} ms</td>
                      <td>≤ {u.cancel_to_stop_ms ?? "—"} ms</td>
                      <td>{u.cancel_to_mouth_zero_ms ?? "—"} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {pendingReview.length > 0 && (
          <section className="rounded-md border border-warn/50 bg-warn-soft p-3">
            <h2 className="font-semibold">待人工复核：{pendingReview.length} 条</h2>
            <p className="text-xs text-muted">复核前，待复核的「合格」只计为不确定；待复核的「不合格」仍按不合格计。</p>
          </section>
        )}

        <section className="space-y-2">
          <h2 className="font-semibold">逐例结果</h2>
          {results.map((r) => (
            <details
              key={r.case_id}
              className="rounded-md border border-border bg-surface p-3"
              open={r.verdict === "fail" || r.findings.some((f) => f.review_status === "pending")}
            >
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                <span className="font-mono">{r.case_id}</span>
                <span className="text-muted">{FAMILY_LABEL[r.family]}</span>
                {r.approval !== "approved" && <Badge tone="warn">草稿</Badge>}
                <CaseBadge status={r.status} verdict={r.verdict} />
                {r.error && <span className="text-xs text-muted">{r.error}</span>}
              </summary>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                <div>
                  {r.turns.map((t) => (
                    <TurnView key={t.turn_id} turn={t} evidence={r.findings.flatMap((f) => f.evidence)} />
                  ))}
                  {!r.turns.length && <p className="text-muted">没有对话记录</p>}
                </div>
                <div>
                  {r.findings.map((f) => (
                    <div key={f.finding_id}>
                      <FindingView f={f} clauseText={clauseText} />
                      {finished && f.review_status === "pending" && (
                        <ReviewButtons runId={m.run_id} findingId={f.finding_id} verdict={f.verdict} />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </details>
          ))}
        </section>

        <section className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-1 font-semibold">对话测试测不到的义务（不计入任何通过率）</h2>
          <ul className="list-disc space-y-1 pl-5">
            {NOT_TESTABLE.map((n) => (
              <li key={n.what}>
                <span className="font-mono text-xs">{n.id}</span> {n.what}：<span className="text-muted">{n.why}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-1 font-semibold">局限</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>用例数量有限，结论只代表本套件覆盖的情形；未测项不能视为通过。</li>
            <li>护栏的规则只能发现明显线索；语义判断依赖裁判模型，存在误判，需人工复核。</li>
            <li>语音用例（音频停止、口型、麦克风）需要语音链路，文字运行中记为未执行或不适用。</li>
            <li>是否适用拟人化办法（第二条）需针对具体被测目标单独判断。第二十八条只是政策背景，本项目没有获得任何官方资质。</li>
            {m.data_level !== "live" && <li>本次为模拟数据，只用于验证流程，不代表任何真实模型的表现。</li>}
          </ul>
        </section>

        <section className="rounded-md border border-border bg-surface p-3 text-xs">
          <h2 className="mb-1 text-sm font-semibold">来源</h2>
          <p>
            《{sourceClause?.law}》（{sourceClause?.version}，{sourceClause?.effective} 施行）。条文取自{" "}
            <a className="text-primary underline" href={sourceClause?.source_url} target="_blank" rel="noreferrer">
              湖南省人民政府网转载页
            </a>
            （页面注明来源为国家互联网信息办公室网站），快照 SHA-256 <span className="font-mono">{sourceClause?.snapshot_sha256}</span>。
          </p>
        </section>
      </article>
    </AppShell>
  );
}
