import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "weixin-settings-"));

const {
  WeixinSettingsStore,
  listDirectories,
  prepareWorkspace,
  resolveWorkspace,
} = await import("../lib/channel/settings.js");

test("resolveWorkspace prefers the user's choice over the configured value", () => {
  const chosen = resolveWorkspace("E:/projects/alpha", "/tmp/from-config");
  assert.equal(chosen.source, "settings");
  assert.equal(path.isAbsolute(chosen.path), true);
  assert.match(chosen.path.replace(/\\/g, "/"), /E:\/projects\/alpha|E:\/projects\/alpha/);

  const configured = resolveWorkspace(undefined, "/tmp/from-config");
  assert.equal(configured.source, "config");
  assert.equal(configured.path, path.resolve("/tmp/from-config"));
});

test("resolveWorkspace falls back to the process directory when config is blank", () => {
  const resolved = resolveWorkspace(undefined, "   ", "/tmp/process");
  assert.equal(resolved.source, "config");
  assert.equal(resolved.path, path.resolve("/tmp/process"));
});

test("resolveWorkspace expands a leading ~", () => {
  const resolved = resolveWorkspace("~", "/tmp/x");
  assert.equal(resolved.path, path.resolve(process.env.USERPROFILE ?? process.env.HOME ?? "~"));
});

test("the settings store round-trips a workspace", () => {
  const store = new WeixinSettingsStore();
  assert.equal(store.workspace, undefined);

  store.workspace = "E:/projects/beta";
  assert.equal(store.workspace, "E:/projects/beta");

  const onDisk = JSON.parse(
    readFileSync(path.join(process.env.DSH_HOME, "weixin", "settings.json"), "utf8"),
  );
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.workspace, "E:/projects/beta");

  // A fresh instance reads the same value.
  assert.equal(new WeixinSettingsStore().workspace, "E:/projects/beta");
});

test("clearing the workspace removes it from the file", () => {
  const store = new WeixinSettingsStore();
  store.workspace = "E:/projects/gamma";
  store.workspace = undefined;
  assert.equal(store.workspace, undefined);

  const onDisk = JSON.parse(
    readFileSync(path.join(process.env.DSH_HOME, "weixin", "settings.json"), "utf8"),
  );
  assert.equal("workspace" in onDisk, false);
});

test("a malformed settings file is ignored, not fatal", () => {
  writeFileSync(path.join(process.env.DSH_HOME, "weixin", "settings.json"), "{not json", "utf8");
  assert.equal(new WeixinSettingsStore().workspace, undefined);
});

test("the three settings do not clobber each other", () => {
  const store = new WeixinSettingsStore();

  store.workspace = "E:/projects/delta";
  store.agentPreset = "standard";
  store.permissionPreset = "read-only";

  // Each writer must keep the siblings: three separate controls share one file.
  assert.equal(store.workspace, "E:/projects/delta");
  assert.equal(store.agentPreset, "standard");
  assert.equal(store.permissionPreset, "read-only");

  const onDisk = JSON.parse(
    readFileSync(path.join(process.env.DSH_HOME, "weixin", "settings.json"), "utf8"),
  );
  assert.equal(onDisk.workspace, "E:/projects/delta");
  assert.equal(onDisk.agentPreset, "standard");
  assert.equal(onDisk.permissionPreset, "read-only");

  // Clearing one leaves the other two alone.
  store.permissionPreset = undefined;
  const afterClear = JSON.parse(
    readFileSync(path.join(process.env.DSH_HOME, "weixin", "settings.json"), "utf8"),
  );
  assert.equal("permissionPreset" in afterClear, false);
  assert.equal(afterClear.workspace, "E:/projects/delta");
  assert.equal(afterClear.agentPreset, "standard");

  // Whitespace-only is "no choice", not a preset named " ".
  store.agentPreset = "   ";
  assert.equal(store.agentPreset, undefined);
  assert.equal(new WeixinSettingsStore().agentPreset, undefined);
  assert.equal(new WeixinSettingsStore().workspace, "E:/projects/delta");
});

test("prepareWorkspace rejects a relative path", () => {
  const result = prepareWorkspace("./somewhere/else");
  assert.equal(result.ok, false);
  assert.match(result.error, /绝对路径/);
});

test("prepareWorkspace rejects an empty string", () => {
  const result = prepareWorkspace("   ");
  assert.equal(result.ok, false);
  assert.match(result.error, /不能为空/);
});

test("prepareWorkspace rejects a file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-ws-"));
  const file = path.join(root, "a-file.txt");
  writeFileSync(file, "x", "utf8");

  const result = prepareWorkspace(file);
  assert.equal(result.ok, false);
  assert.match(result.error, /不是目录/);
});

test("prepareWorkspace accepts an existing directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-ws-"));
  const result = prepareWorkspace(root);
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.writable, true);
});

test("prepareWorkspace creates a missing directory, like the harness does", () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-ws-"));
  const target = path.join(root, "deep", "project");

  const result = prepareWorkspace(target);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.path, path.resolve(target));
});

test("listDirectories returns only sub-directories, alphabetically", () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-dirs-"));
  mkdirSync(path.join(root, "zeta"));
  mkdirSync(path.join(root, "alpha"));
  mkdirSync(path.join(root, ".hidden"));
  writeFileSync(path.join(root, "file.txt"), "x", "utf8");

  const listing = listDirectories(root);
  assert.ok(!("error" in listing));
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["alpha", "zeta"],
  );
  assert.equal(listing.parent, path.dirname(path.resolve(root)));
  assert.equal(listing.truncated, false);
});

test("listDirectories reports its own directory and the parent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "weixin-dirs-"));
  const child = path.join(root, "child");
  mkdirSync(child);

  const listing = listDirectories(child);
  assert.ok(!("error" in listing));
  assert.equal(listing.path, path.resolve(child));
  assert.equal(listing.parent, path.resolve(root));
});

test("listDirectories refuses a relative path and a file", () => {
  const relative = listDirectories("relative/dir");
  assert.ok("error" in relative);

  const root = mkdtempSync(path.join(tmpdir(), "weixin-dirs-"));
  const file = path.join(root, "file.txt");
  writeFileSync(file, "x", "utf8");
  const onFile = listDirectories(file);
  assert.ok("error" in onFile);
});
