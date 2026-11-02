import fs from "node:fs";
import path from "node:path";

import { sendMessageWeixin } from "../protocol/messaging/send.js";
import { sendWeixinMediaFile } from "../protocol/messaging/send-media.js";
import { downloadRemoteImageToTemp } from "../protocol/cdn/upload.js";
import { resolveMediaDir } from "../protocol/storage/state-dir.js";
import { assertSessionActive } from "../protocol/api/session-guard.js";
import type { ResolvedWeixinAccount } from "../protocol/auth/accounts.js";
import { logger } from "../protocol/util/logger.js";
import type { OutboundDelivery } from "./reply.js";
import { TypingIndicator } from "./typing.js";

/**
 * Outbound sends for one account.
 *
 * Everything that writes to WeChat funnels through here so the session guard,
 * the context token and the media routing rules live in one place. Callers pass
 * a peer id; they never touch the API module directly.
 */

/** Directory for media downloaded from a remote URL before re-uploading. */
function outboundTempDir(): string {
  return resolveMediaDir("outbound-temp");
}

/** Resolve a local path or URL into a local file path to upload. */
async function materializeMedia(mediaPath: string): Promise<string> {
  if (mediaPath.startsWith("file://")) return new URL(mediaPath).pathname;
  if (mediaPath.startsWith("http://") || mediaPath.startsWith("https://")) {
    return downloadRemoteImageToTemp(mediaPath, outboundTempDir());
  }
  if (path.isAbsolute(mediaPath)) return mediaPath;
  return path.resolve(process.cwd(), mediaPath);
}

export interface SendContext {
  /** Context token from the inbound message; required for a normal reply. */
  contextToken?: string;
  /** Run id echoed to the platform for correlation. */
  runId?: string;
}

/** Sends text and media to WeChat peers of one account. */
export class AccountSender {
  constructor(
    private readonly account: ResolvedWeixinAccount,
    private readonly cdnBaseUrl: string,
  ) {}

  private get opts(): {
    baseUrl: string;
    token: string;
    accountId: string;
  } {
    assertSessionActive(this.account.accountId);
    if (this.account.token === undefined || this.account.token === "") {
      throw new Error(
        `dsh-weixin: account ${this.account.accountId} has no token — log in again from /dsh-weixin`,
      );
    }
    return {
      baseUrl: this.account.baseUrl,
      token: this.account.token,
      accountId: this.account.accountId,
    };
  }

  /**
   * Build the typing indicator for one recipient of this account.
   *
   * Kept here so credentials have a single source of truth: the indicator
   * needs the same base URL and token as the messages it accompanies.
   */
  createTypingIndicator(to: string, ticket: string | undefined): TypingIndicator {
    return new TypingIndicator({
      baseUrl: this.account.baseUrl,
      ...(this.account.token === undefined ? {} : { token: this.account.token }),
      to,
      ticket,
    });
  }

  /** Send one text message, returning the platform message id when present. */
  async sendText(to: string, text: string, context?: SendContext): Promise<string | undefined> {
    if (text.trim() === "") return undefined;
    const response = await sendMessageWeixin({
      to,
      text,
      opts: {
        ...this.opts,
        ...(context?.contextToken === undefined ? {} : { contextToken: context.contextToken }),
        ...(context?.runId === undefined ? {} : { runId: context.runId }),
      },
    });
    return response.serverMessageId;
  }

  /** Upload and send one local file, optionally captioned. */
  async sendFile(
    to: string,
    filePath: string,
    text: string,
    context?: SendContext,
  ): Promise<void> {
    const resolved = await materializeMedia(filePath);
    const stat = await fs.promises.stat(resolved).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) {
      throw new Error(`dsh-weixin: media file not found: ${resolved}`);
    }
    await sendWeixinMediaFile({
      filePath: resolved,
      to,
      text,
      opts: {
        ...this.opts,
        ...(context?.contextToken === undefined ? {} : { contextToken: context.contextToken }),
        ...(context?.runId === undefined ? {} : { runId: context.runId }),
      },
      cdnBaseUrl: this.cdnBaseUrl,
    });
  }

  /**
   * Send one prepared delivery.
   *
   * A delivery whose media failed to upload still delivers its text into the
   * chat instead of vanishing, so the user is never left without an answer.
   */
  async sendDelivery(to: string, delivery: OutboundDelivery, context?: SendContext): Promise<void> {
    const mediaPath = delivery.mediaPath;
    if (mediaPath === undefined) {
      await this.sendText(to, delivery.text, context);
      return;
    }

    try {
      await this.sendFile(to, mediaPath, delivery.text, context);
    } catch (err) {
      logger.error(`outbound: media send failed to=${to} path=${mediaPath}: ${String(err)}`);
      const notice = delivery.text === ""
        ? `⚠️ 文件发送失败：${path.basename(mediaPath)}`
        : `${delivery.text}\n\n⚠️ 文件发送失败：${path.basename(mediaPath)}`;
      await this.sendText(to, notice, context);
    }
  }
}
