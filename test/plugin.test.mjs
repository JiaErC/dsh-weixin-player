import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * End-to-end smoke test of the plugin wiring.
 *
 * The WeChat side is faked at the `fetch` boundary — that is exactly where the
 * channel meets the network — so this exercises the real long-poll loop, the
 * real inbound pipeline, the real agent manager and the real outbound send path,
 * with only the DSH host and the iLink server replaced.
 */

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-plugin-"));

const accounts = await import("../lib/protocol/auth/accounts.js");
const plugin = await import("../lib/index.js");

const PEER = "owner@im.wechat";
const ACCOUNT_RAW = "testbot@im.bot";
const ACCOUNT = accounts.normalizeWeixinAccountId(ACCOUNT_RAW);

/** Recorded outbound sendMessage bodies. */
const sentMessages = [];
/** Recorded fetch calls. */
const fetched = [];

/** Wait until `predicate()` is truthy or the deadline passes. */
async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Install a fetch double that speaks just enough iLink. */
function installFetchStub() {
  let pollCount = 0;
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    fetched.push({ url: target, body: init.body });

    if (target.includes("/ilink/bot/getupdates")) {
      pollCount += 1;
      if (pollCount === 1) {
        return jsonResponse({
          ret: 0,
          msgs: [
            {
              message_id: "m-1",
              from_user_id: PEER,
              context_token: "ctx-token",
              create_time_ms: Date.now(),
              item_list: [{ type: 1, text_item: { text: "帮我总结一下这个目录" } }],
            },
          ],
          get_updates_buf: "buf-1",
        });
      }
      // Park the loop on the second poll so it behaves like a real long poll.
      await new Promise((resolve) => {
        const signal = init.signal;
        if (signal === undefined) {
          setTimeout(resolve, 50);
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 50);
      });
      return jsonResponse({ ret: 0, msgs: [], get_updates_buf: "buf-1" });
    }

    if (target.includes("/ilink/bot/getconfig")) {
      return jsonResponse({ ret: 0, typing_ticket: "ticket-1" });
    }

    if (target.includes("/ilink/bot/sendtyping")) {
      return jsonResponse({ ret: 0 });
    }

    if (target.includes("/ilink/bot/sendmessage")) {
      sentMessages.push(JSON.parse(String(init.body ?? "{}")));
      return jsonResponse({ ret: 0, message_id: `srv-${sentMessages.length}` });
    }

    if (target.includes("/ilink/bot/msg/notifystart") || target.includes("/ilink/bot/msg/notifystop")) {
      return jsonResponse({ ret: 0 });
    }

    return jsonResponse({ ret: 0 });
  };

  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fake DSH host: the services the channel consumes. */
