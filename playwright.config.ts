import { defineConfig } from "@playwright/test";
import { e2eAuthEnv } from "./e2e/accounts";

// 端到端测试：用本机已装的 Edge（channel: msedge），不额外下载浏览器。
// 三种屏幕尺寸按规格 01 §2.4：1440×900、1280×720、390×844。
// 同一份构建起两台服务（ADR-032）：3100 不登录（原有的测试都在这台），3101 配了测试账号（e2e/accounts.ts、e2e/auth.spec.ts）。
// 两台一起跑，正好能抓住「构建时把没登录写死进静态页」的坑（lib/server/session.ts）。
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
  webServer: [
    {
      // 测试固定走模拟模式，不调用真实模型
      command: "npx next start -p 3100",
      url: "http://127.0.0.1:3100/workbench",
      reuseExistingServer: false,
      timeout: 120_000,
      // 运行数据写到 data/runs-e2e，不进平时的「运行记录」。账号相关的三个变量显式设成空，
      // 免得开发机 .env.local 里的配置把这台变成要登录（真实环境里设成空串，Next 就不再读 .env.local 里的同名值）
      env: { LLM_API_KEY: "", SHIJINSHI_RUNS_SUBDIR: "runs-e2e", AUTH_ACCOUNTS: "", SESSION_SECRET: "", ACCESS_CODE: "" },
    },
    {
      // 配了测试账号的那台：只在本机监听，运行数据写到 data/runs-e2e-auth
      command: "npx next start -H 127.0.0.1 -p 3101",
      url: "http://127.0.0.1:3101/login",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { LLM_API_KEY: "", SHIJINSHI_RUNS_SUBDIR: "runs-e2e-auth", ACCESS_CODE: "", ...e2eAuthEnv() },
    },
  ],
});
