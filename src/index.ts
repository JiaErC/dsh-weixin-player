/**
 * dsh-weixin — a Weixin channel for DeepSeek Harness.
 *
 * The plugin connects one or more Weixin bot accounts (iLink long-poll) to DSH
 * agent sessions: an inbound WeChat message becomes one agent turn, and the
 * turn's assistant text is delivered back into the chat.
 *
 * It has two halves:
 *  - this host half (monitors, routes, per-session tools), and
 *  - a browser half (`./client`) that adds the「微信」tab to DSH's right sidebar,
 *    where the QR login flow and the per-session tool switch live.
 *
 * Mount it by adding a Loader row:
 *
 * ```yaml
 * - id: dsh-weixin
 *   name: dsh-weixin-player
 *   config:
 *     workspace: 'E:/work/my-project'
 * ```
 *
 * @module dsh-weixin-player
 */
import { WeixinChannelRuntime } from "./channel/runtime.js";
import { ConfigError, normalizeConfig } from "./config.js";
import type { WeixinChannelConfig } from "./config.js";
import { readHostServices } from "./dsh/services.js";
import type { Disposer, HostContext, HostServices } from "./dsh/services.js";
import { buildWeixinRoutes, loginPageUrl } from "./host/routes.js";
import { logger, setConsoleSink } from "./protocol/util/logger.js";
import { buildWeixinTools } from "./tools/index.js";
import { WeixinToolOptIn } from "./tools/optin.js";

/** Stable cordis plugin name. */
export const name = "dsh-weixin";

/**
 * No services are injected: the channel tolerates a profile where the agent
 * services are still mounting, and reports a precise error at first use instead
 * of silently never activating.
 */
export const inject: string[] = [];

/**
 * Mount the channel.
 *
 * @param ctx - host cordis context.
 * @param config - the Loader row's `config:` block.
 */
export function apply(ctx: HostContext, config?: Record<string, unknown>): void {
  const normalized = normalizeConfig(config);
  const services = readHostServices(ctx);
  const runtime = new WeixinChannelRuntime({ services, config: normalized });
  const disposers: Disposer[] = [];

  mirrorLogsInto(ctx);
  if (services.agentDefaultModel === undefined) {
    logger.warn(
      "dsh-weixin: this profile has no agentDefaultModel service, so no WeChat message can start a turn",
    );
  }

  ctx.effect(() => {
    void initialize(normalized, services, runtime, disposers).catch((err) => {
      logger.error(`dsh-weixin: startup failed: ${String(err)}`);
    });

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch (err) {
          logger.warn(`dsh-weixin: disposer failed: ${String(err)}`);
        }
      }
      setConsoleSink(undefined);
      void runtime.stop().catch((err) => {
        logger.warn(`dsh-weixin: shutdown failed: ${String(err)}`);
      });
    };
  }, "dsh-weixin: channel");
}

/** Start monitors and, once the Loader has settled, publish routes and tools. */
async function initialize(
  config: WeixinChannelConfig,
  services: HostServices,
  runtime: WeixinChannelRuntime,
  disposers: Disposer[],
): Promise<void> {
  // Tools are NOT registered globally: they are exposed per session through
  // `agent.ctx`, so no preset and no unrelated conversation gains them.
  const optIn = prepareTools(services, runtime, disposers);
  runtime.useToolOptIn(optIn);

  await runtime.start();

  if (optIn === undefined) {
    logger.info("dsh-weixin: this profile has no tool registry; weixin_* tools are unavailable");
  }

  if (!config.loginPage) return;

  const webServer = services.webServer;
  if (webServer === undefined) {
    logger.warn(
      "dsh-weixin: this profile has no web server, so the sidebar tab and the QR login page are unavailable — enable the web profile",
    );
    return;
  }

  const trustedHosts = services.webRuntime?.trustedHosts ?? [];
  for (const route of buildWeixinRoutes({
    runtime,
    config,
    trustedHosts: () => services.webRuntime?.trustedHosts ?? trustedHosts,
  })) {
    try {
      disposers.push(webServer.register(route));
    } catch (err) {
      logger.error(`dsh-weixin: failed to register route ${route.path}: ${String(err)}`);
    }
  }

  const host = webServer.host ?? "127.0.0.1";
  const port = webServer.port ?? 3080;
  logger.info(`dsh-weixin: login page ready at ${loginPageUrl(host, port)}`);
}

/**
 * Build the tool definitions and the per-session opt-in manager.
 *
 * @returns the manager, or undefined when this profile has no tool registry.
 */
function prepareTools(
  services: HostServices,
  runtime: WeixinChannelRuntime,
  disposers: Disposer[],
): WeixinToolOptIn | undefined {
  if (services.tools === undefined) return undefined;

  const definitions = buildWeixinTools(runtime);
  const optIn = new WeixinToolOptIn({
    ctx: services.ctx,
    services,
    definitions,
  });
  try {
    optIn.start();
  } catch (err) {
    logger.error(`dsh-weixin: failed to start the tool opt-in manager: ${String(err)}`);
    return undefined;
  }
  disposers.push(() => optIn.close());
  logger.info(
    `dsh-weixin: ready to expose ${definitions.length} tool(s) per session (${definitions.map((definition) => definition.name).join(", ")})`,
  );
  return optIn;
}

/** Mirror channel logs into the harness console logger when one exists. */
function mirrorLogsInto(ctx: HostContext): void {
  const sink = ctx.logger;
  if (sink === undefined) return;
  setConsoleSink((level, message) => {
    switch (level) {
      case "ERROR":
      case "FATAL":
        sink.error?.(message);
        return;
      case "WARN":
        sink.warn?.(message);
        return;
      case "DEBUG":
      case "TRACE":
        sink.debug?.(message);
        return;
      default:
        sink.info?.(message);
    }
  });
}

export { ConfigError, normalizeConfig } from "./config.js";
export type { WeixinChannelConfig, WeixinChannelConfigInput } from "./config.js";
export { WeixinChannelRuntime } from "./channel/runtime.js";
export type { WeixinToolOptIn, ToolExposure } from "./tools/optin.js";
export { WEIXIN_PATHS, WEIXIN_TOOL_NAMES } from "./shared/wire.js";
