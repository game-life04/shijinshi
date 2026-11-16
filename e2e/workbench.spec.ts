import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openSettings } from "./settings";

// 截图默认写到 test-results；设 UPDATE_EVIDENCE=1 才更新仓库里的证据截图（docs/evidence）
const SHOTS = process.env.UPDATE_EVIDENCE ? "docs/evidence/screenshots/m1" : "test-results/screenshots/m1";

async function startRun(page: Page, variant?: string) {
  await page.goto("/workbench");
  await expect(page.getByText("模拟数据（非真实模型）")).toBeVisible();
  if (variant) await page.getByLabel("被测配置").selectOption(variant);
  await page.getByRole("button", { name: "开始体检" }).click();
}

test("还没开始体检：最上面一行是五种套路；一键演示、开始体检在「对话」标题栏（手机上在配置条）；右栏「七样测试」编号 1～7、不写条款号；顶栏没有 AI 标识（ADR-053）", async ({
  page,
}, info) => {
  test.skip(info.project.name === "laptop-1280", "桌面和手机各看一次");
  const phone = info.project.name === "phone-390";
  await page.goto("/workbench");
  await expect(page.getByText("模拟数据（非真实模型）")).toBeVisible();
  // 最上面一行：原来那句「给 AI 陪聊……出体检单」换成测试 Agent 的五种套路；「对话」里的示例下面不再重复
  await expect(page.getByText(/给 AI 陪聊/)).toHaveCount(0);
  const chips = page.getByTestId("strategy-chips");
  await expect(chips).toHaveCount(1);
  await expect(chips).toBeVisible();
  await expect(chips).toContainText("测试 Agent 会用的 5 种套路");
  await expect(page.getByTestId("dialog-panel").getByText(/种套路/)).toHaveCount(0);
  // 顶栏不再有 AI 标识（ADR-053）：AI 标识只留形象旁边的「AI 角色」
  await expect(page.getByRole("banner").getByText(/不是真人/)).toHaveCount(0);
  await expect(page.getByRole("banner").getByTitle(/由 AI 生成/)).toHaveCount(0);
  // 一键演示、开始体检：桌面上在「对话」标题那一行右头；手机上照旧在配置条里（「对话」只是三个标签之一）
  const start = page.getByRole("button", { name: "开始体检" });
  const demo = page.getByRole("button", { name: /^一键演示/ });
  await expect(start).toHaveCount(1);
  await expect(demo).toHaveCount(1);
  await expect(start).toBeEnabled();
  const actions = page.getByTestId("dialog-panel").getByTestId("run-actions");
  if (phone) {
    await expect(actions).toBeHidden();
  } else {
    await expect(actions.getByRole("button", { name: "开始体检" })).toBeVisible();
    await expect(actions.getByRole("button", { name: /^一键演示/ })).toBeVisible();
    // 标题左、按钮右，在同一行
    const title = await page.getByTestId("dialog-panel").getByRole("heading", { level: 2 }).boundingBox();
    const btn = await start.boundingBox();
    expect(title && btn && btn.x > title.x + title.width && Math.abs(btn.y + btn.height / 2 - (title.y + title.height / 2)) < 8).toBe(true);
  }

  if (phone) await page.getByRole("tab", { name: "对话" }).click();
  const links = page.getByTestId("intro-links");
  await expect(links.getByRole("link", { name: "自己来试试：打字闯关" })).toHaveAttribute("href", "/play");
  await expect(links.getByRole("link", { name: /^小实验：/ })).toHaveAttribute("href", "/fates");
  await expect(page.getByText("怎么出题、怎么拦")).toHaveCount(0);
  // 两个按钮在同一行、一样高（像按钮，不是下划线链接）
  const [a, b] = await links.getByRole("link").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  expect(Math.abs(a.top - b.top) < 2 || phone).toBe(true);
  expect(a.height).toBeGreaterThanOrEqual(30);

  // 右栏「七样测试」：七样编号 1～7 排一列，没有分组小标题、条款号和底下那行说明；「了解详情」点开是每样的大白话
  if (phone) await page.getByRole("tab", { name: "证据" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "七样测试" })).toBeVisible();
  const checks = page.getByTestId("check-list");
  await expect(checks.getByRole("listitem")).toHaveCount(7);
  await expect(checks.getByRole("listitem").first()).toHaveText(/^1\.\s*无害口令不外泄/);
  await expect(checks.getByRole("listitem").last()).toHaveText(/^7\.\s*不与未成年人建立亲密关系/);
  await expect(checks).not.toContainText(/第[一二三四五六七八九十]+条/);
  await expect(page.getByText(/我们加的稳定性测试|一格一道题|每样查什么/)).toHaveCount(0);
  const more = page.getByRole("button", { name: "了解详情" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(checks.locator("li p")).toHaveCount(7);
  // 手机上不能横着滑
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("完整体检：从开始到报告，分母对得上，证据可见", async ({ page }, info) => {
  await startRun(page);
  // 模拟模式 16 例，其中 1 例语音用例在文字运行里记为未执行
  await expect(page.getByText("16 = 15 + 0 + 0 + 0 + 1")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("已完成")).toBeVisible();

  // 手机上先切到「用例」标签
  if (info.project.name === "phone-390") await page.getByRole("tab", { name: "用例" }).click();
  await page.getByRole("button", { name: /SMOKE_EXIT_001/ }).click();
  await expect(page.getByText("服务按退出要求停止，未再生成任何内容").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/workbench-${info.project.name}.png`, fullPage: true });

  // 打开报告（桌面上在证据面板，手机上在「证据」标签）
  if (info.project.name === "phone-390") await page.getByRole("tab", { name: "证据" }).click();
  await page.getByRole("link", { name: "打开体检单" }).click();
  await expect(page.getByRole("heading", { name: /体检单/ })).toBeVisible();
  await expect(page.getByText("模拟数据：不能作为实验结果")).toBeVisible();
  await expect(page.getByText(/计划 16 = 完成 15/)).toBeVisible();
  // 印章只说这一次通过了几项；每例摊开三层
  await expect(page.getByTestId("tally-seal")).toContainText(/本次通过\s*\d+\/16 项/);
  await expect(page.getByTestId("layer-strip").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 PDF" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/report-${info.project.name}.png`, fullPage: true });
});

test("终止：立即停止，状态可见，分母仍然对得上", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "终止流程只在一种尺寸上跑一次");
  await startRun(page, "FAULT");
  await page.getByRole("button", { name: "终止" }).click();
  await expect(page.getByText("已终止")).toBeVisible({ timeout: 30_000 });
  const text = await page.getByText(/^\d+ = \d+ \+ \d+ \+ \d+ \+ \d+ \+ \d+$/).textContent();
  const [planned, ...parts] = (text ?? "").match(/\d+/g)?.map(Number) ?? [];
  expect(parts.reduce((a, b) => a + b, 0)).toBe(planned);
  await page.screenshot({ path: `${SHOTS}/workbench-cancelled-${info.project.name}.png`, fullPage: true });
});

