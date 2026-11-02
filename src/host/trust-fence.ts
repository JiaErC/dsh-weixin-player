import type { IncomingMessage } from "node:http";

/**
 * Same-origin fence for this channel's routes.
 *
 * DSH's webserver binds loopback by default but a deployment may serve other
 * authorities too. Every state-changing route therefore checks the `Host`
 * header against the loopback names plus the deployment's trusted hosts, and
 * cross-checks `Origin` when the browser sent one. A hostile page cannot read
 * or drive these routes without a DNS-rebinding-free authority match.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);

/** True for a hostname this deployment serves locally. */
export function isLoopbackHostname(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(lowered) || lowered.endsWith(".localhost");
}

/** Extract the hostname from a `Host` or `Origin` header value. */
function hostnameOf(authority: string): string | undefined {
  const trimmed = authority.trim();
  if (trimmed === "") return undefined;
  try {
    // Origin carries a scheme, Host does not.
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a request may use this channel's routes.
 *
 * @param request - the inbound request.
 * @param trustedHosts - extra non-loopback authorities this deployment serves.
 */
export function isTrustedRequest(
  request: IncomingMessage,
  trustedHosts: readonly string[] = [],
): boolean {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== "string" || hostHeader === "") return false;

  const hostname = hostnameOf(hostHeader);
  if (hostname === undefined) return false;

  const allowed = isLoopbackHostname(hostname) || trustedHosts.some((trusted) => {
    const trustedName = hostnameOf(trusted);
    return trustedName !== undefined && trustedName.toLowerCase() === hostname.toLowerCase();
  });
  if (!allowed) return false;

  const origin = request.headers.origin;
  if (typeof origin === "string" && origin !== "" && origin !== "null") {
    const originHost = hostnameOf(origin);
    if (originHost === undefined) return false;
    if (originHost.toLowerCase() !== hostname.toLowerCase()) {
      const originTrusted = trustedHosts.some((trusted) => {
        const trustedName = hostnameOf(trusted);
        return trustedName !== undefined && trustedName.toLowerCase() === originHost.toLowerCase();
      });
      if (!originTrusted) return false;
    }
  }

  return true;
}
