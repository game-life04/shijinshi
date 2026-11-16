import { expect, type Locator, type Page, test } from "@playwright/test";

// 攻防地图（ADR-038）：先用接口跑一次模拟体检（冒烟题里口令、身份两类各一题，草稿题只能预览），再打开地图。
// ADR-053（11-16 队员 B 修改稿 3）：最上面三张卡片（测试了 / 守住了 / 没守住）、七项检查结果、本次要看的问题；
//   原来的地图收进「详细矩阵」折叠，默认收着，展开后照旧：口令那一行开场句一格有数、盖了印，身份那一行套路格合成
//   「只用写好的句子测」；点一格看明细、链到体检单；带着 #detail 打开时折叠自己展开。三档对照、切到「角色原话」照样能看。
// 别的测试（同一个服务上）也会跑同样两题的模拟体检，「最近一次」可能是它们的：这里只查数和数之间对得上，不写死几题。
// 截图默认写到 test-results；设 UPDATE_EVIDENCE=1 才更新仓库里的证据截图（docs/evidence）
const SHOTS = process.env.UPDATE_EVIDENCE ? "docs/evidence/screenshots/m3" : "test-results/screenshots/m3";

const KEYS = ["tried", "held", "broken", "unsure"] as const;
type Counts = Record<(typeof KEYS)[number], number>;
const num = async (loc: Locator, attr: string) => Number(await loc.getAttribute(attr));
const countsOf = async (loc: Locator): Promise<Counts> => ({
  tried: await num(loc, "data-tried"),
  held: await num(loc, "data-held"),
  broken: await num(loc, "data-broken"),
  unsure: await num(loc, "data-unsure"),
});

/** 用接口跑一次模拟体检（冒烟题里口令、身份各一题），等它跑完，返回运行编号 */
async function smokeRun(page: Page): Promise<string> {
  const created = await page.request.post("/api/runs", {
    data: {
      suite: "smoke",
      variant: "B2",
      policy: "S2",
      include_drafts: true,
      case_ids: ["SMOKE_CANARY_001", "SMOKE_IDENTITY_001"],
    },
  });
  expect(created.ok()).toBe(true);
  const { run_id } = (await created.json()) as { run_id: string };
  await expect
    .poll(async () => ((await (await page.request.get(`/api/runs/${run_id}`)).json()) as { manifest: { state: string } }).manifest.state, {
      timeout: 60_000,
    })
    .toBe("completed");
  return run_id;
}

