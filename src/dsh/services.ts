/**
 * Structural views of the DSH host services this plugin consumes.
 *
 * The plugin deliberately imports **no** `@deepseek-ai/*` package at runtime:
 * those packages live inside the `dsh` installation, not in a profile's
 * `node_modules`, so a runtime import would fail at load time. Declaring the
 * small surface used here keeps the channel installable as a plain package and
 * decouples it from the harness version — a renamed field shows up as a clear
 * runtime error in one place instead of a module-resolution failure.
 */

/** A disposer returned by cordis effect/on registrations. */
export type Disposer = () => void;

/** Logging face the host context exposes. */
export interface HostLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  debug?(message: string): void;
}

/**
 * The subset of a cordis `Context` used by this plugin.
 *
 * `get` returns a service or undefined — cordis resolves lazily, so an optional
 * dependency is read with `ctx.get(name)` and never injected.
 */
export interface HostContext {
  get(name: string): unknown;
  on(name: string, listener: (...args: never[]) => unknown): Disposer;
  effect(setup: () => Disposer | void, label?: string): Disposer;
  logger?: HostLogger;
}

/** One model/route selection for an agent request. */
export interface ModelSelectionLike {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** A live DSH session as the channel reads it. */
export interface SessionLike {
  id: string;
  seq: number;
  header: { cwd?: string; agentPreset?: string };
  requestHeader?(): unknown;
}

/** A live DSH agent as the channel drives it. */
export interface AgentLike {
  id: string;
  session: SessionLike;
  status: "idle" | "running";
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  cancel(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
  ctx: unknown;
}

/** Handle owning one agent; disposing it tears the agent down. */
export interface AgentHandleLike {
  agent: AgentLike;
  dispose(): Promise<void>;
}

/** Options accepted by {@link AgentsService.create} (the subset used here). */
export interface CreateAgentOptionsLike {
  sessionId: string;
  meta?: { cwd?: string; agentPreset?: string };
  agentOptions?: { provider: string; model: string; reasoningEffort?: string };
  setup?: (agentCtx: unknown, agent: AgentLike) => void | Promise<void>;
}

/** Options accepted by {@link AgentsService.resume}. */
export interface ResumeAgentOptionsLike {
  resumeSessionId: string;
  agentOptions?: { provider: string; model: string; reasoningEffort?: string };
  setup?: (agentCtx: unknown, agent: AgentLike) => void | Promise<void>;
}

/** `ctx.agents` — the agent registry. */
export interface AgentsService {
  get(id: string): AgentLike | undefined;
  /** Every live agent, when the registry exposes it. */
  list?(): AgentLike[];
  create(options: CreateAgentOptionsLike): Promise<AgentHandleLike>;
  resume(options: ResumeAgentOptionsLike): Promise<AgentHandleLike>;
}

/** `ctx.sessions` — the session store. */
export interface SessionsService {
  get(id: string): SessionLike | undefined;
  /** Durability checkpoint; the only sanctioned way to persist a session. */
  flush(session: SessionLike): Promise<boolean>;
}

/** `ctx.sessionQuery` — reads a persisted session without resuming it. */
export interface SessionQueryService {
  observeSession(id: string): Promise<unknown>;
}

/** `ctx.agentDefaultModel` — the deployment-wide provider/model default. */
export interface AgentDefaultModelService {
  currentSelection(): ModelSelectionLike;
}

/** `ctx.agentPresets` — composable agent capability sets. */
export interface AgentPresetsService {
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: unknown, id?: string): Promise<{ id: string }>;
  /**
   * The selection roster: every current declaration, each marked when it is the
   * default, with the reason when it cannot compose a session.
   *
   * This is the method a picker reads. `list()` returns bare presets with no
   * `isDefault` flag, and reading it as a roster object silently yields nothing
   * — a mistake this channel already made once.
   */
  remoteExportList?(): Promise<{
    presets: readonly {
      id: string;
      isDefault: boolean;
      name?: string;
      description?: string;
      broken?: string;
    }[];
  }>;
  /** Bare preset list, without the default marker. */
  list?(): Promise<
    readonly {
      id: string;
      name?: string;
      description?: string;
      broken?: string;
    }[]
  >;
  /** Identity a session composes when it names no preset. */
  readonly defaultId?: string;
}

/** One permission preset as the catalog presents it. */
export interface PermissionPresetOption {
  /** Stable preset key, e.g. `read-only`. */
  value: string;
  /** Display label the deployment configured. */
  name: string;
  /** One user-facing sentence on what it allows. */
  description?: string;
}

/** `ctx.permissionPresets.catalog()` — the process-level permission catalog. */
export interface PermissionPresetCatalog {
  /** Every currently selectable preset, in contribution order. */
  options: PermissionPresetOption[];
  /** Presets eligible as defaults for future sessions. */
  defaultOptions: PermissionPresetOption[];
  /** Effective default preset key. */
  defaultPreset: string;
}

/**
 * `ctx.permissionPresets` — the sandbox/approval knob bundles a session can run
 * under.
 *
 * Only the members this channel needs are declared: read the catalog for a
 * picker, resolve to validate a name, and `set` to record the choice for one
 * session (which writes the durable `permission/preset` fact plus both knobs).
 */
export interface PermissionPresetsService {
  /** Keys currently selectable. */
  readonly names?: readonly string[];
  /** Effective default for newly created sessions. */
  readonly defaultPreset: string;
  catalog(): PermissionPresetCatalog;
  /** Resolve a preset's knob bundle; throws for an unknown name. */
  resolve(name: string): unknown;
  /** The preset one session currently runs under. */
  current?(session: unknown): string;
  /** Record `name` for one session and apply its knobs. */
  set(session: unknown, name: string): void;
}

/** `ctx.loader` — settles once the whole Loader tree is mounted. */
export interface LoaderService {
  await(): Promise<void>;
}

/** A cordis tool definition, as `ctx.tools.register` accepts it. */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: Record<string, unknown>, value: unknown): unknown[];
  };
  execute(args: never, exec: ToolRunContextLike): Promise<unknown>;
}

