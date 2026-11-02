import os from "node:os";
import path from "node:path";

/**
 * Resolve the DSH home directory.
 *
 * The harness exports `DSH_HOME` for every process it launches, so a running
 * plugin normally reads it from the environment. The `~/.dsh` fallback keeps
 * unit tests and out-of-harness tooling working without that variable.
 */
export function resolveStateDir(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".dsh");
}

/**
 * Root of everything this channel persists: credentials, sync buffers, media
 * cache and the peer → session map.
 *
 * Kept separate from the harness's own `sessions/` tree so a DSH upgrade or a
 * session-log migration can never touch channel credentials.
 */
export function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "weixin");
}

/** Per-account credential directory (`<state>/weixin/accounts`). */
export function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

/** Directory holding downloaded/decrypted inbound and outbound media. */
export function resolveMediaDir(...segments: string[]): string {
  return path.join(resolveWeixinStateDir(), "media", ...segments);
}
