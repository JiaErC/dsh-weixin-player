import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-inbound-"));

const { composeUserText, handleInboundMessage } = await import("../lib/channel/handle-message.js");
const { normalizeConfig } = await import("../lib/config.js");

const CONFIG = normalizeConfig({ workspace: "/tmp/workspace", typing: false }, "/tmp/workspace");

/** Minimal inbound WeixinMessage with one text item. */
function textMessage(text, overrides = {}) {
  return {
    message_id: `m-${Math.random().toString(16).slice(2)}`,
    from_user_id: "peer@im.wechat",
    context_token: "ct",
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  };
}

/** Fake collaborators for one inbound message. */
function makeDeps(overrides = {}) {
  const sent = [];
  const turns = [];
  const resets = [];

  const binding = {
    accountId: "acc-im-bot",
    peerId: "peer@im.wechat",
    sessionId: "session-weixin-abc",
    createdAt: 0,
    lastActiveAt: 0,
    generation: 0,
  };

  const deps = {
    config: CONFIG,
    accountId: "acc-im-bot",
    sender: {
      async sendText(to, text) {
        sent.push({ to, text });
        return "srv-1";
      },
      async sendFile(to, filePath, text) {
        sent.push({ to, text, filePath });
      },
      async sendDelivery(to, delivery) {
        sent.push({ to, ...delivery });
      },
      createTypingIndicator() {
        return { start() {}, async stop() {} };
      },
    },
    sessions: {
      async runTurn(request) {
        turns.push(request);
        return overrides.outcome ?? {
          texts: ["好的"],
          kind: "completed",
          error: undefined,
          toolCalls: [],
          durationMs: 5,
        };
      },
      async disposeBinding() {},
      cancel() {
        return false;
      },
      isRunning() {
        return false;
      },
    },
    store: {
      resolve() {
        return binding;
      },
      reset() {
        const next = { ...binding, generation: binding.generation + 1, sessionId: "session-weixin-def" };
        resets.push(next);
        return next;
      },
    },
    configManager: { async getForUser() { return { typingTicket: "" }; } },
    cdnBaseUrl: "https://example.test",
    startedAt: Date.now(),
    allowFrom: () => overrides.allowFrom ?? [],
  };

  return { deps, sent, turns, resets };
}

test("composeUserText keeps the body, the quote and the attachment paths", () => {
  const text = composeUserText({
    Body: "这个文件讲什么",
    From: "peer@im.wechat",
    To: "peer@im.wechat",
    AccountId: "acc",
    OriginatingChannel: "dsh-weixin",
    OriginatingTo: "peer@im.wechat",
    MessageSid: "sid",
    Provider: "dsh-weixin",
    ChatType: "direct",
    ReplyToBody: "上一轮的结论",
    ReplyToQuoteText: "局部引用",
    MediaPaths: ["/tmp/media/a.png"],
    MediaTypes: ["image/png"],
  });

  assert.match(text, /这个文件讲什么/);
  assert.match(text, /\[引用的消息\] 局部引用/);
  assert.match(text, /\[附件\] 已保存到 \/tmp\/media\/a\.png（image\/png）/);
});

test("composeUserText labels a media-only message", () => {
  const text = composeUserText({
    Body: "[图片]",
    From: "p",
    To: "p",
    AccountId: "a",
    OriginatingChannel: "dsh-weixin",
    OriginatingTo: "p",
    MessageSid: "s",
    Provider: "dsh-weixin",
    ChatType: "direct",
    MediaPath: "/tmp/media/b.jpg",
    MediaType: "image/jpeg",
  });

  assert.match(text, /用户发来一个附件/);
  assert.match(text, /\/tmp\/media\/b\.jpg/);
});

test("an unauthorized peer never reaches the agent", async () => {
  const { deps, sent, turns } = makeDeps({ allowFrom: ["someone-else@im.wechat"] });
  await handleInboundMessage(textMessage("hello"), deps);

  assert.equal(turns.length, 0);
  assert.equal(sent.length, 0);
});

test("a plain message becomes one turn and one reply", async () => {
  const { deps, sent, turns } = makeDeps();
  await handleInboundMessage(textMessage("你好"), deps);

  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].content, [{ type: "text", text: "你好" }]);
  assert.equal(turns[0].source.channel, "weixin");
  assert.equal(turns[0].source.peerId, "peer@im.wechat");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "好的");
});

test("a replayed message id is processed only once", async () => {
  const { deps, turns } = makeDeps();
  const message = textMessage("重复", { message_id: "fixed-id" });

  await handleInboundMessage(message, deps);
  await handleInboundMessage(message, deps);

  assert.equal(turns.length, 1);
});

test("/status is answered by the channel, not the model", async () => {
  const { deps, sent, turns } = makeDeps();
  await handleInboundMessage(textMessage("/status"), deps);

  assert.equal(turns.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /账号：acc-im-bot/);
});

test("/new resets the conversation binding", async () => {
  const { deps, sent, resets } = makeDeps();
  await handleInboundMessage(textMessage("/new"), deps);

  assert.equal(resets.length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /session-weixin-def/);
});

test("a message that only starts with a slash still reaches the agent", async () => {
  const { deps, turns } = makeDeps();
  await handleInboundMessage(textMessage("/etc/hosts 里写了什么"), deps);
  assert.equal(turns.length, 1);
});

test("an empty turn explains itself instead of staying silent", async () => {
  const { deps, sent } = makeDeps({
    outcome: { texts: [], kind: "error", error: "boom", toolCalls: [], durationMs: 1 },
  });
  await handleInboundMessage(textMessage("hi"), deps);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /模型调用失败：boom/);
});

test("a refused turn reports the failure back to the chat", async () => {
  const { deps, sent } = makeDeps();
  deps.sessions.runTurn = async () => {
    throw new Error("agent is busy");
  };

  await handleInboundMessage(textMessage("hi"), deps);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /处理这条消息时出错：agent is busy/);
});

test("an empty inbound message gets a short hint", async () => {
  const { deps, sent, turns } = makeDeps();
  await handleInboundMessage(
    { message_id: "empty-1", from_user_id: "peer@im.wechat", item_list: [] },
    deps,
  );

  assert.equal(turns.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /空消息/);
});
