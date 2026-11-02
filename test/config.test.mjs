import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, normalizeConfig } from "../lib/config.js";

test("normalizeConfig fills every default", () => {
  const config = normalizeConfig(undefined, "/tmp/work");

  assert.equal(config.enabled, true);
  assert.deepEqual(config.allowFrom, []);
  assert.equal(config.workspace, "/tmp/work");
  assert.equal(config.agentPreset, undefined);
  assert.equal(config.sessionMode, "per-peer");
  assert.equal(config.sharedSessionId, "session-dsh-weixin");
  assert.equal(config.markdown, true);
  assert.equal(config.typing, true);
  assert.equal(config.textChunkLimit, 4000);
  assert.equal(config.longPollTimeoutMs, 35000);
  assert.equal(config.quoteCache, true);
  assert.equal(config.quoteCacheMaxMessages, 1000);
  assert.deepEqual(config.accounts, {});
  assert.equal(config.loginPage, true);
});

test("normalizeConfig keeps explicit values and trims lists", () => {
  const config = normalizeConfig(
    {
      enabled: false,
      allowFrom: [" a@im.wechat ", "", "b@im.wechat"],
      workspace: "  E:/work  ",
      agentPreset: "standard",
      sessionMode: "shared",
      textChunkLimit: 1200,
      typing: false,
    },
    "/tmp/work",
  );

  assert.equal(config.enabled, false);
  assert.deepEqual(config.allowFrom, ["a@im.wechat", "b@im.wechat"]);
  assert.equal(config.workspace, "E:/work");
  assert.equal(config.agentPreset, "standard");
  assert.equal(config.sessionMode, "shared");
  assert.equal(config.textChunkLimit, 1200);
  assert.equal(config.typing, false);
});

test("normalizeConfig rejects wrong shapes with actionable messages", () => {
  assert.throws(() => normalizeConfig({ markdown: "yes" }), ConfigError);
  assert.throws(() => normalizeConfig({ textChunkLimit: 0 }), ConfigError);
  assert.throws(() => normalizeConfig({ textChunkLimit: 1.5 }), ConfigError);
  assert.throws(() => normalizeConfig({ allowFrom: "a@im.wechat" }), ConfigError);
  assert.throws(() => normalizeConfig({ allowFrom: [42] }), ConfigError);
  assert.throws(() => normalizeConfig({ sessionMode: "broadcast" }), ConfigError);
  assert.throws(() => normalizeConfig({ accounts: [] }), ConfigError);

  assert.throws(
    () => normalizeConfig({ markdown: "yes" }),
    /`markdown` must be a boolean/,
  );
});

test("normalizeConfig treats blank strings as absent", () => {
  const config = normalizeConfig({ agentPreset: "   ", workspace: "" }, "/tmp/work");
  assert.equal(config.agentPreset, undefined);
  assert.equal(config.workspace, "/tmp/work");
});

test("agentPreset 'none' survives normalisation", () => {
  const config = normalizeConfig({ agentPreset: "none" }, "/tmp/work");
  assert.equal(config.agentPreset, "none");
});
