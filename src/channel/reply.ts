import path from "node:path";

import { StreamingMarkdownFilter } from "../protocol/messaging/markdown-filter.js";

/**
 * Turning an agent's turn output into WeChat messages.
 *
 * Three things differ from a normal chat surface:
 *  - WeChat renders only a subset of Markdown, so the channel runs the upstream
 *    streaming filter, which drops images and CJK italic markers and keeps code
 *    fences and tables.
 *  - A long answer must be split: `sendMessage` rejects oversized bodies, and a
 *    wall of text is unreadable on a phone.
 *  - Files are sent through a `MEDIA:<path>` directive the agent writes on its
 *    own line, so a reply can carry an attachment.
 */

/** One outbound delivery: text plus an optional local file to upload. */
export interface OutboundDelivery {
  text: string;
  /** Absolute path of a local file to send as image/video/file. */
  mediaPath?: string;
}

/** `MEDIA:<path>` on its own line is how an agent sends a file. */
const MEDIA_DIRECTIVE = /^\s*MEDIA:\s*(.+?)\s*$/;

/**
 * Split a reply into its text and its file directives.
 *
 * The directive is lifted out of the text so the user never sees the marker.
 * Relative paths are resolved against the agent's workspace; anything that does
 * not resolve to an existing file is reported back as text instead of being
 * silently dropped.
 */
export function extractMediaDirectives(
  text: string,
  workspace: string,
): { text: string; mediaPaths: string[]; missing: string[] } {
  const kept: string[] = [];
  const mediaPaths: string[] = [];
  const missing: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = MEDIA_DIRECTIVE.exec(line);
    if (match === null) {
      kept.push(line);
      continue;
    }
    const raw = match[1]?.trim() ?? "";
    if (raw === "") continue;
    const resolved = raw.startsWith("file://")
      ? new URL(raw).pathname
      : path.isAbsolute(raw)
        ? raw
        : path.resolve(workspace, raw);
    mediaPaths.push(resolved);
  }

  return {
    text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    mediaPaths,
    missing,
  };
}

/**
 * Split text into chunks WeChat accepts.
 *
 * Cuts on a paragraph break when one is available in the last third of the
 * window so messages never end mid-sentence unless the text has no breaks.
 */
export function chunkText(text: string, limit: number): string[] {
  if (limit < 1) return [text];
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const minBreak = Math.floor(limit * 0.6);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const cut =
      paragraph > minBreak
        ? paragraph
        : line > minBreak
          ? line
          : space > minBreak
            ? space
            : limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }

  if (remaining !== "") chunks.push(remaining);
  return chunks.filter((chunk) => chunk !== "");
}

/** Options for {@link buildDeliveries}. */
export interface BuildDeliveriesOptions {
  /** Run the WeChat Markdown sanitiser (drops constructs WeChat cannot render). */
  markdown: boolean;
  /** Max characters per text message. */
  textChunkLimit: number;
  /** Agent workspace, used to resolve relative MEDIA paths. */
  workspace: string;
}

/**
 * Convert one turn's assistant texts into the deliveries to send.
 *
 * @param texts - assistant text blocks in the order the model produced them.
 * @param options - formatting limits.
 * @returns ordered deliveries; media only ever rides on the last chunk so the
 *   caption stays next to its file.
 */
export function buildDeliveries(
  texts: readonly string[],
  options: BuildDeliveriesOptions,
): OutboundDelivery[] {
  const joined = texts
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n\n");

  if (joined === "") return [];

  const filtered = options.markdown
    ? (() => {
        const filter = new StreamingMarkdownFilter();
        return `${filter.feed(joined)}${filter.flush()}`;
      })()
    : joined;

  const { text, mediaPaths } = extractMediaDirectives(filtered, options.workspace);
  const chunks = text === "" ? [] : chunkText(text, options.textChunkLimit);

  if (mediaPaths.length === 0) {
    return chunks.map((chunk) => ({ text: chunk }));
  }

  const [first, ...rest] = mediaPaths;
  if (chunks.length === 0) {
    return mediaPaths.map((mediaPath) => ({ text: "", mediaPath }));
  }

  // Caption the first file with the leading text, then send any further files
  // without text so a multi-file answer stays readable on a phone.
  const deliveries: OutboundDelivery[] = chunks.map((chunk, index) => {
    if (index === chunks.length - 1 && first !== undefined) {
      return { text: chunk, mediaPath: first };
    }
    return { text: chunk };
  });

  for (const mediaPath of rest) deliveries.push({ text: "", mediaPath });
  return deliveries;
}

/** Human-readable line describing why a turn produced no text. */
export function describeEmptyTurn(kind: string | undefined, error: string | undefined): string {
  switch (kind) {
    case "error":
      return `⚠️ 模型调用失败：${error ?? "未知错误"}`;
    case "aborted":
      return "⚠️ 本轮已中止。";
    case "max-tokens":
      return "⚠️ 回复超出模型输出上限，已截断。";
    case "blocked":
      return "⚠️ 本轮被拦截，没有可发送的内容。";
    default:
      return error === undefined
        ? "（本轮没有文本回复）"
        : `⚠️ 本轮结束：${error}`;
  }
}
