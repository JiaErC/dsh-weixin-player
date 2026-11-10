import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-mp-"));

const { buildWeixinRoutes } = await import("../lib/host/routes.js");
const { normalizeConfig } = await import("../lib/config.js");
const { maskToken, tokenMatches } = await import("../lib/host/mp-token.js");

const CONFIG = normalizeConfig({ workspace: "/tmp/workspace" }, "/tmp/workspace");
const TOKEN = "test-token-0123456789";

/**
 * A channel runtime with just the mini-program surface.
 *
 * Everything goes through `calls` so the tests can assert not only the response
 * but whether an operation was actually attempted.
 */
function makeRuntime(overrides = {}) {
  const calls = [];
  const state = {
    workspace: "/tmp/workspace",
    source: "config",
    presets: [
      { id: "standard", isDefault: true, name: "标准" },
      { id: "coder", isDefault: false, name: "编码" },
      { id: "broken-one", isDefault: false, broken: "missing plugin" },
    ],
    peers: [
      {
        accountId: "acc-1",
        peerId: "peer-a@im.wechat",
        sessionId: "session-weixin-aaaa",
        generation: 0,
        lastActiveAt: 10,
        running: true,
        preset: "coder",
      },
    ],
    accounts: [
      { accountId: "acc-1", running: true, inboundCount: 3, ownerUserId: "owner@im.wechat" },
    ],
  };

  const workspacePayload = () => ({
    ok: true,
    path: state.workspace,
    source: state.source,
    exists: true,
    writable: true,
  });

  return {
    calls,
    state,
    workspacePayload,
    machineInfo() {
      return {
        hostname: "test-box",
        platform: "win32/x64",
        node: "22.0.0",
        channelVersion: "0.1.0",
      };
    },
    mpAccounts() {
      return state.accounts;
    },
    mpHello() {
      return {
        ok: true,
        machine: this.machineInfo(),
        workspace: { path: state.workspace, source: state.source, writable: true },
        accounts: state.accounts,
        startedAt: 123,
      };
    },
    async mpPresets() {
      return state.presets;
    },
    async mpState() {
      return {
        ok: true,
        machine: this.machineInfo(),
        workspace: { ...workspacePayload() },
        presets: state.presets,
        peers: state.peers,
        accounts: state.accounts,
      };
    },
    setWorkspace(input) {
      calls.push({ type: "setWorkspace", input });
      if (input.trim() !== "" && !input.trim().match(/^[A-Za-z]:[\\/]|^\//)) {
        throw new Error("请填写绝对路径");
      }
      state.workspace = input.trim() === "" ? "/tmp/workspace" : path.resolve(input);
      state.source = input.trim() === "" ? "config" : "settings";
      return workspacePayload();
    },
    mpEntries(target) {
      calls.push({ type: "mpEntries", target });
      if (target === "relative") throw new Error("请填写绝对路径");
      return {
        ok: true,
        path: target ?? state.workspace,
        parent: "/",
        entries: [
          { name: "src", path: `${target ?? state.workspace}/src`, kind: "dir" },
          { name: "README.md", path: `${target ?? state.workspace}/README.md`, kind: "file", size: 42 },
        ],
        truncated: false,
      };
    },
    async mpNewSession(request) {
      calls.push({ type: "mpNewSession", request });
      if (request.preset !== undefined && request.preset !== "" && request.preset !== "none") {
        const known = state.presets.find((preset) => preset.id === request.preset);
        if (known === undefined) throw new Error(`没有这个 Agent 预设：${request.preset}`);
        if (known.broken !== undefined) throw new Error(`这个预设当前不可用：${known.broken}`);
      }
      return {
        ok: true,
        accountId: request.accountId ?? "acc-1",
        peerId: request.peerId,
        sessionId: "session-weixin-bbbb",
        ...(request.preset === undefined ? {} : { preset: request.preset }),
        previousSessionId: "session-weixin-aaaa",
      };
    },
    mpMessages(request) {
      calls.push({ type: "mpMessages", request });
      if (request.peerId.trim() === "") throw new Error("peerId 不能为空");
      return {
        ok: true,
        accountId: request.accountId ?? "acc-1",
        peerId: request.peerId,
        messages: [
          { role: "user", text: "帮我看下构建", at: 1 },
          { role: "assistant", text: "构建通过了", at: 2 },
        ].slice(-(request.limit ?? 20)),
      };
    },
    mpReadFile(target) {
      calls.push({ type: "mpReadFile", target });
      if (target === undefined || target.trim() === "") throw new Error("path 不能为空");
      if (target.includes("binary")) throw new Error("这是二进制文件，不支持预览");
      return {
        ok: true,
        path: target,
        name: "README.md",
        size: 12,
        truncated: false,
        text: "# hello\n",
      };
    },
    ...overrides,
  };
}

/** Serve the plugin's routes on loopback. */
async function withServer(routes, run) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes.find((entry) => entry.path === pathname);
    if (route === undefined) {
      res.writeHead(404).end("no route");
      return;
    }
    void route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Routes with the mini-program API switched on. */
function routesWithApi(runtime = makeRuntime()) {
  return {
    runtime,
    routes: buildWeixinRoutes({
      runtime,
      config: CONFIG,
      trustedHosts: () => [],
      mpApiToken: () => TOKEN,
    }),
  };
}

const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });

