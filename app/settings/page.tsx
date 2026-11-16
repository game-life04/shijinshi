// 原理（评审 R32，原来的「设置」页；网址仍是 /settings）：一张流程，把一次体检从出题到体检单串起来讲，
// 每一步配一句大白话和「在哪里能看到」；模型、条文来源、数据说明放在下面（R41 改了说法）。
// 只写仓库里查得到、做了的事；没做的（MCP 服务、语音输入、E3 对照实验）不写。端到端测试在这页认「共 32 条」。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import { Badge } from "@/components/ui";
import { LAW_EFFECTIVE, LAW_FULL, modelName } from "@/components/wording";
import { asrAvailable, asrModel } from "@/lib/server/asr";
import { FATES_PAGE } from "@/lib/server/guide";
import { isLive, modelFor } from "@/lib/server/llm";
import { loadKb } from "@/lib/server/rag";

export const dynamic = "force-dynamic";

const STEPS: { n: string; what: string; how: string; where: string; href?: string }[] = [
  {
    n: "①",
    what: "测试 Agent 出招",
    how: "一个大模型扮成用户，只能从队伍登记的 5 种套路里选（装成开发者、先套近乎、让角色演别的、拆开问、直接问）；它每出一招就调用一次工具 execute_case，也能调用 retrieve_reference 查条文、finish 收手。退出、未成年、危机这些敏感题只用人工写好的句子问。",
    where: "工作台右栏「测试 Agent 怎么出的招」",
    href: "/workbench",
  },
  {
    n: "②",
    what: "被测角色回答",
    how: "用你粘贴的人设和边界提示（不填就是默认角色琪叶桃），由大模型扮演，一句一句往外说。",
    where: "工作台中间的对话",
    href: "/workbench",
  },
  {
    n: "③",
    what: "逐句护栏",
    how: "每一句先过规则（口令按字比对，身份、退出、未成年、危机看关键说法），再过一个护栏小模型；审过才放出去。拦下的原话划掉留在记录里，口令只遮住那几个字。",
    where: `对话里的「拦」；三种放行方式的差别看「${FATES_PAGE.name}」`,
    href: "/fates",
  },
  {
    n: "④",
    what: "服务层",
    how: "B2 配置才有：对方说要走就直接停、不再调用模型；连续聊满 2 小时插一条提醒；危机时角色没给求助途径就补上。系统补的话单独标出来，不算角色说的。",
    where: "对话里灰底的系统消息",
    href: "/workbench",
  },
  {
    n: "⑤",
    what: "变成声音、在浏览器里放",
    how: "放行的句子合成语音，在浏览器里一个采样一个采样地放；违规的声音漏出多少、开口要等多久、叫停后多久没声，都按浏览器真正放出来的部分算。",
    where: `工作台「声音这边」（勾上语音播放）、「${FATES_PAGE.name}」`,
    href: "/fates",
  },
  {
    n: "⑥",
    what: "裁判判定",
    how: "程序能判的（口令、退出即停、时长提醒）由程序判；要看意思的由裁判模型判，它先在条文库里检索相关条文，结论必须摘出原话，程序再在原文里逐字找到位置，找不到就不算证据、送人工复核。",
    where: "体检单里的红波浪线和「依据」",
  },
  {
    n: "⑦",
    what: "体检单",
    how: "每题分三层：角色原话 → 护栏处理 → 最终播出，判定只看最终播出。第一屏是总检结论和这次看点，可以导出 PDF；改一处再测，用前后对比页看改了什么、结果怎么变。",
    where: "跑完以后「看体检单」；运行记录",
    href: "/runs",
  },
];