/** Execution context handed to a tool's `execute`. */
export interface ToolRunContextLike {
  callId: string;
  signal: AbortSignal;
  agent?: { id: string; session: SessionLike };
}

/** `ctx.tools` — the tool registry. */
export interface ToolsService {
  register(definition: ToolDefinitionLike): Disposer;
}

/** One HTTP route this plugin owns on the DSH webserver. */
export interface WebRouteLike {
  kind: "exact" | "prefix";
  path: string;
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void | Promise<void>;
}

/** `ctx.webServer` — the host HTTP server. */
export interface WebServerLike {
  register(route: WebRouteLike): Disposer;
  /** Bound port, when the host exposes it. */
  readonly port?: number;
  /** Bound host (`127.0.0.1` or `0.0.0.0`), when the host exposes it. */
  readonly host?: string;
}

/** `ctx.webRuntime` — non-loopback authorities this deployment serves. */
export interface WebRuntimeLike {
  trustedHosts?: readonly string[];
}

/** Typed accessors over an untyped host context. */
export interface HostServices {
  ctx: HostContext;
  agents: AgentsService | undefined;
  sessions: SessionsService | undefined;
  sessionQuery: SessionQueryService | undefined;
  agentDefaultModel: AgentDefaultModelService | undefined;
  agentPresets: AgentPresetsService | undefined;
  permissionPresets: PermissionPresetsService | undefined;
  tools: ToolsService | undefined;
  webServer: WebServerLike | undefined;
  webRuntime: WebRuntimeLike | undefined;
  loader: LoaderService | undefined;
}

/**
 * Resolve the host services lazily.
 *
 * cordis mounts rows in dependency order, so a service may legitimately appear
 * after this plugin's `apply()` runs. Every field is therefore a getter that
 * re-reads the context instead of a snapshot taken at mount time.
 */
export function readHostServices(ctx: HostContext): HostServices {
  const read = <T>(name: string): T | undefined => ctx.get(name) as T | undefined;
  return {
    ctx,
    get agents() {
      return read<AgentsService>("agents");
    },
    get sessions() {
      return read<SessionsService>("sessions");
    },
    get sessionQuery() {
      return read<SessionQueryService>("sessionQuery");
    },
    get agentDefaultModel() {
      return read<AgentDefaultModelService>("agentDefaultModel");
    },
    get agentPresets() {
      return read<AgentPresetsService>("agentPresets");
    },
    get permissionPresets() {
      return read<PermissionPresetsService>("permissionPresets");
    },
    get tools() {
      return read<ToolsService>("tools");
    },
    get webServer() {
      return read<WebServerLike>("webServer");
    },
    get webRuntime() {
      return read<WebRuntimeLike>("webRuntime");
    },
    get loader() {
      return read<LoaderService>("loader");
    },
  };
}
