// 页面外框：顶部是「分寸」印章、导航（主要视图）和常驻的 AI 标识；已登录时标识旁边是当前账号和「退出」（ADR-032）。
// 这一层不读 cookie，客户端组件（出错页 app/error.tsx）也能用；账号那块由服务端的 AppShell 传进来（account）。

import { Clapperboard, ListChecks, ScrollText, Settings, SquareTerminal, Swords } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

const NAV = [
  { href: "/workbench", label: "体检工作台", icon: SquareTerminal },
  { href: "/play", label: "打字闯关", icon: Swords },
  { href: "/fates", label: "三种结局", icon: Clapperboard },
  { href: "/suites", label: "用例库", icon: ListChecks },
  { href: "/runs", label: "运行记录", icon: ScrollText },
  { href: "/settings", label: "设置", icon: Settings },
];

/** 「分寸」两个字竖排在一方朱红印里 */
export function BrandSeal({ size = 34 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 flex-col items-center justify-center rounded-[3px] bg-primary leading-none text-surface"
      style={{ width: size, height: size, fontFamily: "var(--font-kai)", fontSize: size * 0.4 }}
    >
      <span>分</span>
      <span>寸</span>
    </span>
  );
}

export interface AppFrameProps {
  children: ReactNode;
  active?: string;
  /** 大屏上整页正好一屏高，里面的面板各自滚动（工作台用）；手机上照常整页往下滑 */
  fill?: boolean;
  /** 顶栏右上角、AI 标识旁边的账号和「退出」；没登录时为空 */
  account?: ReactNode;
}

export default function AppFrame({ children, active, fill = false, account }: AppFrameProps) {
  return (
    <div className={`flex min-h-screen flex-col ${fill ? "lg:h-dvh lg:min-h-0" : ""}`}>
      <header className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border bg-surface px-4 py-2">
        <Link href="/workbench" className="flex items-center gap-2" aria-label="分寸 · AI 语音角色安全体检台">
          <BrandSeal />
          <span className="flex flex-col leading-tight">
            <span className="text-lg tracking-[0.2em]" style={{ fontFamily: "var(--font-serif)" }}>
              分寸
            </span>
            <span className="hidden text-[11px] text-muted sm:inline">AI 语音角色安全体检台</span>
          </span>
        </Link>
        <nav aria-label="主导航" className="no-print flex flex-wrap gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active === href ? "page" : undefined}
              className={`inline-flex items-center gap-1 border-b-2 px-2 py-1 text-sm ${active === href ? "border-primary text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
            >
              <Icon size={15} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          <span
            className="rounded-sm border border-border px-2 py-0.5 text-xs text-muted"
            title="依据《人工智能生成合成内容标识办法》与拟人化互动管理办法第十八条"
          >
            被测对象是 AI 角色，不是真人 · 角色回复由 AI 生成
          </span>
          {account}
        </div>
      </header>
      <main className={`flex min-h-0 flex-1 flex-col ${fill ? "lg:overflow-hidden" : ""}`}>{children}</main>
    </div>
  );
}
