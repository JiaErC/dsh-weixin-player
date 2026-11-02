import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDeliveries,
  chunkText,
  describeEmptyTurn,
  extractMediaDirectives,
} from "../lib/channel/reply.js";

test("chunkText returns short text unchanged", () => {
  assert.deepEqual(chunkText("hello", 100), ["hello"]);
});

test("chunkText splits on a paragraph break without cutting the sentence", () => {
  const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
  const chunks = chunkText(text, 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "a".repeat(60));
  assert.equal(chunks[1], "b".repeat(60));
});

test("chunkText hard-cuts text that has no break", () => {
  const chunks = chunkText("x".repeat(250), 100);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), "x".repeat(250));
});

test("chunkText never returns empty chunks", () => {
  const chunks = chunkText(`${"a".repeat(10)}\n\n\n\n${"b".repeat(10)}`, 12);
  assert.ok(chunks.every((chunk) => chunk !== ""));
});

test("extractMediaDirectives lifts MEDIA lines out of the text", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "weixin-reply-"));
  writeFileSync(path.join(workspace, "report.pdf"), "x");

  const result = extractMediaDirectives(
    ["这是结果：", "MEDIA:report.pdf", "还有一句"].join("\n"),
    workspace,
  );

  assert.equal(result.text, "这是结果：\n还有一句");
  assert.deepEqual(result.mediaPaths, [path.join(workspace, "report.pdf")]);
});

test("extractMediaDirectives accepts absolute paths and file URLs", () => {
  const absolute = path.resolve(tmpdir(), "photo.png");
  const parsed = extractMediaDirectives(
    [`MEDIA:${absolute}`, "MEDIA:file:///tmp/other.png"].join("\n"),
    tmpdir(),
  );
  assert.equal(parsed.text, "");
  assert.equal(parsed.mediaPaths.length, 2);
  assert.equal(parsed.mediaPaths[0], absolute);
});

test("extractMediaDirectives leaves inline mentions alone", () => {
  const result = extractMediaDirectives("发给我是 MEDIA:x 这样写的", "/tmp");
  assert.equal(result.mediaPaths.length, 0);
  assert.match(result.text, /MEDIA:x/);
});

test("buildDeliveries returns nothing for an empty turn", () => {
  assert.deepEqual(
    buildDeliveries(["", "   "], { markdown: true, textChunkLimit: 4000, workspace: "/tmp" }),
    [],
  );
});

test("buildDeliveries joins steps in order", () => {
  const deliveries = buildDeliveries(["第一段", "第二段"], {
    markdown: false,
    textChunkLimit: 4000,
    workspace: "/tmp",
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].text, "第一段\n\n第二段");
});

test("buildDeliveries attaches media to the last chunk", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "weixin-reply-"));
  writeFileSync(path.join(workspace, "chart.png"), "x");

  const deliveries = buildDeliveries(
    [`${"a".repeat(80)}\n\n${"b".repeat(80)}\n\nMEDIA:chart.png`],
    { markdown: false, textChunkLimit: 100, workspace },
  );

  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].mediaPath, undefined);
  assert.equal(deliveries[1].mediaPath, path.join(workspace, "chart.png"));
});

test("buildDeliveries sends a media-only reply without text", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "weixin-reply-"));
  writeFileSync(path.join(workspace, "voice.mp3"), "x");

  const deliveries = buildDeliveries(["MEDIA:voice.mp3"], {
    markdown: false,
    textChunkLimit: 4000,
    workspace,
  });
  assert.deepEqual(deliveries, [{ text: "", mediaPath: path.join(workspace, "voice.mp3") }]);
});

test("buildDeliveries sanitizes WeChat-unsupported Markdown when asked", () => {
  // The channel's Markdown pass is the upstream streaming filter: it drops what
  // WeChat cannot render (images, CJK italic markers, H5/H6 headings) and keeps
  // what it can (code fences, tables, `**bold**`).
  const deliveries = buildDeliveries(
    ["前 ![图](https://example.test/a.png) 后\n\n*斜体中文*\n\n##### 小标题"],
    { markdown: true, textChunkLimit: 4000, workspace: "/tmp" },
  );

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].text, "前  后\n\n斜体中文\n\n小标题");
});

test("buildDeliveries leaves Markdown untouched when the option is off", () => {
  const deliveries = buildDeliveries(["*斜体中文*"], {
    markdown: false,
    textChunkLimit: 4000,
    workspace: "/tmp",
  });
  assert.equal(deliveries[0].text, "*斜体中文*");
});

test("describeEmptyTurn explains each terminal state", () => {
  assert.match(describeEmptyTurn("error", "boom"), /模型调用失败：boom/);
  assert.match(describeEmptyTurn("aborted", undefined), /已中止/);
  assert.match(describeEmptyTurn("max-tokens", undefined), /输出上限/);
  assert.match(describeEmptyTurn("completed", undefined), /没有文本回复/);
});
