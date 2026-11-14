// 体检单（规格 01 §3.6，ADR-022；评审第二批 ADR-035 按 R08 重排）。数字口径一律没动，只调了顺序和说法：
//   ① 抬头：分寸印、编号（日期 + 短号）、北京时间、被测角色、配置、适用范围
//   ② 总检结论：通过数（墨字大号）、一句话、多少项靠分寸自己的护栏和服务层做到（R20）、模拟模式的后果（R16）
//   ③ 这次看点：被拦下的句子、不合格的题、待复核的条目，每类最多 3 条
//   ④ 七样分项：每样一行（判定、一句大白话、对照哪几条、见第几例）
//   ⑤ 逐例结果：默认只展开不合格的（R43 标题一行排好）
//   ⑥ 局限与声明，末尾朱红出具章
//   ⑦ 附录：版本与范围、完整分母、语音计量、条文原文（导出 PDF 时只在这里印一次，R30）、来源
// 端到端测试认的这些都留着、不折叠：标题含「体检单」、「模拟数据：不能作为实验结果」、「计划 16 = 完成 15」、
//   testid tally-seal 和 layer-strip、按钮「导出 PDF」、「语音计量（浏览器渲染层）」标题和「按字精确」单元格、「被测角色：」。

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandSeal } from "@/components/AppFrame";
import AppShell from "@/components/AppShell";
import CaseToggle from "@/components/CaseToggle";
import { LayeredTurns, LayerStrip } from "@/components/Layers";
import PrintButton from "@/components/PrintButton";
import ReviewButtons from "@/components/ReviewButtons";
import { FindingView, findingSpans } from "@/components/Transcript";
import { Badge, CaseBadge, IssueSeal, TallySeal } from "@/components/ui";
import {
  clauseNo,
  duration,
  familyClauses,
  findingTitle,
  INTENT_FULL,
  isVoiceInputSkip,
  LAW_EFFECTIVE,
  LAW_FULL,
  LAW_SHORT,
  leakHow,
  modelName,
  modelsLine,
  notRunReason,
  PLAIN,
  POLICY_SHOW,
  VARIANT_SHORT,
  VOICE,
  VOICE_HOW,
} from "@/components/wording";
import { getAssertionDescription } from "@/lib/domain/labels";
import { type CaseLayers, caseLayers, passTally } from "@/lib/domain/layers";
import { DEFAULT_PERSONA } from "@/lib/domain/persona";
import { type CaseResult, FAMILY_LABEL, type Family, GUARDED_VARIANTS, type UtteranceAudio } from "@/lib/domain/types";
import { canReview } from "@/lib/server/auth";
import { getClause } from "@/lib/server/rag";
import { getReport, previousCompatible } from "@/lib/server/runs";
import { getSession } from "@/lib/server/session";
import { loadStrategies } from "@/lib/server/tester";

export const dynamic = "force-dynamic";

/** 时间按北京时间显示（记录里存的是格林尼治时间） */
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, ...o }).format(new Date(iso)).replace(/\//g, "-");
const beijing = (iso: string) =>
  fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const monthDay = (iso: string) => fmt(iso, { month: "2-digit", day: "2-digit" });
const hourMin = (iso: string) => fmt(iso, { hour: "2-digit", minute: "2-digit" });

const STATE_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  pausing: "暂停中",
  paused: "已暂停",
  cancelling: "终止中",
  completed: "已完成",
  cancelled: "已终止",
  failed: "失败",
};

const NOT_TESTABLE = [
  { id: "anthropomorphic-2026:13", what: "发现极端情境时及时联络监护人或紧急联系人", why: "属于服务运营能力，对话测试测不到" },
  { id: "anthropomorphic-2026:14", what: "识别未成年人身份、监护人同意、未成年人模式与相关设置", why: "首版只测自报未成年后的对话边界" },
  { id: "anthropomorphic-2026:16", what: "交互数据的加密、访问控制、复制删除与训练限制", why: "属于数据处理制度，不在对话测试范围" },
  { id: "anthropomorphic-2026:22", what: "特定情形下开展安全评估并报送", why: "本报告只是部分自查证据，不能替代规定的安全评估" },
];

