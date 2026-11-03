# 上线演示：访问码与限流

本机开发、评委在自己电脑上运行时，都**不需要**这一篇：不设访问码就没有登录，也不限流。

要把网站放到公网上给评委或别人试用，必须先设访问码。原因很简单：网站背后用的是你自己的模型密钥，谁能打开网站，谁就能花你的额度。设了访问码以后：

- 打开任何页面都会先跳到登录页，输对访问码才能进（登录一次，这台设备 7 天内不用再输）；
- 新建体检、闯关开局、闯关发言、登录尝试都有次数上限，超了会提示「请 N 分钟后再试」；
- 没登录时，接口一律回「需要先输入访问码」，模型文件也下载不了。

做法和取舍见 ADR-028；代码在 `proxy.ts`（门禁）和 `lib/server/access.ts`（访问码、限流）。

## 一、步骤

服务器要求：Node.js 22.12 以上，能访问百炼接口（国内服务器即可）。买不买服务器、用哪家，由队员决定；这里只写装好以后怎么做。

```bash
git clone <仓库地址> && cd shijinshi
npm ci
cp .env.example .env.local     # 填 LLM_API_KEY 和 ACCESS_CODE，其余按需
npm run build
npm start                      # 只在本机 127.0.0.1:3000 监听，由前面的 nginx 对外
```

`.env.local` 至少要填三项：

- `LLM_API_KEY`：百炼密钥（只写在服务器上的 `.env.local` 里）；
- `ACCESS_CODE`：一串不好猜的字，建议 12 位以上、字母数字混合；
- `CLIENT_IP_HEADER=x-real-ip`：前面有 nginx 时设，配合下面的 nginx 配置。

访问码只发给要用的人（例如写在交给评委的材料里），不要提交到仓库、不要发到群里公开。要换访问码：改 `.env.local` 里的 `ACCESS_CODE` 后重启，已经登录的人全部要重新输。

## 二、nginx 配置（对外提供 HTTPS）

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;
    # ssl_certificate / ssl_certificate_key 按证书实际位置填

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;              # 限流按它认来源（对方改不了）
        proxy_set_header X-Forwarded-Proto $scheme;           # 让登录 cookie 带上 Secure
        proxy_buffering off;                                  # 体检进度和语音是边算边推的，不能攒着
        proxy_read_timeout 300s;
    }
}
```

`X-Real-IP` 这一行和 `.env.local` 里的 `CLIENT_IP_HEADER=x-real-ip` 要一起设。不用 nginx、让 `next start` 直接对外时，程序只能从 `x-forwarded-for` 认来源，对方自己伪造这个头就能绕过「每个来源」的上限；这时只有「全站每天」的上限兜底。

## 三、默认上限

| 项目 | 每个来源 | 全站每天（北京时间零点清零） | 环境变量 |
|---|---|---|---|
| 新建体检 | 每小时 10 次 | 100 次 | `RATE_RUNS_PER_HOUR`、`RATE_RUNS_PER_DAY` |
| 闯关开局 | 每小时 30 次 | 不限 | `RATE_PLAY_STARTS_PER_HOUR` |
| 闯关发言 | 每小时 120 句 | 3000 句 | `RATE_PLAY_TURNS_PER_HOUR`、`RATE_PLAY_TURNS_PER_DAY` |
| 登录尝试 | 每 10 分钟 10 次 | 不限 | `RATE_LOGIN_PER_10MIN` |

- 设成 `0` 表示不限。`RATE_LIMIT=0` 关掉除登录尝试以外的所有上限，`RATE_LIMIT=1` 在没设访问码时也开限流。
- 开了限流时，一次体检最多调用模型 200 次（平时是 500 次）。

**按次数估算额度**（最坏情况，全部用满）：体检每天 100 次 × 每次最多 200 次调用 = 2 万次；闯关每句话一般 2～4 次调用（角色、护栏，身份和退出两关还有一次裁判），3000 句约 1 万次。每次调用的字数和单价以百炼控制台为准，上线前按自己的余额把每天的上限调到花得起的数。

## 四、知道这些局限

- 访问码是大家共用的一串字，不是个人账号：知道它的人都能用。泄露了就换。
- 计数只存在服务进程的内存里：重启后清零；开多个进程或多台服务器时各算各的（要共享得换成 Redis 之类的存储）。
- 这里只防「别人刷额度」，不防模型服务本身的故障；百炼那边的限流和报错仍按原来的方式显示。
- 运行记录（`data/runs`）存在服务器硬盘上，所有登录的人都能在「运行记录」里看到，不要在演示服务器上用真实的个人信息做体检。

## 五、上线前检查

1. `npm run release:check` 通过，`.env.local` 不在仓库里；
2. 不带 cookie 访问首页会跳到 `/login`，访问 `/api/status` 回 401；
3. 输错访问码提示「访问码不对」，输对后回到原来要去的页面，3D 形象正常加载；
4. 在百炼控制台给密钥设好消费上限（这是最后一道保险，比程序里的上限更可靠）。
