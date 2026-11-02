import { randomUUID } from "node:crypto";

import { apiGetFetch, apiPostFetch } from "../api/api.js";
import {
  clearStaleAccountsForUserId,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  notifyAccountSetChanged,
  normalizeWeixinAccountId,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "./accounts.js";
import { clearContextTokensForAccount } from "../messaging/inbound.js";
import { logger } from "../util/logger.js";
import { redactToken } from "../util/redact.js";

/**
 * Non-blocking Weixin QR login.
 *
 * Upstream drives this as a blocking terminal loop that reads the numeric
 * verification code from stdin. A DSH deployment is normally operated through
 * the web UI, so this module is a state machine instead: `start()` kicks off a
 * background long-poll loop, `snapshot()` answers a browser poll instantly, and
 * `submitVerifyCode()` feeds the numeric code in from a form.
 */

/** Default `bot_type` for ilink get_bot_qrcode / get_qrcode_status (this channel build). */
export const DEFAULT_ILINK_BOT_TYPE = "3";

/** Fixed API base URL for all QR code requests. */
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";

/** A login attempt stops being resumable after this long. */
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;

/** Client-side timeout for the long-poll get_qrcode_status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

/** How many times a QR code is refreshed before the attempt is abandoned. */
const MAX_QR_REFRESH_COUNT = 3;

/** Pause between two status polls after a non-eventful response. */
const POLL_INTERVAL_MS = 1_000;

/** Lifecycle of one login attempt. */
export type QrLoginStatus =
  | "starting"
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "refreshing"
  | "confirmed"
  | "already_connected"
  | "failed";

/** What a client (web page, tool) can read about a login attempt. */
export interface QrLoginSnapshot {
  sessionKey: string;
  status: QrLoginStatus;
  /** One line the UI can show verbatim. */
  message: string;
  /** Content that must be rendered as a QR code; absent once confirmed. */
  qrcodeUrl?: string;
  /** Epoch ms when the current QR code was issued. */
  startedAt: number;
  /** Whether a numeric verification code is currently expected. */
  needsVerifyCode: boolean;
  /** Account bound by this attempt, once confirmed. */
  accountId?: string;
  /** Weixin user id that scanned, once confirmed. */
  userId?: string;
  /** Terminal failure reason, when `status` is `failed`. */
  error?: string;
}

interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

type StatusValue =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

interface StatusResponse {
  status: StatusValue;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** Mutable state of one attempt (never handed out directly). */
interface QrLoginSession {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  status: QrLoginStatus;
  message: string;
  refreshCount: number;
  apiBaseUrl: string;
  /** Numeric code waiting to be sent back to the server. */
  pendingVerifyCode?: string;
  /** Resolved by {@link WeixinQrLoginManager.submitVerifyCode}. */
  verifyCodeWaiter?: (code: string) => void;
  accountId?: string;
  userId?: string;
  error?: string;
  abort: AbortController;
  done: boolean;
}

/** 获取本地已登录账号的 bot token 列表，最多返回最新的 10 个。 */
function getLocalBotTokenList(): string[] {
  const accountIds = listIndexedWeixinAccountIds();
  const tokens: string[] = [];
  for (let i = accountIds.length - 1; i >= 0 && tokens.length < 10; i--) {
    const accountId = accountIds[i];
    if (accountId === undefined) continue;
    const token = loadWeixinAccount(accountId)?.token?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QrCodeResponse> {
  const localTokenList = getLocalBotTokenList();
  logger.info(
    `fetchQRCode: apiBaseUrl=${apiBaseUrl} bot_type=${botType} localTokens=${localTokenList.length}`,
  );
  const rawText = await apiPostFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: localTokenList }),
    label: "fetchQRCode",
  });
  return JSON.parse(rawText) as QrCodeResponse;
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  verifyCode?: string,
): Promise<StatusResponse> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug("pollQRStatus: client-side timeout, treating as wait");
      return { status: "wait" };
    }
    // Gateway timeouts (Cloudflare 524, …) are normal for a long poll.
    logger.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
    return { status: "wait" };
  }
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

/**
 * Owns every in-flight QR login for this process.
 *
 * One manager instance is created at plugin mount and handed to both the login
 * route and the `weixin_login` tool, so a QR started in one place can be
 * finished in the other.
 */
export class WeixinQrLoginManager {
  private readonly sessions = new Map<string, QrLoginSession>();
  private readonly botType: string;

  constructor(options?: { botType?: string }) {
    this.botType = options?.botType ?? DEFAULT_ILINK_BOT_TYPE;
  }

