import { defineConfig } from "@playwright/test";

// 端到端测试：用本机已装的 Edge（channel: msedge），不额外下载浏览器。
// 三种屏幕尺寸按规格 01 §2.4：1440×900、1280×720、390×844。
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3100", channel: "msedge", locale: "zh-CN" },
  projects: [
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "laptop-1280", use: { viewport: { width: 1280, height: 720 } } },
    { name: "phone-390", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    // 测试固定走模拟模式，不调用真实模型
    command: "npx next start -p 3100",
    url: "http://127.0.0.1:3100/workbench",
    reuseExistingServer: false,
    timeout: 120_000,
    // 运行数据写到 data/runs-e2e，不进平时的「运行记录」
    env: { LLM_API_KEY: "", SHIJINSHI_RUNS_SUBDIR: "runs-e2e" },
  },
});
