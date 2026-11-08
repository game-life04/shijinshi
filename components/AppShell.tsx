// 页面外框（服务端组件）：外框本身在 AppFrame；这里把当前登录的账号和「退出」放进顶栏（ADR-032）。各页面照旧从这里引。
// 顺手做页面的兜底检查（11-06 安全复核）：除登录页外所有页面都包在这里，要登录却没有有效会话就跳登录页，配置有问题就说明原因。
// 平时 proxy 已经拦过，这里只在 matcher 哪天写错时起作用。先读 cookie 再看配置，原因见 lib/server/session.ts。
// 出错页 app/error.tsx 是客户端组件，不能读 cookie，直接用 AppFrame，不显示账号。

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { authConfig, openButNotLocal } from "@/lib/server/auth";
import { getSession } from "@/lib/server/session";
import AccountMenu from "./AccountMenu";
import AppFrame from "./AppFrame";

export { BrandSeal } from "./AppFrame";

export default async function AppShell({ children, active, fill }: { children: ReactNode; active?: string; fill?: boolean }) {
  const session = await getSession();
  const config = authConfig();
  if (config.mode === "broken" || openButNotLocal((await headers()).get("host"))) redirect("/login?error=config");
  if (config.mode === "accounts" && !session) redirect("/login");
  return (
    <AppFrame active={active} fill={fill} account={<AccountMenu />}>
      {children}
    </AppFrame>
  );
}
