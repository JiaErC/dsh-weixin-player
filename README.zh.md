# dsh-weixin-player

把微信接进 **DeepSeek Harness**（DSH）。一条微信消息 = DSH 里的一轮 agent 对话，agent 的回答原样发回微信。

这是 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（腾讯官方 OpenClaw 微信渠道，iLink 长轮询协议）在 DSH 上的移植版：协议层几乎逐字复用，渠道生命周期重写成 DSH 的 cordis 插件，并补上了一个 DSH 原生的右侧栏 tab。

```
微信用户 ──长轮询 getUpdates──▶ 本插件 ──followup()──▶ DSH 会话（agent）
   ▲                                                        │
   └──────────── sendMessage ◀── assistant 文本流 ◀──────────┘

DSH 右侧栏「微信」tab ──▶ 扫码登录 + 按会话启用 weixin_* 工具
```

## 能力

- **右侧栏「微信」tab**：扫码登录、看账号状态、**给当前会话开关微信工具**，全部在 DSH 界面里完成，不用开终端。
- **按会话的工具启用**：点一下按钮，`weixin_send` / `weixin_login` / `weixin_status` 就只对**当前这个会话**可见——不改动任何 Agent 预设，也不管这个会话用的是什么预设；关掉 tab 或换会话互不影响，重启后仍然记得。
- **多账号**：每个扫码登录的 bot 各跑一条长轮询；断线自动退避重连，token 失效自动冷却。
- **每用户独立会话**：一个微信用户对应一个 DSH 会话，重启后自动 resume，上下文不丢。
- **富媒体双向**：微信发来的图片/视频/文件/语音会解密落盘并把**本地路径**告诉 agent；agent 想发文件时，在回复里单独一行写 `MEDIA:<本地路径>` 即可。
- **打字状态**：agent 生成期间保持微信「对方正在输入…」。
- **微信侧命令**：`/help`、`/status`、`/whoami`、`/new`、`/stop`，不消耗模型。
- **引用消息**：把微信引用消息的正文一起交给 agent；服务端只给 ID 时用本地引用缓存补全。

## 前置条件

| 需要 | 说明 |
|---|---|
| DSH | `0.2.0-rc.2` 实测；插件只用宿主服务，不依赖具体版本号 |
| Node | ≥ 22 |
| 微信 bot | 微信 iLink 的 bot 账号（扫码即得，无需申请） |
| pnpm | `dsh plugin` 用它装包 |

## 安装

```powershell
# 1) 装依赖 + 编译（link 安装不会带上插件自己的依赖，必须先跑）
cd E:\AI_dsh_plugin\dsh-weixin-player
npm install
npm run build

# 2) 装进 DSH 的 web profile（会自动登记到 dsh.profile.bundles）
dsh plugin --profile web add link:E:/AI_dsh_plugin/dsh-weixin-player

# 3) 重启 dsh web，然后刷新浏览器页面（客户端 tab 是启动时下发的）
```

也可以直接跑脚本：`pwsh -File scripts\install.ps1`。

挂载行也可以手写进 profile 的 `cordis.patch.yml`（`dsh plugin add` 已经自动做了这一步，一般不用管）：

```yaml
- insert:
    - id: dsh-weixin
      name: dsh-weixin-player
      config:
        workspace: 'E:/work/my-project'
        allowFrom:
          - '你的微信id@im.wechat'
```

## 登录与工具开关（右侧栏 tab）

重启并刷新页面后，右侧栏「新建 tab」里会出现 **微信**：

1. 点「开始登录」，出二维码 → 手机微信扫。
2. 手机提示数字验证码时，tab 里会出现输入框，填进去即可。
3. 登录成功后监控自动启动，**不用再重启**。

同一个 tab 顶部是**本会话的微信工具**开关：

- 「启用」→ 只把这个会话加入可见范围；按钮旁会显示「已启用」或「已启用（待生效）」。
- 「停用」→ 撤掉注册，会话恢复原样。
- 对**下一轮对话**生效（当前这一轮的请求已经发出，工具清单已冻结）。

