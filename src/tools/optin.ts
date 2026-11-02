import fs from "node:fs";
import path from "node:path";

import type {
  AgentLike,
  Disposer,
  HostContext,
  HostServices,
  ToolDefinitionLike,
  ToolsService,
} from "../dsh/services.js";
import { resolveWeixinStateDir } from "../protocol/storage/state-dir.js";
import { logger } from "../protocol/util/logger.js";
import { WEIXIN_TOOL_NAMES } from "../shared/wire.js";

/**
 * Per-session exposure of the channel's agent tools.
 *
 * The tools must be available in exactly the conversations the user asked for —
 * and to nothing else. DSH's tool registry has one mechanism for that: a
 * registration made through an agent's own scoped context is visible to that
 * agent only, which is how preset rows give each session its own set. So this
 * class keeps an **opt-in set of session ids** and materializes each entry by
 * registering the definitions on that session's live agent context.
 *
 * Consequences worth stating explicitly:
 *  - No agent preset is modified. The session's composition is whatever the
 *    preset declared; these registrations are an overlay on top of it.
 *  - The choice is per session and survives a restart (it is persisted next to
 *    the credentials), and it applies to any preset the session runs.
 *  - A registration only reaches the model from the next request: the tool
 *    schema of an in-flight step is already frozen.
 */

/** Where the opt-in set is persisted. */
function optInPath(): string {
  return path.join(resolveWeixinStateDir(), "tool-optins.json");
}

interface OptInFile {
  version: 1;
  /** Sessions the tools are exposed to. */
  sessions: string[];
  /**
   * Sessions a user explicitly switched off.
   *
   * Kept apart from "not listed in `sessions`" because the channel auto-enables
   * its own WeChat conversations: without this list, turning the tools off for
   * one of them would be undone by the next message.
   */
  declined?: string[];
}

/** Answer for the tab's toggle and the `weixin_status` summary. */
export interface ToolExposure {
  sessionId: string;
  enabled: boolean;
  applied: boolean;
  tools: readonly string[];
  note?: string;
}

/** Dependencies of {@link WeixinToolOptIn}. */
export interface ToolOptInDeps {
  ctx: HostContext;
  services: HostServices;
  definitions: readonly ToolDefinitionLike[];
}

/**
 * Read the tools registry out of an agent's scoped context.
 *
 * Property access is the documented shape (`agent.ctx.tools`); `get()` is the
 * fallback for a context object that only exposes the service accessor.
 */
function toolsOf(agentCtx: unknown): ToolsService | undefined {
  if (agentCtx === undefined || agentCtx === null) return undefined;
  const direct = (agentCtx as { tools?: ToolsService }).tools;
  if (direct !== undefined) return direct;
  const getter = (agentCtx as { get?: (name: string) => unknown }).get;
  if (typeof getter !== "function") return undefined;
  return getter.call(agentCtx, "tools") as ToolsService | undefined;
}

/** Owns the opt-in set and the scoped registrations that realize it. */
export class WeixinToolOptIn {
  private readonly enabled = new Set<string>();
  /** Sessions a user turned off; the channel must not auto-enable these again. */
  private readonly declined = new Set<string>();
  private readonly registrations = new Map<string, Disposer[]>();
  private readonly live = new Map<string, AgentLike>();
  private unsubscribe: Disposer | undefined;
  private loaded = false;

  constructor(private readonly deps: ToolOptInDeps) {}

  /** Every tool name this manager can expose. */
  get toolNames(): readonly string[] {
    return WEIXIN_TOOL_NAMES;
  }

  /**
   * Load the persisted set and start following agent lifecycles.
   *
   * Sessions that are already live (a plugin reload, or a session started
   * before this manager) are attached immediately.
   */
  start(): void {
    this.load();
    this.unsubscribe = this.deps.ctx.on("agent/created", ((payload: unknown) => {
      const agent = (payload as { agent?: AgentLike } | undefined)?.agent;
      if (agent !== undefined) this.attach(agent);
    }) as never);

    for (const agent of this.deps.services.agents?.list?.() ?? []) this.attach(agent);
  }

  /** Is this session opted in? */
  isEnabled(sessionId: string): boolean {
    return this.enabled.has(sessionId);
  }

