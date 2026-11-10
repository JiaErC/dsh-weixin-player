import type { IncomingMessage, ServerResponse } from "node:http";

import type { WeixinChannelRuntime } from "../channel/runtime.js";
import type { WeixinChannelConfig } from "../config.js";
import type { WebRouteLike } from "../dsh/services.js";
import { logger } from "../protocol/util/logger.js";
import { WEIXIN_MP_BASE, WEIXIN_MP_PATHS } from "../shared/wire.js";
import type {
  MpFilePayload,
  MpFsPayload,
  MpHelloPayload,
  MpMessagesPayload,
  MpNewSessionPayload,
  MpStatePayload,
  MpTokenPayload,
  MpWorkspaceRequest,
  WorkspacePayload,
} from "../shared/wire.js";
import { maskToken, tokenMatches } from "./mp-token.js";
import { isTrustedRequest } from "./trust-fence.js";

/**
 * The mini-program API.
 *
 * A phone cannot reach the loopback address the DSH UI listens on and cannot
 * satisfy a same-origin check, so these eight routes are authorized by a bearer
 * token instead. Three properties keep that honest:
 *
 *  - nothing is served unless `mpApi.enabled` is set (the routes 404 otherwise);
 *  - every route except `/mp/token` requires `Authorization: Bearer <token>`,
 *    compared in constant time;
 *  - `/mp/token` (which hands the token to the user's own tab) still runs the
 *    same-origin fence, so a page that merely runs in the same browser cannot
 *    read it.
 *
 * The API lists metadata only: directory names, file names and sizes. It never
 * reads file contents.
 */

/** Largest request body accepted; these requests carry an id or a path. */
const MAX_BODY_BYTES = 8 * 1024;

/** What the routes close over. */
export interface MpRouteDeps {
  runtime: WeixinChannelRuntime;
  config: WeixinChannelConfig;
  /** The token to compare against; undefined while the API is disabled. */
  apiToken: () => string | undefined;
  /** Non-loopback authorities this deployment serves. */
  trustedHosts: () => readonly string[];
}

function sendJson(res: ServerResponse, status: number, body: unknown, method: string): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return await new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(
          typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : undefined,
        );
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function methodOf(req: IncomingMessage): string {
  return req.method ?? "GET";
}

function queryOf(req: IncomingMessage, name: string): string | undefined {
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The bearer token from the request headers, if any. */
function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/**
 * Gate one mini-program request.
 *
 * @returns true when the caller may proceed; a response is already written
 *   otherwise.
 */
function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
  allowed: readonly string[],
): boolean {
  const method = methodOf(req);
  const expected = deps.apiToken();

  if (expected === undefined) {
    // Disabled: pretend the surface does not exist rather than advertising it.
    sendJson(res, 404, { ok: false, error: "mini-program API is disabled" }, method);
    return false;
  }
  if (!allowed.includes(method)) {
    sendJson(res, 405, { ok: false, error: `${method} is not allowed here` }, method);
    return false;
  }
  const provided = bearerOf(req);
  if (!tokenMatches(expected, provided)) {
    logger.warn(
      `mp-api: rejected ${method} ${req.url ?? ""} from ${req.socket.remoteAddress ?? "?"} (token ${provided === undefined ? "missing" : `bad ${maskToken(provided)}`})`,
    );
    res.setHeader("WWW-Authenticate", 'Bearer realm="dsh-weixin"');
    sendJson(res, 401, { ok: false, error: "invalid or missing token" }, method);
    return false;
  }
  return true;
}

/** Report a user-level failure as 400 and anything else as 500. */
function fail(res: ServerResponse, method: string, err: unknown, userFault = true): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!userFault) logger.error(`mp-api: unexpected failure: ${message}`);
  sendJson(res, userFault ? 400 : 500, { ok: false, error: message }, method);
}