> 微信会话（就是那些被微信用户驱动的会话）默认自动持有这三个工具——它们本来就是为在微信上说话而存在的。想关掉这个默认行为，把 `autoEnableTools` 设为 `false`，之后也只能在 tab 里手动开。

完整状态页（账号表、会话绑定、日志路径）仍在 <http://127.0.0.1:3080/dsh-weixin>。

## 配置

配置写在挂载行（profile 的 `cordis.patch.yml`）的 `config:` 里，全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启动长轮询 |
| `workspace` | 进程 cwd | agent 会话的工作目录（绝对路径） |
| `agentPreset` | 部署默认预设 | 微信会话用哪个 Agent 预设；写 `none` = 不组合预设（没有工具） |
| `allowFrom` | 账号主人 | 允许对话的微信 id 列表；留空则只允许扫码登录的那个微信号 |
| `sessionMode` | `per-peer` | `per-peer`：一人一会话；`shared`：所有人共用一会话 |
| `sharedSessionId` | `session-dsh-weixin` | `shared` 模式下的会话 id |
| `autoEnableTools` | `true` | 微信会话是否自动持有 `weixin_*` 工具 |
| `markdown` | `true` | 清理微信渲染不了的 Markdown（图片、CJK 斜体标记、H5/H6 标题） |
| `typing` | `true` | 是否发「正在输入」 |
| `textChunkLimit` | `4000` | 单条文本上限，超出自动切分 |
| `longPollTimeoutMs` | `35000` | getUpdates 长轮询超时 |
| `quoteCache` | `true` | 本地缓存消息正文，用于补全只带 ID 的引用消息 |
| `quoteCacheMaxMessages` | `1000` | 每个账号缓存多少条 |
| `accounts.<id>.enabled` | `true` | 单独停用某个 bot 账号 |
| `accounts.<id>.name` | — | 账号显示名 |
| `botAgent` | `DSH/0.1` | 请求头里的自我标识（UA 风格） |
| `loginPage` | `true` | 是否提供 tab 与状态页所需的路由 |

配置写错（比如 `markdown: "yes"`）会在挂载时直接报错并指明字段。

## 微信里能用的命令

| 命令 | 作用 |
|---|---|
| `/help` | 命令列表 |
| `/status` | 账号、预设、工作目录、会话 id、运行状态 |
| `/whoami` | 我的微信 id / 账号 / 会话 id |
| `/new` | 换一段全新会话（旧上下文不带入） |
| `/stop` | 中止正在生成的那一轮 |

不是这五个的命令（例如 `/etc/hosts 是什么`）照常当普通消息交给 agent。

## agent 怎么发文件

回复里**单独一行**写 `MEDIA:<绝对路径>`，这一行会被摘掉，文件按 MIME 走图片/视频/文件通道上传：

```
报表已经生成。

MEDIA:E:/work/report.xlsx
```

也可以调用 `weixin_send` 工具主动推送（需要该会话已启用工具）。

## 数据放在哪

```
<DSH_HOME>/weixin/
├── accounts.json                 已登录账号索引
├── accounts/<accountId>.json     凭据（token/baseUrl/绑定的微信号，权限 600）
├── accounts/<accountId>.sync.json            长轮询游标
├── accounts/<accountId>.context-tokens.json  每条消息的 context_token
├── accounts/<accountId>.quotes.json          引用消息缓存
├── peers.json                    微信用户 → DSH 会话绑定
├── tool-optins.json              哪些会话被启用过 weixin_* 工具
└── media/{inbound,outbound-temp}/            解密后的媒体文件
<DSH_HOME>/logs/dsh-weixin-<日期>.log         渠道日志（JSON lines）
```

`DSH_HOME` 默认 `~/.dsh`。

## 与上游 openclaw-weixin 的关系

