// 上线演示时的登录页（ADR-028）：输入访问码进入。用普通表单提交，页面脚本没加载出来也能登录。
// 没设 ACCESS_CODE 时说明不需要登录，给出进入工作台的入口。

import type { Metadata } from "next";
import Link from "next/link";
import { accessCode, accessTtlMs, safeNext } from "@/lib/server/access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "登录 · 分寸" };

const ERRORS: Record<string, string> = {
  code: "访问码不对，请再输一次。",
  limit: "试得太频繁了，请 10 分钟后再试。",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : "/");
  const error = typeof sp.error === "string" ? ERRORS[sp.error] : undefined;
  const days = Math.max(1, Math.round(accessTtlMs() / 86_400_000));
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4 rounded-sm border border-border bg-surface p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
            分寸
          </h1>
          <p className="text-sm text-muted">AI 语音角色安全体检台</p>
        </div>
        {accessCode() ? (
          <form method="post" action="/api/login" className="space-y-3">
            <input type="hidden" name="next" value={next} />
            <label className="block space-y-1 text-sm">
              <span className="font-medium">访问码</span>
              <input
                name="code"
                type="password"
                required
                autoComplete="current-password"
                aria-describedby={error ? "login-error" : undefined}
                className="h-9 w-full rounded-sm border border-border bg-background px-2 focus-visible:outline-2 focus-visible:outline-primary"
              />
            </label>
            {error && (
              <p id="login-error" role="alert" className="text-sm text-bad">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="inline-flex h-9 w-full items-center justify-center rounded-sm bg-primary px-3 text-sm font-medium text-surface hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              进入
            </button>
            <p className="text-xs text-muted">访问码由参赛队提供。登录后 {days} 天内在这台设备上不用再输。</p>
          </form>
        ) : (
          <p className="text-sm">
            这台服务器没有设访问码，不用登录。{" "}
            <Link href="/workbench" className="font-medium text-primary underline">
              进入体检工作台
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
