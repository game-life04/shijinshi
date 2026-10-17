// 页面外框：顶部导航（五个主要视图）+ 常驻的 AI 标识。

import { FlaskConical, ListChecks, ScrollText, Settings, SquareTerminal } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

const NAV = [
  { href: "/workbench", label: "体检工作台", icon: SquareTerminal },
  { href: "/suites", label: "用例库", icon: ListChecks },
  { href: "/runs", label: "运行记录", icon: ScrollText },
  { href: "/settings", label: "设置", icon: Settings },
];

export default function AppShell({ children, active }: { children: ReactNode; active?: string }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-2">
        <Link href="/workbench" className="flex items-center gap-1.5 font-semibold">
          <FlaskConical size={18} className="text-primary" aria-hidden />
          试金石
          <span className="hidden text-xs font-normal text-muted sm:inline">AI 语音角色安全体检与流式保护工作台</span>
        </Link>
        <nav aria-label="主导航" className="flex flex-wrap gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active === href ? "page" : undefined}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-sm ${active === href ? "bg-primary-soft text-primary" : "text-muted hover:text-foreground"}`}
            >
              <Icon size={15} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
        <span
          className="ml-auto rounded border border-border px-2 py-0.5 text-xs text-muted"
          title="依据《人工智能生成合成内容标识办法》与拟人化互动管理办法第十八条"
        >
          被测对象是 AI 角色，不是真人 · 角色回复由 AI 生成
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
