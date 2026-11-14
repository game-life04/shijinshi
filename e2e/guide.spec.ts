import { expect, type Page, test } from "@playwright/test";
import { LAB, MAIN, MORE, type UiRef } from "../components/guide-content";
import { FATES_PAGE } from "../lib/server/guide";
import { E2E_ACCOUNT, E2E_BASE, E2E_PASSWORD } from "./accounts";

// 用法页和顶栏（ADR-049，队员 B 的建议 4）：顶栏不再放小实验「先审还是先播」（原「三种结局」，从用法页和原理页进），
// 「用法」单独一格、窄屏上也一直看得见；用法页六个页面各一张图、一句话，整张卡都能点；
// 用法页文字里引到的按钮、链接，到各页核对真的还在（谁改了按钮上的字，这里直接报错，用法页跟着改）；
// 配了账号的服务器上，这个浏览器第一次登录先到用法页，一下就能接着去原来要去的页面，以后再登录不再出现。
// 截图默认写到 test-results；设 UPDATE_EVIDENCE=1 才更新仓库里的证据截图（docs/evidence）
const SHOTS = process.env.UPDATE_EVIDENCE ? "docs/evidence/screenshots/guide" : "test-results/screenshots/guide";
const PAGES = [...MAIN, ...MORE];
const NAMES = [...PAGES, LAB].map((m) => m.name);

/** 六张图都取到了（配了账号时 public 里的文件要带着登录的 cookie 才取得到） */
async function imagesLoaded(page: Page) {
  const imgs = page.getByTestId("guide-module").locator("img");
  await expect(imgs).toHaveCount(PAGES.length);
  for (const img of await imgs.all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  }
}

