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
  workspace: "/dsh-weixin/workspace",
  dirs: "/dsh-weixin/fs",
  sessionSettings: "/dsh-weixin/session-settings",
} as const;

/**
 * The mini-program API, served under one prefix.
 *
 * These routes are the one surface meant to be called from outside the browser:
 * a phone cannot reach `127.0.0.1`, so they are authenticated by a bearer token
 * instead of the same-origin fence the other routes use.
 */
export const WEIXIN_MP_BASE = "/dsh-weixin/mp";

/** Every mini-program route, relative to {@link WEIXIN_MP_BASE}. */
export const WEIXIN_MP_PATHS = {
  /** Liveness + identity; the "test this machine" button hits it. */
  hello: "/dsh-weixin/mp/hello",
  /** Everything a dashboard needs in one round trip. */
  state: "/dsh-weixin/mp/state",
  /** Switch the workspace new sessions use. */
  workspace: "/dsh-weixin/mp/workspace",
  /** Browse directories and files. */
  fs: "/dsh-weixin/mp/fs",
  /** The conversation transcript this channel kept. */
  messages: "/dsh-weixin/mp/messages",
  /** Bounded text preview of one file inside the workspace. */
  file: "/dsh-weixin/mp/file",
  /** Start a new session for a peer, optionally with another agent preset. */
  session: "/dsh-weixin/mp/session",
  /** The API token, readable only from the same-origin tab. */
  token: "/dsh-weixin/mp/token",
} as const;

/** Where the effective workspace value came from. */
export type WorkspaceSource = "settings" | "config";

/** `GET`/`POST /dsh-weixin/workspace`. */
export interface WorkspacePayload {
  ok: true;
  /** Absolute, normalised directory the next WeChat session will use. */
  path: string;
  /** `settings` when a user picked it in the tab, `config` when the row set it. */
  source: WorkspaceSource;
  /** Whether the directory exists right now. */
  exists: boolean;
  /** Whether this process can write there; a read-only project is still valid. */
  writable: boolean;
}

/** `POST /dsh-weixin/workspace` request. */
export interface WorkspaceUpdateRequest {
  /** Absolute path, or an empty string to fall back to the configured value. */
  workspace: string;
}

/** One directory the picker can enter. */
export interface DirectoryEntry {
  name: string;
  path: string;
}

/** `GET /dsh-weixin/fs?path=…` */
export interface DirectoryListingPayload {
  ok: true;
  path: string;
  /** Parent directory, or null at a filesystem root. */
  parent: string | null;
  /** Sub-directories, alphabetically; dot-directories are omitted. */
  entries: DirectoryEntry[];
  /** True when the folder has more entries than were returned. */
  truncated: boolean;
}

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
  accountId: string;
  peerId: string;
  sessionId: string;
  lastActiveAt: number;
  generation: number;
  /** Preset this conversation's next session composes, when one was chosen. */
  preset?: string;
}

