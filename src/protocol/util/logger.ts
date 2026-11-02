import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";

/**
 * Plugin logger — writes JSON lines to a channel-owned log file:
 *   <DSH_HOME>/logs/dsh-weixin-YYYY-MM-DD.log
 *
 * The harness's own console sink stays the primary human-facing output; this
 * file exists so a long-running channel (long-poll + agent turns) leaves a
 * durable trail the user can hand over when something goes wrong.
 */

const MAIN_LOG_DIR = path.join(resolveStateDir(), "logs");
const SUBSYSTEM = "channels/dsh-weixin";
const RUNTIME = "node";
const RUNTIME_VERSION = process.versions.node;
const HOSTNAME = os.hostname() || "unknown";
const PARENT_NAMES = ["dsh"];

/** tslog-compatible level IDs (higher = more severe). */
const LEVEL_IDS: Record<string, number> = {
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ERROR: 5,
  FATAL: 6,
};

const DEFAULT_LOG_LEVEL = "INFO";

function resolveMinLevel(): number {
  const env = process.env.DSH_WEIXIN_LOG_LEVEL?.toUpperCase();
  if (env && env in LEVEL_IDS) return LEVEL_IDS[env];
  return LEVEL_IDS[DEFAULT_LOG_LEVEL];
}

let minLevelId = resolveMinLevel();

/** Dynamically change the minimum log level at runtime. */
export function setLogLevel(level: string): void {
  const upper = level.toUpperCase();
  if (!(upper in LEVEL_IDS)) {
    throw new Error(
      `Invalid log level: ${level}. Valid levels: ${Object.keys(LEVEL_IDS).join(", ")}`,
    );
  }
  minLevelId = LEVEL_IDS[upper];
}

/** Shift a Date into local time so toISOString() renders local clock digits. */
function toLocalISO(now: Date): string {
  const offsetMs = -now.getTimezoneOffset() * 60_000;
  const sign = offsetMs >= 0 ? "+" : "-";
  const abs = Math.abs(now.getTimezoneOffset());
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return new Date(now.getTime() + offsetMs).toISOString().replace("Z", offStr);
}

function localDateKey(now: Date): string {
  return toLocalISO(now).slice(0, 10);
}

function resolveMainLogPath(): string {
  const dateKey = localDateKey(new Date());
  return path.join(MAIN_LOG_DIR, `dsh-weixin-${dateKey}.log`);
}

let logDirEnsured = false;

export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Returns a child logger whose messages are prefixed with `[accountId]`. */
  withAccount(accountId: string): Logger;
  /** Returns the current main log file path. */
  getLogFilePath(): string;
  close(): void;
};

function buildLoggerName(accountId?: string): string {
  return accountId ? `${SUBSYSTEM}/${accountId}` : SUBSYSTEM;
}

/**
 * Optional second sink, used to mirror lines into the harness's own console
 * logger so channel activity is visible in the terminal that runs `dsh web`.
 */
export type ConsoleSink = (level: string, message: string) => void;

let consoleSink: ConsoleSink | undefined;

/** Install (or clear) the console mirror. */
export function setConsoleSink(sink: ConsoleSink | undefined): void {
  consoleSink = sink;
}

function writeLog(level: string, message: string, accountId?: string): void {
  const levelId = LEVEL_IDS[level] ?? LEVEL_IDS.INFO;
  if (levelId < minLevelId) return;

  const now = new Date();
  const loggerName = buildLoggerName(accountId);
  const prefixedMessage = accountId ? `[${accountId}] ${message}` : message;
  const entry = JSON.stringify({
    "0": loggerName,
    "1": prefixedMessage,
    _meta: {
      runtime: RUNTIME,
      runtimeVersion: RUNTIME_VERSION,
      hostname: HOSTNAME,
      name: loggerName,
      parentNames: PARENT_NAMES,
      date: now.toISOString(),
      logLevelId: LEVEL_IDS[level] ?? LEVEL_IDS.INFO,
      logLevelName: level,
    },
    time: toLocalISO(now),
  });
  try {
    if (!logDirEnsured) {
      fs.mkdirSync(MAIN_LOG_DIR, { recursive: true });
      logDirEnsured = true;
    }
    fs.appendFileSync(resolveMainLogPath(), `${entry}\n`, "utf-8");
  } catch {
    // Best-effort; never block on logging failures.
  }

  if (consoleSink !== undefined) {
    try {
      consoleSink(level, `[dsh-weixin] ${prefixedMessage}`);
    } catch {
      // A broken mirror must not break logging.
    }
  }
}

/** Creates a logger instance, optionally bound to a specific account. */
function createLogger(accountId?: string): Logger {
  return {
    info(message: string): void {
      writeLog("INFO", message, accountId);
    },
    debug(message: string): void {
      writeLog("DEBUG", message, accountId);
    },
    warn(message: string): void {
      writeLog("WARN", message, accountId);
    },
    error(message: string): void {
      writeLog("ERROR", message, accountId);
    },
    withAccount(id: string): Logger {
      return createLogger(id);
    },
    getLogFilePath(): string {
      return resolveMainLogPath();
    },
    close(): void {
      // No-op: appendFileSync has no persistent handle to close.
    },
  };
}

export const logger: Logger = createLogger();
