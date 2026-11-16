// 页面外框：顶部是「分寸」印章、导航（主要视图）；已登录时右头是当前账号和「退出」（ADR-032）。
// AI 标识不再挂在顶栏（ADR-053（11-16 队员 B 修改稿 3））：现在只在形象旁边标「AI 角色」（components/Avatar.tsx）。
// 这一层不读 cookie，客户端组件（出错页 app/error.tsx）也能用；账号那块由服务端的 AppShell 传进来（account）。
// 窄屏上顶栏压成两行（ADR-047）：第一行 印章 + 账号，第二行是能左右滑的导航；样式在 globals.css 的 .app-header。
// 「用法」（队员 B 的建议 4）放在导航最后、单独一格：窄屏上导航左右滑，它钉在这一行的右头，哪一页都看得见。
// 「三种结局」不再放顶栏：它是个小实验，从「用法」和「原理」两页进（网址 /fates 不变）。

import { BookOpen, CircleHelp, Grid3x3, ListChecks, ScrollText, SquareTerminal, Swords } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import NavScroller from "./NavAutoScroll";

/** 顶栏导航（单元测试 tests/unit/guide.test.ts 认这里：没有三种结局，用法单独一格） */
export const NAV = [
  { href: "/workbench", label: "体检工作台", icon: SquareTerminal },
  { href: "/play", label: "打字闯关", icon: Swords },
  { href: "/suites", label: "用例库", icon: ListChecks },
  { href: "/runs", label: "运行记录", icon: ScrollText },
  { href: "/map", label: "攻防地图", icon: Grid3x3 },
  { href: "/settings", label: "原理", icon: BookOpen },
];
export const GUIDE = { href: "/guide", label: "用法", icon: CircleHelp };

const navItem = (current: boolean) =>
  `inline-flex items-center gap-1 border-b-2 px-2 py-1 text-sm whitespace-nowrap ${current ? "border-primary text-foreground" : "border-transparent text-muted hover:text-foreground"}`;

/** 「分寸」两个字竖排在一方朱红印里 */
export function BrandSeal({ size = 34 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="brand-seal inline-flex shrink-0 flex-col items-center justify-center rounded-[3px] bg-primary leading-none text-surface"
      // 大小用变量给（样式在 globals.css 的 .brand-seal）：窄屏的顶栏要把它压小一号
      style={{ "--seal": `${size}px`, fontFamily: "var(--font-kai)" } as CSSProperties}
    >
      <span>分</span>
      <span>寸</span>
    </span>
  );
}

export interface AppFrameProps {
  children: ReactNode;
  active?: string;
  /**
   * true：大屏上整页正好一屏高，里面的面板各自滚动（工作台用）；手机上照常整页往下滑。
   * "always"：手机、平板上也正好一屏高（闯关页用，ADR-047）；内容实在放不下时页面主体自己滚，不会被裁掉。
   */
  fill?: boolean | "always";
  /** 顶栏右上角的账号和「退出」；没登录时为空 */
  account?: ReactNode;
}

export default function AppFrame({ children, active, fill = false, account }: AppFrameProps) {
  const shell = fill === "always" ? "app-fill" : fill ? "min-h-screen lg:h-dvh lg:min-h-0" : "min-h-screen";
  // "always" 时主体滚不滚写在 globals.css 的 .app-fill 里（要和闯关版面用同一套宽高条件）
  const body = fill === true ? "lg:overflow-hidden" : "";
  return (
    <div className={`flex flex-col ${shell}`}>
      <header className="app-header">
        <Link href="/workbench" className="flex shrink-0 items-center gap-2" aria-label="分寸 · AI 语音角色安全体检台">
          <BrandSeal />
          <span className="app-brand-text flex flex-col leading-tight">
            <span className="app-brand-name text-lg tracking-[0.2em]" style={{ fontFamily: "var(--font-serif)" }}>
              分寸
            </span>
            <span className="hidden text-[11px] text-muted sm:inline">AI 语音角色安全体检台</span>
          </span>
        </Link>
        <nav aria-label="主导航" className="app-nav-row no-print">
          {/* 窄屏上这一行左右滑，哪头还有被挡住的页面，哪头就有「‹」「›」（NavAutoScroll.tsx） */}
          <NavScroller>
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} aria-current={active === href ? "page" : undefined} className={navItem(active === href)}>
                <Icon size={15} aria-hidden />
                {label}
              </Link>
            ))}
          </NavScroller>
          <Link
            href={GUIDE.href}
            aria-current={active === GUIDE.href ? "page" : undefined}
            title="每一页做什么，一页看完"
            className={`app-nav-guide ${navItem(active === GUIDE.href)}`}
          >
            <GUIDE.icon size={15} aria-hidden />
            {GUIDE.label}
          </Link>
        </nav>
        {/* ADR-053（11-16 队员 B 修改稿 3）：顶栏常驻的「被测对象是 AI 角色，不是真人」删了，
            AI 标识只留形象旁边的「AI 角色」小印（components/Avatar.tsx）；这里只放账号和「退出」 */}
        <div className="app-header-side">{account}</div>
      </header>
      <main className={`flex min-h-0 flex-1 flex-col ${body}`}>{children}</main>
    </div>
  );
}
