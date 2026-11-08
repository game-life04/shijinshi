// 账号密码的哈希和核对（11-06，ADR-032）。只依赖 node:crypto：登录接口、命令行工具 scripts/account.ts、测试都用这一份。
//   记录格式：s1.<logN>.<r>.<p>.<盐>.<哈希>。盐 16 字节、哈希 32 字节，都写成 base64url，整条只有字母、数字和 . _ -，
//         Next 读 .env 时的 $ 展开、# 截断都碰不到它。每次生成都用新的随机盐，同一个密码两次生成的记录也不一样。
//   算法：scrypt，默认 N=2^15、r=8、p=3，每次占 32 MiB 内存，本机约 0.2 秒。Node 默认的内存上限（maxmem）比这组参数
//         实际要的少一点，不放宽会直接报错，所以每次都按参数算好上限再传进去。
//   账号不存在时，拿一条固定的假记录（参数和默认一样）照样算一次：耗时和密码不对一样，从快慢上看不出账号存不存在。
//   同时最多算 2 个、排队最多 16 个，再多直接回「忙」（BusyError）。Node 的线程池默认只有 4 个，要给读写文件、DNS 留位置；
//         有人大量刷登录时，登录排队变慢，网站别的功能照常。

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

export interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}

export const SCRYPT_DEFAULT = { logN: 15, r: 8, p: 3 } as const;

const RECORD_RE = /^s1\.(\d{2})\.(\d{1,2})\.(\d{1,2})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const MAX_RUNNING = 2;
const MAX_WAITING = 16;

/** 同时核对密码的请求排满了：登录页提示「登录的人有点多，请过几秒再试」 */
export class BusyError extends Error {
  constructor() {
    super("同时核对密码的请求太多");
    this.name = "BusyError";
  }
}

const inRange = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

/** 参数超出这个范围的记录一律不认，免得配置里写出离谱的参数拖垮服务器 */
function paramsOk({ logN, r, p }: ScryptParams): boolean {
  return inRange(logN, 14, 20) && inRange(r, 8, 16) && inRange(p, 1, 16);
}

/** 登录时输入的密码：只做 NFKC（全角输入法打出来的「ＡＢＣ１２３」和半角的一样），不去空格。空的、超长的返回 null */
export function normalizePassword(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  const s = raw.normalize("NFKC");
  return s.length >= 1 && s.length <= 128 ? s : null;
}

/** 拆开一条记录；格式、参数范围、盐和哈希的长度有一样不对就返回 null */
export function parseRecord(record: string): (ScryptParams & { salt: Buffer; hash: Buffer }) | null {
  const m = RECORD_RE.exec(record);
  if (!m) return null;
  const params = { logN: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  if (!paramsOk(params)) return null;
  const salt = Buffer.from(m[4], "base64url");
  const hash = Buffer.from(m[5], "base64url");
  if (salt.length !== 16 || hash.length !== 32) return null;
  // 再编码回去要和原文一样：末尾那个字符里多余的位写法不同、解出来却一样的，只认规范写法
  if (salt.toString("base64url") !== m[4] || hash.toString("base64url") !== m[5]) return null;
  return { ...params, salt, hash };
}

function scryptOptions({ logN, r, p }: ScryptParams) {
  const N = 2 ** logN;
  // OpenSSL 实际要 128·r·(N+2) + 128·r·p 字节，再多留 1 MiB
  return { N, r, p, maxmem: 128 * r * (N + p + 2) + 1024 * 1024 };
}

function derive(password: string, params: ScryptParams, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, scryptOptions(params), (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function formatRecord(params: ScryptParams, salt: Buffer, hash: Buffer): string {
  return `s1.${params.logN}.${params.r}.${params.p}.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

function checkParams(params: ScryptParams) {
  if (!paramsOk(params)) throw new Error("scrypt 参数超出范围：logN 14～20、r 8～16、p 1～16");
}

/** 生成一条记录（命令行工具用）："s1.15.8.3.盐.哈希" */
export async function hashPassword(pw: string, params: ScryptParams = SCRYPT_DEFAULT): Promise<string> {
  checkParams(params);
  const salt = randomBytes(16);
  return formatRecord(params, salt, await derive(pw, params, salt));
}

/** 同步版，只给端到端测试的配置（加载配置时现算测试账号的记录）和单元测试用 */
export function hashPasswordSync(pw: string, params: ScryptParams = SCRYPT_DEFAULT): string {
  checkParams(params);
  const salt = randomBytes(16);
  return formatRecord(params, salt, scryptSync(pw, salt, 32, scryptOptions(params)));
}

// 未知账号用的假记录：参数和真记录一样，盐和哈希是固定值，不对应任何密码
const DUMMY = { ...SCRYPT_DEFAULT, salt: Buffer.alloc(16, 7), hash: Buffer.alloc(32) };

interface Gate {
  running: number;
  waiting: (() => void)[];
}
// 放在 globalThis 上：同一个进程里不管这个模块被打包了几份，都共用一个闸门
const g = globalThis as { __fencunScrypt?: Gate };
g.__fencunScrypt ??= { running: 0, waiting: [] };
const gate = g.__fencunScrypt;

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (gate.running < MAX_RUNNING) gate.running++;
  else if (gate.waiting.length < MAX_WAITING) await new Promise<void>((resolve) => gate.waiting.push(resolve));
  else throw new BusyError();
  try {
    return await fn();
  } finally {
    // 有人在排队，就把这个名额直接交给他；没人排队才腾出来
    const next = gate.waiting.shift();
    if (next) next();
    else gate.running--;
  }
}

/**
 * 核对密码。pw 为 null（空的或超长）、record 为 null（账号不存在）时也照样算一次哈希，然后返回 false。
 * 排满了抛 BusyError。
 */
export async function verifyPassword(pw: string | null, record: string | null): Promise<boolean> {
  const real = record === null ? null : parseRecord(record);
  const use = real ?? DUMMY;
  const key = await withSlot(() => derive(pw ?? "", use, use.salt));
  const same = timingSafeEqual(key, use.hash);
  return real !== null && pw !== null && same;
}