  /**
   * Start (or reuse) one login attempt.
   *
   * @param options.force - discard a live QR and fetch a new one.
   * @param options.accountId - reuse this account id as the session key (re-login).
   * @returns the snapshot a UI should display.
   */
  async start(options?: { force?: boolean; accountId?: string }): Promise<QrLoginSnapshot> {
    this.purgeExpired();

    const sessionKey = options?.accountId?.trim() || randomUUID();
    const existing = this.sessions.get(sessionKey);
    if (options?.force !== true && existing !== undefined && !existing.done) {
      return this.snapshotOf(existing);
    }
    if (existing !== undefined) this.cancel(sessionKey);

    const session: QrLoginSession = {
      sessionKey,
      qrcode: "",
      qrcodeUrl: "",
      startedAt: Date.now(),
      status: "starting",
      message: "正在获取二维码…",
      refreshCount: 0,
      apiBaseUrl: FIXED_BASE_URL,
      abort: new AbortController(),
      done: false,
    };
    this.sessions.set(sessionKey, session);

    try {
      await this.refresh(session, false);
    } catch (err) {
      this.fail(session, `获取二维码失败：${String(err)}`);
      return this.snapshotOf(session);
    }

    session.status = "wait";
    session.message = "用手机微信扫描二维码，以继续连接。";
    void this.loop(session);
    return this.snapshotOf(session);
  }

  /** Read one attempt without side effects. */
  snapshot(sessionKey: string): QrLoginSnapshot | undefined {
    const session = this.sessions.get(sessionKey);
    return session === undefined ? undefined : this.snapshotOf(session);
  }

  /** Latest attempt, or undefined when none has been started. */
  latest(): QrLoginSnapshot | undefined {
    let latest: QrLoginSession | undefined;
    for (const session of this.sessions.values()) {
      if (latest === undefined || session.startedAt > latest.startedAt) latest = session;
    }
    return latest === undefined ? undefined : this.snapshotOf(latest);
  }

  /**
   * Feed the numeric code shown on the phone back into the running login.
   *
   * @returns false when the attempt is not waiting for a code.
   */
  submitVerifyCode(sessionKey: string, code: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (session === undefined || session.verifyCodeWaiter === undefined) return false;
    const trimmed = code.trim();
    if (trimmed === "") return false;
    session.pendingVerifyCode = trimmed;
    session.status = "wait";
    session.message = "正在验证…";
    session.verifyCodeWaiter(trimmed);
    session.verifyCodeWaiter = undefined;
    return true;
  }

