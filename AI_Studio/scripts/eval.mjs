#!/usr/bin/env node
// Evaluation harness: measure the AI tester on the corpus of real apps (docs/features/evaluation.md).
//   node scripts/eval.mjs [--corpus file] [--repeat N] [--only id] [--plan-only] [--fail-under stable=0.8,flaky=0.1] [--yes]
// The harness is TypeScript, run through tsx like the platform's other entry points. The AI model and its key come from .env.
// It starts browsers, so it holds the machine-wide "browser" lock for its whole run (scripts/lock.mjs): it waits while another run has it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import { holdLock } from "./lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
// bench-report only reads result files: no browser, no AI, so no lock and no .env. The ladder only starts `eval.mjs bench` in each
// rung's tree, and each of those takes the lock and reads its tree's .env itself (holding the lock here would make them wait forever).
const readOnly = argv[0] === "bench-report" || argv[0] === "ladder";
const envFile = path.join(root, ".env");
if (!readOnly && fs.existsSync(envFile)) process.loadEnvFile(envFile);
if (!readOnly && !argv.includes("--help") && !argv.includes("-h")) {
    try {
        await holdLock("browser", `scripts/eval.mjs ${argv.join(" ")}`.trim());
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(3);
    }
}
register();
const { main } = await import("../src/eval/cli.ts");
process.exit(await main(argv));
