import type { WeixinChannelRuntime } from "../channel/runtime.js";
import type { ToolDefinitionLike, ToolRunContextLike } from "../dsh/services.js";
import { logger } from "../protocol/util/logger.js";

/**
 * Agent-facing tools for the channel.
 *
 * A tool registered on the host context is part of the global tool layer, so
 * every agent in the deployment sees it — including sessions that have nothing
 * to do with WeChat. Each tool therefore refuses politely when the calling
 * session is not bound to a WeChat conversation, rather than sending a message
 * on someone else's behalf.
 */

/** JSON Schema used by a tool argument that must be a string. */
function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

/** Wrap a one-line result the model reads. */
function textResult(text: string): unknown[] {
  return [{ type: "text", text }];
}

/** Find the WeChat conversation bound to a session id. */
function bindingFor(runtime: WeixinChannelRuntime, sessionId: string) {
  return runtime.store.list().find((binding) => binding.sessionId === sessionId);
}

/**
 * Build the tool definitions this plugin registers.
 *
 * @param runtime - the live channel, used to resolve senders and bindings.
 */
export function buildWeixinTools(runtime: WeixinChannelRuntime): ToolDefinitionLike[] {
  return [
    {
      name: "weixin_send",
      description:
        "Send a message to the current WeChat conversation, or to another WeChat user of the same bot account. "
        + "Use it to deliver a file (image, video or document) or to push an update while a long task runs. "
        + "Inside a WeChat conversation the recipient is inferred; elsewhere pass `to`.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: stringSchema("Message text. Markdown is converted to WeChat-friendly plain text."),
          filePath: stringSchema(
            "Absolute path of a local file to upload. Relative paths resolve against the session working directory.",
          ),
          to: stringSchema(
            "Recipient Weixin id (xxx@im.wechat). Omit to reply to the conversation this session is bound to.",
          ),
          accountId: stringSchema("Bot account id. Omit unless the deployment runs several bot accounts."),
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            to: { type: "string" },
            accountId: { type: "string" },
            messages: { type: "integer" },
          },
          required: ["ok", "to", "accountId", "messages"],
        },
        render: (_args, value) => {
          const result = value as { ok: boolean; to: string; accountId: string; messages: number };
          return textResult(
            result.ok
              ? `Sent ${result.messages} message(s) to ${result.to} as ${result.accountId}`
              : `Could not send to ${result.to}`,
          );
        },
      },
      async execute(args, exec) {
        const input = args as {
          text?: string;
          filePath?: string;
          to?: string;
          accountId?: string;
        };
        return await sendFromTool(runtime, input, exec);
      },
    },

    {
      name: "weixin_login",
      description:
        "Start (or restart) the WeChat login handshake for this DSH deployment and return the QR code link. "
        + "Show the URL to the user and tell them to open the DSH WeChat page to scan it. "
        + "Use `weixin_status` to check whether the account connected afterwards.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          force: { type: "boolean", description: "Discard a QR code that is already showing and fetch a new one." },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string" },
            message: { type: "string" },
            qrcodeUrl: { type: "string" },
            pagePath: { type: "string" },
          },
          required: ["status", "message", "pagePath"],
        },
        render: (_args, value) => {
          const result = value as { status: string; message: string; qrcodeUrl?: string; pagePath: string };
          return textResult(
            [
              `login status: ${result.status}`,
              result.message,
              result.qrcodeUrl === undefined ? "" : `QR content: ${result.qrcodeUrl}`,
              `Scan it from ${result.pagePath}`,
            ]
              .filter((line) => line !== "")
              .join("\n"),
          );
        },
      },
      async execute(args) {
        const input = args as { force?: boolean };
        const snapshot = await runtime.qr.start(input.force === true ? { force: true } : {});
        return {
          status: snapshot.status,
          message: snapshot.message,
          ...(snapshot.qrcodeUrl === undefined ? {} : { qrcodeUrl: snapshot.qrcodeUrl }),
          pagePath: "/dsh-weixin",
        };
      },
    },

    {
      name: "weixin_status",
      description:
        "Report the WeChat channel state: logged-in accounts, whether each monitor is running, recent inbound counts, "
        + "the peer→session bindings, and where the channel log lives.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
          },
          required: ["summary"],
        },
        render: (_args, value) => textResult((value as { summary: string }).summary),
      },
      async execute() {
        const snapshot = runtime.snapshot();
        const lines: string[] = [];
        lines.push(`workspace: ${snapshot.workspace}`);
        lines.push(`agent preset: ${snapshot.agentPreset ?? "deployment default"}`);
        lines.push(`allowFrom: ${snapshot.allowFrom.length === 0 ? "account owner" : snapshot.allowFrom.join(", ")}`);
        lines.push(`log: ${snapshot.logFile}`);
        if (snapshot.accounts.length === 0) {
          lines.push("accounts: none (not logged in yet)");
        }
        for (const account of snapshot.accounts) {
          lines.push(
            `account ${account.accountId}: ${account.running ? "running" : account.configured ? "stopped" : "not logged in"}`
              + `, inbound=${account.inboundCount}`
              + (account.lastInboundAt === undefined ? "" : `, lastInbound=${new Date(account.lastInboundAt).toISOString()}`)
              + (account.lastError === undefined ? "" : `, lastError=${account.lastError}`),
          );
        }
        for (const peer of snapshot.peers.slice(0, 10)) {
          lines.push(`peer ${peer.peerId} -> ${peer.sessionId}`);
        }
        return { summary: lines.join("\n") };
      },
    },
  ];
}

/**
 * Execute `weixin_send`.
 *
 * Resolves the account and recipient, then reuses the same delivery path the
 * reply pipeline uses so formatting and media rules stay identical.
 */
async function sendFromTool(
  runtime: WeixinChannelRuntime,
  input: { text?: string; filePath?: string; to?: string; accountId?: string },
  exec: ToolRunContextLike,
): Promise<{ ok: boolean; to: string; accountId: string; messages: number }> {
  const sessionId = exec.agent?.session.id;
  const bound = sessionId === undefined ? undefined : bindingFor(runtime, sessionId);

  const accountId = input.accountId?.trim() || bound?.accountId || runtime.runningAccountIds()[0];
  if (accountId === undefined) {
    throw new Error(
      "weixin_send: no WeChat account is running. Log in first (see the /dsh-weixin page) and retry.",
    );
  }

  const sender = runtime.senderFor(accountId);
  if (sender === undefined) {
    throw new Error(`weixin_send: account ${accountId} is not running`);
  }

  const to = input.to?.trim() || bound?.peerId;
  if (to === undefined || to === "") {
    throw new Error(
      "weixin_send: this session is not bound to a WeChat conversation, so `to` is required",
    );
  }

  const text = input.text ?? "";
  const filePath = input.filePath?.trim();
  if (text.trim() === "" && (filePath === undefined || filePath === "")) {
    throw new Error("weixin_send: pass `text`, `filePath`, or both");
  }

  // A file with a caption is one upload; text alone is one message.
  if (filePath !== undefined && filePath !== "") {
    await sender.sendFile(to, filePath, text);
  } else {
    await sender.sendText(to, text);
  }

  logger.info(
    `tool: weixin_send to=${to} account=${accountId} file=${filePath ?? "none"} textLen=${text.length}`,
  );
  return { ok: true, to, accountId, messages: 1 };
}
