/**
 * Optional Metro config wrapper for metro-mcp.
 *
 * Patches `@react-native/dev-middleware`'s InspectorProxy so that
 * `webSocketDebuggerUrl` and `devtoolsFrontendUrl` in all CDP target
 * descriptions point at the MCP's CDP proxy. This is the single source of
 * truth consumed by both the `/json` HTTP endpoint and the `/open-debugger`
 * handler, so patching it ensures that pressing "j" in Metro or tapping
 * "Open Debugger" in the dev menu routes through the proxy — allowing Chrome
 * DevTools and the MCP to coexist.
 *
 * Usage in metro.config.js:
 *
 *   const { withMetroMcp } = require('metro-mcp/metro');
 *   module.exports = withMetroMcp(getDefaultConfig(__dirname));
 *
 * This is entirely optional. The MCP works without it — the only difference
 * is that "j" and "Open Debugger" will steal the CDP connection if the
 * wrapper is not installed.
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('metro-config');

const PROXY_PORT_ENV = 'METRO_MCP_PROXY_PORT';
const PROXY_PORT_FILE = '.metro-mcp-proxy-port';

// Sentinel property to prevent double-wrapping getPageDescriptions.
const MCP_PATCHED = Symbol.for('metro-mcp-patched');

// Cache the port after the first successful discovery — it's invariant once
// the MCP server writes it. Never cache null: the MCP server may start after
// Metro, so we keep retrying until we find a valid port.
let cachedProxyPort: number | undefined;

function discoverProxyPort(): number | null {
  if (cachedProxyPort !== undefined) return cachedProxyPort;

  const envPort = process.env[PROXY_PORT_ENV];
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port > 0) {
      cachedProxyPort = port;
      return port;
    }
  }

  try {
    const content = readFileSync(PROXY_PORT_FILE, 'utf8').trim();
    const port = parseInt(content, 10);
    if (!isNaN(port) && port > 0) {
      cachedProxyPort = port;
      return port;
    }
  } catch {
    // File not present — MCP server not running yet.
  }

  return null;
}

function rewritePageDescription(
  page: Record<string, unknown>,
  proxyPort: number,
): Record<string, unknown> {
  const rewritten = { ...page };

  if (typeof rewritten.webSocketDebuggerUrl === 'string') {
    rewritten.webSocketDebuggerUrl = `ws://127.0.0.1:${proxyPort}`;
  }

  if (typeof rewritten.devtoolsFrontendUrl === 'string') {
    // Replace the ws= (or wss=) query parameter value with the proxy address.
    // The URL looks like:
    //   http://localhost:8081/debugger-frontend/rn_fusebox.html?ws=localhost:8081/...
    rewritten.devtoolsFrontendUrl = rewritten.devtoolsFrontendUrl.replace(
      /([?&]wss?=)[^&]+/,
      `$1127.0.0.1:${proxyPort}`,
    );
  }

  return rewritten;
}

/**
 * Wrap a target object's `getPageDescriptions` method to rewrite CDP URLs.
 * Works on both prototypes and individual instances. Idempotent (uses a
 * Symbol sentinel to skip if already wrapped).
 */
function wrapGetPageDescriptions(target: Record<string | symbol, unknown>): boolean {
  if (target[MCP_PATCHED]) return false;

  const original = target.getPageDescriptions;
  if (typeof original !== 'function') return false;

  target.getPageDescriptions = function (
    this: unknown,
    ...args: unknown[]
  ): Record<string, unknown>[] {
    const pages = (original as Function).apply(this, args) as Record<string, unknown>[];
    const proxyPort = discoverProxyPort();
    if (!proxyPort) return pages;
    return pages.map((page) => rewritePageDescription(page, proxyPort));
  };
  target[MCP_PATCHED] = true;
  return true;
}

let patched = false;

