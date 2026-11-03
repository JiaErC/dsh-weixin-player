/**
 * The「微信」tab body.
 *
 * Three jobs, in the order the user needs them:
 *  1. where new conversations work — the channel's working directory, pickable
 *     here instead of buried in the profile YAML;
 *  2. the per-session tool switch — the only place that can give one
 *     conversation the WeChat tools without touching any agent preset;
 *  3. the QR login flow, so connecting an account never requires the terminal.
 *
 * All state comes from this plugin's host routes; the tab holds no credentials.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import {
  WEIXIN_PATHS,
  type ChannelSnapshot,
  type DirectoryListingPayload,
  type QrLoginSnapshot,
  type ToolsPayload,
  type WorkspacePayload,
} from "../shared/wire";
import {
  fetchDirs,
  fetchLoginStatus,
  fetchStatus,
  fetchTools,
  fetchWorkspace,
  isAbort,
  saveWorkspace,
  setTools,
  startLogin,
  submitVerifyCode,
  WeixinClientError,
} from "./api";
import {
  card,
  cardHeader,
  cardLast,
  disabled,
  errorText,
  hint,
  input,
  link,
  meta,
  panel,
  pill,
  pickerRow,
  primaryButton,
  qrFrame,
  qrPlaceholder,
  row,
  secondaryButton,
  title,
  token,
} from "./styles";

/** Props the sidebar slot injects. */
export interface WeixinTabProps {
  /** The session this pane belongs to; the tool switch is scoped to it. */
  sessionId?: string;
  /** The client cordis context (unused today, kept for parity with the slot). */
  ctx?: unknown;
}

/** Poll cadence for the login attempt while it is in flight. */
const LOGIN_POLL_MS = 1500;
/** Poll cadence for the channel status, workspace and tool exposure. */
const STATUS_POLL_MS = 5000;

/** Statuses that are still moving and therefore worth polling. */
const ACTIVE_LOGIN: ReadonlySet<string> = new Set([
  "starting",
  "wait",
  "scaned",
  "need_verifycode",
  "refreshing",
]);