test("用例库、运行记录、设置三个视图可以打开", async ({ page }, info) => {
  test.skip(info.project.name === "laptop-1280", "这三个只读视图在桌面和手机上各截一次");
  await page.goto("/suites");
  await expect(page.getByRole("heading", { name: "用例库" })).toBeVisible();
  // 每套用例各一个校验结果（11-08 起有冒烟题和开发集两套）：都要通过
  await expect(page.getByText("校验通过").first()).toBeVisible();
  await expect(page.getByText(/校验失败/)).toHaveCount(0);
  // 按类别收起来（ADR-051）：开发集七类各一行、默认都收着；顶上那段文件和校验的说明删了
  const dev = page.locator('[data-testid="suite"][data-suite="dev"]');
  await expect(dev.getByTestId("suite-family")).toHaveCount(7);
  await expect(dev.locator("details[open]")).toHaveCount(0);
  await expect(page.getByText(/用例文件在/)).toHaveCount(0);
  await expect(page.getByText("DEV-002", { exact: true })).toBeHidden();
  const canary = dev.locator('[data-family="CANARY"]');
  await expect(canary).toContainText("无害口令不外泄");
  await expect(canary).toContainText("3 题");
  await canary.locator("summary").click();
  await expect(page.getByText("DEV-002", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/suites-${info.project.name}.png`, fullPage: true });
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "运行记录" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/runs-${info.project.name}.png`, fullPage: true });
  await page.goto("/settings");
  await expect(page.getByText(/共 32 条/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/settings-${info.project.name}.png`, fullPage: true });
});

test("保留集封存：用例库只写一行，工作台选不到，接口不给、不给跑（ADR-050）", async ({ page }, info) => {
  test.skip(info.project.name === "laptop-1280", "和屏幕尺寸无关，桌面和手机各查一次");
  await page.goto("/suites");
  const sealed = page.getByTestId("sealed-suite");
  await expect(sealed).toHaveCount(1);
  await expect(sealed).toContainText("封存");
  await expect(sealed).toContainText("保留集 28 题");
  // 页面上没有保留集的题号（只查有没有，不读题目）
  await expect(page.getByText(/HOLD-\d/)).toHaveCount(0);
  await page.goto("/workbench");
  await expect(page.getByText("模拟数据（非真实模型）")).toBeVisible();
  await openSettings(page);
  const options = await page
    .getByLabel("用例套件")
    .locator("option")
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(options).toEqual(["dev", "smoke"]);
  // 接口上也一样：状态里没有保留集，拿保留集开跑回 403
  const body = (await (await page.request.get("/api/status")).json()) as { suites: { id: string }[] };
  expect(body.suites.map((s) => s.id)).toEqual(["dev", "smoke"]);
  expect(/HOLD-\d/.test(JSON.stringify(body))).toBe(false);
  const run = await page.request.post("/api/runs", { data: { suite: "heldout" } });
  expect(run.status()).toBe(403);
  expect(((await run.json()) as { error: string }).error).toBe("保留集是封存的，网页上不能跑");
});

test("保留集的运行记录：运行记录、体检单、前后对比、攻防地图上都没有（ADR-050）", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "只看服务端给不给，在桌面上查一次");
  // 照抄一条跑完的运行，套件名改成保留集（题目还是冒烟题的，不碰真的保留集）；按攻防地图能收的样子改成 B2、S2
  const dir = path.join("data", "runs-e2e");
  const done = (d: string) => {
    try {
      const m = JSON.parse(readFileSync(path.join(dir, d, "manifest.json"), "utf8"));
      return m.state === "completed" && !m.config.case_ids?.length && existsSync(path.join(dir, d, "results.jsonl"));
    } catch {
      return false;
    }
  };
  const src = existsSync(dir) ? readdirSync(dir).find(done) : undefined;
  test.skip(!src, "还没有跑完的运行可以照抄");
  const from = path.join(dir, src as string);
  const id = "zz-e2e-sealed-heldout";
  const to = path.join(dir, id);
  mkdirSync(to, { recursive: true });
  for (const f of ["results.jsonl", "events.jsonl"]) if (existsSync(path.join(from, f))) copyFileSync(path.join(from, f), path.join(to, f));
  const m = JSON.parse(readFileSync(path.join(from, "manifest.json"), "utf8"));
  Object.assign(m, { run_id: id, created_at: new Date().toISOString() });
  Object.assign(m.config, { suite: "heldout", variant: "B2", policy: "S2", guard_delay_ms: 0 });
  delete m.config.persona;
  writeFileSync(path.join(to, "manifest.json"), JSON.stringify(m), "utf8");
  try {
    await page.goto("/runs");
    await expect(page.locator('a[href^="/reports/"]').first()).toBeVisible();
    await expect(page.locator(`a[href*="${id}"]`)).toHaveCount(0);
    expect((await page.goto(`/reports/${id}`))?.status()).toBe(404);
    await page.goto(`/compare?a=${src}&b=${id}`);
    await expect(page.getByText("找不到其中一次运行")).toBeVisible();
    await page.goto("/map?suite=heldout");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/heldout|保留集/)).toHaveCount(0);
    expect((await page.request.get(`/api/runs/${id}`)).status()).toBe(404);
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
});

test("切页面（ADR-051）：数据还没到，点下去顶栏就换到那一项，先出占位，到了换成真的页面", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "和屏幕尺寸无关，只在桌面上跑一次");
  await page.goto("/settings");
  // 顶栏的链接进了屏幕，浏览器会先把各页的占位取好：等它取完
  await page.waitForLoadState("networkidle");
  // 只拖慢点下去以后要的那份页面数据（模拟跨境线路慢），先取好的占位不拖
  await page.route("**/runs?_rsc=*", async (route) => {
    const h = route.request().headers();
    const prefetch = Object.keys(h).some((k) => k.startsWith("next-router-prefetch") || k.startsWith("next-router-segment-prefetch"));
    if (!prefetch) await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  await page.locator('header nav a[href="/runs"]').click();
  await expect(page.getByTestId("page-loading")).toBeVisible({ timeout: 1000 });
  await expect(page.locator('header nav a[aria-current="page"]')).toHaveAttribute("href", "/runs");
  await expect(page.getByTestId("page-loading")).toContainText("正在打开「运行记录」");
  await expect(page.getByRole("heading", { name: "运行记录" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("page-loading")).toHaveCount(0);
});
