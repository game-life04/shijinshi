// 先审还是先播：一个小实验（原「三种结局」，ADR-049 收成原理页下面的一个小实验，导航高亮跟着「原理」，
// 和前后对比、体检单高亮「运行记录」一个道理）。
// 是不是真实模型由服务端直接给：页面原来为这一个开关去要 /api/status，那份返回里带着整套用例，这页用不着。
import AppShell from "@/components/AppShell";
import Fates from "@/components/Fates";
import { isLive } from "@/lib/server/llm";

export const dynamic = "force-dynamic";

export default function FatesPage() {
  return (
    <AppShell active="/settings">
      <Fates live={isLive()} />
    </AppShell>
  );
}
