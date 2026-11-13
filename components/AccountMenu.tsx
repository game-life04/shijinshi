// 顶栏右上角的当前账号和「退出」（11-06，ADR-032）。服务端组件：自己读 cookie、核签名（lib/server/session.ts），
// 没登录、没配账号时什么都不显示。退出用普通表单 POST 到 /api/logout，页面脚本没加载出来也能退。
// 按钮上写「退出」，读屏名字是「退出登录」：「退出」在这个产品里也是一类测试和护栏原因的名字，免得听混。打印体检单时不印这一块。

import { CircleUserRound } from "lucide-react";
import { getSession } from "@/lib/server/session";

export default async function AccountMenu() {
  const session = await getSession();
  if (!session) return null;
  return (
    <div className="no-print flex items-center gap-2 text-xs text-muted">
      <span className="inline-flex min-w-0 items-center gap-1" title="当前登录的账号">
        <CircleUserRound size={14} aria-hidden className="shrink-0" />
        {/* 手机上顶栏第一行很挤：账号名太长就截断（鼠标停上去、读屏照样是全名） */}
        <span className="max-w-[4.5rem] truncate sm:max-w-none">{session.account}</span>
      </span>
      <form method="post" action="/api/logout">
        <button
          type="submit"
          aria-label="退出登录"
          className="rounded-sm border border-border px-2 py-0.5 whitespace-nowrap hover:text-foreground"
        >
          退出
        </button>
      </form>
    </div>
  );
}
