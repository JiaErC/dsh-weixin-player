import type { IncomingMessage, ServerResponse } from "node:http";

import type { WeixinChannelRuntime } from "../channel/runtime.js";
import type { WeixinChannelConfig } from "../config.js";
import type { WebRouteLike } from "../dsh/services.js";
import { logger } from "../protocol/util/logger.js";
import { WEIXIN_PATHS, WEIXIN_TOOL_NAMES } from "../shared/wire.js";
import type {
  LoginStartPayload,
  LoginStatusPayload,
  StatusPayload,
  ToolsPayload,
} from "../shared/wire.js";
import { isTrustedRequest } from "./trust-fence.js";

/**
 * The channel's HTTP surface on the DSH webserver.
 *
 * Two consumers share it: the standalone login page (a deep link for a full
 * status view) and the right-sidebar tab (the everyday surface). Both speak the
 * same JSON, so the tab never needs a second implementation of the login flow.
 */

/** Largest request body accepted; these routes only take a code or a session id. */
const MAX_BODY_BYTES = 4096;

/** Rendered QR images, keyed by "sessionKey:startedAt". */
const qrCache = new Map<string, Uint8Array>();
const QR_CACHE_LIMIT = 8;

/** What route handlers close over. */
export interface WeixinRoutesDeps {
  runtime: WeixinChannelRuntime;
  config: WeixinChannelConfig;
  trustedHosts: () => readonly string[];
}

function sendJson(res: ServerResponse, status: number, body: unknown, method: string): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : payload);
}

function sendHtml(res: ServerResponse, html: string, method: string): void {
  const payload = Buffer.from(html, "utf-8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": payload.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : payload);
}

/** Read a small JSON body; returns undefined when it is unusable. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return await new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(
          typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : undefined,
        );
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function methodOf(req: IncomingMessage): string {
  return req.method ?? "GET";
}

/** Query parameter of the request URL, if it parses. */
function queryOf(req: IncomingMessage, name: string): string | undefined {
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Reject a request that is not a same-origin read/write of this deployment. */
function guard(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
  allowed: readonly string[],
  path: string,
): boolean {
  const method = methodOf(req);
  if (!allowed.includes(method)) {
    sendJson(res, 405, { ok: false, error: `${method} is not allowed on ${path}` }, method);
    return false;
  }
  if (!isTrustedRequest(req, deps.trustedHosts())) {
    sendJson(res, 403, { ok: false, error: "this route only answers same-origin requests" }, method);
    return false;
  }
  return true;
}

/** Render the QR for `text` as a PNG, or undefined when the library is absent. */
async function renderQrPng(text: string): Promise<Uint8Array | undefined> {
  try {
    const mod = (await import("qrcode")) as {
      toBuffer(text: string, options?: Record<string, unknown>): Promise<Uint8Array>;
    };
    return await mod.toBuffer(text, { type: "png", width: 360, margin: 1 });
  } catch (err) {
    logger.warn(`routes: qrcode is unavailable, serving the link only: ${String(err)}`);
    return undefined;
  }
}

async function handlePage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
): Promise<void> {
  if (!guard(req, res, deps, ["GET", "HEAD"], WEIXIN_PATHS.page)) return;
  sendHtml(res, renderPage(deps.config), methodOf(req));
}

async function handleStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
): Promise<void> {
  if (!guard(req, res, deps, ["GET", "HEAD"], WEIXIN_PATHS.status)) return;
  const payload: StatusPayload = {
    ok: true,
    channel: deps.runtime.snapshot(),
    login: deps.runtime.qr.latest() ?? null,
  };
  sendJson(res, 200, payload, methodOf(req));
}

async function handleLoginStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
): Promise<void> {
  if (!guard(req, res, deps, ["POST"], WEIXIN_PATHS.loginStart)) return;

  const body = (await readJsonBody(req)) ?? {};
  const force = body.force === true;
  const accountId = typeof body.accountId === "string" ? body.accountId : undefined;

  try {
    const snapshot = await deps.runtime.qr.start({
      ...(force ? { force } : {}),
      ...(accountId === undefined || accountId === "" ? {} : { accountId }),
    });
    const payload: LoginStartPayload = { ok: true, login: snapshot };
    sendJson(res, 200, payload, methodOf(req));
  } catch (err) {
    logger.error(`routes: login start failed: ${String(err)}`);
    sendJson(
      res,
      500,
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      methodOf(req),
    );
  }
}

