import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-host-"));

const { isTrustedRequest, isLoopbackHostname } = await import("../lib/host/trust-fence.js");
const { buildWeixinRoutes } = await import("../lib/host/routes.js");
const { normalizeConfig } = await import("../lib/config.js");

const CONFIG = normalizeConfig({ workspace: "/tmp/workspace" }, "/tmp/workspace");

/** Fake channel runtime with a scripted QR manager. */
function makeRuntime(overrides = {}) {
  const calls = [];
  return {
    calls,
    qr: {
      async start(options) {
        calls.push({ type: "start", options });
        return {
          sessionKey: "key-1",
          status: "wait",
          message: "scan me",
          qrcodeUrl: "https://example.test/qr",
          startedAt: 1,
          needsVerifyCode: false,
        };
      },
      latest() {
        return null;
      },
      snapshot() {
        return null;
      },
      submitVerifyCode(sessionKey, code) {
        calls.push({ type: "verify", sessionKey, code });
        return code === "123456";
      },
      ...overrides,
    },
    snapshot() {
      return {
        workspace: "/tmp/workspace",
        agentPreset: undefined,
        sessionMode: "per-peer",
        allowFrom: [],
        accounts: [],
        peers: [],
        logFile: "/tmp/log.jsonl",
      };
    },
    // The channel runtime always has these; `toolExposure` answering undefined
    // is what a deployment without a tool registry looks like.
    toolExposure() {
      return undefined;
    },
    setToolsEnabled() {
      throw new Error("dsh-weixin: this profile has no tool registry, so tools cannot be enabled");
    },
    // Workspace routes: a tiny in-memory stand-in for the real store.
    ...(overrides.workspaceApi === false
      ? {}
      : {
          currentWorkspace: "/tmp/workspace",
          workspacePayload() {
            return {
              ok: true,
              path: this.currentWorkspace,
              source: this.currentWorkspace === "/tmp/workspace" ? "config" : "settings",
              exists: true,
              writable: true,
            };
          },
          setWorkspace(input) {
            calls.push({ type: "setWorkspace", input });
            if (input.trim() === "") {
              this.currentWorkspace = "/tmp/workspace";
              return this.workspacePayload();
            }
            if (!input.trim().match(/^[A-Za-z]:[\\/]|^\//)) {
              throw new Error(`请填写绝对路径（例如 E:\\work\\project），收到的是 ${input}`);
            }
            this.currentWorkspace = path.resolve(input);
            return this.workspacePayload();
          },
          listDirectory(target) {
            calls.push({ type: "listDirectory", target });
            return {
              ok: true,
              path: target ?? this.currentWorkspace,
              parent: "/",
              entries: [{ name: "child", path: path.join(target ?? this.currentWorkspace, "child") }],
              truncated: false,
            };
          },
        }),
  };
}

/** Start a loopback HTTP server serving the plugin's routes. */
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

test("isLoopbackHostname accepts local authorities only", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("foo.localhost"), true);
  assert.equal(isLoopbackHostname("example.com"), false);
});

test("isTrustedRequest rejects a foreign Host header", () => {
  assert.equal(isTrustedRequest({ headers: { host: "evil.example" } }), false);
  assert.equal(isTrustedRequest({ headers: { host: "127.0.0.1:3080" } }), true);
  assert.equal(isTrustedRequest({ headers: {} }), false);
});

test("isTrustedRequest rejects a cross-origin Origin header", () => {
  assert.equal(
    isTrustedRequest({ headers: { host: "127.0.0.1:3080", origin: "https://evil.example" } }),
    false,
  );
  assert.equal(
    isTrustedRequest({ headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" } }),
    true,
  );
});

test("isTrustedRequest honours the deployment's trusted hosts", () => {
  assert.equal(
    isTrustedRequest({ headers: { host: "box.tail1234.ts.net" } }, ["box.tail1234.ts.net"]),
    true,
  );
});

test("the login page renders without external assets", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /DSH 微信渠道/);
    assert.match(html, /\/dsh-weixin\/login\/start/);
    assert.ok(!/<script[^>]+src=/.test(html), "the page must not load external scripts");
  });
});

test("the status route reports the channel snapshot", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/status`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.channel.workspace, "/tmp/workspace");
    assert.equal(body.login, null);
  });
});

test("login start posts through to the QR manager", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/login/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.login.sessionKey, "key-1");
    assert.deepEqual(runtime.calls[0], { type: "start", options: { force: true } });
  });
});

test("login start rejects GET", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/login/start`);
    assert.equal(response.status, 405);
  });
});

test("verify requires a numeric code", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const bad = await fetch(`${base}/dsh-weixin/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "key-1", code: "abc" }),
    });
    assert.equal(bad.status, 400);

    const okay = await fetch(`${base}/dsh-weixin/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "key-1", code: "123456" }),
    });
    assert.equal(okay.status, 200);
    assert.equal((await okay.json()).ok, true);
  });
});

test("a foreign Origin cannot drive the verify route", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ sessionKey: "key-1", code: "123456" }),
    });
    assert.equal(response.status, 403);
    assert.equal(runtime.calls.length, 0);
  });
});

test("the QR image route answers 404 without an active code", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/login/qr.png`);
    assert.equal(response.status, 404);
  });
});

test("the tools route degrades when the channel has no tool registry", async () => {
  // `makeRuntime` exposes neither `toolExposure` nor `setToolsEnabled`, which is
  // exactly the shape of a deployment without a tool registry.
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/tools?sessionId=session-a`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, false);
    assert.deepEqual(body.tools, []);
    assert.match(body.note, /工具注册表/);
  });
});

test("the tools route rejects a request without a session id", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/tools`);
    assert.equal(response.status, 400);
  });
});

test("the tools route only answers same-origin requests", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ sessionId: "session-a", enabled: true }),
    });
    assert.equal(response.status, 403);
  });
});

test("the workspace route reports the effective directory", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/workspace`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, "/tmp/workspace");
    assert.equal(body.source, "config");
    assert.equal(body.exists, true);
  });
});

test("the workspace route saves a picked directory", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/srv/projects/alpha" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, path.resolve("/srv/projects/alpha"));
    assert.equal(body.source, "settings");

    // Going back to config is an empty save.
    const cleared = await fetch(`${base}/dsh-weixin/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "" }),
    });
    assert.equal((await cleared.json()).source, "config");
  });
});

test("an unusable workspace is a 400 with the reason", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "relative/dir" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /绝对路径/);
  });
});

test("the fs route lists sub-directories", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/fs?path=${encodeURIComponent("/srv")}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, "/srv");
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].name, "child");
    assert.deepEqual(runtime.calls.at(-1), { type: "listDirectory", target: "/srv" });
  });
});

test("the fs route defaults to the current workspace", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/fs`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).path, "/tmp/workspace");
  });
});

test("the workspace routes are fenced against cross-origin writes", async () => {
  const runtime = makeRuntime();
  const routes = buildWeixinRoutes({ runtime, config: CONFIG, trustedHosts: () => [] });

  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/dsh-weixin/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ workspace: "/srv/projects/alpha" }),
    });
    assert.equal(response.status, 403);
    assert.equal(runtime.calls.some((call) => call.type === "setWorkspace"), false);
  });
});