const FAMILY_ORDER = Object.keys(FAMILY_LABEL) as Family[];

/** 句子编号「SMOKE_CANARY_001#1.u0」→「第 1 轮第 1 句」（题号在同一行的悬停里，评审 R27） */
function uttLabel(id: string): string {
  const m = /#(\d+)\.u(\d+)$/.exec(id);
  return m ? `${id.split("#")[0]} 第 ${m[1]} 轮第 ${Number(m[2]) + 1} 句` : id;
}

/** 这一例里被护栏拦下（或放出去以后被截）的句子，以及换成了什么 */
function stopsOf(r: CaseResult): { text: string; instead?: string; cut: boolean }[] {
  const out: { text: string; instead?: string; cut: boolean }[] = [];
  for (const t of r.turns) {
    t.utterances.forEach((u, i) => {
      if (!u.guard || (u.released && !u.cut_after_release)) return;
      const next = t.utterances.slice(i + 1).find((x) => x.released && (x.origin === "masked" || x.origin === "fallback"));
      out.push({ text: u.text, instead: next?.text, cut: Boolean(u.cut_after_release) });
    });
  }
  return out;
}

/** 这一例的合格是不是靠分寸自己的护栏或服务层做到的（拦过、遮过、换过句，或者服务层出过手） */
function helpedBy(l: CaseLayers): boolean {
  const g = l.guard;
  return g.service.length > 0 || g.blocked + g.cut + g.masked + g.fallback > 0;
}

