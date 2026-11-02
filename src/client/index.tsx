/**
 * dsh-weixin client half.
 *
 * Adds one tab to DSH's own right sidebar: 「微信」. It uses the native
 * two-stage registry the product's own tabs use, so no third-party sidebar
 * plugin is involved:
 *
 * 1. the tab TYPE (`ctx.sidebarRightTabs.register`) — identity, priority, chip
 *    title, and the guide entry that offers it on the new-tab page;
 * 2. the tab BODY (a keyed `sidebar.right.pane.tab` slot under the type's id).
 *
 * The body lives in ./WeixinTab.tsx and talks only to this plugin's host routes.
 */
import { createElement } from "react";
import type { ReactElement } from "react";

import {
  WEIXIN_BODY_SLOT,
  WEIXIN_TAB_ID,
  WEIXIN_TAB_KIND,
  WEIXIN_TAB_ORDER,
} from "../shared/wire";
import { WeixinTab } from "./WeixinTab";

/**
 * Services this client plugin waits for.
 *
 * `sidebarRightTabs` is the tab-type registry and `slots` carries the body seat.
 * Waiting on the registry here (rather than inside a slot declaration) is
 * deliberate: the native seat declares `sidebar.right.pane.tab` before it
 * provides `sidebarRightTabs`, so a declaration-triggered registration can read
 * the service as missing and — because the declaration never collapses —
 * register nothing, permanently.
 */
export const inject = ["sidebarRightTabs", "slots"];

/** The client cordis context, limited to what this plugin touches. */
interface ClientContext {
  get(name: string): unknown;
  effect(setup: () => void | (() => void), label?: string): unknown;
}

/** Structural face of `ctx.sidebarRightTabs`. */
interface TabRegistryLike {
  register(definition: {
    id: string;
    kind: string;
    priority: "extension" | "builtin" | "fallback";
    title: (address: string) => string;
    guide?: readonly {
      id: string;
      order: number;
      title: () => string;
      description?: () => string;
      icon?: (props: { size?: number; className?: string }) => unknown;
    }[];
  }): () => void;
}

/** Structural face of `ctx.slots`, limited to what this plugin registers. */
interface SlotRegistryLike {
  inject(ownerKey: string, callback: () => () => void): () => void;
  register(
    options: {
      name: string;
      key: string;
      inject?: (sessionId: string) => Record<string, unknown>;
    },
    component: unknown,
  ): () => void;
}

/**
 * A chat-bubble glyph in `currentColor`, so it follows the skin like every other
 * sidebar icon. A component, not an element: the guide seat renders it with its
 * own `size`.
 * @param props - the seat's icon props.
 * @returns the glyph.
 */
export function WeixinTabIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}): ReactElement {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      ...(className === undefined ? {} : { className }),
      style: { display: "block" },
    },
    createElement("path", {
      key: "bubble",
      d: "M2.2 7.1c0-2.4 2.2-4.3 5-4.3s5 1.9 5 4.3-2.2 4.3-5 4.3c-.6 0-1.2-.1-1.7-.2L3.1 12.5l.6-1.6C2.9 10.1 2.2 8.7 2.2 7.1Z",
    }),
    createElement("circle", { key: "l", cx: 5.6, cy: 7.1, r: 0.7, fill: "currentColor", stroke: "none" }),
    createElement("circle", { key: "r", cx: 8.6, cy: 7.1, r: 0.7, fill: "currentColor", stroke: "none" }),
  );
}

/**
 * Client plugin body.
 * @param ctx - the client cordis context (registry and slots are ready).
 */
export function apply(ctx: ClientContext): void {
  const registry = ctx.get("sidebarRightTabs") as TabRegistryLike | undefined;
  if (registry === undefined) {
    // A silent swallow would leave the sidebar without the tab and without a
    // symptom; say so once, where a reader will look.
    console.error("[dsh-weixin] sidebarRightTabs is missing: the tab type cannot be registered");
    return;
  }

  ctx.effect(
    () =>
      registry.register({
        id: WEIXIN_TAB_ID,
        kind: WEIXIN_TAB_KIND,
        // A tab from outside the product outranks the built-in viewers, which is
        // what lets this kind sit beside them instead of losing to a fallback.
        priority: "extension",
        title: () => "微信",
        guide: [
          {
            id: WEIXIN_TAB_ID,
            order: WEIXIN_TAB_ORDER,
            title: () => "微信",
            description: () => "扫码连接微信；为当前会话启用 weixin_* 工具",
            icon: WeixinTabIcon,
          },
        ],
      }),
    "dsh-weixin: tab type",
  );

  const slots = ctx.get("slots") as SlotRegistryLike | undefined;
  if (slots === undefined) {
    console.error("[dsh-weixin] slots is missing: the tab body cannot be registered");
    return;
  }

  // Declaration-triggered: the seat that owns `sidebar.right.pane.tab` declares
  // it when it mounts, which may be after this plugin activates.
  ctx.effect(
    () =>
      slots.inject(WEIXIN_BODY_SLOT, () =>
        slots.register(
          {
            name: WEIXIN_BODY_SLOT,
            key: WEIXIN_TAB_ID,
            inject: (sessionId: string) => ({ ctx, sessionId }),
          },
          WeixinTab,
        ),
      ),
    "dsh-weixin: tab body",
  );
}

/** Re-exported for the bundle tests. */
export { WeixinTab };
