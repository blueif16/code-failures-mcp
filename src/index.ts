#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { resolve } from "node:path";

const brainPath = process.env.BRAIN_PATH || process.env.CODE_FAILURES_PATH;

if (!brainPath) {
  console.error(`
╔══════════════════════════════════════════════════════════════╗
║  code-failures-mcp: Missing configuration                   ║
║                                                              ║
║  Set BRAIN_PATH to your code_failures directory:             ║
║                                                              ║
║  BRAIN_PATH=/path/to/brain/code_failures                     ║
║                                                              ║
║  Or CODE_FAILURES_PATH as an alias.                          ║
╚══════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

const resolvedPath = resolve(brainPath);
console.error(`[code-failures-mcp] Indexing: ${resolvedPath}`);

async function main() {
  const server = await createServer(resolvedPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[code-failures-mcp] Server running on stdio");
}

main().catch((error) => {
  console.error("[code-failures-mcp] Fatal error:", error);
  process.exit(1);
});
