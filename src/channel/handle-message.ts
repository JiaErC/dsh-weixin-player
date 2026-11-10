import { randomUUID } from "node:crypto";

import type { WeixinChannelConfig } from "../config.js";
import { WeixinConfigManager } from "../protocol/api/config-cache.js";
import type { WeixinMessage } from "../protocol/api/types.js";
import { MessageItemType } from "../protocol/api/types.js";
import {
  getWeixinMessageId,
  isMediaItem,
  resolveStoredQuoteContext,
  setContextToken,
  weixinMessageToMsgContext,
} from "../protocol/messaging/inbound.js";
import type { WeixinMsgContext } from "../protocol/messaging/inbound.js";
import { getQuoteStore } from "../protocol/messaging/quote-store.js";
import { downloadMediaFromItem } from "../protocol/media/media-download.js";
import { createLocalMediaSaver } from "../protocol/media/media-store.js";
import { logger } from "../protocol/util/logger.js";
import { isChannelCommand, handleChannelCommand } from "./commands.js";
import type { AccountSender } from "./outbound.js";
import type { AgentSessionManager, PeerSessionStore } from "./peer-session.js";
import { buildDeliveries, describeEmptyTurn } from "./reply.js";

/**
 * One inbound WeChat message → one agent turn → the reply back in WeChat.
 *
 * Kept separate from the long-poll loop so the loop only owns transport
 * concerns (backoff, sync buffer, abort) and this module owns semantics.
 */

/** Everything one inbound message needs. */
export interface HandleMessageDeps {
  config: WeixinChannelConfig;
  accountId: string;
  sender: AccountSender;
  sessions: AgentSessionManager;
  store: PeerSessionStore;
  configManager: WeixinConfigManager;
  cdnBaseUrl: string;
  /** Epoch ms the account's monitor started, for `/status`. */
  startedAt: number;
  /** Peer ids allowed to talk to the agent (empty = allow every sender). */
  allowFrom: () => readonly string[];
  /**
   * Keep a copy of each inbound body for the mini program's "recent messages".
   * Optional: the pipeline works without it.
   */
  record?: (accountId: string, peerId: string, role: "user", text: string) => void;
}

/** Save decrypted inbound media once per process. */
const saveMedia = createLocalMediaSaver();

/** Recently handled platform message ids, so a replayed sync buffer is ignored. */
const handledMessageIds = new Set<string>();
const HANDLED_ID_LIMIT = 500;

function rememberMessageId(messageId: string): boolean {
  if (handledMessageIds.has(messageId)) return false;
  handledMessageIds.add(messageId);
  if (handledMessageIds.size > HANDLED_ID_LIMIT) {
    const oldest = handledMessageIds.values().next();
    if (oldest.done !== true) handledMessageIds.delete(oldest.value);
  }
  return true;
}

