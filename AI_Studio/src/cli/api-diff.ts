import fs from "node:fs";
import path from "node:path";
import { parseSpecText } from "../engine/api/openapi.js";
import { diffOpenApi, renderDiffMarkdown } from "../engine/contracts/diff.js";
import { EXIT, InfraError, UsageError } from "./errors.js";
import type { Io } from "./run.js";

const USAGE = `ai-test api-diff — what changed between two versions of an API description

  ai-test api-diff <old> <new> [--fail-on breaking|any|none] [--json file] [--markdown file]

  <old>, <new>   an OpenAPI/Swagger file (.json, .yaml) or an http(s) address
  --fail-on      breaking (default): exit 1 if any breaking change; any: exit 1 on any change; none: always exit 0
  --json/--markdown  also write the report to a file

Exit codes: 0 gate passed, 1 gate failed, 2 usage or infrastructure error.`;

export const API_DIFF_HELP = USAGE;

async function load(source: string): Promise<Record<string, any>> {
    let text: string;
    if (/^https?:\/\//i.test(source)) {
        try {
            const res = await fetch(source, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
            if (!res.ok) throw new InfraError(`Could not download ${source} (HTTP ${res.status}).`);
            text = await res.text();
        } catch (e) {
            if (e instanceof InfraError) throw e;
            throw new InfraError(`Could not download ${source}: ${e instanceof Error ? e.message : String(e)}`);
        }
    } else {
        if (!fs.existsSync(source)) throw new InfraError(`File not found: ${source}`);
        text = fs.readFileSync(source, "utf8");
    }
    try {
        return parseSpecText(text);
    } catch (e) {
        throw new InfraError(`${source} is not a readable OpenAPI description: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** `ai-test api-diff`: gate a pipeline on breaking changes between two API descriptions. */
export async function apiDiffCommand(argv: string[], io: Io): Promise<number> {
    const positional: string[] = [];
    const opts: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--help" || a === "-h") {
            io.out(USAGE);
            return EXIT.OK;
        }
        if (a.startsWith("--")) {
            const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
            if (!["fail-on", "json", "markdown"].includes(k)) throw new UsageError(`Unknown option --${k}. Try “ai-test api-diff --help”.`);
            const v = inline ?? argv[++i];
            if (v === undefined || v.startsWith("--")) throw new UsageError(`--${k} needs a value.`);
            opts[k] = v;
        } else positional.push(a);
    }
    if (positional.length !== 2) throw new UsageError("Give the old and the new API description: ai-test api-diff <old> <new>");
    const failOn = opts["fail-on"] ?? "breaking";
    if (!["breaking", "any", "none"].includes(failOn)) throw new UsageError(`--fail-on must be breaking, any or none (got “${failOn}”).`);

    const [oldDoc, newDoc] = await Promise.all([load(positional[0]!), load(positional[1]!)]);
    const diff = diffOpenApi(oldDoc, newDoc);

    const lines = [
        `API changes: ${diff.breaking.length} breaking, ${diff.nonBreaking.length} other.`,
        ...diff.breaking.map((c) => `  BREAKING  ${c.operation}: ${c.message}`),
        ...diff.nonBreaking.map((c) => `  change    ${c.operation}: ${c.message}`),
    ];
    io.out(lines.join("\n"));
    for (const [flag, body] of [["json", JSON.stringify(diff, null, 2) + "\n"], ["markdown", renderDiffMarkdown(diff)]] as const) {
        const file = opts[flag];
        if (!file) continue;
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(file, body);
    }
    const failed = failOn === "any" ? diff.breaking.length + diff.nonBreaking.length > 0 : failOn === "breaking" ? diff.breaking.length > 0 : false;
    if (failed) io.err(`ai-test: gate failed (--fail-on ${failOn}).`);
    return failed ? EXIT.GATE_FAILED : EXIT.OK;
}
