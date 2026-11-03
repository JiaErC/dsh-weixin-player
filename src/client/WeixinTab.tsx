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
  modalBackdrop,
  modalBody,
  modalFooter,
  modalHeader,
  modalPanel,
  panel,
  pickerRow,
  pill,
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

/**
 * The directory dialog.
 *
 * A real modal rather than an inline list: picking a folder is a small task of
 * its own, and it needs room for a path field at the top plus a scrolling list.
 * The backdrop is \`position: fixed\` so it covers the viewport instead of the
 * sidebar's scroll box, which is why the dialog is usable in a narrow pane.
 */
function DirectoryModal({
  listing,
  draft,
  busy,
  error,
  onDraftChange,
  onNavigate,
  onPick,
  onClose,
}: {
  listing: DirectoryListingPayload | null;
  draft: string;
  busy: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onNavigate: (path: string) => void;
  onPick: (path: string) => void;
  onClose: () => void;
}): ReactElement {
  const currentPath = listing === null ? "" : listing.path;
  return (
    <div
      style={modalBackdrop}
      role="presentation"
      onClick={(event) => {
        // Only the backdrop itself closes the dialog, not a click inside it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={modalPanel} role="dialog" aria-modal="true" aria-label="选择工作目录">
        <div style={modalHeader}>
          <span style={title}>选择工作目录</span>
          <button type="button" onClick={onClose} style={secondaryButton} aria-label="关闭">
            ×
          </button>
        </div>

        <div style={{ padding: "8px 12px 0" }}>
          <div style={row}>
            <input
              style={{ ...input, flex: "1 1 180px", width: "100%", fontFamily: token.mono }}
              value={draft}
              placeholder="可以直接输入或粘贴绝对路径，回车跳转"
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onNavigate(draft);
              }}
              autoFocus
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => onNavigate(draft)}
              style={{ ...secondaryButton, ...(busy ? disabled : {}) }}
            >
              转到
            </button>
          </div>
          <p style={{ ...meta, marginTop: 6 }}>
            {currentPath === "" ? "读取中…" : currentPath}
          </p>
          {error !== null && <p style={errorText}>{error}</p>}
        </div>

        <div style={modalBody}>
          {listing !== null && listing.parent !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onNavigate(listing.parent as string)}
              style={{ ...pickerRow, color: token.textSecondary }}
            >
              ↑ 上一级
            </button>
          )}
          {listing !== null && listing.entries.length === 0 && (
            <div style={{ ...pickerRow, color: token.textTertiary, cursor: "default" }}>
              这个目录下没有子目录
            </div>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              disabled={busy}
              onClick={() => onNavigate(entry.path)}
              style={pickerRow}
              title={entry.path}
            >
              📁 {entry.name}
            </button>
          ))}
          {listing !== null && listing.truncated && (
            <div style={{ ...pickerRow, color: token.textTertiary, cursor: "default" }}>
              目录过多，只显示前 500 个
            </div>
          )}
        </div>

        <div style={modalFooter}>
          <span style={hint}>进到目标文件夹后点右侧按钮</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryButton}>
              取消
            </button>
            <button
              type="button"
              disabled={busy || listing === null}
              onClick={() => onPick(currentPath)}
              style={{ ...primaryButton, ...(busy || listing === null ? disabled : {}) }}
            >
              用这个目录
            </button>
          </div>
        </div>
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
  /** Whether the directory dialog is open. */
  const [browseOpen, setBrowseOpen] = useState(false);
  /** What the dialog's top path field shows (editable, independent of `browsing`). */
  const [browseDraft, setBrowseDraft] = useState("");
  /** Why the last navigation inside the dialog failed. */
  const [browseError, setBrowseError] = useState<string | null>(null);
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
      // A save ends the dialog's job, whichever path it came from.
      setBrowseOpen(false);
      setBrowseError(null);
      setNotice(
        next.source === "config"
          ? "已恢复为配置里的工作目录。"
          : `已保存：${next.path}${next.writable ? "" : "（该目录当前不可写）"}`,
      );
    } catch (err) {
      const message = errorMessageOf(err);
      setError(message);
      // The dialog may be the surface the save came from, so the message has to
      // be visible there too; it is cleared the next time the dialog opens.
      setBrowseError(message);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Navigate the dialog to `path` (or reload the current directory).
   *
   * A failure is reported **inside** the dialog and the dialog stays open: the
   * user is mid-typing, so closing on a typo would lose their place.
   */
  const browse = useCallback(async (path?: string) => {
    setBusy(true);
    setBrowseError(null);
    try {
      const listing = await fetchDirs(path);
      setBrowsing(listing);
      setBrowseDraft(listing.path);
    } catch (err) {
      setBrowseError(errorMessageOf(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Open the dialog at the current workspace. */
  const openBrowser = useCallback(() => {
    setBrowseOpen(true);
    // Always start from the workspace actually in effect, not from wherever the
    // last browsing session ended.
    void browse(workspace?.path);
  }, [browse, workspace]);

  /** Close the dialog and forget its transient state. */
  const closeBrowser = useCallback(() => {
    setBrowseOpen(false);
    setBrowseError(null);
  }, []);

  // Escape closes the dialog, the way every other modal in the app behaves.
  useEffect(() => {
    if (!browseOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeBrowser();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [browseOpen, closeBrowser]);

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
            onClick={openBrowser}
            style={{ ...secondaryButton, ...(busy ? disabled : {}) }}
          >
            浏览…
          </button>
        </div>
        {browseOpen && (
          <DirectoryModal
            listing={browsing}
            draft={browseDraft}
            busy={busy}
            error={browseError}
            onDraftChange={setBrowseDraft}
            onNavigate={(path) => void browse(path)}
            onPick={(path) => {
              setWorkspaceDraft(path);
              void persistWorkspace(path);
            }}
            onClose={closeBrowser}
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
