import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWeixinStateDir } from "../protocol/storage/state-dir.js";
import { logger } from "../protocol/util/logger.js";
import type { WorkspaceSource } from "../shared/wire.js";

/**
 * Settings a user picks at runtime, persisted next to the credentials.
 *
 * The Loader row's `config:` block is the deployment's declaration; this file is
 * what the *user* changes in the sidebar tab. The stored value wins, so a
 * workspace chosen in the UI survives a restart without editing YAML.
 */

/** On-disk shape. */
interface SettingsFile {
  version: 1;
  /** Absolute directory new WeChat sessions are created in. */
  workspace?: string;
  /** Agent preset id new WeChat sessions compose; `none` means no preset. */
  agentPreset?: string;
  /** Permission preset id new WeChat sessions start under. */
  permissionPreset?: string;
}

/** The string fields a user can choose, in the order they are normalised. */
const STRING_FIELDS = ["workspace", "agentPreset", "permissionPreset"] as const;

/** Where the settings live. */
function settingsPath(): string {
  return path.join(resolveWeixinStateDir(), "settings.json");
}

/** Read/write the channel's user-editable settings. */
export class WeixinSettingsStore {
  private loaded = false;
  private data: SettingsFile = { version: 1 };

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf-8")) as SettingsFile;
      if (parsed.version !== 1) return;
      const next: SettingsFile = { version: 1 };
      for (const field of STRING_FIELDS) {
        const value = parsed[field];
        if (typeof value === "string" && value.trim() !== "") next[field] = value.trim();
      }
      this.data = next;
      logger.debug(
        `settings: loaded workspace=${this.data.workspace ?? "(unset)"} ` +
          `agentPreset=${this.data.agentPreset ?? "(unset)"} ` +
          `permissionPreset=${this.data.permissionPreset ?? "(unset)"}`,
      );
    } catch {
      // No file yet, or unreadable: the config value applies.
    }
  }

  /**
   * Merge one field into the file, keeping the others.
   *
   * Each setting is chosen by a different control in the tab, so a writer that
   * replaced the whole file would silently erase the other two.
   */
  private write(patch: Partial<SettingsFile>): void {
    this.load();
    const next: SettingsFile = { ...this.data, ...patch, version: 1 };
    for (const field of STRING_FIELDS) {
      const value = next[field];
      // An empty string means "fall back to the config value", not "store ''".
      if (typeof value !== "string" || value.trim() === "") delete next[field];
      else next[field] = value.trim();
    }
    this.data = next;
    try {
      fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf-8");
      logger.info(
        `settings: saved workspace=${next.workspace ?? "(config)"} ` +
          `agentPreset=${next.agentPreset ?? "(config)"} ` +
          `permissionPreset=${next.permissionPreset ?? "(config)"}`,
      );
    } catch (err) {
      logger.error(`settings: failed to persist: ${String(err)}`);
      throw err;
    }
  }

  /** The user-chosen workspace, or undefined when they never picked one. */
  get workspace(): string | undefined {
    this.load();
    return this.data.workspace;
  }

  /**
   * Persist a user-chosen workspace.
   *
   * @param workspace - absolute directory, or undefined to fall back to config.
   */
  set workspace(workspace: string | undefined) {
    this.write({ workspace });
  }

  /** The user-chosen agent preset, or undefined when the config value applies. */
  get agentPreset(): string | undefined {
    this.load();
    return this.data.agentPreset;
  }

  /**
   * Persist the agent preset new WeChat sessions compose.
   *
   * @param agentPreset - preset id, `none`, or undefined to fall back to config.
   */
  set agentPreset(agentPreset: string | undefined) {
    this.write({ agentPreset });
  }

  /** The user-chosen permission preset, or undefined when the config applies. */
  get permissionPreset(): string | undefined {
    this.load();
    return this.data.permissionPreset;
  }

  /**
   * Persist the permission preset new WeChat sessions start under.
   *
   * @param permissionPreset - preset key, or undefined to fall back to config.
   */
  set permissionPreset(permissionPreset: string | undefined) {
    this.write({ permissionPreset });
  }
}

/** A resolved workspace plus where the value came from. */
export interface ResolvedWorkspace {
  /** Absolute, normalised path. */
  path: string;
  /** `settings` when a user chose it in the UI, `config` when the row set it. */
  source: WorkspaceSource;
}

/**
 * Pick the effective workspace.
 *
 * @param chosen - the user's choice from the settings file, when present.
 * @param configured - the Loader row's `workspace` (already absolute in practice).
 * @param cwd - last-resort process directory.
 */
