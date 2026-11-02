import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-peers-"));

const { AgentSessionManager, PeerSessionStore } = await import("../lib/channel/peer-session.js");

const CONFIG = {
  workspace: "/tmp/workspace",
  agentPreset: undefined,
};

/** A fake agent that records what the manager asks it to do. */
function makeAgent(id, calls) {
  return {
    id,
    session: { id, seq: 0, header: { cwd: "/tmp/workspace" } },
    status: "idle",
    followup(message) {
      calls.push({ type: "followup", message });
    },
    async whenIdle() {},
    cancel(cause, options) {
      calls.push({ type: "cancel", cause, options });
    },
    ctx: {},
  };
}

/** Build fake host services around one scripted registry. */
function makeServices(overrides = {}) {
  const calls = [];
  const created = [];
  const live = new Map();
  const persisted = new Set(overrides.persisted ?? []);

  const services = {
    ctx: { get: () => undefined, on: () => () => {}, effect: () => () => {} },
    agents: {
      get: (id) => live.get(id),
      async create(options) {
        created.push({ kind: "create", options });
        if (options.setup) await options.setup(options.sessionId, makeAgent(options.sessionId, calls));
        const agent = makeAgent(options.sessionId, calls);
        live.set(options.sessionId, agent);
        return {
          agent,
          async dispose() {
            live.delete(options.sessionId);
            calls.push({ type: "dispose" });
          },
        };
      },
      async resume(options) {
        created.push({ kind: "resume", options });
        if (options.setup) await options.setup(options.resumeSessionId, makeAgent(options.resumeSessionId, calls));
        const agent = makeAgent(options.resumeSessionId, calls);
        live.set(options.resumeSessionId, agent);
        return {
          agent,
          async dispose() {
            live.delete(options.resumeSessionId);
            calls.push({ type: "dispose" });
          },
        };
      },
    },
    sessions: { flush: async () => true, get: () => undefined },
    sessionQuery: {
      async observeSession(id) {
        if (!persisted.has(id)) throw new Error(`session ${id} not found`);
        return { header: { id } };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }) },
    agentPresets: overrides.agentPresets,
    tools: undefined,
    webServer: undefined,
    webRuntime: undefined,
    loader: undefined,
  };

  return { services, calls, created };
}

/** Deferred tracker so a test decides when the turn ends. */
function makeTracker() {
  const ticks = [];
  return {
    begin(sessionId) {
      return new Promise((resolve) => ticks.push({ sessionId, resolve }));
    },
    abort(sessionId) {
      ticks.push({ sessionId, aborted: true });
    },
    finish(outcome) {
      const tick = ticks.shift();
      tick.resolve(outcome);
    },
  };
}

test("peer bindings get a stable, distinct session id", () => {
  const store = new PeerSessionStore();
  const first = store.resolve("acc-im-bot", "a@im.wechat");
  const again = store.resolve("acc-im-bot", "a@im.wechat");
  const other = store.resolve("acc-im-bot", "b@im.wechat");

  assert.equal(first.sessionId, again.sessionId);
  assert.notEqual(first.sessionId, other.sessionId);
  assert.match(first.sessionId, /^session-weixin-[0-9a-f]{12}$/);
});

test("reset() bumps the generation and changes the session id", () => {
  const store = new PeerSessionStore();
  const before = store.resolve("acc-im-bot", "reset@im.wechat");
  const after = store.reset("acc-im-bot", "reset@im.wechat");

  assert.equal(after.generation, before.generation + 1);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.equal(store.resolve("acc-im-bot", "reset@im.wechat").sessionId, after.sessionId);
});

test("bindings survive a new store instance", () => {
  const first = new PeerSessionStore();
  const binding = first.resolve("acc-im-bot", "persist@im.wechat");

  const second = new PeerSessionStore();
  assert.equal(second.resolve("acc-im-bot", "persist@im.wechat").sessionId, binding.sessionId);
});

test("runTurn creates an agent with the deployment model and drives one followup", async () => {
  const { services, calls, created } = makeServices();
  const tracker = makeTracker();
  const manager = new AgentSessionManager({ services, config: CONFIG, tracker });
  const binding = new PeerSessionStore().resolve("acc-im-bot", "turn@im.wechat");

  const pending = manager.runTurn({
    binding,
    content: [{ type: "text", text: "你好" }],
    source: { kind: "user" },
  });

  // Let ensureAgent + followup run.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "create");
  assert.deepEqual(created[0].options.agentOptions, {
    provider: "deepseek-official",
    model: "deepseek-flash",
  });
  assert.equal(created[0].options.meta.cwd, "/tmp/workspace");

  const followup = calls.find((call) => call.type === "followup");
  assert.ok(followup, "expected followup() to be called");
  assert.equal(followup.message.role, "user");
  assert.deepEqual(followup.message.content, [{ type: "text", text: "你好" }]);
  assert.match(followup.message.id, /^[0-9a-f-]{36}$/);
  assert.ok(Object.isFrozen(followup.message), "user messages must be frozen like the harness does");

  tracker.finish({ texts: ["完成"], kind: "completed", error: undefined, toolCalls: [], durationMs: 1 });
  const outcome = await pending;
  assert.deepEqual(outcome.texts, ["完成"]);

  await manager.close();
  assert.ok(calls.some((call) => call.type === "dispose"));
});

