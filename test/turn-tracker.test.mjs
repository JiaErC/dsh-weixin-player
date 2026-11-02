import assert from "node:assert/strict";
import test from "node:test";

import { TurnTracker } from "../lib/channel/turn-tracker.js";

/** Build a host context whose only job is to hand out the event listener. */
function fakeContext() {
  const listeners = new Map();
  return {
    ctx: {
      get: () => undefined,
      on(name, listener) {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
        return () => {
          const remaining = (listeners.get(name) ?? []).filter((entry) => entry !== listener);
          listeners.set(name, remaining);
        };
      },
      effect: () => () => {},
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
  };
}

const assistantMessage = (text) => ({
  type: "assistant/message",
  data: { message: { content: [{ type: "text", text }] } },
});

test("begin() collects assistant text and settles on turn/end", async () => {
  const bus = fakeContext();
  const tracker = new TurnTracker(bus.ctx);

  const pending = tracker.begin("session-a");
  bus.emit("session/event", { id: "session-a" }, assistantMessage("第一段"));
  bus.emit("session/event", { id: "session-a" }, assistantMessage("第二段"));
  bus.emit("session/event", { id: "session-a" }, {
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });

  const outcome = await pending;
  assert.deepEqual(outcome.texts, ["第一段", "第二段"]);
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.error, undefined);
  tracker.stop();
});

test("events from other sessions are ignored", async () => {
  const bus = fakeContext();
  const tracker = new TurnTracker(bus.ctx);

  const pending = tracker.begin("session-a");
  bus.emit("session/event", { id: "session-b" }, assistantMessage("别人的"));
  bus.emit("session/event", { id: "session-a" }, assistantMessage("我的"));
  bus.emit("session/event", { id: "session-a" }, {
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });

  const outcome = await pending;
  assert.deepEqual(outcome.texts, ["我的"]);
  tracker.stop();
});

test("tool calls are recorded in order", async () => {
  const bus = fakeContext();
  const tracker = new TurnTracker(bus.ctx);

  const pending = tracker.begin("session-a");
  bus.emit("session/event", { id: "session-a" }, { type: "tool/call", data: { name: "read" } });
  bus.emit("session/event", { id: "session-a" }, { type: "tool/call", data: { name: "grep" } });
  bus.emit("session/event", { id: "session-a" }, {
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });

  const outcome = await pending;
  assert.deepEqual(outcome.toolCalls, ["read", "grep"]);
  tracker.stop();
});

test("an error turn reports the provider failure", async () => {
  const bus = fakeContext();
  const tracker = new TurnTracker(bus.ctx);

  const pending = tracker.begin("session-a");
  bus.emit("session/event", { id: "session-a" }, {
    type: "turn/end",
    data: { reason: { kind: "error", error: { message: "rate limited", code: "429" } } },
  });

  const outcome = await pending;
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.error, "rate limited");
  tracker.stop();
});

test("non-text assistant blocks do not count as reply text", async () => {
  const bus = fakeContext();
  const tracker = new TurnTracker(bus.ctx);

  const pending = tracker.begin("session-a");
  bus.emit("session/event", { id: "session-a" }, {
    type: "assistant/message",
    data: { message: { content: [{ type: "tool-call", name: "x" }] } },
  });
  bus.emit("session/event", { id: "session-a" }, {
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });

  assert.deepEqual((await pending).texts, []);
  tracker.stop();
});

test("a second begin() settles the stale waiter instead of wedging", async () => {
  const bus = fakeContext();
  const tracker = new TurnTracker(bus.ctx);

  const first = tracker.begin("session-a");
  const second = tracker.begin("session-a");

  const firstOutcome = await first;
  assert.equal(firstOutcome.kind, "interrupted");

  bus.emit("session/event", { id: "session-a" }, {
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });
  assert.equal((await second).kind, "completed");
  tracker.stop();
});

test("stop() settles outstanding waiters and detaches the listener", async () => {
  const bus = fakeContext();
  const tracker = new TurnTracker(bus.ctx);

  const pending = tracker.begin("session-a");
  tracker.stop();
  assert.equal((await pending).kind, "aborted");

  // The listener is gone, so emitting now must not throw or resolve anything.
  bus.emit("session/event", { id: "session-a" }, {
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });
});
