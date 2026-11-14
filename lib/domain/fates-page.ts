// 小实验「先审还是先播」（/fates，原「三种结局」）的名字只放这一份（ADR-049）：用法页、原理页、工作台对话下面的链接、
// 运行记录的分组和「知道了，去……」按钮都用它；端到端测试（e2e/guide.spec.ts）到 /fates 核对标题里有它。
// 放在 lib/domain：浏览器里的组件（工作台的对话）也要用，不能从 lib/server 拿。
export const FATES_PAGE = { href: "/fates", name: "先审还是先播" } as const;
