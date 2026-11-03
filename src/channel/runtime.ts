import type { WeixinChannelConfig } from "../config.js";
import type { HostServices } from "../dsh/services.js";
import {
  listWeixinAccountIds,
  loadWeixinAccount,
  normalizeWeixinAccountId,
  onAccountsChanged,
  resolveWeixinAccount,
} from "../protocol/auth/accounts.js";
import type { ResolvedWeixinAccount } from "../protocol/auth/accounts.js";
import { WeixinQrLoginManager } from "../protocol/auth/login-qr.js";
import { initializeQuoteStore } from "../protocol/messaging/quote-store.js";
import { resetRuntimeSettings, setRuntimeSettings } from "../protocol/runtime-settings.js";
import { logger } from "../protocol/util/logger.js";
import type { AccountSnapshot, ChannelSnapshot, DirectoryListingPayload, PeerSnapshot, WorkspacePayload } from "../shared/wire.js";
import type { WeixinToolOptIn, ToolExposure } from "../tools/optin.js";
import { handleInboundMessage } from "./handle-message.js";
import { createConfigManager, createMonitorStatus, monitorWeixinAccount } from "./monitor.js";
import type { MonitorStatus } from "./monitor.js";
import { AccountSender } from "./outbound.js";
import { AgentSessionManager, PeerSessionStore } from "./peer-session.js";
import {
  WeixinSettingsStore,
  inspectWorkspace,
  listDirectories,
  prepareWorkspace,
  resolveWorkspace,
} from "./settings.js";
import type { ResolvedWorkspace } from "./settings.js";
import { TurnTracker } from "./turn-tracker.js";

/**
 * The channel itself: one long-poll monitor per logged-in WeChat account, all
 * of them feeding the same agent-session machinery.
 *
 * Mounting the plugin does not start anything by itself — {@link start} waits
 * for the harness Loader to settle, then reconciles the accounts found on disk.
 * A later QR login re-runs the same reconcile through `onAccountsChanged`.
 */

/** What one running account owns. */
interface AccountRuntime {
  account: ResolvedWeixinAccount;
  sender: AccountSender;
  status: MonitorStatus;
  abort: AbortController;
  done: Promise<void>;
}

/** Dependency bundle for {@link WeixinChannelRuntime}. */
export interface ChannelRuntimeDeps {
  services: HostServices;
  config: WeixinChannelConfig;
}

/** Owns the monitors, the senders and the agent sessions. */
export class WeixinChannelRuntime {
  readonly qr: WeixinQrLoginManager;
  readonly sessions: AgentSessionManager;
  readonly store = new PeerSessionStore();