function makeHost() {
  const sessionListeners = [];
  const registeredTools = [];
  const registeredRoutes = [];
  const serviceCalls = [];
  const liveAgents = new Map();
  /** session id → the tool names registered on that agent's own scope. */
  const scopedTools = new Map();
  /** Every `permissionPresets.set(session, name)` the channel issued. */
  const permissionCalls = [];

  const emitSessionEvent = (sessionId, event) => {
    for (const listener of sessionListeners) listener({ id: sessionId }, event);
  };

  const makeAgent = (sessionId) => {
    // Each agent owns a scoped tool registry, the way `agent.ctx.tools` does.
    const scoped = new Map();
    scopedTools.set(sessionId, scoped);
    return {
      id: sessionId,
      session: { id: sessionId, seq: 0, header: { cwd: "/tmp/workspace" } },
      status: "idle",
      followup(message) {
        serviceCalls.push({ type: "followup", sessionId, message });
        // Finish the turn on the next tick, like a real loop would.
        setImmediate(() => {
          emitSessionEvent(sessionId, {
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "**目录** 里有两个文件。\n\nMEDIA:/tmp/workspace/report.txt" }] } },
          });
          emitSessionEvent(sessionId, { type: "turn/end", data: { reason: { kind: "completed" } } });
        });
      },
      async whenIdle() {},
      cancel() {
        serviceCalls.push({ type: "cancel", sessionId });
      },
      ctx: {
        tools: {
          register(definition) {
            scoped.set(definition.name, definition);
            return () => scoped.delete(definition.name);
          },
        },
      },
    };
  };

  const services = {
    agents: {
      get: (id) => liveAgents.get(id),
      async create(options) {
        serviceCalls.push({ type: "create", options });
        if (options.setup) await options.setup({}, makeAgent(options.sessionId));
        const agent = makeAgent(options.sessionId);
        liveAgents.set(options.sessionId, agent);
        return {
          agent,
          async dispose() {
            liveAgents.delete(options.sessionId);
            serviceCalls.push({ type: "dispose", sessionId: options.sessionId });
          },
        };
      },
      async resume(options) {
        serviceCalls.push({ type: "resume", options });
        const agent = makeAgent(options.resumeSessionId);
        liveAgents.set(options.resumeSessionId, agent);
        return { agent, async dispose() {} };
      },
    },
    sessions: { flush: async () => true, get: () => undefined },
    sessionQuery: {
      async observeSession() {
        throw new Error("not found");
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }),
    },
    agentPresets: undefined,
    // Permission presets: the catalog the tab offers and the `set` the channel
    // calls on a freshly created session.
    permissionPresets: {
      defaultPreset: "workspace-write",
      catalog: () => ({
        options: [
          { value: "read-only", name: "read-only" },
          { value: "workspace-write", name: "workspace-write" },
          { value: "danger-full-access", name: "danger-full-access" },
        ],
        defaultOptions: [
          { value: "workspace-write", name: "workspace-write" },
          { value: "danger-full-access", name: "danger-full-access" },
        ],
        defaultPreset: "workspace-write",
      }),
      resolve(name) {
        const known = ["read-only", "workspace-write", "danger-full-access"];
        if (!known.includes(name)) throw new Error(`未知权限预设 ${name}`);
        return { sandbox: name, approval: name === "danger-full-access" ? "never" : "ask" };
      },
      set(session, name) {
        permissionCalls.push({ sessionId: session?.id, preset: name });
      },
    },
    tools: {
      register(definition) {
        registeredTools.push(definition);
        return () => {};
      },
    },
    webServer: {
      host: "127.0.0.1",
      port: 3080,
      register(route) {
        registeredRoutes.push(route);
        return () => {};
      },
    },
    webRuntime: { trustedHosts: [] },
    loader: { await: async () => {} },
  };

  const ctx = {
    get: (name) => services[name],
    on(name, listener) {
      if (name === "session/event") sessionListeners.push(listener);
      return () => {};
    },
    effect(setup) {
      const dispose = setup();
      return typeof dispose === "function" ? dispose : () => {};
    },
    logger: undefined,
  };
  services.ctx = ctx;

  return { ctx, services, registeredTools, registeredRoutes, serviceCalls, scopedTools, permissionCalls };
}

