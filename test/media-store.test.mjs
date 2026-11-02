import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-media-"));

const { createLocalMediaSaver } = await import("../lib/protocol/media/media-store.js");
const { getMimeFromFilename, getExtensionFromMime } = await import(
  "../lib/protocol/media/mime.js"
);

test("the saver writes bytes under the requested bucket", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-media-store-"));
  const save = createLocalMediaSaver({ rootDir: root });

  const saved = await save(Buffer.from("png-bytes"), "image/png", "inbound");

  assert.ok(existsSync(saved.path));
  assert.equal(readFileSync(saved.path, "utf-8"), "png-bytes");
  assert.equal(path.dirname(saved.path), path.join(root, "inbound"));
  assert.match(path.basename(saved.path), /^wx-[a-z0-9]+-[0-9a-f]{8}\.png$/);
});

test("the saver keeps the original extension when a filename is given", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-media-store-"));
  const save = createLocalMediaSaver({ rootDir: root });

  const saved = await save(Buffer.from("xlsx"), "application/vnd.ms-excel", "inbound", undefined, "报表.xlsx");
  assert.match(saved.path, /\.xlsx$/);
});

test("the saver refuses oversized media", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-media-store-"));
  const save = createLocalMediaSaver({ rootDir: root });

  await assert.rejects(() => save(Buffer.alloc(64), "image/png", "inbound", 32), /exceeds the 32 byte limit/);
});

test("a hostile subdir cannot escape the media root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-media-store-"));
  const save = createLocalMediaSaver({ rootDir: root });

  const saved = await save(Buffer.from("x"), undefined, "../../etc");

  assert.ok(saved.path.startsWith(root), `expected ${saved.path} to stay under ${root}`);
  assert.ok(!saved.path.includes(".."));
});

test("the saver prunes a bucket down to its limit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-media-store-"));
  const save = createLocalMediaSaver({ rootDir: root });

  for (let index = 0; index < 205; index += 1) {
    await save(Buffer.from("x"), "text/plain", "prune");
  }

  const files = readdirSync(path.join(root, "prune"));
  assert.ok(files.length <= 200, `expected at most 200 files, got ${files.length}`);
});

test("mime helpers cover the types the channel exchanges", () => {
  assert.equal(getMimeFromFilename("a.PDF"), "application/pdf");
  assert.equal(getMimeFromFilename("a.unknown-ext"), "application/octet-stream");
  assert.equal(getExtensionFromMime("image/jpeg; charset=binary"), ".jpg");
  assert.equal(getExtensionFromMime("application/x-unknown"), ".bin");
});
