import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/login/route";
import * as logoutRoute from "@/app/api/logout/route";
import { e2eAuthEnv } from "@/e2e/accounts";
import { resetRateLimits } from "@/lib/server/access";
import {
  authConfig,
  clearSessionCookie,
  isHttps,
  issueSession,
  normalizeAccount,
  parseAccounts,
  SESSION_COOKIE,
  sessionCookie,
  sessionFromRequest,
  verifySession,
} from "@/lib/server/auth";
import { GUIDE_COOKIE } from "@/lib/server/guide";
import { BusyError, hashPassword, hashPasswordSync, normalizePassword, parseRecord, verifyPassword } from "@/lib/server/password";
import { proxy, config as proxyConfig } from "@/proxy";

// 账号登录（ADR-032）。环境变量每个用例前清空、用完复原；账号记录和密钥都在运行时现算，仓库里不存。
const KEYS = [
  "AUTH_ACCOUNTS",
  "SESSION_SECRET",
  "ACCESS_CODE",
  "SESSION_TTL_HOURS",
  "ACCESS_TTL_HOURS",
  "AUTH_ALLOW_E2E_ACCOUNTS",
  "RATE_LIMIT",
  "RATE_LOGIN_PER_10MIN",
  "RATE_LOGIN_FAILS_PER_15MIN",
  "CLIENT_IP_HEADER",
  // 开发机 shell 里设了这两个，「没配账号却接了真实模型」那几条会误报失败
  "LLM_API_KEY",
  "TTS_API_KEY",
];
const PW_A = "kq7-ma3x-29pd";
const PW_B = "another-pass-123";
const SECRET = randomBytes(32).toString("base64url");
const HOUR = 3_600_000;
let REC_A = "";
let REC_B = "";
// 登录接口那一组用便宜参数的记录：每次登录都要算一次哈希，全按默认参数算太占 CPU（行为和默认参数一样，只是快）
let FAST = "";

let saved: Record<string, string | undefined> = {};
/** 这一个用例里写进 console.error 的内容（服务端日志） */
let logs: string[] = [];
beforeAll(async () => {
  [REC_A, REC_B] = await Promise.all([hashPassword(PW_A), hashPassword(PW_B)]);
  const cheap = { logN: 14, r: 8, p: 1 };
  FAST = `judge-01:${hashPasswordSync(PW_A, cheap)},team.b:${hashPasswordSync(PW_B, cheap)}`;
});
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetRateLimits();
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRateLimits();
  vi.restoreAllMocks();
});

function useAccounts(accounts = `judge-01:${REC_A},team.b:${REC_B}`, secret = SECRET) {
  process.env.AUTH_ACCOUNTS = accounts;
  process.env.SESSION_SECRET = secret;
}
const useFastAccounts = () => useAccounts(FAST);

/** 哪些字符串绝不能出现在提示、日志里：记录整条、盐、哈希、密钥、密码 */
const secrets = () => [REC_A, REC_A.split(".")[4], REC_A.split(".")[5], REC_B, SECRET, PW_A, PW_B];

describe("账号名和密码的规范化", () => {
  it("账号名：全角、大小写、首尾空格（含全角空格）折叠；中文、破折号、零宽字符、İ、长度不对都拒绝", () => {
    expect(normalizeAccount("  ＪＵＤＧＥ－０１　")).toBe("judge-01");
    expect(normalizeAccount("ＪＵＤＧＥ-01")).toBe("judge-01");
    expect(normalizeAccount("Judge.01")).toBe("judge.01");
    expect(normalizeAccount("team_b")).toBe("team_b");
    // 开尔文符号 K、带点的数字 ⒈ 都折成同一个 ASCII 账号：换写法躲不过按账号的计数和锁定（11-06 安全复核扫过全部码位）
    expect(normalizeAccount(`${String.fromCodePoint(0x212a)}q7-judge`)).toBe("kq7-judge");
    expect(normalizeAccount(`judge${String.fromCodePoint(0x2488)}x`)).toBe("judge1.x");
    for (const bad of [
      "评委一",
      "judge—01",
      `judge${String.fromCodePoint(0x200b)}01`,
      "İnfo",
      "a",
      "x".repeat(33),
      "x".repeat(65),
      " ",
      "",
      "-judge",
      "judge 01",
      42,
      null,
    ]) {
      expect(normalizeAccount(bad), String(bad)).toBeNull();
    }
  });

  it("密码：只做 NFKC（全角等于半角），不去空格；空的、超过 128 个字符、原文超过 256 个字符返回 null", () => {
    expect(normalizePassword("ｋｑ７－ｍａ３ｘ")).toBe("kq7-ma3x");
    expect(normalizePassword(" pad ")).toBe(" pad ");
    expect(normalizePassword("x".repeat(128))).toBe("x".repeat(128));
    expect(normalizePassword("x".repeat(129))).toBeNull();
    expect(normalizePassword("ｘ".repeat(200))).toBeNull();
    expect(normalizePassword("x".repeat(257))).toBeNull();
    expect(normalizePassword("")).toBeNull();
    expect(normalizePassword(undefined)).toBeNull();
  });
});