/** Text of the first text item, if the message carries one. */
function textBody(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/** Find the first downloadable media item in the message. */
function findMediaItem(msg: WeixinMessage) {
  const downloadable = (media?: { encrypt_query_param?: string; full_url?: string }) =>
    Boolean(media?.encrypt_query_param ?? media?.full_url);

  return (
    msg.item_list?.find(
      (item) => item.type === MessageItemType.IMAGE && downloadable(item.image_item?.media),
    ) ??
    msg.item_list?.find(
      (item) => item.type === MessageItemType.VIDEO && downloadable(item.video_item?.media),
    ) ??
    msg.item_list?.find(
      (item) => item.type === MessageItemType.FILE && downloadable(item.file_item?.media),
    ) ??
    msg.item_list?.find(
      (item) =>
        item.type === MessageItemType.VOICE &&
        downloadable(item.voice_item?.media) &&
        !item.voice_item?.text,
    ) ??
    msg.item_list?.find(
      (item) =>
        item.type === MessageItemType.TEXT &&
        item.ref_msg?.message_item !== undefined &&
        isMediaItem(item.ref_msg.message_item),
    )?.ref_msg?.message_item
  );
}

/**
 * Render the inbound context as the text an agent reads.
 *
 * DSH image blocks need attachment ids the channel cannot mint, so media is
 * described by its local path: the agent's file tools can open it, and the user
 * still sees the message text.
 *
 * Exported for tests: it is the one place where a WeChat message becomes words.
 */
export function composeUserText(context: WeixinMsgContext): string {
  const parts: string[] = [];
  const body = context.Body.trim();

  if (body !== "" && !isPlaceholderOnly(body)) parts.push(body);
  else if (body !== "") parts.push("（用户发来一个附件，没有文字说明）");

  if (context.ReplyToBody !== undefined && context.ReplyToBody !== "") {
    const quoted = context.ReplyToQuoteText ?? context.ReplyToBody;
    parts.push(`[引用的消息] ${quoted}`);
  }

  const paths =
    context.MediaPaths ?? (context.MediaPath === undefined ? [] : [context.MediaPath]);
  const types =
    context.MediaTypes ??
    (context.MediaType === undefined ? [] : [context.MediaType]);

  for (const [index, mediaPath] of paths.entries()) {
    const mediaType = types[index] ?? "application/octet-stream";
    parts.push(`[附件] 已保存到 ${mediaPath}（${mediaType}）`);
  }

  for (const extra of context.ChannelPromptContext ?? []) {
    if (extra.trim() !== "") parts.push(extra);
  }

  return parts.join("\n\n");
}

/** True when the body is only a media placeholder label such as `[图片]`. */
function isPlaceholderOnly(body: string): boolean {
  return /^\[(图片|视频|文件|语音)\]$/.test(body.trim());
}

/**
 * Process one inbound message.
 *
 * Never throws: a failure is reported back to the user when possible, and
 * logged otherwise, because the caller is a long-poll loop that must survive
 * any single bad message.
 */
export async function handleInboundMessage(
  msg: WeixinMessage,
  deps: HandleMessageDeps,
): Promise<void> {
  const peerId = msg.from_user_id ?? "";
  if (peerId === "") {
    logger.warn("inbound: message without from_user_id, dropped");
    return;
  }

  const platformMessageId = getWeixinMessageId(msg);
  if (platformMessageId !== undefined && !rememberMessageId(platformMessageId)) {
    logger.debug(`inbound: duplicate message_id=${platformMessageId}, skipped`);
    return;
  }

  const allowed = deps.allowFrom();
  if (allowed.length > 0 && !allowed.includes(peerId)) {
    logger.info(`inbound: dropped message from unauthorized peer=${peerId}`);
    return;
  }
  if (allowed.length === 0) {
    logger.warn(
      "inbound: allowFrom is empty and the account has no recorded owner — any sender can reach the agent. Set `allowFrom` in the plugin config to restrict this.",
    );
  }

  const contextToken = msg.context_token;
  if (contextToken !== undefined && contextToken !== "") {
    setContextToken(deps.accountId, peerId, contextToken);
  }

  const mediaItem = findMediaItem(msg);
  const mediaOptions =
    mediaItem === undefined
      ? {}
      : await downloadMediaFromItem(mediaItem, {
          cdnBaseUrl: deps.cdnBaseUrl,
          saveMedia,
          log: (line) => logger.info(line),
          errLog: (line) => logger.warn(line),
          label: "inbound",
        });

  const context = weixinMessageToMsgContext(msg, deps.accountId, mediaOptions);
  resolveStoredQuoteContext(context, msg, deps.accountId);

  const binding = deps.store.resolve(deps.accountId, peerId);
  const startedAt = deps.startedAt;

  // Channel-level commands never reach the model.
  const body = textBody(msg);
  if (body.trim() !== "" && isChannelCommand(body)) {
    await handleChannelCommand(body, {
      config: deps.config,
      accountId: deps.accountId,
      peerId,
      binding,
      sender: deps.sender,
      sessions: deps.sessions,
      store: deps.store,
      ...(contextToken === undefined ? {} : { contextToken }),
      startedAt,
    });
    return;
  }

  await cacheInboundBody(msg, context, deps.accountId, peerId);

  const userText = composeUserText(context);
  if (userText === "") {
    await deps.sender.sendText(peerId, "（收到一条空消息）", {
      ...(contextToken === undefined ? {} : { contextToken }),
    });
    return;
  }

  // Keep the transcript for the mini program before the turn runs, so a crash in
  // the agent does not swallow what the user said.
  try {
    deps.record?.(deps.accountId, peerId, "user", userText);
  } catch {
    // A transcript problem must never drop a message.
  }

  const cachedConfig = await deps.configManager.getForUser(peerId, contextToken);
  const indicator =
    deps.config.typing && cachedConfig.typingTicket !== ""
      ? deps.sender.createTypingIndicator(peerId, cachedConfig.typingTicket)
      : undefined;
  indicator?.start();

  const runId = randomUUID();
  try {
    const outcome = await deps.sessions.runTurn({
      binding,
      content: [{ type: "text", text: userText }],
      source: {
        kind: "user",
        channel: "weixin",
        accountId: deps.accountId,
        peerId,
        ...(platformMessageId === undefined ? {} : { messageId: platformMessageId }),
      },
    });

    const deliveries = buildDeliveries(outcome.texts, {
      markdown: deps.config.markdown,
      textChunkLimit: deps.config.textChunkLimit,
      workspace: deps.config.workspace,
    });

    if (deliveries.length === 0) {
      await deps.sender.sendText(
        peerId,
        describeEmptyTurn(outcome.kind, outcome.error),
        { ...(contextToken === undefined ? {} : { contextToken }), runId },
      );
      return;
    }

    for (const delivery of deliveries) {
      await deps.sender.sendDelivery(peerId, delivery, {
        ...(contextToken === undefined ? {} : { contextToken }),
        runId,
      });
    }

    logger.info(
      `inbound: replied to=${peerId} turn=${outcome.kind ?? "unknown"} texts=${outcome.texts.length} deliveries=${deliveries.length} in ${outcome.durationMs}ms`,
    );
  } catch (err) {
    logger.error(`inbound: turn failed for peer=${peerId}: ${String(err)}`);
    await deps.sender
      .sendText(peerId, `⚠️ 处理这条消息时出错：${err instanceof Error ? err.message : String(err)}`, {
        ...(contextToken === undefined ? {} : { contextToken }),
        runId,
      })
      .catch(() => undefined);
  } finally {
    await indicator?.stop();
  }
}

/** Remember the inbound body so an ID-only quote can resolve it later. */
async function cacheInboundBody(
  msg: WeixinMessage,
  context: WeixinMsgContext,
  accountId: string,
  peerId: string,
): Promise<void> {
  const store = getQuoteStore();
  const messageId = getWeixinMessageId(msg);
  if (store === undefined || messageId === undefined) return;
  try {
    await store.put({
      accountId,
      conversationId: peerId,
      messageId,
      direction: "inbound",
      body: context.Body,
      createdAt: msg.create_time_ms ?? Date.now(),
    });
  } catch (err) {
    logger.warn(`quote-cache: failed to save inbound id=${messageId}: ${String(err)}`);
  }
}
