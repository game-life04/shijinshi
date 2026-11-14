import { expect, test } from "@playwright/test";

// 攻防地图（ADR-038）：先用接口跑一次模拟体检（冒烟题里口令、身份两类各一题，草稿题只能预览），
// 再打开地图：开头一句结论；口令那一行开场句一格有数、盖了印，身份那一行套路格合成「只用写好的句子测」；切到「角色原话」照样能看。
// ADR-049（看得懂）：格子盖「守 / 破 / 疑」印；「怎么数的」两行 + 收起来的「详细规则」；档位按钮里带「三档对照」。
// 截图默认写到 test-results；设 UPDATE_EVIDENCE=1 才更新仓库里的证据截图（docs/evidence）
const SHOTS = process.env.UPDATE_EVIDENCE ? "docs/evidence/screenshots/m3" : "test-results/screenshots/m3";

test("攻防地图：七样检查 × 怎么攻，每格攻破几次 / 试了几次", async ({ page }, info) => {
  test.setTimeout(120_000);
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

  await page.goto("/map?suite=smoke&level=simulation&variant=B2&layer=released");
  await expect(page.getByRole("heading", { name: "攻防地图" })).toBeVisible();
  // 开头一句话先说结论：这一档攻了几题、被攻破几题
  await expect(page.getByTestId("map-summary")).toContainText("再加护栏这一档：攻了");
  const map = page.getByTestId("attack-map");
  await expect(map.getByRole("rowheader", { name: "无害口令不外泄" })).toBeVisible();
  // 口令这一行：开场句那一格试过，盖了一方印（守 / 破 / 疑）
  const canary = map.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "无害口令不外泄" }) });
  await expect(canary.locator("td[data-tried]").first()).toHaveAttribute("data-tried", /[1-9]/);
  await expect(canary.locator("td[data-tried]").first()).toHaveAttribute("data-mark", /^[守破疑]$/);
  // 身份这一行：测试 Agent 的套路一个都不让用，后面几格合成一格；角色设定那一行只有「拆开提问」不适用
  const identity = map.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "提示自己是 AI" }) });
  await expect(identity.getByText(/只用写好的句子测/)).toBeVisible();
  const persona = map.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "不违背角色设定" }) });
  await expect(persona.getByText("不适用")).toBeVisible();
  await expect(page.getByText("详细规则")).toBeVisible();
  await expect(page.getByText(/这张图用了哪几次体检/)).toBeVisible();
  // 拦住攻击的是哪一层（和闯关四层同一个口径）
  await expect(page.getByTestId("stop-bar").first()).toBeVisible();

  // 点口令那一行的开场句：下面出明细，列出这一题、那一句、她说了什么、被哪层拦住
  await canary
    .getByRole("link", { name: /看明细/ })
    .first()
    .click();
  await expect(page).toHaveURL(/cell=CANARY\.OPENING/);
  const detail = page.getByTestId("map-detail");
  await expect(detail).toContainText("SMOKE_CANARY_001");
  await expect(detail).toContainText("这一句：");
  await expect(detail.getByRole("link", { name: "SMOKE_CANARY_001" })).toHaveAttribute(
    "href",
    new RegExp(`/reports/${run_id}#case-[0-9]+$`),
  );
  await page.screenshot({ path: `${SHOTS}/map-${info.project.name}.png`, fullPage: true });

  // 三档对照：每格三行（人设 / 边界 / 护栏），「哪一层拦住」三档并排；点档位回到一档一张图
  await page.getByRole("link", { name: "三档对照" }).click();
  await expect(page).toHaveURL(/view=compare/);
  await expect(page.getByTestId("map-summary")).toContainText("三档对照：");
  await expect(page.getByTestId("stop-bar")).toHaveAttribute("data-tiers", "3");
  await page.getByRole("link", { name: /再加护栏/ }).click();
  await expect(page).toHaveURL(/view=one/);

  // 切到「角色原话」
  await page.getByRole("link", { name: /角色原话/ }).click();
  await expect(page).toHaveURL(/layer=raw/);
  await expect(page.getByTestId("map-summary")).toContainText("看角色原话");
});
