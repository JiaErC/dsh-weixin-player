import type { WeixinChannelConfig } from "../config.js";
import { logger } from "../protocol/util/logger.js";
import type { AccountSender } from "./outbound.js";
import type { AgentSessionManager, PeerBinding, PeerSessionStore } from "./peer-session.js";

/**
 * Slash commands typed straight into WeChat.
 *
 * These run in the channel, before the agent sees anything: they are about the
 * channel's own lifecycle (which session am I talking to? start over, stop the
 * turn). Everything else is the agent's business.
 */

/** Everything a channel command may touch. */
export interface ChannelCommandContext {
  config: WeixinChannelConfig;
  accountId: string;
  peerId: string;
  binding: PeerBinding;
  sender: AccountSender;
  sessions: AgentSessionManager;
  store: PeerSessionStore;
  contextToken?: string;
  /** Epoch ms when this account's monitor started. */
  startedAt: number;
}

const HELP_TEXT = [
  "可用命令：",
  "/help — 显示这份帮助",
  "/status — 当前账号、会话与运行状态",
  "/whoami — 我的微信 ID 与会话 ID",
  "/new — 开一段全新的会话（清空上下文）",
  "/stop — 中止正在进行的一轮",
  "",
  "直接发消息就是和 agent 对话；让 agent 发文件时它会用 MEDIA:<路径> 指令。",
].join("\n");

/** Command names this channel handles (leading slash included). */
export const CHANNEL_COMMANDS = ["/help", "/status", "/whoami", "/new", "/stop"] as const;

/** True when the body is a command this channel owns. */
export function isChannelCommand(body: string): boolean {
  const head = body.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return (CHANNEL_COMMANDS as readonly string[]).includes(head);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Run one channel command.
 *
 * @returns true when the message was consumed and must not become a turn.
 */
export async function handleChannelCommand(
  body: string,
  context: ChannelCommandContext,
): Promise<boolean> {
  const [head = "", ...rest] = body.trim().split(/\s+/);
  const command = head.toLowerCase();

  switch (command) {
    case "/help": {
      await context.sender.sendText(context.peerId, HELP_TEXT, {
        ...(context.contextToken === undefined ? {} : { contextToken: context.contextToken }),
      });
      return true;
    }

    case "/whoami": {
      await context.sender.sendText(
        context.peerId,
        [
          `微信 ID：${context.peerId}`,
          `账号：${context.accountId}`,
          `会话 ID：${context.binding.sessionId}`,
        ].join("\n"),
        context.contextToken === undefined ? {} : { contextToken: context.contextToken },
      );
      return true;
    }

    case "/status": {
      const running = context.sessions.isRunning(context.binding);
      const lines = [
        `账号：${context.accountId}`,
        `模型预设：${context.config.agentPreset ?? "（部署默认）"}`,
        `工作目录：${context.config.workspace}`,
        `会话：${context.binding.sessionId}（第 ${context.binding.generation + 1} 代）`,
        `状态：${running ? "正在生成" : "空闲"}`,
        `监控已运行：${formatDuration(Date.now() - context.startedAt)}`,
      ];
      await context.sender.sendText(context.peerId, lines.join("\n"), {
        ...(context.contextToken === undefined ? {} : { contextToken: context.contextToken }),
      });
      return true;
    }

    case "/new": {
      await context.sessions.disposeBinding(context.binding);
      const binding = context.store.reset(context.accountId, context.peerId);
      context.binding = binding;
      await context.sender.sendText(
        context.peerId,
        `已开启全新会话：${binding.sessionId}\n之前的上下文不会带入。`,
        context.contextToken === undefined ? {} : { contextToken: context.contextToken },
      );
      return true;
    }

    case "/stop": {
      const cancelled = context.sessions.cancel(context.binding);
      await context.sender.sendText(
        context.peerId,
        cancelled ? "已请求中止当前这一轮。" : "当前没有正在运行的轮次。",
        context.contextToken === undefined ? {} : { contextToken: context.contextToken },
      );
      return true;
    }

    default: {
      // A message that starts with a slash but no known command: let the agent
      // decide, it may be a path (`/etc/hosts`) rather than a command.
      logger.debug(`commands: ignoring unknown command ${command} ${rest.join(" ")}`);
      return false;
    }
  }
}