test("the plugin mounts routes and tools, then answers a WeChat message end to end", async (t) => {
  const restoreFetch = installFetchStub();
  t.after(() => restoreFetch());

  accounts.saveWeixinAccount(ACCOUNT, { token: "bot-token", userId: PEER });
  accounts.registerWeixinAccountId(ACCOUNT);

  const host = makeHost();
  const disposers = [];
  const originalEffect = host.ctx.effect;
  host.ctx.effect = (setup, label) => {
    const dispose = originalEffect(setup, label);
    disposers.push(dispose);
    return dispose;
  };

  plugin.apply(host.ctx, { workspace: "/tmp/workspace", markdown: true });

  // Dispose even when an assertion below fails: a live monitor keeps timers and
  // sockets alive, and an undisposed run would hang the whole test process.
  t.after(() => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // best effort
      }
    }
  });

  // Mounting is asynchronous: wait for the routes the page needs.
  assert.ok(
    await waitFor(() => host.registeredRoutes.length === 10),
    `expected 10 routes, got ${host.registeredRoutes.map((route) => route.path).join(", ")}`,
  );

  assert.deepEqual(
    host.registeredRoutes.map((route) => route.path).sort(),
    [
      "/dsh-weixin",
      "/dsh-weixin/fs",
      "/dsh-weixin/login/qr.png",
      "/dsh-weixin/login/start",
      "/dsh-weixin/login/status",
      "/dsh-weixin/login/verify",
      "/dsh-weixin/session-settings",
      "/dsh-weixin/status",
      "/dsh-weixin/tools",
      "/dsh-weixin/workspace",
    ],
  );

  // Tools must NOT be registered globally: that would expose them to every
  // agent in the deployment, which is exactly what the tab's switch avoids.
  assert.deepEqual(host.registeredTools, []);

  // The long poll must deliver the message, start a turn and send a reply.
  assert.ok(
    await waitFor(() => sentMessages.length > 0),
    "expected an outbound sendMessage call",
  );

  const outcome = host.serviceCalls.find((call) => call.type === "create");
  assert.ok(outcome, "expected the channel to create an agent session");
  assert.equal(outcome.options.agentOptions.model, "deepseek-flash");
  // The channel normalises the workspace, so the session cwd is absolute.
  assert.equal(outcome.options.meta.cwd, path.resolve("/tmp/workspace"));

  const followup = host.serviceCalls.find((call) => call.type === "followup");
  assert.ok(followup, "expected one driven turn");
  assert.equal(followup.message.content[0].text, "帮我总结一下这个目录");

  // A WeChat conversation gets the channel's tools on its own scope, because
  // those sessions exist to talk on WeChat.
  const channelSessionTools = host.scopedTools.get(outcome.options.sessionId);
  assert.ok(channelSessionTools !== undefined, "expected a scoped registry for the channel session");
  assert.deepEqual(
    [...channelSessionTools.keys()].sort(),
    ["weixin_login", "weixin_send", "weixin_status"],
  );

  const message = sentMessages[0].msg;
  assert.equal(message.to_user_id, PEER);
  assert.equal(message.context_token, "ctx-token");
  assert.equal(message.message_type, 2);
  const text = message.item_list[0].text_item.text;
  assert.match(text, /目录/);
  assert.ok(!text.includes("MEDIA:"), "the MEDIA directive must not reach the user");

  // The typing indicator needs a ticket from getConfig.
  assert.ok(
    fetched.some((call) => call.url.includes("/ilink/bot/getconfig")),
    "expected a getConfig call for the typing ticket",
  );

  // Unmounting stops the monitor and releases the agent.
  for (const dispose of disposers) dispose();
  assert.ok(
    await waitFor(() => host.serviceCalls.some((call) => call.type === "dispose")),
    "expected the channel to dispose its agent on unmount",
  );
});

test("a session that is not bound to WeChat cannot send", async () => {
  const host = makeHost();
  const runtimeModule = await import("../lib/channel/runtime.js");
  const runtime = new runtimeModule.WeixinChannelRuntime({
    services: host.services,
    config: (await import("../lib/config.js")).normalizeConfig({}, "/tmp/workspace"),
  });
  const { buildWeixinTools } = await import("../lib/tools/index.js");
  const send = buildWeixinTools(runtime).find((tool) => tool.name === "weixin_send");

  await assert.rejects(
    () =>
      send.execute(
        { text: "hi" },
        { callId: "c1", signal: new AbortController().signal, agent: { id: "s", session: { id: "s", seq: 0, header: {} } } },
      ),
    /no WeChat account is running/,
  );

  await runtime.stop();
});

