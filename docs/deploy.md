# 上线演示：账号登录与限流

本机开发、评委在自己电脑上运行时，都**不需要**这一篇：不配账号就没有登录，也不限流。

要把网站放到公网上给评委或别人试用，必须先配账号。原因很简单：网站背后用的是你自己的模型密钥，谁能打开网站，谁就能花你的额度。配了账号以后：

- 打开任何页面都会先跳到登录页，输对账号和密码才能进（登录一次，这个浏览器 7 天内不用再登录）；顶栏右上角显示当前账号和「退出」；
- 新建体检、闯关开局、闯关发言按账号算次数上限，登录按来源和账号名各有上限，超了会提示「请 N 分钟后再试」；
- 没登录时，接口一律回「需要先登录」，模型文件也下载不了。

账号由参赛队分配，不开放注册；服务器上只存密码的哈希。做法和取舍见 ADR-032（取代 ADR-028 的访问码）；代码在 `proxy.ts`（门禁）、`lib/server/auth.ts`（账号配置、登录 cookie）、`lib/server/password.ts`（密码哈希）、`lib/server/access.ts`（限流）、`scripts/account.ts`（命令行工具）。

一条防手滑的保险：填了模型密钥（接了真实模型）却一个账号都没配时，网站只许从本机（127.0.0.1、localhost）打开，别的地址一律拦住，服务端日志里会写原因。

## 一、步骤

服务器要求：Node.js 22.12 以上，能访问百炼接口（国内服务器即可）。买不买服务器、用哪家，由队员决定；这里只写装好以后怎么做。

```bash
git clone <仓库地址> && cd shijinshi
npm ci
cp .env.example .env.local     # 填 LLM_API_KEY，账号和密钥按下面的步骤填
chmod 600 .env.local           # 里面有模型密钥和会话密钥，只给自己看
```

1. 生成会话密钥，写进 `.env.local` 的 `SESSION_SECRET=`：

   ```bash
   npx tsx scripts/account.ts secret
   ```

2. 给每个要用的人生成一条账号记录。密码要输两遍，输入时不显示；屏幕上打出来的一行就是这个账号的记录：

   | 在哪里运行 | 命令 |
   |---|---|
   | Linux 服务器、macOS | `npx tsx scripts/account.ts add <账号名>` |
   | Windows PowerShell、cmd、Windows Terminal | `npx tsx scripts/account.ts add <账号名>`（`npx` 被执行策略拦住时改用 `npx.cmd`） |
   | Git Bash | `winpty node --import tsx scripts/account.ts add <账号名>`（Git Bash 里直接用 `npx` 没法隐藏输入，工具会报错，不会把密码显示出来） |

   - 密码至少 12 个字符，不能包含账号名和常见词；尽量只用英文字母、数字和符号，评委的电脑上好输入。
   - 给脚本用：bash 里先 `read -rs PW`，再 `printf '%s\n' "$PW" | npx tsx scripts/account.ts add <账号名> --stdin`。Windows PowerShell 5.1 的管道会把中文变成问号，管道里只用英文密码。不要把密码直接写在命令行里（会进命令历史）。

3. 把记录写进 `.env.local` 的 `AUTH_ACCOUNTS`。一条一个，用英文逗号隔开写成一行；要一行一条，就必须用英文双引号把整段括起来（忘了加引号，Next 只读到空串，网站会拦住并报配置错）：

   ```ini
   SESSION_SECRET=<43位随机串>
   AUTH_ACCOUNTS="
   # 评委
   <账号名>:s1.15.8.3.<22位盐>.<43位哈希>
   <账号名>:s1.15.8.3.<22位盐>.<43位哈希>
   "
   CLIENT_IP_HEADER=x-real-ip
   ```

4. 检查配置（读法和 `next start` 一模一样，不打印记录和密钥）：

   ```bash
   npx tsx scripts/account.ts check
   ```

   看到「账号登录已启用：N 个账号」才算对。写错了会说是第几条、什么问题；这时网站会拦住所有请求，而不是放开。

