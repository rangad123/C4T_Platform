#!/usr/bin/env node
// `ai-test-mcp` command: the MCP server for AI tools (Claude, Cursor...). TypeScript, run through tsx like `ai-test`.
import { register } from "tsx/esm/api";

register();
await import("../src/mcp/index.ts");