describe("密码记录（scrypt）", { timeout: 30_000 }, () => {
  it("生成后能核对，错的密码不行；格式只有字母、数字和 . _ -；同一个密码两次生成的记录不一样", async () => {
    expect(REC_A).toMatch(/^s1\.15\.8\.3\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword(PW_A, REC_A)).toBe(true);
    expect(await verifyPassword(normalizePassword("ｋｑ７－ｍａ３ｘ－２９ｐｄ"), REC_A)).toBe(true);
    expect(await verifyPassword("kq7-ma3x-29pD", REC_A)).toBe(false);
    expect(await verifyPassword(null, REC_A)).toBe(false);
    expect(hashPasswordSync(PW_A)).not.toBe(REC_A);
  });

  it("记录格式不对、参数超出范围、盐和哈希写法不规范的都不认", () => {
    const [, , , , salt, hash] = REC_A.split(".");
    expect(parseRecord(REC_A)).toMatchObject({ logN: 15, r: 8, p: 3 });
    for (const bad of [
      REC_A.slice(0, -1),
      `${REC_A}x`,
      `s2.15.8.3.${salt}.${hash}`,
      `s1.13.8.3.${salt}.${hash}`,
      `s1.21.8.3.${salt}.${hash}`,
      `s1.15.7.3.${salt}.${hash}`,
      `s1.15.8.17.${salt}.${hash}`,
      `s1.15.8.3.${salt.slice(0, -1)}R.${hash}`,
      `$scrypt$ln=15,r=8,p=1$${salt}$${hash}`,
    ]) {
      expect(parseRecord(bad), bad.slice(0, 12)).toBeNull();
    }
  });

  it("账号不存在也照样算一次哈希：耗时和密码不对差不多", async () => {
    const time = async (record: string | null) => {
      const t = performance.now();
      expect(await verifyPassword("wrong-password-1", record)).toBe(false);
      return performance.now() - t;
    };
    const wrong: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      wrong.push(await time(REC_A));
      unknown.push(await time(null));
    }
    expect(Math.min(...unknown)).toBeGreaterThan(Math.min(...wrong) / 2);
  });

  it("同时最多算 2 个、排队 16 个，再多直接回「忙」", async () => {
    const cheap = hashPasswordSync("cheap-pass-for-gate", { logN: 14, r: 8, p: 1 });
    const outcomes = await Promise.all(
      Array.from({ length: 19 }, () =>
        verifyPassword("cheap-pass-for-gate", cheap).then(
          (ok) => (ok ? "ok" : "wrong"),
          (e) => (e instanceof BusyError ? "busy" : "other"),
        ),
      ),
    );
    expect(outcomes.filter((x) => x === "ok")).toHaveLength(18);
    expect(outcomes.filter((x) => x === "busy")).toHaveLength(1);
    // 排满的那一下过去以后照常能算
    expect(await verifyPassword("cheap-pass-for-gate", cheap)).toBe(true);
  });
});