5. 构建、启动：

   ```bash
   npm run build
   npm start                      # 只在本机 127.0.0.1:3000 监听，由前面的 nginx 对外
   ```

   只用 `npm start`（它带了 `-H 127.0.0.1`）。不要写成 `npx next start`：不带 `-H` 时会在所有网卡上监听，别人绕过 nginx 直接连 3000 端口，就能自己写来源请求头、绕过按来源的上限，登录 cookie 也不带 Secure。用 pm2、systemd 托管时同样照 `npm start` 写。

## 二、账号怎么管

改了 `.env.local` 都要重启服务才生效。重启**不会**让已经登录的人掉线（会话不存在服务器内存里）；只会清零次数计数，并把正在跑的体检标成失败。

- **加账号**：`add` 生成一条记录，加进 `AUTH_ACCOUNTS`，重启。
- **改密码**：重新 `add` 同一个账号名，用新记录替换旧的那条，重启。只有这个账号要重新登录。
- **删账号**：删掉那一条，重启。它已经登录的会话立即作废。
- **全部踢下线**：换一个 `SESSION_SECRET`（再跑一次 `secret`），重启。
- **谁能复核**：`.env.local` 里写 `AUTH_REVIEWERS=队员的账号名,另一个`（逗号隔开），重启。只有这几个账号在体检单上看得到「确认结论 / 改判 / 撤销」，别的账号（比如发给评委的）只能看；复核时记下账号和时间，写在那条结论旁边。不设的话所有账号都能复核（和以前一样）。
- 账号名别用真名、别好猜（例如 `judge-7k3q`）：顶栏会显示账号名，录视频、截图时也会带出来；知道账号名的人凑够几个来源故意输错，能把它锁 15 分钟。账号名和密码一起私下发给要用的人，不要发到群里。
- 不要把 `SESSION_SECRET` 设成端到端测试里那一把（`e2e/accounts.ts`，随仓库公开）：线上会当成配置错误拦住。`e2e-` 开头的账号线上也不认。

## 三、nginx 配置（对外提供 HTTPS）

```nginx
server {
    listen 80;
    server_name 你的域名;
    return 301 https://$host$request_uri;                     # 只做跳转，不要把 80 端口也转给 3000
}

server {
    listen 443 ssl;
    server_name 你的域名;
    # ssl_certificate / ssl_certificate_key 按证书实际位置填

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $http_host;                     # 带上端口：开在非 443 端口时，本站判断「是不是本站提交的」要用到
        proxy_set_header X-Real-IP $remote_addr;              # 限流按它认来源（对方改不了）
        proxy_set_header X-Forwarded-For $remote_addr;        # 覆盖掉对方自己带的，不是追加
        proxy_set_header X-Forwarded-Proto $scheme;           # 让登录 cookie 带上 Secure
        proxy_buffering off;                                  # 体检进度和语音是边算边推的，不能攒着
        proxy_read_timeout 300s;
    }
}
```

- `X-Real-IP` 这一行和 `.env.local` 里的 `CLIENT_IP_HEADER=x-real-ip` 要一起设。`X-Forwarded-For` 那一行是第二道：万一漏设了 `CLIENT_IP_HEADER`，程序默认读的 `x-forwarded-for` 也是 nginx 看到的真实地址。Next 只在请求里没有这个头时才自己填，对方自己带了就原样保留，所以不覆盖的话，换一个假的 `X-Forwarded-For` 就能绕过按来源的上限。
- 可选：给 `/api/login` 再加一道 nginx 的 `limit_req`。不许别的网站把页面嵌进去（`X-Frame-Options: DENY`、`frame-ancestors 'none'`）和 `X-Content-Type-Options: nosniff`，程序自己会发（`next.config.ts`），nginx 里不用再加。

## 四、默认上限

| 项目 | 按什么算 | 默认上限 | 环境变量 |
|---|---|---|---|
| 新建体检 | 账号（没配账号、用 `RATE_LIMIT=1` 硬开时按来源） | 每小时 10 次；全站每天 100 次（北京时间零点清零） | `RATE_RUNS_PER_HOUR`、`RATE_RUNS_PER_DAY` |
| 闯关开局 | 账号 | 每小时 30 次 | `RATE_PLAY_STARTS_PER_HOUR` |
| 闯关发言 | 账号 | 每小时 120 句；全站每天 3000 句 | `RATE_PLAY_TURNS_PER_HOUR`、`RATE_PLAY_TURNS_PER_DAY` |
| 登录尝试 | 来源 | 每 10 分钟 10 次 | `RATE_LOGIN_PER_10MIN` |
| 输错密码 | 账号名（不管从哪来，账号存不存在都算） | 每 15 分钟 30 次 | `RATE_LOGIN_FAILS_PER_15MIN` |

