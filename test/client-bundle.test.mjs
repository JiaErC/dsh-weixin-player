import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * The client half is browser code: a bundle that registers itself with DSH's
 * module system. The only way to exercise it is to materialize it exactly the
 * way that system does — define `window.__ModuleLoader__.load`, capture the
 * factory, run it with a `require` stub whose `react` entries are inert.
 *
 * This proves three things that a type-check cannot: the bundle is valid
 * standalone JS, it registers under the package name, and `apply()` wires both
 * the tab type and the tab body.
 */
const BUNDLE = path.resolve("lib/client.js");
const PACKAGE_NAME = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")).name;

/** Inert React surface; `apply()` registers, it never renders. */
const reactStub = {
  createElement: (...args) => ({ __element: args[0], props: args[1] }),
  Fragment: "fragment",
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
};

const jsxRuntimeStub = {
  jsx: (...args) => ({ __element: args[0], props: args[1] }),
  jsxs: (...args) => ({ __element: args[0], props: args[1] }),
  Fragment: "fragment",
};

/**
 * Load the bundle the way the shell does.
 * @returns the module exports plus the registered id.
 */
function materialize() {
  let captured;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured = definition;
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => Promise.reject(new Error("no network in this test")),
    AbortController,
    TextEncoder,
    TextDecoder,
  };

  vm.runInNewContext(readFileSync(BUNDLE, "utf8"), sandbox, { filename: "client.js" });

  assert.ok(captured !== undefined, "the bundle must register itself with __ModuleLoader__");
  assert.equal(captured.id, PACKAGE_NAME, "the module id must be the package name");

  const requireStub = (specifier) => {
    if (specifier === "react") return reactStub;
    if (specifier === "react/jsx-runtime") return jsxRuntimeStub;
    if (specifier === "react-dom") return {};
    throw new Error(`unexpected require in the client bundle: ${specifier}`);
  };

  return { exports: captured.factory(requireStub), id: captured.id };
}

/** A client cordis context double that records registrations. */
function makeClientContext() {
  const tabs = [];
  const slotRegistrations = [];
  const effects = [];

  const ctx = {
    get(name) {
      if (name === "sidebarRightTabs") {
        return {
          register(definition) {
            tabs.push(definition);
            return () => {
              const index = tabs.indexOf(definition);
              if (index >= 0) tabs.splice(index, 1);
            };
          },
        };
      }
      if (name === "slots") {
        return {
          inject(_ownerKey, callback) {
            const dispose = callback();
            return dispose;
          },
          register(options, component) {
            slotRegistrations.push({ options, component });
            return () => {
              const index = slotRegistrations.indexOf({ options, component });
              if (index >= 0) slotRegistrations.splice(index, 1);
            };
          },
        };
      }
      return undefined;
    },
    effect(setup) {
      const dispose = setup();
      effects.push(dispose);
      return dispose;
    },
  };

  return { ctx, tabs, slotRegistrations, effects };
}

test("the bundle registers one tab type with a guide entry", () => {
  const { exports } = materialize();
  assert.equal(typeof exports.apply, "function");
  assert.deepEqual([...exports.inject], ["sidebarRightTabs", "slots"]);

  const client = makeClientContext();
  exports.apply(client.ctx);

  assert.equal(client.tabs.length, 1);
  const tab = client.tabs[0];
  assert.equal(tab.id, "dsh-weixin:channel");
  assert.equal(tab.kind, "dsh-weixin:channel");
  assert.equal(tab.priority, "extension");
  assert.equal(tab.title(""), "微信");
  assert.equal(tab.guide.length, 1);
  assert.equal(tab.guide[0].id, "dsh-weixin:channel");
  assert.equal(tab.guide[0].order, 45);
  assert.equal(tab.guide[0].title(), "微信");
  assert.equal(typeof tab.guide[0].icon, "function");
});

test("the bundle registers the tab body under the tab id", () => {
  const { exports } = materialize();
  const client = makeClientContext();
  exports.apply(client.ctx);

  assert.equal(client.slotRegistrations.length, 1);
  const entry = client.slotRegistrations[0];
  assert.equal(entry.options.name, "sidebar.right.pane.tab");
  assert.equal(entry.options.key, "dsh-weixin:channel");
  assert.equal(typeof entry.component, "function");

  const injected = entry.options.inject("session-abc");
  assert.equal(injected.sessionId, "session-abc");
  assert.ok(injected.ctx !== undefined);
});

test("a missing registry logs instead of throwing", () => {
  const { exports } = materialize();
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    exports.apply({
      get: () => undefined,
      effect: (setup) => setup(),
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((message) => message.includes("sidebarRightTabs")));
});

test("the icon renders an svg in currentColor", () => {
  const { exports } = materialize();
  const element = exports.WeixinTabIcon({ size: 16, className: "x" });
  assert.equal(typeof element, "object", `icon returned ${typeof element}`);
  assert.equal(element.__element, "svg");
  assert.equal(element.props.width, 16);
  assert.equal(element.props.stroke, "currentColor");
  assert.equal(element.props.className, "x");
});

/**
 * Escape text the way esbuild's minifier does with its default `charset`.
 *
 * Non-ASCII becomes `\uXXXX` (upper-case hex), which is why grepping the built
 * bundle for a Chinese literal finds nothing. This helper keeps those
 * assertions honest instead of silently vacuous.
 */
function escapeForBundle(text) {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    out += code > 0x7f ? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}` : char;
  }
  return out;
}

/** Whether the built bundle contains `text`, plain or escaped. */
function bundleIncludes(source, text) {
  return source.includes(text) || source.includes(escapeForBundle(text));
}

test("the built bundle carries the directory dialog", () => {
  const source = readFileSync(BUNDLE, "utf8");

  // The dialog is the only fixed-position surface in this bundle.
  assert.ok(source.includes('position:"fixed"'), "expected a fixed-position modal backdrop");

  for (const copy of [
    "选择工作目录",
    "用这个目录",
    "上一级",
    "可以直接输入或粘贴绝对路径，回车跳转",
    "进到目标文件夹后点右侧按钮",
  ]) {
    assert.ok(bundleIncludes(source, copy), `bundle is missing the copy: ${copy}`);
  }

  // The inline picker this replaced must be gone, not merely hidden.
  assert.equal(bundleIncludes(source, "抽屉"), false);
  assert.equal(bundleIncludes(source, "刷新目录"), false);
});