  private readonly running = new Map<string, AccountRuntime>();
  /** Per-session tool exposure; set once the definitions exist. */
  private toolOptIn: WeixinToolOptIn | undefined;
  /** User-editable settings (workspace), persisted next to the credentials. */
  private readonly settings = new WeixinSettingsStore();
  private readonly tracker: TurnTracker;
  private readonly stopWatchingAccounts: () => void;
  private started = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ChannelRuntimeDeps) {
    this.qr = new WeixinQrLoginManager();
    this.tracker = new TurnTracker(deps.services.ctx);
    this.sessions = new AgentSessionManager({
      services: deps.services,
      config: deps.config,
      tracker: this.tracker,
      workspace: () => this.workspace().path,
      onAgentReady: (sessionId) => this.enableToolsForChannelSession(sessionId),
    });
    this.stopWatchingAccounts = onAccountsChanged(() => this.scheduleReconcile());
  }

  /**
   * The directory new WeChat sessions are created in.
   *
   * Resolution order: what the user picked in the sidebar tab, then the Loader
   * row's `workspace`, then the process working directory.
   */
  workspace(): ResolvedWorkspace {
    return resolveWorkspace(this.settings.workspace, this.config.workspace);
  }

  /** Current workspace as the tab and the status tool read it. */
  workspacePayload(): WorkspacePayload {
    const resolved = this.workspace();
    // A read must not create directories; only saving does that.
    const inspection = inspectWorkspace(resolved.path);
    return {
      ok: true,
      path: resolved.path,
      source: resolved.source,
      exists: inspection.exists,
      writable: inspection.writable,
    };
  }

  /**
   * Change the workspace new WeChat sessions use.
   *
   * The directory is created when missing, matching what the harness itself does
   * before creating a session. Existing conversations keep the directory
   * recorded in their session header, so the tab tells the user how to get a
   * fresh one.
   *
   * @param input - absolute path, or an empty string to fall back to config.
   * @throws {Error} when the path is unusable; the message is user-facing.
   */
  setWorkspace(input: string): WorkspacePayload {
    const trimmed = input.trim();
    if (trimmed === "") {
      this.settings.workspace = undefined;
      return this.workspacePayload();
    }

    const prepared = prepareWorkspace(trimmed);
    if (!prepared.ok) throw new Error(prepared.error);

    this.settings.workspace = prepared.path;
    logger.info(
      `runtime: workspace set to ${prepared.path}${prepared.created ? " (created)" : ""}${prepared.writable ? "" : " (read-only)"}`,
    );
    return this.workspacePayload();
  }

  /**
   * List sub-directories for the workspace picker.
   *
   * @param target - absolute directory; defaults to the current workspace.
   * @throws {Error} when the directory cannot be read; the message is user-facing.
   */
  listDirectory(target?: string): DirectoryListingPayload {
    const path = target === undefined || target.trim() === "" ? this.workspace().path : target;
    const listing = listDirectories(path);
    if ("error" in listing) throw new Error(listing.error);
    return { ok: true, ...listing };
  }

  /**
   * Attach the per-session tool exposure manager.
   *
   * Separated from the constructor because the tool definitions close over this
   * runtime: the runtime must exist before the definitions, and the definitions
   * before the manager.
   */
  useToolOptIn(optIn: WeixinToolOptIn | undefined): void {
    this.toolOptIn = optIn;
  }

  private get config(): WeixinChannelConfig {
    return this.deps.config;
  }

  /**
   * Publish runtime settings, wait for the Loader, then start every account
   * that already has credentials.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    setRuntimeSettings({
      ...(this.config.botAgent === undefined ? {} : { botAgent: this.config.botAgent }),
      ...(this.config.routeTag === undefined ? {} : { routeTag: this.config.routeTag }),
    });

    if (this.config.quoteCache) {
      initializeQuoteStore({ maxMessagesPerAccount: this.config.quoteCacheMaxMessages });
    }

    try {
      await this.deps.services.loader?.await();
    } catch (err) {
      logger.warn(`runtime: loader.await() rejected: ${String(err)}`);
    }

    const accounts = listWeixinAccountIds();
    const workspace = this.workspace();
    logger.info(
      `runtime: starting with ${accounts.length} account(s); workspace=${workspace.path} (${workspace.source}); preset=${this.config.agentPreset ?? "deployment default"}`,
    );

    if (accounts.length === 0) {
      logger.info(
        "runtime: no WeChat account is logged in yet — open the login tab in DSH to scan the QR code",
      );
    }

    for (const accountId of accounts) this.startAccount(accountId);
  }

  /** Stop every monitor and release the agents this channel owns. */
  async stop(): Promise<void> {
    if (this.reconcileTimer !== undefined) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    this.stopWatchingAccounts();
    this.qr.cancelAll();
    this.tracker.stop();

    await Promise.all([...this.running.keys()].map((accountId) => this.stopAccount(accountId)));
    await this.sessions.close();
    resetRuntimeSettings();
    logger.info("runtime: stopped");
  }

  /** Start one account's monitor if it is configured and not already running. */
  private startAccount(accountId: string): void {
    const normalized = normalizeWeixinAccountId(accountId);
    if (this.running.has(normalized)) return;

    const settings = this.config.accounts[normalized];
    const account = resolveWeixinAccount(settings, normalized);
    if (!account.enabled) {
      logger.info(`runtime: account ${normalized} is disabled in config, skipped`);
      return;
    }
    if (!account.configured) {
      logger.warn(
        `runtime: account ${normalized} has no token — log in again from the DSH WeChat tab`,
      );
      return;
    }

    const configManager = createConfigManager(account);
    const sender = new AccountSender(account, account.cdnBaseUrl);
    const status = createMonitorStatus();
    const abort = new AbortController();

    const done = monitorWeixinAccount({
      account,
      longPollTimeoutMs: this.config.longPollTimeoutMs,
      configManager,
      abortSignal: abort.signal,
      status,
      handleMessage: (message) =>
        handleInboundMessage(message, {
          config: this.config,
          accountId: account.accountId,
          sender,
          sessions: this.sessions,
          store: this.store,
          configManager,
          cdnBaseUrl: account.cdnBaseUrl,
          startedAt: status.startedAt,
          allowFrom: () => this.allowFrom(account.accountId),
        }),
    })
      .catch((err) => {
        status.running = false;
        status.lastError = String(err);
        logger.withAccount(normalized).error(`monitor failed: ${String(err)}`);
      })
      .finally(() => {
        this.running.delete(normalized);
      });

    this.running.set(normalized, { account, sender, status, abort, done });
  }

  /** Stop one account's monitor. */
  private async stopAccount(accountId: string): Promise<void> {
    const runtime = this.running.get(accountId);
    if (runtime === undefined) return;
    this.running.delete(accountId);
    runtime.abort.abort();
    try {
      await runtime.done;
    } catch (err) {
      logger.warn(`runtime: monitor ${accountId} did not stop cleanly: ${String(err)}`);
    }
  }

  /** Coalesce bursts of credential changes into one reconcile pass. */
  private scheduleReconcile(): void {
    if (this.reconcileTimer !== undefined) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcile();
    }, 200);
    this.reconcileTimer.unref?.();
  }

  /** Start monitors for new accounts and stop monitors for removed ones. */
  private async reconcile(): Promise<void> {
    const wanted = new Set(listWeixinAccountIds().map((id) => normalizeWeixinAccountId(id)));
    for (const accountId of wanted) this.startAccount(accountId);
    for (const accountId of [...this.running.keys()]) {
      if (!wanted.has(accountId)) await this.stopAccount(accountId);
    }
    logger.info(`runtime: reconciled to ${this.running.size} running account(s)`);
  }

  /**
   * Effective sender allowlist for one account.
   *
   * An explicit `allowFrom` wins. Otherwise the account is scoped to the WeChat
   * user who scanned the QR code, so a freshly created bot is not automatically
   * open to everyone who finds it.
   */
  private allowFrom(accountId: string): readonly string[] {
    if (this.config.allowFrom.length > 0) return this.config.allowFrom;
    const ownerUserId = loadWeixinAccount(accountId)?.userId?.trim();
    return ownerUserId === undefined || ownerUserId === "" ? [] : [ownerUserId];
  }

  /**
   * Give a WeChat conversation its own tools.
   *
   * These sessions exist to talk on WeChat, so `weixin_send`/`weixin_login`/
   * `weixin_status` belong to them by default. The registration is scoped to
   * the agent, so it never leaks into the preset or into other sessions.
   */
  private enableToolsForChannelSession(sessionId: string): void {
    if (!this.config.autoEnableTools) return;
    const optIn = this.toolOptIn;
    if (optIn === undefined) return;
    if (optIn.isEnabled(sessionId)) return;
    // A user who switched the tools off for this conversation outranks the
    // auto-enable; otherwise the next message would silently undo their choice.
    if (optIn.isDeclined(sessionId)) return;
    try {
      optIn.setEnabled(sessionId, true);
      logger.info(`runtime: enabled weixin tools for channel session ${sessionId}`);
    } catch (err) {
      logger.warn(`runtime: failed to enable tools for ${sessionId}: ${String(err)}`);
    }
  }

  /** Per-session tool exposure, for the tab and the status tool. */
  toolExposure(sessionId: string): ToolExposure | undefined {
    return this.toolOptIn?.exposure(sessionId);
  }

  /** Opt a session's tools in or out. */
  setToolsEnabled(sessionId: string, enabled: boolean): ToolExposure {
    const optIn = this.toolOptIn;
    if (optIn === undefined) {
      throw new Error("dsh-weixin: this profile has no tool registry, so tools cannot be enabled");
    }
    const exposure = optIn.setEnabled(sessionId, enabled);
    logger.info(
      `runtime: tools ${enabled ? "enabled" : "disabled"} for session ${sessionId} (applied=${String(exposure.applied)})`,
    );
    return exposure;
  }

  /** Sender for an account, or undefined when it is not running. */
  senderFor(accountId: string): AccountSender | undefined {
    return this.running.get(normalizeWeixinAccountId(accountId))?.sender;
  }

  /** Running account ids. */
  runningAccountIds(): string[] {
    return [...this.running.keys()];
  }

  /** Snapshot for the status route and the `weixin_status` tool. */
  snapshot(): ChannelSnapshot {
    const accounts: AccountSnapshot[] = [];

    for (const accountId of new Set([
      ...listWeixinAccountIds().map((id) => normalizeWeixinAccountId(id)),
      ...this.running.keys(),
    ])) {
      const settings = this.config.accounts[accountId];
      const account = resolveWeixinAccount(settings, accountId);
      const runtime = this.running.get(accountId);
      accounts.push({
        accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        running: runtime !== undefined && runtime.status.running,
        startedAt: runtime === undefined ? undefined : runtime.status.startedAt,
        lastInboundAt: runtime?.status.lastInboundAt,
        lastEventAt: runtime?.status.lastEventAt,
        lastError: runtime?.status.lastError,
        inboundCount: runtime?.status.inboundCount ?? 0,
        ownerUserId: loadWeixinAccount(accountId)?.userId?.trim() || undefined,
      });
    }

    const peers: PeerSnapshot[] = this.store.list().slice(0, 50).map((binding) => ({
      peerId: binding.peerId,
      sessionId: binding.sessionId,
      lastActiveAt: binding.lastActiveAt,
      generation: binding.generation,
    }));

    const workspace = this.workspace();
    return {
      workspace: workspace.path,
      workspaceSource: workspace.source,
      agentPreset: this.config.agentPreset,
      sessionMode: this.config.sessionMode,
      allowFrom: this.config.allowFrom,
      accounts,
      peers,
      logFile: logger.getLogFilePath(),
    };
  }
}
