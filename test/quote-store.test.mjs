import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-quotes-"));

const {
  initializeQuoteStore,
  getQuoteStore,
  deleteQuoteCacheForAccount,
} = await import("../lib/protocol/messaging/quote-store.js");

const ACCOUNT = "quote-test-im-bot";

function record(messageId, body) {
  return {
    accountId: ACCOUNT,
    conversationId: "peer@im.wechat",
    messageId,
    direction: "inbound",
    body,
    createdAt: Date.now(),
  };
}

test("initializeQuoteStore publishes the process-wide store", () => {
  initializeQuoteStore({ maxMessagesPerAccount: 3 });
  assert.ok(getQuoteStore());
});

test("put then find returns the cached body", async () => {
  const store = initializeQuoteStore({ maxMessagesPerAccount: 10 });
  await store.put(record("m1", "hello"));
  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "m1").body, "hello");
  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "missing"), undefined);
  assert.equal(store.find("other-account", "peer@im.wechat", "m1"), undefined);
});

test("the store trims to maxMessagesPerAccount, dropping the oldest", async () => {
  const store = initializeQuoteStore({ maxMessagesPerAccount: 2 });
  await store.put(record("a", "1"));
  await store.put(record("b", "2"));
  await store.put(record("c", "3"));

  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "a"), undefined);
  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "b").body, "2");
  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "c").body, "3");
});

test("re-putting an id refreshes it instead of duplicating", async () => {
  const store = initializeQuoteStore({ maxMessagesPerAccount: 2 });
  await store.put(record("x", "first"));
  await store.put(record("y", "second"));
  await store.put(record("x", "updated"));

  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "x").body, "updated");
  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "y").body, "second");

  // `x` moved to the end, so a third insert must evict `y`.
  await store.put(record("z", "third"));
  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "y"), undefined);
  assert.ok(store.find(ACCOUNT, "peer@im.wechat", "x"));
});

test("records survive a fresh store instance (disk persistence)", async () => {
  const first = initializeQuoteStore({ maxMessagesPerAccount: 10 });
  await first.put(record("persisted", "on disk"));
  // The write is queued on the microtask queue; let it run.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = initializeQuoteStore({ maxMessagesPerAccount: 10 });
  assert.equal(second.find(ACCOUNT, "peer@im.wechat", "persisted").body, "on disk");
});

test("deleteQuoteCacheForAccount forgets one account", async () => {
  const store = initializeQuoteStore({ maxMessagesPerAccount: 10 });
  await store.put(record("gone", "bye"));
  deleteQuoteCacheForAccount(ACCOUNT);
  assert.equal(store.find(ACCOUNT, "peer@im.wechat", "gone"), undefined);
});
