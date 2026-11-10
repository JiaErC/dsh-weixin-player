import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { WeixinChannelConfig } from "../config.js";
import type {
  AgentHandleLike,
  AgentLike,
  HostServices,
  ModelSelectionLike,
} from "../dsh/services.js";
import { resolveWeixinStateDir } from "../protocol/storage/state-dir.js";
import { logger } from "../protocol/util/logger.js";
import type { TurnOutcome } from "./turn-tracker.js";

/**
 * Peer → DSH session binding, and the agent driving one conversation.
 *
 * One WeChat direct chat maps to exactly one DSH session so the agent keeps
 * context across messages and the conversation shows up in the DSH session list
 * like any other. The session id is derived from (account, peer) so it is
 * stable across restarts without needing the map to survive — the map exists
 * for introspection and for `/new`.
 */

/** One persisted binding. */
export interface PeerBinding {
  accountId: string;
  peerId: string;
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  /** Bumped by `/new`; part of the derived session id. */
  generation: number;
  /**
   * Agent preset this conversation's sessions compose.
   *
   * Absent means "whatever the channel config says". DSH locks a session's
   * composition once its first turn starts, so choosing a preset here applies to
   * the *next* session of this conversation — which is exactly what "换预设"
   * does: it starts a fresh conversation with the new composition.
   */
  preset?: string;
}

interface PeerFile {
  version: 1;
  bindings: Array<{ key: string; binding: PeerBinding }>;
}

function peerKey(accountId: string, peerId: string): string {
  return `${accountId}\u0000${peerId}`;
}

/** Stable, filesystem-safe session id for one conversation. */
function deriveSessionId(accountId: string, peerId: string, generation: number): string {
  const digest = createHash("sha256")
    .update(`${accountId}\u0000${peerId}\u0000${generation}`)
    .digest("hex")
    .slice(0, 12);
  return `session-weixin-${digest}`;
}

function storePath(): string {
  return path.join(resolveWeixinStateDir(), "peers.json");
}

