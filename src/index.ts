#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { registerSpecTools } from './spec/register.js';
import { loadToolSpecs } from './spec/loader.js';
import { registerSessionTools } from './tools/session.tools.js';
import { registerCartTools } from './tools/cart.tools.js';
import { startKeepAlive } from './services/auth.service.js';
import { browserService } from './services/browser.service.js';
import { logger } from './utils/logger.js';

config();

export function createServer(): { server: McpServer; toolCount: number } {
  const server = new McpServer({ name: 'carrefour-drive', version: '2.0.0' });

  registerSessionTools(server);
  registerCartTools(server);
  const load = loadToolSpecs();
  registerSpecTools(server, load);

  if (load.failures.length > 0) {
    for (const f of load.failures) {
      process.stderr.write(`[carrefour-drive] skipped ${f.file}: ${f.reason}\n`);
    }
  }
  logger.info('Tools registered', {
    declarative: load.specs.length,
    failed: load.failures.length,
    dir: load.dir,
  });

  return { server, toolCount: load.specs.filter((s) => !s.internal).length };
}

async function main(): Promise<void> {
  const { server, toolCount } = createServer();
  // Keep the storefront session in use between two user requests.
  startKeepAlive();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[carrefour-drive] MCP server ready — ${toolCount} API tools loaded\n`);

  // The browser is a child process; leaving it behind would lock the profile.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      browserService.shutdown().finally(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  logger.error('Failed to start server', { error: String(error) });
  process.stderr.write(`[carrefour-drive] fatal: ${String(error)}\n`);
  process.exit(1);
});
