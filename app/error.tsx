"use client";

// 页面渲染出错时显示（Next 的 error 文件约定，必须是客户端组件）：说清楚发生了什么，给出重试和回工作台两个出口；
// 已经跑完的运行都落了盘，出错不会丢结果（规格 01 §2.3：每个异常状态都要有可执行的恢复操作）。
// 生产环境里服务端错误的原文不会传到浏览器，只显示一个编号，方便到服务端日志里对上。

import { RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <AppShell>
      <div role="alert" className="mx-auto mt-16 max-w-md space-y-3 rounded-sm border border-border bg-surface p-6 text-center text-sm">
        <h1 className="flex items-center justify-center gap-1.5 text-lg font-semibold">
          <TriangleAlert size={18} className="text-primary" aria-hidden />
          这个页面出了点问题
        </h1>
        <p className="text-muted">
          已经跑完的体检结果都保存着，不会因为这次出错丢失。可以先重试；还不行就回到工作台，或到运行记录里找刚才那次。
        </p>
        {error.digest && <p className="font-mono text-xs text-muted">错误编号 {error.digest}</p>}
        <div className="flex justify-center gap-2">
          <Button variant="primary" onClick={() => retry()}>
            <RotateCcw size={14} aria-hidden />
            重试
          </Button>
          <Link href="/runs" className="inline-flex h-8 items-center rounded-sm border border-border px-3 hover:bg-background">
            运行记录
          </Link>
          <Link href="/workbench" className="inline-flex h-8 items-center rounded-sm border border-border px-3 hover:bg-background">
            回到工作台
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
