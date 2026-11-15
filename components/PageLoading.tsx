// 切页面时先出来的样子（ADR-051，11-15 队员 B：点页面标签要等一会儿才转过去）。
// 线上服务器在香港，跨境线路慢（几百 KB/s；3D 模型在后台下载时更慢，11-15 实测点「运行记录」等了 13 秒），
// 新页面的数据要几百毫秒到几秒才到，原来这段时间页面一动不动，像没点上。现在每个页面都有 loading.tsx：
// 点下去顶栏马上换到那一项，下面先放几块淡淡的占位，数据到了换成真的页面（Next.js 的 loading 约定：链接进了屏幕，
// 这一层就先取好了，点的时候不用等服务器）。账号那一块等页面到了才出来（这一层不读 cookie）。
// 体检单（/reports/<编号>）不加：加了 loading 以后页面是边算边发的，找不到这次运行时状态码已经发出去是 200，
// 改不成 404（ADR-050 要求封存的运行和不存在的一模一样，都回 404，e2e/workbench.spec.ts 查这个）。
import AppFrame from "./AppFrame";

export default function PageLoading({ active, fill, title }: { active?: string; fill?: boolean | "always"; title: string }) {
  return (
    <AppFrame active={active} fill={fill}>
      <div className="mx-auto w-full max-w-6xl space-y-3 p-4" aria-busy="true" data-testid="page-loading">
        <p className="text-sm text-muted" aria-live="polite">
          正在打开「{title}」……
        </p>
        <div className="page-skel h-7 w-44" />
        <div className="page-skel h-24" />
        <div className="page-skel h-40" />
      </div>
    </AppFrame>
  );
}
