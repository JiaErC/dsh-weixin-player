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

- **右侧栏「微信」tab**：扫码登录、看账号状态、**选工作目录**、**给当前会话开关微信工具**，全部在 DSH 界面里完成，不用开终端。
- **工作目录自己选**：默认取 `dsh web` 的启动目录，但可以在 tab 里直接改（支持目录树浏览），选择存盘、重启后仍生效；只影响之后新建的微信会话，不动已有会话的目录。
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

## 右侧栏「微信」tab

重启并刷新页面后，右侧栏「新建 tab」里会出现 **微信**，从上到下三块：

### 1. 工作目录

微信里的 agent 会话在哪个目录下干活，就在这里选。

- 顶部显示当前生效目录，右边一个徽标说明它是**自定义**（tab 里选的）还是**来自配置**（`cordis.patch.yml` 里的 `workspace`）。
- 直接改输入框里的绝对路径后点「保存」；或者点「浏览…」打开**选择目录弹窗**：弹窗顶部是一条可编辑的路径框（可直接输入或粘贴绝对路径，回车即跳转，旁边有「转到」按钮），下面是当前目录的子目录列表，点目录进入、点「↑ 上一级」返回，最后点「用这个目录」保存。
- 弹窗里路径打错不会关掉弹窗：错误显示在路径框下方，改完再回车即可。按 `Esc`、点遮罩或「取消」都能关闭。
- 目录不存在时会**自动创建**（和 DSH 自己建项目目录的行为一致）；不存在的父级也会一并建。
- 选择立刻生效并写进 `<DSH_HOME>/weixin/settings.json`，重启后仍是它。
- 清空输入框再保存 = 回到配置里的值。
- **只影响之后新建的微信会话**：已经在跑的会话把目录记在会话头里，不会被动挪走；在微信里发 `/new` 就会用新目录。

> 目录只有「只读」权限时也能保存，tab 会提示「该目录当前不可写」——读代码的场景仍然成立，但 agent 落盘会失败。

### 2. 微信会话设置（Agent 预设 + 权限等级）

微信里的每一段会话，用哪套 Agent 组合、跑在哪个权限等级下，都在这张卡片里选。

**Agent 预设**下拉框列出的是 `agentPresetRegistry` 的当前清单，所以：

- **「Agent预设」插件里保存并发布过的预设，会直接出现在这里**——本插件不认识那个编辑器，它读的就是发布后的注册表，编辑器一保存就多一项。
- 标「（部署默认）」的是部署给未指定预设的会话用的那套；标「（不可用）」的是注册表报告无法组合的（配置报错），选不了。
- 「跟随配置」= 不覆盖，用 `cordis.patch.yml` 里的 `agentPreset`；「不组合预设」= 裸 agent（没有工具），对应 `agentPreset: none`。

**权限等级**下拉框列的是 `permissionPresets` 的目录，三档就是你要的：

| 选项 | 预设 id | 沙箱 | 审批 |
|---|---|---|---|
| 仅可查看 | `read-only` | 只读 | 需要审批 |
| 工作区内修改 | `workspace-write` | 只能写工作区 | 需要审批 |
| 完全权限 | `danger-full-access` | 无限制 | 不审批 |

标「（部署默认）」的那一项是没做选择时会用的。选完点「保存」即生效，写进 `<DSH_HOME>/weixin/settings.json`，重启后还在。

实现方式与官方渠道插件一致：新会话 `agents.create` 之后立刻 `permissionPresets.set(session, 预设)`——它会同时写入 `permission/preset` 这个持久事实和沙箱、审批两个旋钮，所以会话里显示的权限名是对的，而不是 `custom`。

> **只影响之后新建的微信会话。** 已有会话把自己的预设和权限记在自己的日志里，插件不会去改——想按新设置重开一段，在微信里发 `/new`（或在小程序里「新会话」）。
> 权限预设目录来自 profile 的 `permission` 行；如果那里只写了 `workspace-write` / `danger-full-access`，这一栏就只有两项（本部署三者俱全）。

### 3. 本会话的微信工具

