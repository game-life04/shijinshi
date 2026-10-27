// 访问了不存在的地址时显示：说明原因，并给出回到工作台的入口（规格 01 §2.3：每个异常状态都要有可执行的恢复操作）。

import Link from "next/link";
import AppShell from "@/components/AppShell";

export default function NotFound() {
  return (
    <AppShell>
      <div className="mx-auto mt-16 max-w-md space-y-3 rounded-md border border-border bg-surface p-6 text-center text-sm">
        <h1 className="text-lg font-semibold">这个地址没有对应的页面</h1>
        <p className="text-muted">可能是网址多带了符号（例如从聊天里复制时带上了标点）。</p>
        <Link href="/workbench" className="inline-flex h-8 items-center rounded bg-primary px-4 font-medium text-white hover:opacity-90">
          回到体检工作台
        </Link>
      </div>
    </AppShell>
  );
}
