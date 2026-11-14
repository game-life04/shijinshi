// 用法（队员 B 的建议 4：登录以后有一页用法说明，清楚、字少、配图，把每个模块讲清楚）。
// 每一页一张截图、一句话（不超过 25 个字）、至多三条小字；整张卡都能点（图、标题、字），键盘上每张卡只停一次。
// 「先审还是先播」（原「三种结局」）是原理页下面的小实验：放在最后，一行小卡，不和六个页面抢。
// 这个浏览器第一次登录时先到这里（lib/server/guide.ts），右上角一个按钮接着去原来要去的页面；平时从顶栏「用法」进来。
// 字和图的数据在 ./guide-content.ts（文字里用「」引到的按钮、链接也登记在那里，测试拿去核对）；这里只管怎么摆。
// 图在 public/guide/，由 scripts/guide-shots.ts 从开着的本机服务（模拟模式）截出来；页面改了样子就重跑一次。
// 服务端组件，不带页面脚本。

import { ArrowRight, BookOpen, Clapperboard, Grid3x3, ListChecks, type LucideIcon, ScrollText, SquareTerminal, Swords } from "lucide-react";
import Link from "next/link";
import { type Entry, type Fade, LAB, MAIN, MORE, type Module, SHOT } from "./guide-content";

/** 每一项的图标（和顶栏导航上的一样；小实验用场记板） */
const ICON: Record<string, LucideIcon> = {
  "/workbench": SquareTerminal,
  "/play": Swords,
  "/suites": ListChecks,
  "/runs": ScrollText,
  "/map": Grid3x3,
  "/settings": BookOpen,
  "/fates": Clapperboard,
};

const primaryBtn =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-sm bg-primary px-4 text-sm font-medium whitespace-nowrap text-surface hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const plainBtn =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-sm border border-border bg-surface px-4 text-sm font-medium whitespace-nowrap hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
/** 卡片：整张都能点（「打开」链接铺满整张卡，见 Title），悬停时边深一点；键盘停在「打开」上时整张卡描边 */
const card =
  "relative overflow-hidden rounded-sm border bg-surface transition-[border-color] hover:border-foreground/40 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-primary";

const EDGE = "1.75rem";
const MASK: Record<Fade, string | undefined> = {
  none: undefined,
  bottom: `linear-gradient(to bottom, #000 calc(100% - ${EDGE}), transparent)`,
  right: `linear-gradient(to right, #000 calc(100% - ${EDGE}), transparent)`,
  both: `linear-gradient(to bottom, #000 calc(100% - ${EDGE}), transparent), linear-gradient(to right, #000 calc(100% - ${EDGE}), transparent)`,
};

function Shot({ m, eager = false }: { m: Module; eager?: boolean }) {
  const mask = MASK[m.fade];
  return (
    // biome-ignore lint/performance/noImgElement: 静态截图，宽高写死；不用 next/image 现场转码（第一位访客要等）
    <img
      src={m.shot}
      width={SHOT.width}
      height={SHOT.height}
      alt={m.alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      // 深色模式下截图是浅色的：压暗一点，不在墨底上亮成一块
      className="block aspect-[16/10] h-auto w-full object-cover object-left-top dark:brightness-[.72] dark:contrast-[1.05]"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask, maskComposite: "intersect", WebkitMaskComposite: "source-in" } : undefined}
    />
  );
}

/** 图上的角标：截图里的数字都是模拟数据（站里统一的说法） */
function SimTag() {
  return (
    <span className="pointer-events-none absolute right-1.5 bottom-1.5 rounded-sm border border-dashed border-warn bg-surface/90 px-1 text-xs leading-5 text-warn">
      模拟数据（非真实模型）
    </span>
  );
}

/** 标题和「打开」：「打开」的点击区铺满整张卡（伪元素），所以点图、点标题、点字都能进；读屏和键盘只认这一个链接 */
function Title({ m, size }: { m: Entry; size: "lg" | "base" }) {
  const Icon = ICON[m.href] ?? ArrowRight;
  return (
    <div className="flex items-center justify-between gap-2">
      <h3
        className={`flex min-w-0 items-center gap-1.5 font-semibold ${size === "lg" ? "text-lg" : "text-base"}`}
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <Icon size={size === "lg" ? 17 : 15} aria-hidden className="shrink-0 text-muted" />
        {m.name}
      </h3>
      <Link
        href={m.href}
        className="link inline-flex shrink-0 items-center gap-0.5 text-xs after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        aria-label={`打开${m.name}`}
      >
        打开
        <ArrowRight size={13} aria-hidden />
      </Link>
    </div>
  );
}