export default function SettingsPage() {
  const kb = loadKb();
  const first = kb.clauses[0];
  const live = isLive();
  const base = process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1（默认）";
  return (
    <AppShell active="/settings">
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 text-sm">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">原理：一次体检是怎么跑的</h1>
          <p className="text-muted">
            给会说话的 AI 角色做上线前的安全体检：测试 Agent 套话，默认配置下每句话护栏审过才说出口，最后对照{LAW_FULL}（{LAW_EFFECTIVE}
            ）出体检单。
          </p>
        </header>

        <ol className="space-y-2" aria-label="一次体检的七步">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-sm border border-border bg-surface p-3">
              <p className="font-semibold">
                <span className="mr-1" style={{ fontFamily: "var(--font-kai)" }}>
                  {s.n}
                </span>
                {s.what}
              </p>
              <p className="mt-0.5 text-muted">{s.how}</p>
              <p className="mt-1 text-xs">
                在哪里看：
                {s.href ? (
                  <Link className="link" href={s.href}>
                    {s.where}
                  </Link>
                ) : (
                  s.where
                )}
              </p>
            </li>
          ))}
        </ol>

        {/* 原来的「三种结局」不在顶栏了（ADR-049，队员 B 的建议）：是个小实验，从这里和「用法」页进 */}
        <p className="text-xs text-muted">
          小实验：
          <Link className="link" href={FATES_PAGE.href}>
            {FATES_PAGE.name}
          </Link>
          ——同一句套话问三遍，只换「审」和「说」的先后。
        </p>

        <section className="rounded-sm border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">模型连接</h2>
          <p className="mb-2">
            {live ? (
              <Badge tone="ok">已配置模型密钥：用的是真实模型（会产生调用费用）</Badge>
            ) : (
              <span className="inline-block rounded-sm border border-dashed border-warn px-1.5 py-0.5 text-xs text-warn">
                没配模型密钥：现在用的是模拟器，回答按固定规则生成，只能演示流程，数字不能当实验结果
              </span>
            )}
          </p>
          <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
            <dt className="text-muted">接口地址</dt>
            <dd className="font-mono text-xs break-all">
              {base}
              {live ? "" : "（模拟模式不连接）"}
            </dd>
            <dt className="text-muted">被测角色</dt>
            <dd className="font-mono break-all">{modelName(modelFor("subject"))}</dd>
            <dt className="text-muted">测试 Agent</dt>
            <dd className="font-mono break-all">{modelName(modelFor("tester"))}</dd>
            <dt className="text-muted">裁判</dt>
            <dd className="font-mono break-all">{modelName(modelFor("judge"))}</dd>
            <dt className="text-muted">护栏</dt>
            <dd className="font-mono break-all">{modelName(modelFor("guard"))}</dd>
            {/* ADR-054：闯关「说」的那一段录音交给它转文字 */}
            <dt className="text-muted">语音转文字</dt>
            <dd className="font-mono break-all">
              {asrAvailable() ? asrModel() : live ? "没接（用浏览器自带的识别）" : "模拟模式（闯关用浏览器自带的识别）"}
            </dd>
          </dl>
          <p className="mt-2 text-xs text-muted">
            在项目根目录的 .env.local 里配置（参考 .env.example），改完重启服务。密钥不会出现在页面、日志或导出文件里。
          </p>
        </section>

        <section className="rounded-sm border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">条文来源</h2>
          <p>
            《{first?.law}》{first?.version}，{first?.effective} 施行，共 {kb.clauses.length} 条；条文库版本{" "}
            <span className="font-mono break-all">{kb.hash}</span>。
          </p>
          <p className="text-xs break-all text-muted">
            快照：<span className="font-mono">kb/sources/anthropomorphic-2026.hunan.html</span>，SHA-256{" "}
            <span className="font-mono">{first?.snapshot_sha256}</span>。重新生成：
            <code>npx tsx scripts/build-kb.ts</code>
          </p>
        </section>

        <section className="rounded-sm border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">数据与隐私</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>运行结果保存在服务器的运行数据目录（默认 data/runs/），只含文字对话和事件；不保存录音。</li>
            <li>
              {asrAvailable()
                ? "打字闯关点「说」时，录下的那一段声音发到服务器，交给阿里云百炼的语音识别转成文字，转完就丢：不保存、不写日志，也不进运行记录。"
                : "打字闯关点「说」时用浏览器自带的识别：Edge、Chrome 会把声音发到它们自己的识别服务，分寸收不到录音。"}
            </li>
            <li>
              每次体检的随机口令单独存放，不会单独发给浏览器和裁判；角色原话里如果说出了口令，原话层会照原样显示（划掉），方便看它是怎么漏的。
            </li>
            <li>只测试本人原创或已获授权的角色；不接受任意外部网址作为被测对象。</li>
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
