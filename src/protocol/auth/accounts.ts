import fs from "node:fs";
import path from "node:path";

import { resolveAccountsDir, resolveStateDir, resolveWeixinStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ---------------------------------------------------------------------------
// Account ID normalisation
// ---------------------------------------------------------------------------

/**
 * Turn a raw iLink bot id into a filesystem-safe key.
 *
 * iLink hands out ids such as `b0f5860fdecb@im.bot` / `abcd@im.wechat`. Those
 * contain `@` and `.`, which are awkward in file names and logs, so every
 * non `[a-z0-9-]` run collapses to a single `-`:
 *
 *   "b0f5860fdecb@im.bot"  -> "b0f5860fdecb-im-bot"
 *   "abcd@im.wechat"       -> "abcd-im-wechat"
 */
export function normalizeWeixinAccountId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "default";
}

/**
 * Pattern-based reverse of {@link normalizeWeixinAccountId} for the two id
 * suffixes iLink actually issues.
 *
 * Only used as a compatibility fallback when account files were written under
 * an older raw id.
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveAccountIndexPath(): string {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}

/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/** Add accountId to the persistent index (no-op if already present). */
export function registerWeixinAccountId(accountId: string): void {
  fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });

  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(accountId)) return;

  fs.writeFileSync(
    resolveAccountIndexPath(),
    JSON.stringify([...existing, accountId], null, 2),
    "utf-8",
  );
}

/** Remove accountId from the persistent index. */
export function unregisterWeixinAccountId(accountId: string): void {
  const existing = listIndexedWeixinAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Credential change notifications
// ---------------------------------------------------------------------------

type AccountsChangedListener = () => void;
const accountsChangedListeners = new Set<AccountsChangedListener>();

/**
 * Subscribe to "the set of usable accounts changed" (a login finished, a stale
 * duplicate was pruned, an account was removed).
 *
 * The channel plugin uses this to start or stop per-account monitors without
 * the protocol layer having to know anything about DSH.
 */
export function onAccountsChanged(listener: AccountsChangedListener): () => void {
  accountsChangedListeners.add(listener);
  return () => {
    accountsChangedListeners.delete(listener);
  };
}

/** Notify listeners that the account set changed. */
export function notifyAccountSetChanged(): void {
  for (const listener of accountsChangedListeners) {
    try {
      listener();
    } catch (err) {
      logger.warn(`onAccountsChanged listener failed: ${String(err)}`);
    }
  }
}

/**
 * Remove stale accounts that share the same userId as the newly-bound account.
 * Called after a successful QR login so only the latest account remains for a
 * given WeChat user, which keeps contextToken matching unambiguous.
 *
 * @param onClearContextTokens callback to clear context tokens for the removed account
 */
export function clearStaleAccountsForUserId(
  currentAccountId: string,
  userId: string,
  onClearContextTokens?: (accountId: string) => void,
): void {
  if (!userId) return;
  for (const id of listIndexedWeixinAccountIds()) {
    if (id === currentAccountId) continue;
    if (loadWeixinAccount(id)?.userId?.trim() !== userId) continue;
    logger.info(
      `clearStaleAccountsForUserId: removing stale account=${id} (same userId=${userId})`,
    );
    onClearContextTokens?.(id);
    clearWeixinAccount(id);
    unregisterWeixinAccountId(id);
  }
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

/** Unified per-account data: token + baseUrl in one file. */
export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

/**
 * Legacy single-file token: `<state>/credentials/dsh-weixin/credentials.json`.
 * Only read; nothing writes this location any more.
 */
function loadLegacyToken(): string | undefined {
  const legacyPath = path.join(resolveStateDir(), "credentials", "dsh-weixin", "credentials.json");
  try {
    if (!fs.existsSync(legacyPath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(legacyPath, "utf-8")) as { token?: string };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore unreadable / malformed files
  }
  return null;
}

/** Load account data by ID, with compatibility fallbacks. */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;

  // Compatibility: if the given ID is normalized, derive the older raw filename.
  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readAccountFile(resolveAccountPath(rawId));
    if (compat) return compat;
  }

  const token = loadLegacyToken();
  if (token) return { token };

  return null;
}

/**
 * Persist account data after QR login (merges into the existing file).
 *
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolution falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted when cleared to empty.
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  fs.mkdirSync(resolveAccountsDir(), { recursive: true });

  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort: Windows and some filesystems ignore POSIX modes
  }
}

/**
 * Remove every file associated with an account:
 *   - `accounts/{accountId}.json`                 (credentials)
 *   - `accounts/{accountId}.sync.json`            (getUpdates sync buf)
 *   - `accounts/{accountId}.context-tokens.json`  (context tokens)
 */
export function clearWeixinAccount(accountId: string): void {
  for (const file of [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
  ]) {
    try {
      fs.unlinkSync(path.join(resolveAccountsDir(), file));
    } catch {
      // ignore if not found
    }
  }
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/** Per-account knobs the plugin configuration can supply. */
export type WeixinAccountSettings = {
  name?: string;
  enabled?: boolean;
  cdnBaseUrl?: string;
};

/** A resolved account: stored credentials merged with configured knobs. */
export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  enabled: boolean;
  /** true when a token has been obtained via QR login. */
  configured: boolean;
  name?: string;
};

/** List accountIds from the index file (written at QR login). */
export function listWeixinAccountIds(): string[] {
  return listIndexedWeixinAccountIds();
}

/** Resolve a weixin account by ID, merging configuration and stored credentials. */
export function resolveWeixinAccount(
  settings: WeixinAccountSettings | undefined,
  accountId: string,
): ResolvedWeixinAccount {
  const id = normalizeWeixinAccountId(accountId);
  const accountData = loadWeixinAccount(id);
  const token = accountData?.token?.trim() || undefined;
  const stateBaseUrl = accountData?.baseUrl?.trim() || "";

  return {
    accountId: id,
    baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: settings?.cdnBaseUrl?.trim() || CDN_BASE_URL,
    token,
    enabled: settings?.enabled !== false,
    configured: Boolean(token),
    name: settings?.name?.trim() || undefined,
  };
}