async function handleLoginStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
): Promise<void> {
  if (!guard(req, res, deps, ["GET", "HEAD"], WEIXIN_PATHS.loginStatus)) return;
  const sessionKey = queryOf(req, "sessionKey");
  const snapshot =
    sessionKey === undefined ? deps.runtime.qr.latest() : deps.runtime.qr.snapshot(sessionKey);
  const payload: LoginStatusPayload = { ok: true, login: snapshot ?? null };
  sendJson(res, 200, payload, methodOf(req));
}

async function handleLoginVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
): Promise<void> {
  if (!guard(req, res, deps, ["POST"], WEIXIN_PATHS.loginVerify)) return;

  const body = (await readJsonBody(req)) ?? {};
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (sessionKey === "" || !/^\d{1,6}$/.test(code.trim())) {
    sendJson(res, 400, { ok: false, error: "sessionKey and a numeric code are required" }, methodOf(req));
    return;
  }

  const accepted = deps.runtime.qr.submitVerifyCode(sessionKey, code);
  const payload: LoginStatusPayload = {
    ok: accepted,
    login: deps.runtime.qr.snapshot(sessionKey) ?? null,
    ...(accepted ? {} : { error: "这次登录当前不需要验证码" }),
  };
  sendJson(res, accepted ? 200 : 409, payload, methodOf(req));
}

async function handleQrImage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
): Promise<void> {
  if (!guard(req, res, deps, ["GET", "HEAD"], WEIXIN_PATHS.loginQr)) return;

  const sessionKey = queryOf(req, "sessionKey");
  const snapshot =
    sessionKey === undefined ? deps.runtime.qr.latest() : deps.runtime.qr.snapshot(sessionKey);
  const url = snapshot?.qrcodeUrl;
  if (snapshot === undefined || url === undefined || url === "") {
    sendJson(res, 404, { ok: false, error: "no active QR code" }, methodOf(req));
    return;
  }

  const key = `${snapshot.sessionKey}:${snapshot.startedAt}`;
  let png = qrCache.get(key);
  if (png === undefined) {
    const rendered = await renderQrPng(url);
    if (rendered === undefined) {
      sendJson(
        res,
        503,
        { ok: false, error: "the qrcode package is unavailable; open the link instead" },
        methodOf(req),
      );
      return;
    }
    png = rendered;
    if (qrCache.size >= QR_CACHE_LIMIT) {
      const oldest = qrCache.keys().next();
      if (oldest.done !== true) qrCache.delete(oldest.value);
    }
    qrCache.set(key, png);
  }

  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": png.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(methodOf(req) === "HEAD" ? undefined : png);
}

/**
 * Read or change one session's tool exposure.
 *
 * GET takes the session id from the query; POST takes `{ sessionId, enabled }`.
 * This is the button in the sidebar tab: it registers the channel's tools on
 * that one agent's scope, leaving every preset untouched.
 */
async function handleTools(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeixinRoutesDeps,
): Promise<void> {
  if (!guard(req, res, deps, ["GET", "HEAD", "POST"], WEIXIN_PATHS.tools)) return;
  const method = methodOf(req);

  // The body is read exactly once: the stream cannot be consumed twice.
  const body = method === "POST" ? ((await readJsonBody(req)) ?? {}) : undefined;
  const sessionId =
    body === undefined
      ? (queryOf(req, "sessionId") ?? "")
      : typeof body.sessionId === "string"
        ? body.sessionId
        : "";

  if (sessionId.trim() === "") {
    sendJson(res, 400, { ok: false, error: "sessionId is required" }, method);
    return;
  }

  try {
    if (body !== undefined) {
      const exposure = deps.runtime.setToolsEnabled(sessionId, body.enabled === true);
      const payload: ToolsPayload = { ok: true, ...exposure, tools: WEIXIN_TOOL_NAMES };
      sendJson(res, 200, payload, method);
      return;
    }

    const exposure = deps.runtime.toolExposure(sessionId);
    if (exposure === undefined) {
      const payload: ToolsPayload = {
        ok: true,
        sessionId,
        enabled: false,
        applied: false,
        tools: [],
        note: "此部署没有工具注册表，无法按会话启用工具",
      };
      sendJson(res, 200, payload, method);
      return;
    }
    const payload: ToolsPayload = { ok: true, ...exposure, tools: WEIXIN_TOOL_NAMES };
    sendJson(res, 200, payload, method);
  } catch (err) {
    logger.error(`routes: tools route failed: ${String(err)}`);
    sendJson(
      res,
      500,
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      method,
    );
  }
}

/**
 * Register every route this channel owns.
 *
 * @returns the route definitions so the caller can wrap each in `ctx.effect`.
 */
