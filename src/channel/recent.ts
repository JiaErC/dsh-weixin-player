import fs from "node:fs";
import path from "node:path";

import { resolveWeixinStateDir } from "../protocol/storage/state-dir.js";
import { logger } from "../protocol/util/logger.js";

/**
 * A short, bounded transcript of what went over each WeChat conversation.
 *
 * The mini program wants to show "what did we just talk about". Reading DSH's own
 * session log would be the richer source, but that is the agent's record with its
 * own event model; this store keeps exactly what crossed the channel — each
 * inbound user message and each reply the channel sent — so the app can never see
 * anything the WeChat side did not.
 *
 * Bounded on purpose: 40 messages per conversation, 50 conversations, 2000
 * characters per message. It is a preview, not an archive.
 */

/** One recorded line. */
export interface RecentMessage {
  accountId: string;
  peerId: string;
  role: "user" | "assistant";
  text: string;
  /** Epoch ms. */
  at: number;
}

/** Limits, exported so tests and docs agree with the code. */
export const RECENT_LIMITS = {
  perPeer: 40,
  peers: 50,
  chars: 2000,
} as const;

interface RecentFile {
  version: 1;
  conversations: Array<{ key: string; messages: RecentMessage[] }>;
}

function storePath(): string {
  return path.join(resolveWeixinStateDir(), "recent.json");
}

function conversationKey(accountId: string, peerId: string): string {
  return `${accountId}\u0000${peerId}`;
}

/** In-memory ring buffer per conversation, mirrored to disk on changes. */
export class RecentMessageStore {
  private readonly conversations = new Map<string, RecentMessage[]>();
  private loaded = false;
  /** Coalesce rapid writes: one timer, flushed on close. */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(storePath(), "utf-8");
      const parsed = JSON.parse(raw) as RecentFile;
      if (parsed.version !== 1) return;
      for (const entry of parsed.conversations) {
        if (!Array.isArray(entry.messages)) continue;
        this.conversations.set(entry.key, entry.messages.slice(-RECENT_LIMITS.perPeer));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`recent: could not read ${storePath()}: ${String(error)}`);
      }
    }
  }

  /**
   * Append one message.
   *
   * @param role - who spoke.
   * @param text - message body; truncated to the preview limit.
   */
  record(accountId: string, peerId: string, role: RecentMessage["role"], text: string): void {
    const body = text.trim();
    if (body === "") return;
    this.load();

    const key = conversationKey(accountId, peerId);
    const messages = this.conversations.get(key) ?? [];
    messages.push({
      accountId,
      peerId,
      role,
      text: body.length > RECENT_LIMITS.chars ? `${body.slice(0, RECENT_LIMITS.chars)}…` : body,
      at: Date.now(),
    });
    if (messages.length > RECENT_LIMITS.perPeer) {
      messages.splice(0, messages.length - RECENT_LIMITS.perPeer);
    }
    // Re-inserting keeps Map order as "least recently written first".
    this.conversations.delete(key);
    this.conversations.set(key, messages);

    while (this.conversations.size > RECENT_LIMITS.peers) {
      const oldest = this.conversations.keys().next();
      if (oldest.done === true) break;
      this.conversations.delete(oldest.value);
    }
    this.schedulePersist();
  }

  /**
   * Read one conversation, oldest first.
   *
   * @param limit - how many of the newest messages to return.
   */
  list(accountId: string, peerId: string, limit = 20): RecentMessage[] {
    this.load();
    const messages = this.conversations.get(conversationKey(accountId, peerId)) ?? [];
    const wanted = Math.max(1, Math.min(limit, RECENT_LIMITS.perPeer));
    return messages.slice(-wanted);
  }

  /** Forget one conversation. */
  forget(accountId: string, peerId: string): void {
    this.load();
    if (this.conversations.delete(conversationKey(accountId, peerId))) this.schedulePersist();
  }

  /** Write the file now and stop the timer. */
  close(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.persist();
  }

  private schedulePersist(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.persist();
    }, 1000);
    this.flushTimer.unref?.();
  }

  private persist(): void {
    const payload: RecentFile = {
      version: 1,
      conversations: [...this.conversations.entries()].map(([key, messages]) => ({ key, messages })),
    };
    try {
      fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
      fs.writeFileSync(storePath(), JSON.stringify(payload), "utf-8");
    } catch (error) {
      logger.warn(`recent: could not persist: ${String(error)}`);
    }
  }
}
