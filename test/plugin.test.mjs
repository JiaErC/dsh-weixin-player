import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

  return { ctx, services, registeredTools, registeredRoutes, serviceCalls, scopedTools };
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

  // Mounting is asynchronous: wait for the routes the page needs.
  assert.ok(
    await waitFor(() => host.registeredRoutes.length === 7),
    `expected 7 routes, got ${host.registeredRoutes.map((route) => route.path).join(", ")}`,
  );

  assert.deepEqual(
    host.registeredRoutes.map((route) => route.path).sort(),
    [
      "/dsh-weixin",
      "/dsh-weixin/login/qr.png",
      "/dsh-weixin/login/start",
      "/dsh-weixin/login/status",
      "/dsh-weixin/login/verify",
      "/dsh-weixin/status",
      "/dsh-weixin/tools",
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
  assert.equal(outcome.options.meta.cwd, "/tmp/workspace");

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
