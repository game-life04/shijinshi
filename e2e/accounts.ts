// 端到端测试专用的账号（ADR-032）：只给 playwright.config.ts 里 3101 那台测试服务用。
// 密码和 SESSION_SECRET 随仓库公开，只能用在测试里。线上有两道防线：e2e- 开头的账号不认、以 e2e- 开头的 SESSION_SECRET 也不认
// （除非设了 AUTH_ALLOW_E2E_ACCOUNTS=1，只有测试服务这么设），见 lib/server/auth.ts。
// 仓库里不存哈希：账号记录在加载配置时用 hashPasswordSync 现算，每次的盐都不一样。

import { hashPasswordSync } from "../lib/server/password";

export const E2E_BASE = "http://127.0.0.1:3101";
export const E2E_ACCOUNT = "e2e-judge";
/** 只给测试用的密码，会随仓库公开 */
export const E2E_PASSWORD = "e2e-only-judge-pass-7k3q";
const E2E_SESSION_SECRET = "e2e-only-session-secret-public-in-repo-do-not-deploy";

/** 3101 那台测试服务的环境变量：一个测试账号；登录次数、输错次数的上限放宽，锁定的逻辑在单元测试里测 */
export function e2eAuthEnv(): Record<string, string> {
  return {
    AUTH_ACCOUNTS: `${E2E_ACCOUNT}:${hashPasswordSync(E2E_PASSWORD)}`,
    SESSION_SECRET: E2E_SESSION_SECRET,
    AUTH_ALLOW_E2E_ACCOUNTS: "1",
    RATE_LOGIN_PER_10MIN: "100",
    RATE_LOGIN_FAILS_PER_15MIN: "50",
  };
}
