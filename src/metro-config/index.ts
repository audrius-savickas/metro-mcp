/**
 * Optional Metro config wrapper for metro-mcp.
 *
 * Makes pressing "j" in Metro and "Open Debugger" in the dev menu route
 * through the MCP's CDP proxy instead of directly to Hermes. Uses two
 * complementary strategies:
 *
 * 1. InspectorProxy prototype patching — rewrites URLs at the source.
 * 2. HTTP server interception — guaranteed fallback that intercepts
 *    POST /open-debugger and GET /json at the raw HTTP level, before
 *    any Connect middleware runs.
 *
 * Usage in metro.config.js:
 *
 *   const { withMetroMcp } = require('metro-mcp/metro');
 *   module.exports = withMetroMcp(getDefaultConfig(__dirname));
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('metro-config');

const PROXY_PORT_ENV = 'METRO_MCP_PROXY_PORT';
const PROXY_PORT_FILE = '.metro-mcp-proxy-port';
const MCP_PATCHED = Symbol.for('metro-mcp-patched');

// ── Proxy port discovery ─────────────────────────────────────────────────────

// Don't cache — the MCP server may start/restart at any time and the port
// could change. File reads are only triggered by infrequent /json or
// /open-debugger requests so the I/O cost is negligible.
function discoverProxyPort(): number | null {
  const envPort = process.env[PROXY_PORT_ENV];
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port > 0) return port;
  }

  try {
    const content = readFileSync(PROXY_PORT_FILE, 'utf8').trim();
    const port = parseInt(content, 10);
    if (!isNaN(port) && port > 0) return port;
  } catch {
    // File not present — MCP server not running yet.
  }

  return null;
}

// ── URL rewriting ────────────────────────────────────────────────────────────

function rewriteTargetUrls(
  page: Record<string, unknown>,
  proxyPort: number,
): Record<string, unknown> {
  const rewritten = { ...page };

  if (typeof rewritten.webSocketDebuggerUrl === 'string') {
    rewritten.webSocketDebuggerUrl = `ws://127.0.0.1:${proxyPort}`;
  }

  if (typeof rewritten.devtoolsFrontendUrl === 'string') {
    // Rewrite the ws= query param to point at the proxy.
    // URL shape: http://host:port/debugger-frontend/rn_fusebox.html?ws=host:port/...
    rewritten.devtoolsFrontendUrl = rewritten.devtoolsFrontendUrl.replace(
      /([?&]wss?=)[^&]+/,
      `$1127.0.0.1:${proxyPort}`,
    );
  }

  return rewritten;
}

function rewriteJsonBody(body: string, proxyPort: number): string {
  try {
    const targets = JSON.parse(body);
    if (!Array.isArray(targets)) return body;
    return JSON.stringify(
      targets.map((t: Record<string, unknown>) => rewriteTargetUrls(t, proxyPort)),
    );
  } catch {
    return body;
  }
}

// ── Strategy A: InspectorProxy prototype patching ────────────────────────────

function wrapGetPageDescriptions(target: Record<string | symbol, unknown>): boolean {
  if (target[MCP_PATCHED]) return false;
  const original = target.getPageDescriptions;
  if (typeof original !== 'function') return false;

  target.getPageDescriptions = function (this: unknown, ...args: unknown[]) {
    const pages = (original as Function).apply(this, args) as Record<string, unknown>[];
    const proxyPort = discoverProxyPort();
    if (!proxyPort) return pages;
    return pages.map((p) => rewriteTargetUrls(p, proxyPort));
  };
  target[MCP_PATCHED] = true;
  logger.info('Patched InspectorProxy.getPageDescriptions');
  return true;
}

let protoPatched = false;

function tryPrototypePatch(): void {
  if (protoPatched) return;

  try {
    const req = createRequire(process.cwd() + '/');

    try {
      req.resolve('@react-native/dev-middleware');
    } catch {
      return;
    }

    // Load the main module so its dependency tree populates require.cache.
    try { req('@react-native/dev-middleware'); } catch {}

    // Try known internal paths where InspectorProxy lives.
    const paths = [
      '@react-native/dev-middleware/dist/inspector-proxy/InspectorProxy',
      '@react-native/dev-middleware/dist/inspector-proxy/InspectorProxy.js',
    ];
    for (const p of paths) {
      try {
        const mod = req(p) as Record<string, unknown>;
        const cls = mod?.default || mod?.InspectorProxy || mod;
        if (
          typeof cls === 'function' &&
          cls.prototype &&
          typeof (cls.prototype as Record<string | symbol, unknown>).getPageDescriptions === 'function'
        ) {
          protoPatched = wrapGetPageDescriptions(cls.prototype as Record<string | symbol, unknown>);
          if (protoPatched) return;
        }
      } catch {}
    }

    // Search require.cache.
    const cache = require.cache ?? {};
    for (const key of Object.keys(cache)) {
      if (!key.includes('InspectorProxy')) continue;
      const exp =
        (cache[key]?.exports as Record<string, unknown>)?.default ?? cache[key]?.exports;
      if (typeof exp === 'function') {
        const cls = exp as Function & { prototype?: Record<string | symbol, unknown> };
        if (cls.prototype && typeof cls.prototype.getPageDescriptions === 'function') {
          protoPatched = wrapGetPageDescriptions(cls.prototype);
          if (protoPatched) return;
        }
      }
    }

    // Module._load hook for lazy-loaded InspectorProxy.
    try {
      const Module = require('module') as Record<string, unknown>;
      const origLoad = Module._load as Function;
      Module._load = function (request: string, ...rest: unknown[]) {
        const result = origLoad.call(this, request, ...rest);
        if (
          typeof request === 'string' &&
          request.includes('InspectorProxy') &&
          typeof result === 'function'
        ) {
          const cls = result as Function & { prototype?: Record<string | symbol, unknown> };
          if (cls.prototype && typeof cls.prototype.getPageDescriptions === 'function') {
            if (wrapGetPageDescriptions(cls.prototype)) {
              Module._load = origLoad; // unhook
            }
          }
        }
        return result;
      };
    } catch {}

    // Also wrap createDevMiddleware export to patch instances directly.
    try {
      const devMw = req('@react-native/dev-middleware') as Record<string, unknown>;
      const origCreate = devMw.createDevMiddleware;
      if (typeof origCreate === 'function') {
        devMw.createDevMiddleware = function (...args: unknown[]) {
          const result = (origCreate as Function).apply(this, args) as Record<string, unknown>;
          const proxy = result?.inspectorProxy as Record<string | symbol, unknown> | undefined;
          if (proxy && typeof proxy.getPageDescriptions === 'function') {
            wrapGetPageDescriptions(proxy);
          }
          return result;
        };
      }
    } catch {}
  } catch (err) {
    logger.warn('Error during prototype patching:', err);
  }
}

// ── Strategy B: HTTP server interception via enhanceMiddleware ────────────────
// This is the guaranteed fallback. On the first request that reaches our
// enhanced middleware, we access the HTTP server via req.socket.server and
// replace its 'request' listeners with our interceptor. Our interceptor runs
// BEFORE any Connect middleware, so we can:
//   - POST /open-debugger: suppress Metro's handler entirely and open
//     Fusebox through the proxy ourselves.
//   - GET /json: let Metro handle it but rewrite the response body.

type MiddlewareFn = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

function launchBrowser(url: string): void {
  try {
    const cmd =
      process.platform === 'darwin'
        ? `open "${url}"`
        : process.platform === 'win32'
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;
    execSync(cmd, { stdio: 'ignore' });
  } catch {
    logger.warn('Could not launch browser. Open manually:', url);
  }
}

function handleOpenDebugger(
  _req: IncomingMessage,
  res: ServerResponse,
  proxyPort: number,
  metroPort: number,
  metroHost: string,
): void {
  const frontendUrl =
    `http://${metroHost}:${metroPort}/debugger-frontend/rn_fusebox.html` +
    `?ws=127.0.0.1:${proxyPort}` +
    `&sources.hide_add_folder=true`;

  logger.info('Intercepted /open-debugger → opening through proxy:', frontendUrl);
  launchBrowser(frontendUrl);

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

function interceptJsonResponse(
  req: IncomingMessage,
  res: ServerResponse,
  proxyPort: number,
  connectApp: Function,
): void {
  const origWrite = res.write.bind(res) as Function;
  const origEnd = res.end.bind(res) as Function;
  const chunks: Buffer[] = [];

  res.write = function (chunk: unknown): boolean {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    return true;
  } as typeof res.write;

  res.end = function (chunk?: unknown): ServerResponse {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    const body = Buffer.concat(chunks).toString('utf8');
    const rewritten = rewriteJsonBody(body, proxyPort);
    res.setHeader('Content-Length', Buffer.byteLength(rewritten));
    origWrite(rewritten);
    return origEnd() as ServerResponse;
  } as typeof res.end;

  // Let Metro's Connect app handle the request — our patched write/end will
  // rewrite the response before it reaches the client.
  connectApp(req, res);
}

function createEnhancedMiddleware(
  inner: MiddlewareFn,
  metroPort: number,
  metroHost: string,
): MiddlewareFn {
  let serverPatched = false;

  function patchHttpServer(server: {
    listeners: Function;
    removeAllListeners: Function;
    on: Function;
  }): void {
    if (serverPatched) return;
    serverPatched = true;

    const origListeners = server.listeners('request') as Function[];
    if (origListeners.length === 0) return;

    const connectApp = origListeners[0];
    server.removeAllListeners('request');

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '';
      const proxyPort = discoverProxyPort();

      // Intercept POST /open-debugger — suppress Metro's handler and launch
      // through the proxy.
      if (proxyPort && req.method === 'POST' && url.startsWith('/open-debugger')) {
        handleOpenDebugger(req, res, proxyPort, metroPort, metroHost);
        return;
      }

      // Intercept GET /json — let Metro handle it, rewrite the response.
      if (
        proxyPort &&
        req.method === 'GET' &&
        (url === '/json' || url === '/json/list' || url === '/json/')
      ) {
        interceptJsonResponse(req, res, proxyPort, connectApp);
        return;
      }

      // Everything else: pass through unchanged.
      connectApp(req, res);
    });

    logger.info('HTTP server patched — /open-debugger and /json will route through MCP proxy');
  }

  return function (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
    // Lazily patch the HTTP server on the first request that reaches us.
    if (!serverPatched) {
      const server = (req.socket as Record<string, unknown>)?.server;
      if (server && typeof (server as Record<string, Function>).listeners === 'function') {
        patchHttpServer(
          server as { listeners: Function; removeAllListeners: Function; on: Function },
        );
      }
    }
    return inner(req, res, next);
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

interface MetroConfig {
  server?: {
    enhanceMiddleware?: (middleware: MiddlewareFn, metroServer?: unknown) => MiddlewareFn;
    port?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Wrap a Metro config to make pressing "j" and "Open Debugger" work
 * alongside the MCP server.
 *
 * @example
 * ```js
 * // metro.config.js
 * const { getDefaultConfig } = require('expo/metro-config');
 * const { withMetroMcp } = require('metro-mcp/metro');
 *
 * module.exports = withMetroMcp(getDefaultConfig(__dirname));
 * ```
 */
export function withMetroMcp(config: MetroConfig): MetroConfig {
  // Strategy A: try to patch InspectorProxy at the prototype level.
  tryPrototypePatch();

  // Strategy B: install enhanceMiddleware to intercept at the HTTP level.
  const existingEnhance = config.server?.enhanceMiddleware;
  const metroPort = (config.server?.port as number) || 8081;
  const metroHost = 'localhost';

  return {
    ...config,
    server: {
      ...config.server,
      enhanceMiddleware: (middleware: MiddlewareFn, metroServer?: unknown) => {
        const enhanced = existingEnhance
          ? existingEnhance(middleware, metroServer)
          : middleware;
        return createEnhancedMiddleware(enhanced, metroPort, metroHost);
      },
    },
  };
}