test("runTurn resumes a persisted session instead of creating a new one", async () => {
  const store = new PeerSessionStore();
  const binding = store.resolve("acc-im-bot", "resume@im.wechat");
  const { services, created } = makeServices({ persisted: [binding.sessionId] });
  const tracker = makeTracker();
  const manager = new AgentSessionManager({ services, config: CONFIG, tracker });

  void manager.runTurn({ binding, content: [{ type: "text", text: "hi" }], source: { kind: "user" } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created[0].kind, "resume");
  assert.equal(created[0].options.resumeSessionId, binding.sessionId);

  tracker.finish({ texts: [], kind: "completed", error: undefined, toolCalls: [], durationMs: 1 });
  await manager.close();
});

test("two turns for one peer are serialized", async () => {
  const { services, calls } = makeServices();
  const tracker = makeTracker();
  const manager = new AgentSessionManager({ services, config: CONFIG, tracker });
  const binding = new PeerSessionStore().resolve("acc-im-bot", "serial@im.wechat");

  const first = manager.runTurn({ binding, content: [{ type: "text", text: "1" }], source: { kind: "user" } });
  const second = manager.runTurn({ binding, content: [{ type: "text", text: "2" }], source: { kind: "user" } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.type === "followup").length, 1);

  tracker.finish({ texts: ["a"], kind: "completed", error: undefined, toolCalls: [], durationMs: 1 });
  await first;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.filter((call) => call.type === "followup").length, 2);
  tracker.finish({ texts: ["b"], kind: "completed", error: undefined, toolCalls: [], durationMs: 1 });
  assert.deepEqual((await second).texts, ["b"]);

  await manager.close();
});

test("agentPreset is resolved and mounted inside setup", async () => {
  const mounted = [];
  const agentPresets = {
    async resolve(id) {
      assert.equal(id, "standard");
      return { id: "standard" };
    },
    async mount(agentCtx, id) {
      mounted.push(id);
      return { id };
    },
  };
  const { services, created } = makeServices({ agentPresets });
  const tracker = makeTracker();
  const manager = new AgentSessionManager({
    services,
    config: { ...CONFIG, agentPreset: "standard" },
    tracker,
  });
  const binding = new PeerSessionStore().resolve("acc-im-bot", "preset@im.wechat");

  void manager.runTurn({ binding, content: [{ type: "text", text: "x" }], source: { kind: "user" } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created[0].options.meta.agentPreset, "standard");
  assert.deepEqual(mounted, ["standard"]);

  tracker.finish({ texts: [], kind: "completed", error: undefined, toolCalls: [], durationMs: 1 });
  await manager.close();
});

test("agentPreset 'none' composes no preset", async () => {
  const { services, created } = makeServices({
    agentPresets: {
      async resolve() {
        throw new Error("resolve must not be called");
      },
      async mount() {
        throw new Error("mount must not be called");
      },
    },
  });
  const tracker = makeTracker();
  const manager = new AgentSessionManager({
    services,
    config: { ...CONFIG, agentPreset: "none" },
    tracker,
  });
  const binding = new PeerSessionStore().resolve("acc-im-bot", "bare@im.wechat");

  void manager.runTurn({ binding, content: [{ type: "text", text: "x" }], source: { kind: "user" } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created[0].options.meta.agentPreset, undefined);
  tracker.finish({ texts: [], kind: "completed", error: undefined, toolCalls: [], durationMs: 1 });
  await manager.close();
});

test("cancel() forwards a user cancellation to the live agent", async () => {
  const { services, calls } = makeServices();
  const tracker = makeTracker();
  const manager = new AgentSessionManager({ services, config: CONFIG, tracker });
  const binding = new PeerSessionStore().resolve("acc-im-bot", "cancel@im.wechat");

  const pending = manager.runTurn({ binding, content: [{ type: "text", text: "x" }], source: { kind: "user" } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.cancel(binding), true);
  assert.deepEqual(calls.find((call) => call.type === "cancel"), {
    type: "cancel",
    cause: { kind: "user" },
    options: { keepInbox: true },
  });

  tracker.finish({ texts: [], kind: "aborted", error: undefined, toolCalls: [], durationMs: 1 });
  await pending;
  await manager.close();
});
