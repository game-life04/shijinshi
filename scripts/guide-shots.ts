// 「用法」页（/guide，components/Guide.tsx）的六张图：从开着的本机服务里打开每一页，截下要讲的那一块，
// 存成 public/guide/*.webp（16 : 10，960 × 600）。页面改了样子就重跑一次；Guide.tsx 里的字只在那一页做的事变了时才改
// （字里引到的按钮名由 e2e/guide.spec.ts 到各页核对）。
//   先起一台模拟模式、运行数据单独放的服务（不花钱；用法页和每张图上都标着「模拟数据」，运行记录那张图里不能混进真实的运行）：
//     SHIJINSHI_RUNS_SUBDIR=runs-guide-shots LLM_API_KEY= TTS_API_KEY= AUTH_ACCOUNTS= SESSION_SECRET= npx next start -H 127.0.0.1 -p 3600
//   再跑：npx tsx scripts/guide-shots.ts --base http://127.0.0.1:3600 --seed（第一次要 --seed；只重截某几张加 --only workbench,map）
//   --seed：先用接口跑七次冒烟题（只有人设 / 加边界提示 / 再加护栏，再加几种放行方式），运行记录的表格才填得满、攻防地图才有东西可截。
//           只在模拟模式下跑（工作台写着「模拟数据（非真实模型）」）；接了真实模型的服务直接退出，免得花钱。
// 截图用两倍像素，再在浏览器里缩成 960 × 600、编码成 WebP（不另装图片库）。
// 表格只截要讲的几列（用例库：编号、类别、审核、输入、期望；运行记录：A、B、时间、角色、配置），截前把不截的列从页面上拿掉、
// 不让表格挤成一字一行；运行记录最多留七行；原理只截七步的小标题。都只改这一次截图里的页面，不改网站。
// 用例库只截开发集那一段（suites/dev.jsonl，本来就公开）；截图前先把保留集那一段从页面上拿掉，不进图、也不打印。

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const base = arg("--base") ?? "http://127.0.0.1:3600";
const seed = process.argv.includes("--seed");
const only = arg("--only");
const OUT = path.join("public", "guide");
const W = 960;
const H = 600;
const QUALITY = 0.82;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 元素在整页里的位置（不是视口里的） */
async function pageRect(l: Locator): Promise<Rect> {
  await l.scrollIntoViewIfNeeded();
  const r = await l.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left + window.scrollX, y: b.top + window.scrollY, width: b.width, height: b.height };
  });
  await l.page().evaluate(() => window.scrollTo(0, 0));
  return r;
}

/** 几个元素合起来的外框 */
async function union(ls: Locator[]): Promise<Rect> {
  const rs = await Promise.all(ls.map(pageRect));
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  const right = Math.max(...rs.map((r) => r.x + r.width));
  const bottom = Math.max(...rs.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** 从外框左上角起截一块 16 : 10：宽按外框（再加一点边），高按宽算，超出的部分截掉 */
function frame(r: Rect, pad = 0): Rect {
  const width = Math.round(r.width + pad * 2);
  return { x: Math.max(0, Math.round(r.x - pad)), y: Math.max(0, Math.round(r.y - pad)), width, height: Math.round((width * H) / W) };
}

/** 整个外框都要进图：宽高哪边不够 16 : 10 就把哪边放大（多出来的是页面底色） */
function fit(r: Rect, pad = 0): Rect {
  const w = r.width + pad * 2;
  const h = r.height + pad * 2;
  const width = Math.round(Math.max(w, (h * W) / H));
  return { x: Math.max(0, Math.round(r.x - pad)), y: Math.max(0, Math.round(r.y - pad)), width, height: Math.round((width * H) / W) };
}

/** 截下一块，在浏览器里缩到 960 × 600、编成 WebP。页面不够高、不够宽时，按页面底色补齐（不拉伸） */
async function save(page: Page, want: Rect, name: string) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  const clip = { ...want, width: Math.min(want.width, size.width - want.x), height: Math.min(want.height, size.height - want.y) };
  const png = await page.screenshot({ clip, type: "png", fullPage: true, animations: "disabled", caret: "hide" });
  const enc = await page.context().newPage();
  const dataUrl = await enc.evaluate(
    async ({ b64, w, h, q, scale, bg }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      if (!g) throw new Error("没有 2D 画布");
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, img.naturalWidth * scale, img.naturalHeight * scale);
      return c.toDataURL("image/webp", q);
    },
    // 截图是两倍像素：页面上 want.width 宽的一块要缩到 W 宽
    { b64: png.toString("base64"), w: W, h: H, q: QUALITY, scale: W / (want.width * 2), bg: size.bg },
  );
  await enc.close();
  if (!dataUrl.startsWith("data:image/webp")) throw new Error("浏览器没编出 WebP");
  const file = path.join(OUT, `${name}.webp`);
  writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`✓ ${file}  ${Math.round(statSync(file).size / 1024)} KB  （截的是页面上 ${clip.width}×${clip.height} 的一块）`);
}

