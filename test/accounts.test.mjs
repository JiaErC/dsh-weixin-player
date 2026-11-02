import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Point the channel's state directory at a throwaway root before anything that
// resolves it is loaded.
process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-accounts-"));

const accounts = await import("../lib/protocol/auth/accounts.js");

test("normalizeWeixinAccountId produces a filesystem-safe key", () => {
  assert.equal(accounts.normalizeWeixinAccountId("b0f5860fdecb@im.bot"), "b0f5860fdecb-im-bot");
  assert.equal(accounts.normalizeWeixinAccountId("ABCD@im.wechat"), "abcd-im-wechat");
  assert.equal(accounts.normalizeWeixinAccountId("  Spaced Id  "), "spaced-id");
  assert.equal(accounts.normalizeWeixinAccountId("***"), "default");
});

test("deriveRawAccountId reverses the two real iLink suffixes", () => {
  assert.equal(accounts.deriveRawAccountId("abc-im-bot"), "abc@im.bot");
  assert.equal(accounts.deriveRawAccountId("abc-im-wechat"), "abc@im.wechat");
  assert.equal(accounts.deriveRawAccountId("abc"), undefined);
});

test("account index round-trips without duplicates", () => {
  accounts.registerWeixinAccountId("one-im-bot");
  accounts.registerWeixinAccountId("one-im-bot");
  accounts.registerWeixinAccountId("two-im-bot");
  assert.deepEqual(accounts.listIndexedWeixinAccountIds(), ["one-im-bot", "two-im-bot"]);

  accounts.unregisterWeixinAccountId("one-im-bot");
  assert.deepEqual(accounts.listIndexedWeixinAccountIds(), ["two-im-bot"]);
});

test("saveWeixinAccount merges instead of replacing", () => {
  accounts.saveWeixinAccount("merge-im-bot", { token: "t1", userId: "u1" });
  accounts.saveWeixinAccount("merge-im-bot", { baseUrl: "https://example.test" });

  const stored = accounts.loadWeixinAccount("merge-im-bot");
  assert.equal(stored.token, "t1");
  assert.equal(stored.userId, "u1");
  assert.equal(stored.baseUrl, "https://example.test");
  assert.ok(stored.savedAt);
});

test("resolveWeixinAccount falls back to the default base URL", () => {
  accounts.saveWeixinAccount("resolve-im-bot", { token: "tok" });
  const resolved = accounts.resolveWeixinAccount({ name: "测试号" }, "resolve-im-bot");

  assert.equal(resolved.accountId, "resolve-im-bot");
  assert.equal(resolved.baseUrl, accounts.DEFAULT_BASE_URL);
  assert.equal(resolved.cdnBaseUrl, accounts.CDN_BASE_URL);
  assert.equal(resolved.token, "tok");
  assert.equal(resolved.configured, true);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.name, "测试号");
});

test("resolveWeixinAccount honours a disabled account", () => {
  accounts.saveWeixinAccount("off-im-bot", { token: "tok" });
  const resolved = accounts.resolveWeixinAccount({ enabled: false }, "off-im-bot");
  assert.equal(resolved.enabled, false);
});

test("clearStaleAccountsForUserId drops older accounts for the same WeChat user", () => {
  accounts.registerWeixinAccountId("keep-im-bot");
  accounts.saveWeixinAccount("keep-im-bot", { token: "new", userId: "scanner" });
  accounts.registerWeixinAccountId("stale-im-bot");
  accounts.saveWeixinAccount("stale-im-bot", { token: "old", userId: "scanner" });

  const cleared = [];
  accounts.clearStaleAccountsForUserId("keep-im-bot", "scanner", (id) => cleared.push(id));

  assert.deepEqual(cleared, ["stale-im-bot"]);
  assert.equal(accounts.loadWeixinAccount("stale-im-bot"), null);
  assert.ok(accounts.loadWeixinAccount("keep-im-bot"));
});

test("credential files are written with the token, not the raw id", () => {
  accounts.saveWeixinAccount("disk-im-bot", { token: "secret-token" });
  const file = path.join(process.env.DSH_HOME, "weixin", "accounts", "disk-im-bot.json");
  const parsed = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(parsed.token, "secret-token");
});

test("onAccountsChanged notifies and unsubscribes", () => {
  let calls = 0;
  const off = accounts.onAccountsChanged(() => {
    calls += 1;
  });
  accounts.notifyAccountSetChanged();
  assert.equal(calls, 1);
  off();
  accounts.notifyAccountSetChanged();
  assert.equal(calls, 1);
});