**逐字复用**：iLink 协议（`getUpdates`/`sendMessage`/`getUploadUrl`/CDN 加解密、AES-ECB、缩略图上传）、账号与游标存储、流式 Markdown 过滤器、发送分片、媒体加解密与 MIME 处理。

**重写**：

| 上游（OpenClaw） | 这里（DSH） |
|---|---|
| `ChannelPlugin` 契约 + 网关注入的 `channelRuntime` | cordis 插件 `apply(ctx, config)`，直连 `agents`/`sessions`/`agentDefaultModel`/`agentPresets` |
| 阻塞式终端扫码 + stdin 输入验证码 | 非阻塞 QR 状态机 + 右侧栏 tab / 网页扫码 |
| 全局注册的 agent 工具 | **按会话**注册到 `agent.ctx.tools`，不碰预设；tab 里一个开关 |
| OpenClaw 会话/回复/路由管线 | `agents.create/resume` + `followup()` + `session/event` 收口 |
| `openclaw.json` 配置、`mutateConfigFile` | Loader 行 `config:`，手写校验 |
| 全量引用+媒体缓存（quote-store 22KB） | 只缓存文本的紧凑实现；引用里的媒体标注为「已过期」 |
| `channelRuntime.media.saveMediaBuffer` | 落盘到 `DSH_HOME/weixin/media/`，把路径交给 agent |
| `openclaw-weixin` 的 pairing/命令授权框架 | `allowFrom` + 内置 5 个渠道命令 |

## 故障排查

| 现象 | 处理 |
|---|---|
| 右侧栏没有「微信」tab | 客户端 tab 是 `dsh web` 启动时下发的：确认已重启 dsh web **并刷新页面**；浏览器控制台搜 `[dsh-weixin]` 看是否报了 `sidebarRightTabs is missing` |
| tab 里工具按钮置灰 | 该 tab 没绑定会话（不是从某个会话打开的）。在会话里打开右侧栏再新建这个 tab |
| 点了「启用」但 agent 还是没工具 | 按钮显示「已启用（待生效）」说明会话当时没有活动的 agent；发一条消息让它启动，工具随下一次请求生效 |
| 状态页打不开 | profile 没有 `webServer`（例如 headless）。日志会提示 |
| 二维码不显示 | 插件目录没 `npm install`（`qrcode` 缺）；tab 会退化为「复制链接到手机微信打开」 |
| 收消息无响应 | 看日志里 `inbound: dropped message from unauthorized peer=`：把该微信 id 加进 `allowFrom` |
| `token 已失效，暂停 60 分钟` | bot token 被服务端作废：重新扫码登录 |
| 发文件失败 | agent 给的是相对路径；`MEDIA:` 相对路径按 `workspace` 解析，建议写绝对路径 |
| 会话想推倒重来 | 微信里发 `/new` |

日志：`<DSH_HOME>/logs/dsh-weixin-*.log`；也可以问 agent「用 weixin_status 看看渠道状态」。

## 卸载

```powershell
dsh plugin --profile web remove dsh-weixin-player
```

## 开发

```powershell
npm run typecheck   # 宿主 + 客户端两份 tsconfig
npm test            # 编译后跑 node --test（100 项）
npm run build       # esbuild 出 lib/client.js + tsc 出 lib/**/*.js 与类型
```

两半的结构：

| 半边 | 入口 | 产物 |
|---|---|---|
| 宿主 | `src/index.ts` | `lib/**/*.js`（tsc，一模块一文件） |
| 客户端 | `src/client/index.tsx` | `lib/client.js`（esbuild，`window.__ModuleLoader__` 注册，react 外置） |

测试覆盖：配置校验、分片与 Media 指令解析、凭据与引用缓存、turn 收集、peer→会话绑定与串行化、HTTP 路由与同源校验、**按会话工具启用/撤销/持久化**、客户端 bundle 的模块装载与 tab 注册，以及一条 **fetch 打桩的端到端链路**（收消息→驱动 turn→发回复）。