test("tokenMatches compares without leaking length-only equality", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("abc", "ab"), false);
  assert.equal(tokenMatches("abc", undefined), false);
  assert.equal(maskToken("0123456789abcdef"), "0123…ef");
  assert.equal(maskToken("short"), "****");
});

test("the mini-program routes are absent unless the API is enabled", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({
    runtime,
    config: normalizeConfig({ workspace: "/tmp/workspace" }, "/tmp/workspace"),
    trustedHosts: () => [],
  });
  assert.equal(
    routes.some((route) => route.path.startsWith("/dsh-weixin/mp")),
    false,
    "no mp route may be registered while mpApi is off",
  );

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/mp/hello`, { headers: auth() });
    assert.equal(response.status, 404);
  });
});

test("every mini-program route demands the bearer token", async () => {
  const { routes } = routesWithApi();

  await withServer(routes, async (base) => {
    const missing = await fetch(`${base}/dsh-weixin/mp/state`);
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/);

    const wrong = await fetch(`${base}/dsh-weixin/mp/state`, { headers: auth("nope") });
    assert.equal(wrong.status, 401);

    const good = await fetch(`${base}/dsh-weixin/mp/state`, { headers: auth() });
    assert.equal(good.status, 200);
  });
});

test("hello reports the machine identity", async () => {
  const { routes } = routesWithApi();

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/mp/hello`, { headers: auth() });
    const body = await response.json();
    assert.equal(body.machine.hostname, "test-box");
    assert.equal(body.workspace.path, "/tmp/workspace");
    assert.equal(body.workspace.source, "config");
    assert.equal(body.startedAt, 123);
  });
});

test("state bundles workspace, presets, peers and accounts", async () => {
  const { routes } = routesWithApi();

  await withServer(routes, async (base) => {
    const body = await (await fetch(`${base}/dsh-weixin/mp/state`, { headers: auth() })).json();
    assert.equal(body.presets.length, 3);
    assert.equal(body.presets[0].isDefault, true);
    assert.equal(body.peers[0].peerId, "peer-a@im.wechat");
    assert.equal(body.peers[0].preset, "coder");
    assert.equal(body.accounts[0].inboundCount, 3);
  });
});