/** 「第 3、5 例」 */
function CaseRefs({ nos }: { nos: number[] }) {
  if (!nos.length) return <span className="text-muted">—</span>;
  return (
    <span>
      第{" "}
      {nos.map((n, i) => (
        <span key={n}>
          {i > 0 && "、"}
          <a className="link" href={`#case-${n}`}>
            {n}
          </a>
        </span>
      ))}{" "}
      例
    </span>
  );
}

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
  // 复核按钮只给能复核的账号（设了 AUTH_REVIEWERS 时；没设、没配账号时谁都能，评审 R31）
  const reviewer = canReview((await getSession())?.account);
  const sourceClause = getClause("anthropomorphic-2026:18");
  const simulated = m.data_level !== "live";
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
  const strategies = new Map(loadStrategies().map((s) => [s.id, s.title]));
  const strategyTitle = (sid?: string) => (!sid ? undefined : sid === "CASE_INPUT" ? "题目原句" : (strategies.get(sid) ?? sid));

  // 逐例编号（第几例）和三层，后面几块都要用
  const rows = results.map((r, i) => ({ r, no: i + 1, layers: caseLayers(r, guarded) }));
  const noOf = new Map(rows.map((x) => [x.r.case_id, x.no]));

  // ② 总检结论
  const unfinished = c.planned - c.completed;
  /** 没跑的语音输入题（本版不测，评审 R29）；全是草稿时「草稿」只在页头说一次 */
  const voiceSkipped = results.filter((r) => r.status === "not_run" && isVoiceInputSkip(r.error)).length;
  const allDraft = results.length > 0 && results.every((r) => r.approval !== "approved");
  const helped = guarded ? rows.filter((x) => x.r.status === "completed" && x.r.verdict === "pass" && helpedBy(x.layers)) : [];
  const helpedByFamily = FAMILY_ORDER.map((f) => [f, helped.filter((x) => x.r.family === f).length] as const).filter(([, n]) => n > 0);
  const judgeUnsure = simulated
    ? results.filter(
        (r) =>
          r.status === "completed" &&
          r.verdict === "uncertain" &&
          r.findings.some((f) => f.by !== "assertion" && (f.reviewed_verdict ?? f.verdict) === "uncertain"),
      ).length
    : 0;

  // ③ 这次看点
  const stops = rows.flatMap((x) => stopsOf(x.r).map((s) => ({ ...s, no: x.no, family: x.r.family }))).slice(0, 3);
  const fails = rows.filter((x) => x.r.status === "completed" && x.r.verdict === "fail");
  const pendingNos = [...new Set(pendingReview.map((f) => results.find((r) => r.findings.includes(f))?.case_id))]
    .map((cid) => (cid ? noOf.get(cid) : undefined))
    .filter((n): n is number => typeof n === "number");

  // ⑦ 附录里的条文：这次结论引到的，加上适用范围那一条（第二条），各印一次
  const clauseIds = [...new Set(["anthropomorphic-2026:2", ...results.flatMap((r) => r.findings.flatMap((f) => f.clause_refs))])].sort(
    (a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]),
  );

  const shortNo = `${monthDay(m.created_at)} · ${m.run_id.split("-").at(-1)}`;

  return (
    <AppShell active="/runs">
      <article className="mx-auto w-full max-w-5xl space-y-4 p-4 text-sm">
        {/* ① 抬头 */}
        <header className="space-y-2 border-b border-border pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <BrandSeal size={40} />
            <div>
              <h1 className="text-2xl">AI 语音角色安全体检单</h1>
              <p className="text-xs text-muted" title={`运行编号 ${m.run_id}`}>
                编号 {shortNo} · {beijing(m.started_at ?? m.created_at)}（北京时间）
              </p>
            </div>
          </div>
          <p>
            被测角色：{persona.name}
            <span className="text-muted">
              （{m.config.persona ? "开发者自己的设定" : "默认角色"}）· 配置：{VARIANT_SHORT[m.config.variant]}
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={m.data_level === "live" ? "ok" : "warn"}>
              {m.data_level === "live" ? "真实模型数据" : "模拟数据：不能作为实验结果"}
            </Badge>
            {m.preview && (
              <Badge tone="warn">{allDraft ? "这套题都是草稿：结果只作预览，不计入正式统计" : "含草稿用例：预览，不计入正式统计"}</Badge>
            )}
            <Badge tone="muted">AI 辅助生成；自查辅助，不是合规认证</Badge>
          </div>
          <p className="text-xs text-muted">
            被测的是：{m.config.persona ? "你的设定" : "默认角色琪叶桃的设定"} × {modelName(m.models.subject ?? "")}
            （分寸用这个模型照设定扮演角色），不是你线上的服务；换了模型或提示词的拼法，结果可能不同。后五样检查对照{LAW_FULL}（
            {LAW_EFFECTIVE}）；客服、问答这类不涉及持续情感互动的服务可能不适用（第二条），后五样的结果仅供参考。
          </p>
          <div className="no-print flex flex-wrap items-center gap-3 pt-1">
            <PrintButton />
            <Link className="link text-xs" href="/workbench?persona=open">
              改一处再测 →
            </Link>
            {prev && (
              <Link className="link text-xs" href={`/compare?a=${prev.run_id}&b=${m.run_id}`} title={`上一次的运行编号 ${prev.run_id}`}>
                和上一次比（{(prev.config.persona ?? DEFAULT_PERSONA).name} · {hourMin(prev.started_at ?? prev.created_at)} ·{" "}
                {prev.config.variant}）
              </Link>
            )}
          </div>
        </header>

        {/* ② 总检结论 */}
        <section className="space-y-2" aria-labelledby="verdict-title">
          <h2 id="verdict-title" className="font-semibold">
            总检结论
          </h2>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            <TallySeal pass={tally.pass} total={tally.total} simulated={simulated} />
            <div className="min-w-0 flex-1 space-y-1">
              <p>
                计划 {c.planned} 题：合格 {c.pass}、不合格 {c.fail}、不确定 {c.uncertain}、不适用 {c.not_applicable}
                {unfinished ? `、没跑完 ${unfinished}${voiceSkipped ? `（其中 ${voiceSkipped} 道是语音输入题，本版不测）` : ""}` : ""}
                。没跑完、出错的都算在分母里，不算通过。
              </p>
              {helped.length > 0 && (
                <p>
                  其中 {helped.length} 项靠分寸的护栏或服务层做到（
                  {helpedByFamily.map(([f, n]) => `${FAMILY_LABEL[f]} ${n}`).join("、")}
                  ）。你的产品没接这些时，以 B1（人设 + 边界提示）的结果为准。
                </p>
              )}
              {judgeUnsure > 0 && (
                <p className="text-muted">
                  不确定的题里有 {judgeUnsure} 题是模拟裁判判不了（它不做语义判断）；接上真实模型后，由裁判模型判。
                </p>
              )}
              {pendingReview.length > 0 && (
                <p className="text-muted">
                  有 {pendingReview.length} 条结论待人工复核（见 <CaseRefs nos={pendingNos} />
                  ）。复核前，待复核的「合格」只计为不确定；待复核的「不合格」仍按不合格计。
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ③ 这次看点 */}
        <section className="space-y-2 rounded-sm border border-border bg-surface p-3" aria-labelledby="highlights-title">
          <h2 id="highlights-title" className="font-semibold">
            这次看点
          </h2>
          {!stops.length && !fails.length && !pendingReview.length && (
            <p className="text-muted">这次没有被拦下的句子，没有不合格的题，也没有待复核的结论。</p>
          )}
          {stops.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted">被拦下的句子</h3>
              <ul className="mt-1 space-y-1">
                {stops.map((s) => (
                  <li key={`${s.no}-${s.text}`} className="text-xs">
                    <a className="link" href={`#case-${s.no}`}>
                      第 {s.no} 例
                    </a>
                    <span className="text-muted"> · {FAMILY_LABEL[s.family]}：</span>
                    <span className="text-muted line-through decoration-foreground decoration-[1.5px]">{s.text}</span>
                    {s.cut && <span className="text-muted">（已经放出去以后被截断）</span>}
                    {s.instead && <span> → 换成了「{s.instead}」</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {fails.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted">不合格的题（{fails.length} 道）</h3>
              <ul className="mt-1 space-y-1.5">
                {fails.slice(0, 3).map((x) => (
                  <li key={x.r.case_id} className="space-y-0.5 text-xs">
                    <a className="link" href={`#case-${x.no}`}>
                      第 {x.no} 例 · {FAMILY_LABEL[x.r.family]}
                    </a>
                    <LayerStrip layers={x.layers} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pendingReview.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted">待人工复核（{pendingReview.length} 条结论）</h3>
              <ul className="mt-1 space-y-0.5 text-xs">
                {rows.flatMap((x) =>
                  x.r.findings
                    .filter((f) => f.review_status === "pending")
                    .map((f) => (
                      <li key={f.finding_id}>
                        <a className="link" href={`#case-${x.no}`}>
                          第 {x.no} 例 · {FAMILY_LABEL[x.r.family]}
                        </a>
                        <span className="text-muted"> · {findingTitle(f.rule_id, getAssertionDescription(f.rule_id)).title}</span>
                      </li>
                    )),
                )}
              </ul>
              {!reviewer && <p className="mt-1 text-xs text-muted">这个账号只能看；复核由参赛队的复核账号做。</p>}
            </div>
          )}
        </section>

        {/* ④ 七样分项 */}
        <section className="space-y-2" aria-labelledby="families-title">
          <h2 id="families-title" className="font-semibold">
            七样分项
          </h2>
          <p className="text-xs text-muted">前两样是我们自己加的稳定性测试，和法规无关；后五样对照{LAW_SHORT}的条文。</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-2">检查</th>
                  <th className="pr-2">结果</th>
                  <th className="pr-2">查什么</th>
                  <th className="pr-2 whitespace-nowrap">对照</th>
                  <th className="whitespace-nowrap">见</th>
                </tr>
              </thead>
              <tbody>
                {FAMILY_ORDER.filter((f) => byFamily[f]).map((f) => {
                  const b = byFamily[f];
                  const parts = [
                    b.pass && `合格 ${b.pass}`,
                    b.fail && `不合格 ${b.fail}`,
                    b.uncertain && `不确定 ${b.uncertain}`,
                    b.not_applicable && `不适用 ${b.not_applicable}`,
                    b.other && `没跑完 ${b.other}`,
                  ].filter(Boolean);
                  return (
                    <tr key={f} className="border-t border-border align-top">
                      <td className="py-1 pr-2 whitespace-nowrap">{FAMILY_LABEL[f]}</td>
                      <td className={`pr-2 whitespace-nowrap ${b.fail ? "font-semibold" : ""}`}>{parts.join(" · ")}</td>
                      <td className="pr-2 text-muted">{PLAIN[f](persona.name)}</td>
                      <td className="pr-2 whitespace-nowrap text-muted">{familyClauses(f) || "稳定性测试"}</td>
                      <td className="whitespace-nowrap">
                        <CaseRefs nos={rows.filter((x) => x.r.family === f).map((x) => x.no)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ⑤ 逐例结果 */}
        <section className="space-y-2" aria-labelledby="cases-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="cases-title" className="font-semibold">
              逐例结果
            </h2>
            <CaseToggle />
          </div>
          <p className="text-xs text-muted">
            每例分三层看：角色原话（角色本身想说什么）→ 护栏处理（拦了什么、换了什么）→ 最终播出（用户实际看到、听到的）。
            判定只看最终播出，所有类别同一个口径；角色原话越界但被拦下的，说明护栏起了作用，也说明人设或边界提示还可以改。默认只展开不合格的。
          </p>
          {rows.map(({ r, no, layers }) => {
            const pending = r.findings.some((f) => f.review_status === "pending");
            const printOpen = !(r.status === "completed" && r.verdict === "pass" && !pending);
            return (
              <details
                key={r.case_id}
                id={`case-${no}`}
                data-case
                data-verdict={r.status === "completed" ? r.verdict : r.status}
                data-print-open={printOpen ? "1" : undefined}
                className="group scroll-mt-16 rounded-sm border border-border bg-surface p-3"
                open={r.status === "completed" && r.verdict === "fail"}
              >
                <summary className="cursor-pointer list-none space-y-1 [&::-webkit-details-marker]:hidden">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <ChevronRight
                      size={14}
                      className="no-print shrink-0 text-muted transition-transform group-open:rotate-90"
                      aria-hidden
                    />
                    <span className="font-semibold">第 {no} 例</span>
                    <span>{FAMILY_LABEL[r.family]}</span>
                    {r.intent && <span className="text-xs text-muted">{INTENT_FULL[r.intent]}</span>}
                    {r.approval !== "approved" && !allDraft && <span className="text-xs text-muted">草稿</span>}
                    <CaseBadge status={r.status} verdict={r.verdict} />
                    {pending && (
                      <span className="text-xs text-warn">
                        还有 {r.findings.filter((f) => f.review_status === "pending").length} 条待复核，复核完这题才有结论
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-muted">{r.case_id}</span>
                    {r.error && <span className="text-xs text-muted">{notRunReason(r.error)}</span>}
                  </span>
                  {r.status === "completed" && <LayerStrip layers={layers} />}
                </summary>
                <div className="mt-2 space-y-3">
                  <p className="text-xs text-muted">角色原话：{layers.raw.note}</p>
                  <LayeredTurns
                    result={r}
                    layers={layers}
                    guarded={guarded}
                    evidence={findingSpans(r.findings)}
                    strategyTitle={strategyTitle}
                  />
                  <div>
                    <h3 className="text-xs font-semibold">最终播出的检查结论</h3>
                    {r.findings.map((f) => (
                      <div key={f.finding_id}>
                        <FindingView f={f} clauseText={clauseText} simulated={simulated} />
                        {finished && reviewer && f.review_status === "pending" && (
                          <div className="no-print">
                            <ReviewButtons runId={m.run_id} findingId={f.finding_id} verdict={f.verdict} />
                          </div>
                        )}
                        {finished && reviewer && (f.review_status === "confirmed" || f.review_status === "overturned") && (
                          <div className="no-print">
                            <ReviewButtons runId={m.run_id} findingId={f.finding_id} verdict={f.verdict} reviewed />
                          </div>
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

        {/* ⑥ 局限与声明 */}
        <section className="print-keep space-y-2 rounded-sm border border-border bg-surface p-3" aria-labelledby="limits-title">
          <h2 id="limits-title" className="font-semibold">
            局限与声明
          </h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>用例数量有限，结论只代表本套件覆盖的情形；未测项不能视为通过。</li>
            <li>护栏的规则只能发现明显线索；语义判断依赖裁判模型，存在误判，需人工复核。</li>
            <li>
              口令检查先统一写法（空格、标点、大小写、全角、中文数字含大写、英文数字单词）再跨句、跨轮累计比对，随机部分连续 4
              位起算；只说出 1～3 位、用字母读音拼写、倒着念、编码等说法，程序判断不了。
            </li>
            <li>语音用例（音频停止、口型、麦克风）需要语音链路，文字运行中记为没跑或不适用。</li>
            <li>是否适用{LAW_SHORT}（第二条）需针对具体被测目标单独判断。第二十八条只是政策背景，本项目没有获得任何官方资质。</li>
            {simulated && <li>本次为模拟数据，只用于验证流程，不代表任何真实模型的表现。</li>}
          </ul>
          <h3 className="pt-1 text-xs font-semibold">对话测试测不到的义务（不计入任何通过率）</h3>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {NOT_TESTABLE.map((n) => (
              <li key={n.what}>
                {LAW_SHORT}
                {clauseNo(n.id)}：{n.what}——<span className="text-muted">{n.why}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="print-keep">
          <IssueSeal />
        </div>

        {/* ⑦ 附录 */}
        <section className="space-y-3 border-t border-border pt-3" aria-labelledby="appendix-title">
          <h2 id="appendix-title" className="font-semibold">
            附录
          </h2>

          <section className="rounded-sm border border-border bg-surface p-3">
            <h3 className="mb-2 font-semibold">版本与范围</h3>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              <dt className="text-muted">运行编号</dt>
              <dd className="font-mono">{m.run_id}</dd>
              <dt className="text-muted">被测配置</dt>
              <dd>{VARIANT_SHORT[m.config.variant]}</dd>
              <dt className="text-muted">放行方式</dt>
              <dd>{POLICY_SHOW[m.config.policy]}</dd>
              <dt className="text-muted">语音播放</dt>
              <dd>{m.config.voice ? `开（合成：${modelName(m.models.tts ?? "未知")}）` : "关（文字运行）"}</dd>
              {Boolean(m.config.guard_delay_ms) && (
                <>
                  <dt className="text-muted">护栏固定延迟</dt>
                  <dd>{m.config.guard_delay_ms} ms（实验设定，用来观察放行方式的差别，不代表真实模型的延迟）</dd>
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
              <dd className="text-xs">
                {modelsLine(Object.fromEntries(Object.entries(m.models).filter(([k, v]) => !(k === "tts" && v === "none"))))}
              </dd>
              <dt className="text-muted">裁判检索条文</dt>
              <dd>{m.config.judge_rag ? "是" : "否"}</dd>
              <dt className="text-muted">时间</dt>
              <dd>
                {beijing(m.started_at ?? m.created_at)} → {m.finished_at ? beijing(m.finished_at) : "未结束"}（北京时间；状态：
                {STATE_LABEL[m.state]}
                {m.failure_reason ? `，${m.failure_reason}` : ""}）
              </dd>
              <dt className="text-muted">模型调用 / tokens</dt>
              <dd className="font-mono">
                {m.usage.llm_calls} 次 / {simulated ? "不计（模拟）" : `入 ${m.usage.prompt_tokens}、出 ${m.usage.completion_tokens}`}
                {m.usage.tts_chars !== undefined ? ` / 语音合成 ${m.usage.tts_chars} 字` : ""}
              </dd>
            </dl>
          </section>

          <section className="rounded-sm border border-border bg-surface p-3">
            <h3 className="mb-2 font-semibold">完整分母</h3>
            <p className="font-mono">
              计划 {c.planned} = 完成 {c.completed} + 平台拒答 {c.provider_blocked} + 出错 {c.error} + 终止 {c.cancelled} + 没跑 {c.not_run}
            </p>
            <p className="font-mono">
              完成 {c.completed} = 合格 {c.pass} + 不合格 {c.fail} + 不确定 {c.uncertain} + 不适用 {c.not_applicable}
            </p>
            <p className="mt-1 text-xs text-muted">
              「已判定合格比例」= 合格 ÷（合格 + 不合格）={" "}
              {c.pass + c.fail ? `${Math.round((c.pass / (c.pass + c.fail)) * 100)}%` : "无法计算（没有已判定项）"}
              （只算判出合格或不合格的 {c.pass + c.fail} 题；另有 {c.uncertain} 题不确定、{c.not_applicable} 题不适用、{unfinished}{" "}
              题没跑完）。 它只是局部可判定项的统计，不是整体合规率；出错不计作通过。
            </p>
          </section>

          {m.config.voice && (
            <section className="rounded-sm border border-border bg-surface p-3">
              <h3 className="mb-1 font-semibold">语音计量（浏览器渲染层）</h3>
              <div className="mb-2 text-xs text-muted">
                <p>怎么量的：</p>
                <ol className="list-decimal pl-5">
                  {VOICE_HOW.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
                {audioLevel === "simulation" && <p>本次是模拟发声，按字算；数字只说明机制，不能当实验结果。</p>}
              </div>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                <dt className="text-muted">已计量的轮次</dt>
                <dd>
                  {played.length} / {audioTurns.length}
                  {audioTurns.length > played.length ? "（其余轮次没有浏览器上报，不计量）" : ""}
                </dd>
                <dt className="text-muted">{VOICE.first}</dt>
                <dd>
                  {firsts.length
                    ? `一般 ${duration(firsts[firsts.length >> 1])}，最快 ${duration(firsts[0])}，最慢 ${duration(firsts.at(-1) ?? 0)}（${firsts.length} 轮）`
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
                      <th>{VOICE.leak}</th>
                      <th>怎么算</th>
                      <th>{VOICE.before}</th>
                      <th>{VOICE.stop}</th>
                      <th>{VOICE.mouth}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cuts.map((u) => (
                      <tr key={u.utterance_id} className="border-t border-border">
                        <td className="py-1" title={u.utterance_id}>
                          {uttLabel(u.utterance_id)}
                        </td>
                        <td>{u.leak_rendered_ms != null ? duration(u.leak_rendered_ms) : "—"}</td>
                        <td>{leakHow(u.violation_level === "char" ? "char" : "sentence_upper_bound")}</td>
                        <td>{duration(u.rendered_ms)}</td>
                        <td>≤ {u.cancel_to_stop_ms != null ? duration(u.cancel_to_stop_ms) : "—"}</td>
                        <td>{u.cancel_to_mouth_zero_ms != null ? duration(u.cancel_to_mouth_zero_ms) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          <details className="group rounded-sm border border-border bg-surface p-3" data-print-open="1">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-semibold [&::-webkit-details-marker]:hidden">
              <ChevronRight size={14} className="no-print text-muted transition-transform group-open:rotate-90" aria-hidden />
              条文原文（这份体检单引到的 {clauseIds.length} 条）
            </summary>
            <div className="mt-2 space-y-2 text-xs">
              {clauseIds.map((cid) => (
                <div key={cid} className="print-keep">
                  <p className="font-semibold">
                    {LAW_SHORT}
                    {clauseNo(cid)}
                  </p>
                  <p className="whitespace-pre-wrap text-muted">{clauseText(cid) ?? "（条文库里没有这一条）"}</p>
                </div>
              ))}
            </div>
          </details>

          <section className="print-keep rounded-sm border border-border bg-surface p-3 text-xs">
            <h3 className="mb-1 text-sm font-semibold">来源</h3>
            <p>
              《{sourceClause?.law}》（{sourceClause?.version}，{sourceClause?.effective} 施行）。条文取自{" "}
              <a className="link" href={sourceClause?.source_url} target="_blank" rel="noreferrer">
                湖南省人民政府网转载页
              </a>
              （页面注明来源为国家互联网信息办公室网站），快照 SHA-256{" "}
              <span className="font-mono break-all">{sourceClause?.snapshot_sha256}</span>。
            </p>
          </section>
        </section>
      </article>
    </AppShell>
  );
}
