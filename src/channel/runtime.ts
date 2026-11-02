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
import { handleInboundMessage } from "./handle-message.js";
import { createConfigManager, createMonitorStatus, monitorWeixinAccount } from "./monitor.js";
import type { MonitorStatus } from "./monitor.js";
import { AccountSender } from "./outbound.js";
import { AgentSessionManager, PeerSessionStore } from "./peer-session.js";
import type { PeerBinding } from "./peer-session.js";
import { TurnTracker } from "./turn-tracker.js";

/**
 * The channel itself: one long-poll monitor per logged-in WeChat account, all
 * of them feeding the same agent-session machinery.
 *
 * Mounting the plugin does not start anything by itself — {@link start} waits
 * for the harness Loader to settle, then reconciles the accounts found on disk.
 * A later QR login re-runs the same reconcile through `onAccountsChanged`.
 */

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

/** Everything the status route and `weixin_status` tool report. */
export interface ChannelSnapshot {
  workspace: string;
  agentPreset: string | undefined;
  sessionMode: string;
  allowFrom: readonly string[];
  accounts: AccountSnapshot[];
  peers: PeerBinding[];
  logFile: string;
}

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
    });
    this.stopWatchingAccounts = onAccountsChanged(() => this.scheduleReconcile());
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
    logger.info(
      `runtime: starting with ${accounts.length} account(s); workspace=${this.config.workspace}; preset=${this.config.agentPreset ?? "deployment default"}`,
    );

    if (accounts.length === 0) {
      logger.info(
        "runtime: no WeChat account is logged in yet — open the login page in DSH to scan the QR code",
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
        `runtime: account ${normalized} has no token — log in again from the DSH login page`,
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

    return {
      workspace: this.config.workspace,
      agentPreset: this.config.agentPreset,
      sessionMode: this.config.sessionMode,
      allowFrom: this.config.allowFrom,
      accounts,
      peers: this.store.list().slice(0, 50),
      logFile: logger.getLogFilePath(),
    };
  }
}
