import { expect, type Page, test } from "@playwright/test";
import { expectOneScreen, gate, openPanel } from "./play-helpers";

// 闯关页的版面和几处时序（ADR-047，11-13 深度测试以后加的）：
//   手机：整页正好一屏，关卡和记录从底下拉出来；平板两栏；横着拿的手机左右分；矮的笔记本右边一栏不被挤掉；
//   键盘：一下跳到输入框；点现在这一层不清局；带声音的开场白看得见字、念得完。
// 模拟模式。截图默认写到 test-results；设 UPDATE_EVIDENCE=1 才更新仓库里的证据截图（docs/evidence）
const SHOTS = process.env.UPDATE_EVIDENCE ? "docs/evidence/screenshots/m3" : "test-results/screenshots/m3";

async function open(page: Page) {
  await page.goto("/play");
  // 她先开口（ADR-046）：等开场白念完再动手
  await expect(page.getByTestId("greeting")).toHaveAttribute("data-done", "1", { timeout: 30_000 });
}

test("手机：整页正好一屏；关卡和记录从底下拉出来，收起以后焦点回到按钮上", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390", "只在手机尺寸上跑");
  await open(page);
  // 一屏：顶栏压成两行（原来 7 个导航折成好几行，占 150 多像素）；她、四层防守、卡片、输入框、声音开关都整个在屏幕里
  expect((await page.getByRole("banner").boundingBox())?.height ?? 999).toBeLessThan(80);
  for (const el of [
    page.getByTestId("open-levels"),
    page.getByTestId("avatar-stage"),
    page.getByTestId("play-gates"),
    page.getByTestId("stage-card"),
    page.getByLabel("发给角色的话"),
    page.getByRole("button", { name: /她用声音回答/ }),
    page.getByTestId("ink-dots"),
  ])
    await expect(el).toBeInViewport({ ratio: 1 });
  await expectOneScreen(page);
  // 还没开局时卡片里的东西一眼看全，不用在卡片里滚
  expect(await page.getByTestId("stage-card").evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  // 手机上「看 AI 来套话」直接在卡片里（大屏上它在右边一栏）
  await expect(page.getByTestId("stage-card").getByRole("button", { name: "看 AI 来套话" })).toBeVisible();

  // 关卡面板：拉出来以后焦点在「收起」上，台上那几块点不到；按 Esc 收起，焦点回到关卡条
  await page.getByTestId("open-levels").click();
  await expect(page.locator('.play-grid[data-sheet="levels"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "收起", exact: true })).toBeFocused();
  await expect(page.getByTestId("seal-map")).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(() => [".play-chips", ".play-avatar", ".play-dock"].every((s) => document.querySelector<HTMLElement>(s)?.inert)),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".play-grid[data-sheet]")).toHaveCount(0);
  await expect(page.getByTestId("open-levels")).toBeFocused();
  await expect(page.getByTestId("seal-map")).toBeHidden();

  // 在面板里选一格：面板自己收起，关卡条跟着变，她说这一关的开场白
  await openPanel(page, "levels");
  await page.getByTestId("seal-map").getByRole("button", { name: "真人关 · 规则" }).click();
  await expect(page.locator(".play-grid[data-sheet]")).toHaveCount(0);
  await expect(page.getByTestId("open-levels")).toContainText("让它说自己是真人");
  await expect(page.getByTestId("open-levels")).toContainText("第 3 层");
  // 看屏幕上真的显示出来的字（不是给读屏留的那份全文）
  await expect(page.getByTestId("greeting-shown")).toContainText("AI 角色琪叶桃", { timeout: 20_000 });

  // 记录面板：点面板外面的暗处也能收起
  await page.getByTestId("open-log").click();
  await expect(page.locator('.play-grid[data-sheet="log"]')).toHaveCount(1);
  await expect(page.getByTestId("play-log")).toBeVisible();
  await page.getByRole("button", { name: "收起面板" }).click({ position: { x: 20, y: 20 } });
  await expect(page.locator(".play-grid[data-sheet]")).toHaveCount(0);
  await expect(page.getByTestId("open-log")).toBeFocused();
});