async function open(browser: Browser, url: string, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "zh-CN", reducedMotion: "reduce", colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(`${base}${url}`, { waitUntil: "load" });
  return page;
}

/** 这几个里先出现的那个（页面改版以后，老的写法认不出来时还有退路） */
async function firstOf(page: Page, ls: Locator[], what: string): Promise<Locator> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const l of ls)
      if (
        await l
          .first()
          .isVisible()
          .catch(() => false)
      )
        return l.first();
    await page.waitForTimeout(250);
  }
  throw new Error(`页面上找不到「${what}」：页面改版了的话，改一下 scripts/guide-shots.ts 里认它的写法`);
}

/** 等 3D 形象加载好、登场演完，再等到某一帧两眼睁着（逐帧记录在 ?avatarTest=1 时挂在 window.__avatar 上） */
async function settleAvatar(page: Page) {
  const ok = await page
    .getByTestId("avatar-status")
    .filter({ hasText: "VRM 3D 形象" })
    .first()
    .waitFor({ timeout: 90_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) console.warn("! 3D 形象 90 秒没加载出来，截的是静态图");
  await page.waitForTimeout(3500);
  await page
    .waitForFunction(
      () => {
        const t = (window as unknown as { __avatar?: { trace: { blink: number }[] } }).__avatar?.trace.at(-1);
        return t === undefined || t.blink < 0.02;
      },
      undefined,
      { timeout: 10_000, polling: 16 },
    )
    .catch(() => {});
}

/** 一页的主体容器：一级标题外面那个居中的容器（各页都是「标题 + 说明 + 内容」包在 mx-auto 的容器里） */
const bodyOf = (page: Page, title: string | RegExp) =>
  page.getByRole("heading", { level: 1, name: title }).locator("xpath=ancestor::div[contains(concat(' ', @class, ' '), ' mx-auto ')][1]");

/** 表头写着这几个字的列，整列从这一次截图的页面上拿掉（表格不再被窄列挤成一字一行） */
async function dropColumns(table: Locator, names: string[]) {
  await table.evaluate((t, names) => {
    const heads = [...t.querySelectorAll("thead th")];
    const idx = heads.map((th, i) => (names.includes((th.textContent ?? "").replace(/\s/g, "")) ? i : -1)).filter((i) => i >= 0);
    for (const row of t.querySelectorAll("tr"))
      for (const i of idx.sort((a, b) => b - a)) (row.children[i] as HTMLElement | undefined)?.style.setProperty("display", "none");
  }, names);
}

/** 某一列的右边（整页坐标）：text = true 时按这一列里最长的那段字算（列本身很宽、字只占一半时，图不留一大块空） */
async function columnRight(table: Locator, name: string, text = false): Promise<number> {
  const right = await table.evaluate(
    (t, { name, text }) => {
      const heads = [...t.querySelectorAll("thead th")];
      const i = heads.findIndex((th) => (th.textContent ?? "").replace(/\s/g, "") === name);
      if (i < 0) return null;
      if (!text) return heads[i].getBoundingClientRect().right + window.scrollX;
      let max = heads[i].getBoundingClientRect().left;
      for (const row of t.querySelectorAll("tbody tr")) {
        const cell = row.children[i];
        if (!cell) continue;
        const range = document.createRange();
        range.selectNodeContents(cell);
        max = Math.max(max, range.getBoundingClientRect().right);
      }
      return max + window.scrollX;
    },
    { name, text },
  );
  if (right === null) throw new Error(`表头里找不到「${name}」：页面改版了的话，改一下 scripts/guide-shots.ts`);
  return right;
}

/** 模拟模式下跑七次冒烟题，给运行记录和攻防地图垫数据。默认放行方式（边审边合成）的三档放在最后，攻防地图取的「最近一次」就是它们 */
async function seedRuns(browser: Browser) {
  const page = await open(browser, "/workbench", { width: 1280, height: 800 });
  const simulated = await page
    .getByText("模拟数据（非真实模型）")
    .first()
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  await page.context().close();
  if (!simulated) throw new Error("这台服务接了真实模型（或者没认出模拟模式）：--seed 只在模拟模式下跑");
  const plan: [variant: string, policy: string][] = [
    ["B2", "S1"],
    ["B2", "S3"],
    ["B1", "S3"],
    ["B0", "S3"],
    ["B0", "S2"],
    ["B1", "S2"],
    ["B2", "S2"],
  ];
  for (const [variant, policy] of plan) {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suite: "smoke", variant, policy, include_drafts: true }),
    });
    if (!res.ok) throw new Error(`新建体检失败：${res.status} ${await res.text()}`);
    const { run_id } = (await res.json()) as { run_id: string };
    for (let i = 0; ; i++) {
      const m = (await (await fetch(`${base}/api/runs/${run_id}`)).json()) as { manifest: { state: string } };
      if (["completed", "failed", "cancelled"].includes(m.manifest.state)) {
        console.log(`✓ 模拟体检 ${variant} · ${policy}：${m.manifest.state}`);
        break;
      }
      if (i > 600) throw new Error(`模拟体检 ${variant} 十分钟还没跑完`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

type Shot = { name: string; take: (browser: Browser) => Promise<void> };

const SHOTS: Shot[] = [
  {
    // 体检工作台：中间「对话」那一栏的上半截（工作台的主角；还没开始时是一段标明「示例」的对话：原话被划掉、盖「拦」）。
    // 图在用法页上大约 480 宽，各张截的宽度都在 470～640：图里的字和页面上的字差不多大
    name: "workbench",
    take: async (browser) => {
      const page = await open(browser, "/workbench", { width: 1280, height: 800 });
      const chat = await firstOf(
        page,
        [
          page.getByTestId("dialog-panel"),
          page.getByTestId("chat-panel"),
          page.locator("section").filter({ has: page.getByRole("heading", { name: "对话", exact: true }) }),
        ],
        "对话",
      );
      await page.waitForTimeout(1000);
      await save(page, frame(await pageRect(chat)), "workbench");
      await page.context().close();
    },
  },
  {
    // 打字闯关：她和她身前的四层防守（电脑版面的左边两栏；屏幕取 1024 × 600，舞台矮一点，她不至于太小）
    name: "play",
    take: async (browser) => {
      const page = await open(browser, "/play?avatarTest=1&avatarSeed=7", { width: 1024, height: 600 });
      await page.locator('[data-testid="greeting"][data-done="1"]').waitFor({ timeout: 30_000 });
      await settleAvatar(page);
      const r = await union([page.getByTestId("avatar-stage"), page.getByTestId("play-gates")]);
      await save(page, frame(r, 6), "play");
      await page.context().close();
    },
  },
  {
    // 用例库：开发集那一段的头几行，只留编号、类别、审核、输入、期望（「方式」「断言」「条款」三列先拿掉）。
    // 保留集那一段先从页面上拿掉（不进图、不打印）
    name: "suites",
    take: async (browser) => {
      const page = await open(browser, "/suites", { width: 1280, height: 900 });
      await firstOf(page, [bodyOf(page, "用例库")], "用例库");
      await page.evaluate(() => {
        for (const s of document.querySelectorAll("section")) if (/heldout/i.test(s.querySelector("h2")?.textContent ?? "")) s.remove();
      });
      const dev = await firstOf(
        page,
        [page.locator("section").filter({ has: page.getByRole("heading", { name: "dev", exact: true }) })],
        "开发集",
      );
      const table = dev.locator("table").first();
      await dropColumns(table, ["方式", "断言", "条款"]);
      // 剩下五列排进 640 宽（整页上表格有 1100 多宽，五列会被拉得很散）
      await table.evaluate((t) => {
        (t as HTMLElement).style.setProperty("width", "640px");
        (t as HTMLElement).style.setProperty("min-width", "0");
      });
      await save(page, frame(await pageRect(table)), "suites");
      await page.context().close();
    },
  },
  {
    // 运行记录：表格和「前后对比」按钮；A、B 各选一次，按钮亮着。右边几列（数据、通过、体检单）截掉，截到配置那几个字为止
    name: "runs",
    take: async (browser) => {
      const page = await open(browser, "/runs", { width: 1280, height: 900 });
      await firstOf(page, [bodyOf(page, "运行记录")], "运行记录");
      const form = await firstOf(page, [page.locator('form[action="/compare"]')], "运行记录的表格");
      // 最多留七行（运行多了按钮会被挤出图外）：多出来的这一次截图里先藏起来
      await form.locator("tbody tr").evaluateAll((rows) => {
        for (const row of rows.slice(7)) (row as HTMLElement).style.setProperty("display", "none");
      });
      const a = page.locator('input[type="radio"][name="a"]');
      const b = page.locator('input[type="radio"][name="b"]');
      if ((await a.count()) >= 2) {
        await a.nth(1).check();
        await b.nth(0).check();
      }
      const r = await pageRect(form);
      const right = await columnRight(form.locator("table").first(), "配置", true);
      await save(page, frame({ ...r, width: right + 14 - r.x }), "runs");
      await page.context().close();
    },
  },
  {
    // 攻防地图：模拟数据、冒烟题、只有人设那一档（有「守」也有「破」）；图例那一行和格子，截到第三种攻法为止
    name: "map",
    take: async (browser) => {
      const page = await open(browser, "/map?suite=smoke&level=simulation&variant=B0&layer=released", { width: 1280, height: 900 });
      const grid = await firstOf(page, [page.getByTestId("attack-map")], "攻防地图的格子");
      const head = page.locator('section[aria-labelledby="atk-map-title"]');
      const box = (await head.count()) ? await pageRect(head.first()) : await pageRect(grid);
      const right = await columnRight(grid.locator("table").first(), "自称开发者");
      await save(page, frame({ ...box, width: right + 10 - box.x }), "map");
      await page.context().close();
    },
  },
  {
    // 原理：只截七步的小标题（① 测试 Agent 出招 …… ⑦ 体检单）；每一步的说明和「在哪里看」这一次截图里先拿掉
    name: "settings",
    take: async (browser) => {
      const page = await open(browser, "/settings", { width: 600, height: 900 });
      const steps = await firstOf(page, [page.getByRole("list", { name: "一次体检的七步" })], "一次体检的七步");
      await steps.evaluate((ol) => {
        for (const li of ol.children) for (const p of [...li.children].slice(1)) (p as HTMLElement).style.setProperty("display", "none");
      });
      await save(page, fit(await pageRect(steps)), "settings");
      await page.context().close();
    },
  },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", args: ["--no-proxy-server"] });
  try {
    if (seed) await seedRuns(browser);
    for (const s of SHOTS) if (!only || only.split(",").includes(s.name)) await s.take(browser);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
