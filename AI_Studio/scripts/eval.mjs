#!/usr/bin/env node
// Evaluation harness: measure the AI tester on the corpus of real apps (docs/features/evaluation.md).
//   node scripts/eval.mjs [--corpus file] [--repeat N] [--only id] [--plan-only] [--fail-under stable=0.8,flaky=0.1] [--yes]
// The harness is TypeScript, run through tsx like the platform's other entry points. The AI model and its key come from .env.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
register();
const { main } = await import("../src/eval/cli.ts");
process.exit(await main(process.argv.slice(2)));
