import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openSettings } from "./settings";

// 3D 形象（规格 01 §2.5：截图 + 多帧像素差确认非空、会动）。没有放模型文件时跳过。
const HAS_MODEL = existsSync("public/models/qiyetao.vrm");
// 截图默认写到 test-results；设 UPDATE_EVIDENCE=1 才更新仓库里的证据截图（docs/evidence）
const SHOTS = process.env.UPDATE_EVIDENCE ? "docs/evidence/screenshots/m2" : "test-results/screenshots/m2";

test("VRM 形象加载后在动，说话时口型跟着声音", async ({ page }, info) => {
  test.skip(!HAS_MODEL, "public/models/qiyetao.vrm 不存在");
  test.skip(info.project.name !== "desktop-1440", "3D 只在桌面尺寸上跑");
  // 模型提前下载（ADR-043）：页面能用以后自己发一个请求，下载好的数据直接拿来解析，整个模型只下载一次。
  // ADR-049 复查起不再用预下载的 link、也不先发 HEAD 探文件：控制台原来会报「预加载的请求方法对不上」「预加载了没用上」
  const downloads: string[] = [];
  const others: string[] = [];
  const notes: string[] = [];
  page.on("request", (r) => {
    if (!r.url().includes("/models/qiyetao.vrm")) return;
    if (r.method() === "GET") downloads.push(r.url());
    else others.push(r.method());
  });
  page.on("console", (m) => {
    if (/preload/i.test(m.text())) notes.push(m.text());
  });
  await page.goto("/workbench");
  await expect(page.getByTestId("avatar-status")).toHaveAttribute("data-state", "loaded", { timeout: 60_000 });
  // 出来以后形象下面只写「AI 角色」和名字（ADR-051：「VRM 3D 形象」「不是真人」删了，AI 标识顶栏一直挂着）
  await expect(page.getByTestId("avatar-status").first()).toHaveText(/^AI 角色\s*琪叶桃$/);
  await expect(page.locator('link[rel="preload"][href*="qiyetao.vrm"]')).toHaveCount(0);
  expect(downloads.length).toBe(1);
  expect(others).toEqual([]);
  expect(notes).toEqual([]);
  const avatar = page.getByRole("img", { name: "琪叶桃 3D 形象" });
  await expect(avatar).toHaveAttribute("data-fps", /\d+/, { timeout: 10_000 });

  // 开一次语音运行，在说话期间连拍两帧，像素要有差别
  await page.getByLabel("被测配置").selectOption("B2");
  await openSettings(page);
  await page.getByLabel("最多用例").fill("1");
  await page.getByLabel("语音播放").check();
  await page.getByRole("button", { name: "开始体检" }).click();
  await expect(page.getByTestId("first-audio-meter"))
    .not.toHaveText("—", { timeout: 30_000 })
    .catch(() => {});
  const a = await avatar.screenshot();
  await page.waitForTimeout(250);
  const b = await avatar.screenshot();
  expect(a.equals(b)).toBe(false);
  console.log(`fps=${await avatar.getAttribute("data-fps")}`);
  await page.screenshot({ path: `${SHOTS}/vrm-${info.project.name}.png`, fullPage: true });
});

test("模型文件不在：写明「还没有放入 VRM 模型文件」，静态图留着，页面照常能用；只用 GET 要模型（最多两次），不发 HEAD", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop-1440", "3D 只在桌面尺寸上跑");
  const methods: string[] = [];
  await page.route("**/models/qiyetao.vrm", (route) => {
    methods.push(route.request().method());
    return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
  });
  await page.goto("/workbench");
  await expect(page.getByTestId("avatar-status")).toContainText("还没有放入 VRM 模型文件", { timeout: 60_000 });
  // 3D 出不来，静态图留着（月洞窗里的半身像）
  await expect(page.locator('img[src*="qiyetao-bust"]').first()).toBeVisible();
  // 失败的下载不记着：提前下载那一次失败以后，3D 组件自己再要一次（都是 GET）
  expect(methods.every((m) => m === "GET")).toBe(true);
  expect(methods.length).toBeGreaterThanOrEqual(1);
  expect(methods.length).toBeLessThanOrEqual(2);
  // 页面照常能用
  await expect(page.getByRole("button", { name: "开始体检" })).toBeEnabled();
});
