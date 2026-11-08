import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as playPost } from "@/app/api/play/route";
import { POST as runsPost } from "@/app/api/runs/route";
import { clientKey, rateLimit, rateRules, resetRateLimits, safeNext } from "@/lib/server/access";
import { issueSession, requireSession, SESSION_COOKIE } from "@/lib/server/auth";
import { hashPasswordSync } from "@/lib/server/password";

// 上线演示的限流（ADR-028；11-06 门禁换成账号登录后按账号计，ADR-032）。登录、会话本身的测试在 auth.test.ts。
// 环境变量每个用例前清空、用完复原，不影响别的测试；账号记录在运行时现算。
const KEYS = [
  "AUTH_ACCOUNTS",
  "SESSION_SECRET",
  "SESSION_TTL_HOURS",
  "AUTH_ALLOW_E2E_ACCOUNTS",
  "ACCESS_CODE",
  "ACCESS_TTL_HOURS",
  "RATE_LIMIT",
  "RATE_RUNS_PER_HOUR",
  "RATE_RUNS_PER_DAY",
  "RATE_PLAY_STARTS_PER_HOUR",
  "RATE_PLAY_TURNS_PER_HOUR",
  "RATE_PLAY_TURNS_PER_DAY",
  "RATE_LOGIN_PER_10MIN",
  "RATE_LOGIN_FAILS_PER_15MIN",
  "CLIENT_IP_HEADER",
  "LLM_API_KEY",
  "TTS_API_KEY",
];
let saved: Record<string, string | undefined> = {};
let ACCOUNTS = "";
beforeAll(() => {
  // 「unknown」也是个合格的账号名：用来确认它和认不出来源的请求不会算到一起
  ACCOUNTS = ["judge-01", "team.b", "unknown"].map((name) => `${name}:${hashPasswordSync(`${name}-pass-for-tests`)}`).join(",");
});
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetRateLimits();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRateLimits();
});

function useAccounts() {
  process.env.AUTH_ACCOUNTS = ACCOUNTS;
  process.env.SESSION_SECRET = "s".repeat(40);
}
const sessionOf = (account: string) => `${SESSION_COOKIE}=${issueSession(account).value}`;

