import os from "node:os";

import type { WeixinChannelConfig } from "../config.js";
import type { AgentLike, HostServices } from "../dsh/services.js";
import { channelVersion } from "../protocol/api/api.js";
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
import type {
  AccountSnapshot,
  ChannelSnapshot,
  DirectoryListingPayload,
  MpAccount,
  MpFilePayload,
  MpFsPayload,
  MpHelloPayload,
  MpMachine,
  MpMessagesPayload,
  MpMessagesRequest,
  MpNewSessionPayload,
  MpNewSessionRequest,
  MpPeer,
  MpPreset,
  MpStatePayload,
  PeerSnapshot,
  SessionSettingsPayload,
  SessionSettingsRequest,
  WorkspacePayload,
} from "../shared/wire.js";
import type { WeixinToolOptIn, ToolExposure } from "../tools/optin.js";
import { handleInboundMessage } from "./handle-message.js";
import { createConfigManager, createMonitorStatus, monitorWeixinAccount } from "./monitor.js";
import type { MonitorStatus } from "./monitor.js";
import { AccountSender } from "./outbound.js";
import { AgentSessionManager, PeerSessionStore } from "./peer-session.js";
import { RecentMessageStore } from "./recent.js";
import {
  WeixinSettingsStore,
  inspectWorkspace,
  listDirectories,
  listEntries,
  prepareWorkspace,
  readTextFile,
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
  /** Bounded transcript of each conversation, for the mini program. */
  readonly recent = new RecentMessageStore();

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
      defaultAgentPreset: () => this.sessionDefaults().agentPreset,
      defaultPermissionPreset: () => this.sessionDefaults().permissionPreset,
      applyPermissionPreset: (sessionId, agent, preset) =>
        this.applyPermissionPreset(sessionId, agent, preset),
      onAgentReady: (sessionId) => this.enableToolsForChannelSession(sessionId),
    });
    this.stopWatchingAccounts = onAccountsChanged(() => this.scheduleReconcile());
  }

  /**
   * The agent preset and permission level new WeChat sessions start with.
   *
   * Resolution order per field: what the user chose in the sidebar tab, then the
   * Loader row's value. A conversation-level preset already on file outranks the
   * agent preset (see {@link AgentSessionManager}); nothing outranks the
   * permission choice, because a session's permission is only ever set when it
   * is created.
   */
  sessionDefaults(): { agentPreset: string | undefined; permissionPreset: string | undefined } {
    return {
      agentPreset: this.settings.agentPreset ?? this.config.agentPreset,
      permissionPreset: this.settings.permissionPreset ?? this.config.permissionPreset,
    };
  }

  /**
   * Record a permission preset on a freshly created session.
   *
   * Mirrors the official channel plugins: validate the name first, then `set`
   * once the session exists, which writes the durable `permission/preset` fact
   * plus the sandbox and approval knobs together.
   *
   * @param sessionId - the session being initialized (for error reporting).
   * @param agent - its live agent; `agent.session` is the real Session.
   * @param preset - permission preset key.
   * @throws {Error} when the profile has no permission service or the name is unknown.
   */
  private applyPermissionPreset(sessionId: string, agent: AgentLike, preset: string): void {
    const permissions = this.deps.services.permissionPresets;
    if (permissions === undefined) {
      throw new Error("这个部署没有挂载 permissionPresets，无法设置权限等级");
    }
    // Throws for an unknown name, before anything is written to the session.
    permissions.resolve(preset);
    permissions.set(agent.session, preset);
    logger.info(`runtime: session ${sessionId} starts under permission preset ${preset}`);
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
   * The agent preset and permission level new WeChat sessions start with, plus
   * the two lists to pick from.
   *
   * The preset list is the same roster the mini program uses, which is the
   * registry's view: presets published by the「Agent预设」editor show up here as
   * soon as the editor saves them, with no plugin-specific plumbing.
   */
  async sessionSettings(): Promise<SessionSettingsPayload> {
    const defaults = this.sessionDefaults();
    const presets = await this.mpPresets();
    const permissions = this.deps.services.permissionPresets;
    const catalog = permissions?.catalog();
    const notes: string[] = [];
    if (permissions === undefined) notes.push("这个部署没有挂载 permissionPresets，权限等级只能跟随部署默认。");
    if (presets.length === 0) {
      notes.push("注册表里没有任何已发布的 Agent 预设（在「Agent预设」插件里保存并发布后会出现在这里）。");
    }

    return {
      ok: true,
      agentPreset: defaults.agentPreset ?? null,
      permissionPreset: defaults.permissionPreset ?? null,
      defaultPermission: catalog?.defaultPreset ?? null,
      presets,
      permissions: catalog?.options ?? [],
      ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
    };
  }

  /**
   * Change the defaults new WeChat sessions start with.
   *
   * Both values are validated against the live catalogs before anything is
   * persisted, so a typo cannot leave the channel pointing at a preset that will
   * fail to compose a session later.
   *
   * @param input - fields to change; omitted fields keep their current value.
   * @returns the settings after the change.
   * @throws {Error} when a name is unknown; the message is user-facing.
   */
  async setSessionSettings(input: SessionSettingsRequest): Promise<SessionSettingsPayload> {
    if (input.agentPreset !== undefined) {
      const wanted = input.agentPreset === null ? "" : input.agentPreset.trim();
      if (wanted === "") {
        this.settings.agentPreset = undefined;
      } else if (wanted === "none") {
        this.settings.agentPreset = "none";
      } else {
        const registry = this.deps.services.agentPresets;
        if (registry === undefined) throw new Error("这个部署没有挂载 agentPresets，无法选择预设");
        try {
          await registry.resolve(wanted);
        } catch {
          const known = (await this.mpPresets()).map((preset) => preset.id).join("、");
          throw new Error(`没有这个 Agent 预设：${wanted}${known === "" ? "" : `（可选：${known}）`}`);
        }
        this.settings.agentPreset = wanted;
      }
    }

    if (input.permissionPreset !== undefined) {
      const wanted = input.permissionPreset === null ? "" : input.permissionPreset.trim();
      if (wanted === "") {
        this.settings.permissionPreset = undefined;
      } else {
        const permissions = this.deps.services.permissionPresets;
        if (permissions === undefined) throw new Error("这个部署没有挂载 permissionPresets，无法选择权限等级");
        try {
          permissions.resolve(wanted);
        } catch {
          const known = permissions.catalog().options.map((option) => option.value).join("、");
          throw new Error(`没有这个权限预设：${wanted}${known === "" ? "" : `（可选：${known}）`}`);
        }
        this.settings.permissionPreset = wanted;
      }
    }

    const defaults = this.sessionDefaults();
    logger.info(
      `runtime: session defaults set to agentPreset=${defaults.agentPreset ?? "(config)"} ` +
        `permissionPreset=${defaults.permissionPreset ?? "(config)"}`,
    );
    return this.sessionSettings();
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
    this.recent.close();
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
    // The transcript mirrors what the peer actually received, so it records on
    // the way out as well as on the way in.
    const sender = new AccountSender(account, account.cdnBaseUrl, (to, text) => {
      this.recent.record(account.accountId, to, "assistant", text);
    });
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
          record: (accountId, peerId, role, text) => {
            this.recent.record(accountId, peerId, role, text);
          },
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
      accountId: binding.accountId,
      peerId: binding.peerId,
      sessionId: binding.sessionId,
      lastActiveAt: binding.lastActiveAt,
      generation: binding.generation,
      ...(binding.preset === undefined ? {} : { preset: binding.preset }),
    }));

    const workspace = this.workspace();
    const defaults = this.sessionDefaults();
    return {
      workspace: workspace.path,
      workspaceSource: workspace.source,
      agentPreset: defaults.agentPreset,
      permissionPreset: defaults.permissionPreset,
      sessionMode: this.config.sessionMode,
      allowFrom: this.config.allowFrom,
      accounts,
      peers,
      logFile: logger.getLogFilePath(),
    };
  }

  // -------------------------------------------------------------------------
  // Mini-program API
  // -------------------------------------------------------------------------

  /** Identity of this machine, so several computers can be told apart. */
  machineInfo(): MpMachine {
    return {
      hostname: os.hostname() || "unknown",
      platform: `${process.platform}/${process.arch}`,
      node: process.versions.node,
      channelVersion: channelVersion(),
    };
  }

  /** Accounts in the shape the mini program renders. */
  mpAccounts(): MpAccount[] {
    return this.snapshot().accounts.map((account) => ({
      accountId: account.accountId,
      ...(account.name === undefined ? {} : { name: account.name }),
      running: account.running,
      ...(account.ownerUserId === undefined ? {} : { ownerUserId: account.ownerUserId }),
      inboundCount: account.inboundCount,
      ...(account.lastInboundAt === undefined ? {} : { lastInboundAt: account.lastInboundAt }),
      ...(account.lastError === undefined ? {} : { lastError: account.lastError }),
    }));
  }

  /** Whether a monitor is up, for the "started at" line. */
  startedAt(): number {
    let earliest = 0;
    for (const runtime of this.running.values()) {
      const at = runtime.status.startedAt;
      if (at > 0 && (earliest === 0 || at < earliest)) earliest = at;
    }
    return earliest;
  }

  /** `GET /mp/hello` */
  mpHello(): MpHelloPayload {
    const workspace = this.workspacePayload();
    return {
      ok: true,
      machine: this.machineInfo(),
      workspace: {
        path: workspace.path,
        source: workspace.source,
        writable: workspace.writable,
      },
      accounts: this.mpAccounts(),
      startedAt: this.startedAt(),
    };
  }

  /**
   * Agent presets the mini program may choose from.
   *
   * A profile without a preset registry reports an empty list, and the app then
   * hides the preset picker instead of offering choices that cannot work.
   */
  async mpPresets(): Promise<MpPreset[]> {
    const service = this.deps.services.agentPresets;
    if (service === undefined) return [];

    try {
      // The roster first: it carries the `isDefault` marker and the activation
      // failures. `list()` is the fallback and returns a bare array, so it is
      // read as one rather than as a roster object.
      if (service.remoteExportList !== undefined) {
        const roster = await service.remoteExportList();
        return roster.presets.map((preset) => ({
          id: preset.id,
          isDefault: preset.isDefault,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
          ...(preset.broken === undefined ? {} : { broken: preset.broken }),
        }));
      }

      if (service.list !== undefined) {
        const presets = await service.list();
        const defaultId = service.defaultId;
        return presets.map((preset) => ({
          id: preset.id,
          isDefault: defaultId !== undefined && defaultId === preset.id,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
          ...(preset.broken === undefined ? {} : { broken: preset.broken }),
        }));
      }

      return [];
    } catch (err) {
      logger.warn(`presets: could not read the roster: ${String(err)}`);
      return [];
    }
  }

  /** `GET /mp/state` — everything the dashboard needs in one round trip. */
  async mpState(): Promise<MpStatePayload> {
    const workspace = this.workspacePayload();
    const presets = await this.mpPresets();
    const peers: MpPeer[] = this.store.list().map((binding) => ({
      accountId: binding.accountId,
      peerId: binding.peerId,
      sessionId: binding.sessionId,
      generation: binding.generation,
      lastActiveAt: binding.lastActiveAt,
      running: this.sessions.isRunning(binding),
      ...(binding.preset === undefined ? {} : { preset: binding.preset }),
    }));

    return {
      ok: true,
      machine: this.machineInfo(),
      workspace: {
        path: workspace.path,
        source: workspace.source,
        exists: workspace.exists,
        writable: workspace.writable,
      },
      ...(this.config.agentPreset === undefined ? {} : { defaultPreset: this.config.agentPreset }),
      presets,
      peers,
      accounts: this.mpAccounts(),
    };
  }

  /** `GET /mp/fs?path=` — directories **and** files, metadata only. */
  mpEntries(target?: string): MpFsPayload {
    const path = target === undefined || target.trim() === "" ? this.workspace().path : target;
    const listing = listEntries(path);
    if ("error" in listing) throw new Error(listing.error);
    return {
      ok: true,
      path: listing.path,
      parent: listing.parent,
      entries: listing.entries,
      truncated: listing.truncated,
      ...(listing.skipped === 0 ? {} : { skipped: listing.skipped }),
    };
  }

  /**
   * Start a fresh conversation for one WeChat peer, optionally with a new preset.
   *
   * DSH freezes a session's composition once its first turn has run, so
   * "change this conversation's preset" is necessarily "start a new conversation
   * with that preset". The old agent is disposed first, so nothing keeps running
   * against the old composition.
   *
   * @param request.peerId - the WeChat id of the person.
   * @param request.accountId - bot account; inferred when exactly one is logged in.
   * @param request.preset - a preset id, `"none"` for a bare agent, `""` to fall
   *   back to the channel default, or omitted to keep the current choice.
   * @throws {Error} when the account or preset cannot be used; the message is
   *   user-facing.
   */
  async mpNewSession(request: MpNewSessionRequest): Promise<MpNewSessionPayload> {
    const peerId = request.peerId?.trim() ?? "";
    if (peerId === "") throw new Error("peerId 不能为空");

    const accountId = this.resolveAccountId(request.accountId);
    const previous = this.store.resolve(accountId, peerId);

    let presetOption: { preset?: string | null } | undefined;
    if (request.preset !== undefined) {
      const preset = request.preset.trim();
      if (preset === "") {
        presetOption = { preset: null };
      } else if (preset === "none") {
        presetOption = { preset: "none" };
      } else {
        const presets = await this.mpPresets();
        const known = presets.find((candidate) => candidate.id === preset);
        if (known === undefined) {
          throw new Error(`没有这个 Agent 预设：${preset}`);
        }
        if (known.broken !== undefined) {
          throw new Error(`这个预设当前不可用：${known.broken}`);
        }
        presetOption = { preset: known.id };
      }
    }

    // Release the running conversation before its session id stops being current.
    await this.sessions.disposeBinding(previous);
    const binding = this.store.reset(accountId, peerId, presetOption);

    logger.info(
      `mp: new session for ${accountId}/${peerId} (${previous.sessionId} -> ${binding.sessionId}${binding.preset === undefined ? "" : `, preset=${binding.preset}`})`,
    );

    return {
      ok: true,
      accountId,
      peerId,
      sessionId: binding.sessionId,
      ...(binding.preset === undefined ? {} : { preset: binding.preset }),
      previousSessionId: previous.sessionId,
    };
  }

  /**
   * Pick the account a peer belongs to.
   *
   * @param requested - an explicit account id, when the app sent one.
   * @throws {Error} when the id is unknown or there is nothing to infer from.
   */
  private resolveAccountId(requested: string | undefined): string {
    const wanted = requested?.trim();
    if (wanted !== undefined && wanted !== "") {
      const normalized = normalizeWeixinAccountId(wanted);
      if (!this.running.has(normalized) && listWeixinAccountIds().length === 0) {
        throw new Error(`这个机器上没有已登录的微信账号：${wanted}`);
      }
      return normalized;
    }

    const running = this.runningAccountIds();
    if (running.length === 1) return running[0] as string;
    if (running.length > 1) {
      throw new Error(`这台机器登录了多个微信账号（${running.join("、")}），请指定 accountId`);
    }
    const indexed = listWeixinAccountIds();
    if (indexed.length === 1) return normalizeWeixinAccountId(indexed[0] as string);
    if (indexed.length === 0) throw new Error("这台机器还没有登录任何微信账号");
    throw new Error(`这台机器登录了多个微信账号（${indexed.join("、")}），请指定 accountId`);
  }

  // -------------------------------------------------------------------------
  // Mini-program: conversation transcript and text preview
  // -------------------------------------------------------------------------

  /**
   * `GET /mp/messages` — the transcript this channel kept for one conversation.
   *
   * @param request.peerId - the WeChat id.
   * @param request.accountId - bot account; inferred when only one is logged in.
   * @param request.limit - how many of the newest lines to return (1–40).
   */
  mpMessages(request: MpMessagesRequest): MpMessagesPayload {
    const peerId = request.peerId?.trim() ?? "";
    if (peerId === "") throw new Error("peerId 不能为空");
    const accountId = this.resolveAccountId(request.accountId);
    const limit = request.limit === undefined ? 20 : request.limit;
    const messages = this.recent.list(accountId, peerId, limit).map((message) => ({
      role: message.role,
      text: message.text,
      at: message.at,
    }));
    return { ok: true, accountId, peerId, messages };
  }

  /**
   * `GET /mp/file` — a bounded text preview of one file inside the workspace.
   *
   * The containment rule lives in {@link readTextFile}; this only turns its error
   * into an exception the route reports as a 400.
   */
  mpReadFile(target: string | undefined): MpFilePayload {
    const wanted = target?.trim() ?? "";
    if (wanted === "") throw new Error("path 不能为空");
    const preview = readTextFile(this.workspace().path, wanted);
    if ("error" in preview) throw new Error(preview.error);
    return {
      ok: true,
      path: preview.path,
      name: preview.name,
      size: preview.size,
      truncated: preview.truncated,
      text: preview.text,
    };
  }
}