export function resolveWorkspace(
  chosen: string | undefined,
  configured: string,
  cwd: string = process.cwd(),
): ResolvedWorkspace {
  if (chosen !== undefined && chosen !== "") {
    return { path: path.resolve(expandHome(chosen)), source: "settings" };
  }
  const base = configured.trim() === "" ? cwd : configured;
  return { path: path.resolve(expandHome(base)), source: "config" };
}

/** Expand a leading `~` so a pasted POSIX-style path still resolves. */
function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** Outcome of validating a user-supplied directory. */
export type PrepareWorkspaceResult =
  | { ok: true; path: string; created: boolean; writable: boolean }
  | { ok: false; error: string };

/**
 * Validate (and if necessary create) a directory the user chose.
 *
 * This mirrors what the harness itself does before creating a session: the
 * project directory is created when missing, so a path typed slightly early
 * does not fail later at the agent's first turn.
 *
 * @param input - the raw string from the UI.
 */
export function prepareWorkspace(input: string): PrepareWorkspaceResult {
  const raw = input.trim();
  if (raw === "") return { ok: false, error: "目录不能为空" };

  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: `请填写绝对路径（例如 E:\\work\\project），收到的是 ${expanded}` };
  }

  const target = path.resolve(expanded);
  let created = false;

  try {
    const info = fs.statSync(target);
    if (!info.isDirectory()) return { ok: false, error: `${target} 是一个文件，不是目录` };
  } catch {
    try {
      fs.mkdirSync(target, { recursive: true });
      created = true;
    } catch (err) {
      return { ok: false, error: `无法创建目录 ${target}：${String(err)}` };
    }
  }

  let writable = false;
  try {
    fs.accessSync(target, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  return { ok: true, path: target, created, writable };
}

/** What the channel knows about a directory without touching it. */
export interface WorkspaceInspection {
  /** Absolute, normalised path. */
  path: string;
  exists: boolean;
  writable: boolean;
}

/**
 * Report whether a directory exists and is writable.
 *
 * A read must not have side effects, so unlike {@link prepareWorkspace} this
 * never creates anything: the tab polls it to render the workspace card.
 *
 * @param input - an absolute path (a leading `~` is expanded).
 */
export function inspectWorkspace(input: string): WorkspaceInspection {
  const target = path.resolve(expandHome(input));
  try {
    const info = fs.statSync(target);
    if (!info.isDirectory()) return { path: target, exists: false, writable: false };
  } catch {
    return { path: target, exists: false, writable: false };
  }

  let writable = false;
  try {
    fs.accessSync(target, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return { path: target, exists: true, writable };
}

/** One directory a picker can enter. */
export interface DirectoryEntry {
  name: string;
  path: string;
}

/** A directory listing for the picker. */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  truncated: boolean;
}

/** Cap on entries returned, so a huge folder cannot stall the tab. */
const MAX_ENTRIES = 500;

/**
 * List the sub-directories of one path.
 *
 * Only directories are returned: the picker chooses a working directory, and
 * listing files would leak more than the feature needs.
 *
 * @param input - an absolute directory path.
 * @returns the listing, or an error string the caller can show.
 */
export function listDirectories(input: string): DirectoryListing | { error: string } {
  const raw = input.trim();
  if (raw === "") return { error: "目录不能为空" };

  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) return { error: `请填写绝对路径，收到的是 ${expanded}` };

  const target = path.resolve(expanded);
  let names: string[];
  try {
    const info = fs.statSync(target);
    if (!info.isDirectory()) return { error: `${target} 不是目录` };
    names = fs.readdirSync(target);
  } catch (err) {
    return { error: `无法读取 ${target}：${String(err)}` };
  }

  const entries: DirectoryEntry[] = [];
  let capped = false;
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    const candidate = path.join(target, name);
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({ name, path: candidate });
    if (entries.length >= MAX_ENTRIES) {
      capped = true;
      break;
    }
  }

  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries,
    truncated: capped,
  };
}

/** One directory *or file* in the mini program's browser. */
export interface FileEntry {  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
  mtime?: number;
}

/** A mixed listing for the file browser. */
export interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
  /** Entries whose metadata could not be read (permissions, broken links). */
  skipped: number;
}

/**
 * List directories and files of one path, directories first.
 *
 * This is the widest thing the mini-program API exposes, so it deliberately
 * returns **metadata only** — names, kinds, sizes and mtimes. File contents are
 * never read here.
 *
 * @param input - an absolute directory path.
 * @returns the listing, or an error string the caller can show.
 */
