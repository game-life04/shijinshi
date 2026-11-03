import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE,
  clientKey,
  codeMatches,
  issueAccess,
  rateLimit,
  resetRateLimits,
  safeNext,
  verifyAccess,
} from "@/lib/server/access";
import { config, proxy } from "@/proxy";

// 上线演示的门禁和限流（ADR-028）。环境变量每个用例前清空、用完复原，不影响别的测试。
const KEYS = [
  "ACCESS_CODE",
  "ACCESS_TTL_HOURS",
  "RATE_LIMIT",
  "RATE_RUNS_PER_HOUR",
  "RATE_RUNS_PER_DAY",
  "RATE_LOGIN_PER_10MIN",
  "CLIENT_IP_HEADER",
];
let saved: Record<string, string | undefined> = {};
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

const req = (ip = "1.2.3.4", headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3000/api/runs", { method: "POST", headers: { "x-forwarded-for": ip, ...headers } });

describe("访问码与登录 cookie", () => {
  it("签名 cookie：原样的能过；改过签名、改过到期时间、过期、换了访问码的都不行", () => {
    const now = Date.UTC(2026, 10, 3);
    const { value } = issueAccess("secret-code", now);
    const [exp, sig] = value.split(".");
    expect(verifyAccess("secret-code", value, now + 1000)).toBe(true);
    expect(verifyAccess("other-code", value, now + 1000)).toBe(false);
    expect(verifyAccess("secret-code", `${value}x`, now)).toBe(false);
    expect(verifyAccess("secret-code", `${Number(exp) + 1000}.${sig}`, now)).toBe(false);
    expect(verifyAccess("secret-code", value, Number(exp) + 1)).toBe(false);
    expect(verifyAccess("secret-code", "garbage", now)).toBe(false);
    expect(verifyAccess("secret-code", undefined, now)).toBe(false);
    expect(verifyAccess("", value, now)).toBe(false);
  });

  it("核对访问码", () => {
    expect(codeMatches("abc12345", "abc12345")).toBe(true);
    expect(codeMatches("abc12345", "abc1234")).toBe(false);
    expect(codeMatches("", "")).toBe(false);
  });

  it("登录后只跳回本站路径", () => {
    expect(safeNext("/workbench?x=1")).toBe("/workbench?x=1");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

describe("门禁（proxy.ts）", () => {
  it("没设访问码时什么都不拦", () => {
    expect(proxy(new NextRequest("http://127.0.0.1:3000/workbench")).headers.get("x-middleware-next")).toBe("1");
  });

  it("设了访问码：没登录时接口回 401、页面跳登录页并记住原地址；带有效 cookie 放行", () => {
    process.env.ACCESS_CODE = "secret-code";
    expect(proxy(new NextRequest("http://127.0.0.1:3000/api/runs")).status).toBe(401);
    const page = proxy(new NextRequest("http://127.0.0.1:3000/workbench?tab=1"));
    expect(page.status).toBe(307);
    const to = new URL(page.headers.get("location") ?? "");
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/workbench?tab=1");
    const cookie = `${ACCESS_COOKIE}=${issueAccess("secret-code").value}`;
    const model = proxy(new NextRequest("http://127.0.0.1:3000/models/qiyetao.vrm", { headers: { cookie } }));
    expect(model.headers.get("x-middleware-next")).toBe("1");
  });

  it("登录页、登录接口、构建出的静态文件不经过门禁；模型文件和其他接口要经过", () => {
    const inner = config.matcher[0].slice(1);
    const re = new RegExp(`^/${inner}$`);
    for (const p of ["/login", "/api/login", "/_next/static/chunks/a.js", "/favicon.ico"]) expect(re.test(p)).toBe(false);
    for (const p of ["/", "/workbench", "/api/runs", "/models/qiyetao.vrm", "/audio/playback-core.js"]) expect(re.test(p)).toBe(true);
  });
});

describe("限流", () => {
  it("没设访问码也没开限流时不拦", () => {
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
    expect(((await r?.json()) as { error: string }).error).toContain("每小时最多 2 次");
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

  it("设了访问码默认开限流，RATE_LIMIT=0 可以关；登录尝试只要有访问码就一直限", () => {
    process.env.ACCESS_CODE = "secret-code";
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

  it("认来源：默认取 x-forwarded-for 的最后一个；可以改成 nginx 写的 x-real-ip", () => {
    expect(clientKey(req("9.9.9.9, 1.2.3.4"))).toBe("1.2.3.4");
    process.env.CLIENT_IP_HEADER = "x-real-ip";
    expect(clientKey(req("9.9.9.9", { "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientKey(new Request("http://127.0.0.1/"))).toBe("unknown");
  });
});