function patchDevMiddleware(): void {
  if (patched) return;
  patched = true;

  try {
    const req = createRequire(process.cwd() + '/');

    // Verify @react-native/dev-middleware is installed.
    try {
      req.resolve('@react-native/dev-middleware');
    } catch {
      return;
    }

    // Load the main module so its dependency tree populates require.cache.
    try { req('@react-native/dev-middleware'); } catch {}

    // ── Strategy 1: Prototype patch ──────────────────────────────────────
    // Patching InspectorProxy.prototype.getPageDescriptions is the most
    // reliable approach because it affects ALL instances — even ones
    // created after the CLI destructured `createDevMiddleware` at import
    // time (which makes the module-export patch ineffective).
    let protoPatched = false;

    // Try known internal paths where InspectorProxy lives.
    const internalPaths = [
      '@react-native/dev-middleware/dist/inspector-proxy/InspectorProxy',
      '@react-native/dev-middleware/dist/inspector-proxy/InspectorProxy.js',
    ];

    for (const modPath of internalPaths) {
      try {
        const mod = req(modPath) as Record<string, unknown>;
        const cls = mod?.default || mod?.InspectorProxy || mod;
        if (typeof cls === 'function' && cls.prototype && typeof (cls.prototype as Record<string | symbol, unknown>).getPageDescriptions === 'function') {
          protoPatched = wrapGetPageDescriptions(cls.prototype as Record<string | symbol, unknown>);
          if (protoPatched) break;
        }
      } catch {}
    }

    // Fallback: search require.cache for any module whose export looks
    // like the InspectorProxy class.
    if (!protoPatched) {
      const cache = require.cache ?? {};
      for (const key of Object.keys(cache)) {
        if (!key.includes('InspectorProxy')) continue;
        const mod = cache[key];
        const exp = (mod?.exports as Record<string, unknown>)?.default ?? mod?.exports;
        if (typeof exp === 'function') {
          const cls = exp as Record<string, unknown> & { prototype?: Record<string | symbol, unknown> };
          if (cls.prototype && typeof cls.prototype.getPageDescriptions === 'function') {
            protoPatched = wrapGetPageDescriptions(cls.prototype);
            if (protoPatched) break;
          }
        }
      }
    }

    // ── Strategy 2: Module._load hook ────────────────────────────────────
    // If InspectorProxy hasn't been loaded yet (lazy loaded inside
    // createDevMiddleware), install a require hook to catch it.
    if (!protoPatched) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Module = require('module') as Record<string, unknown>;
        const originalLoad = Module._load as Function;

        Module._load = function (request: string, ...rest: unknown[]) {
          const result = originalLoad.call(this, request, ...rest);
          if (
            typeof request === 'string' &&
            request.includes('InspectorProxy') &&
            typeof result === 'function'
          ) {
            const cls = result as Record<string, unknown> & { prototype?: Record<string | symbol, unknown> };
            if (cls.prototype && typeof cls.prototype.getPageDescriptions === 'function') {
              if (wrapGetPageDescriptions(cls.prototype)) {
                // Restore the original _load — we only need to patch once.
                Module._load = originalLoad;
              }
            }
          }
          return result;
        };
      } catch {}
    }

    // ── Strategy 3: Wrap createDevMiddleware export ──────────────────────
    // Belt-and-suspenders: also patch the returned inspectorProxy instance
    // directly. This handles class-field methods (not on prototype) and
    // cases where the module hasn't been imported by the CLI yet.
    try {
      const devMiddleware = req('@react-native/dev-middleware') as Record<string, unknown>;
      const original = devMiddleware.createDevMiddleware;

      if (typeof original === 'function') {
        devMiddleware.createDevMiddleware = function (
          ...args: unknown[]
        ): Record<string, unknown> {
          const result = (original as Function).apply(this, args) as Record<string, unknown>;
          const proxy = result?.inspectorProxy as Record<string | symbol, unknown> | undefined;
          if (proxy && typeof proxy.getPageDescriptions === 'function') {
            wrapGetPageDescriptions(proxy);
          }
          return result;
        };
      }
    } catch {}
  } catch (err) {
    logger.warn(
      'Unexpected error patching @react-native/dev-middleware:',
      err,
      '\n"j" / "Open Debugger" will not route through the MCP proxy.',
    );
  }
}

interface MetroConfig {
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
  patchDevMiddleware();
  return config;
}