export function listEntries(input: string): FileListing | { error: string } {
  const raw = input.trim();
  if (raw === "") return { error: "目录不能为空" };

  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) return { error: `请填写绝对路径，收到的是 ${expanded}` };

  const target = path.resolve(expanded);
  let names: string[];
  try {
    const info = fs.statSync(target);
    if (!info.isDirectory()) return { error: `${target} 不是目录` };
    names = fs.readdirSync(target);
  } catch (err) {
    return { error: `无法读取 ${target}：${String(err)}` };
  }

  const directories: FileEntry[] = [];
  const files: FileEntry[] = [];
  let skipped = 0;
  let capped = false;

  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    if (directories.length + files.length >= MAX_ENTRIES) {
      capped = true;
      break;
    }
    const candidate = path.join(target, name);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      skipped += 1;
      continue;
    }
    if (stats.isDirectory()) {
      directories.push({ name, path: candidate, kind: "dir", mtime: stats.mtimeMs });
    } else if (stats.isFile()) {
      files.push({
        name,
        path: candidate,
        kind: "file",
        size: stats.size,
        mtime: stats.mtimeMs,
      });
    } else {
      skipped += 1;
    }
  }

  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries: [...directories, ...files],
    truncated: capped,
    skipped,
  };
}

/** A short text preview of one file. */
export interface FilePreview {
  path: string;
  name: string;
  size: number;
  /** True when the file is longer than {@link PREVIEW_MAX_BYTES}. */
  truncated: boolean;
  text: string;
}

/** How much of a file the preview may return. */
export const PREVIEW_MAX_BYTES = 64 * 1024;

/** Extensions that are text often enough to preview without sniffing harder. */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".log", ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".scss", ".less", ".js", ".mjs",
  ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".py", ".go", ".rs", ".java", ".kt", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".ps1", ".bat", ".sql", ".env",
  ".gitignore", ".dockerfile", ".editorconfig", ".wxml", ".wxss", ".wxs", ".prisma",
]);

/**
 * Read a text file for the mini program's preview.
 *
 * Three fences, because this is the only route that returns file *contents*:
 *
 *  1. **Containment** — the resolved path must stay inside `root` (the current
 *     workspace), so the API cannot walk off into the rest of the disk;
 *  2. **No dotfiles** — anything whose path contains a `.`-prefixed segment is
 *     refused, which keeps `.env`, `.ssh`, `.git` out of reach;
 *  3. **Text and size** — a NUL byte in the first 4 KiB, or an extension outside
 *     the allowlist, or a file larger than {@link PREVIEW_MAX_BYTES}, is refused
 *     or truncated rather than streamed.
 *
 * @param root - the workspace the preview is confined to.
 * @param input - absolute path the app asked for.
 * @returns the preview, or an error string fit for a toast.
 */
export function readTextFile(root: string, input: string): FilePreview | { error: string } {
  const raw = input.trim();
  if (raw === "") return { error: "路径不能为空" };

  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) return { error: `请填写绝对路径，收到的是 ${expanded}` };

  const target = path.resolve(expanded);
  const base = path.resolve(expandHome(root));
  const relative = path.relative(base, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { error: `只能预览工作目录（${base}）里的文件` };
  }
  if (relative.split(path.sep).some((segment) => segment.startsWith("."))) {
    return { error: "以 . 开头的文件与目录不提供预览" };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(target);
  } catch (error) {
    return { error: `无法读取 ${target}：${String(error)}` };
  }
  if (!stats.isFile()) return { error: `${target} 不是文件` };

  const extension = path.extname(target).toLowerCase();
  const allowed =
    TEXT_EXTENSIONS.has(extension) ||
    path.basename(target).toLowerCase().startsWith("dockerfile") ||
    path.basename(target).toLowerCase() === "makefile";
  if (!allowed) return { error: `不预览 ${extension || "无扩展名"} 类型的文件` };

  let handle: number;
  try {
    handle = fs.openSync(target, "r");
  } catch (error) {
    return { error: `无法打开 ${target}：${String(error)}` };
  }
  try {
    const length = Math.min(stats.size, PREVIEW_MAX_BYTES);
    const buffer = Buffer.alloc(Number(length));
    fs.readSync(handle, buffer, 0, Number(length), 0);
    const head = buffer.subarray(0, Math.min(buffer.length, 4096));
    if (head.includes(0)) return { error: "这是二进制文件，不支持预览" };
    return {
      path: target,
      name: path.basename(target),
      size: stats.size,
      truncated: stats.size > PREVIEW_MAX_BYTES,
      text: buffer.toString("utf8"),
    };
  } finally {
    fs.closeSync(handle);
  }
}
