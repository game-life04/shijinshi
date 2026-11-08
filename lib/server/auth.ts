// 账号登录（11-06，ADR-032，取代 ADR-028 的访问码）：读账号配置，签发、核对会话 cookie。
// 不引 next/headers：proxy.ts、各个接口、页面、命令行工具 scripts/account.ts 都用这一份。
//   账号：环境变量 AUTH_ACCOUNTS，一条「账号名:记录」，条与条之间用换行、空格或英文逗号隔开；多行写法要用英文双引号把整段括起来，
//         块里整行以 # 开头的当注释。记录由 scripts/account.ts 生成，只存哈希（lib/server/password.ts）。账号由参赛队分配，不开放注册。
//   三种模式：
//     open：AUTH_ACCOUNTS、SESSION_SECRET、ACCESS_CODE 三个都没设。本机开发、评委在自己电脑上跑，什么都不拦，和以前一样
//           （只有一个例外：接了真实模型却不是从本机打开的，照样拦住，见下面的 openButNotLocal）；
//     accounts：要登录；
//     broken：设了其中任何一个，但配得不对（缺密钥、记录写坏、只剩旧的 ACCESS_CODE……）。全站拦住、报配置错：
//             宁可谁都进不去，也不能配漏了变成谁都能进。原因只写进服务端日志和 check 命令，不显示在页面上（里面可能有账号名）。
//   会话 cookie：v1.<账号名的 base64url>.<到期毫秒>.<签名>。签名是 HMAC-SHA256，密钥是 SESSION_SECRET，签的内容里含这个账号
//         当前的记录：改了谁的密码只踢谁，删了账号它的会话立即作废，换 SESSION_SECRET 所有人重新登录。
//         会话不存在服务器内存里，重启服务不会让人掉线。SESSION_SECRET 不给默认值、也不在进程里随机生成：
//         写死的默认值谁都能拿来伪造 cookie；随机生成的话，proxy 和登录接口是两份模块，各生成各的，登录完马上又被踢回登录页。

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseRecord, SCRYPT_DEFAULT } from "./password";

export const SESSION_COOKIE = "fencun_session";

const HOUR = 3_600_000;
const DEFAULT_TTL_HOURS = 168;
const MAX_TTL_HOURS = 720;
const MIN_SECRET = 32;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export type AuthConfig =
  | { mode: "open" }
  | { mode: "broken"; reason: string }
  | {
      mode: "accounts";
      accounts: ReadonlyMap<string, string>;
      secret: string;
      ttlMs: number;
      warnings: string[];
      /** 能复核的账号（AUTH_REVIEWERS）；没设就是所有账号都能复核（评审 R31） */
      reviewers?: ReadonlySet<string>;
    };

/** 读配置用的环境变量（默认就是 process.env；测试和 check 命令可以传别的） */
type Env = Record<string, string | undefined>;

/** 账号名：NFKC（全角折成半角）、去首尾空格（全角空格也算）、转小写，再按格式核对；不合格式返回 null */
export function normalizeAccount(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const s = raw.normalize("NFKC").trim().toLowerCase();
  return ACCOUNT_RE.test(s) ? s : null;
}

/**
 * 解析 AUTH_ACCOUNTS。有一条错误整份配置就算错（宁可全站拦住，也不放过写了一半的配置）；
 * 报错只写第几条和账号名，不带记录内容。记录参数和默认的不一样只提醒：未知账号按默认参数算，耗时会和它对不上。
 */
