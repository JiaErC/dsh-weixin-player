import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveMediaDir } from "../storage/state-dir.js";
import { getExtensionFromMime } from "./mime.js";
import { logger } from "../util/logger.js";

/**
 * Local media store for inbound attachments.
 *
 * Upstream hands this job to the host framework's media service. DSH has an
 * attachment service too, but its ids are opaque and it is built for images the
 * model reads — not for arbitrary files an agent may want to open with a path.
 * Writing decrypted media under `<DSH_HOME>/weixin/media/<bucket>` keeps a real
 * filesystem path available for the agent's file tools, which is what the
 * channel's inbound pipeline needs.
 */

/** Signature `downloadMediaFromItem` expects for persisting decrypted bytes. */
export type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

/** Keep at most this many files per bucket before the oldest are pruned. */
const MAX_FILES_PER_BUCKET = 200;

/** Prefix that makes generated names sortable and greppable. */
const FILE_PREFIX = "wx";

function sanitizeSubdir(subdir: string | undefined): string {
  if (subdir === undefined) return "inbound";
  const cleaned = subdir
    .split(/[\\/]+/)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+$/, ""))
    .filter((part) => part !== "" && part !== "..")
    .join(path.sep);
  return cleaned === "" ? "inbound" : cleaned;
}

/** Files in one bucket, newest first. */
function listBucket(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .map((name) => {
        const full = path.join(dir, name);
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is { full: string; mtime: number } => entry !== undefined)
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.full);
  } catch {
    return [];
  }
}

/** Drop everything past {@link MAX_FILES_PER_BUCKET} in one bucket. */
function pruneBucket(dir: string): void {
  const files = listBucket(dir);
  for (const file of files.slice(MAX_FILES_PER_BUCKET)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

/**
 * Build a {@link SaveMediaFn} rooted at the channel's media directory.
 *
 * @param options.rootDir - override of the bucket root (tests).
 */
export function createLocalMediaSaver(options?: { rootDir?: string }): SaveMediaFn {
  return async (buffer, contentType, subdir, maxBytes, originalFilename) => {
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
      throw new Error(
        `media exceeds the ${maxBytes} byte limit (got ${buffer.byteLength} bytes)`,
      );
    }

    const bucket = sanitizeSubdir(subdir);
    const dir = options?.rootDir === undefined
      ? resolveMediaDir(bucket)
      : path.join(options.rootDir, bucket);
    fs.mkdirSync(dir, { recursive: true });

    const extension = originalFilename
      ? path.extname(originalFilename).toLowerCase() || getExtensionFromMime(contentType ?? "")
      : getExtensionFromMime(contentType ?? "");

    const name = `${FILE_PREFIX}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${extension}`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, buffer);
    logger.debug(`media-store: saved ${buffer.byteLength} bytes to ${filePath}`);
    pruneBucket(dir);
    return { path: filePath };
  };
}