export function buildWeixinRoutes(deps: WeixinRoutesDeps): WebRouteLike[] {
  return [
    { kind: "exact", path: WEIXIN_PATHS.page, handler: (req, res) => handlePage(req, res, deps) },
    {
      kind: "exact",
      path: WEIXIN_PATHS.status,
      handler: (req, res) => handleStatus(req, res, deps),
    },
    {
      kind: "exact",
      path: WEIXIN_PATHS.loginStart,
      handler: (req, res) => handleLoginStart(req, res, deps),
    },
    {
      kind: "exact",
      path: WEIXIN_PATHS.loginStatus,
      handler: (req, res) => handleLoginStatus(req, res, deps),
    },
    {
      kind: "exact",
      path: WEIXIN_PATHS.loginVerify,
      handler: (req, res) => handleLoginVerify(req, res, deps),
    },
    {
      kind: "exact",
      path: WEIXIN_PATHS.loginQr,
      handler: (req, res) => handleQrImage(req, res, deps),
    },
    { kind: "exact", path: WEIXIN_PATHS.tools, handler: (req, res) => handleTools(req, res, deps) },
  ];
}

/** Absolute URL of the login page for a given host:port. */
export function loginPageUrl(host: string, port: number): string {
  const hostname = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${hostname}:${port}${WEIXIN_PATHS.page}`;
}

/** The page itself: no external assets, no framework. */
function renderPage(config: WeixinChannelConfig): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 微信渠道</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f6f7f9; color: #1c1f23; }
  @media (prefers-color-scheme: dark) { body { background: #17191c; color: #e6e8ea; } .card { background: #202327; border-color: #2c3035; } }
  .wrap { max-width: 860px; margin: 0 auto; display: grid; gap: 18px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 20px; }
  .muted { color: #6b7280; font-size: 13px; }
  .row { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .qr { width: 240px; height: 240px; border-radius: 10px; border: 1px solid #e3e6ea; background: #fff; object-fit: contain; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #2563eb;
           background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  input { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; width: 140px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  @media (prefers-color-scheme: dark) { th, td { border-color: #2c3035; } input { background: #17191c; color: inherit; border-color: #3a3f45; } }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; }
  .ok { color: #15803d; } .bad { color: #b91c1c; } .warn { color: #b45309; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>DSH 微信渠道</h1>
    <p class="muted">
      工作目录 <code id="workspace">-</code> ·
      模型预设 <code id="preset">-</code> ·
      允许来源 <code id="allow">-</code>
    </p>
    <p class="muted">日常使用请用 DSH 右侧栏的「微信」tab；本页用于查看完整状态。</p>
    <table>
      <thead><tr><th>账号</th><th>状态</th><th>最近收消息</th><th>收消息数</th><th>备注</th></tr></thead>
      <tbody id="accounts"><tr><td colspan="5" class="muted">加载中…</td></tr></tbody>
    </table>
    <p class="muted">日志：<code id="logfile">-</code></p>
  </div>

  <div class="card">
    <h2>连接微信</h2>
    <div class="row">
      <div>
        <img id="qr" class="qr hidden" alt="微信登录二维码">
        <div id="qr-placeholder" class="muted" style="width:240px">还没有二维码。点右侧按钮开始。</div>
      </div>
      <div style="flex:1;min-width:260px">
        <p id="login-message" class="muted">用手机微信扫描二维码即可完成连接。</p>
        <p><button id="start">开始登录 / 重新扫码</button></p>
        <div id="verify-box" class="hidden">
          <p class="muted">手机微信上显示了一串数字，把它填到这里：</p>
          <input id="verify-code" inputmode="numeric" placeholder="数字">
          <button id="verify-submit">提交</button>
        </div>
        <p class="muted" id="login-link"></p>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>会话绑定</h2>
    <table>
      <thead><tr><th>微信 ID</th><th>DSH 会话</th><th>最近活跃</th></tr></thead>
      <tbody id="peers"><tr><td colspan="3" class="muted">暂无</td></tr></tbody>
    </table>
    <p class="muted">每个微信用户对应一个 DSH 会话；在微信里发 <code>/new</code> 可以换一段新会话。</p>
  </div>
</div>

<script>
const PATHS = ${JSON.stringify(WEIXIN_PATHS)};
const PAGE_CONFIG = ${JSON.stringify({ workspace: config.workspace, autoEnableTools: config.autoEnableTools })};

function $(id) { return document.getElementById(id); }
function when(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let currentLogin = null;

async function refreshStatus() {
  try {
    const response = await fetch(PATHS.status);
    const data = await response.json();
    if (!data.ok) return;
    const channel = data.channel;
    $('workspace').textContent = channel.workspace;
    $('preset').textContent = channel.agentPreset || '部署默认';
    $('allow').textContent = channel.allowFrom.length ? channel.allowFrom.join(', ') : '账号主人';
    $('logfile').textContent = channel.logFile;

    const body = $('accounts');
    if (!channel.accounts.length) {
      body.innerHTML = '<tr><td colspan="5" class="muted">还没有登录任何微信账号。</td></tr>';
    } else {
      body.innerHTML = channel.accounts.map((a) => {
        const state = a.running ? '<span class="pill ok">运行中</span>'
          : a.configured ? '<span class="pill warn">已停</span>'
          : '<span class="pill bad">未登录</span>';
        const note = a.lastError ? '<span class="bad">' + escapeHtml(a.lastError) + '</span>'
          : (a.ownerUserId ? '主人 ' + escapeHtml(a.ownerUserId) : '');
        return '<tr><td><code>' + escapeHtml(a.accountId) + '</code></td><td>' + state + '</td><td>' +
          when(a.lastInboundAt) + '</td><td>' + a.inboundCount + '</td><td>' + note + '</td></tr>';
      }).join('');
    }

    const peers = $('peers');
    if (!channel.peers.length) {
      peers.innerHTML = '<tr><td colspan="3" class="muted">还没有人给这个 bot 发过消息。</td></tr>';
    } else {
      peers.innerHTML = channel.peers.map((p) =>
        '<tr><td><code>' + escapeHtml(p.peerId) + '</code></td><td><code>' + escapeHtml(p.sessionId) +
        '</code></td><td>' + when(p.lastActiveAt) + '</td></tr>').join('');
    }
  } catch (error) {
    console.error(error);
  }
}

function showLogin(login) {
  currentLogin = login;
  const qr = $('qr');
  const placeholder = $('qr-placeholder');
  const message = $('login-message');
  const verifyBox = $('verify-box');
  const link = $('login-link');

  if (!login) {
    qr.classList.add('hidden');
    placeholder.classList.remove('hidden');
    verifyBox.classList.add('hidden');
    link.textContent = '';
    return;
  }

  message.textContent = login.message + (login.error ? ' ' + login.error : '');
  message.className = login.status === 'confirmed' || login.status === 'already_connected'
    ? 'ok' : (login.status === 'failed' ? 'bad' : 'muted');

  if (login.qrcodeUrl && login.status !== 'confirmed' && login.status !== 'already_connected') {
    qr.classList.remove('hidden');
    placeholder.classList.add('hidden');
    qr.src = PATHS.loginQr + '?sessionKey=' + encodeURIComponent(login.sessionKey) + '&t=' + login.startedAt;
    link.innerHTML = '二维码无法显示时，把下面的链接复制到手机微信里打开：<br><a href="' +
      escapeHtml(login.qrcodeUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(login.qrcodeUrl) + '</a>';
  } else {
    qr.classList.add('hidden');
    placeholder.classList.remove('hidden');
    link.textContent = '';
  }

  verifyBox.classList.toggle('hidden', !login.needsVerifyCode);
  if (login.status === 'confirmed') refreshStatus();
}

async function startLogin() {
  $('start').disabled = true;
  try {
    const response = await fetch(PATHS.loginStart, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true })
    });
    const data = await response.json();
    if (data.ok) showLogin(data.login); else $('login-message').textContent = data.error || '启动登录失败';
  } catch (error) {
    $('login-message').textContent = '启动登录失败：' + error;
  } finally {
    $('start').disabled = false;
  }
}

async function submitCode() {
  const code = $('verify-code').value.trim();
  if (!code || !currentLogin) return;
  $('verify-submit').disabled = true;
  try {
    const response = await fetch(PATHS.loginVerify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: currentLogin.sessionKey, code })
    });
    const data = await response.json();
    if (data.login) showLogin(data.login);
    if (!data.ok) $('login-message').textContent = data.error || '提交失败';
    $('verify-code').value = '';
  } catch (error) {
    $('login-message').textContent = '提交失败：' + error;
  } finally {
    $('verify-submit').disabled = false;
  }
}

async function pollLogin() {
  try {
    const response = await fetch(PATHS.loginStatus);
    const data = await response.json();
    if (data.ok) showLogin(data.login);
  } catch (error) {
    console.error(error);
  }
}

$('start').addEventListener('click', startLogin);
$('verify-submit').addEventListener('click', submitCode);
$('verify-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitCode(); });

refreshStatus();
pollLogin();
setInterval(pollLogin, 2000);
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`;
}
