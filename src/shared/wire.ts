/**
 * Wire contract shared by the channel's two halves.
 *
 * The host serves these routes and the browser tab calls them, so the paths and
 * payload shapes live in one module that both sides import. It must stay free of
 * node imports: the client bundle pulls this file into the browser.
 */

/** Every HTTP route this plugin owns, absolute and without a trailing slash. */
export const WEIXIN_PATHS = {
  page: "/dsh-weixin",
  status: "/dsh-weixin/status",
  loginStart: "/dsh-weixin/login/start",
  loginStatus: "/dsh-weixin/login/status",
  loginVerify: "/dsh-weixin/login/verify",
  loginQr: "/dsh-weixin/login/qr.png",
  tools: "/dsh-weixin/tools",
} as const;

/** Tool names the channel can expose to a session. */
export const WEIXIN_TOOL_NAMES = ["weixin_send", "weixin_login", "weixin_status"] as const;

/** Right-sidebar tab identity and its guide position. */
export const WEIXIN_TAB_ID = "dsh-weixin:channel";
export const WEIXIN_TAB_KIND = "dsh-weixin:channel";
export const WEIXIN_TAB_ORDER = 45;
export const WEIXIN_BODY_SLOT = "sidebar.right.pane.tab";

/** One account as the status route reports it. */
export interface AccountSnapshot {
  accountId: string;
  name: string | undefined;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  startedAt: number | undefined;
  lastInboundAt: number | undefined;
  lastEventAt: number | undefined;
  lastError: string | undefined;
  inboundCount: number;
  ownerUserId: string | undefined;
}

/** One WeChat peer → DSH session binding. */
export interface PeerSnapshot {
  peerId: string;
  sessionId: string;
  lastActiveAt: number;
  generation: number;
}

/** Everything the status route reports about the channel. */
export interface ChannelSnapshot {
  workspace: string;
  agentPreset: string | undefined;
  sessionMode: string;
  allowFrom: readonly string[];
  accounts: AccountSnapshot[];
  peers: PeerSnapshot[];
  logFile: string;
}

/** Lifecycle of one QR login attempt. */
export type QrLoginStatus =
  | "starting"
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "refreshing"
  | "confirmed"
  | "already_connected"
  | "failed";

/** What a client can read about a login attempt. */
export interface QrLoginSnapshot {
  sessionKey: string;
  status: QrLoginStatus;
  message: string;
  qrcodeUrl?: string;
  startedAt: number;
  needsVerifyCode: boolean;
  accountId?: string;
  userId?: string;
  error?: string;
}

/** `GET /dsh-weixin/status` */
export interface StatusPayload {
  ok: true;
  channel: ChannelSnapshot;
  login: QrLoginSnapshot | null;
}

/** `POST /dsh-weixin/login/start` */
export interface LoginStartPayload {
  ok: true;
  login: QrLoginSnapshot;
}

/** `GET /dsh-weixin/login/status`, `POST /dsh-weixin/login/verify` */
export interface LoginStatusPayload {
  ok: boolean;
  login: QrLoginSnapshot | null;
  error?: string;
}

/** Per-session tool exposure, as the tab reads and toggles it. */
export interface ToolsPayload {
  ok: true;
  sessionId: string;
  /** Whether the session is opted in. */
  enabled: boolean;
  /** Whether the definitions are registered on a live agent right now. */
  applied: boolean;
  /** Tool names the session gains. */
  tools: readonly string[];
  /** Why `applied` is false while `enabled` is true, when known. */
  note?: string;
}

/** `POST /dsh-weixin/tools` */
export interface ToolsToggleRequest {
  sessionId: string;
  enabled: boolean;
}

/** The error envelope every route answers on failure. */
export interface RouteError {
  ok: false;
  error: string;
}
