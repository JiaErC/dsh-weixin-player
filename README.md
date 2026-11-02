# dsh-weixin-player

A WeChat (Weixin) channel for **DeepSeek Harness**: one WeChat message becomes one
agent turn, and the agent's answer is delivered back into the chat.

A port of [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — Tencent's
official OpenClaw WeChat channel built on the iLink long-poll protocol. The protocol
layer is reused nearly verbatim; the channel lifecycle is rewritten as a DSH cordis
plugin, plus a native right-sidebar tab.

```
WeChat user ──getUpdates long-poll──▶ this plugin ──followup()──▶ DSH session (agent)
     ▲                                                               │
     └──────────── sendMessage ◀── assistant text stream ◀───────────┘

DSH right sidebar「微信」tab ──▶ QR login + per-session tool switch
```

Full Chinese documentation (the primary one): [README.zh.md](README.zh.md).

## What it does

- **A「微信」tab in DSH's own right sidebar** — scan the QR, watch the account state,
  and switch the WeChat tools on for the conversation you are looking at.
- **Per-session tools, not per-preset** — one click registers
  `weixin_send` / `weixin_login` / `weixin_status` on that *one* agent's scope. No
  agent preset is touched, the session's preset does not matter, and the choice is
  remembered across restarts.
- **Multi-account** — one long-poll loop per logged-in bot; reconnect backoff, stale
  token cooldown, cursor persisted across restarts.
- **One DSH session per WeChat peer** — resumed on restart, so context survives.
- **Media both ways** — inbound images/video/files/voice are decrypted to disk and the
  agent is told the local path; the agent sends a file by writing `MEDIA:<path>` on its
  own line.
- **Typing indicator** while the model is generating.
- **Channel commands** that never reach the model: `/help`, `/status`, `/whoami`,
  `/new`, `/stop`.

## Install

```powershell
cd E:\AI_dsh_plugin\dsh-weixin-player
npm install          # a `link:` install does not bring dependencies along
npm run build        # esbuild -> lib/client.js, tsc -> lib/**/*.js
dsh plugin --profile web add link:E:/AI_dsh_plugin/dsh-weixin-player
# restart `dsh web`, then refresh the browser tab (the client tab is served at boot)
```

## Using it

Open a session, then add the **微信** tab from the right sidebar's new-tab page:

- **开始登录** → scan the QR with the WeChat app; type the numeric code when the phone
  asks for one.
- **本会话的微信工具 → 启用** → this conversation, and only this one, gains the tools
  from its next turn on. **停用** takes them away again.

WeChat conversations get the tools automatically (`autoEnableTools: true`), because
those sessions exist to talk on WeChat.

## Configuration

All fields are optional; they live in the Loader row's `config:` block in the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-weixin
      name: dsh-weixin-player
      config:
        workspace: 'E:/work/my-project'
        agentPreset: standard         # or 'none' for a bare agent
        allowFrom: ['you@im.wechat']  # default: the account's QR-login owner
        autoEnableTools: true
        sessionMode: per-peer         # or 'shared'
        textChunkLimit: 4000
```

See [README.zh.md](README.zh.md) for the full table, the data layout under
`<DSH_HOME>/weixin/`, the differences from upstream, and troubleshooting.

## Development

```powershell
npm run typecheck   # host tsconfig + client tsconfig
npm test            # builds, then runs 100 node:test cases
```

Two halves, two builds:

| Half | Entry | Output |
|---|---|---|
| host | `src/index.ts` | `lib/**/*.js` (tsc, one file per module) |
| client | `src/client/index.tsx` | `lib/client.js` (esbuild, `window.__ModuleLoader__`, react external) |

The suite includes an end-to-end test that stubs `fetch` at the network boundary and
drives the real long-poll loop, inbound pipeline, agent manager and outbound send path,
plus per-session tool opt-in/opt-out/persistence and a client-bundle test that
materializes `lib/client.js` the way DSH's module loader does.

## Licence

MIT. The WeChat protocol implementation derives from
[openclaw-weixin](https://github.com/Tencent/openclaw-weixin), which is MIT licensed and
copyright Tencent.
