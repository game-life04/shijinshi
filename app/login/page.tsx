// 登录页（ADR-032）：背景是琪叶桃主视觉的「登录版」——同一个场景另出的一张图，不带字，右下角留空；
// 标题、副标题、台词用 HTML 排，右下角是账号密码框。用普通表单提交，页面脚本没加载出来也能登录。
// 样式在 login.css（普通样式表，选择器都挂在 .login-page 下面）。
// 背景图事先压好放在 app/login/art/（主视觉原型 login/shoot.mjs 出图、login/encode.mjs 压），静态 import 后走 /_next/static/media，
// 带内容指纹、可以长期缓存，登录前 proxy 也不拦。不放 public/（会被 proxy 拦在门外），也不用 next/image 现场转码（第一位访客要等编码）。
// 只用一个 <picture>：React 会给单独的 <img> 自动加 preload，亮暗两张图用 CSS 切换就会两张都下载；<picture> 里的不会。
// 服务器没配账号时（本机开发、评委在自己电脑上运行）不用登录，给出进入工作台的入口；
// 但接了真实模型、没配账号、又是从外网打开的，按「登录设置有问题」处理（proxy 同样会拦，见 lib/server/auth.ts 的 openButNotLocal）。

import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { StaticImageData } from "next/image";
import Link from "next/link";
import { BrandSeal } from "@/components/AppFrame";
import { safeNext } from "@/lib/server/access";
import { authConfig, openButNotLocal, sessionTtlMs } from "@/lib/server/auth";
import { getSession } from "@/lib/server/session";
import ink1280 from "./art/login-ink-1280.avif";
import ink1920 from "./art/login-ink-1920.avif";
import ink1920w from "./art/login-ink-1920.webp";
import ink2560 from "./art/login-ink-2560.avif";
import inkM780 from "./art/login-ink-m-780.avif";
import inkM1170 from "./art/login-ink-m-1170.avif";
import inkM1170w from "./art/login-ink-m-1170.webp";
import paper1280 from "./art/login-paper-1280.avif";
import paper1920 from "./art/login-paper-1920.avif";
import paper1920w from "./art/login-paper-1920.webp";
import paper2560 from "./art/login-paper-2560.avif";
import paperM780 from "./art/login-paper-m-780.avif";
import paperM1170 from "./art/login-paper-m-1170.avif";
import paperM1170w from "./art/login-paper-m-1170.webp";
import "./login.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "登录 · 分寸" };

/** 和 login.css 里「大屏」版式同一个条件：图和字要一起换 */
const WIDE = "(min-width: 1200px) and (min-height: 640px) and (min-aspect-ratio: 16/10)";
const DARK = "(prefers-color-scheme: dark)";
const WIDE_SIZES = "(max-aspect-ratio: 16/9) 177.7vh, 100vw";
const CROP_SIZES = "(min-width: 900px) and (min-aspect-ratio: 1/1) 92.5vh, 100vw";
/** srcset：宽度按文件名写死——Next 读不出 AVIF 的尺寸（静态 import 给的 width 是 100），按它写浏览器只会挑第一张 */
const set = (...imgs: [StaticImageData, number][]) => imgs.map(([i, w]) => `${i.src} ${w}w`).join(", ");

/** 登录接口跳回来时带的出错原因（ADR-032）。retry 是还要等几分钟 */
function errorText(code: string, retry: number | null): string | undefined {
  switch (code) {
    case "auth":
      return "账号或密码不对。";
    case "missing":
      return "请输入账号和密码。";
    case "limit":
      return `试得太频繁了，请 ${retry ?? 10} 分钟后再试。`;
    case "locked":
      return `这个账号连续输错太多次，请 ${retry ?? 15} 分钟后再试。`;
    case "busy":
      return "登录的人有点多，请过几秒再试。";
    case "config":
      return "服务器的登录设置有问题，暂时进不去，请联系参赛队。";
    default:
      return undefined;
  }
}

/** 登录一次管多久：整天写天，不是整天写小时（设成 12 小时不会被写成「1 天」） */
function ttlText(ms: number): string {
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return h % 24 === 0 ? `${h / 24} 天` : `${h} 小时`;
}