test("the tools route turns the switch on and off for one live session only", async () => {
  const host = makeHost();
  const config = (await import("../lib/config.js")).normalizeConfig({}, "/tmp/workspace");
  const runtimeModule = await import("../lib/channel/runtime.js");
  const runtime = new runtimeModule.WeixinChannelRuntime({ services: host.services, config });

  const { buildWeixinTools } = await import("../lib/tools/index.js");
  const optInModule = await import("../lib/tools/optin.js");
  const optIn = new optInModule.WeixinToolOptIn({
    ctx: host.ctx,
    services: host.services,
    definitions: buildWeixinTools(runtime),
  });
  optIn.start();
  runtime.useToolOptIn(optIn);

  // Two ordinary sessions, unrelated to WeChat.
  const agentA = await host.services.agents.create({ sessionId: "session-a" });
  const agentB = await host.services.agents.create({ sessionId: "session-b" });

  const { buildWeixinRoutes } = await import("../lib/host/routes.js");
  const routes = buildWeixinRoutes({
    runtime,
    config,
    trustedHosts: () => [],
  });
  const toolsRoute = routes.find((route) => route.path === "/dsh-weixin/tools");
  assert.ok(toolsRoute !== undefined);

  /** Run one request against the route through a fake req/res pair. */
  async function call(method, url, body) {
    const req = Object.assign(new (await import("node:stream")).PassThrough(), {
      method,
      url,
      headers: { host: "127.0.0.1:3080" },
    });
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers ?? {};
        return this;
      },
      end(payload) {
        if (payload !== undefined) chunks.push(Buffer.from(payload));
      },
    };
    const finished = new Promise((resolve) => {
      res.end = (payload) => {
        if (payload !== undefined) chunks.push(Buffer.from(payload));
        resolve();
        return res;
      };
    });
    const handling = toolsRoute.handler(req, res);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
    await Promise.all([handling, finished]);
    const text = Buffer.concat(chunks).toString("utf8");
    return { status: res.statusCode, body: text === "" ? undefined : JSON.parse(text) };
  }

  // Enabled for A only.
  const enabled = await call("POST", "/dsh-weixin/tools", { sessionId: "session-a", enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.applied, true);

  assert.deepEqual([...host.scopedTools.get("session-a").keys()].sort(), [
    "weixin_login",
    "weixin_send",
    "weixin_status",
  ]);
  assert.equal(host.scopedTools.get("session-b").size, 0);

  // The read agrees, and the tools are still global-free.
  const read = await call("GET", "/dsh-weixin/tools?sessionId=session-a");
  assert.equal(read.status, 200);
  assert.equal(read.body.enabled, true);
  assert.deepEqual([...read.body.tools].sort(), ["weixin_login", "weixin_send", "weixin_status"]);
  assert.deepEqual(host.registeredTools, []);

  // Disabling removes them again.
  const disabled = await call("POST", "/dsh-weixin/tools", { sessionId: "session-a", enabled: false });
  assert.equal(disabled.body.enabled, false);
  assert.equal(host.scopedTools.get("session-a").size, 0);

  // A missing session id is a 400, not a crash.
  const bad = await call("GET", "/dsh-weixin/tools");
  assert.equal(bad.status, 400);

  optIn.close();
  await agentA.dispose();
  await agentB.dispose();
  await runtime.stop();
});

test("changing the workspace applies to the next conversation, not the running one", async () => {
  const host = makeHost();
  const config = (await import("../lib/config.js")).normalizeConfig(
    { workspace: "/tmp/first" },
    "/tmp/first",
  );
  const runtimeModule = await import("../lib/channel/runtime.js");
  const runtime = new runtimeModule.WeixinChannelRuntime({ services: host.services, config });

  // The configured value is in effect until the user picks something.
  const before = runtime.workspacePayload();
  assert.equal(before.source, "config");
  assert.equal(before.path, path.resolve("/tmp/first"));

  // A relative path is refused with a user-facing message.
  assert.throws(() => runtime.setWorkspace("relative/dir"), /绝对路径/);

  const target = path.join(mkdtempSync(path.join(tmpdir(), "weixin-ws-")), "project");
  const after = runtime.setWorkspace(target);
  assert.equal(after.source, "settings");
  assert.equal(after.path, target);
  assert.equal(after.exists, true);
  assert.equal(after.writable, true);

  // The next session created for a peer uses the new directory.
  const firstPeer = runtime.store.resolve("acc-im-bot", "ws@im.wechat");
  void runtime.sessions
    .runTurn({
      binding: firstPeer,
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    })
    .catch(() => undefined);
  await waitFor(() => host.serviceCalls.some((call) => call.type === "followup"));
  const created = host.serviceCalls.find((call) => call.type === "create");
  assert.ok(created !== undefined);
  assert.equal(created.options.meta.cwd, target);

  // Going back to the configured value is one empty save.
  const restored = runtime.setWorkspace("");
  assert.equal(restored.source, "config");
  assert.equal(restored.path, path.resolve("/tmp/first"));

  await runtime.stop();
});