function errorMessageOf(error: unknown): string {
  if (error instanceof WeixinClientError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function when(ms: number | undefined): string {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toLocaleString() : "—";
}

/** One row of the account summary. */
function AccountLine({ channel }: { channel: ChannelSnapshot }): ReactElement {
  if (channel.accounts.length === 0) {
    return <p style={hint}>还没有登录任何微信账号，扫码即可连接。</p>;
  }
  return (
    <div>
      {channel.accounts.map((account) => {
        const color = account.running
          ? token.success
          : account.configured
            ? token.textTertiary
            : token.danger;
        const label = account.running ? "运行中" : account.configured ? "已停" : "未登录";
        return (
          <div key={account.accountId} style={{ marginBottom: 6 }}>
            <span style={pill(color)}>{label}</span>{" "}
            <span style={{ fontFamily: token.mono, fontSize: 11 }}>{account.accountId}</span>
            <div style={meta}>
              收 {account.inboundCount} 条 · 最近 {when(account.lastInboundAt)}
            </div>
            {account.lastError !== undefined && <div style={errorText}>{account.lastError}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Directory picker: a parent link plus one row per sub-directory. */
function DirectoryPicker({
  listing,
  busy,
  onEnter,
  onPick,
  onClose,
}: {
  listing: DirectoryListingPayload;
  busy: boolean;
  onEnter: (path: string) => void;
  onPick: (path: string) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div
      style={{
        marginTop: 8,
        border: `1px solid ${token.hairline}`,
        borderRadius: 6,
        background: token.surface,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "4px 8px",
          borderBottom: `1px solid ${token.hairline}`,
          fontFamily: token.mono,
          fontSize: 11,
          wordBreak: "break-all",
          color: token.textSecondary,
        }}
      >
        {listing.path}
      </div>
      <div style={{ maxHeight: 180, overflowY: "auto" }}>
        {listing.parent !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onEnter(listing.parent as string)}
            style={{ ...pickerRow, color: token.textSecondary }}
          >
            ↑ 上一级
          </button>
        )}
        {listing.entries.length === 0 && (
          <div style={{ ...pickerRow, color: token.textTertiary, cursor: "default" }}>
            没有子目录
          </div>
        )}
        {listing.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            disabled={busy}
            onClick={() => onEnter(entry.path)}
            style={pickerRow}
            title={entry.path}
          >
            📁 {entry.name}
          </button>
        ))}
        {listing.truncated && (
          <div style={{ ...pickerRow, color: token.textTertiary, cursor: "default" }}>
            目录过多，只显示前 500 个
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, padding: 8, borderTop: `1px solid ${token.hairline}` }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => onPick(listing.path)}
          style={{ ...primaryButton, ...(busy ? disabled : {}) }}
        >
          用这个目录
        </button>
        <button type="button" onClick={onClose} style={secondaryButton}>
          收起
        </button>
      </div>
    </div>
  );
}

/**
 * The tab body.
 * @param props - injected session id.
 * @returns the rendered panel.
 */
export function WeixinTab({ sessionId }: WeixinTabProps): ReactElement {
  const [channel, setChannel] = useState<ChannelSnapshot | null>(null);
  const [login, setLogin] = useState<QrLoginSnapshot | null>(null);
  const [tools, setToolsState] = useState<ToolsPayload | null>(null);
  const [workspace, setWorkspaceState] = useState<WorkspacePayload | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [browsing, setBrowsing] = useState<DirectoryListingPayload | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sessionRef = useRef<string | undefined>(sessionId);
  sessionRef.current = sessionId;

  /** Refresh channel status, the workspace, and this session's tool exposure. */
  const refresh = useCallback(async () => {
    try {
      const status = await fetchStatus();
      setChannel(status.channel);
      if (status.login !== null) setLogin(status.login);
    } catch (err) {
      if (!isAbort(err)) setError(errorMessageOf(err));
    }

    try {
      const next = await fetchWorkspace();
      setWorkspaceState(next);
      // Only seed the field while the user has not typed anything.
      setWorkspaceDraft((current) => (current === "" ? next.path : current));
    } catch (err) {
      if (!isAbort(err)) setError(errorMessageOf(err));
    }

    const id = sessionRef.current;
    if (id === undefined || id === "") return;
    try {
      setToolsState(await fetchTools(id));
    } catch (err) {
      if (!isAbort(err)) setError(errorMessageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Poll the login attempt only while it is moving.
  useEffect(() => {
    if (login === null || !ACTIVE_LOGIN.has(login.status)) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const result = await fetchLoginStatus();
          if (result.login !== null) setLogin(result.login);
        } catch (err) {
          if (!isAbort(err)) setError(errorMessageOf(err));
        }
        // A confirmed login changes the account list; pick it up immediately.
        try {
          setChannel((await fetchStatus()).channel);
        } catch {
          // The scheduled refresh will retry.
        }
      })();
    }, LOGIN_POLL_MS);
    return () => clearInterval(timer);
  }, [login]);

  /** Persist the working directory new conversations will use. */
  const persistWorkspace = useCallback(async (value: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveWorkspace(value);
      setWorkspaceState(next);
      setWorkspaceDraft(next.path);
      setBrowsing(null);
      setNotice(
        next.source === "config"
          ? "已恢复为配置里的工作目录。"
          : `已保存：${next.path}${next.writable ? "" : "（该目录当前不可写）"}`,
      );
    } catch (err) {
      setError(errorMessageOf(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Open (or navigate) the directory picker. */
  const browse = useCallback(async (path?: string) => {
    setBusy(true);
    setError(null);
    try {
      setBrowsing(await fetchDirs(path));
    } catch (err) {
      setError(errorMessageOf(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Toggle this session's WeChat tools. */
  const toggleTools = useCallback(async () => {
    const id = sessionRef.current;
    if (id === undefined || id === "") {
      setError("这个面板没有绑定会话，无法启用工具");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setToolsState(await setTools(id, tools?.enabled !== true));
    } catch (err) {
      setError(errorMessageOf(err));
    } finally {
      setBusy(false);
    }
  }, [tools]);

  /** Begin (or restart) the QR login. */
  const beginLogin = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await startLogin({ force: true });
      setLogin(result.login);
    } catch (err) {
      setError(errorMessageOf(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Submit the numeric code from the phone. */
  const sendCode = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed === "" || login === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitVerifyCode(login.sessionKey, trimmed);
      if (result.login !== null) setLogin(result.login);
      setCode("");
      if (!result.ok && result.error !== undefined) setError(result.error);
    } catch (err) {
      setError(errorMessageOf(err));
    } finally {
      setBusy(false);
    }
  }, [code, login]);

  const toolsEnabled = tools?.enabled === true;
  // Narrowed once: the JSX below needs a definite string, not a boolean flag.
  const qrUrl =
    login !== null &&
    login.qrcodeUrl !== undefined &&
    login.status !== "confirmed" &&
    login.status !== "already_connected"
      ? login.qrcodeUrl
      : undefined;
  const qrSessionKey = login === null ? "" : login.sessionKey;
  const qrVersion = login === null ? 0 : login.startedAt;
  const sourceLabel =
    workspace === null ? "…" : workspace.source === "settings" ? "自定义" : "来自配置";

  return (
    <div style={panel}>
      <div style={card}>
        <div style={cardHeader}>
          <span style={title}>工作目录</span>
          <span style={pill(workspace?.source === "settings" ? token.accent : token.textTertiary)}>
            {sourceLabel}
          </span>
        </div>
        <div style={{ ...meta, fontSize: 12 }}>{workspace?.path ?? "读取中…"}</div>
        <div style={row}>
          <input
            style={{ ...input, width: "100%", flex: "1 1 140px" }}
            placeholder="绝对路径，例如 E:\work\my-project"
            value={workspaceDraft}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void persistWorkspace(workspaceDraft);
            }}
          />
        </div>
        <div style={row}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void persistWorkspace(workspaceDraft)}
            style={{ ...primaryButton, ...(busy ? disabled : {}) }}
          >
            保存
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void browse(browsing?.path ?? workspace?.path)}
            style={{ ...secondaryButton, ...(busy ? disabled : {}) }}
          >
            {browsing === null ? "浏览…" : "刷新目录"}
          </button>
          {browsing !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBrowsing(null);
              }}
              style={secondaryButton}
            >
              收起
            </button>
          )}
        </div>
        {browsing !== null && (
          <DirectoryPicker
            listing={browsing}
            busy={busy}
            onEnter={(path) => void browse(path)}
            onPick={(path) => void persistWorkspace(path)}
            onClose={() => setBrowsing(null)}
          />
        )}
        <p style={hint}>
          只影响之后新建的微信会话；已经开始的会话仍用旧目录（在微信里发 <code>/new</code> 就会用新目录）。
          {workspace !== null && !workspace.writable ? " 当前目录不可写，agent 可能无法落盘。" : ""}
        </p>
        {notice !== null && <p style={{ ...hint, color: token.success }}>{notice}</p>}
      </div>

      <div style={card}>
        <div style={cardHeader}>
          <span style={title}>本会话的微信工具</span>
          <a style={link} href={WEIXIN_PATHS.page} target="_blank" rel="noreferrer">
            完整页面 ↗
          </a>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div>
            <span style={pill(toolsEnabled ? token.success : token.textTertiary)}>
              {toolsEnabled ? (tools?.applied ? "已启用" : "已启用（待生效）") : "未启用"}
            </span>
            <div style={meta}>{sessionId === undefined ? "（面板未绑定会话）" : sessionId}</div>
          </div>
          <button
            type="button"
            onClick={() => void toggleTools()}
            disabled={busy || sessionId === undefined}
            style={{ ...(toolsEnabled ? secondaryButton : primaryButton), ...(busy ? disabled : {}) }}
          >
            {toolsEnabled ? "停用" : "启用"}
          </button>
        </div>
        <p style={hint}>
          只对当前会话生效，不改动任何 Agent 预设
          {channel?.agentPreset === undefined ? "（当前用部署默认预设）" : `（当前预设：${channel.agentPreset}）`}；
          工具名{" "}
          <span style={{ fontFamily: token.mono }}>weixin_send / weixin_login / weixin_status</span>
          ，对下一轮对话生效。
        </p>
        {tools?.note !== undefined && <p style={hint}>{tools.note}</p>}
      </div>

      <div style={card}>
        <div style={cardHeader}>
          <span style={title}>连接微信</span>
          <button
            type="button"
            onClick={() => void beginLogin()}
            disabled={busy}
            style={{ ...primaryButton, ...(busy ? disabled : {}) }}
          >
            {qrUrl === undefined ? "开始登录" : "重新扫码"}
          </button>
        </div>

        {qrUrl === undefined ? (
          <div style={qrPlaceholder}>用手机微信扫描二维码即可完成连接</div>
        ) : (
          <img
            style={qrFrame}
            src={`${WEIXIN_PATHS.loginQr}?sessionKey=${encodeURIComponent(qrSessionKey)}&t=${qrVersion}`}
            alt="微信登录二维码"
          />
        )}

        <p style={hint}>{login === null ? "点「开始登录」生成二维码。" : login.message}</p>
        {login?.error !== undefined && <p style={errorText}>{login.error}</p>}

        {login?.needsVerifyCode === true && (
          <div style={row}>
            <input
              style={input}
              inputMode="numeric"
              placeholder="手机上的数字"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendCode();
              }}
            />
            <button
              type="button"
              onClick={() => void sendCode()}
              disabled={busy}
              style={{ ...secondaryButton, ...(busy ? disabled : {}) }}
            >
              提交
            </button>
          </div>
        )}

        {qrUrl !== undefined && (
          <p style={{ ...hint, wordBreak: "break-all" }}>
            二维码显示不出来时，把链接复制到手机微信打开：{" "}
            <a style={link} href={qrUrl} target="_blank" rel="noreferrer">
              {qrUrl}
            </a>
          </p>
        )}
      </div>

      <div style={cardLast}>
        <div style={cardHeader}>
          <span style={title}>账号</span>
        </div>
        {channel === null ? (
          <p style={hint}>读取中…</p>
        ) : (
          <AccountLine channel={channel} />
        )}
        {channel !== null && (
          <p style={hint}>
            允许来源：{channel.allowFrom.length > 0 ? channel.allowFrom.join(", ") : "账号主人"}
          </p>
        )}
        {error !== null && <p style={errorText}>{error}</p>}
      </div>
    </div>
  );
}
