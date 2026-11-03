/**
 * Browser-side data access for the WeChat tab.
 *
 * Every call goes to this plugin's own host routes; the tab never touches a DSH
 * client service or another plugin's API.
 */
import {
  WEIXIN_PATHS,
  type DirectoryListingPayload,
  type StatusPayload,
  type LoginStartPayload,
  type LoginStatusPayload,
  type ToolsPayload,
  type WorkspacePayload,
} from "../shared/wire";

/** One failed call, carrying the message the route reported. */
export class WeixinClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeixinClientError";
  }
}

/** Whether a rejection is our own abort rather than a real failure. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One JSON request.
 *
 * @param url - route URL including its query.
 * @param options.payload - when present the request is a POST with this body.
 * @param options.signal - aborts the request.
 * @returns the parsed success body.
 * @throws {WeixinClientError} on a transport failure or an error envelope.
 */
async function request<T extends { ok: boolean }>(
  url: string,
  options: { payload?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.payload === undefined ? "GET" : "POST",
      headers:
        options.payload === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new WeixinClientError(messageOf(error));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WeixinClientError(`HTTP ${response.status}`);
  }
  const record = body as { ok?: unknown; error?: unknown };
  if (record?.ok !== true) {
    throw new WeixinClientError(
      typeof record?.error === "string" && record.error !== ""
        ? record.error
        : `HTTP ${response.status}`,
    );
  }
  return body as T;
}

/** Read the channel status (accounts, peers, log path) and the latest login. */
export async function fetchStatus(signal?: AbortSignal): Promise<StatusPayload> {
  return request<StatusPayload>(WEIXIN_PATHS.status, { signal });
}

/** Start (or restart) a QR login. */
export async function startLogin(
  options: { force?: boolean } = {},
  signal?: AbortSignal,
): Promise<LoginStartPayload> {
  return request<LoginStartPayload>(WEIXIN_PATHS.loginStart, {
    payload: options.force === true ? { force: true } : {},
    signal,
  });
}

/** Read the current login attempt. */
export async function fetchLoginStatus(signal?: AbortSignal): Promise<LoginStatusPayload> {
  return request<LoginStatusPayload>(WEIXIN_PATHS.loginStatus, { signal });
}

/** Submit the numeric code shown on the phone. */
export async function submitVerifyCode(
  sessionKey: string,
  code: string,
  signal?: AbortSignal,
): Promise<LoginStatusPayload> {
  return request<LoginStatusPayload>(WEIXIN_PATHS.loginVerify, {
    payload: { sessionKey, code },
    signal,
  });
}

/** Read one session's tool exposure. */
export async function fetchTools(sessionId: string, signal?: AbortSignal): Promise<ToolsPayload> {
  return request<ToolsPayload>(
    `${WEIXIN_PATHS.tools}?sessionId=${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

/** Opt one session's tools in or out. */
export async function setTools(
  sessionId: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<ToolsPayload> {
  return request<ToolsPayload>(WEIXIN_PATHS.tools, {
    payload: { sessionId, enabled },
    signal,
  });
}

/** Read the workspace new WeChat sessions are created in. */
export async function fetchWorkspace(signal?: AbortSignal): Promise<WorkspacePayload> {
  return request<WorkspacePayload>(WEIXIN_PATHS.workspace, { signal });
}

/** Change that workspace. An empty string falls back to the configured value. */
export async function saveWorkspace(
  workspace: string,
  signal?: AbortSignal,
): Promise<WorkspacePayload> {
  return request<WorkspacePayload>(WEIXIN_PATHS.workspace, {
    payload: { workspace },
    signal,
  });
}

/** List one directory's sub-directories for the picker. */
export async function fetchDirs(
  dirPath?: string,
  signal?: AbortSignal,
): Promise<DirectoryListingPayload> {
  const query =
    dirPath === undefined || dirPath === "" ? "" : `?path=${encodeURIComponent(dirPath)}`;
  return request<DirectoryListingPayload>(`${WEIXIN_PATHS.dirs}${query}`, { signal });
}
