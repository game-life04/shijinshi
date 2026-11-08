import type { Page } from "@playwright/test";

/** 工作台的「实验设置」默认收着（评审 R06）：要改放行策略、最多用例、护栏固定延迟这些，先展开 */
export async function openSettings(page: Page) {
  const toggle = page.getByRole("button", { name: /实验设置/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
