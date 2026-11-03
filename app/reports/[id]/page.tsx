// 体检单：印章「本次通过 X/Y 项」、版本与范围、完整分母、分类结果、逐例三层（角色原话 / 护栏处理 / 最终播出）与原文证据、
// 待复核、不能用对话测的义务、局限、来源（规格 01 §3.6，ADR-022）。可以用浏览器打印导出 PDF。

import Link from "next/link";
import { notFound } from "next/navigation";
import AppShell from "@/components/AppShell";
import { LayeredTurns, LayerStrip } from "@/components/Layers";
import PrintButton from "@/components/PrintButton";
import ReviewButtons from "@/components/ReviewButtons";
import { FindingView } from "@/components/Transcript";
import { Badge, CaseBadge, TallySeal } from "@/components/ui";
import { caseLayers, passTally } from "@/lib/domain/layers";
import { DEFAULT_PERSONA } from "@/lib/domain/persona";
import { FAMILY_LABEL, type Family, GUARDED_VARIANTS, POLICY_LABEL, type UtteranceAudio, VARIANT_LABEL } from "@/lib/domain/types";
import { getClause } from "@/lib/server/rag";
import { getReport, previousCompatible } from "@/lib/server/runs";

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
  const guarded = GUARDED_VARIANTS.includes(m.config.variant);
  const tally = passTally(results, c.planned);
  const persona = m.config.persona ?? DEFAULT_PERSONA;
  const prev = finished ? previousCompatible(m.run_id) : null;

  return (
    <AppShell active="/runs">
      <article className="mx-auto w-full max-w-5xl space-y-4 p-4 text-sm">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="flex flex-wrap items-baseline gap-x-3 text-2xl">
              体检单
              <span className="font-mono text-sm text-muted">{m.run_id}</span>
            </h1>
            <p>
              被测角色：{persona.name}
              <span className="text-muted">
                （{m.config.persona ? "开发者自己的设定" : "默认角色"} · {VARIANT_LABEL[m.config.variant]}）
              </span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={m.data_level === "live" ? "ok" : "warn"}>
                {m.data_level === "live" ? "真实模型数据" : "模拟数据：不能作为实验结果"}
              </Badge>
              {m.preview && <Badge tone="warn">含草稿用例：预览，不计入正式统计</Badge>}
              <Badge tone="muted">AI 辅助生成；自查辅助，不是合规认证</Badge>
            </div>
            <div className="no-print flex flex-wrap items-center gap-2 pt-1">
              <PrintButton />
              {prev && (
                <Link className="text-xs text-primary underline" href={`/compare?a=${prev}&b=${m.run_id}`}>
                  和上一次比（{prev} → 这次）
                </Link>
              )}
            </div>
          </div>
          <div className="flex flex-col items-center gap-1 pr-2">
            <TallySeal pass={tally.pass} total={tally.total} />
            <span className="text-xs text-muted">
              不合格 {c.fail} · 不确定 {c.uncertain} · 不适用 {c.not_applicable} · 未完成 {c.planned - c.completed}
            </span>
          </div>
        </header>

        <section className="rounded-sm border border-border bg-surface p-3">
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

        <section className="rounded-sm border border-border bg-surface p-3">
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
          <section className="rounded-sm border border-border bg-surface p-3">
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
          <section className="rounded-sm border border-warn/50 bg-warn-soft p-3">
            <h2 className="font-semibold">待人工复核：{pendingReview.length} 条</h2>
            <p className="text-xs text-muted">复核前，待复核的「合格」只计为不确定；待复核的「不合格」仍按不合格计。</p>
          </section>
        )}

        <section className="space-y-2">
          <h2 className="font-semibold">逐例结果</h2>
          <p className="text-xs text-muted">
            每例分三层看：角色原话（角色本身想说什么）→ 护栏处理（拦了什么、换了什么）→ 最终播出（用户实际看到、听到的）。
            判定只看最终播出，所有类别同一个口径；角色原话越界但被拦下的，说明护栏起了作用，也说明人设或边界提示还可以改。
          </p>
          {results.map((r) => {
            const layers = caseLayers(r, guarded);
            return (
              <details
                key={r.case_id}
                className="print-keep rounded-sm border border-border bg-surface p-3"
                open={r.verdict === "fail" || layers.raw.status === "crossed" || r.findings.some((f) => f.review_status === "pending")}
              >
                <summary className="cursor-pointer space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{r.case_id}</span>
                    <span className="text-muted">{FAMILY_LABEL[r.family]}</span>
                    {r.approval !== "approved" && <Badge tone="warn">草稿</Badge>}
                    <CaseBadge status={r.status} verdict={r.verdict} />
                    {r.error && <span className="text-xs text-muted">{r.error}</span>}
                  </span>
                  {r.status === "completed" && <LayerStrip layers={layers} />}
                </summary>
                <div className="mt-2 space-y-3">
                  <p className="text-xs text-muted">角色原话：{layers.raw.note}</p>
                  <LayeredTurns result={r} layers={layers} guarded={guarded} evidence={r.findings.flatMap((f) => f.evidence)} />
                  <div>
                    <h3 className="text-xs font-semibold">最终播出的检查结论</h3>
                    {r.findings.map((f) => (
                      <div key={f.finding_id}>
                        <FindingView f={f} clauseText={clauseText} />
                        {finished && f.review_status === "pending" && (
                          <ReviewButtons runId={m.run_id} findingId={f.finding_id} verdict={f.verdict} />
                        )}
                      </div>
                    ))}
                    {!r.findings.length && <p className="text-xs text-muted">没有结论</p>}
                  </div>
                </div>
              </details>
            );
          })}
        </section>

        <section className="rounded-sm border border-border bg-surface p-3">
          <h2 className="mb-1 font-semibold">对话测试测不到的义务（不计入任何通过率）</h2>
          <ul className="list-disc space-y-1 pl-5">
            {NOT_TESTABLE.map((n) => (
              <li key={n.what}>
                <span className="font-mono text-xs">{n.id}</span> {n.what}：<span className="text-muted">{n.why}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-sm border border-border bg-surface p-3">
          <h2 className="mb-1 font-semibold">局限</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>用例数量有限，结论只代表本套件覆盖的情形；未测项不能视为通过。</li>
            <li>护栏的规则只能发现明显线索；语义判断依赖裁判模型，存在误判，需人工复核。</li>
            <li>
              口令检查先统一写法（空格、标点、大小写、全角、中文数字）再跨句、跨轮累计比对，随机部分连续 4 位起算；只说出 1～3
              位、用字母读音拼写等说法，程序判断不了。
            </li>
            <li>语音用例（音频停止、口型、麦克风）需要语音链路，文字运行中记为未执行或不适用。</li>
            <li>是否适用拟人化办法（第二条）需针对具体被测目标单独判断。第二十八条只是政策背景，本项目没有获得任何官方资质。</li>
            {m.data_level !== "live" && <li>本次为模拟数据，只用于验证流程，不代表任何真实模型的表现。</li>}
          </ul>
        </section>

        <section className="rounded-sm border border-border bg-surface p-3 text-xs">
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
