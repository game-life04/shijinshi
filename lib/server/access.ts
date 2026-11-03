// 上线演示用的门禁和限流（11-03，ADR-028）。
//   门禁：设了环境变量 ACCESS_CODE 才启用。访问者先在 /login 输入访问码，服务端发一个签了名的 cookie
//         （有效期 ACCESS_TTL_HOURS，默认 168 小时），proxy.ts 对登录页和构建出的静态文件以外的所有请求核对它。
//         没设 ACCESS_CODE 时（本机开发、评委在自己电脑上跑）什么都不拦。
//   限流：防止有人刷掉模型额度。新建体检、闯关开局、闯关发言、登录尝试各有「每个来源」的上限，体检和闯关发言还有「全站每天」的上限；
//         设了 ACCESS_CODE 时默认开启（RATE_LIMIT=0 可关），没设时默认不开（RATE_LIMIT=1 可开）。登录尝试的上限只要有访问码就一直生效。
//   来源怎么认：默认取 x-forwarded-for 的最后一个地址。next start 直接对外时，Next 会在这里填上对方的 IP，
//         但对方自己带了这个头就会被骗过；前面有 nginx 时让它写 X-Real-IP，并设 CLIENT_IP_HEADER=x-real-ip（docs/deploy.md）。
//         认错来源时，「全站每天」的上限仍然兜底。
//   计数只在内存里：一个服务进程够用，重启清零；多台服务器要换成共享存储。

import { createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE = "fencun_access";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 「每天」按北京时间算，零点清零 */
const BEIJING_OFFSET = 8 * HOUR;

export function accessCode(): string {
  return (process.env.ACCESS_CODE ?? "").trim();
}

export function accessTtlMs(): number {
  const h = Number(process.env.ACCESS_TTL_HOURS ?? 168);
  return (Number.isFinite(h) && h > 0 ? h : 168) * HOUR;
}

function signature(code: string, expiresAt: number): string {
  return createHmac("sha256", `fencun-access-v1:${code}`).update(String(expiresAt)).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 登录成功后发的 cookie 值：到期时间 + 签名。签名用访问码当密钥，换了访问码，发出去的 cookie 全部失效 */
export function issueAccess(code: string, now = Date.now()): { value: string; maxAgeSeconds: number } {
  const expiresAt = now + accessTtlMs();
  return { value: `${expiresAt}.${signature(code, expiresAt)}`, maxAgeSeconds: Math.floor(accessTtlMs() / 1000) };
}

export function verifyAccess(code: string, value: string | undefined, now = Date.now()): boolean {
  if (!code || !value) return false;
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const expiresAt = Number(value.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return safeEqual(value.slice(dot + 1), signature(code, expiresAt));
}

/** 核对输入的访问码：两边先各自做摘要再比，长度不同也不会从耗时上露馅 */
export function codeMatches(code: string, input: string): boolean {
  const digest = (s: string) => createHmac("sha256", "fencun-code").update(s).digest("base64url");
  return Boolean(code) && safeEqual(digest(input), digest(code));
}

/** 登录后跳回的地址：只认本站路径（「//别的网站」「/\别的网站」这类会被浏览器当成外站的写法一律回首页） */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  try {
    const u = new URL(next, "http://local.invalid");
    return u.origin === "http://local.invalid" ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch {
    return "/";
  }
}

// ---------- 限流 ----------

export type RateBucket = "run" | "play_start" | "play_say" | "login";

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
  };
}

export function rateLimitEnabled(): boolean {
  const v = process.env.RATE_LIMIT?.trim();
  if (v === "1" || v === "0") return v === "1";
  return Boolean(accessCode());
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

/** 超过上限返回 429 响应（带 Retry-After）；没超过就记一次、返回 null。被拒的请求不占额度 */
export function rateLimit(req: Request, bucket: RateBucket, now = Date.now()): Response | null {
  if (bucket === "login" ? !accessCode() : !rateLimitEnabled()) return null;
  if (counters.size > 5000) for (const [k, c] of counters) if (c.until <= now) counters.delete(k);
  const r = rateRules()[bucket];
  const win = Math.floor(now / r.windowMs);
  const mine = r.perClient ? slot(`${bucket}|${clientKey(req)}|${win}`, (win + 1) * r.windowMs) : null;
  const day = Math.floor((now + BEIJING_OFFSET) / DAY);
  const site = r.perDay ? slot(`${bucket}|*|${day}`, (day + 1) * DAY - BEIJING_OFFSET) : null;
  if (mine && mine.count >= r.perClient) {
    const minutes = Math.ceil((mine.until - now) / MINUTE);
    return tooMany(`${r.label}太频繁了：同一来源${r.windowLabel}最多 ${r.perClient} 次，请 ${minutes} 分钟后再试`, mine.until - now);
  }
  if (site && site.count >= r.perDay) {
    return tooMany(`今天全站的${r.label}次数已经用完（每天 ${r.perDay} 次），北京时间零点后再来`, site.until - now);
  }
  if (mine) mine.count++;
  if (site) site.count++;
  return null;
}