- 「跳转到会话」（在启用/停用**左边**）→ 直接在 DSH 主视图里打开**微信聊天对应的会话**，等于在会话列表里点它一下。
  - 选谁：优先打开**绑定了当前会话的那个微信 peer**（也就是你正待着的会话，点了等于聚焦回来）；当前会话还没绑定微信时，打开**最近活跃**的那个微信会话。
  - 还没有任何微信会话时按钮是灰的，鼠标悬停会说明原因。
  - 用的是 DSH 自己的导航服务 `uiWorkspace.openSession()`，所以跳转后的行为和点会话列表完全一致（标签页、右栏状态都会跟着切）。
- 「启用」→ 只把这个会话加入可见范围；按钮旁会显示「已启用」或「已启用（待生效）」。
- 「停用」→ 撤掉注册，会话恢复原样。
- 对**下一轮对话**生效（当前这一轮的请求已经发出，工具清单已冻结）。

> 微信会话（就是那些被微信用户驱动的会话）默认自动持有这三个工具——它们本来就是为在微信上说话而存在的。想关掉这个默认行为，把 `autoEnableTools` 设为 `false`，之后也只能在 tab 里手动开。手动「停用」过的微信不会在下一轮被自动打开。

### 4. 连接微信

1. 点「开始登录」，出二维码 → 手机微信扫。
2. 手机提示数字验证码时，tab 里会出现输入框，填进去即可。
3. 登录成功后监控自动启动，**不用再重启**。

完整状态页（账号表、会话绑定、日志路径）仍在 <http://127.0.0.1:3080/dsh-weixin>。

## 配置

配置写在挂载行（profile 的 `cordis.patch.yml`）的 `config:` 里，全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启动长轮询 |
| `workspace` | 进程 cwd | 微信 agent 会话的默认工作目录（绝对路径）；tab 里选过的值会覆盖它 |
| `agentPreset` | 部署默认预设 | 微信会话用哪个 Agent 预设；写 `none` = 不组合预设（没有工具） |
| `permissionPreset` | 部署默认权限 | 新微信会话的权限等级预设，如 `read-only` / `workspace-write` / `danger-full-access` |
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
| `mpApi.enabled` | `false` | 是否开放 `/dsh-weixin/mp/*`（微信小程序 WeixinPlayer 用） |
| `mpApi.token` | 自动生成 | 固定小程序 API 的令牌；留空则用 `mp-token.txt` 里那个 |

配置写错（比如 `markdown: "yes"`）会在挂载时直接报错并指明字段。

## 微信小程序接口（可选）

[`WeixinPlayer`](E:/ai_projects/WeixinPlayer) 小程序用这组接口遥控这台电脑。**默认关闭**，因为手机
够不到 `127.0.0.1`，要开放就得让端口对外可达，而这块接口能列目录、能换工作目录、能开新会话。

打开方式（profile 的 `cordis.patch.yml`，覆盖插件那一行的 config）：

```yaml
- id: dsh-weixin
  config:
    mpApi:
      enabled: true
```

重启后日志会打 `mini-program API at /dsh-weixin/mp (token abcd…yz)`，完整令牌在
`<DSH_HOME>/weixin/mp-token.txt`，也可以从「微信」tab 里复制。

| 路由 | 说明 |
|---|---|
| `GET /dsh-weixin/mp/hello` | 机器身份 + 工作目录 + 账号 |
| `GET /dsh-weixin/mp/state` | 一次拿全：机器、工作目录、预设清单、会话、账号 |
| `POST /dsh-weixin/mp/workspace` | 换工作目录（同 tab 里那套语义：只影响新会话） |
| `GET /dsh-weixin/mp/fs?path=` | 目录**与文件**列表（只有元数据：名字/大小/时间） |
| `GET /dsh-weixin/mp/messages?peerId=` | 这个微信对话最近 40 条消息（渠道自己记的收发记录） |
| `GET /dsh-weixin/mp/file?path=` | 文本预览：**仅限工作目录内**、≤64KB、跳过点文件、拒绝二进制 |
| `POST /dsh-weixin/mp/session` | 给某个微信对话开新会话，可选换 Agent 预设 |
| `GET /dsh-weixin/mp/token` | 取令牌（仅同源，给 tab 复制用） |

