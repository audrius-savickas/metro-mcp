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

const PROXY_PORT_ENV = 'METRO_MCP_PROXY_PORT';
const PROXY_PORT_FILE = '.metro-mcp-proxy-port';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/**
 * Discover the proxy port on each call. Never caches null so we keep
 * retrying — Metro may start before the MCP server writes the port file.
 */
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

/**
 * Rewrite `webSocketDebuggerUrl` and `devtoolsFrontendUrl` in a single
 * page-description object to point at the MCP CDP proxy.
 */
function rewritePageDescription(page: AnyRecord, proxyPort: number): AnyRecord {
  const rewritten = { ...page };

  if (rewritten.webSocketDebuggerUrl) {
    rewritten.webSocketDebuggerUrl = `ws://127.0.0.1:${proxyPort}`;
  }

  if (rewritten.devtoolsFrontendUrl) {
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

/** True once the patch has been applied — prevents double-patching. */
let patched = false;

/**
 * Monkey-patch `@react-native/dev-middleware` so the InspectorProxy's
 * `getPageDescriptions()` rewrites CDP target URLs to point at the MCP proxy.
 *
 * This must be called before Metro starts (i.e. when metro.config.js loads).
 * The patch is idempotent — safe to call multiple times.
 */
function patchDevMiddleware(): void {
  if (patched) return;
  patched = true;

  try {
    // Resolve the module from the user's project root so we find the copy
    // of @react-native/dev-middleware that Metro is actually using.
    const req = createRequire(process.cwd() + '/');

    let devMiddlewarePath: string;
    try {
      devMiddlewarePath = req.resolve('@react-native/dev-middleware');
    } catch {
      // Package not installed in this project — nothing to patch.
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const devMiddleware = req(devMiddlewarePath) as AnyRecord;

    const original: ((...args: unknown[]) => AnyRecord) | undefined =
      devMiddleware.createDevMiddleware;

    if (typeof original !== 'function') {
      // API changed — bail out gracefully.
      console.warn(
        '[metro-mcp] Could not patch @react-native/dev-middleware: ' +
          'createDevMiddleware export not found. ' +
          '"j" / "Open Debugger" will not route through the MCP proxy.',
      );
      return;
    }

    devMiddleware.createDevMiddleware = function (...args: unknown[]): AnyRecord {
      const result: AnyRecord = original.apply(this, args);

      const proxy: AnyRecord | undefined = result?.inspectorProxy;
      if (!proxy || typeof proxy.getPageDescriptions !== 'function') {
        // Proxy not exposed or API changed — return result unchanged.
        return result;
      }

      const originalGet: (...a: unknown[]) => AnyRecord[] = proxy.getPageDescriptions.bind(proxy);

      proxy.getPageDescriptions = function (...a: unknown[]): AnyRecord[] {
        const pages: AnyRecord[] = originalGet(...a);
        const proxyPort = discoverProxyPort();
        if (!proxyPort) return pages;
        return pages.map((page) => rewritePageDescription(page, proxyPort));
      };

      return result;
    };
  } catch (err) {
    console.warn(
      '[metro-mcp] Unexpected error patching @react-native/dev-middleware:',
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
 * Patches `@react-native/dev-middleware` so the InspectorProxy serves
 * the MCP's CDP proxy URL instead of the raw Hermes WebSocket URL.
 * This affects all CDP target consumers: the `/json` discovery endpoint,
 * the `/open-debugger` handler, and any future endpoint that queries
 * `inspectorProxy.getPageDescriptions()`.
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
