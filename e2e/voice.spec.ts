import { expect, type Page, test } from "@playwright/test";

// 语音链路（模拟发声）：浏览器真实运行 AudioWorklet，计量来自实际渲染的采样。
const SHOTS = "docs/evidence/screenshots/m2";

async function startVoiceRun(page: Page, o: { variant: string; policy: string; delay: number; cases: number }) {
  await page.goto("/workbench");
  await expect(page.getByText("模拟数据（非真实模型）")).toBeVisible();
  await page.getByLabel("被测配置").selectOption(o.variant);
  await page.getByLabel("放行策略").selectOption(o.policy);
  await page.getByLabel("最多用例").fill(String(o.cases));
  await page.getByLabel("护栏固定延迟 ms").fill(String(o.delay));
  await page.getByLabel("语音播放").check();
  await page.getByRole("button", { name: "开始体检" }).click();
}

const ms = (s: string | null, label: RegExp) => Number(s?.match(label)?.[1] ?? Number.NaN);

test("先播后截：判定在口令开口前回来，口令一个采样都没渲染", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "语音只在桌面尺寸上跑");
  await startVoiceRun(page, { variant: "FAULT_B2", policy: "S3", delay: 1000, cases: 1 });
  const leak = page.getByTestId("leak-meter");
  await expect(leak).toContainText("1 次截断", { timeout: 60_000 });
  await expect(leak).toContainText("0 ms");
  await expect(leak).toContainText("按字精确定位");
  await expect(page.getByText("已完成")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/截断前已渲染 [1-9][\d.]* ms/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/voice-s3-cut-early-${info.project.name}.png`, fullPage: true });
});

test("先播后截：判定晚于口令开口，漏出时长大于 0，停止和口型归零都有计时", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "语音只在桌面尺寸上跑");
  await startVoiceRun(page, { variant: "FAULT_B2", policy: "S3", delay: 4000, cases: 1 });
  const leak = page.getByTestId("leak-meter");
  await expect(leak).toContainText("1 次截断", { timeout: 60_000 });
  expect(ms(await leak.textContent(), /([\d.]+) ms/)).toBeGreaterThan(0);
  await expect(page.getByText(/停止 ≤ [\d.]+ ms · 口型归零 [\d.]+ ms/)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/voice-s3-leak-${info.project.name}.png`, fullPage: true });

  // 报告里写明计量口径和逐次截断
  await expect(page.getByText("已完成")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "打开体检单" }).click();
  await expect(page.getByRole("heading", { name: "语音计量（浏览器渲染层）" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "按字精确" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/report-voice-${info.project.name}.png`, fullPage: true });
});

test("先审后播：违规句不放行、不合成，首声等待有数", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "语音只在桌面尺寸上跑");
  await startVoiceRun(page, { variant: "FAULT_B2", policy: "S1", delay: 0, cases: 2 });
  await expect(page.getByText("已完成")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("leak-meter")).toContainText("还没有截断");
  expect(ms(await page.getByTestId("first-audio-meter").textContent(), /最近 ([\d.]+) ms/)).toBeGreaterThan(0);
  await expect(page.getByText("护栏拦下，未放行").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/voice-s1-${info.project.name}.png`, fullPage: true });
});