export function parseAccounts(
  raw: string,
  o: { allowE2E?: boolean } = {},
): { accounts: Map<string, string>; errors: string[]; warnings: string[] } {
  const accounts = new Map<string, string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  // 整行以 # 开头的当注释：英文双引号括起来的多行值里，# 不算 .env 的注释，会原样读进来
  const body = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  if (/[$#"'`\\]/.test(body)) {
    errors.push("AUTH_ACCOUNTS 里有 $ # 引号或反斜杠：Next 读 .env 时会展开或截断这些字符，请用 scripts/account.ts 重新生成记录");
  }
  const items = body.split(/[\s,]+/).filter(Boolean);
  for (const [i, item] of items.entries()) {
    const n = i + 1;
    const at = item.indexOf(":");
    const name = at > 0 ? normalizeAccount(item.slice(0, at)) : null;
    const record = item.slice(at + 1);
    const parsed = name ? parseRecord(record) : null;
    if (at < 1) errors.push(`第 ${n} 条缺「账号名:记录」中间的英文冒号`);
    else if (!name) errors.push(`第 ${n} 条的账号名不合格式：只能是 2～32 位字母、数字和 . _ -，以字母或数字开头`);
    else if (!parsed) errors.push(`第 ${n} 条（${name}）的记录格式不对，可能抄漏了或被截断，请用 scripts/account.ts 重新生成`);
    else if (accounts.has(name)) errors.push(`账号 ${name} 写了两次（第 ${n} 条）`);
    else if (name.startsWith("e2e-") && !o.allowE2E) errors.push(`第 ${n} 条（${name}）是端到端测试专用的账号，线上不认`);
    else {
      if (parsed.logN !== SCRYPT_DEFAULT.logN || parsed.r !== SCRYPT_DEFAULT.r || parsed.p !== SCRYPT_DEFAULT.p) {
        warnings.push(`${name} 的记录参数和默认的不一样，不存在的账号按默认参数算，耗时会对不上，建议用 scripts/account.ts 重新生成`);
      }
      accounts.set(name, record);
    }
  }
  return { accounts, errors, warnings };
}

function ttlHours(raw: string | undefined, warnings: string[]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_HOURS;
  const h = Number(raw);
  if (!Number.isFinite(h) || h <= 0) {
    warnings.push(`SESSION_TTL_HOURS 不是正数，按默认 ${DEFAULT_TTL_HOURS} 小时`);
    return DEFAULT_TTL_HOURS;
  }
  if (h > MAX_TTL_HOURS) {
    warnings.push(`SESSION_TTL_HOURS 最多 ${MAX_TTL_HOURS}，按 ${MAX_TTL_HOURS} 小时`);
    return MAX_TTL_HOURS;
  }
  return h;
}

/** 按环境变量算出登录配置：不缓存、不写日志（命令行工具的 check 用它，自己打印结果） */
export function parseAuthConfig(env: Env): AuthConfig {
  const raw = (env.AUTH_ACCOUNTS ?? "").trim();
  const secret = (env.SESSION_SECRET ?? "").trim();
  const legacy = (env.ACCESS_CODE ?? "").trim();
  if (!raw && !secret && !legacy) return { mode: "open" };
  if (!raw) {
    return {
      mode: "broken",
      reason: legacy
        ? "ACCESS_CODE 已经停用（ADR-032）：请改用 AUTH_ACCOUNTS 配账号，步骤见 docs/deploy.md"
        : "设了 SESSION_SECRET，却没读到账号：AUTH_ACCOUNTS 是空的（多行写法要用英文双引号把整段括起来）",
    };
  }
  const allowE2E = env.AUTH_ALLOW_E2E_ACCOUNTS?.trim() === "1";
  const { accounts, errors, warnings } = parseAccounts(raw, { allowE2E });
  if (errors.length) return { mode: "broken", reason: errors.join("；") };
  if (!accounts.size) return { mode: "broken", reason: "AUTH_ACCOUNTS 里一个账号也没有（只写了注释？）" };
  if (secret.length < MIN_SECRET) {
    return {
      mode: "broken",
      reason: `${secret ? "SESSION_SECRET 太短" : "缺 SESSION_SECRET"}：配了账号就必须设，至少 ${MIN_SECRET} 个字符，用 npx tsx scripts/account.ts secret 生成`,
    };
  }
  // 端到端测试那把密钥写在仓库里（e2e/accounts.ts，以 e2e- 开头），抄进线上就谁都能伪造任何账号的 cookie
  if (secret.startsWith("e2e-") && !allowE2E) {
    return {
      mode: "broken",
      reason: "SESSION_SECRET 是端到端测试专用的那一把（随仓库公开），线上不能用：用 npx tsx scripts/account.ts secret 重新生成",
    };
  }
  // 11-08 安全复核：这个开关一开，仓库里公开的测试账号和测试密钥都会被认，线上设了要能在日志和 check 里看到
  if (allowE2E) warnings.push("设了 AUTH_ALLOW_E2E_ACCOUNTS=1：只给端到端测试用，线上必须删掉（测试账号和测试密钥都随仓库公开）");
  if (legacy) warnings.push("ACCESS_CODE 已经停用，不起作用，可以删掉");
  if ((env.ACCESS_TTL_HOURS ?? "").trim()) warnings.push("ACCESS_TTL_HOURS 已改名为 SESSION_TTL_HOURS，旧名不生效");
  const ttlMs = Math.round(ttlHours(env.SESSION_TTL_HOURS, warnings) * HOUR);
  // 能复核的账号：AUTH_REVIEWERS 写账号名，逗号或空格隔开。没设时所有账号都能复核（和以前一样）；
  // 设了以后只有这几个账号看得到复核按钮，别的账号（比如发给评委的）只能看（评审 R31）
  const rawReviewers = (env.AUTH_REVIEWERS ?? "").trim();
  let reviewers: Set<string> | undefined;
  if (rawReviewers) {
    reviewers = new Set();
    for (const item of rawReviewers.split(/[\s,]+/).filter(Boolean)) {
      const name = normalizeAccount(item);
      if (!name || !accounts.has(name))
        warnings.push(`AUTH_REVIEWERS 里的 ${name ?? "（写法不对的名字）"} 不在 AUTH_ACCOUNTS 里，不起作用`);
      else reviewers.add(name);
    }
  }
  return { mode: "accounts", accounts, secret, ttlMs, warnings, ...(reviewers ? { reviewers } : {}) };
}

// 和配置有关的几个变量；按原始字符串缓存，proxy 每个请求都要用，不用每次重新解析
const ENV_KEYS = [
  "AUTH_ACCOUNTS",
  "SESSION_SECRET",
  "ACCESS_CODE",
  "SESSION_TTL_HOURS",
  "AUTH_ALLOW_E2E_ACCOUNTS",
  "ACCESS_TTL_HOURS",
  "AUTH_REVIEWERS",
];
let cached: { key: string; config: AuthConfig } | undefined;
// 每种配置在一个进程里只往日志写一次（proxy 和各个接口是不同的模块副本，记在 globalThis 上）。只记哈希，不留原文
const g = globalThis as { __fencunAuthLogged?: Set<string> };
g.__fencunAuthLogged ??= new Set<string>();
const logged = g.__fencunAuthLogged;

function report(key: string, config: AuthConfig) {
  if (config.mode === "open") return;
  const id = createHash("sha256").update(key).digest("base64url");
  if (logged.has(id)) return;
  logged.add(id);
  // 只写原因和提醒：里面有账号名，没有记录和密钥
  if (config.mode === "broken") console.error(`[登录] 配置有问题，网站会拦住所有请求：${config.reason}`);
  else if (config.warnings.length) console.error(`[登录] 账号登录已启用，但有提醒：${config.warnings.join("；")}`);
}

export function authConfig(env: Env = process.env): AuthConfig {
  const key = JSON.stringify(ENV_KEYS.map((k) => env[k] ?? ""));
  if (cached?.key === key) return cached.config;
  const config = parseAuthConfig(env);
  cached = { key, config };
  report(key, config);
  return config;
}

/** 要不要登录：配了账号，或者配错了（这时全站拦住） */
export function authEnabled(): boolean {
  return authConfig().mode !== "open";
}

/** 接没接真实模型：模型或语音合成的密钥有值（lib/server/llm.ts 的 isLive() 只看模型密钥，这里连语音一起算） */
function liveKeys(): boolean {
  return Boolean((process.env.LLM_API_KEY ?? "").trim() || (process.env.TTS_API_KEY ?? "").trim());
}

function isLocalHost(host: string | null | undefined): boolean {
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/**
 * 没配账号、却接了真实模型，而且不是从本机打开的（Host 不是 localhost / 127.0.0.1 / [::1]）：当配置有问题拦住（11-06 安全复核）。
 * 防的是最常见的部署失误：复制 .env.example、只填了模型密钥、忘了配账号，网站就整个公开、谁都能花额度，而且不报任何错。
 * 评委在自己电脑上用自己的密钥跑（地址是 127.0.0.1 或 localhost）不受影响；模拟模式不花钱，也不管。
 * 这只是防手滑的保险，不是安全边界：故意伪造 Host 头的人还是进得来，真正的边界是配好账号。
 * proxy、requireSession、登录接口、页面外框都要用它，不然会出现 proxy 拦了、登录接口却直接放行这种不一致。
 */
export function openButNotLocal(host: string | null | undefined): boolean {
  if (authConfig().mode !== "open" || !liveKeys() || isLocalHost(host)) return false;
  if (!logged.has("open-but-not-local")) {
    logged.add("open-but-not-local");
    console.error(
      "[登录] 接了真实模型却没配账号：只许从本机（localhost、127.0.0.1）打开，别的地址一律拦住。要放到公网上先配账号（docs/deploy.md）",
    );
  }
  return true;
}

/** 当前生效的会话有效期（毫秒）。没配账号时也按 SESSION_TTL_HOURS 算，没设就是默认的 168 小时 */
export function sessionTtlMs(): number {
  const config = authConfig();
  return config.mode === "accounts" ? config.ttlMs : Math.round(ttlHours(process.env.SESSION_TTL_HOURS, []) * HOUR);
}

export interface Session {
  account: string;
  expiresAt: number;
}

/** 核对不存在的账号时拿来凑数的记录，不对应任何密码 */
const DUMMY_RECORD = `s1.15.8.3.${"A".repeat(22)}.${"A".repeat(43)}`;

function sign(secret: string, account: string, expiresAt: number, record: string): string {
  return createHmac("sha256", secret).update(`fencun-session-v1\n${account}\n${expiresAt}\n${record}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 登录成功后发的 cookie 值。账号必须在当前配置里 */
export function issueSession(account: string, now = Date.now()): { value: string; maxAgeSeconds: number } {
  const config = authConfig();
  const record = config.mode === "accounts" ? config.accounts.get(account) : undefined;
  if (config.mode !== "accounts" || record === undefined) throw new Error("没有启用账号登录，或者没有这个账号");
  const expiresAt = now + config.ttlMs;
  const value = `v1.${Buffer.from(account).toString("base64url")}.${expiresAt}.${sign(config.secret, account, expiresAt, record)}`;
  return { value, maxAgeSeconds: Math.floor(config.ttlMs / 1000) };
}

/**
 * 核对会话 cookie，通过了返回账号和到期时间。这些都当没登录：没配账号、格式不对、账号名的写法不规范、
 * 已经过期、到期时间比现在的有效期还远（有效期调短后，已经发出去的长 cookie 立即作废）、账号不在配置里、签名对不上。
 */
export function verifySession(value: string | undefined, now = Date.now()): Session | null {
  const config = authConfig();
  if (config.mode !== "accounts" || typeof value !== "string" || value.length > 200) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{13}$/.test(parts[2])) return null;
  const account = Buffer.from(parts[1], "base64url").toString("utf8");
  if (normalizeAccount(account) !== account || Buffer.from(account).toString("base64url") !== parts[1]) return null;
  const expiresAt = Number(parts[2]);
  if (expiresAt <= now || expiresAt > now + config.ttlMs + 60_000) return null;
  const record = config.accounts.get(account);
  // 账号不在配置里也照样算一次签名、比一次：耗时和账号存在时一样，拿伪造的 cookie 试不出哪些账号名存在
  const same = safeEqual(parts[3], sign(config.secret, account, expiresAt, record ?? DUMMY_RECORD));
  return same && record !== undefined ? { account, expiresAt } : null;
}

/** 从 Cookie 请求头里取一个 cookie。照 Next 自己的解析办法（同名的取最后一个），和页面里 cookies() 读到的一致 */
function readCookie(header: string | null, name: string): string | undefined {
  let found: string | undefined;
  for (const pair of (header ?? "").split(/; */)) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq) !== name) continue;
    try {
      found = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      // 编码写坏的不认
    }
  }
  return found;
}

export function sessionFromRequest(req: Request): Session | null {
  return verifySession(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
}

/** 是不是 https：地址本身是 https，或者前面的 nginx 写了 X-Forwarded-Proto: https（docs/deploy.md） */
export function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase() === "https";
}

export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

/**
 * 这个账号能不能做人工复核（评审 R31）：没配账号时（本机、评委自己运行）能；配了账号、没设 AUTH_REVIEWERS 时所有账号都能；
 * 设了 AUTH_REVIEWERS 时只有名单里的能。
 */
export function canReview(account: string | undefined): boolean {
  const config = authConfig();
  if (config.mode !== "accounts" || !config.reviewers) return true;
  return account !== undefined && config.reviewers.has(account);
}

/** 没登录时接口回的 401；proxy 也用这一份 */
export function authRequired(): Response {
  return Response.json(
    { error: "需要先登录：请打开 /login", code: "auth_required" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** 登录配置有问题时接口回的 503；具体原因只在服务端日志里 */
export function authBroken(): Response {
  return Response.json(
    { error: "服务器的登录设置有问题，暂时用不了", code: "auth_config" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * 每个接口（登录、退出除外）开头再核一次会话：proxy 之外的兜底，以后 matcher 写错了也不会漏放（11-06 安全复核）。
 * 没配账号返回 null（放行；接了真实模型又不是从本机打开的除外，见 openButNotLocal）；配置有问题回 503；没有有效会话回 401。
 */
export function requireSession(req: Request): Response | null {
  const config = authConfig();
  if (config.mode === "open") return openButNotLocal(req.headers.get("host")) ? authBroken() : null;
  if (config.mode === "broken") return authBroken();
  return sessionFromRequest(req) ? null : authRequired();
}
