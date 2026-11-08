// 给形象渲两张静态图（评审 R48）：3D 形象加载出来之前先显示它，加载失败就停在它上面，不再是一个空圆。
//   半身月洞窗（工作台、三种结局）：components/avatar-art/qiyetao-bust.jpg
//   闯关页的半身舞台：               components/avatar-art/qiyetao-stage.jpg
// 用的就是网站上的 VRM 和同样的取景：开着的本机服务里打开页面，等 3D 形象出来、两眼睁着时截图。换了模型或取景就重跑一次。
//   先起服务：npx next start -H 127.0.0.1 -p 3600（模拟模式就行，不花钱）
//   再跑：npx tsx scripts/avatar-stills.ts --base http://127.0.0.1:3600
// 模型文件 public/models/qiyetao.vrm 是队员 A 用 VRoid Studio 做的（许可见 docs/PROVENANCE.md），这两张图只是它的渲染。

import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const base = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:3600";
const OUT = path.join("components", "avatar-art");

/** 等 3D 形象加载好，再等到某一帧两眼睁着、嘴闭着（逐帧记录在 ?avatarTest=1 时挂在 window.__avatar 上） */
async function settle(page: Page) {
  await page.getByTestId("avatar-status").filter({ hasText: "VRM 3D 形象" }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000); // 登场的点头演完
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { __avatar?: { trace: { blink: number; open: number }[] } }).__avatar?.trace.at(-1);
      return t !== undefined && t.blink < 0.02 && t.open < 0.02;
    },
    undefined,
    { timeout: 20_000, polling: 16 },
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", args: ["--no-proxy-server"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  await page.goto(`${base}/workbench?avatarTest=1&avatarSeed=7`);
  await settle(page);
  const bust = page.getByRole("img", { name: "琪叶桃 3D 形象" }).first();
  await bust.screenshot({ path: path.join(OUT, "qiyetao-bust.jpg"), type: "jpeg", quality: 82 });
  console.log("✓ 半身月洞窗");

  await page.goto(`${base}/play?avatarTest=1&avatarSeed=7`);
  await settle(page);
  // 状态环是现场画的，不进静态图
  await page.addStyleTag({ content: '[data-testid="avatar-stage"] > div:first-child { visibility: hidden }' });
  await page.getByTestId("avatar-stage").screenshot({ path: path.join(OUT, "qiyetao-stage.jpg"), type: "jpeg", quality: 80 });
  console.log("✓ 闯关页半身舞台");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