  /** Did a user explicitly switch this session off? */
  isDeclined(sessionId: string): boolean {
    return this.declined.has(sessionId);
  }

  /**
   * Opt a session in or out.
   *
   * Enabling clears a previous decline, so an explicit "on" always wins.
   *
   * @returns the resulting exposure, including whether it is live right now.
   * @throws {Error} when the session id is blank.
   */
  setEnabled(sessionId: string, enabled: boolean): ToolExposure {
    const id = sessionId.trim();
    if (id === "") throw new Error("dsh-weixin: sessionId is required");

    if (enabled) {
      this.enabled.add(id);
      this.declined.delete(id);
    } else {
      this.enabled.delete(id);
      this.declined.add(id);
      this.detach(id);
    }
    this.persist();

    const agent = this.live.get(id) ?? this.deps.services.agents?.get?.(id);
    if (enabled && agent !== undefined) this.attach(agent);

    return this.exposure(id);
  }

  /** Attach a live agent whose session is opted in. */
  attach(agent: AgentLike): void {
    const sessionId = agent.session?.id ?? agent.id;
    if (typeof sessionId !== "string") return;
    this.live.set(sessionId, agent);
    if (!this.enabled.has(sessionId)) return;
    if (this.registrations.has(sessionId)) return;

    const tools = toolsOf(agent.ctx);
    if (tools === undefined) {
      logger.warn(
        `tool-optin: session ${sessionId} is opted in but has no tool registry in its scope`,
      );
      return;
    }

    const disposers: Disposer[] = [];
    for (const definition of this.deps.definitions) {
      try {
        disposers.push(tools.register(definition as never));
      } catch (err) {
        logger.error(
          `tool-optin: failed to register ${definition.name} for ${sessionId}: ${String(err)}`,
        );
      }
    }
    if (disposers.length > 0) {
      this.registrations.set(sessionId, disposers);
      logger.info(
        `tool-optin: session ${sessionId} now sees ${disposers.length} weixin tool(s)`,
      );
    }
  }

  /** Drop a session's registrations (disable), leaving the agent alive. */
  private detach(sessionId: string): void {
    const disposers = this.registrations.get(sessionId);
    if (disposers === undefined) return;
    this.registrations.delete(sessionId);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (err) {
        logger.warn(`tool-optin: disposer failed for ${sessionId}: ${String(err)}`);
      }
    }
    logger.info(`tool-optin: session ${sessionId} no longer sees the weixin tools`);
  }

  /** Current exposure of one session. */
  exposure(sessionId: string): ToolExposure {
    const id = sessionId.trim();
    const enabled = this.enabled.has(id);
    const applied = this.registrations.has(id);
    return {
      sessionId: id,
      enabled,
      applied,
      tools: enabled ? WEIXIN_TOOL_NAMES : [],
      ...(enabled && !applied
        ? { note: "会话当前没有活动的 agent，工具会在它下一次启动时生效" }
        : {}),
    };
  }

  /** Session ids currently opted in. */
  list(): string[] {
    return [...this.enabled];
  }

  /** Forget an agent that went away (its scoped registrations went with it). */
  forget(sessionId: string): void {
    this.registrations.delete(sessionId);
    this.live.delete(sessionId);
  }

  /** Stop following agents and drop every registration this manager made. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const sessionId of [...this.registrations.keys()]) this.detach(sessionId);
    this.live.clear();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(optInPath(), "utf-8")) as OptInFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;
      for (const sessionId of parsed.sessions) {
        if (typeof sessionId === "string" && sessionId !== "") this.enabled.add(sessionId);
      }
      for (const sessionId of parsed.declined ?? []) {
        if (typeof sessionId === "string" && sessionId !== "") this.declined.add(sessionId);
      }
      logger.debug(
        `tool-optin: loaded ${this.enabled.size} opt-in / ${this.declined.size} declined session(s)`,
      );
    } catch {
      // No file yet: nothing is opted in.
    }
  }

  private persist(): void {
    const payload: OptInFile = {
      version: 1,
      sessions: [...this.enabled],
      declined: [...this.declined],
    };
    try {
      fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
      fs.writeFileSync(optInPath(), JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      logger.warn(`tool-optin: failed to persist: ${String(err)}`);
    }
  }
}
