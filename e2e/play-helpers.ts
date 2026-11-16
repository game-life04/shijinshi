import { expect, type Page } from "@playwright/test";

// 闯关页的测试小工具（ADR-047）。手机版面（宽不到 768，或者高不到 520）上「选关卡」「记录」收在从底下拉出来的面板里，
// 要点里面的东西得先把面板拉出来；平板、大屏上它们一直摆在旁边，这里什么都不用做。

/**
 * 页面换上来了：切页、打开页面时先出「正在打开」的占位（ADR-051，app/play/loading.tsx），真页面随后换上来（React 会把换上来的那一下
 * 攒一攒，最多晚几百毫秒）。下面两个小工具都要先看「是不是手机版面」，看早了会把占位当成页面，所以先等占位没了、闯关版面出来
 */
async function ready(page: Page) {
  await expect(page.getByTestId("page-loading")).toHaveCount(0);
  await page.locator(".play-grid").waitFor();
}

/** 把面板拉出来（已经开着就不动，开着另一个就先收起）。返回是不是手机版面 */
export async function openPanel(page: Page, which: "levels" | "log"): Promise<boolean> {
  await ready(page);
  const chip = page.getByTestId(which === "log" ? "open-log" : "open-levels");
  if (!(await chip.isVisible())) return false;
  const open = await page.locator(".play-grid").getAttribute("data-sheet");
  if (open === which) return true;
  if (open) await closePanel(page);
  await chip.click();
  await expect(page.locator(`.play-grid[data-sheet="${which}"]`)).toHaveCount(1);
  // 面板是滑上来的：等它停稳再点里面的东西
  await page.waitForTimeout(320);
  return true;
}

export async function closePanel(page: Page) {
  if (!(await page.locator(".play-grid[data-sheet]").count())) return;
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(page.locator(".play-grid[data-sheet]")).toHaveCount(0);
  await page.waitForTimeout(320);
}

/** 四层防守里的第 n 条（手机上关卡条的名字里也有「第 n 层」，所以限定在四层防守里找） */
export const gate = (page: Page, n: 1 | 2 | 3 | 4) =>
  page.getByTestId("play-gates").getByRole("button", { name: new RegExp(`第 ${n} 层`) });

/** 印谱地图上的关卡名（点一下换关）。手机上先把关卡面板拉出来；选完面板自己收起 */
export async function pickLevel(page: Page, title: RegExp) {
  await openPanel(page, "levels");
  await page.getByTestId("seal-map").getByRole("button", { name: title }).click();
}

/** 现在打的是哪一关：大屏上看右边一栏的标题，手机上看关卡条 */
export async function expectLevel(page: Page, title: string) {
  await ready(page);
  if (await page.getByTestId("open-levels").isVisible()) await expect(page.getByTestId("open-levels")).toContainText(title);
  else await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

/** 「故意出错」：ADR-053 起在输入框下面那一行里，手机上也一直看得见（面板开着时台上点不到，先收起）；勾完重新开局 */
export async function setFault(page: Page, on: boolean) {
  await ready(page);
  await closePanel(page);
  const box = page.getByLabel(/故意出错/);
  if (on) await box.check();
  else await box.uncheck();
}

/**
 * 整页正好一屏：不用上下划、左右划，也没有被裁掉的内容。
 * 闯关页整页一屏高（ADR-047），放不下的内容是在页面主体（main）里滚或者被裁，整个文档永远不滚，所以两处都要量；容 1 像素的小数误差。
 */
export async function expectOneScreen(page: Page) {
  const over = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main");
    return {
      文档左右: doc.scrollWidth - window.innerWidth,
      文档上下: doc.scrollHeight - window.innerHeight,
      主体左右: main ? main.scrollWidth - main.clientWidth : 0,
      主体上下: main ? main.scrollHeight - main.clientHeight : 0,
    };
  });
  for (const [where, px] of Object.entries(over)) expect(px, `${where}多出来的像素`).toBeLessThanOrEqual(1);
}