除 `/mp/token` 外都要 `Authorization: Bearer <token>`；常量时间比较，失败会记日志。
`/mp/token` 走同源围栏，所以同浏览器里别的页面读不到它。

三条边界，写在这里省得以后踩：
- **消息记录是渠道自己攒的**：只有经过本渠道的「用户发来的正文」和「渠道实际发出去的回复」，
  每条对话留最近 40 条、每台机器最多 50 个对话，落盘在 `<DSH_HOME>/weixin/recent.json`。
  重启之前的历史不在里面（它不是 DSH 会话日志的镜像）。
- **文件预览有三道闸**：必须在当前工作目录内、路径里不能有点开头的段落（`.env`/`.ssh` 这类）、
  扩展名在白名单内且前 4KB 没有 NUL 字节；最多返回 64KB，超出截断并标 `truncated`。
- **换预设 = 开新会话**：DSH 一旦某个会话跑过一轮就锁定预设（`agent-preset/locked`），
  所以「给这个微信对话换预设」必然是「用新预设开一段新会话」，接口返回值里带 `previousSessionId`。

还需要注意：`dsh web` 默认只监听 `127.0.0.1`，手机连不上。同网段用
`webserver.host: 0.0.0.0`，或用隧道拿 HTTPS 地址（小程序正式环境要求 HTTPS + 备案域名）。

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
├── settings.json                 tab 里选的工作目录等用户设置
├── mp-token.txt                  小程序 API 的令牌（权限 600，mpApi 打开时生成）
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
| 发文件失败 | agent 给的是相对路径；`MEDIA:` 相对路径按工作目录解析，建议写绝对路径 |
| 保存工作目录时报「请填写绝对路径」 | 只接受绝对路径（`E:\work\x` 或 `/srv/x`），`~` 会被展开 |
| 换了工作目录，但微信里还是旧目录 | 已有会话把目录记在会话头里；在微信里发 `/new` 开新会话才会用新目录 |
| agent 说写不了文件 | 工作目录可能只读；tab 里会提示「该目录当前不可写」，换一个有写权限的目录 |
| 扫码后微信弹窗写着「OpenClaw / 微信ClawBot」 | 那是**微信自己的**绑定弹窗文案，不是本插件输出：详见下面「关于扫码弹窗里的产品名」 |
| 会话想推倒重来 | 微信里发 `/new` |

### 关于扫码弹窗里的产品名

扫描二维码后，微信会弹一句「将 **OpenClaw** 连接到微信，连接后将启用 微信ClawBot 插件……」。这句话**不是本插件写的，也改不掉**，原因有三条可直接验证的事实：

1. 我们请求二维码的接口是 `POST ilink/bot/get_bot_qrcode?bot_type=3`，请求体只有 `{ "local_token_list": [...] }` —— 协议里**没有任何"显示名 / 昵称 / 产品名"字段**（见上游 `docs/protocol.md`）。
2. 返回的二维码内容只有一个不透明 id：
   `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=<不透明id>&bot_type=3`
   —— 弹窗文案由微信侧的 `liteapp.weixin.qq.com` 页面渲染，属于微信/腾讯的产品文案。
3. `bot_type` 只有 `3` 有效（`1/2/4/0` 服务端都返回 `ret: 2` 拒绝），没有"换一个产品模板"的选项。

因此插件这一侧**没有任何字符串会出现在那个弹窗里**；本仓库也已经没有任何 `OpenClaw` / `ClawBot` 字样。唯一与上游相关的自报字段是请求体里的 `bot_agent`（默认值已改为 `DSH/0.1`，也可用 `botAgent` 配置覆盖），按协议说明它只用于服务端观测，不参与鉴权与路由，也不影响该弹窗。

想让微信里显示 **DeepSeek Harness**，可行的只有微信侧的动作：绑定成功后，在微信里打开这个机器人会话 → 右上角资料/设置，修改它的**名称或备注**（能否改名取决于微信版本）。

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