/** 竖排：一个字一格（不少楷体、宋体没有竖排字距表，用 writing-mode 时各台电脑排出来不一样长） */
function Column({ chars, className }: { chars: string[]; className?: string }) {
  return (
    <span className={`col ${className ?? ""}`} aria-hidden>
      {chars.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 固定的字，不会重排
        <span key={i}>{c}</span>
      ))}
    </span>
  );
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const next = safeNext(one("next") || "/");
  const retryN = Number.parseInt(one("retry"), 10);
  const retry = Number.isFinite(retryN) && retryN > 0 ? Math.min(retryN, 1440) : null;
  const cfg = authConfig();
  const broken = cfg.mode === "broken" || openButNotLocal((await headers()).get("host"));
  const mode = broken ? "broken" : cfg.mode;
  const session = mode === "accounts" ? await getSession() : null;
  const error = mode === "broken" ? errorText("config", null) : errorText(one("error"), retry);
  const notice = !error && one("reason") === "expired" ? "登录已过期，请重新登录。" : !error && one("bye") === "1" ? "已退出登录。" : "";
  const enter = next;
  const invalid = one("error") === "auth" ? true : undefined;
  const described = error || notice ? "login-status" : undefined;

  return (
    <main className="login-page">
      <div className="art">
        <picture>
          <source
            media={`${DARK} and ${WIDE}`}
            type="image/avif"
            srcSet={set([ink1280, 1280], [ink1920, 1920], [ink2560, 2560])}
            sizes={WIDE_SIZES}
          />
          <source media={WIDE} type="image/avif" srcSet={set([paper1280, 1280], [paper1920, 1920], [paper2560, 2560])} sizes={WIDE_SIZES} />
          <source media={DARK} type="image/avif" srcSet={set([inkM780, 780], [inkM1170, 1170])} sizes={CROP_SIZES} />
          <source type="image/avif" srcSet={set([paperM780, 780], [paperM1170, 1170])} sizes={CROP_SIZES} />
          <source media={`${DARK} and ${WIDE}`} type="image/webp" srcSet={ink1920w.src} />
          <source media={WIDE} type="image/webp" srcSet={paper1920w.src} />
          <source media={DARK} type="image/webp" srcSet={inkM1170w.src} />
          <img
            src={paperM1170w.src}
            width={1170}
            height={1266}
            alt="琪叶桃（AI 角色）站在墨笔画的圆窗前，3D 模型渲染图"
            fetchPriority="high"
            decoding="async"
            className="img"
          />
        </picture>
      </div>

      {/* 大屏：画面上的字，按 1920×1080 的画面坐标排（login.css） */}
      <div className="stage">
        <h1 className="title">
          <span className="sr-only">分寸</span>
          <Column chars={["分", "寸"]} />
        </h1>
        <p className="sub">
          <span className="sr-only">AI 语音角色安全体检台</span>
          <Column chars={["AI", ..."语音角色安全体检台"]} className="subCol" />
        </p>
        <span className="bigSeal" aria-hidden>
          <span>分</span>
          <span>寸</span>
        </span>
        <figure className="quote">
          <figcaption className="sr-only">琪叶桃（AI 角色）的台词</figcaption>
          <blockquote className="sr-only">那是我的小秘密，不告诉你～</blockquote>
          <Column chars={["那", "是", "我", "的", "小", "秘", "密", "︐"]} className="quoteCol1" />
          <Column chars={["不", "告", "诉", "你", "︴"]} />
        </figure>
        <Column chars={["琪", "叶", "桃"]} className="who" />
      </div>

      <section aria-labelledby="login-title" className="card">
        <div className="head">
          <BrandSeal />
          <div className="brand">
            <h1 className="brandName">分寸</h1>
            <p className="brandSub">AI 语音角色安全体检台</p>
          </div>
          <h2 id="login-title" className="loginTitle">
            {mode === "open" ? "不用登录" : "登录"}
          </h2>
        </div>

        {mode === "open" ? (
          <>
            <p className="note">这台服务器没有配置账号，不用登录。</p>
            <Link href={enter} className="btn btnLong">
              进入体检工作台
            </Link>
          </>
        ) : mode === "broken" ? (
          <p id="login-status" role="alert" className="status err">
            <CircleAlert size={14} aria-hidden />
            {error}
          </p>
        ) : session ? (
          <>
            <p className="note">已登录：{session.account}。</p>
            <div className="actions">
              <Link href={enter} className="btn btnLong">
                进入体检工作台
              </Link>
              <form method="post" action="/api/logout">
                <button type="submit" className="btnGhost" aria-label="退出登录">
                  退出
                </button>
              </form>
            </div>
          </>
        ) : (
          <form method="post" action="/api/login" className="form">
            <input type="hidden" name="next" value={next} />
            <div className="field">
              <div className="label">
                <label htmlFor="login-account">账号</label>
                <small id="login-account-hint">由参赛队发放</small>
              </div>
              <input
                id="login-account"
                name="account"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={64}
                required
                aria-invalid={invalid}
                aria-describedby={described ? `login-account-hint ${described}` : "login-account-hint"}
                className="input"
              />
            </div>
            <div className="field">
              <div className="label">
                {/* 「密码」下面的朱批和画面上「小秘密」旁边的那道是同一种：她的秘密，你的密码 */}
                <label htmlFor="login-password" className="zhupi">
                  密码
                </label>
              </div>
              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                required
                // biome-ignore lint/a11y/noAutofocus: 只在「账号或密码不对」跳回来时把光标放回密码框，读屏会接着读出原因
                autoFocus={invalid}
                aria-invalid={invalid}
                aria-describedby={described}
                className="input"
              />
            </div>
            <button type="submit" className="btn">
              登录
            </button>
            {error ? (
              <p id="login-status" role="alert" className="status err">
                <CircleAlert size={14} aria-hidden />
                {error}
              </p>
            ) : notice ? (
              <output id="login-status" className="status notice">
                {notice}
              </output>
            ) : (
              <p className="status">登录一次，这个浏览器 {ttlText(sessionTtlMs())}内不用再登录。</p>
            )}
          </form>
        )}

        <p className="ai">
          <b>琪叶桃是 AI 角色，不是真人</b>
          画面由琪叶桃的 3D 模型渲染
        </p>
      </section>
    </main>
  );
}