test("the preset and permission defaults reach a new conversation", async () => {
  const host = makeHost();
  const config = (await import("../lib/config.js")).normalizeConfig({}, "/tmp/workspace");
  const runtimeModule = await import("../lib/channel/runtime.js");
  const runtime = new runtimeModule.WeixinChannelRuntime({ services: host.services, config });

  // Fresh channel: nothing chosen, the catalog is offered as-is.
  const before = await runtime.sessionSettings();
  assert.equal(before.agentPreset, null);
  assert.equal(before.permissionPreset, null);
  assert.equal(before.defaultPermission, "workspace-write");
  assert.deepEqual(
    before.permissions.map((option) => option.value),
    ["read-only", "workspace-write", "danger-full-access"],
  );
  assert.equal(before.presets.length, 0, "this fake profile has no agent preset roster");

  // An unknown permission preset is refused before anything is persisted.
  await assert.rejects(
    () => runtime.setSessionSettings({ permissionPreset: "superuser" }),
    /没有这个权限预设/,
  );

  const saved = await runtime.setSessionSettings({
    agentPreset: "none",
    permissionPreset: "read-only",
  });
  assert.equal(saved.agentPreset, "none");
  assert.equal(saved.permissionPreset, "read-only");

  // A new conversation composes no preset and starts under read-only.
  const binding = runtime.store.resolve("acc-im-bot", "perm@im.wechat");
  void runtime.sessions
    .runTurn({
      binding,
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    })
    .catch(() => undefined);
  await waitFor(() => host.serviceCalls.some((call) => call.type === "followup"));

  const created = host.serviceCalls.find((call) => call.type === "create");
  assert.ok(created !== undefined);
  assert.equal("agentPreset" in created.options.meta, false, "`none` composes no preset");

  // Applied to the session that was just created, once.
  assert.deepEqual(host.permissionCalls, [
    { sessionId: binding.sessionId, preset: "read-only" },
  ]);

  // Clearing a field hands it back to the configured value.
  const cleared = await runtime.setSessionSettings({ permissionPreset: null });
  assert.equal(cleared.permissionPreset, null);
  assert.equal(cleared.agentPreset, "none", "the other field keeps its choice");

  await runtime.stop();
});

test("the preset picker reads the registry roster, not its bare list", async () => {
  const host = makeHost();
  const config = (await import("../lib/config.js")).normalizeConfig({}, "/tmp/workspace");
  const runtimeModule = await import("../lib/channel/runtime.js");
  const runtime = new runtimeModule.WeixinChannelRuntime({ services: host.services, config });

  // `remoteExportList()` is the roster: it carries `isDefault`.
  host.services.agentPresets = {
    async resolve(id) {
      return { id: id ?? "standard" };
    },
    async mount() {
      return { id: "standard" };
    },
    async remoteExportList() {
      return {
        presets: [
          { id: "standard", isDefault: true, name: "Standard" },
          { id: "hunk-review", isDefault: false, name: "Hunk 评审", broken: "缺少 provider" },
        ],
      };
    },
  };

  const withRoster = await runtime.sessionSettings();
  assert.deepEqual(
    withRoster.presets.map((preset) => preset.id),
    ["standard", "hunk-review"],
  );
  assert.equal(withRoster.presets[0].isDefault, true);
  assert.equal(withRoster.presets[1].broken, "缺少 provider");
  assert.equal(withRoster.note, undefined);

  // A registry that only offers the bare array still works, via `defaultId`.
  host.services.agentPresets = {
    async resolve(id) {
      return { id: id ?? "alpha" };
    },
    async mount() {
      return { id: "alpha" };
    },
    defaultId: "alpha",
    async list() {
      return [
        { id: "alpha", name: "Alpha" },
        { id: "beta" },
      ];
    },
  };

  const withList = await runtime.sessionSettings();
  assert.deepEqual(
    withList.presets.map((preset) => preset.id),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    withList.presets.map((preset) => preset.isDefault),
    [true, false],
  );

  // A preset from either list is accepted when saved.
  const saved = await runtime.setSessionSettings({ agentPreset: "hunk-review" });
  assert.equal(saved.agentPreset, "hunk-review");

  await runtime.stop();
});

test("the fs route lists directories for the picker", async () => {
  const host = makeHost();
  const config = (await import("../lib/config.js")).normalizeConfig({}, "/tmp/workspace");
  const runtimeModule = await import("../lib/channel/runtime.js");
  const runtime = new runtimeModule.WeixinChannelRuntime({ services: host.services, config });

  const root = mkdtempSync(path.join(tmpdir(), "weixin-fs-"));
  mkdirSync(path.join(root, "alpha"));
  mkdirSync(path.join(root, "beta"));

  const { buildWeixinRoutes } = await import("../lib/host/routes.js");
  const routes = buildWeixinRoutes({ runtime, config, trustedHosts: () => [] });
  const fsRoute = routes.find((route) => route.path === "/dsh-weixin/fs");
  assert.ok(fsRoute !== undefined);

  const listing = runtime.listDirectory(root);
  assert.equal(listing.ok, true);
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["alpha", "beta"],
  );

  await runtime.stop();
});
