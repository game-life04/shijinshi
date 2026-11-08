// 账号命令行工具（11-06，ADR-032）：生成账号记录和会话密钥，检查服务器上的登录配置。在仓库根目录运行：
//   npx tsx scripts/account.ts add <账号名>          生成一条账号记录：密码输两遍，输入时不显示。标准输出只有一行「账号名:记录」，
//                                                    照标准错误里的说明加进服务器 .env.local 的 AUTH_ACCOUNTS
//   npx tsx scripts/account.ts add <账号名> --stdin  从管道读密码（只读第一行），给自动化用。bash 里先 read -rs PW，
//                                                    再 printf '%s\n' "$PW" | npx tsx scripts/account.ts add <账号名> --stdin
//   npx tsx scripts/account.ts secret               生成一个 SESSION_SECRET（32 个随机字节，base64url）
//   npx tsx scripts/account.ts check                照 next start 的读法读当前目录的 .env*（包括 $ 展开），报告模式、
//                                                    账号个数和名字、哪一条有问题；不打印记录和密钥
// 隐藏输入：PowerShell、cmd、Windows Terminal 直接能用（npx 被执行策略拦住时改用 npx.cmd）。Git Bash（mintty）里 node 拿到的是
//   管道、不是终端，没法隐藏输入，这时报错并提示改用 winpty。任何情况都不退回到明文回显。
// 不留痕迹：不接受从命令行参数传密码（会进 shell 历史和进程列表），不写任何文件，报错信息里不带密码。
// 退出码：0 成功；1 输入不合格；2 用法不对，或者当前环境没法隐藏输入；130 按了 Ctrl+C。

import { randomBytes } from "node:crypto";
import { emitKeypressEvents } from "node:readline";
// @next/env 随 next 一起装（next 用它读 .env），用它才能和 next start 读到的一模一样
import { loadEnvConfig } from "@next/env";
import { normalizeAccount, parseAuthConfig } from "../lib/server/auth";
import { hashPassword, normalizePassword } from "../lib/server/password";

const HOUR = 3_600_000;
const MAX_STDIN = 4096;
/** 太常见的词：密码里出现了就不收 */
const WEAK = ["12345678", "password", "qwerty", "fencun", "shijinshi", "qiyetao", "admin"];
const USAGE = "用法：npx tsx scripts/account.ts add <账号名> [--stdin] | secret | check";

/** 用户按了 Ctrl+C / Ctrl+D */
class Cancelled extends Error {}
/** 输入不合格：退出码 1 */
class BadInput extends Error {}

const err = (s: string) => process.stderr.write(`${s}\n`);

/** 控制字符（C0、DEL、C1）：回车、退格这些不能进密码 */
function hasControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** 在终端里读一行，不回显：回车结束，退格删一个字，Ctrl+C、Ctrl+D 取消，方向键和别的控制键不当输入 */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const chars: string[] = [];
    process.stderr.write(label);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const finish = (value: string | null) => {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (value === null) reject(new Cancelled());
      else resolve(value);
    };
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish(null);
      if (key.name === "return" || key.name === "enter") return finish(chars.join(""));
      // \b 和 \x7f 都会被 readline 认成 backspace
      if (key.name === "backspace") {
        chars.pop();
        return;
      }
      if (key.ctrl || key.meta || typeof str !== "string" || hasControl(str)) return;
      chars.push(...str);
    };
    input.on("keypress", onKey);
  });
}

/** 从管道读第一行：去掉开头的 BOM 和行尾的换行，最多读 4 KB；编码坏了（读到 U+FFFD）就报错 */
async function readStdinLine(): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > MAX_STDIN) throw new BadInput("标准输入太长：只读第一行，最多 4 KB");
    parts.push(b);
    if (b.includes(0x0a)) break;
  }
  let text = Buffer.concat(parts).toString("utf8");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text.includes("\uFFFD")) {
    throw new BadInput("标准输入不是 UTF-8 编码（比如 cmd 按 GBK 传进来的中文）：管道里只用英文字母、数字和符号，或者改用交互输入");
  }
  return text.split(/\r?\n/, 1)[0] ?? "";
}

/** 生成记录前对密码的要求（只在这里查；服务器登录时只限最长 128 个字符） */
function passwordProblem(raw: string, pw: string | null, account: string): string | null {
  if (raw === "") return "没有读到密码";
  if (pw === null) return "密码太长：最多 128 个字符";
  if (hasControl(pw)) return "密码里不能有控制字符";
  if ([...pw].length < 12) return "密码太短：至少 12 个字符";
  const low = pw.toLowerCase();
  if (low.includes(account)) return "密码里不能包含账号名";
  if (new Set(pw).size < 4) return "密码太单调：不同的字符至少要有 4 种";
  if (WEAK.some((w) => low.includes(w))) return "密码里有太常见的词（比如 password、12345678、admin 或者项目名）";
  return null;
}

function cannotHide(): number {
  err(
    process.env.MSYSTEM
      ? "Git Bash 里读不到隐藏输入（node 拿到的是管道，不是终端）。改用 winpty node --import tsx scripts/account.ts add <账号名>，或者到 PowerShell 里运行；要从管道读密码请加 --stdin。"
      : "标准输入不是终端，没法隐藏输入；要从管道读密码请加 --stdin。",
  );
  return 2;
}

