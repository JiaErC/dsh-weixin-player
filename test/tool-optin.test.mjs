import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-optin-"));

const { WeixinToolOptIn } = await import("../lib/tools/optin.js");

/** A tool definition stub; registration only needs the shape. */
function definition(name) {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: { schema: { type: "object", additionalProperties: false, properties: {} }, render: () => [] },
    async execute() {
      return {};
    },
  };
}

/** A recording fake tool registry, standing in for `agent.ctx.tools`. */
function makeToolRegistry(scope) {
  const registered = new Map();
  return {
    registered,
    register(def) {
      if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name} in ${scope}`);
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  };
}

/** A host context that records listeners and can fire them. */
function makeCtx() {
  const listeners = new Map();
  return {
    ctx: {
      get: () => undefined,
      on(name, listener) {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
        return () => listeners.set(name, (listeners.get(name) ?? []).filter((l) => l !== listener));
      },
      effect: () => () => {},
    },
    fire(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
  };
}

/** One fake agent whose scope owns a recording tool registry. */
function makeAgent(sessionId) {
  const tools = makeToolRegistry(sessionId);
  return { agent: { id: sessionId, session: { id: sessionId, seq: 0, header: {} }, ctx: { tools } }, tools };
}

/** Build a manager over the given live agents. */
function makeManager({ agents = [], definitions = [definition("weixin_send"), definition("weixin_login")] } = {}) {
  const bus = makeCtx();
  const live = new Map(agents.map((entry) => [entry.agent.id, entry.agent]));
  const services = {
    ctx: bus.ctx,
    agents: { get: (id) => live.get(id), list: () => [...live.values()] },
  };
  const optIn = new WeixinToolOptIn({ ctx: bus.ctx, services, definitions });
  return { optIn, bus, live };
}

test("enabling a live session registers the tools on that agent's own scope", () => {
  const entry = makeAgent("session-a");
  const { optIn } = makeManager({ agents: [entry] });
  optIn.start();

  const exposure = optIn.setEnabled("session-a", true);

  assert.equal(exposure.enabled, true);
  assert.equal(exposure.applied, true);
  assert.deepEqual([...entry.tools.registered.keys()].sort(), ["weixin_login", "weixin_send"]);
  optIn.close();
});

test("enabling another session does not touch the first one", () => {
  const first = makeAgent("session-a");
  const second = makeAgent("session-b");
  const { optIn } = makeManager({ agents: [first, second] });
  optIn.start();

  optIn.setEnabled("session-a", true);

  assert.equal(first.tools.registered.size, 2);
  assert.equal(second.tools.registered.size, 0);
  optIn.close();
});

test("disabling removes exactly the registrations it made", () => {
  const entry = makeAgent("session-a");
  const { optIn } = makeManager({ agents: [entry] });
  optIn.start();

  optIn.setEnabled("session-a", true);
  optIn.setEnabled("session-a", false);

  assert.equal(entry.tools.registered.size, 0);
  assert.equal(optIn.exposure("session-a").enabled, false);
  assert.equal(optIn.exposure("session-a").applied, false);
  optIn.close();
});

test("an opted-in session that starts later gets the tools on agent/created", () => {
  const { optIn, bus, live } = makeManager();
  optIn.start();

  const exposure = optIn.setEnabled("session-later", true);
  assert.equal(exposure.enabled, true);
  assert.equal(exposure.applied, false);
  assert.match(String(exposure.note), /下一/);

  const entry = makeAgent("session-later");
  live.set(entry.agent.id, entry.agent);
  bus.fire("agent/created", { agent: entry.agent });

  assert.equal(entry.tools.registered.size, 2);
  assert.equal(optIn.exposure("session-later").applied, true);
  optIn.close();
});

test("the opt-in set survives a new manager (disk persistence)", () => {
  const first = makeManager();
  first.optIn.start();
  first.optIn.setEnabled("session-persist", true);
  first.optIn.close();

  const second = makeManager();
  second.optIn.start();
  assert.equal(second.optIn.isEnabled("session-persist"), true);
  second.optIn.close();
});

test("a session that is not opted in stays untouched on agent/created", () => {
  const { optIn, bus, live } = makeManager();
  optIn.start();

  const entry = makeAgent("session-idle");
  live.set(entry.agent.id, entry.agent);
  bus.fire("agent/created", { agent: entry.agent });

  assert.equal(entry.tools.registered.size, 0);
  optIn.close();
});

test("the persisted file lists only opted-in sessions", () => {
  const { optIn } = makeManager();
  optIn.start();
  optIn.setEnabled("session-x", true);
  optIn.setEnabled("session-y", true);
  optIn.setEnabled("session-x", false);
  optIn.close();

  const file = path.join(process.env.DSH_HOME, "weixin", "tool-optins.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(parsed.sessions.includes("session-y"));
  assert.ok(!parsed.sessions.includes("session-x"));
});

test("a blank session id is refused", () => {
  const { optIn } = makeManager();
  optIn.start();
  assert.throws(() => optIn.setEnabled("   ", true), /sessionId is required/);
  optIn.close();
});

test("close() drops every registration it owns", () => {
  const first = makeAgent("session-a");
  const second = makeAgent("session-b");
  const { optIn } = makeManager({ agents: [first, second] });
  optIn.start();

  optIn.setEnabled("session-a", true);
  optIn.setEnabled("session-b", true);
  optIn.close();

  assert.equal(first.tools.registered.size, 0);
  assert.equal(second.tools.registered.size, 0);
});

test("a registration failure is reported, not thrown", () => {
  const broken = {
    agent: {
      id: "session-broken",
      session: { id: "session-broken", seq: 0, header: {} },
      ctx: {
        tools: {
          register() {
            throw new Error("registry says no");
          },
        },
      },
    },
  };
  const { optIn } = makeManager({ agents: [broken] });
  optIn.start();

  const exposure = optIn.setEnabled("session-broken", true);
  assert.equal(exposure.enabled, true);
  assert.equal(exposure.applied, false);
  optIn.close();
});

test("an agent without a tool registry is handled quietly", () => {
  const bare = { agent: { id: "session-bare", session: { id: "session-bare", seq: 0, header: {} }, ctx: {} } };
  const { optIn } = makeManager({ agents: [bare] });
  optIn.start();

  const exposure = optIn.setEnabled("session-bare", true);
  assert.equal(exposure.enabled, true);
  assert.equal(exposure.applied, false);
  optIn.close();
});

test("a decline survives a restart and blocks the channel's auto-enable", () => {
  const first = makeManager();
  first.optIn.start();
  first.optIn.setEnabled("session-declined", true);
  first.optIn.setEnabled("session-declined", false);
  assert.equal(first.optIn.isDeclined("session-declined"), true);
  first.optIn.close();

  const second = makeManager();
  second.optIn.start();
  assert.equal(second.optIn.isEnabled("session-declined"), false);
  assert.equal(second.optIn.isDeclined("session-declined"), true);

  // The channel's auto-enable path is `isEnabled -> isDeclined -> setEnabled`,
  // so a declined session must not be flipped back on by a later agent start.
  const entry = makeAgent("session-declined");
  second.live.set(entry.agent.id, entry.agent);
  second.bus.fire("agent/created", { agent: entry.agent });
  assert.equal(entry.tools.registered.size, 0);

  // An explicit "on" clears the decline.
  second.optIn.setEnabled("session-declined", true);
  assert.equal(second.optIn.isDeclined("session-declined"), false);
  assert.equal(entry.tools.registered.size, 2);
  second.optIn.close();
});

test("the opt-in file is written under the channel's own state directory", () => {
  const stateDir = path.join(process.env.DSH_HOME, "weixin");
  mkdirSync(stateDir, { recursive: true });

  const { optIn } = makeManager();
  optIn.start();
  optIn.setEnabled("session-fresh", true);
  optIn.close();

  const parsed = JSON.parse(readFileSync(path.join(stateDir, "tool-optins.json"), "utf8"));
  assert.equal(parsed.version, 1);
  assert.ok(parsed.sessions.includes("session-fresh"));
});
