import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hashPasswordSync, verifyPassword } from "@/lib/server/password";

// 账号命令行工具 scripts/account.ts（ADR-032）：真起一个 node 进程来跑，标准输入走管道（不是终端）。
// check 要读 .env*：只在临时目录里放测试用的 .env.local 跑，碰不到仓库里真的 .env.local。
const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "account.ts");
// 按绝对地址加载 tsx：在临时目录里跑 check 时，从当前目录找不到它
const TSX = pathToFileURL(createRequire(path.join(ROOT, "package.json")).resolve("tsx")).href;
// 这些不从测试进程带过去：NODE_ENV=test 时 Next 不读 .env.local；MSYSTEM 在 Git Bash 里会有
const CLEAR = [
  "AUTH_ACCOUNTS",
  "SESSION_SECRET",
  "ACCESS_CODE",
  "SESSION_TTL_HOURS",
  "ACCESS_TTL_HOURS",
  "AUTH_ALLOW_E2E_ACCOUNTS",
  "NODE_ENV",
  "__NEXT_PROCESSED_ENV",
  "MSYSTEM",
];
const PW = "kq7-ma3x-29pd";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], o: { input?: string | Buffer; cwd?: string; env?: Record<string, string> } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CLEAR) delete env[k];
  Object.assign(env, o.env);
  const r = spawnSync(process.execPath, ["--import", TSX, SCRIPT, ...args], {
    cwd: o.cwd ?? ROOT,
    env,
    input: o.input ?? "",
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** 临时目录，里面只放测试用的 .env.local（不传内容就是空目录） */
function envDir(content?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fencun-check-"));
  dirs.push(dir);
  if (content !== undefined) writeFileSync(path.join(dir, ".env.local"), content);
  return dir;
}

const recordOf = (out: string, account: string) => out.trim().slice(account.length + 1);

describe("账号命令行工具（scripts/account.ts）", { timeout: 60_000 }, () => {
  it("add --stdin：标准输出正好一行「账号名:记录」，记录能核对；标准输出和标准错误里都没有密码", async () => {
    const r = run(["add", "Judge-X", "--stdin"], { input: `${PW}\n` });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^judge-x:s1\.15\.8\.3\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\n$/);
    expect(await verifyPassword(PW, recordOf(r.out, "judge-x"))).toBe(true);
    expect(r.out + r.err).not.toContain(PW);
    // Windows 上的管道可能带 BOM 和 \r\n，都去掉
    const bom = run(["add", "judge-x", "--stdin"], { input: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${PW}\r\n`)]) });
    expect(bom.code).toBe(0);
    expect(await verifyPassword(PW, recordOf(bom.out, "judge-x"))).toBe(true);
  });

  it("密码不合格（太短、常见词、含账号名、太单调、编码坏了）：退出码 1，标准输出为空，提示里不带密码", () => {
    for (const pw of ["short-1A", "password-0123456", "judge-x-0123456789", "abababababababab"]) {
      const r = run(["add", "judge-x", "--stdin"], { input: `${pw}\n` });
      expect(r.code, pw).toBe(1);
      expect(r.out, pw).toBe("");
      expect(r.err, pw).not.toContain(pw);
    }
    const garbled = run(["add", "judge-x", "--stdin"], { input: Buffer.from([0x6b, 0x71, 0xff, 0xfe, 0x37, 0x0a]) });
    expect(garbled.code).toBe(1);
    expect(garbled.out).toBe("");
    expect(garbled.err).toContain("UTF-8");
  });

  it("没有终端又没加 --stdin：退出码 2 并提示怎么办（Git Bash 里提示 winpty）；用法不对也是 2，不把参数原样打出来", () => {
    const piped = run(["add", "judge-x"]);
    expect(piped.code).toBe(2);
    expect(piped.out).toBe("");
    expect(piped.err).toContain("--stdin");
    const gitBash = run(["add", "judge-x"], { env: { MSYSTEM: "MINGW64" } });
    expect(gitBash.code).toBe(2);
    expect(gitBash.err).toContain("winpty");
    const odd = run(["add", "judge-x", "--pw=hunter2-hunter2"]);
    expect(odd.code).toBe(2);
    expect(odd.err).not.toContain("hunter2");
    expect(run([]).code).toBe(2);
  });

  it("secret：输出 43 位 base64url，每次都不一样", () => {
    const a = run(["secret"]);
    const b = run(["secret"]);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(a.out).not.toBe(b.out);
  });

  it("check：照 next start 的读法读 .env.local；没配账号回 0，配好了列出账号回 0，配错了回 1；都不打印记录和密钥", () => {
    const empty = run(["check"], { cwd: envDir() });
    expect(empty.code).toBe(0);
    expect(empty.out).toContain("没有配置账号");
    const secret = randomBytes(32).toString("base64url");
    const recA = hashPasswordSync("judge-a-pass-123");
    const recB = hashPasswordSync("team-b-pass-456");
    const good = run(["check"], {
      cwd: envDir(`SESSION_SECRET=${secret}\nAUTH_ACCOUNTS="\n# 评委\njudge-01:${recA}\nteam.b:${recB}\n"\n`),
    });
    expect(good.code).toBe(0);
    expect(good.out).toContain(".env.local");
    expect(good.out).toContain("2 个账号（judge-01、team.b）");
    const phc = run(["check"], { cwd: envDir(`SESSION_SECRET=${secret}\nAUTH_ACCOUNTS=judge-01:$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA\n`) });
    expect(phc.code).toBe(1);
    expect(phc.out).toContain("配置有问题");
    const legacy = run(["check"], { cwd: envDir("ACCESS_CODE=old-access-code\n") });
    expect(legacy.code).toBe(1);
    expect(legacy.out).toContain("ACCESS_CODE");
    for (const r of [good, phc, legacy]) {
      for (const s of [secret, recA, recB, recA.split(".")[5], "old-access-code"]) expect(r.out + r.err).not.toContain(s);
    }
  });

  it("源码里不写文件，也不收从命令行参数传的密码", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream/);
    expect(src).not.toContain("--password");
  });
});
