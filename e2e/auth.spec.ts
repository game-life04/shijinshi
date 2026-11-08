import { existsSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { E2E_ACCOUNT, E2E_BASE, E2E_PASSWORD } from "./accounts";

// 账号登录（ADR-032）。3101 那台配了测试账号（e2e/accounts.ts），3100 那台不登录，两台用同一份构建、都是模拟模式。
// 登录页的画面只认这些：「账号」「密码」两个输入框、「登录」按钮和标题、出错时 role=alert 的那一行、提示原文、
// 「琪叶桃是 AI 角色，不是真人」；不认具体样式和图片文件名。
// 截图默认写到 test-results；设 UPDATE_EVIDENCE=1 才更新仓库里的证据截图（docs/evidence）
const SHOTS = process.env.UPDATE_EVIDENCE ? "docs/evidence/screenshots/login" : "test-results/screenshots/login";
const OPEN_BASE = "http://127.0.0.1:3100";
const HAS_MODEL = existsSync("public/models/qiyetao.vrm");
// 想把人骗到外站的跳回地址：规整后是「//evil.example」（11-06 安全复核找到的写法）
const EVIL_NEXT = "/.//evil.example";

async function login(page: Page, account: string, password: string) {
  await page.getByLabel("账号", { exact: true }).fill(account);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

const alertWith = (page: Page, text: string) => page.getByRole("alert").filter({ hasText: text });

test.describe("没配账号的服务器（3100）", () => {
  test.use({ baseURL: OPEN_BASE });

  test("/login 说明不用登录，给出进入工作台的入口，入口只指向本站", async ({ page }) => {
    const res = await page.goto(`/login?next=${encodeURIComponent(EVIL_NEXT)}`);
    // 不许别的网站把页面嵌进去（11-08 安全复核，next.config.ts），没配账号时也一样
    expect(res?.headers()["x-frame-options"]).toBe("DENY");
    expect(res?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
    await expect(page.getByText("这台服务器没有配置账号，不用登录。")).toBeVisible();
    await expect(page.getByRole("link", { name: "进入体检工作台" })).toHaveAttribute("href", "/workbench");
    await expect(page.getByText("琪叶桃是 AI 角色，不是真人")).toBeVisible();
  });
});

test.describe("配了账号的服务器（3101）", () => {
  test.use({ baseURL: E2E_BASE });

  test("没登录：页面跳登录页并记住原地址；接口回 401；模型文件拿不到", async ({ page }) => {
    await page.goto("/workbench");
    await expect(page).toHaveURL(/\/login\?next=%2Fworkbench$/);
    await expect(page.getByRole("heading", { level: 2, name: "登录", exact: true })).toBeVisible();
    await expect(page.getByLabel("账号", { exact: true })).toBeVisible();
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
    await expect(page.getByText("琪叶桃是 AI 角色，不是真人")).toBeVisible();
    // page.request 和页面共用 cookie，这时还没登录
    const api = await page.request.get("/api/status");
    expect(api.status()).toBe(401);
    expect(await api.json()).toMatchObject({ code: "auth_required" });
    const model = await page.request.get("/models/qiyetao.vrm", { maxRedirects: 0 });
    expect(model.status()).toBe(307);
    expect(model.headers().location).toMatch(/^\/login\?next=%2Fmodels%2Fqiyetao\.vrm/);
  });

  test("登录页的背景图登录前就能取到：在构建出的静态文件里，不经过门禁", async ({ page }) => {
    await page.goto("/login");
    const img = page.locator("picture img").first();
    await expect(img).toBeAttached();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.currentSrc), { timeout: 15_000 }).toContain("/_next/static/media/");
    const res = await page.request.get(await img.evaluate((el: HTMLImageElement) => el.currentSrc));
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^image\//);
  });

  test("密码不对、账号不存在，提示一样：「账号或密码不对」", async ({ page }) => {
    await page.goto("/login");
    await login(page, E2E_ACCOUNT, "wrong-password-1");
    await expect(alertWith(page, "账号或密码不对。")).toBeVisible();
    await login(page, "nobody-at-all", "wrong-password-1");
    await expect(alertWith(page, "账号或密码不对。")).toBeVisible();
  });

  test("全角大写的账号名也能登录：回到原来要去的页面，顶栏显示账号和「退出」；cookie 是 HttpOnly、Lax，管 7 天", async ({
    page,
    context,
  }, info) => {
    await page.goto("/workbench");
    await login(page, "Ｅ２Ｅ－ＪＵＤＧＥ", E2E_PASSWORD);
    await expect(page).toHaveURL(/\/workbench$/);
    const banner = page.getByRole("banner");
    await expect(banner.getByText(E2E_ACCOUNT, { exact: true })).toBeVisible();
    await expect(banner.getByRole("button", { name: "退出登录" })).toHaveText("退出");
    const cookie = (await context.cookies()).find((c) => c.name === "fencun_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.secure).toBe(false);
    const hours = ((cookie?.expires ?? 0) * 1000 - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(167);
    expect(hours).toBeLessThanOrEqual(168.1);
    // 登录以后 3D 形象（public 里的模型文件要带 cookie 才拿得到）和体检都照常；只在桌面尺寸上跑一次
    if (info.project.name !== "desktop-1440") return;
    if (HAS_MODEL) await expect(page.getByTestId("avatar-status")).toContainText("VRM 3D 形象", { timeout: 60_000 });
    await expect(page.getByText("模拟数据（非真实模型）")).toBeVisible();
    await page.getByLabel("最多用例").fill("1");
    await page.getByRole("button", { name: "开始体检" }).click();
    await expect(page.getByText("已完成")).toBeVisible({ timeout: 60_000 });
  });

  test("点「退出」：提示已退出，再打开工作台又要登录", async ({ page }) => {
    await page.goto("/login");
    await login(page, E2E_ACCOUNT, E2E_PASSWORD);
    await expect(page).toHaveURL(/\/workbench$/);
    await page.getByRole("banner").getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByText("已退出登录。")).toBeVisible();
    await page.goto("/workbench");
    await expect(page).toHaveURL(/\/login\?next=%2Fworkbench$/);
  });

  test("cookie 被改过：跳回登录页，提示登录已过期", async ({ page, context }) => {
    const name = Buffer.from(E2E_ACCOUNT).toString("base64url");
    const forged = `v1.${name}.${Date.now() + 3_600_000}.${"x".repeat(43)}`;
    await context.addCookies([{ name: "fencun_session", value: forged, url: E2E_BASE }]);
    await page.goto("/workbench");
    await expect(page).toHaveURL(/reason=expired/);
    await expect(page.getByText("登录已过期，请重新登录。")).toBeVisible();
  });

  test("页面开着时会话失效：下一次请求带着原地址跳登录页，提示登录已过期", async ({ page, context }, info) => {
    test.skip(info.project.name !== "desktop-1440", "只在桌面尺寸上跑一次");
    await page.goto("/login?next=%2Fworkbench");
    await login(page, E2E_ACCOUNT, E2E_PASSWORD);
    await expect(page).toHaveURL(/\/workbench$/);
    const start = page.getByRole("button", { name: "开始体检" });
    await expect(start).toBeEnabled();
    // 换了密码、删了账号、cookie 到期，对浏览器来说都一样：手里的会话不再有效（lib/client/session-expired.ts）
    await context.clearCookies();
    await start.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fworkbench&reason=expired$/);
    await expect(page.getByText("登录已过期，请重新登录。")).toBeVisible();
  });

  test("锁定、太频繁的提示照原文显示，分钟数来自跳转地址", async ({ page }) => {
    await page.goto("/login?error=locked&retry=5");
    await expect(alertWith(page, "这个账号连续输错太多次，请 5 分钟后再试。")).toBeVisible();
    await page.goto("/login?error=limit&retry=3");
    await expect(alertWith(page, "试得太频繁了，请 3 分钟后再试。")).toBeVisible();
  });

  test("已登录时打开登录页：写明是谁，「进入体检工作台」只指向本站", async ({ page }) => {
    await page.goto("/login");
    await login(page, E2E_ACCOUNT, E2E_PASSWORD);
    await expect(page).toHaveURL(/\/workbench$/);
    await page.goto(`/login?next=${encodeURIComponent(EVIL_NEXT)}`);
    await expect(page.getByText(`已登录：${E2E_ACCOUNT}。`)).toBeVisible();
    await expect(page.getByRole("link", { name: "进入体检工作台" })).toHaveAttribute("href", "/workbench");
  });

  test("登录页截图（三种尺寸），没有横向滚动条", async ({ page }, info) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 2, name: "登录", exact: true })).toBeVisible();
    await expect
      .poll(
        () =>
          page
            .locator("picture img")
            .first()
            .evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
        { timeout: 15_000 },
      )
      .toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/login-${info.project.name}.png`, fullPage: true });
  });
});
