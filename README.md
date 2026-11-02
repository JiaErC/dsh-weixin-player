# dsh-weixin-player

A WeChat (Weixin) channel for **DeepSeek Harness**: one WeChat message becomes one
agent turn, and the agent's answer is delivered back into the chat.

A port of [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — Tencent's
official OpenClaw WeChat channel built on the iLink long-poll protocol. The protocol
layer is reused nearly verbatim; the channel lifecycle is rewritten as a DSH cordis
plugin.

```
WeChat user ──getUpdates long-poll──▶ this plugin ──followup()──▶ DSH session (agent)
     ▲                                                               │
     └──────────── sendMessage ◀── assistant text stream ◀───────────┘
```

Full Chinese documentation (the primary one): [README.zh.md](README.zh.md).

## What it does

- **QR login in the browser** at `/dsh-weixin` — scan with the WeChat app, enter the
  numeric code when the phone asks for it.
- **Multi-account** — one long-poll loop per logged-in bot; reconnect backoff, stale
  token cooldown, cursor persisted across restarts.
- **One DSH session per WeChat peer** — resumed on restart, so context survives.
- **Media both ways** — inbound images/video/files/voice are decrypted to disk and the
  agent is told the local path; the agent sends a file by writing `MEDIA:<path>` on its
  own line.
- **Typing indicator** while the model is generating.
- **Channel commands** that never reach the model: `/help`, `/status`, `/whoami`,
  `/new`, `/stop`.
- **Agent tools**: `weixin_send`, `weixin_login`, `weixin_status`.

## Install

```powershell
cd E:\AI_dsh_plugin\dsh-weixin-player
npm install
npm run build
dsh plugin --profile web add link:E:/AI_dsh_plugin/dsh-weixin-player
# restart `dsh web`, then open http://127.0.0.1:3080/dsh-weixin
```

Dependencies must be installed inside this directory first: a `link:` install does not
bring them along.

## Configuration

All fields are optional; they live in the Loader row's `config:` block in the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-weixin
      name: dsh-weixin-player
      config:
        workspace: 'E:/work/my-project'
        agentPreset: standard        # or 'none' for a bare agent
        allowFrom: ['you@im.wechat'] # default: the account's QR-login owner
        sessionMode: per-peer        # or 'shared'
        textChunkLimit: 4000
```

See [README.zh.md](README.zh.md) for the full table, the data layout under
`<DSH_HOME>/weixin/`, the differences from upstream, and troubleshooting.

## Development

```powershell
npm run typecheck
npm test    # builds, then runs 80 node:test cases
```

The suite includes an end-to-end test that stubs `fetch` at the network boundary and
drives the real long-poll loop, inbound pipeline, agent manager and outbound send path.

## Licence

MIT. The WeChat protocol implementation derives from
[openclaw-weixin](https://github.com/Tencent/openclaw-weixin), which is MIT licensed and
copyright Tencent.
