/**
 * Process-wide settings the low-level protocol modules need but cannot get as
 * arguments (they are called from deep inside upload/download/send helpers).
 *
 * The channel plugin publishes the active values once at mount time; before
 * that, every reader sees the documented defaults. This replaces the upstream
 * plugin's habit of re-reading `openclaw.json` from disk on every request.
 */

/** Values read by the iLink request headers and telemetry fields. */
export interface WeixinRuntimeSettings {
  /**
   * Self-declared bot identity sent as `base_info.bot_agent` (UA-style
   * `Name/Version` tokens). Defaults to `DSH` on the wire.
   */
  botAgent?: string;
  /** Optional `SKRouteTag` header for routing experiments. */
  routeTag?: string;
  /** Channel version reported as `base_info.channel_version`. */
  channelVersion?: string;
}

let current: WeixinRuntimeSettings = {};

/** Publish the settings resolved from the plugin configuration. */
export function setRuntimeSettings(next: WeixinRuntimeSettings): void {
  current = { ...next };
}

/** Read the active settings (a snapshot; mutating it changes nothing). */
export function getRuntimeSettings(): WeixinRuntimeSettings {
  return current;
}

/** Reset to defaults — test helper. */
export function resetRuntimeSettings(): void {
  current = {};
}
