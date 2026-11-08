// 上线演示的限流（11-03，ADR-028）。门禁 11-06 改成了账号登录（ADR-032，lib/server/auth.ts），这里只剩限流和跳转地址的检查。
//   限流：防止有人刷掉模型额度。新建体检、闯关开局、闯关发言各有「每个账号」的上限（没配账号、用 RATE_LIMIT=1 硬开时按来源算），
//         体检和闯关发言还有「全站每天」的上限。配了账号时默认开启（RATE_LIMIT=0 可关），没配时默认不开（RATE_LIMIT=1 可开）。
//   登录：同一来源每 10 分钟最多试几次；同一账号名每 15 分钟最多输错几次（不管从哪来、账号存不存在都照样计，防止换着 IP 猜同一个账号）。
//         这两条只要要登录就一直生效，RATE_LIMIT=0 也不关。输错的上限（默认 30）必须大于一个来源 15 分钟内最多能试的次数
//         （10 次 / 10 分钟，跨两个格子最多 20 次），不然一个 IP 就能把知道名字的账号一直锁住，评委进不来（11-06 安全复核）。
//   为什么登录后按账号算：同一个出口后面的几位评委不会再挤同一份额度；没有 nginx 时来源可以伪造，账号伪造不了；
//         账号泄露了，损失也有这个账号自己的上限和全站每天的上限两道封顶。
//   来源怎么认：默认取 x-forwarded-for 的最后一个地址。next start 直接对外时，Next 会在这里填上对方的 IP，
//         但对方自己带了这个头就会被骗过；前面有 nginx 时让它写 X-Real-IP，并设 CLIENT_IP_HEADER=x-real-ip（docs/deploy.md）。
//         认错来源时，「全站每天」的上限仍然兜底。
//   计数只在内存里：一个服务进程够用，重启清零；多台服务器要换成共享存储。

import { authEnabled, sessionFromRequest } from "./auth";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 「每天」按北京时间算，零点清零 */
const BEIJING_OFFSET = 8 * HOUR;

const HOME = "/workbench";