// 照 next start 的读法读 .env.local（@next/env，和 next 同一个版本），在子进程里读，不动这个测试进程的环境变量
const NEXT_ENV = createRequire(path.join(process.cwd(), "package.json")).resolve("@next/env");
function loadLikeNext(content: string): { AUTH_ACCOUNTS?: string; SESSION_SECRET?: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fencun-env-"));
  try {
    writeFileSync(path.join(dir, ".env.local"), content);
    const script = `const { loadEnvConfig } = require(${JSON.stringify(NEXT_ENV)});
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
process.stdout.write(JSON.stringify({ AUTH_ACCOUNTS: process.env.AUTH_ACCOUNTS, SESSION_SECRET: process.env.SESSION_SECRET }));`;
    const env = { ...process.env };
    for (const k of [...KEYS, "NODE_ENV", "__NEXT_PROCESSED_ENV"]) delete env[k];
    const r = spawnSync(process.execPath, ["-e", script], { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("和 Next 读 .env 的规则连起来", { timeout: 30_000 }, () => {
  it("单行逗号写法、双引号多行写法（带注释）都读得全", () => {
    const single = loadLikeNext(`SESSION_SECRET=${SECRET}\nAUTH_ACCOUNTS=judge-01:${REC_A},team.b:${REC_B}\n`);
    expect(single.AUTH_ACCOUNTS).toBe(`judge-01:${REC_A},team.b:${REC_B}`);
    expect(authConfig(single).mode).toBe("accounts");
    const multi = loadLikeNext(
      `SESSION_SECRET=${SECRET}\nAUTH_ACCOUNTS="\n# 评委\njudge-01:${REC_A}\n  # team.c:${REC_B}\nteam.b:${REC_B}\n"\n`,
    );
    expect([...parseAccounts(multi.AUTH_ACCOUNTS ?? "").accounts.keys()]).toEqual(["judge-01", "team.b"]);
    expect(authConfig(multi).mode).toBe("accounts");
  });

  it("多行忘了加引号会读丢账号、PHC 写法会被 $ 展开弄坏：两种都当配置错误拦住", () => {
    const unquoted = loadLikeNext(`SESSION_SECRET=${SECRET}\nAUTH_ACCOUNTS=\njudge-01:${REC_A}\n`);
    expect(unquoted.AUTH_ACCOUNTS ?? "").toBe("");
    expect(authConfig(unquoted).mode).toBe("broken");
    const phc = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2g";
    const expanded = loadLikeNext(`SESSION_SECRET=${SECRET}\nAUTH_ACCOUNTS=judge-01:${phc}\n`);
    expect(expanded.AUTH_ACCOUNTS).not.toBe(`judge-01:${phc}`);
    expect(authConfig(expanded).mode).toBe("broken");
  });
});

describe("账号配置（AUTH_ACCOUNTS）", () => {
  it("换行、空格、英文逗号都能分隔；多行块里整行以 # 开头的是注释", () => {
    const parsed = parseAccounts(`\n# 评委\n judge-01:${REC_A}\n,team.b:${REC_B}  ops-3:${REC_A}\n  # team.c:${REC_B}\n`);
    expect([...parsed.accounts.keys()]).toEqual(["judge-01", "team.b", "ops-3"]);
    expect(parsed.errors).toEqual([]);
  });

  it("三个都没设才不登录；设了任何一个但配得不对就全站拦住，原因里不带记录和密钥", () => {
    expect(authConfig({}).mode).toBe("open");
    expect(authConfig({ AUTH_ACCOUNTS: " ", SESSION_SECRET: "", ACCESS_CODE: "" }).mode).toBe("open");
    const cases: [string, Record<string, string>][] = [
      ["重复账号", { AUTH_ACCOUNTS: `judge-01:${REC_A},JUDGE-01:${REC_B}`, SESSION_SECRET: SECRET }],
      ["记录被截断", { AUTH_ACCOUNTS: `judge-01:${REC_A.slice(0, -3)}`, SESSION_SECRET: SECRET }],
      ["含 $", { AUTH_ACCOUNTS: `judge-01:${REC_A},team.b:$scrypt`, SESSION_SECRET: SECRET }],
      ["含 #", { AUTH_ACCOUNTS: `judge-01:${REC_A} #team.b:${REC_B}`, SESSION_SECRET: SECRET }],
      ["没有冒号", { AUTH_ACCOUNTS: REC_A, SESSION_SECRET: SECRET }],
      ["测试账号", { AUTH_ACCOUNTS: `e2e-judge:${REC_A}`, SESSION_SECRET: SECRET }],
      ["只设了 ACCESS_CODE", { ACCESS_CODE: "old-access-code" }],
      ["只设了 SESSION_SECRET", { SESSION_SECRET: SECRET }],
      ["缺 SESSION_SECRET", { AUTH_ACCOUNTS: `judge-01:${REC_A}` }],
      ["密钥太短", { AUTH_ACCOUNTS: `judge-01:${REC_A}`, SESSION_SECRET: "short-secret" }],
      ["只有注释", { AUTH_ACCOUNTS: "# 评委\n# 还没加", SESSION_SECRET: SECRET }],
    ];
    for (const [label, env] of cases) {
      const c = authConfig(env);
      expect(c.mode, label).toBe("broken");
      const reason = c.mode === "broken" ? c.reason : "";
      expect(reason, label).not.toBe("");
      for (const s of secrets()) expect(reason, label).not.toContain(s);
    }
    // 每种配置在一个进程里写一次服务端日志（前面的用例写过的不再写），同样不带记录和密钥
    expect(logs.length).toBeGreaterThan(0);
    for (const s of secrets()) expect(logs.join("\n")).not.toContain(s);
  });

  it("端到端测试的账号和密钥（随仓库公开）只在显式允许时认：抄进线上的一律当配置错误", () => {
    const e2e = e2eAuthEnv();
    expect(authConfig(e2e).mode).toBe("accounts");
    expect(authConfig({ ...e2e, AUTH_ALLOW_E2E_ACCOUNTS: "" }).mode).toBe("broken");
    const copied = authConfig({ AUTH_ACCOUNTS: `judge-01:${REC_A}`, SESSION_SECRET: e2e.SESSION_SECRET });
    expect(copied.mode).toBe("broken");
    expect(copied.mode === "broken" ? copied.reason : "").not.toContain(e2e.SESSION_SECRET);
  });

  it("测试账号要显式允许；旧变量、不同的哈希参数、离谱的有效期只提醒", () => {
    const allowed = authConfig({ AUTH_ACCOUNTS: `e2e-judge:${REC_A}`, SESSION_SECRET: SECRET, AUTH_ALLOW_E2E_ACCOUNTS: "1" });
    expect(allowed.mode).toBe("accounts");
    // 开着这个开关要在日志和 check 里看得到（11-08 安全复核）；没开时不提
    expect(allowed.mode === "accounts" && allowed.warnings.some((w) => w.includes("AUTH_ALLOW_E2E_ACCOUNTS"))).toBe(true);
    const c = authConfig({
      AUTH_ACCOUNTS: `judge-01:${REC_A},team.b:${hashPasswordSync(PW_B, { logN: 14, r: 8, p: 1 })}`,
      SESSION_SECRET: SECRET,
      ACCESS_CODE: "old-access-code",
      ACCESS_TTL_HOURS: "24",
      SESSION_TTL_HOURS: "9999",
    });
    expect(c.mode).toBe("accounts");
    if (c.mode !== "accounts") return;
    expect(c.ttlMs).toBe(720 * HOUR);
    expect(c.warnings.some((w) => w.startsWith("team.b"))).toBe(true);
    expect(c.warnings.some((w) => w.includes("ACCESS_CODE"))).toBe(true);
    expect(c.warnings.some((w) => w.includes("ACCESS_TTL_HOURS"))).toBe(true);
    expect(c.warnings.some((w) => w.includes("SESSION_TTL_HOURS"))).toBe(true);
    expect(c.warnings.some((w) => w.includes("AUTH_ALLOW_E2E_ACCOUNTS"))).toBe(false);
    expect(authConfig({ AUTH_ACCOUNTS: `judge-01:${REC_A}`, SESSION_SECRET: SECRET, SESSION_TTL_HOURS: "abc" })).toMatchObject({
      ttlMs: 168 * HOUR,
    });
  });
});

describe("会话 cookie", () => {
  const now = Date.UTC(2026, 10, 6, 4);

  it("签发后能核对；换账号名、改到期时间、多一个字、乱写、版本不对、账号名写法不规范、过期的都不认", () => {
    useAccounts();
    const { value, maxAgeSeconds } = issueSession("judge-01", now);
    expect(maxAgeSeconds).toBe(168 * 3600);
    expect(value.length).toBeLessThan(100);
    expect(verifySession(value, now + 1000)).toEqual({ account: "judge-01", expiresAt: now + 168 * HOUR });
    const [v, b64, exp, sig] = value.split(".");
    // 账号名的 base64url 末位多余的位改一下，解出来还是同一个名字，但不是规范写法
    const loose = b64.slice(0, -1) + String.fromCharCode(b64.charCodeAt(b64.length - 1) + 1);
    expect(Buffer.from(loose, "base64url").toString()).toBe("judge-01");
    for (const bad of [
      `${v}.${Buffer.from("team.b").toString("base64url")}.${exp}.${sig}`,
      `${v}.${b64}.${Number(exp) + 1000}.${sig}`,
      `${value}x`,
      `v2.${b64}.${exp}.${sig}`,
      `${v}.${b64}=.${exp}.${sig}`,
      `${v}.${loose}.${exp}.${sig}`,
      "garbage",
      "x".repeat(201),
    ]) {
      expect(verifySession(bad, now), bad.slice(0, 20)).toBeNull();
    }
    expect(verifySession(undefined, now)).toBeNull();
    expect(verifySession(value, Number(exp))).toBeNull();
    expect(() => issueSession("nobody-01", now)).toThrow();
  });

  it("有效期调短后，已经发出去的长 cookie 立即作废", () => {
    useAccounts();
    const { value } = issueSession("judge-01", now);
    process.env.SESSION_TTL_HOURS = "1";
    expect(verifySession(value, now + 1000)).toBeNull();
    expect(verifySession(issueSession("judge-01", now).value, now + 1000)?.account).toBe("judge-01");
  });

  it("改了 A 的密码只踢 A；删了账号它的会话作废；换 SESSION_SECRET 全部作废；不登录模式一律不认", () => {
    useAccounts();
    const a = issueSession("judge-01", now).value;
    const b = issueSession("team.b", now).value;
    useAccounts(`judge-01:${hashPasswordSync(PW_A)},team.b:${REC_B}`);
    expect(verifySession(a, now)).toBeNull();
    expect(verifySession(b, now)?.account).toBe("team.b");
    useAccounts(`team.b:${REC_B}`);
    expect(verifySession(b, now)?.account).toBe("team.b");
    useAccounts(`team.b:${REC_B}`, randomBytes(32).toString("base64url"));
    expect(verifySession(b, now)).toBeNull();
    delete process.env.AUTH_ACCOUNTS;
    delete process.env.SESSION_SECRET;
    expect(verifySession(b, now)).toBeNull();
  });

  it("从请求里取：照 Cookie 请求头解析，别的 cookie 不干扰", () => {
    useAccounts();
    const { value } = issueSession("judge-01");
    const req = new Request("http://127.0.0.1:3000/", { headers: { cookie: `theme=dark; ${SESSION_COOKIE}=${value}; other=1` } });
    expect(sessionFromRequest(req)?.account).toBe("judge-01");
    expect(sessionFromRequest(new Request("http://127.0.0.1:3000/"))).toBeNull();
    // 同名的写了两份时取后一份，和 Next 自己的解析（proxy 的 request.cookies、页面的 cookies()）认的是同一份
    const b = issueSession("team.b").value;
    const twice = `${SESSION_COOKIE}=${value}; other=1; ${SESSION_COOKIE}=${b}`;
    expect(new NextRequest("http://127.0.0.1:3000/", { headers: { cookie: twice } }).cookies.get(SESSION_COOKIE)?.value).toBe(b);
    expect(sessionFromRequest(new Request("http://127.0.0.1:3000/", { headers: { cookie: twice } }))?.account).toBe("team.b");
  });

  it("cookie 属性：HttpOnly、SameSite=Lax、Path=/、Max-Age 都在；只有 https 才加 Secure；退出时 Max-Age=0", () => {
    const plain = sessionCookie("v1.x", 600, false);
    for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=600"]) expect(plain).toContain(attr);
    expect(plain).not.toContain("Secure");
    expect(sessionCookie("v1.x", 600, true)).toMatch(/; Secure$/);
    expect(clearSessionCookie(false)).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    expect(isHttps(new Request("https://demo.example/"))).toBe(true);
    expect(isHttps(new Request("http://127.0.0.1:3000/", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
    expect(isHttps(new Request("http://127.0.0.1:3000/", { headers: { "x-forwarded-proto": "http, https" } }))).toBe(false);
    expect(isHttps(new Request("http://127.0.0.1:3000/"))).toBe(false);
  });
});

describe("门禁（proxy.ts）", () => {
  it("没配账号时什么都不拦", () => {
    expect(proxy(new NextRequest("http://127.0.0.1:3000/workbench")).headers.get("x-middleware-next")).toBe("1");
  });

  it("配了账号：没登录时接口回 401、页面跳登录页并记住原地址；cookie 无效时提示过期；有效的放行", async () => {
    useAccounts();
    const api = proxy(new NextRequest("http://127.0.0.1:3000/api/runs"));
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "需要先登录：请打开 /login", code: "auth_required" });
    const page = proxy(new NextRequest("http://127.0.0.1:3000/workbench?tab=1"));
    expect(page.status).toBe(307);
    const to = new URL(page.headers.get("location") ?? "");
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/workbench?tab=1");
    expect(to.searchParams.has("reason")).toBe(false);
    const stale = proxy(new NextRequest("http://127.0.0.1:3000/workbench", { headers: { cookie: `${SESSION_COOKIE}=v1.eA.1.x` } }));
    expect(new URL(stale.headers.get("location") ?? "").searchParams.get("reason")).toBe("expired");
    const cookie = `${SESSION_COOKIE}=${issueSession("judge-01").value}`;
    const model = proxy(new NextRequest("http://127.0.0.1:3000/models/qiyetao.vrm", { headers: { cookie } }));
    expect(model.headers.get("x-middleware-next")).toBe("1");
  });

  it("配置有问题：接口回 503，页面跳到登录页说明「登录设置有问题」", async () => {
    process.env.ACCESS_CODE = "old-access-code";
    const api = proxy(new NextRequest("http://127.0.0.1:3000/api/status"));
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ code: "auth_config" });
    const page = proxy(new NextRequest("http://127.0.0.1:3000/workbench"));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location") ?? "").search).toBe("?error=config");
  });

  it("登录页、登录和退出接口按完整路径放行（配置有问题时也放行，不然转圈）；只是前缀一样的地址照样要登录", () => {
    const passes = (p: string) => proxy(new NextRequest(`http://127.0.0.1:3000${p}`)).headers.get("x-middleware-next") === "1";
    const setups: [string, () => void][] = [
      ["配了账号", () => useAccounts()],
      [
        "配置有问题",
        () => {
          process.env.ACCESS_CODE = "old-access-code";
        },
      ],
    ];
    for (const [label, setup] of setups) {
      for (const k of KEYS) delete process.env[k];
      setup();
      for (const p of ["/login", "/login?next=%2Fworkbench", "/api/login", "/api/logout"]) expect(passes(p), `${label} ${p}`).toBe(true);
      for (const p of ["/login-bg.webp", "/login/x", "/api/login-x", "/api/logout-x", "/loginx"])
        expect(passes(p), `${label} ${p}`).toBe(false);
    }
  });

  it("matcher（用 Next 自己的匹配逻辑）：只有构建出的静态文件和网站图标不经过 proxy，别的都要过（包括 /_next/image）", () => {
    // Next 的服务端模块加载时要 AsyncLocalStorage（next start 里由 Next 自己放上去）
    const g = globalThis as { AsyncLocalStorage?: unknown };
    g.AsyncLocalStorage ??= AsyncLocalStorage;
    const testing = createRequire(path.join(process.cwd(), "package.json"))(
      "next/experimental/testing/server",
    ) as typeof import("next/experimental/testing/server");
    const runs = (url: string) => testing.unstable_doesMiddlewareMatch({ config: proxyConfig, url });
    for (const url of ["/_next/static/media/login.3f2a1b9c.avif", "/_next/static/chunks/app.js", "/favicon.ico"])
      expect(runs(url), url).toBe(false);
    const gated = ["/", "/workbench", "/api/runs", "/api/session", "/api/status", "/models/qiyetao.vrm", "/audio/playback-core.js"];
    for (const url of [
      ...gated,
      "/login",
      "/api/login",
      "/login-bg.webp",
      "/api/login-x",
      "/_next/image",
      "/faviconXico",
      "/_next/staticx",
    ]) {
      expect(runs(url), url).toBe(true);
    }
  });

  it("没配账号却接了真实模型：只许从本机打开，别的 Host 当配置有问题拦住；模拟模式不管", async () => {
    const saved = process.env.LLM_API_KEY;
    try {
      const at = (host: string, p = "/workbench") => proxy(new NextRequest(`http://${host}${p}`, { headers: { host } }));
      expect(at("demo.example").headers.get("x-middleware-next")).toBe("1");
      process.env.LLM_API_KEY = "sk-test-only";
      for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "LOCALHOST"])
        expect(at(host).headers.get("x-middleware-next"), host).toBe("1");
      expect(new URL(at("demo.example").headers.get("location") ?? "").search).toBe("?error=config");
      expect(at("demo.example", "/api/status").status).toBe(503);
      expect(at("demo.example", "/login").headers.get("x-middleware-next")).toBe("1");
      const remote = (headers: Record<string, string>) => form({ next: "/play" }, { host: "demo.example", ...headers });
      expect(where(await login(remote({})))).toBe("/login?error=config&next=%2Fplay");
      expect(where(await login(form({ next: "/play" }, { host: "127.0.0.1:3000" })))).toBe("/play");
      expect(logs.some((l) => l.includes("只许从本机"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = saved;
    }
  });
});

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams(fields).toString();
  return new Request("http://127.0.0.1:3000/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
      "x-forwarded-for": "203.0.113.7",
      ...headers,
    },
    body,
  });
};
const where = (r: Response) => r.headers.get("location");

describe("登录接口", { timeout: 30_000 }, () => {
  it("没配账号时不用登录，直接跳回", async () => {
    const r = await login(form({ next: "/play" }));
    expect(r.status).toBe(303);
    expect(where(r)).toBe("/play");
  });

  it("跨站 403；太长 413（写了长度、没写长度都拦）；不是普通表单 415；没填全回 missing", async () => {
    useFastAccounts();
    expect((await login(form({ account: "judge-01", password: PW_A }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await login(form({ account: "judge-01", password: PW_A }, { "content-length": "5000" }))).status).toBe(413);
    const long = new Request("http://127.0.0.1:3000/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `account=judge-01&password=${"x".repeat(5000)}`,
    });
    expect((await login(long)).status).toBe(413);
    const json = new Request("http://127.0.0.1:3000/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: "judge-01", password: PW_A }),
    });
    expect((await login(json)).status).toBe(415);
    expect(where(await login(form({ account: "judge-01", password: "" })))).toBe("/login?error=missing&next=%2Fworkbench");
    expect(where(await login(form({ account: "　", password: PW_A })))).toBe("/login?error=missing&next=%2Fworkbench");
  });

  it("密码不对、账号不存在、账号名不合格式、密码超长：跳转地址一字不差，都不发 cookie", async () => {
    useFastAccounts();
    const tries = [
      { account: "judge-01", password: "wrong-password-1" },
      { account: "nobody-01", password: "wrong-password-1" },
      { account: "评委", password: PW_A },
      { account: "judge-01", password: "x".repeat(200) },
    ];
    for (const t of tries) {
      const r = await login(form({ ...t, next: "/play" }));
      expect(r.status).toBe(303);
      expect(where(r)).toBe("/login?error=auth&next=%2Fplay");
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("全角大写的账号名加全角的密码能登录，cookie 里是规范化后的账号名；跳回地址只认本站路径", async () => {
    useFastAccounts();
    // 这个浏览器看过用法页了（带着记号）：直接回原地址，只发会话 cookie
    const seen = { cookie: `${GUIDE_COOKIE}=1` };
    const r = await login(form({ account: "ＪＵＤＧＥ－０１", password: "ｋｑ７－ｍａ３ｘ－２９ｐｄ", next: "//evil.example" }, seen));
    expect(r.status).toBe(303);
    expect(where(r)).toBe("/workbench");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith(`${SESSION_COOKIE}=v1.`)).toBe(true);
    for (const attr of ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${168 * 3600}`]) expect(cookie).toContain(attr);
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain(GUIDE_COOKIE);
    expect(verifySession(cookie.split(";")[0].slice(SESSION_COOKIE.length + 1))?.account).toBe("judge-01");
    // 登录页、接口不当跳回的目标
    expect(where(await login(form({ account: "judge-01", password: PW_A, next: "/login?next=/x" }, seen)))).toBe("/workbench");
    expect(where(await login(form({ account: "judge-01", password: PW_A, next: "/api/status" }, seen)))).toBe("/workbench");
  });

  it("这个浏览器第一次登录：先去用法页，原来要去的地址带在 next 里，顺手发「看过用法」的记号；输错不发", async () => {
    useFastAccounts();
    const r = await login(form({ account: "judge-01", password: PW_A, next: "/play?level=exit" }));
    expect(r.status).toBe(303);
    expect(where(r)).toBe("/guide?next=%2Fplay%3Flevel%3Dexit");
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0].startsWith(`${SESSION_COOKIE}=v1.`)).toBe(true);
    expect(cookies[1]).toBe(`${GUIDE_COOKIE}=1; Path=/; Max-Age=${365 * 24 * 3600}; HttpOnly; SameSite=Lax`);
    // 跳回地址先规整，再套进用法页：外站、登录页都回工作台
    expect(where(await login(form({ account: "judge-01", password: PW_A, next: "/.//evil.example" })))).toBe("/guide?next=%2Fworkbench");
    // 本来就要去用法页的，不再套一层
    expect(where(await login(form({ account: "judge-01", password: PW_A, next: "/guide" })))).toBe("/guide");
    // 输错：照旧回登录页，不发任何 cookie
    const bad = await login(form({ account: "judge-01", password: "wrong-password-1", next: "/play" }));
    expect(where(bad)).toBe("/login?error=auth&next=%2Fplay");
    expect(bad.headers.getSetCookie()).toEqual([]);
    // https 时两个 cookie 都带 Secure
    const https = await login(form({ account: "judge-01", password: PW_A }, { "x-forwarded-proto": "https" }));
    for (const c of https.headers.getSetCookie()) expect(c).toMatch(/; Secure$/);
  });

  it("同一来源 10 分钟内试的次数有上限，换个来源不受影响", async () => {
    useFastAccounts();
    process.env.RATE_LOGIN_PER_10MIN = "2";
    await login(form({ account: "judge-01", password: "wrong-password-1" }));
    await login(form({ account: "judge-01", password: "wrong-password-1" }));
    expect(where(await login(form({ account: "judge-01", password: PW_A })))).toMatch(/^\/login\?error=limit&retry=\d+&next=%2Fworkbench$/);
    const other = await login(form({ account: "judge-01", password: PW_A }, { "x-forwarded-for": "198.51.100.9" }));
    expect(other.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=v1.`);
  });

  it("同一账号名输错满了就锁：换来源也没用、密码对了也不行；别的账号不受影响；不存在的账号名一样锁", async () => {
    useFastAccounts();
    process.env.RATE_LOGIN_FAILS_PER_15MIN = "3";
    const from = (n: number) => ({ "x-forwarded-for": `203.0.113.${n}` });
    for (const n of [1, 2, 3]) await login(form({ account: "judge-01", password: "wrong-password-1" }, from(n)));
    const locked = await login(form({ account: "judge-01", password: PW_A }, from(4)));
    expect(where(locked)).toMatch(/^\/login\?error=locked&retry=\d+&next=%2Fworkbench$/);
    expect(locked.headers.get("set-cookie")).toBeNull();
    expect(logs.some((l) => l.includes("judge-01") && l.includes("锁"))).toBe(true);
    const other = await login(form({ account: "team.b", password: PW_B }, from(4)));
    expect(other.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=v1.`);
    for (const n of [1, 2, 3]) await login(form({ account: "nobody-01", password: "wrong-password-1" }, from(n)));
    expect(where(await login(form({ account: "nobody-01", password: "wrong-password-1" }, from(4))))).toMatch(/error=locked/);
    // 不存在的账号名不进日志（可能是把密码输进了账号框）；密码、记录、密钥一律不进日志
    expect(logs.some((l) => l.includes("nobody-01"))).toBe(false);
    for (const s of [...secrets(), "wrong-password-1"]) expect(logs.join("\n")).not.toContain(s);
  });

  it("默认上限下一个来源锁不住别人的账号：跨两个 10 分钟格子连着输错 20 次，只被按来源限住，换个来源密码对了照常登录", async () => {
    // 这个用例要算 20 次哈希，记录用便宜的参数（只会多一条参数不同的提醒）
    useAccounts(`judge-01:${hashPasswordSync(PW_A, { logN: 14, r: 8, p: 1 })}`);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const wrong = () => login(form({ account: "judge-01", password: "wrong-password-1" }, { "x-forwarded-for": "203.0.113.50" }));
      for (const t of [Date.UTC(2026, 10, 6, 2, 9, 30), Date.UTC(2026, 10, 6, 2, 10, 30)]) {
        vi.setSystemTime(t);
        for (let i = 0; i < 10; i++) expect(where(await wrong())).toContain("error=auth");
        expect(where(await wrong())).toContain("error=limit");
      }
      const ok = await login(form({ account: "judge-01", password: PW_A }, { "x-forwarded-for": "198.51.100.20" }));
      expect(ok.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=v1.`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超长的密码也算一次输错", async () => {
    useFastAccounts();
    process.env.RATE_LOGIN_FAILS_PER_15MIN = "1";
    expect(where(await login(form({ account: "judge-01", password: "x".repeat(200) })))).toBe("/login?error=auth&next=%2Fworkbench");
    expect(where(await login(form({ account: "judge-01", password: PW_A })))).toMatch(/error=locked/);
  });

  it("配置有问题回 config；https（nginx 写了 X-Forwarded-Proto）时 cookie 带 Secure", async () => {
    process.env.ACCESS_CODE = "old-access-code";
    expect(where(await login(form({ account: "judge-01", password: PW_A })))).toBe("/login?error=config&next=%2Fworkbench");
    delete process.env.ACCESS_CODE;
    useFastAccounts();
    const r = await login(form({ account: "judge-01", password: PW_A }, { "x-forwarded-proto": "https" }));
    expect(r.headers.get("set-cookie")).toMatch(/; Secure$/);
  });
});

describe("退出接口", () => {
  const post = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/logout", { method: "POST", headers });

  it("303 回登录页并清掉 cookie；跨站的拒绝；没配账号时回工作台；只收 POST", async () => {
    useAccounts();
    const r = await logoutRoute.POST(post());
    expect(r.status).toBe(303);
    expect(where(r)).toBe("/login?bye=1");
    expect(r.headers.get("set-cookie")).toBe(clearSessionCookie(false));
    expect((await logoutRoute.POST(post({ origin: "https://evil.example" }))).status).toBe(403);
    expect((await logoutRoute.POST(post({ "x-forwarded-proto": "https" }))).headers.get("set-cookie")).toBe(clearSessionCookie(true));
    delete process.env.AUTH_ACCOUNTS;
    delete process.env.SESSION_SECRET;
    expect(where(await logoutRoute.POST(post()))).toBe("/workbench");
    expect(Object.keys(logoutRoute)).not.toContain("GET");
  });
});
