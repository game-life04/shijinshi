// 给形象渲两张静态图（评审 R48）：3D 形象加载出来之前先显示它，加载失败就停在它上面，不再是一个空圆。
//   半身月洞窗（工作台、三种结局）：components/avatar-art/qiyetao-bust.jpg
//   闯关页的舞台（ADR-049 起两张，globals.css 里 .avatar-still-tall / .avatar-still-wide 按舞台宽高比各摆各的，和 3D 严丝合缝）：
//     又高又窄的舞台（电脑、笔记本，宽高比不到 0.85）：components/avatar-art/qiyetao-stage-tall.jpg
//       这种舞台 3D 取景按宽度撑满（每米 = 舞台宽 ÷ 0.72），中心固定在头顶和腰之间：一张够高的图按宽度缩放、上下居中就对得上
//     方一点、横一点的舞台（平板、手机、横屏）：components/avatar-art/qiyetao-stage-wide.jpg
//       舞台强制成 728×414、镜头中心在头骨下 0.115 米、上下各看 0.435 米（试验台 window.__vrmLab.camera）渲的，宽 1.5299 米；
//       每一段取景的缩放和中心在 globals.css 里算好了
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

  // 又高又窄的舞台：窗口拉高，舞台约 378×1020（宽高比 0.37），比电脑上实际的舞台都高，按宽度缩放后上下都盖得住
  await page.setViewportSize({ width: 1440, height: 1180 });
  await page.goto(`${base}/play?avatarTest=1&avatarSeed=7`);
  await settle(page);
  // 状态环是现场画的，不进静态图
  await page.addStyleTag({ content: '[data-testid="avatar-stage"] > div:first-child { visibility: hidden }' });
  await page.getByTestId("avatar-stage").screenshot({ path: path.join(OUT, "qiyetao-stage-tall.jpg"), type: "jpeg", quality: 78 });
  console.log("✓ 闯关页又高又窄的舞台");

  // 方一点、横一点的舞台：舞台强制成 728×414，镜头用试验台指定（改完拉一下窗口，让它重新取景）
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    (window as unknown as { __vrmLab: unknown }).__vrmLab = { camera: { dy: -0.115, half: 0.435 } };
  });
  await page.goto(`${base}/play?avatarTest=1&avatarSeed=7`);
  await page.addStyleTag({
    content:
      '[data-testid="avatar-stage"] { position: fixed !important; left: 0 !important; top: 0 !important; width: 728px !important; height: 414px !important; flex: none !important; z-index: 50 }',
  });
  await page.getByTestId("avatar-status").filter({ hasText: "VRM 3D 形象" }).waitFor({ timeout: 60_000 });
  await page.setViewportSize({ width: 1441, height: 900 });
  await settle(page);
  await page.addStyleTag({ content: '[data-testid="avatar-stage"] > div:first-child { visibility: hidden }' });
  await page.getByTestId("avatar-stage").screenshot({ path: path.join(OUT, "qiyetao-stage-wide.jpg"), type: "jpeg", quality: 80 });
  console.log("✓ 闯关页方一点、横一点的舞台");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