test("从上面点「查看原话」：折叠自己展开、明细卷进屏幕、她的话前面标着 AI 角色；收起以后再点同一个链接照样展开", async ({ page }, info) => {
  test.skip(info.project.name === "laptop-1280", "桌面和手机各跑一次");
  test.setTimeout(120_000);
  await smokeRun(page);
  await page.goto("/map?suite=smoke&level=simulation&variant=B2&layer=released");
  await expect(page.getByRole("heading", { level: 1, name: "攻防地图" })).toBeVisible();
  // 「查看原话」在两处：没守住的问题里、拿不准的那几样后面。模拟体检里身份那一题裁判判不了，至少有拿不准的那一个
  const see = page.getByTestId("map-issues").getByRole("link", { name: "查看原话" });
  test.skip((await see.count()) === 0, "这次模拟体检没有没守住、也没有拿不准的题，没有「查看原话」可点");
  // 读屏名字里带着是哪样检查（一页上有好几个「查看原话」，光这四个字分不清）
  await expect(see.first()).toHaveAttribute("aria-label", /^查看原话：.+/);
  const fold = page.getByTestId("map-fold");
  const detail = page.getByTestId("map-detail");
  await expect(fold).not.toHaveAttribute("open");
  await see.first().click();
  await expect(page).toHaveURL(/cell=.+#detail$/);
  await expect(fold).toHaveAttribute("open", "");
  await expect(detail).toBeInViewport();
  // 这一页没有形象、顶栏也不标 AI：她的话前面自己写明是 AI 角色说的
  await expect(detail).toContainText("她（AI 角色）说出口的：");
  // 把折叠收起来、卷回顶上，再点同一个链接：地址没变，也要展开、卷过去（复查：原来点了没反应）
  await fold.locator(":scope > summary").click();
  await expect(fold).not.toHaveAttribute("open");
  await page.evaluate(() => window.scrollTo(0, 0));
  await see.first().click();
  await expect(fold).toHaveAttribute("open", "");
  await expect(detail).toBeInViewport();
  // 手改地址带坏掉的 %xx：页面照常打开，不整页报错
  await page.goto("/map?suite=smoke&level=simulation&variant=B2&layer=released#cmp-%E0");
  await expect(page.getByRole("heading", { level: 1, name: "攻防地图" })).toBeVisible();
  await expect(page.getByTestId("map-summary")).toBeVisible();
});

test("攻防地图：三张卡片、七项检查结果、要看的问题；展开详细矩阵点一格看明细", async ({ page }, info) => {
  test.setTimeout(120_000);
  const run_id = await smokeRun(page);

  await page.goto("/map?suite=smoke&level=simulation&variant=B2&layer=released");
  await expect(page.getByRole("heading", { level: 1, name: "攻防地图" })).toBeVisible();
  await expect(page.getByText("先看哪项没守住，再查看对应问题和原话。")).toBeVisible();

  // 三张卡片：测试了 = 守住了 + 没守住 + 拿不准（拿不准单独标，不算守住也不算没守住）
  const summary = page.getByTestId("map-summary");
  const card = (k: string) => summary.locator(`[data-card="${k}"]`);
  await expect(card("tried")).toContainText("测试了");
  await expect(card("held")).toContainText("守住了");
  await expect(card("broken")).toContainText("没守住");
  const total = await countsOf(summary);
  expect(total.tried).toBeGreaterThanOrEqual(1);
  expect(total.held + total.broken + total.unsure).toBe(total.tried);
  for (const k of ["tried", "held", "broken"] as const) {
    expect(await num(card(k), "data-n")).toBe(total[k]);
    await expect(card(k)).toContainText(`${total[k]} 题`);
  }
  if (total.unsure) await expect(summary).toContainText(`拿不准 ${total.unsure} 题`);

  // 七项检查结果：一样一行，七行加起来就是卡片上的数；口令测过，写「x / y 守住」；没测过的写「没测」，不当成守住
  const checks = page.getByTestId("map-checks");
  await expect(checks.getByRole("heading", { name: "七项检查结果" })).toBeVisible();
  const rows = checks.locator("li[data-family]");
  await expect(rows).toHaveCount(7);
  const sum: Counts = { tried: 0, held: 0, broken: 0, unsure: 0 };
  for (const row of await rows.all()) {
    const c = await countsOf(row);
    for (const k of KEYS) sum[k] += c[k];
    if (c.tried) await expect(row).toContainText(`${c.held} / ${c.tried} 守住`);
    else {
      await expect(row).toContainText("没测");
      await expect(row).not.toContainText("守住");
    }
  }
  expect(sum).toEqual(total);
  const canaryCheck = checks.locator('li[data-family="CANARY"]');
  await expect(canaryCheck).toContainText("无害口令不外泄");
  expect(await num(canaryCheck, "data-tried")).toBeGreaterThanOrEqual(1);

  // 本次要看的问题：没守住的一条条列（每条三个按钮，「没守住几题」加起来就是卡片上的数），一题都没破就一句话
  const issues = page.getByTestId("map-issues");
  await expect(issues).toBeVisible();
  const broken = issues.locator('li[data-kind="broken"]');
  const listed = await broken.evaluateAll((els) => els.reduce((s, el) => s + Number(el.getAttribute("data-broken")), 0));
  expect(listed).toBe(total.broken);
  if (total.broken) {
    await expect(issues.getByRole("heading", { level: 2 })).toContainText("本次要看这");
    await expect(broken.first().getByRole("link", { name: "打开对应体检单" })).toHaveAttribute("href", /\/reports\/[^#]+#case-\d+$/);
    await expect(broken.first().getByRole("link", { name: "查看原话" })).toHaveAttribute("href", /cell=.+#detail$/);
    await expect(broken.first().getByRole("link", { name: "查看三档对照" })).toHaveAttribute("href", /view=compare.*#cmp-/);
  } else if (!(await issues.locator('li[data-kind="blocked"]').count())) {
    await expect(issues).toContainText(/这一档都守住了|没有没守住的题/);
  }

  // 详细矩阵：默认收着；展开后和原来的地图一样
  const fold = page.getByTestId("map-fold");
  const map = page.getByTestId("attack-map");
  await expect(fold).not.toHaveAttribute("open");
  await expect(map).toBeHidden();
  await fold.locator(":scope > summary").click();
  await expect(fold).toHaveAttribute("open", "");
  await expect(map).toBeVisible();
  await expect(map.getByRole("rowheader", { name: "无害口令不外泄" })).toBeVisible();
  // 口令这一行：开场句那一格试过，盖了一方印（守 / 破 / 疑）
  const canary = map.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "无害口令不外泄" }) });
  await expect(canary.locator("td[data-tried]").first()).toHaveAttribute("data-tried", /[1-9]/);
  await expect(canary.locator("td[data-tried]").first()).toHaveAttribute("data-mark", /^[守破疑]$/);
  // 格子里的「攻破」只记在攻破那一句上，加起来就是卡片上的「没守住」
  const cellBroken = await map
    .locator("td[data-broken]")
    .evaluateAll((els) => els.reduce((s, el) => s + Number(el.getAttribute("data-broken")), 0));
  expect(cellBroken).toBe(total.broken);
  // 身份这一行：测试 Agent 的套路一个都不让用，后面几格合成一格；角色设定那一行只有「拆开提问」不适用
  const identity = map.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "提示自己是 AI" }) });
  await expect(identity.getByText(/只用写好的句子测/)).toBeVisible();
  const persona = map.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "不违背角色设定" }) });
  await expect(persona.getByText("不适用")).toBeVisible();
  await expect(page.getByText("详细规则")).toBeVisible();
  await expect(page.getByText(/这张图用了哪几次体检/)).toBeVisible();
  // 拦住攻击的是哪一层（和闯关四层同一个口径）
  await expect(page.getByTestId("stop-bar").first()).toBeVisible();

  // 点口令那一行的开场句：下面出明细，列出这一题、那一句、她说了什么、被哪层拦住，链到体检单那一例
  await canary
    .getByRole("link", { name: /看明细/ })
    .first()
    .click();
  await expect(page).toHaveURL(/cell=CANARY\.OPENING#detail$/);
  const detail = page.getByTestId("map-detail");
  await expect(detail).toContainText("SMOKE_CANARY_001");
  await expect(detail).toContainText("这一句：");
  await expect(detail.getByRole("link", { name: "SMOKE_CANARY_001" })).toHaveAttribute(
    "href",
    new RegExp(`/reports/${run_id}#case-[0-9]+$`),
  );
  await page.screenshot({ path: `${SHOTS}/map-${info.project.name}.png`, fullPage: true });

  // 带着 #detail 直接打开（刷新）：详细矩阵自己展开、明细看得见；收起明细，详细矩阵还开着
  await page.reload();
  await expect(fold).toHaveAttribute("open", "");
  await expect(detail).toBeVisible();
  await detail.getByRole("link", { name: "收起" }).click();
  await expect(detail).toHaveCount(0);
  await expect(map).toBeVisible();

  // 不横着滚
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // 三档对照：三档各一组小卡片（各自对得上），七项三档并排；详细矩阵里是原来的三档对照（「哪一层拦住」三档并排）
  const tiersNav = page.getByRole("navigation", { name: "看哪一档" });
  await tiersNav.getByRole("link", { name: "三档对照" }).click();
  await expect(page).toHaveURL(/view=compare/);
  const tiers = page.getByTestId("map-summary").locator("[data-tier]");
  await expect(tiers).toHaveCount(3);
  for (const t of await tiers.all()) {
    const c = await countsOf(t);
    expect(c.held + c.broken + c.unsure).toBe(c.tried);
  }
  await expect(page.getByTestId("map-checks").locator("tbody tr")).toHaveCount(7);
  if ((await fold.getAttribute("open")) === null) await fold.locator(":scope > summary").click();
  await expect(page.getByTestId("stop-bar")).toHaveAttribute("data-tiers", "3");
  await tiersNav.getByRole("link", { name: /再加护栏/ }).click();
  await expect(page).toHaveURL(/view=one/);

  // 切到「角色原话」
  await page.getByRole("navigation", { name: "按哪句算" }).getByRole("link", { name: "角色原话" }).click();
  await expect(page).toHaveURL(/layer=raw/);
  await expect(page.getByTestId("map-summary")).toHaveAttribute("data-layer", "raw");
  await expect(page.getByTestId("map-summary")).toContainText("按角色原话算");
});
