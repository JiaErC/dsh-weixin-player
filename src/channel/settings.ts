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
}

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
      this.data = {
        version: 1,
        ...(typeof parsed.workspace === "string" && parsed.workspace.trim() !== ""
          ? { workspace: parsed.workspace.trim() }
          : {}),
      };
      logger.debug(`settings: loaded workspace=${this.data.workspace ?? "(unset)"}`);
    } catch {
      // No file yet, or unreadable: the config value applies.
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
    this.load();
    const next: SettingsFile = {
      version: 1,
      ...(workspace === undefined ? {} : { workspace }),
    };
    this.data = next;
    try {
      fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf-8");
      logger.info(`settings: workspace set to ${workspace ?? "(config default)"}`);
    } catch (err) {
      logger.error(`settings: failed to persist: ${String(err)}`);
      throw err;
    }
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
