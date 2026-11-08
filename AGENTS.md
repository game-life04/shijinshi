<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 写技术文档（队员 B 用 Codex 起草第 1、2、6、7 章）

- 先读 `docs/writing/README.md` 和 `docs/writing/00-我们做了什么.md`，再读要写的那一章的模板（`docs/writing/01-…` 到 `07-…`）。
- 只写仓库里查得到的事实，每句事实后面用 HTML 注释写出处（文件路径，或 `kb/clauses.jsonl` 里的条文 id）。查不到的写【待补】，不要编数字、调查、新闻、论文，也不要替别的工具下结论。
- 条文照 `kb/clauses.jsonl` 原文引用。模拟数据和草稿题跑出来的数字（比如 `docs/pilot-log.md`）不当实验结果写。
- 草稿只写到 `docs/writing/drafts/`；不改代码，不改 `docs/decisions.md`、`docs/implementation-status.md` 这些记录，不读 `.env*`。
- 不写任何真人姓名（队员写「队员 A」「队员 B」）、单位、密钥、账号和密码、服务器地址、画师名。
