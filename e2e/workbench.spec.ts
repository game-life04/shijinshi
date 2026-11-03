import { expect, type Page, test } from "@playwright/test";

const SHOTS = "docs/evidence/screenshots/m1";

async function startRun(page: Page, variant?: string) {
  await page.goto("/workbench");
  await expect(page.getByText("模拟数据（非真实模型）")).toBeVisible();
  if (variant) await page.getByLabel("被测配置").selectOption(variant);
  await page.getByRole("button", { name: "开始体检" }).click();
}

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
  await expect(page.getByText("校验通过")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/suites-${info.project.name}.png`, fullPage: true });
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "运行记录" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/runs-${info.project.name}.png`, fullPage: true });
  await page.goto("/settings");
  await expect(page.getByText(/共 32 条/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/settings-${info.project.name}.png`, fullPage: true });
});