- 设成 `0` 表示不限。`RATE_LIMIT=0` 关掉体检、闯关的上限（登录的两项照样限），`RATE_LIMIT=1` 在没配账号时也按来源开限流。
- 输错密码的上限要大于一个来源 15 分钟内最多能试的次数（按默认值是 20 次），不然一个 IP 就能把知道名字的账号一直锁住。
- 开了限流时，一次体检最多调用模型 200 次（平时是 500 次）。

**按次数估算额度**（最坏情况，全部用满）：体检每天 100 次 × 每次最多 200 次调用 = 2 万次；闯关每句话一般 2～4 次调用（角色、护栏，身份和退出两关还有一次裁判），3000 句约 1 万次。每次调用的字数和单价以百炼控制台为准，上线前按自己的余额把每天的上限调到花得起的数。

## 五、知道这些局限

- **配置一出错，全站都进不去。** 这是有意的：宁可谁都进不去，也不要配漏了变成谁都能进。上线前用 `check` 命令查，原因细节只写在服务端日志里。
- **知道账号名、又有几个来源的人，能故意输错把它锁 15 分钟**（一个来源锁不住：按来源的上限先到）。已经登录的人不受影响（cookie 管 7 天）。所以账号名别好猜、别公开。
- **会话不存服务器。** 被偷走的 cookie 在到期前一直能用；只能给这个账号改密码，或者换 `SESSION_SECRET` 让所有人重新登录，没法单独踢掉某一台设备。
- **不配 nginx 直接对外时，来源可以伪造**，按来源的登录上限形同虚设，只剩按账号名的锁定和同时核对密码的个数上限兜底。上线必须照上面配 nginx。
- **核对密码要吃 CPU 和内存**：每次约 32 MB、零点几秒，最多两个同时算、十几个排队，再多就提示「登录的人有点多」。有人大量刷登录时登录会变慢，网站别的功能照常。
- **计数只存在服务进程的内存里**：重启后清零，锁定也跟着解除；开多个进程或多台服务器时各算各的（要共享得换成 Redis 之类的存储）。
- **所有账号权限一样**：都能看全部运行记录，能暂停、终止别人的体检，能改别人体检单上的人工复核，复核也不记是谁做的。不要在演示服务器上用真实的个人信息做体检。
- 这里只防「别人刷额度」，不防模型服务本身的故障；百炼那边的限流和报错仍按原来的方式显示。

## 六、上线前检查

1. `npx tsx scripts/account.ts check` 显示「账号登录已启用」；`npm run release:check` 通过，`.env.local` 不在仓库里；
2. `ss -ltn | grep 3000` 只看到 `127.0.0.1:3000`（没有 `0.0.0.0:3000`）；
3. 不带 cookie 访问首页会跳到 `/login`，访问 `/api/status` 回 401；
4. 输错密码提示「账号或密码不对」；每次换一个假的 `X-Forwarded-For`（`9.9.9.1`、`9.9.9.2`……）连着输错，最迟第 11 次必须提示「试得太频繁了」（说明来源认的是 nginx 看到的真实地址，不是对方自己写的）。次数按整 10 分钟分格子算（比如 10:00～10:09 算一格）：前面那次输错也算在内，所以可能第 10 次就提示；连着试的时候跨过了整 10 分钟会重新计，要重试一遍；
5. 输对后回到原来要去的页面，顶栏显示账号，3D 形象正常加载；用浏览器开发者工具看登录 cookie：HttpOnly、Secure、SameSite=Lax 都在；
6. 点「退出」后再打开工作台，要重新登录；
7. 退出登录的状态下，登录页的背景图能显示，模型文件 `/models/qiyetao.vrm` 拿不到（跳到登录页）；
8. 在百炼控制台给密钥设好消费上限（这是最后一道保险，比程序里的上限更可靠）。
