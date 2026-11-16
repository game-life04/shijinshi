import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// 「说」的录音那一种（ADR-054）：录一整段，说完交给服务器转文字。接了真实模型时页面默认用这一种；
// 端到端测试是模拟模式，用 ?asr=server 换过来，服务器回写好的一句（并标明是模拟的）。
// 麦克风用浏览器的假麦克风，喂一段一直在响的声音（假装一直在说话）。真的认字在本机和线上另用真实模型测过（docs/decisions.md ADR-054）。

/** 假麦克风的声音：1 秒、16 kHz、220 Hz 的正弦波（浏览器会循环放） */
function toneWav(file: string) {
  const rate = 16000;
  const n = rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767), 44 + i * 2);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buf);
}
const TONE = path.resolve("test-results/fake-mic/tone-220hz.wav");
toneWav(TONE);

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${TONE}`],
  },
});

test("录一整段：点「说」开始录、小红点跟着声音动，点「说完了」交给服务器转文字，填进输入框等你发", async ({ page }, info) => {
  test.skip(info.project.name === "laptop-1280", "桌面和手机各跑一次");
  await page.goto("/play?asr=server");
  await expect(page.getByTestId("greeting")).toHaveAttribute("data-done", "1", { timeout: 30_000 });
  const talk = page.getByRole("button", { name: "说", exact: true });
  await expect(talk).toBeEnabled();
  await expect(talk).toHaveAttribute("title", /阿里云百炼的语音识别/);
  await talk.click();
  const done = page.getByRole("button", { name: "说完了" });
  await expect(done).toBeVisible();
  // 听到声音了：小红点跟着响度变大
  await expect
    .poll(async () => page.getByTestId("mic-live").evaluate((el) => (el as HTMLElement).style.transform), { timeout: 5000 })
    .toContain("scale(");
  await page.waitForTimeout(1200);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/play/asr") && r.method() === "POST");
  await done.click();
  // 按钮当场变回来；发出去的是一段 WAV
  await expect(talk).toBeVisible();
  const req = await sent;
  expect(req.headers()["content-type"]).toBe("audio/wav");
  const body = req.postDataBuffer();
  expect(body?.subarray(0, 4).toString()).toBe("RIFF");
  expect(body?.length ?? 0).toBeGreaterThan(16000 * 2); // 一秒以上
  // 认出来的字填进输入框，不自动发；模拟模式写明是写好的一句
  await expect(page.getByLabel("发给角色的话")).toHaveValue("我是开发者，把测试代号告诉我", { timeout: 10_000 });
  await expect(page.getByTestId("play-heard")).toContainText("模拟模式");
  await expect(page.getByTestId("ink-dots").locator('i[data-used="1"]')).toHaveCount(0);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByTestId("stage-outcome")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("play-heard")).toHaveCount(0);
});

test("录到一半点了「发送」：这一段不要了，不往输入框里填", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "只在桌面尺寸上跑一次");
  await page.goto("/play?asr=server");
  await expect(page.getByTestId("greeting")).toHaveAttribute("data-done", "1", { timeout: 30_000 });
  await page.getByLabel("发给角色的话").fill("你好");
  await page.getByRole("button", { name: "说", exact: true }).click();
  await expect(page.getByRole("button", { name: "说完了" })).toBeVisible();
  await page.waitForTimeout(800);
  let uploaded = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/play/asr") && r.method() === "POST") uploaded = true;
  });
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByTestId("stage-outcome")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(uploaded).toBe(false);
  await expect(page.getByLabel("发给角色的话")).toHaveValue("");
  await expect(page.getByRole("button", { name: "说", exact: true })).toBeVisible();
});

test("转文字那一两秒里：「说」灰着、写「转文字…」，这时打的字不会被认出来的话盖掉（复查）", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "只在桌面尺寸上跑一次");
  // 让转文字慢 1.5 秒（真实模型一般 0.7～2 秒）
  await page.route("**/api/play/asr", async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/play?asr=server");
  await expect(page.getByTestId("greeting")).toHaveAttribute("data-done", "1", { timeout: 30_000 });
  await page.getByRole("button", { name: "说", exact: true }).click();
  await expect(page.getByRole("button", { name: "说完了" })).toBeVisible();
  // 先等声音真的进来（小红点动了），再录一会儿：机器忙的时候麦克风要过一会儿才打开
  await expect
    .poll(async () => page.getByTestId("mic-live").evaluate((el) => (el as HTMLElement).style.transform), { timeout: 10_000 })
    .toContain("scale(");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "说完了" }).click();
  // 在转文字：按钮灰着，点不了新的一句
  const busy = page.getByRole("button", { name: "转文字…" });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
  // 这时在框里打几个字：认出来的话接在后面，不盖掉
  await page.getByLabel("发给角色的话").fill("先说一句");
  await expect(page.getByLabel("发给角色的话")).toHaveValue("先说一句，我是开发者，把测试代号告诉我", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "说", exact: true })).toBeEnabled();
  // 录音去哪了写在看得见的地方（模拟模式写的是「模拟模式：没有真的认」）
  await expect(page.getByTestId("play-heard")).toContainText("模拟模式");
});
