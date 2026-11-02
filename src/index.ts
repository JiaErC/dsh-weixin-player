/**
 * dsh-weixin — a Weixin channel for DeepSeek Harness.
 *
 * The plugin connects one or more Weixin bot accounts (iLink long-poll) to DSH
 * agent sessions: an inbound WeChat message becomes one agent turn, and the
 * turn's assistant text is delivered back into the chat.
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
import { buildWeixinTools } from "./tools/index.js";
import { logger, setConsoleSink } from "./protocol/util/logger.js";

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
  await runtime.start();

  if (services.tools !== undefined) {
    for (const definition of buildWeixinTools(runtime)) {
      try {
        const dispose = services.tools.register(definition as never);
        disposers.push(dispose);
        logger.info(`dsh-weixin: registered tool ${definition.name}`);
      } catch (err) {
        logger.error(`dsh-weixin: failed to register tool ${definition.name}: ${String(err)}`);
      }
    }
  } else {
    logger.info("dsh-weixin: this profile has no tool registry; weixin_* tools are unavailable");
  }

  if (!config.loginPage) return;

  const webServer = services.webServer;
  if (webServer === undefined) {
    logger.warn(
      "dsh-weixin: this profile has no web server, so the QR login page is unavailable — log in from another profile or enable the web profile",
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
      const dispose = webServer.register(route);
      disposers.push(dispose);
    } catch (err) {
      logger.error(`dsh-weixin: failed to register route ${route.path}: ${String(err)}`);
    }
  }

  const host = webServer.host ?? "127.0.0.1";
  const port = webServer.port ?? 3080;
  logger.info(`dsh-weixin: login page ready at ${loginPageUrl(host, port)}`);
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
export type { AccountSnapshot, ChannelSnapshot } from "./channel/runtime.js";