async function add(args: string[]): Promise<number> {
  const names = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  // 别的参数一律不认，也不把它们原样打出来（万一里面是密码）
  if (names.length !== 1 || flags.some((f) => f !== "--stdin")) {
    err(USAGE);
    return 2;
  }
  const account = normalizeAccount(names[0]);
  if (!account) {
    err("账号名只能是 2～32 位字母、数字和 . _ -，以字母或数字开头（大写会转成小写）");
    return 2;
  }
  if (account !== names[0]) err(`账号名记为 ${account}`);
  if (account.startsWith("e2e-")) err("提醒：e2e- 开头的是端到端测试专用的账号，线上服务器不认。");
  let raw: string;
  if (flags.includes("--stdin")) {
    if (process.stdin.isTTY) {
      err("--stdin 只用于从管道读密码；要自己输入请去掉 --stdin");
      return 2;
    }
    // Git Bash（mintty）里分不出是管道还是人在打字，直接打字会显示在屏幕上（11-08 复核）
    if (process.env.MSYSTEM) err("正在从管道读密码。如果你是在直接打字，屏幕会显示密码：请按 Ctrl+C，改用 winpty 运行、去掉 --stdin。");
    raw = await readStdinLine();
    // Windows PowerShell 5.1 的管道默认先把每个中文字换成「?」再传过来，到这里已经是合法的字，认不出来（11-08 复核实测）
    if (process.platform === "win32" && raw.includes("?")) {
      err(
        "提醒：读到的密码里有「?」。Windows PowerShell 5.1 的管道会把中文悄悄换成「?」：原密码里要是有中文，这条记录就对不上你的密码。" +
          "请改用交互输入（去掉 --stdin），或者先运行 $OutputEncoding = [Text.UTF8Encoding]::new($false) 再用管道。",
      );
    }
  } else {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return cannotHide();
    const first = await promptHidden("密码（输入时不显示）：");
    const second = await promptHidden("再输一遍：");
    if (first.normalize("NFKC") !== second.normalize("NFKC")) throw new BadInput("两次输入的不一样，什么都没生成。");
    raw = first;
  }
  const pw = normalizePassword(raw);
  const problem = passwordProblem(raw, pw, account);
  if (problem || pw === null) throw new BadInput(`${problem}；什么都没生成。`);
  if (/[^ -~]/.test(pw)) err("提醒：密码里有中文或其他非 ASCII 字符，评委的电脑上不一定好输入。");
  const record = await hashPassword(pw);
  process.stdout.write(`${account}:${record}\n`);
  err(
    "把上面这一行加进服务器 .env.local 的 AUTH_ACCOUNTS（一行一条时要用英文双引号把整段括起来，也可以用英文逗号隔开写成一行），重启服务后生效。",
  );
  err("同名账号的旧记录要删掉；换了记录，这个账号已经登录的设备都要重新登录。账号名和密码私下发给要用的人，别发到群里。");
  return 0;
}

function secret(): number {
  process.stdout.write(`${randomBytes(32).toString("base64url")}\n`);
  err("写进服务器 .env.local 的 SESSION_SECRET。不要提交到仓库；换掉它，所有人都要重新登录。");
  return 0;
}

function check(): number {
  // 和 next start 一样：读 .env.production.local、.env.local、.env.production、.env，已有的环境变量优先
  const { loadedEnvFiles } = loadEnvConfig(process.cwd(), false, { info() {}, error: (message: unknown) => err(String(message)) });
  const files = loadedEnvFiles.map((f) => f.path);
  console.log(`读了 ${process.cwd()} 下的：${files.length ? files.join("、") : "（没有 .env 文件）"}`);
  if (process.env.NODE_ENV === "test") console.log("注意：NODE_ENV=test 时 Next 不读 .env.local。");
  const config = parseAuthConfig(process.env);
  if (config.mode === "open") {
    console.log("没有配置账号：网站不要求登录，也默认不限流，只适合本机或可信的网络。要放到公网上，先照 docs/deploy.md 配账号。");
    if ((process.env.LLM_API_KEY ?? "").trim() || (process.env.TTS_API_KEY ?? "").trim()) {
      console.log("填了模型密钥却没配账号：网站只许从本机（127.0.0.1、localhost）打开，别的地址一律拦住。");
    }
    return 0;
  }
  if (config.mode === "broken") {
    console.log(`配置有问题，网站会拦住所有请求：${config.reason}`);
    return 1;
  }
  const names = [...config.accounts.keys()];
  console.log(
    `账号登录已启用：${names.length} 个账号（${names.join("、")}）；SESSION_SECRET 长度够；登录一次管 ${config.ttlMs / HOUR} 小时。`,
  );
  for (const w of config.warnings) console.log(`提醒：${w}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "add") return await add(rest);
    if (cmd === "secret" && rest.length === 0) return secret();
    if (cmd === "check" && rest.length === 0) return check();
    err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof Cancelled) {
      err("已取消，什么都没生成。");
      return 130;
    }
    if (e instanceof BadInput) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}

/** 等标准输出、标准错误都写完再退出（Windows 终端上写是异步的，直接退出可能丢字） */
const flush = (s: NodeJS.WriteStream) => new Promise<void>((resolve) => s.write("", () => resolve()));

main(process.argv.slice(2)).then(
  async (code) => {
    await Promise.all([flush(process.stdout), flush(process.stderr)]);
    process.exit(code);
  },
  async (e) => {
    err(`出错了：${e instanceof Error ? e.message : String(e)}`);
    await flush(process.stderr);
    process.exit(1);
  },
);