test("the workspace route switches the directory the next session uses", async () => {
  const { routes, runtime } = routesWithApi();

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/mp/workspace`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/srv/projects/alpha" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, path.resolve("/srv/projects/alpha"));
    assert.equal(body.source, "settings");
    assert.deepEqual(runtime.calls.at(-1), {
      type: "setWorkspace",
      input: "/srv/projects/alpha",
    });

    const bad = await fetch(`${base}/dsh-weixin/mp/workspace`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "relative/dir" }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /绝对路径/);

    const read = await fetch(`${base}/dsh-weixin/mp/workspace`, { headers: auth() });
    assert.equal(read.status, 405, "the workspace switch is a POST");
  });
});

test("the fs route lists directories and files", async () => {
  const { routes, runtime } = routesWithApi();

  await withServer(routes, async (base) => {
    const body = await (
      await fetch(`${base}/dsh-weixin/mp/fs?path=${encodeURIComponent("/srv/projects")}`, {
        headers: auth(),
      })
    ).json();
    assert.equal(body.path, "/srv/projects");
    assert.deepEqual(
      body.entries.map((entry) => [entry.name, entry.kind]),
      [
        ["src", "dir"],
        ["README.md", "file"],
      ],
    );
    assert.deepEqual(runtime.calls.at(-1), { type: "mpEntries", target: "/srv/projects" });

    const bad = await fetch(`${base}/dsh-weixin/mp/fs?path=relative`, { headers: auth() });
    assert.equal(bad.status, 400);
  });
});

test("the session route starts a new conversation with a chosen preset", async () => {
  const { routes, runtime } = routesWithApi();

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/mp/session`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: "peer-a@im.wechat", preset: "coder" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sessionId, "session-weixin-bbbb");
    assert.equal(body.previousSessionId, "session-weixin-aaaa");
    assert.equal(body.preset, "coder");
    assert.deepEqual(runtime.calls.at(-1).request, {
      peerId: "peer-a@im.wechat",
      preset: "coder",
    });

    const unknown = await fetch(`${base}/dsh-weixin/mp/session`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: "peer-a@im.wechat", preset: "nope" }),
    });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /没有这个 Agent 预设/);

    const noPeer = await fetch(`${base}/dsh-weixin/mp/session`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(noPeer.status, 400);
  });
});

test("the messages route returns the conversation transcript", async () => {
  const { routes, runtime } = routesWithApi();

  await withServer(routes, async (base) => {
    const body = await (
      await fetch(
        `${base}/dsh-weixin/mp/messages?peerId=${encodeURIComponent("peer-a@im.wechat")}&limit=1`,
        { headers: auth() },
      )
    ).json();
    assert.equal(body.peerId, "peer-a@im.wechat");
    assert.deepEqual(body.messages, [{ role: "assistant", text: "构建通过了", at: 2 }]);
    assert.equal(runtime.calls.at(-1).request.limit, 1);

    const missing = await fetch(`${base}/dsh-weixin/mp/messages`, { headers: auth() });
    assert.equal(missing.status, 400);
  });
});

test("the file route previews text and refuses binaries", async () => {
  const { routes, runtime } = routesWithApi();

  await withServer(routes, async (base) => {
    const body = await (
      await fetch(`${base}/dsh-weixin/mp/file?path=${encodeURIComponent("/tmp/workspace/README.md")}`, {
        headers: auth(),
      })
    ).json();
    assert.equal(body.name, "README.md");
    assert.equal(body.text, "# hello\n");
    assert.deepEqual(runtime.calls.at(-1), {
      type: "mpReadFile",
      target: "/tmp/workspace/README.md",
    });

    const binary = await fetch(`${base}/dsh-weixin/mp/file?path=${encodeURIComponent("/tmp/workspace/binary.bin")}`, {
      headers: auth(),
    });
    assert.equal(binary.status, 400);
    assert.match((await binary.json()).error, /二进制/);

    const empty = await fetch(`${base}/dsh-weixin/mp/file`, { headers: auth() });
    assert.equal(empty.status, 400);
  });
});

test("the token route is same-origin only", async () => {  const { routes } = routesWithApi();

  await withServer(routes, async (base) => {
    const ok = await fetch(`${base}/dsh-weixin/mp/token`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.enabled, true);
    assert.equal(body.token, TOKEN);
    assert.equal(body.basePath, "/dsh-weixin/mp");

    const foreign = await fetch(`${base}/dsh-weixin/mp/token`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
  });
});

test("a disabled token route explains how to switch it on", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({
    runtime,
    config: CONFIG,
    trustedHosts: () => [],
    mpApiToken: () => undefined,
  });

  await withServer(routes, async (base) => {
    const body = await (await fetch(`${base}/dsh-weixin/mp/token`)).json();
    assert.equal(body.enabled, false);
    assert.match(body.error, /mpApi/);
  });
});
