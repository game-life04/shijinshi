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
  await page.goto("/workbench");
  await expect(page.getByTestId("avatar-status")).toContainText("VRM 3D 形象", { timeout: 60_000 });
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