async function login(page: Page) {
  await page.getByLabel("账号", { exact: true }).fill(E2E_ACCOUNT);
  await page.getByLabel("密码", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

/** 按钮、链接上的字是这几个字开头（「一键演示（约一分钟）」也算「一键演示」） */
const startsWith = (name: string) => new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const findUi = (page: Page, u: UiRef) => page.getByRole(u.role, { name: startsWith(u.name) }).first();

test.describe("顶栏和用法页（3100，没配账号）", () => {
  test("顶栏没有小实验；「用法」一直看得见，点进去每页一张图、一句话，下面给开始体检、去闯关", async ({ page }, info) => {
    await page.goto("/workbench");
    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav.getByRole("link", { name: "体检工作台" })).toBeVisible();
    await expect(nav.getByRole("link", { name: LAB.name })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "三种结局" })).toHaveCount(0);
    // 窄屏上导航左右滑，「用法」钉在这一行右头，不用滑就整个看得见
    const guide = nav.getByRole("link", { name: "用法" });
    await expect(guide).toBeInViewport({ ratio: 1 });
    // 看得出还能滑（ADR-049 深度测试）：手机上哪一头还有被挡住的页面，哪一头画「‹」「›」；大屏上放得下，没有箭头
    const more = (side: "left" | "right") => nav.locator(`.app-nav-more[data-side="${side}"]`);
    if (info.project.name === "phone-390") {
      const scroller = nav.locator(".app-nav");
      const edge = async (side: "left" | "right") => {
        const b = await scroller.boundingBox();
        if (!b) throw new Error("导航不在页面上");
        // 箭头那一小块宽 28（1.75rem）：点在里面离边 20 的地方（离边 12 正好压在第一项的左边线上）
        return { x: side === "left" ? b.x + 20 : b.x + b.width - 20, y: b.y + b.height / 2 };
      };
      const tapEdge = async (side: "left" | "right") => {
        const at = await edge(side);
        await page.touchscreen.tap(at.x, at.y);
      };
      const scrollLeft = () => scroller.evaluate((el) => Math.round(el.scrollLeft));
      // 先等脚本跑起来、量过导航（服务端先画出来的「›」在脚本跑起来以前点了不翻页）
      const measured = nav.locator(".app-nav-scroller[data-measured]");
      await expect(measured).toHaveCount(1);
      await expect(more("right")).toBeVisible();
      await expect(more("left")).toHaveCount(0);
      // 箭头只是画上去的记号：手指从「›」上开始往左拖，划的还是底下的导航（原来箭头是盖在上面的按钮，从它上面拖不动）
      const cdp = await page.context().newCDPSession(page);
      const from = await edge("right");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x - i * 15, y: from.y }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(scrollLeft).toBeGreaterThan(60);
      await expect(page).toHaveURL(/\/workbench$/);
      await scroller.evaluate((el) => {
        el.scrollLeft = 0;
      });
      await expect(more("left")).toHaveCount(0);
      // 点「›」那一小块：按项翻到头，左头出「‹」、「原理」整个露出来、「›」收掉
      for (let i = 0; i < 6 && (await more("right").count()); i++) {
        await tapEdge("right");
        await page.waitForTimeout(450);
      }
      await expect(more("right")).toHaveCount(0);
      await expect(more("left")).toBeVisible();
      await expect(nav.getByRole("link", { name: "原理" })).toBeInViewport({ ratio: 1 });
      // 在「原理」页连点「‹」：滑到头以后那一小块底下是「体检工作台」，接着点不会点进去；停一会儿再点才进
      await page.goto("/settings");
      await expect(measured).toHaveCount(1);
      await expect(more("left")).toBeVisible();
      for (let i = 0; i < 8; i++) {
        await tapEdge("left");
        await page.waitForTimeout(200);
      }
      await expect(page).toHaveURL(/\/settings$/);
      await expect.poll(scrollLeft).toBe(0);
      await expect(more("left")).toHaveCount(0);
      // 挡点击的那一会儿（1.2 秒，挡着时点了会续上）过了以后，点第一项的图标照常进
      await page.waitForTimeout(1800);
      await tapEdge("left");
      await expect(page).toHaveURL(/\/workbench$/);
      await expect(nav.getByRole("link", { name: "体检工作台" })).toHaveAttribute("aria-current", "page");
    } else {
      await expect(nav.locator(".app-nav-more")).toHaveCount(0);
    }
    await guide.click();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(page.getByRole("heading", { level: 1, name: "用法" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "用法" })).toHaveAttribute("aria-current", "page");
    for (const name of NAMES) await expect(page.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
    // 图上标着模拟数据（和站里别处一个说法）
    await expect(page.getByText("模拟数据（非真实模型）").first()).toBeVisible();
    // 每张卡键盘上只停一次：只有一个「打开……」链接
    const cards = page.getByTestId("guide-module");
    await expect(cards).toHaveCount(NAMES.length);
    for (const card of await cards.all()) await expect(card.getByRole("link")).toHaveCount(1);
    await expect(page.getByRole("link", { name: `打开${LAB.name}` })).toHaveAttribute("href", FATES_PAGE.href);
    // 从顶栏进来的没有「知道了」按钮
    await expect(page.getByTestId("guide-continue")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "开始体检" }).first()).toHaveAttribute("href", "/workbench");
    await expect(page.getByRole("link", { name: "去闯关" }).first()).toHaveAttribute("href", "/play");
    await imagesLoaded(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/guide-${info.project.name}.png`, fullPage: true });
    // 点图也能进（不只是「打开」那两个小字）：「打开」的点击区铺满整张卡、盖在图上，所以按图的位置点，不直接点 img
    const img = page.locator('[data-testid="guide-module"][data-href="/map"] img');
    await img.scrollIntoViewIfNeeded();
    const box = await img.boundingBox();
    expect(box).not.toBeNull();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page).toHaveURL(/\/map$/);
  });

  test("原理页里能进小实验，小实验页的标题就是用法页上那个名字", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("link", { name: FATES_PAGE.name, exact: true }).click();
    await expect(page).toHaveURL(/\/fates$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(FATES_PAGE.name);
  });

  test("用法页上引到的按钮、链接，各页上真的都有", async ({ page }, info) => {
    test.skip(info.project.name === "laptop-1280", "桌面和手机上各查一次");
    test.setTimeout(120_000);
    // 运行记录、攻防地图要有一次跑完的体检才有表格和按钮：用接口跑一次模拟体检（两道冒烟题）
    const created = await page.request.post("/api/runs", {
      data: { suite: "smoke", variant: "B2", policy: "S2", include_drafts: true, case_ids: ["SMOKE_CANARY_001", "SMOKE_IDENTITY_001"] },
    });
    expect(created.ok()).toBe(true);
    const { run_id } = (await created.json()) as { run_id: string };
    await expect
      .poll(
        async () => ((await (await page.request.get(`/api/runs/${run_id}`)).json()) as { manifest: { state: string } }).manifest.state,
        {
          timeout: 60_000,
        },
      )
      .toBe("completed");
    for (const m of PAGES) {
      if (!m.ui.length) continue;
      await page.goto(m.href);
      for (const u of m.ui) await expect(findUi(page, u), `${m.name}：「${u.name}」`).toBeVisible({ timeout: 15_000 });
    }
  });
});

test.describe("第一次登录先看用法（3101，配了测试账号）", () => {
  test.use({ baseURL: E2E_BASE });

  test("第一次登录先到用法页，一下就接着去原来要去的页面；退出再登录，直接回原地址", async ({ page, context }, info) => {
    await page.goto("/play");
    await expect(page).toHaveURL(/\/login\?next=%2Fplay$/);
    await login(page);
    await expect(page).toHaveURL(/\/guide\?next=%2Fplay$/);
    await expect(page.getByRole("heading", { level: 1, name: "用法" })).toBeVisible();
    // 不用往下翻就看得到「知道了」，一下就去原来要去的页面
    const go = page.getByTestId("guide-continue");
    await expect(go).toHaveText("知道了，去打字闯关");
    await expect(go).toBeInViewport({ ratio: 1 });
    const mark = (await context.cookies()).find((c) => c.name === "fencun_guide");
    expect(mark?.httpOnly).toBe(true);
    expect(mark?.sameSite).toBe("Lax");
    await imagesLoaded(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/guide-first-login-${info.project.name}.png` });
    await go.click();
    await expect(page).toHaveURL(/\/play$/);

    // 退出再登录：这个浏览器看过用法页了，直接回原地址
    await page.getByRole("banner").getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByText("已退出登录。")).toBeVisible();
    await page.goto("/map");
    await expect(page).toHaveURL(/\/login\?next=%2Fmap$/);
    await login(page);
    await expect(page).toHaveURL(/\/map$/);
  });

  test("用法页地址里的 next 只认本站路径：指向外站的，「知道了」回工作台", async ({ page, context }) => {
    await context.addCookies([{ name: "fencun_guide", value: "1", url: E2E_BASE }]);
    await page.goto("/login");
    await login(page);
    await expect(page).toHaveURL(/\/workbench$/);
    await page.goto(`/guide?next=${encodeURIComponent("/.//evil.example")}`);
    await expect(page.getByTestId("guide-continue")).toHaveAttribute("href", "/workbench");
    await expect(page.getByTestId("guide-continue")).toHaveText("知道了，去体检工作台");
  });
});