  /** Abandon one attempt and stop its poll loop. */
  cancel(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session === undefined) return;
    session.done = true;
    session.abort.abort();
    session.verifyCodeWaiter?.("");
    session.verifyCodeWaiter = undefined;
    this.sessions.delete(sessionKey);
  }

  /** Abandon every attempt; used on plugin unmount. */
  cancelAll(): void {
    for (const sessionKey of [...this.sessions.keys()]) this.cancel(sessionKey);
  }

  private purgeExpired(): void {
    const cutoff = Date.now() - ACTIVE_LOGIN_TTL_MS;
    for (const [key, session] of this.sessions) {
      if (session.done || session.startedAt < cutoff) this.cancel(key);
    }
  }

  private snapshotOf(session: QrLoginSession): QrLoginSnapshot {
    const settled = session.status === "confirmed" || session.status === "already_connected";
    return {
      sessionKey: session.sessionKey,
      status: session.status,
      message: session.message,
      ...(settled ? {} : { qrcodeUrl: session.qrcodeUrl }),
      startedAt: session.startedAt,
      needsVerifyCode: false,
      ...(session.accountId === undefined ? {} : { accountId: session.accountId }),
      ...(session.userId === undefined ? {} : { userId: session.userId }),
      ...(session.error === undefined ? {} : { error: session.error }),
    };
  }

  /** Fetch a fresh QR code into `session` (also used for expiry refreshes). */
  private async refresh(session: QrLoginSession, isRefresh: boolean): Promise<void> {
    if (isRefresh) {
      session.status = "refreshing";
      session.message = `二维码已过期，正在刷新（${session.refreshCount}/${MAX_QR_REFRESH_COUNT}）…`;
    }
    const response = await fetchQRCode(FIXED_BASE_URL, this.botType);
    session.qrcode = response.qrcode;
    session.qrcodeUrl = response.qrcode_img_content;
    session.startedAt = Date.now();
    session.pendingVerifyCode = undefined;
    logger.info(`qr login: got code qrcode=${redactToken(response.qrcode)}`);
  }

  /** Wait for a numeric verification code from the client. */
  private awaitVerifyCode(session: QrLoginSession): Promise<string> {
    return new Promise((resolve) => {
      session.verifyCodeWaiter = resolve;
      session.abort.signal.addEventListener(
        "abort",
        () => {
          session.verifyCodeWaiter = undefined;
          resolve("");
        },
        { once: true },
      );
    });
  }

  /** The background status loop for one attempt. */
  private async loop(session: QrLoginSession): Promise<void> {
    const signal = session.abort.signal;

    while (!session.done && !signal.aborted) {
      const response = await pollQRStatus(
        session.apiBaseUrl,
        session.qrcode,
        session.pendingVerifyCode,
      );

      if (session.done) return;

      switch (response.status) {
        case "wait":
          break;

        case "scaned":
          // A sent code answered with `scaned` was accepted.
          session.pendingVerifyCode = undefined;
          session.status = "scaned";
          session.message = "已扫码，正在验证…";
          break;

        case "need_verifycode": {
          session.status = "need_verifycode";
          session.message =
            session.pendingVerifyCode === undefined
              ? "输入手机微信上显示的数字，以继续连接。"
              : "数字不匹配，请重新输入手机微信上显示的数字。";
          const code = await this.awaitVerifyCode(session);
          if (code === "") return; // cancelled
          continue; // poll again immediately with the code attached
        }

        case "verify_code_blocked": {
          session.pendingVerifyCode = undefined;
          session.refreshCount += 1;
          if (session.refreshCount > MAX_QR_REFRESH_COUNT) {
            this.fail(session, "多次输入错误，连接流程已停止。请稍后再试。");
            return;
          }
          try {
            await this.refresh(session, true);
            session.status = "wait";
            session.message = "多次输入错误，二维码已更新，请重新扫描。";
          } catch (err) {
            this.fail(session, `刷新二维码失败：${String(err)}`);
            return;
          }
          break;
        }

        case "expired": {
          session.refreshCount += 1;
          if (session.refreshCount > MAX_QR_REFRESH_COUNT) {
            this.fail(session, "二维码多次失效，连接流程已停止。请稍后再试。");
            return;
          }
          try {
            await this.refresh(session, true);
            session.status = "wait";
            session.message = "二维码已更新，请重新扫描。";
          } catch (err) {
            this.fail(session, `刷新二维码失败：${String(err)}`);
            return;
          }
          break;
        }

        case "scaned_but_redirect": {
          const redirectHost = response.redirect_host?.trim();
          if (redirectHost !== undefined && redirectHost !== "") {
            session.apiBaseUrl = `https://${redirectHost}`;
            logger.info(`qr login: IDC redirect, polling host is now ${redirectHost}`);
          } else {
            logger.warn("qr login: scaned_but_redirect without redirect_host, keeping current host");
          }
          break;
        }

        case "binded_redirect": {
          // The scanned bot is already bound to this deployment: existing
          // credentials stay valid, so this is a successful outcome.
          session.status = "already_connected";
          session.message = "该微信号已连接过此 DSH，无需重复连接。";
          session.done = true;
          this.sessions.delete(session.sessionKey);
          return;
        }

        case "confirmed": {
          if (!response.ilink_bot_id) {
            this.fail(session, "登录失败：服务器未返回 ilink_bot_id。");
            return;
          }
          this.persist(session, response);
          return;
        }
      }

      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  /** Persist the credentials a confirmed login produced. */
  private persist(session: QrLoginSession, response: StatusResponse): void {
    const normalizedId = normalizeWeixinAccountId(response.ilink_bot_id ?? "");
    try {
      saveWeixinAccount(normalizedId, {
        ...(response.bot_token === undefined ? {} : { token: response.bot_token }),
        ...(response.baseurl === undefined ? {} : { baseUrl: response.baseurl }),
        ...(response.ilink_user_id === undefined ? {} : { userId: response.ilink_user_id }),
      });
      registerWeixinAccountId(normalizedId);
      if (response.ilink_user_id !== undefined && response.ilink_user_id !== "") {
        clearStaleAccountsForUserId(
          normalizedId,
          response.ilink_user_id,
          clearContextTokensForAccount,
        );
      }
    } catch (err) {
      logger.error(`qr login: failed to persist accountId=${normalizedId} err=${String(err)}`);
      this.fail(session, `保存账号数据失败：${String(err)}`);
      return;
    }

    session.status = "confirmed";
    session.accountId = normalizedId;
    session.userId = response.ilink_user_id;
    session.message = "已将此 DSH 连接到微信。";
    session.done = true;
    this.sessions.delete(session.sessionKey);
    logger.info(
      `qr login: confirmed accountId=${normalizedId} userId=${redactToken(response.ilink_user_id)}`,
    );

    // Start the account's monitor without the route knowing about the channel.
    notifyAccountSetChanged();
  }

  private fail(session: QrLoginSession, message: string): void {
    session.status = "failed";
    session.error = message;
    session.message = message;
    session.done = true;
    this.sessions.delete(session.sessionKey);
    logger.warn(`qr login: ${message} (sessionKey=${session.sessionKey})`);
  }
}