const req = (ip = "1.2.3.4", headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3000/api/runs", { method: "POST", headers: { "x-forwarded-for": ip, ...headers } });
const message = async (r: Response | null) => ((await r?.json()) as { error: string }).error;

describe("登录后跳回的地址", () => {
  it("只跳回本站路径，别的一律回工作台；规整以后变成「//别的网站」的写法也不行", () => {
    expect(safeNext("/workbench?x=1")).toBe("/workbench?x=1");
    expect(safeNext("/reports/abc?x=1#h")).toBe("/reports/abc?x=1#h");
    expect(safeNext("/play#level")).toBe("/play#level");
    // 11-06 安全复核找到的 6 种：只比 origin 时都会变成 //evil.example，浏览器当成外站
    const tricks = [
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/./\\evil.example",
      "/.\\/evil.example",
      "/x/..//evil.example/p?q=1",
    ];
    for (const next of [
      ...tricks,
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "evil.example",
      undefined,
      42,
      `/${"x".repeat(512)}`,
    ]) {
      expect(safeNext(next), String(next)).toBe("/workbench");
    }
  });

  it("登录页、接口、首页本身不当跳回的目标，改回工作台", () => {
    for (const next of ["/", "/login", "/login?next=/x", "/./login", "/api", "/api/status", "/api/runs?x=1"])
      expect(safeNext(next), next).toBe("/workbench");
  });
});

describe("限流", () => {
  it("没配账号也没开限流时不拦", () => {
    for (let i = 0; i < 30; i++) expect(rateLimit(req(), "run")).toBeNull();
  });

  it("同一来源每小时有上限；换个来源、到下一个小时重新算", async () => {
    process.env.RATE_LIMIT = "1";
    process.env.RATE_RUNS_PER_HOUR = "2";
    const t = Date.UTC(2026, 10, 3, 2, 10);
    expect(rateLimit(req("1.1.1.1"), "run", t)).toBeNull();
    expect(rateLimit(req("1.1.1.1"), "run", t)).toBeNull();
    const r = rateLimit(req("1.1.1.1"), "run", t);
    expect(r?.status).toBe(429);
    expect(r?.headers.get("retry-after")).toBe(String(50 * 60));
    expect(await message(r)).toContain("每小时最多 2 次");
    expect(rateLimit(req("2.2.2.2"), "run", t)).toBeNull();
    expect(rateLimit(req("1.1.1.1"), "run", t + 50 * 60_000)).toBeNull();
  });

  it("全站每天的上限按北京时间零点清零；被拒的请求不占额度", () => {
    process.env.RATE_LIMIT = "1";
    process.env.RATE_RUNS_PER_DAY = "3";
    const t = Date.UTC(2026, 10, 3, 15, 0); // 北京时间 11-03 23:00
    for (const ip of ["a", "b", "c"]) expect(rateLimit(req(ip), "run", t)).toBeNull();
    const r = rateLimit(req("d"), "run", t);
    expect(r?.status).toBe(429);
    expect(r?.headers.get("retry-after")).toBe("3600");
    expect(rateLimit(req("d"), "run", t + 3_600_000)).toBeNull();
  });

  it("配了账号默认开限流，RATE_LIMIT=0 可以关；登录尝试只要要登录就一直限", () => {
    useAccounts();
    process.env.RATE_RUNS_PER_HOUR = "1";
    process.env.RATE_LOGIN_PER_10MIN = "1";
    const t = Date.UTC(2026, 10, 3, 2, 0);
    expect(rateLimit(req(), "run", t)).toBeNull();
    expect(rateLimit(req(), "run", t)?.status).toBe(429);
    process.env.RATE_LIMIT = "0";
    expect(rateLimit(req(), "run", t)).toBeNull();
    expect(rateLimit(req(), "login", t)).toBeNull();
    expect(rateLimit(req(), "login", t)?.status).toBe(429);
  });

  it("登录后按账号算：同一个账号换了来源也共用额度；同一个出口后面的两个账号各算各的", async () => {
    useAccounts();
    process.env.RATE_RUNS_PER_HOUR = "1";
    const t = Date.UTC(2026, 10, 6, 2, 0);
    const judge = sessionOf("judge-01");
    expect(rateLimit(req("1.1.1.1", { cookie: judge }), "run", t)).toBeNull();
    const again = rateLimit(req("2.2.2.2", { cookie: judge }), "run", t);
    expect(again?.status).toBe(429);
    expect(await message(again)).toContain("同一账号每小时最多 1 次");
    expect(rateLimit(req("1.1.1.1", { cookie: sessionOf("team.b") }), "run", t)).toBeNull();
    // 闯关的两项也一样按账号
    process.env.RATE_PLAY_TURNS_PER_HOUR = "1";
    expect(rateLimit(req("1.1.1.1", { cookie: judge }), "play_say", t)).toBeNull();
    expect(rateLimit(req("2.2.2.2", { cookie: judge }), "play_say", t)?.status).toBe(429);
  });

  it("没配账号、用 RATE_LIMIT=1 硬开时按来源算，提示写「同一来源」", async () => {
    process.env.RATE_LIMIT = "1";
    process.env.RATE_PLAY_STARTS_PER_HOUR = "1";
    const t = Date.UTC(2026, 10, 6, 2, 0);
    expect(rateLimit(req("1.1.1.1"), "play_start", t)).toBeNull();
    expect(await message(rateLimit(req("1.1.1.1"), "play_start", t))).toContain("同一来源每小时最多 1 次");
  });

  it("计数对象分账号和来源：叫 unknown 的账号和认不出来源的请求不会算到一起", () => {
    useAccounts();
    process.env.RATE_RUNS_PER_HOUR = "1";
    const t = Date.UTC(2026, 10, 6, 2, 0);
    const url = "http://127.0.0.1:3000/api/runs";
    expect(rateLimit(new Request(url, { method: "POST", headers: { cookie: sessionOf("unknown") } }), "run", t)).toBeNull();
    expect(rateLimit(new Request(url, { method: "POST" }), "run", t)).toBeNull();
    expect(rateLimit(new Request(url, { method: "POST" }), "run", t)?.status).toBe(429);
  });

  it("认来源：默认取 x-forwarded-for 的最后一个；可以改成 nginx 写的 x-real-ip", () => {
    expect(clientKey(req("9.9.9.9, 1.2.3.4"))).toBe("1.2.3.4");
    process.env.CLIENT_IP_HEADER = "x-real-ip";
    expect(clientKey(req("9.9.9.9", { "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientKey(new Request("http://127.0.0.1/"))).toBe("unknown");
  });

  it("输错的上限默认大于一个来源 15 分钟内最多能试的次数：一个 IP 锁不住别人的账号", () => {
    const r = rateRules();
    expect(r.login_fail.perClient).toBe(30);
    expect(r.login_fail.perClient).toBeGreaterThan(2 * r.login.perClient);
  });
});

describe("接口和页面自己再核一次会话（proxy 之外的兜底）", () => {
  it("除了登录、退出，app/api 下每个接口函数开头都核会话；页面外框 AppShell 也核", () => {
    const files = readdirSync("app/api", { recursive: true })
      .map(String)
      .filter((f) => f.endsWith("route.ts"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const rel = f.replaceAll("\\", "/");
      if (rel === "login/route.ts" || rel === "logout/route.ts") continue;
      const src = readFileSync(path.join("app/api", f), "utf8");
      const handlers = src.match(/export (?:async )?function (?:GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
      expect(handlers.length, rel).toBeGreaterThan(0);
      expect((src.match(/const denied = requireSession\(req\);\n {2}if \(denied\) return denied;/g) ?? []).length, rel).toBe(
        handlers.length,
      );
    }
    const shell = readFileSync("components/AppShell.tsx", "utf8");
    expect(shell).toContain('redirect("/login")');
    expect(shell).toContain('redirect("/login?error=config")');
  });

  it("模型文件不能静态引入：那样它会进 /_next/static，登录前谁都能下载", () => {
    for (const dir of ["app", "components", "lib"]) {
      for (const f of readdirSync(dir, { recursive: true }).map(String)) {
        if (!/\.(?:ts|tsx|mts|js|mjs)$/.test(f)) continue;
        expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/(?:from\s*|import\s*\(\s*)["'][^"']+\.vrm["']/);
      }
    }
  });

  it("requireSession：没配账号放行；配置有问题回 503；没有有效会话回 401，有就放行", async () => {
    expect(requireSession(req())).toBeNull();
    process.env.ACCESS_CODE = "old-access-code";
    const broken = requireSession(req());
    expect(broken?.status).toBe(503);
    expect(await broken?.json()).toEqual({ error: "服务器的登录设置有问题，暂时用不了", code: "auth_config" });
    delete process.env.ACCESS_CODE;
    useAccounts();
    const denied = requireSession(req());
    expect(denied?.status).toBe(401);
    expect(await denied?.json()).toEqual({ error: "需要先登录：请打开 /login", code: "auth_required" });
    expect(requireSession(req("1.2.3.4", { cookie: `${SESSION_COOKIE}=v1.eA.1.x` }))?.status).toBe(401);
    expect(requireSession(req("1.2.3.4", { cookie: sessionOf("judge-01") }))).toBeNull();
  });

  it("没配账号却接了真实模型（模型或语音合成的密钥有值）：不是从本机打开的回 503", () => {
    for (const key of ["LLM_API_KEY", "TTS_API_KEY"]) {
      for (const k of KEYS) delete process.env[k];
      process.env[key] = "sk-test-only";
      expect(requireSession(req("1.2.3.4", { host: "demo.example" }))?.status, key).toBe(503);
      expect(requireSession(req("1.2.3.4", { host: "127.0.0.1:3000" })), key).toBeNull();
      expect(requireSession(req("1.2.3.4", { host: "localhost:3000" })), key).toBeNull();
    }
  });

  it("新建体检、闯关：没登录回 401；登录了照常往下走（这里故意传错参数，回 400，不会真的开始）", async () => {
    useAccounts();
    const post = (url: string, body: unknown, cookie?: string) =>
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    const runs = "http://127.0.0.1:3000/api/runs";
    const play = "http://127.0.0.1:3000/api/play";
    expect((await runsPost(post(runs, { variant: "nope" }))).status).toBe(401);
    expect((await playPost(post(play, { action: "nope" }))).status).toBe(401);
    expect((await runsPost(post(runs, { variant: "nope" }, sessionOf("judge-01")))).status).toBe(400);
    expect((await playPost(post(play, { action: "nope" }, sessionOf("judge-01")))).status).toBe(400);
  });
});
