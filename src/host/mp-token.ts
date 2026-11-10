import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { resolveWeixinStateDir } from "../protocol/storage/state-dir.js";
import { logger } from "../protocol/util/logger.js";

/**
 * Bearer token for the mini-program API.
 *
 * A phone cannot reach the loopback address the DSH UI listens on, and the
 * same-origin fence cannot help a native client, so the only gate on that API is
 * a shared secret. It is generated once (32 bytes, base64url), stored beside the
 * credentials with a 0600 mode, and never logged in full.
 *
 * The token is *not* a session credential: it grants exactly the five
 * mini-program routes, which browse directories, read the workspace and start a
 * WeChat conversation. Turning `mpApi.enabled` off makes those routes 404.
 */

/** Where the token lives. */
function tokenPath(): string {
  return path.join(resolveWeixinStateDir(), "mp-token.txt");
}

/** Mask a token for logs and the UI: first 4 and last 2 characters. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-2)}`;
}

/** Constant-time comparison, so a wrong token cannot be probed by timing. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided === "") return false;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
}

/** Read the stored token, if one was ever generated. */
function readToken(): string | undefined {
  try {
    const value = fs.readFileSync(tokenPath(), "utf-8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the API token for this process.
 *
 * @param configured - a token pinned in the plugin config, which wins.
 * @returns the token to compare against, or undefined when it cannot be
 *   resolved (the caller must then keep the API closed).
 */
export function resolveApiToken(configured: string | undefined): string | undefined {
  const pinned = configured?.trim();
  if (pinned !== undefined && pinned !== "") return pinned;

  const existing = readToken();
  if (existing !== undefined) return existing;

  const generated = randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
    fs.writeFileSync(tokenPath(), `${generated}\n`, "utf-8");
    try {
      fs.chmodSync(tokenPath(), 0o600);
    } catch {
      // Windows ignores POSIX modes; the directory is under the user's home.
    }
    logger.info(`mp-api: generated an API token (${maskToken(generated)}) at ${tokenPath()}`);
    return generated;
  } catch (err) {
    logger.error(`mp-api: cannot persist a token, the mini-program API stays closed: ${String(err)}`);
    return undefined;
  }
}

/** Read the token without generating one (for the same-origin tab). */
export function peekApiToken(configured: string | undefined): string | undefined {
  const pinned = configured?.trim();
  if (pinned !== undefined && pinned !== "") return pinned;
  return readToken();
}
