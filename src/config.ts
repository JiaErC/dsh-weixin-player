/**
 * Channel configuration.
 *
 * The value arrives as the `config:` block of the plugin's Loader row. It is
 * validated and normalised exactly once, at mount time, so every downstream
 * module can rely on defaults being filled in.
 *
 * No config schema object is exported: DSH validates rows whose plugin exports
 * `Config`, but doing so would add a `@deepseek-ai/schemastery` dependency for
 * one flat object. {@link normalizeConfig} enforces the same contract with
 * actionable errors instead.
 */

/** How inbound WeChat peers map onto DSH sessions. */
export type SessionMode = "per-peer" | "shared";

/** Configuration as written in `cordis.patch.yml`. */
export interface WeixinChannelConfigInput {
  /** Start the long-poll loops at mount time. Default `true`. */
  enabled?: boolean;
  /**
   * Weixin peer ids (`xxx@im.wechat`) allowed to talk to the agent.
   *
   * Empty means "only the account owner recorded by QR login", falling back to
   * "anyone" when that is unknown — the channel logs a warning in that case.
   */
  allowFrom?: string[];
  /** Absolute working directory for agent sessions. Default: process cwd. */
  workspace?: string;
  /**
   * Agent preset id each WeChat session composes. Omit to use the deployment
   * default preset; `none` composes no preset (no tools, bare agent).
   */
  agentPreset?: string;
  /** How inbound peers map onto sessions. Default `per-peer`. */
  sessionMode?: SessionMode;
  /** Session id used by `sessionMode: "shared"`. Default `session-dsh-weixin`. */
  sharedSessionId?: string;
  /** Strip Markdown WeChat cannot render (images, CJK italic markers, H5/H6). Default `true`. */
  markdown?: boolean;
  /** Send the WeChat "typing" indicator while a turn runs. Default `true`. */
  typing?: boolean;
  /** Max characters per outbound text message. Default `4000`. */
  textChunkLimit?: number;
  /** Long-poll timeout for `getUpdates`, ms. Default `35000`. */
  longPollTimeoutMs?: number;
  /** Cache message bodies so ID-only quotes resolve to text. Default `true`. */
  quoteCache?: boolean;
  /** Recent messages kept per account by the quote cache. Default `1000`. */
  quoteCacheMaxMessages?: number;
  /**
   * Give every WeChat conversation the `weixin_*` tools automatically.
   *
   * These sessions exist to talk on WeChat, so they get the tools scoped to
   * themselves by default. Other sessions opt in from the sidebar tab. Default
   * `true`.
   */
  autoEnableTools?: boolean;
  /** Per-account overrides, keyed by normalised account id. */
  accounts?: Record<
    string,
    {
      name?: string;
      enabled?: boolean;
      cdnBaseUrl?: string;
    }
  >;
  /** `base_info.bot_agent` self-identification on the wire. */
  botAgent?: string;
  /** Optional `SKRouteTag` header. */
  routeTag?: string;
  /** Serve the QR login page. Default `true` when the host has a webserver. */
  loginPage?: boolean;
}

/** Normalised configuration with every default applied. */
export interface WeixinChannelConfig {
  enabled: boolean;
  allowFrom: string[];
  workspace: string;
  agentPreset: string | undefined;
  sessionMode: SessionMode;
  sharedSessionId: string;
  markdown: boolean;
  typing: boolean;
  textChunkLimit: number;
  longPollTimeoutMs: number;
  quoteCache: boolean;
  quoteCacheMaxMessages: number;
  autoEnableTools: boolean;
  accounts: NonNullable<WeixinChannelConfigInput["accounts"]>;
  botAgent: string | undefined;
  routeTag: string | undefined;
  loginPage: boolean;
}

/** Thrown when the row's `config:` block cannot be used as written. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

function asBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError(`dsh-weixin: \`${field}\` must be a boolean (got ${JSON.stringify(value)})`);
  }
  return value;
}

function asPositiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError(
      `dsh-weixin: \`${field}\` must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`dsh-weixin: \`${field}\` must be an array of strings`);
  }
  return value
    .map((entry, index) => {
      if (typeof entry !== "string") {
        throw new ConfigError(`dsh-weixin: \`${field}[${index}]\` must be a string`);
      }
      return entry.trim();
    })
    .filter((entry) => entry !== "");
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`dsh-weixin: \`${field}\` must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Validate one Loader-row config object and fill in every default.
 *
 * @param raw - the row's `config:` value (may be undefined for a bare row).
 * @param cwd - process working directory, used as the default workspace.
 * @returns configuration every other module can trust.
 * @throws {ConfigError} when a field has the wrong shape.
 */
export function normalizeConfig(
  raw: Record<string, unknown> | undefined,
  cwd: string = process.cwd(),
): WeixinChannelConfig {
  const input = (raw ?? {}) as WeixinChannelConfigInput;

  const sessionMode = input.sessionMode ?? "per-peer";
  if (sessionMode !== "per-peer" && sessionMode !== "shared") {
    throw new ConfigError(
      `dsh-weixin: \`sessionMode\` must be "per-peer" or "shared" (got ${JSON.stringify(input.sessionMode)})`,
    );
  }

  const workspace = asOptionalString(input.workspace, "workspace") ?? cwd;

  const accountsInput = input.accounts ?? {};
  if (typeof accountsInput !== "object" || accountsInput === null || Array.isArray(accountsInput)) {
    throw new ConfigError("dsh-weixin: `accounts` must be an object keyed by account id");
  }

  return {
    enabled: asBoolean(input.enabled, "enabled", true),
    allowFrom: asStringArray(input.allowFrom, "allowFrom"),
    workspace,
    agentPreset: asOptionalString(input.agentPreset, "agentPreset"),
    sessionMode,
    sharedSessionId: asOptionalString(input.sharedSessionId, "sharedSessionId") ?? "session-dsh-weixin",
    markdown: asBoolean(input.markdown, "markdown", true),
    typing: asBoolean(input.typing, "typing", true),
    textChunkLimit: asPositiveInt(input.textChunkLimit, "textChunkLimit", 4000),
    longPollTimeoutMs: asPositiveInt(input.longPollTimeoutMs, "longPollTimeoutMs", 35_000),
    quoteCache: asBoolean(input.quoteCache, "quoteCache", true),
    quoteCacheMaxMessages: asPositiveInt(input.quoteCacheMaxMessages, "quoteCacheMaxMessages", 1000),
    autoEnableTools: asBoolean(input.autoEnableTools, "autoEnableTools", true),
    accounts: accountsInput,
    botAgent: asOptionalString(input.botAgent, "botAgent"),
    routeTag: asOptionalString(input.routeTag, "routeTag"),
    loginPage: asBoolean(input.loginPage, "loginPage", true),
  };
}