test("平板两栏、横着拿的手机、矮的笔记本：输入框都在屏幕里，右边一栏最下面那行不被挤掉", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "换尺寸的检查只跑一次");
  test.setTimeout(240_000);
  await open(page);

  // 平板 768×1024：两栏，没有关卡条，印谱地图直接看得到，在她的右边
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByTestId("open-levels")).toBeHidden();
  await expect(page.getByTestId("seal-map")).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel("发给角色的话")).toBeInViewport({ ratio: 1 });
  const stage = await page.getByTestId("avatar-stage").boundingBox();
  const map = await page.getByTestId("seal-map").boundingBox();
  expect(map?.x ?? 0).toBeGreaterThan((stage?.x ?? 0) + (stage?.width ?? 0) - 1);
  await expectOneScreen(page);
  await page.screenshot({ path: `${SHOTS}/play-tablet-768.png` });

  // 横着拿的手机 667×375：左边她，右边 关卡条 + 四层防守（两行两列）+ 卡片 + 输入框；顶栏只有一行
  await page.setViewportSize({ width: 667, height: 375 });
  await expect(page.getByTestId("open-levels")).toBeVisible();
  await expect(page.getByLabel("发给角色的话")).toBeInViewport({ ratio: 1 });
  expect((await page.getByRole("banner").boundingBox())?.height ?? 999).toBeLessThan(48);
  const g1 = await gate(page, 1).boundingBox();
  const g2 = await gate(page, 2).boundingBox();
  expect(Math.abs((g1?.y ?? 0) - (g2?.y ?? 99))).toBeLessThan(2);
  const stage2 = await page.getByTestId("avatar-stage").boundingBox();
  expect(g1?.x ?? 0).toBeGreaterThan((stage2?.x ?? 0) + (stage2?.width ?? 0) - 1);
  await expectOneScreen(page);
  await page.screenshot({ path: `${SHOTS}/play-landscape-667.png` });

  // 矮的笔记本 1280×720：看 AI 来套话出满 4 招以后（多出一段解说），右边一栏最下面那行说明还在屏幕里
  // （11-13 深度测试：原来这时候它被挤到屏幕外面去了）
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId("open-levels")).toBeHidden();
  await page
    .getByTestId("seal-map")
    .getByRole("button", { name: /让它说自己是真人/ })
    .click();
  await gate(page, 4).click();
  await page.getByRole("button", { name: "看 AI 来套话" }).click();
  await expect(page.getByTestId("watch-note")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId("commentary")).toContainText("第 4 招");
  await expect(page.locator(".play-side-foot")).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel("发给角色的话")).toBeInViewport({ ratio: 1 });
});

test("键盘：Tab 到「跳到输入框」回车就能打字；点现在这一层、这一格不会把这一局清掉", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "只在桌面尺寸上跑一次");
  await open(page);
  // 顶栏后面第一个能停的就是「跳到输入框」（平时在屏幕外，聚焦时才出现）
  await page.evaluate(() => document.body.focus());
  let presses = 0;
  for (; presses < 20; presses++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.classList.contains("play-skip"))) break;
  }
  expect(presses).toBeLessThan(12);
  await expect(page.getByRole("button", { name: "跳到输入框" })).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("发给角色的话")).toBeFocused();
  // 顺着 Tab 走：四层防守、输入框排在右边一栏（关卡和记录）前面
  expect(
    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="发给角色的话"]');
      const map = document.querySelector('[data-testid="seal-map"]');
      return Boolean(input && map && input.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);

  await page.keyboard.type("nihao");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("stage-outcome")).toBeVisible({ timeout: 30_000 });
  const used = page.getByTestId("ink-dots").locator('i[data-used="1"]');
  await expect(used).toHaveCount(1);
  // 点现在就在打的那一层、那一格：什么都不变（原来会把这一局清掉；要重来点「重新开始」）
  await gate(page, 1).click();
  await page.getByTestId("seal-map").locator('.seal-map-cell[data-here="1"]').click();
  await page.waitForTimeout(400);
  await expect(used).toHaveCount(1);
  await expect(page.getByTestId("play-outcome")).toHaveCount(1);
  // 换一层才重新开局
  await gate(page, 2).click();
  await expect(used).toHaveCount(0);
  await expect(page.getByTestId("play-outcome")).toHaveCount(0);
});

test("点「听她说」：开场白的字一直在，声音放完才算念完；开场白接口只念写好的那三句", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "语音只在桌面尺寸上跑");
  // ?avatarTest=1：打开逐帧记录（window.__avatar），下面要看导演层是不是真的从「说」里出来了
  await page.goto("/play?avatarTest=1");
  await expect(page.getByTestId("greeting")).toHaveAttribute("data-done", "1", { timeout: 30_000 });
  const mode = () => page.evaluate(() => window.__avatar?.trace.at(-1)?.mode ?? "");
  const audio = page.waitForResponse((r) => r.url().includes("/api/play/greet") && r.status() === 200, { timeout: 30_000 });
  await page.getByRole("button", { name: "听她说" }).click();
  await audio;
  // 带声音时字直接全显示（真实合成没有逐字的时间）。原来这时候一个字都不出、也永远念不完（11-13 深度测试）
  await expect(page.getByTestId("greeting")).toHaveAttribute("data-voiced", "1");
  await expect(page.getByTestId("greeting-shown")).toContainText("才不会随便告诉你呢");
  await expect(page.getByText("她用声音回答（开着）")).toBeVisible();
  // 声音在放的时候她在「说」（嘴跟着声音动）；放完算念完，她从「说」里出来
  await expect.poll(mode, { timeout: 15_000 }).toBe("speak");
  await expect(page.getByTestId("greeting")).toHaveAttribute("data-done", "1", { timeout: 30_000 });
  await expect.poll(mode, { timeout: 10_000 }).not.toBe("speak");

  const bad = await page.request.get("/api/play/greet?level=nope");
  expect(bad.status()).toBe(404);
  const ok = await page.request.get("/api/play/greet?level=exit");
  expect(ok.status()).toBe(200);
  // 端到端里是模拟发声：不让浏览器留着（真实合成的才留一小时；不然接上真实合成以后听到的还是旧的）
  expect(ok.headers()["cache-control"]).toBe("no-store");
  expect((await ok.body()).byteLength).toBeGreaterThan(1000);
});