function Points({ points }: { points: string[] }) {
  if (!points.length) return null;
  return (
    <ul className="space-y-0.5 text-xs leading-relaxed text-muted">
      {points.map((p) => (
        <li key={p} className="flex gap-1.5">
          <span aria-hidden className="select-none">
            ·
          </span>
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

function Card({ m, size, eager = false }: { m: Module; size: "lg" | "base"; eager?: boolean }) {
  return (
    <article className={`${card} flex flex-col border-border`} data-testid="guide-module" data-href={m.href}>
      <div className="relative border-b border-border bg-sunken">
        <Shot m={m} eager={eager} />
        <SimTag />
      </div>
      <div className="space-y-1.5 p-3 sm:p-4">
        <Title m={m} size={size} />
        <p className={size === "lg" ? "text-[15px]" : "text-sm"}>{m.line}</p>
        <Points points={m.points} />
      </div>
    </article>
  );
}

/** 小实验：一行小卡（虚线框、不配图），电脑上标题和那句话排一行 */
function LabCard({ m }: { m: Entry }) {
  return (
    <article className={`${card} border-dashed border-border px-3 py-2.5 sm:px-4`} data-testid="guide-module" data-href={m.href}>
      <Title m={m} size="base" />
      <p className="mt-1 text-sm text-muted">{m.line}</p>
    </article>
  );
}

function GroupLabel({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-xs tracking-[0.2em] text-muted" style={{ fontFamily: "var(--font-kai)" }}>
      {children}
    </h2>
  );
}

function StartButtons() {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href="/workbench" className={primaryBtn}>
        开始体检
        <ArrowRight size={15} aria-hidden />
      </Link>
      <Link href="/play" className={plainBtn}>
        去闯关
      </Link>
    </div>
  );
}

function ContinueButton({ to, testId }: { to: { href: string; name: string }; testId?: string }) {
  return (
    <Link href={to.href} className={primaryBtn} data-testid={testId}>
      知道了，去{to.name}
      <ArrowRight size={15} aria-hidden />
    </Link>
  );
}

/** continueTo：第一次登录时原来要去的页面（已经过 safeNext），右上角给一个「知道了」接着去 */
export default function Guide({ continueTo }: { continueTo?: { href: string; name: string } }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 text-sm sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">用法</h1>
          <p className="text-muted">给会说话的 AI 角色做上线前的安全体检。每页一张图、一句话；图都是模拟数据（非真实模型）的截图。</p>
        </div>
        {continueTo ? (
          <div className="flex flex-col gap-1 sm:items-end">
            <ContinueButton to={continueTo} testId="guide-continue" />
            <p className="text-xs text-muted">以后点顶栏的「用法」还能再看</p>
          </div>
        ) : (
          <StartButtons />
        )}
      </header>

      <section aria-labelledby="guide-main" className="space-y-2">
        <GroupLabel id="guide-main">先从这两页开始</GroupLabel>
        <div className="grid gap-4 md:grid-cols-2">
          {MAIN.map((m) => (
            <Card key={m.href} m={m} size="lg" eager />
          ))}
        </div>
      </section>

      <section aria-labelledby="guide-more" className="space-y-2">
        <GroupLabel id="guide-more">想看得更细</GroupLabel>
        <div className="grid gap-4 sm:grid-cols-2">
          {MORE.map((m) => (
            <Card key={m.href} m={m} size="base" />
          ))}
        </div>
      </section>

      <section aria-labelledby="guide-lab" className="space-y-2">
        <GroupLabel id="guide-lab">小实验</GroupLabel>
        <LabCard m={LAB} />
      </section>

      <footer className="flex justify-end border-t border-border pt-4">
        {continueTo ? <ContinueButton to={continueTo} /> : <StartButtons />}
      </footer>
    </div>
  );
}
