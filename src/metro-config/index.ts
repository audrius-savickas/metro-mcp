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

let patched = false;

function patchDevMiddleware(): void {
  if (patched) return;
  patched = true;

  try {
    // Resolve from the user's project root so we find the copy of
    // @react-native/dev-middleware that Metro is actually using.
    const req = createRequire(process.cwd() + '/');

    let devMiddlewarePath: string;
    try {
      devMiddlewarePath = req.resolve('@react-native/dev-middleware');
    } catch {
      // Package not installed in this project — nothing to patch.
      return;
    }

    const devMiddleware = req(devMiddlewarePath) as Record<string, unknown>;
    const original = devMiddleware.createDevMiddleware;

    if (typeof original !== 'function') {
      logger.warn(
        'Could not patch @react-native/dev-middleware: createDevMiddleware export not found. ' +
          '"j" / "Open Debugger" will not route through the MCP proxy.',
      );
      return;
    }

    devMiddleware.createDevMiddleware = function (
      ...args: unknown[]
    ): Record<string, unknown> {
      const result = (original as (...a: unknown[]) => Record<string, unknown>).apply(
        this,
        args,
      );

      const proxy = result?.inspectorProxy as Record<string, unknown> | undefined;
      if (!proxy || typeof proxy.getPageDescriptions !== 'function') {
        return result;
      }

      const originalGet = proxy.getPageDescriptions.bind(proxy) as (
        ...a: unknown[]
      ) => Record<string, unknown>[];

      proxy.getPageDescriptions = function (...a: unknown[]): Record<string, unknown>[] {
        const pages = originalGet(...a);
        const proxyPort = discoverProxyPort();
        if (!proxyPort) return pages;
        return pages.map((page) => rewritePageDescription(page, proxyPort));
      };

      return result;
    };
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
