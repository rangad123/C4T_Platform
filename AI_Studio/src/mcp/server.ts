/**
 * The MCP server: registers the tools and the report resource over a platform client. Transport-agnostic (main.ts
 * connects stdio), so tests can also drive it in memory.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlatformError, type PlatformClient } from "./client.js";
import type { McpConfig } from "./config.js";
import { cap, scrub } from "./format.js";
import { projectSummary, TOOLS, type ToolContext } from "./tools.js";

export const SERVER_NAME = "ai-testing-platform";
export const SERVER_VERSION = "0.1.0";

/** A message for people and AI tools: never a stack trace. */
function messageOf(e: unknown): string {
    if (e instanceof PlatformError) return e.message;
    if (e instanceof z.ZodError) return `Invalid input: ${e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")}`;
    return `Something went wrong: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`.slice(0, 400);
}

export function createMcpServer(client: PlatformClient, config: McpConfig): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    const waits = new Map<string, number>();
    const clean = (text: string, max?: number) => cap(scrub(text, config.apiKey), max);

    for (const tool of TOOLS) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                // Strict: a misspelled argument is an error the caller can fix, not something silently ignored.
                inputSchema: z.object(tool.shape).strict(),
                annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: !tool.readOnly },
            },
            async (args: any, extra) => {
                const ctx: ToolContext = { client, config, signal: extra.signal, waits };
                try {
                    return { content: [{ type: "text" as const, text: clean(await tool.run(args, ctx), tool.maxChars) }] };
                } catch (e) {
                    return { isError: true, content: [{ type: "text" as const, text: clean(messageOf(e)) }] };
                }
            },
        );
    }

    // The HTML report is far too big for a model; the resource is the same facts as get_project, as JSON.
    server.registerResource(
        "project-report",
        new ResourceTemplate("aitp://projects/{projectId}/report", {
            list: async () => {
                const projects = (await client.json("GET", "/projects").catch(() => [])) as Array<{ id: string; name: string }>;
                return { resources: projects.slice(0, 50).map((p) => ({ uri: `aitp://projects/${p.id}/report`, name: `${p.name} report`, mimeType: "application/json" })) };
            },
        }),
        { title: "Project report summary", description: "Test counts, readiness and latest job of one project, as JSON.", mimeType: "application/json" },
        async (uri, vars) => {
            const id = String(Array.isArray(vars.projectId) ? vars.projectId[0] : vars.projectId);
            const summary = await projectSummary({ client, config, waits }, decodeURIComponent(id));
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: clean(JSON.stringify(summary, null, 2)) }] };
        },
    );
    return server;
}
