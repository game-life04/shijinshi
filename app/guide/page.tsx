// 用法页（队员 B 的建议 4）。内容在 components/Guide.tsx；这里只认地址里的 next：
// 第一次登录时登录接口把人送到 /guide?next=原来要去的地址（lib/server/guide.ts），右上角的按钮就接着去那里；
// next 和登录页一样用 safeNext 规整（只认本站路径，登录页、接口不算），指回用法页自己的回工作台。

import type { Metadata } from "next";
import AppShell from "@/components/AppShell";
import Guide from "@/components/Guide";
import { continueTarget } from "@/lib/server/guide";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "用法 · 分寸" };

export default async function GuidePage({ searchParams }: PageProps<"/guide">) {
  const sp = await searchParams;
  return (
    <AppShell active="/guide">
      <Guide continueTo={continueTarget(sp.next)} />
    </AppShell>
  );
}
