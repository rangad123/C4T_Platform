// Program entry for `npm run mcp` and the `ai-test-mcp` bin: an MCP server on stdio.
// stdout carries the protocol, so everything we say about ourselves goes to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlatformClient } from "./client.js";
import { ConfigError, readConfig } from "./config.js";
import { createMcpServer, SERVER_NAME } from "./server.js";

let config;
try {
    config = readConfig(process.env);
} catch (e) {
    console.error(e instanceof ConfigError ? e.message : "Could not read the MCP server settings.");
    process.exit(1);
}

const server = createMcpServer(new PlatformClient(config), config);
await server.connect(new StdioServerTransport());
console.error(`[${SERVER_NAME}] MCP server ready on stdio, platform at ${config.host}${config.apiKey ? " (API key set)" : ""}`);

const stop = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// The client closing our stdin is the normal way to stop.
process.stdin.on("close", () => void stop());
