import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-recent-"));

const { RecentMessageStore, RECENT_LIMITS } = await import("../lib/channel/recent.js");

/**
 * Give one test its own state directory.
 *
 * `resolveWeixinStateDir()` reads `DSH_HOME` on every call, so rotating it here
 * isolates tests without any hook in the store itself.
 */
function isolatedHome() {
  const dir = mkdtempSync(path.join(tmpdir(), "weixin-recent-"));
  process.env.DSH_HOME = dir;
  return dir;
}

test("record then list returns the conversation oldest first", () => {
  isolatedHome();
  const store = new RecentMessageStore();
  store.record("acc", "peer", "user", "第一条");
  store.record("acc", "peer", "assistant", "第二条");
  const messages = store.list("acc", "peer");
  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [
      ["user", "第一条"],
      ["assistant", "第二条"],
    ],
  );
  store.close();
});

test("empty bodies are ignored and long ones are truncated", () => {
  isolatedHome();
  const store = new RecentMessageStore();
  store.record("acc", "peer", "user", "   ");
  assert.equal(store.list("acc", "peer").length, 0);

  store.record("acc", "peer", "user", "x".repeat(RECENT_LIMITS.chars + 50));
  const [message] = store.list("acc", "peer");
  assert.equal(message.text.length, RECENT_LIMITS.chars + 1, "truncated with an ellipsis");
  assert.ok(message.text.endsWith("…"));
  store.close();
});

test("each conversation keeps only the newest messages", () => {
  isolatedHome();
  const store = new RecentMessageStore();
  for (let index = 0; index < RECENT_LIMITS.perPeer + 5; index += 1) {
    store.record("acc", "peer", "user", `m${index}`);
  }
  const messages = store.list("acc", "peer", 100);
  assert.equal(messages.length, RECENT_LIMITS.perPeer);
  assert.equal(messages.at(-1).text, `m${RECENT_LIMITS.perPeer + 4}`);
  assert.equal(messages.at(0).text, "m5");

  assert.deepEqual(
    store.list("acc", "peer", 2).map((message) => message.text),
    ["m43", "m44"],
  );
  store.close();
});

test("the conversation count is bounded and forget() drops one", () => {
  isolatedHome();
  const store = new RecentMessageStore();
  for (let index = 0; index < RECENT_LIMITS.peers + 3; index += 1) {
    store.record("acc", `peer-${index}`, "user", "hi");
  }
  // The oldest conversations fell out of the buffer.
  assert.equal(store.list("acc", "peer-0").length, 0);
  assert.equal(store.list("acc", `peer-${RECENT_LIMITS.peers + 2}`).length, 1);

  store.forget("acc", `peer-${RECENT_LIMITS.peers + 2}`);
  assert.equal(store.list("acc", `peer-${RECENT_LIMITS.peers + 2}`).length, 0);
  store.close();
});

test("close() persists and a fresh store reads it back", () => {
  const home = isolatedHome();
  const store = new RecentMessageStore();
  store.record("acc", "peer", "user", "持久化");
  store.close();

  const file = path.join(home, "weixin", "recent.json");
  const payload = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(payload.version, 1);
  assert.equal(payload.conversations.length, 1);

  const reopened = new RecentMessageStore();
  assert.deepEqual(
    reopened.list("acc", "peer").map((message) => message.text),
    ["持久化"],
  );
  reopened.close();
});

test("a corrupted file does not break recording", () => {
  const home = isolatedHome();
  const store = new RecentMessageStore();
  store.close(); // creates <home>/weixin
  writeFileSync(path.join(home, "weixin", "recent.json"), "{ not json", "utf-8");

  const reopened = new RecentMessageStore();
  reopened.record("acc", "peer", "user", "still works");
  assert.equal(reopened.list("acc", "peer").length, 1);
  reopened.close();
});
