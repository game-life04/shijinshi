// 运行记录：选两次运行，到「前后对比」页看改了什么、结果怎么变（评审 R28 改版，ADR-036）。
//   - 时间按北京时间写，不再只露格林尼治时间的运行编号（编号在体检单链接的悬停里）；状态、配置都写中文；
//   - 「拦截」改叫「平台拒答」：那是模型平台自己的内容审核挡下的，和护栏的「拦」不是一回事；补上「不适用」；
//   - 三种结局、一键演示这类只跑几道指定题的运行收进单独一组，不和完整体检混在一起；
//   - 配了账号时默认只列自己发起的，可以切到「全部」。ADR-051（11-15 队员 B：小字多余）：原来那句「只列 xxx 发起的运行 · 看全部」
//     改成标题旁边「我的 / 全部」两个按钮。
// listRuns 是服务端函数，分组、筛选只在这一页做。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import AutoRefresh from "@/components/AutoRefresh";
import PlayGames from "@/components/PlayGames";
import RunPicker, { type RunRow } from "@/components/RunPicker";
import { POLICY_SHORT, VARIANT_SHORT } from "@/components/wording";
import { FATES_PAGE } from "@/lib/domain/fates-page";
import { DEFAULT_PERSONA } from "@/lib/domain/persona";
import { BUSY_RUN_STATES, type RunManifest } from "@/lib/domain/types";
import { authConfig } from "@/lib/server/auth";
import { listRuns } from "@/lib/server/runs";
import { publicRuns } from "@/lib/server/sealed";
import { getSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const STATE: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  pausing: "暂停中",
  paused: "暂停",
  cancelling: "终止中",
  completed: "",
  cancelled: "终止",
  failed: "失败",
};

const time = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(iso))
    .replace(/\//g, "-");

function row(m: RunManifest): RunRow {
  const c = m.counts;
  const unfinished = [
    c.provider_blocked && `平台拒答 ${c.provider_blocked}`,
    c.error && `出错 ${c.error}`,
    c.cancelled && `终止 ${c.cancelled}`,
    c.not_run && `没跑 ${c.not_run}`,
  ]
    .filter(Boolean)
    .join("、");
  return {
    run_id: m.run_id,
    time: time(m.started_at ?? m.created_at),
    persona: (m.config.persona ?? DEFAULT_PERSONA).name,
    config: `${VARIANT_SHORT[m.config.variant]} · ${POLICY_SHORT[m.config.policy]}${m.config.voice ? " · 语音" : ""}`,
    live: m.data_level === "live",
    preview: m.preview,
    state: STATE[m.state] ?? m.state,
    pass: c.pass,
    planned: c.planned,
    fail: c.fail,
    uncertain: c.uncertain,
    na: c.not_applicable,
    unfinished,
  };
}

/** 「我的 / 全部」：选中的墨底白字，没选的描边（和攻防地图的筛选按钮一个意思） */
const seg = (on: boolean) =>
  `inline-flex h-7 items-center rounded-sm border px-2.5 ${on ? "border-foreground bg-foreground text-surface" : "border-border bg-surface hover:bg-background"}`;

export default async function RunsPage({ searchParams }: PageProps<"/runs">) {
  const sp = await searchParams;
  const a = typeof sp.a === "string" ? sp.a : undefined;
  const b = typeof sp.b === "string" ? sp.b : undefined;
  const all = sp.all === "1";
  const me = authConfig().mode === "accounts" ? (await getSession())?.account : undefined;
  // 封存的保留集运行不列（ADR-050）
  const runs = publicRuns(listRuns());
  const shown = me && !all ? runs.filter((r) => r.created_by === me) : runs;
  // 只跑指定几道题的（三种结局每播一遍一题、一键演示四题）单独一组
  const picked = (r: RunManifest) => Boolean(r.config.case_ids?.length);
  const full = shown.filter((r) => !picked(r));
  const demos = shown.filter(picked);
  // 有体检还没结束：这一页每 3 秒自己刷新（11-17 修改 4）
  const busy = shown.some((r) => BUSY_RUN_STATES.includes(r.state));

  return (
    <AppShell active="/runs">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold">运行记录</h1>
          <AutoRefresh on={busy} />
          {busy && (
            <span className="text-xs text-muted" data-testid="runs-live">
              有体检在跑：这一页每 3 秒自己刷新
            </span>
          )}
          {me && (
            <nav className="flex items-center gap-1.5 text-xs" aria-label="看谁的运行" data-testid="runs-whose">
              <Link className={seg(!all)} href="/runs" aria-current={!all ? "page" : undefined}>
                我的
              </Link>
              <Link className={seg(all)} href="/runs?all=1" aria-current={all ? "page" : undefined} title="所有账号发起的运行">
                全部
              </Link>
            </nav>
          )}
        </div>
        <p className="text-xs text-muted">上面是体检工作台跑的体检；打字闯关的记录在最下面。</p>
        {!shown.length && <p className="text-muted">还没有运行记录。到「体检工作台」开始一次体检。</p>}
        {full.length > 0 && <RunPicker rows={full.map(row)} a0={a} b0={b} />}
        {demos.length > 0 && (
          <details className="rounded-sm border border-border bg-surface p-3" open={!full.length}>
            <summary className="cursor-pointer text-sm">
              小实验「{FATES_PAGE.name}」、一键演示这类只跑几道指定题的运行（{demos.length} 次）
              <span className="ml-1 text-xs text-muted">和完整体检分开放：题数不一样，通过数不能直接比</span>
            </summary>
            <div className="mt-2">
              <RunPicker rows={demos.map(row)} a0={a} b0={b} />
            </div>
          </details>
        )}
        {/* 这个浏览器里打过的闯关（11-17）：不进体检统计，单独一块 */}
        <PlayGames />
      </div>
    </AppShell>
  );
}