async function handleHello(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {
  if (!authorize(req, res, deps, ["GET", "HEAD"])) return;
  const payload: MpHelloPayload = deps.runtime.mpHello();
  sendJson(res, 200, payload, methodOf(req));
}

async function handleState(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {
  if (!authorize(req, res, deps, ["GET", "HEAD"])) return;
  try {
    const payload: MpStatePayload = await deps.runtime.mpState();
    sendJson(res, 200, payload, methodOf(req));
  } catch (err) {
    fail(res, methodOf(req), err, false);
  }
}

async function handleWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {
  if (!authorize(req, res, deps, ["POST"])) return;
  const body = (await readJsonBody(req)) ?? {};
  const request: MpWorkspaceRequest = {
    workspace: typeof body.workspace === "string" ? body.workspace : "",
  };
  try {
    const payload: WorkspacePayload = deps.runtime.setWorkspace(request.workspace);
    sendJson(res, 200, payload, methodOf(req));
  } catch (err) {
    fail(res, methodOf(req), err);
  }
}

async function handleFs(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {
  if (!authorize(req, res, deps, ["GET", "HEAD"])) return;
  try {
    const payload: MpFsPayload = deps.runtime.mpEntries(queryOf(req, "path"));
    sendJson(res, 200, payload, methodOf(req));
  } catch (err) {
    fail(res, methodOf(req), err);
  }
}

async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {  if (!authorize(req, res, deps, ["POST"])) return;
  const body = (await readJsonBody(req)) ?? {};
  const peerId = typeof body.peerId === "string" ? body.peerId : "";
  if (peerId.trim() === "") {
    sendJson(res, 400, { ok: false, error: "peerId 不能为空" }, methodOf(req));
    return;
  }
  try {
    const payload: MpNewSessionPayload = await deps.runtime.mpNewSession({
      peerId,
      ...(typeof body.accountId === "string" && body.accountId.trim() !== ""
        ? { accountId: body.accountId }
        : {}),
      ...(typeof body.preset === "string" ? { preset: body.preset } : {}),
    });
    sendJson(res, 200, payload, methodOf(req));
  } catch (err) {
    fail(res, methodOf(req), err);
  }
}

/** `GET /mp/messages?peerId=&limit=` — the transcript this channel kept. */
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {
  if (!authorize(req, res, deps, ["GET", "HEAD"])) return;
  const peerId = queryOf(req, "peerId") ?? "";
  const accountId = queryOf(req, "accountId");
  const rawLimit = Number(queryOf(req, "limit") ?? "20");
  try {
    const payload: MpMessagesPayload = deps.runtime.mpMessages({
      peerId,
      ...(accountId === undefined || accountId === "" ? {} : { accountId }),
      ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: Math.trunc(rawLimit) } : {}),
    });
    sendJson(res, 200, payload, methodOf(req));
  } catch (err) {
    fail(res, methodOf(req), err);
  }
}

/** `GET /mp/file?path=` — bounded text preview, confined to the workspace. */
async function handleFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {
  if (!authorize(req, res, deps, ["GET", "HEAD"])) return;
  try {
    const payload: MpFilePayload = deps.runtime.mpReadFile(queryOf(req, "path"));
    sendJson(res, 200, payload, methodOf(req));
  } catch (err) {
    fail(res, methodOf(req), err);
  }
}

/**
 * Hand the token to the user's own tab.
 *
 * Protected by the same-origin fence instead of the token: it exists so the user
 * can copy the secret into the mini program, which means it must be reachable
 * from the browser on this machine and from nowhere else.
 */
async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MpRouteDeps,
): Promise<void> {
  const method = methodOf(req);
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: `${method} is not allowed here` }, method);
    return;
  }
  if (!isTrustedRequest(req, deps.trustedHosts())) {
    sendJson(res, 403, { ok: false, error: "this route only answers same-origin requests" }, method);
    return;
  }

  const token = deps.apiToken();
  if (token === undefined) {
    const payload: MpTokenPayload = {
      ok: false,
      enabled: false,
      basePath: WEIXIN_MP_BASE,
      error: "小程序 API 未启用：在插件配置里设置 mpApi.enabled: true",
    };
    sendJson(res, 200, payload, method);
    return;
  }
  const payload: MpTokenPayload = {
    ok: true,
    enabled: true,
    basePath: WEIXIN_MP_BASE,
    token,
  };
  sendJson(res, 200, payload, method);
}

/**
 * Build the mini-program routes.
 *
 * @returns the definitions, so the caller registers them under `ctx.effect`.
 */
export function buildMpRoutes(deps: MpRouteDeps): WebRouteLike[] {
  return [
    { kind: "exact", path: WEIXIN_MP_PATHS.hello, handler: (req, res) => handleHello(req, res, deps) },
    { kind: "exact", path: WEIXIN_MP_PATHS.state, handler: (req, res) => handleState(req, res, deps) },
    {
      kind: "exact",
      path: WEIXIN_MP_PATHS.workspace,
      handler: (req, res) => handleWorkspace(req, res, deps),
    },
    { kind: "exact", path: WEIXIN_MP_PATHS.fs, handler: (req, res) => handleFs(req, res, deps) },
    {
      kind: "exact",
      path: WEIXIN_MP_PATHS.messages,
      handler: (req, res) => handleMessages(req, res, deps),
    },
    {
      kind: "exact",
      path: WEIXIN_MP_PATHS.file,
      handler: (req, res) => handleFile(req, res, deps),
    },
    {
      kind: "exact",
      path: WEIXIN_MP_PATHS.session,
      handler: (req, res) => handleSession(req, res, deps),
    },
    { kind: "exact", path: WEIXIN_MP_PATHS.token, handler: (req, res) => handleToken(req, res, deps) },
  ];
}