/** Persisted map of WeChat conversations to DSH sessions. */
export class PeerSessionStore {
  private readonly bindings = new Map<string, PeerBinding>();
  private loaded = false;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(storePath(), "utf-8");
      const parsed = JSON.parse(raw) as PeerFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return;
      for (const entry of parsed.bindings) {
        if (typeof entry?.key !== "string" || typeof entry.binding?.sessionId !== "string") continue;
        this.bindings.set(entry.key, entry.binding);
      }
      logger.debug(`peer-sessions: loaded ${this.bindings.size} bindings`);
    } catch {
      // No map yet: every peer starts on its derived id.
    }
  }

  private persist(): void {
    const payload: PeerFile = {
      version: 1,
      bindings: [...this.bindings.entries()].map(([key, binding]) => ({ key, binding })),
    };
    try {
      fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
      fs.writeFileSync(storePath(), JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      logger.warn(`peer-sessions: failed to persist: ${String(err)}`);
    }
  }

  /** Binding for one conversation, created on first use. */
  resolve(accountId: string, peerId: string): PeerBinding {
    this.load();
    const key = peerKey(accountId, peerId);
    const existing = this.bindings.get(key);
    if (existing !== undefined) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const binding: PeerBinding = {
      accountId,
      peerId,
      sessionId: deriveSessionId(accountId, peerId, 0),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      generation: 0,
    };
    this.bindings.set(key, binding);
    this.persist();
    logger.info(`peer-sessions: bound ${accountId}/${peerId} -> ${binding.sessionId}`);
    return binding;
  }

  /**
   * Start a fresh conversation for one peer; returns the new binding.
   *
   * @param options.preset - a preset id to adopt, `null` to clear a previously
   *   chosen one, or omitted to carry the current choice over. Carrying it over
   *   is what makes `/new` behave: the conversation keeps its composition, only
   *   the history is dropped.
   */
  reset(
    accountId: string,
    peerId: string,
    options?: { preset?: string | null },
  ): PeerBinding {
    this.load();
    const key = peerKey(accountId, peerId);
    const previous = this.bindings.get(key);
    const generation = (previous?.generation ?? 0) + 1;
    const preset =
      options === undefined
        ? previous?.preset
        : options.preset === null
          ? undefined
          : options.preset;
    const binding: PeerBinding = {
      accountId,
      peerId,
      sessionId: deriveSessionId(accountId, peerId, generation),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      generation,
      ...(preset === undefined ? {} : { preset }),
    };
    this.bindings.set(key, binding);
    this.persist();
    logger.info(
      `peer-sessions: reset ${accountId}/${peerId} -> ${binding.sessionId}${preset === undefined ? "" : ` (preset=${preset})`}`,
    );
    return binding;
  }

  /**
   * Record the preset a conversation's next session must compose.
   *
   * @param preset - a preset id, or null to fall back to the channel default.
   */
  setPreset(accountId: string, peerId: string, preset: string | null): PeerBinding {
    const binding = this.resolve(accountId, peerId);
    if (preset === null) delete binding.preset;
    else binding.preset = preset;
    this.persist();
    return binding;
  }

  /** Every binding, newest activity first. */
  list(): PeerBinding[] {
    this.load();
    return [...this.bindings.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
}

/** What one inbound batch needs from the caller. */
export interface RunTurnRequest {
  binding: PeerBinding;
  content: Array<Record<string, unknown>>;
  /** Where the message came from, recorded in the session log. */
  source: Record<string, unknown>;
}

/** Dependencies of {@link AgentSessionManager}. */
export interface AgentSessionDeps {
  services: HostServices;
  config: WeixinChannelConfig;
  tracker: { begin(sessionId: string): Promise<TurnOutcome>; abort(sessionId: string): void };
  /**
   * Working directory for a newly created session, read per call.
   *
   * A function rather than a string because the user may change the channel's
   * workspace from the sidebar tab while the channel is running; the next
   * conversation must pick up the new value without a restart.
   */
  workspace: () => string;
  /**
   * Channel-wide agent preset, read per call.
   *
   * A conversation-level choice (`binding.preset`, set from the mini program)
   * outranks it; the tab's default decides for every other conversation.
   */
  defaultAgentPreset?: () => string | undefined;
  /**
   * Permission preset for *newly created* sessions, read per call.
   *
   * Resumed sessions keep the permission facts in their own log: re-applying a
   * preset there would silently widen or narrow a conversation the user did not
   * ask to change.
   */
  defaultPermissionPreset?: () => string | undefined;
  /**
   * Record a permission preset on a freshly created session.
   *
   * The host seam (it needs the real `Session` and the permission service), so
   * the manager stays free of `@deepseek-ai/*` imports.
   */
  applyPermissionPreset?: (sessionId: string, agent: AgentLike, preset: string) => void;
  /**
   * Called once per newly created or resumed agent, before its first turn.
   *
   * The channel uses it to give its own conversations the WeChat tools without
   * touching any agent preset.
   */
  onAgentReady?: (sessionId: string, agent: AgentLike) => void;
}

/**
 * Creates, resumes and drives the agent behind one conversation.
 *
 * Turns for the same session are serialized: WeChat users send bursts, and two
 * concurrent `followup()` calls would interleave into one turn.
 */
export class AgentSessionManager {
  private readonly handles = new Map<string, AgentHandleLike>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly presets = new Map<string, { id: string }>();

  constructor(private readonly deps: AgentSessionDeps) {}

  private get agents() {
    const agents = this.deps.services.agents;
    if (agents === undefined) {
      throw new Error("dsh-weixin: the `agents` service is missing from this DSH profile");
    }
    return agents;
  }

  private agentOptions(): { provider: string; model: string; reasoningEffort?: string } {
    const service = this.deps.services.agentDefaultModel;
    if (service === undefined) {
      throw new Error("dsh-weixin: the `agentDefaultModel` service is missing from this DSH profile");
    }
    const selection: ModelSelectionLike = service.currentSelection();
    if (typeof selection.provider !== "string" || typeof selection.model !== "string") {
      throw new Error("dsh-weixin: the deployment default model is not configured");
    }
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort }),
    };
  }

  /**
   * Resolve the agent preset this conversation composes.
   *
   * Mirrors the harness's own `composeAgent`: resolve the id first, then mount
   * the preset inside the unpublished setup callback so the agent's tools and
   * prompt sections exist before its first turn.
   */
  private async composition(binding: PeerBinding): Promise<{
    agentPreset: string | undefined;
    setup: (agentCtx: unknown, agent: AgentLike) => void | Promise<void>;
  }> {
    // A conversation-level choice wins over the channel-wide one, so the mini
    // program can give one WeChat chat its own preset without touching others.
    const requested = binding.preset ?? this.deps.defaultAgentPreset?.() ?? this.deps.config.agentPreset;
    if (requested === "none") {
      return { agentPreset: undefined, setup: () => {} };
    }

    const presets = this.deps.services.agentPresets;
    if (presets === undefined) {
      if (requested !== undefined) {
        logger.warn("dsh-weixin: agentPreset is set but this profile has no agent preset registry");
      }
      return { agentPreset: undefined, setup: () => {} };
    }

    const cached = requested === undefined ? undefined : this.presets.get(requested);
    const resolved = cached ?? (await presets.resolve(requested));
    if (requested !== undefined && cached === undefined) this.presets.set(requested, resolved);

    return {
      agentPreset: resolved.id,
      setup: async (agentCtx, _agent) => {
        await presets.mount(agentCtx, resolved.id);
      },
    };
  }

  /** True when a persisted session exists under this id. */
  private async isPersisted(sessionId: string): Promise<boolean> {
    const query = this.deps.services.sessionQuery;
    if (query === undefined) return false;
    try {
      await query.observeSession(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the live agent for a binding, creating or resuming as needed. */
  private async ensureAgent(binding: PeerBinding): Promise<AgentLike> {
    const live = this.agents.get(binding.sessionId);
    if (live !== undefined) {
      this.notifyReady(binding.sessionId, live);
      return live;
    }

    const composition = await this.composition(binding);
    const agentOptions = this.agentOptions();
    const cwd = this.deps.workspace();

    if (await this.isPersisted(binding.sessionId)) {
      const handle = await this.agents.resume({
        resumeSessionId: binding.sessionId,
        agentOptions,
        setup: composition.setup,
      });
      this.handles.set(binding.sessionId, handle);
      logger.info(`agent-session: resumed ${binding.sessionId}`);
      this.notifyReady(binding.sessionId, handle.agent);
      return handle.agent;
    }

    const handle = await this.agents.create({
      sessionId: binding.sessionId,
      meta: {
        cwd,
        ...(composition.agentPreset === undefined
          ? {}
          : { agentPreset: composition.agentPreset }),
      },
      agentOptions,
      setup: composition.setup,
    });
    this.handles.set(binding.sessionId, handle);

    // A brand-new session starts on the channel's permission preset. This runs
    // after `create` (the session must exist to record the durable fact) and
    // before the first turn, so no tool call ever runs under the wrong bundle.
    const permissionPreset = this.deps.defaultPermissionPreset?.();
    if (permissionPreset !== undefined && permissionPreset !== "") {
      try {
        this.deps.applyPermissionPreset?.(binding.sessionId, handle.agent, permissionPreset);
      } catch (err) {
        logger.warn(
          `agent-session: permission preset ${permissionPreset} was not applied to ` +
            `${binding.sessionId}: ${String(err)}`,
        );
      }
    }

    logger.info(
      `agent-session: created ${binding.sessionId} (preset=${composition.agentPreset ?? "none"}, ` +
        `permission=${permissionPreset ?? "deployment default"}, cwd=${cwd})`,
    );
    this.notifyReady(binding.sessionId, handle.agent);
    return handle.agent;
  }

  /** Announce a ready agent to the channel (tool opt-in, bookkeeping). */
  private notifyReady(sessionId: string, agent: AgentLike): void {
    try {
      this.deps.onAgentReady?.(sessionId, agent);
    } catch (err) {
      logger.warn(`agent-session: onAgentReady failed for ${sessionId}: ${String(err)}`);
    }
  }

  /** Run one turn for a binding, serialized behind earlier turns. */
  async runTurn(request: RunTurnRequest): Promise<TurnOutcome> {
    const sessionId = request.binding.sessionId;
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.drive(request));

    this.queues.set(
      sessionId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );

    return current;
  }

  private async drive(request: RunTurnRequest): Promise<TurnOutcome> {
    const agent = await this.ensureAgent(request.binding);
    const pending = this.deps.tracker.begin(request.binding.sessionId);

    const message = {
      id: randomUUID(),
      role: "user",
      content: request.content,
      source: request.source,
    };
    freeze(message);

    try {
      agent.followup(message);
    } catch (err) {
      this.deps.tracker.abort(request.binding.sessionId);
      throw err;
    }

    const outcome = await pending;
    try {
      await this.deps.services.sessions?.flush(agent.session);
    } catch (err) {
      logger.warn(`agent-session: session flush failed for ${request.binding.sessionId}: ${String(err)}`);
    }
    return outcome;
  }

  /** Cancel the running turn for a binding, keeping queued work. */
  cancel(binding: PeerBinding): boolean {
    const agent = this.agents.get(binding.sessionId);
    if (agent === undefined) return false;
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return true;
  }

  /** Is a turn currently running for this binding? */
  isRunning(binding: PeerBinding): boolean {
    return this.agents.get(binding.sessionId)?.status === "running";
  }

  /** Drop the live agent for a binding (used by `/new`). */
  async disposeBinding(binding: PeerBinding): Promise<void> {
    const handle = this.handles.get(binding.sessionId);
    this.handles.delete(binding.sessionId);
    this.queues.delete(binding.sessionId);
    if (handle === undefined) return;
    try {
      await handle.dispose();
    } catch (err) {
      logger.warn(`agent-session: dispose failed for ${binding.sessionId}: ${String(err)}`);
    }
  }

  /** Dispose every agent this manager owns. */
  async close(): Promise<void> {
    for (const [sessionId, handle] of [...this.handles]) {
      this.handles.delete(sessionId);
      try {
        await handle.dispose();
      } catch (err) {
        logger.warn(`agent-session: dispose failed for ${sessionId}: ${String(err)}`);
      }
    }
    this.queues.clear();
  }
}

/** Deep-freeze a message exactly like the harness message factories do. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
