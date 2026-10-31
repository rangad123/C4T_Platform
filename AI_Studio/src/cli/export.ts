import fs from "node:fs";
import path from "node:path";
import type { ExportArgs } from "./args.js";
import { ApiCallError, remoteClient } from "./client.js";
import { InfraError } from "./errors.js";
import type { Io } from "./run.js";

/** `ai-test export`: save a project's tests to a file that `ai-test run --specs` replays. */
export async function exportCommand(args: ExportArgs, io: Io): Promise<number> {
    let apiKey = args["api-key"];
    if (!apiKey) {
        const name = args["api-key-env"] ?? (io.env.AI_TEST_API_KEY ? "AI_TEST_API_KEY" : undefined);
        if (name) apiKey = io.env[name];
    }
    const client = remoteClient(args.server, apiKey);
    let specs: unknown[];
    let projectName: string;
    try {
        const all = await client.json<Array<{ id: string; name: string }>>("GET", "/projects");
        const hit = all.find((p) => p.id === args.project) ?? all.find((p) => p.name === args.project);
        if (!hit) throw new InfraError(`No project called “${args.project}” on ${args.server}. Available: ${all.map((p) => p.name).slice(0, 10).join(", ") || "(none)"}.`);
        projectName = hit.name;
        specs = (await client.json<{ specs: unknown[] }>("GET", `/projects/${hit.id}/specs`)).specs;
    } catch (e) {
        if (e instanceof ApiCallError) throw new InfraError(`The platform refused the request (${e.status}): ${e.message}`);
        throw e;
    }
    if (specs.length === 0) throw new InfraError(`Project “${projectName}” has no tests to export.`);
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify({ specs }, null, 2) + "\n");
    io.out(`Exported ${specs.length} test${specs.length === 1 ? "" : "s"} from “${projectName}” to ${args.out}`);
    return 0;
}