/** Everything the status route reports about the channel. */
export interface ChannelSnapshot {
  /** Effective workspace for new WeChat sessions. */
  workspace: string;
  /** Whether `workspace` came from the tab's setting or from the Loader row. */
  workspaceSource: WorkspaceSource;
  agentPreset: string | undefined;
  /** Permission preset new WeChat sessions start under, undefined for the deployment default. */
  permissionPreset: string | undefined;
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

// ---------------------------------------------------------------------------
// Mini-program API
// ---------------------------------------------------------------------------

/** One agent preset a new session can compose. */
export interface MpPreset {
  id: string;
  /** Whether a session that names no preset composes this one. */
  isDefault: boolean;
  name?: string;
  description?: string;
  /** Present when the preset cannot compose a session, with the reason. */
  broken?: string;
}

/** One permission level a WeChat session can run under. */
export interface PermissionLevelOption {
  /** Preset key, e.g. `read-only`. */
  value: string;
  /** Label the deployment configured. */
  name: string;
  /** One sentence on what it allows. */
  description?: string;
}

/**
 * What the tab's session-settings card needs: the current defaults plus the two
 * pickable lists.
 *
 * `null` in either default means "no choice of our own" — the deployment value
 * applies, which is why the tab shows it as「跟随部署默认」rather than a preset.
 */
export interface SessionSettingsPayload {
  ok: true;
  /** Agent preset new WeChat sessions compose, or null for the deployment default. */
  agentPreset: string | null;
  /** Permission preset new WeChat sessions start under, or null for the deployment default. */
  permissionPreset: string | null;
  /** The permission preset a session would get without any choice of ours. */
  defaultPermission: string | null;
  /** Agent presets available to compose (includes editor-managed ones). */
  presets: MpPreset[];
  /** Permission levels available to pick. */
  permissions: PermissionLevelOption[];
  /** Set when a list is degraded (e.g. no permission service in this profile). */
  note?: string;
}

/** Body of a session-settings save: omit a field to leave it alone. */
export interface SessionSettingsRequest {
  /** Preset id, `none` for no preset, or null to fall back to config. */
  agentPreset?: string | null;
  /** Permission preset key, or null to fall back to config. */
  permissionPreset?: string | null;
}

/** One WeChat conversation as the mini program lists it. */
export interface MpPeer {
  accountId: string;
  peerId: string;
  sessionId: string;
  /** Bumped by every "new session". */
  generation: number;
  lastActiveAt: number;
  /** Preset this conversation's next session will compose, when one was chosen. */
  preset?: string;
  /** Whether a turn is running right now. */
  running: boolean;
}

/** One logged-in bot account. */
export interface MpAccount {
  accountId: string;
  name?: string;
  running: boolean;
  /** WeChat id that owns this bot (the QR-login scanner). */
  ownerUserId?: string;
  inboundCount: number;
  lastInboundAt?: number;
  lastError?: string;
}

/** Machine identity, so several computers can be told apart in the app. */
export interface MpMachine {
  hostname: string;
  platform: string;
  /** Node version the harness runs on. */
  node: string;
  /** Channel plugin version. */
  channelVersion: string;
}

/** `GET /dsh-weixin/mp/hello` — identity plus the little a card needs. */
export interface MpHelloPayload {
  ok: true;
  machine: MpMachine;
  workspace: { path: string; source: WorkspaceSource; writable: boolean };
  accounts: MpAccount[];
  /** Epoch ms the channel started, for an "uptime" line. */
  startedAt: number;
}

/** `GET /dsh-weixin/mp/state` — the dashboard's single round trip. */
export interface MpStatePayload {
  ok: true;
  machine: MpMachine;
  workspace: { path: string; source: WorkspaceSource; exists: boolean; writable: boolean };
  /** Preset the channel uses when a conversation names none. */
  defaultPreset?: string;
  presets: MpPreset[];
  peers: MpPeer[];
  accounts: MpAccount[];
}

/** One entry in the file browser. */
export interface MpEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  /** Size in bytes, for files. */
  size?: number;
  /** Last modification time, epoch ms. */
  mtime?: number;
}

/** `GET /dsh-weixin/mp/fs?path=…` */
export interface MpFsPayload {
  ok: true;
  path: string;
  parent: string | null;
  entries: MpEntry[];
  /** True when the folder holds more entries than were returned. */
  truncated: boolean;
  /** Why some entries could not be described (permissions, links), when any. */
  skipped?: number;
}

/** `POST /dsh-weixin/mp/workspace` */
export interface MpWorkspaceRequest {
  workspace: string;
}

/** One line of a conversation, as the channel saw it. */
export interface MpMessage {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms. */
  at: number;
}

/** `GET /dsh-weixin/mp/messages` — the transcript for one conversation. */
export interface MpMessagesPayload {
  ok: true;
  accountId: string;
  peerId: string;
  messages: MpMessage[];
}

/** Query for {@link MpMessagesPayload}. */
export interface MpMessagesRequest {
  peerId: string;
  accountId?: string;
  /** 1–40, newest last. */
  limit?: number;
}

/** `GET /dsh-weixin/mp/file` — metadata plus the text itself. */
export interface MpFilePayload {
  ok: true;
  path: string;
  name: string;
  /** Full size on disk; `text` may be shorter. */
  size: number;
  /** True when the file exceeds the preview cap. */
  truncated: boolean;
  text: string;
}

/** `POST /dsh-weixin/mp/session` — start a fresh conversation for one peer. */
export interface MpNewSessionRequest {
  /** WeChat id of the person, e.g. `abc@im.wechat`. */
  peerId: string;
  /** Bot account id; optional when only one account is logged in. */
  accountId?: string;
  /**
   * Preset for the new session. Omit to keep the channel default; send the id
   * of a preset from {@link MpStatePayload.presets}.
   */
  preset?: string;
}

/** `POST /dsh-weixin/mp/session` result. */
export interface MpNewSessionPayload {
  ok: true;
  accountId: string;
  peerId: string;
  sessionId: string;
  preset?: string;
  /** The session the conversation used before, for the "what changed" line. */
  previousSessionId: string;
}

/** `GET /dsh-weixin/mp/token` — same-origin only, for pasting into the app. */
export interface MpTokenPayload {
  ok: boolean;
  enabled: boolean;
  /** Base path the app should append to its machine URL. */
  basePath: string;
  token?: string;
  /** Present when `enabled` is false. */
  error?: string;
}

/** The error envelope every route answers on failure. */
export interface RouteError {
  ok: false;
  error: string;
}
