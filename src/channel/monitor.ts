import { classifyFetchError, getUpdates } from "../protocol/api/api.js";
import { WeixinConfigManager } from "../protocol/api/config-cache.js";
import { STALE_TOKEN_ERRCODE, getRemainingPauseMs, pauseSession } from "../protocol/api/session-guard.js";
import type { WeixinMessage } from "../protocol/api/types.js";
import {
  getSyncBufFilePath,
  loadGetUpdatesBuf,
  saveGetUpdatesBuf,
} from "../protocol/storage/sync-buf.js";
import type { ResolvedWeixinAccount } from "../protocol/auth/accounts.js";
import { logger } from "../protocol/util/logger.js";
import { redactBody } from "../protocol/util/redact.js";

/**
 * The `getUpdates` long-poll loop for one logged-in account.
 *
 * Owns transport concerns only: cursor persistence, error classification,
 * backoff, and the stale-token cooldown. Message semantics live in
 * `handle-message.ts`, so a bug in reply formatting can never stop the poll.
 */

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

/** Mutable state of one running account, read by `/status` and the route. */
export interface MonitorStatus {
  running: boolean;
  startedAt: number;
  lastEventAt?: number;
  lastPollAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
  inboundCount: number;
  consecutiveFailures: number;
}

/** Fresh status for an account that has not started yet. */
export function createMonitorStatus(): MonitorStatus {
  return { running: false, startedAt: 0, inboundCount: 0, consecutiveFailures: 0 };
}

export interface MonitorDeps {
  account: ResolvedWeixinAccount;
  /** Long-poll timeout requested from the server. */
  longPollTimeoutMs: number;
  /** Per-account `getConfig` cache (typing ticket). */
  configManager: WeixinConfigManager;
  /** Inbound handler; must not throw for a single bad message. */
  handleMessage: (message: WeixinMessage) => Promise<void>;
  abortSignal: AbortSignal;
  status: MonitorStatus;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** True when a getUpdates response reports an application-level error. */
function isApiError(response: { ret?: number; errcode?: number }): boolean {
  return (
    (response.ret !== undefined && response.ret !== 0) ||
    (response.errcode !== undefined && response.errcode !== 0)
  );
}

/**
 * Run the long-poll loop until `abortSignal` fires.
 *
 * @returns a promise that settles when the loop has fully stopped.
 */
export async function monitorWeixinAccount(deps: MonitorDeps): Promise<void> {
  const { account, abortSignal, status } = deps;
  const accountId = account.accountId;
  const log = logger.withAccount(accountId);

  if (account.token === undefined || account.token === "") {
    throw new Error(`dsh-weixin: account ${accountId} has no token; log in again`);
  }

  const syncFilePath = getSyncBufFilePath(accountId);
  let getUpdatesBuf = loadGetUpdatesBuf(syncFilePath) ?? "";
  let nextTimeoutMs = deps.longPollTimeoutMs;
  let consecutiveFailures = 0;

  status.running = true;
  status.startedAt = Date.now();
  log.info(
    `monitor started: baseUrl=${account.baseUrl} timeoutMs=${nextTimeoutMs} cursor=${getUpdatesBuf === "" ? "fresh" : `${getUpdatesBuf.length}B`}`,
  );

  while (!abortSignal.aborted) {
    try {
      const response = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      status.lastPollAt = Date.now();

      if (response.longpolling_timeout_ms !== undefined && response.longpolling_timeout_ms > 0) {
        nextTimeoutMs = response.longpolling_timeout_ms;
      }

      if (isApiError(response)) {
        if (response.errcode === STALE_TOKEN_ERRCODE || response.ret === STALE_TOKEN_ERRCODE) {
          // The server rejected the bot token: pause instead of hammering it.
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          status.lastError = `token 已失效，暂停 ${Math.ceil(pauseMs / 60_000)} 分钟`;
          consecutiveFailures = 0;
          log.error(`getUpdates: stale token, pausing ${Math.ceil(pauseMs / 60_000)} min`);
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        status.consecutiveFailures = consecutiveFailures;
        status.lastError = `getUpdates ret=${response.ret} errcode=${response.errcode} ${response.errmsg ?? ""}`;
        log.error(
          `getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""} body=${redactBody(JSON.stringify(response))}`,
        );
        await sleep(
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
          abortSignal,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        continue;
      }

      consecutiveFailures = 0;
      status.consecutiveFailures = 0;
      status.lastEventAt = Date.now();
      status.lastError = undefined;

      if (response.get_updates_buf !== undefined && response.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, response.get_updates_buf);
        getUpdatesBuf = response.get_updates_buf;
      }

      for (const message of response.msgs ?? []) {
        if (abortSignal.aborted) break;
        status.lastInboundAt = Date.now();
        status.inboundCount += 1;
        log.info(
          `inbound: from=${message.from_user_id ?? "?"} items=${message.item_list?.map((item) => item.type).join(",") ?? "none"}`,
        );
        try {
          await deps.handleMessage(message);
        } catch (err) {
          // A single message must never stop the loop.
          log.error(`inbound handler failed: ${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      consecutiveFailures += 1;
      status.consecutiveFailures = consecutiveFailures;
      const classified = classifyFetchError(err);
      status.lastError = `getUpdates ${classified.type}: ${String(err)}`;
      log.error(
        `getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) type=${classified.type} description=${classified.description} error=${String(err)}`,
      );
      await sleep(
        consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
        abortSignal,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
    }
  }

  status.running = false;
  log.info("monitor stopped");
}

/** Build the per-account config cache used for typing tickets. */
export function createConfigManager(account: ResolvedWeixinAccount): WeixinConfigManager {
  return new WeixinConfigManager(
    {
      baseUrl: account.baseUrl,
      ...(account.token === undefined ? {} : { token: account.token }),
    },
    (line) => logger.withAccount(account.accountId).info(line),
  );
}
