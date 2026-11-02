import fs from "node:fs";
import path from "node:path";

import { resolveAccountsDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

/**
 * Local message-content cache for Weixin quotes.
 *
 * WeChat sends a quoted message as an ID plus (sometimes) a title, and newer
 * clients omit the quoted body entirely. Without a local cache the agent sees a
 * bare `[引用]` with no content. This store keeps recent message bodies per
 * account so an ID-only quote can still be resolved to text.
 *
 * Scope of this build: **text only**. Media quoted from an earlier message is
 * reported as expired rather than re-uploaded, which keeps the store small and
 * avoids a second media-retention policy inside the channel.
 */

/** One cached message body. */
export interface QuoteRecord {
  accountId: string;
  conversationId: string;
  messageId: string;
  direction: "inbound" | "outbound";
  body: string;
  /** Path of the cached media copy; always absent in this build. */
  mediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
  createdAt: number;
}

/** A record as handed back to the inbound resolver. */
export interface QuoteLookup {
  body: string;
  mediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
}

/** Subset of the store the inbound pipeline depends on. */
export interface QuoteStore {
  put(record: QuoteRecord): Promise<void>;
  find(accountId: string, conversationId: string, messageId: string): QuoteLookup | undefined;
}

interface StoreFile {
  version: 1;
  /** Newest last; trimmed to `maxMessagesPerAccount`. */
  records: QuoteRecord[];
}

function storePath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.quotes.json`);
}

/**
 * Bounded, lazily-loaded, write-behind store.
 *
 * Writes are cheap (one deferred synchronous write per batch of `PUTS_PER_FLUSH`
 * puts) because inbound processing must never wait on disk.
 */
class JsonQuoteStore implements QuoteStore {
  private readonly maxMessages: number;
  private readonly loaded = new Map<string, Map<string, QuoteRecord>>();
  private readonly dirty = new Set<string>();

  constructor(options: { maxMessagesPerAccount: number }) {
    this.maxMessages = Math.max(1, Math.floor(options.maxMessagesPerAccount));
  }

  private key(conversationId: string, messageId: string): string {
    return `${conversationId}\u0000${messageId}`;
  }

  private load(accountId: string): Map<string, QuoteRecord> {
    const cached = this.loaded.get(accountId);
    if (cached) return cached;

    const records = new Map<string, QuoteRecord>();
    try {
      const raw = fs.readFileSync(storePath(accountId), "utf-8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version === 1 && Array.isArray(parsed.records)) {
        for (const record of parsed.records) {
          if (typeof record?.messageId !== "string") continue;
          records.set(this.key(record.conversationId, record.messageId), record);
        }
      }
      logger.debug(`quote-store: loaded ${records.size} records for ${accountId}`);
    } catch {
      // Missing or malformed file: start from an empty cache.
    }
    this.loaded.set(accountId, records);
    return records;
  }

  private flush(accountId: string): void {
    if (!this.dirty.delete(accountId)) return;
    const records = this.load(accountId);
    const payload: StoreFile = { version: 1, records: [...records.values()] };
    try {
      fs.mkdirSync(resolveAccountsDir(), { recursive: true });
      fs.writeFileSync(storePath(accountId), JSON.stringify(payload), "utf-8");
    } catch (err) {
      logger.warn(`quote-store: failed to persist ${accountId}: ${String(err)}`);
    }
  }

  async put(record: QuoteRecord): Promise<void> {
    const records = this.load(record.accountId);
    const key = this.key(record.conversationId, record.messageId);
    // Re-inserting keeps insertion order fresh for the trim below.
    records.delete(key);
    records.set(key, record);

    while (records.size > this.maxMessages) {
      const oldest = records.keys().next();
      if (oldest.done === true) break;
      records.delete(oldest.value);
    }

    this.dirty.add(record.accountId);
    // Coalesce bursts of writes into one file write per turn.
    queueMicrotask(() => this.flush(record.accountId));
  }

  find(accountId: string, conversationId: string, messageId: string): QuoteLookup | undefined {
    const record = this.load(accountId).get(this.key(conversationId, messageId));
    if (!record) return undefined;
    return {
      body: record.body,
      ...(record.mediaPath !== undefined ? { mediaPath: record.mediaPath } : {}),
      ...(record.mediaMime !== undefined ? { mediaMime: record.mediaMime } : {}),
      ...(record.mediaName !== undefined ? { mediaName: record.mediaName } : {}),
    };
  }

  /** Drop every cached record for an account, memory and disk. */
  clearAccount(accountId: string): void {
    this.loaded.delete(accountId);
    this.dirty.delete(accountId);
    try {
      fs.unlinkSync(storePath(accountId));
    } catch {
      // ignore if not found
    }
  }
}

let store: QuoteStore | undefined;

/**
 * Initialise the process-wide store.
 *
 * @param options.maxMessagesPerAccount - recent messages kept per account.
 * @returns the store, for callers that want to bypass the global lookup.
 */
export function initializeQuoteStore(options: { maxMessagesPerAccount: number }): QuoteStore {
  store = new JsonQuoteStore(options);
  return store;
}

/** The active store, or undefined before {@link initializeQuoteStore} runs. */
export function getQuoteStore(): QuoteStore | undefined {
  return store;
}

/** Forget an account's cache (account removal / stale-account pruning). */
export function deleteQuoteCacheForAccount(accountId: string): void {
  if (store instanceof JsonQuoteStore) store.clearAccount(accountId);
}