/**
 * 登录后跳回的地址：规整之后必须是「/ 开头、第二个字不是 / 或 \」的本站路径，否则回工作台。
 * 只比 origin 不够：「/.//别的网站」规整后是「//别的网站」，origin 还是本站，浏览器却会当成外站（11-06 安全复核实测）。
 * 登录页、接口也不当跳回的目标：登完又回到登录页、或者看到一屏 JSON，都不对。登录页、登录接口都用这一个函数。
 */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || next.length > 512 || !next.startsWith("/")) return HOME;
  let u: URL;
  try {
    u = new URL(next, "http://local.invalid");
  } catch {
    return HOME;
  }
  const out = `${u.pathname}${u.search}${u.hash}`;
  if (u.origin !== "http://local.invalid" || !/^\/(?![/\\])/.test(out)) return HOME;
  if (out === "/" || out.startsWith("/login") || /^\/api(?:[/?#]|$)/.test(out)) return HOME;
  return out;
}

// ---------- 限流 ----------

export type RateBucket = "run" | "play_start" | "play_say" | "login" | "login_fail";

interface RateRule {
  label: string;
  perClient: number;
  windowMs: number;
  windowLabel: string;
  perDay: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** 各项上限；0 表示不限。数字都能用环境变量改（docs/deploy.md 有按额度估算的表） */
export function rateRules(): Record<RateBucket, RateRule> {
  return {
    run: {
      label: "新建体检",
      perClient: envInt("RATE_RUNS_PER_HOUR", 10),
      windowMs: HOUR,
      windowLabel: "每小时",
      perDay: envInt("RATE_RUNS_PER_DAY", 100),
    },
    play_start: { label: "闯关开局", perClient: envInt("RATE_PLAY_STARTS_PER_HOUR", 30), windowMs: HOUR, windowLabel: "每小时", perDay: 0 },
    play_say: {
      label: "闯关发言",
      perClient: envInt("RATE_PLAY_TURNS_PER_HOUR", 120),
      windowMs: HOUR,
      windowLabel: "每小时",
      perDay: envInt("RATE_PLAY_TURNS_PER_DAY", 3000),
    },
    login: {
      label: "登录尝试",
      perClient: envInt("RATE_LOGIN_PER_10MIN", 10),
      windowMs: 10 * MINUTE,
      windowLabel: "每 10 分钟",
      perDay: 0,
    },
    // 按账号名计，见下面的 loginLock、noteLoginFailure
    login_fail: {
      label: "输错密码",
      perClient: envInt("RATE_LOGIN_FAILS_PER_15MIN", 30),
      windowMs: 15 * MINUTE,
      windowLabel: "每 15 分钟",
      perDay: 0,
    },
  };
}

export function rateLimitEnabled(): boolean {
  const v = process.env.RATE_LIMIT?.trim();
  if (v === "1" || v === "0") return v === "1";
  return authEnabled();
}

/** 认来源：CLIENT_IP_HEADER（默认 x-forwarded-for）里的最后一个地址 */
export function clientKey(req: Request): string {
  const name = (process.env.CLIENT_IP_HEADER || "x-forwarded-for").trim().toLowerCase();
  const parts = (req.headers.get(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.at(-1) || "unknown";
}

interface Counter {
  count: number;
  until: number;
}
const g = globalThis as { __fencunRate?: Map<string, Counter> };
g.__fencunRate ??= new Map<string, Counter>();
const counters = g.__fencunRate;

/** 只给单元测试用：清空计数 */
export function resetRateLimits() {
  counters.clear();
}

let lastSweep = 0;
/** 计数攒多了就把过期的清掉；最多一分钟清一次，不然表很大时每个请求都要整张扫一遍 */
function sweep(now: number) {
  if (counters.size <= 5000 || Math.abs(now - lastSweep) < MINUTE) return;
  lastSweep = now;
  for (const [k, c] of counters) if (c.until <= now) counters.delete(k);
}

function slot(key: string, until: number): Counter {
  let c = counters.get(key);
  if (!c) {
    c = { count: 0, until };
    counters.set(key, c);
  }
  return c;
}

function tooMany(message: string, retryMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryMs / 1000));
  return Response.json({ error: message, retry_after_seconds: seconds }, { status: 429, headers: { "Retry-After": String(seconds) } });
}

/**
 * 超过上限返回 429 响应（带 Retry-After）；没超过就记一次、返回 null。被拒的请求不占额度。
 * 登录尝试按来源计；别的有有效会话就按账号计，没有（没配账号、RATE_LIMIT=1 硬开）按来源计。
 * 计数对象带 acct: / ip: 前缀：叫 unknown 的账号和认不出来源的请求不会算到一起。
 */
export function rateLimit(req: Request, bucket: Exclude<RateBucket, "login_fail">, now = Date.now()): Response | null {
  if (bucket === "login" ? !authEnabled() : !rateLimitEnabled()) return null;
  sweep(now);
  const r = rateRules()[bucket];
  const session = bucket === "login" ? null : sessionFromRequest(req);
  const who = session ? `acct:${session.account}` : `ip:${clientKey(req)}`;
  const win = Math.floor(now / r.windowMs);
  const mine = r.perClient ? slot(`${bucket}|${who}|${win}`, (win + 1) * r.windowMs) : null;
  const day = Math.floor((now + BEIJING_OFFSET) / DAY);
  const site = r.perDay ? slot(`${bucket}|*|${day}`, (day + 1) * DAY - BEIJING_OFFSET) : null;
  if (mine && mine.count >= r.perClient) {
    const minutes = Math.ceil((mine.until - now) / MINUTE);
    const scope = session ? "同一账号" : "同一来源";
    return tooMany(`${r.label}太频繁了：${scope}${r.windowLabel}最多 ${r.perClient} 次，请 ${minutes} 分钟后再试`, mine.until - now);
  }
  if (site && site.count >= r.perDay) {
    return tooMany(`今天全站的${r.label}次数已经用完（每天 ${r.perDay} 次），北京时间零点后再来`, site.until - now);
  }
  if (mine) mine.count++;
  if (site) site.count++;
  return null;
}

function failKey(account: string, now: number): { key: string; until: number } {
  const r = rateRules().login_fail;
  const win = Math.floor(now / r.windowMs);
  return { key: `login_fail|${account}|${win}`, until: (win + 1) * r.windowMs };
}

/**
 * 这个账号名是不是因为输错太多次被锁着：锁着返回还要等多久，没锁返回 null。
 * 账号存不存在都一样算，不然从锁不锁看得出账号在不在。RATE_LOGIN_FAILS_PER_15MIN=0 时不锁。
 */
export function loginLock(account: string, now = Date.now()): { retryMs: number } | null {
  const limit = rateRules().login_fail.perClient;
  const c = limit ? counters.get(failKey(account, now).key) : undefined;
  return c && c.count >= limit ? { retryMs: c.until - now } : null;
}

/** 记一次输错（账号名要先规范化）。登录成功不清零，窗口到了自然过期 */
export function noteLoginFailure(account: string, now = Date.now()): void {
  if (!rateRules().login_fail.perClient) return;
  sweep(now);
  const { key, until } = failKey(account, now);
  slot(key, until).count++;
}
