/**
 * Real end-to-end demonstration:  URL → AI explores → scenarios → scripts → executed → validated → stored.
 *
 *   npm run demo:e2e                      # starts the local DemoShop sample app and tests it
 *   npm run demo:e2e -- https://my.app    # tests any reachable site instead
 *
 * Requires LLM credentials (e.g. ANTHROPIC_API_KEY). There is no mock mode: without a key this
 * script exits instead of pretending.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { assertLlmConfigured } from "../src/engine/llm/provider.js";
import { extractDocumentText } from "../src/engine/requirements/extract.js";
import { bootstrap } from "../src/platform/bootstrap.js";
import { Worker } from "../src/platform/worker.js";

const cfg0 = loadConfig();
try {
    assertLlmConfigured(cfg0);
} catch (e) {
    console.error(`\n${e instanceof Error ? e.message : e}\nThe end-to-end demo needs a real model; see README "LLM configuration".`);
    process.exit(2);
}

const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
let sample: ChildProcess | undefined;
let url = target;
// --username / --password: a test account for the target site (the sample app uses its demo account).
const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
};
let creds: Record<string, string> | undefined =
    flag("username") && flag("password") ? { username: flag("username")!, password: flag("password")! } : undefined;
if (!target) {
    const port = 5056;
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(port)], { stdio: "ignore" });
    url = `http://127.0.0.1:${port}`;
    creds = { username: "demo@example.com", password: "Password123!", apiToken: "demo-token-123" };
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(url)).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-e2e-"));
const platform = bootstrap(loadConfig({ ...process.env, DATA_DIR: dataDir } as NodeJS.ProcessEnv));
const worker = new Worker(platform, 300);
worker.start();

const project = platform.repo.createProject({ name: "E2E demo" });
// --requirements <file>: plan tests that cover a requirements document (the sample app ships one).
const reqArg = process.argv.indexOf("--requirements");
const reqPath = reqArg > 0 ? process.argv[reqArg + 1] : !target ? path.join(REPO_ROOT, "examples/sample-app/requirements.md") : undefined;
const requirementsText = reqPath ? await extractDocumentText({ name: path.basename(reqPath), data: fs.readFileSync(reqPath) }) : undefined;

const options = {
    maxPages: 12,
    maxDepth: 2,
    maxScenarios: 12,
    targets: ["web", "api"] as Array<"web" | "api">,
    allowMutatingApiTests: false,
    accessibility: true,
    requirementsName: reqPath ? path.basename(reqPath) : undefined,
    requirementsText,
};
const { requirementsText: _t, ...appConfig } = options;
const appId = platform.repo.createApplication(project.id as string, url!, appConfig, creds);
const job = await platform.repo.createJob(project.id as string, appId, options);
console.log(`Job ${job.id} queued for ${url}\n`);

let last = 0;
let status = "";
while (true) {
    for (const e of platform.repo.listEvents(job.id, last)) {
        last = e.id;
        console.log(`  [${e.stage}] ${e.message}`);
    }
    status = platform.repo.getJob(job.id)!.status;
    if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 1000));
}

const done = platform.repo.getJob(job.id)!;
console.log(`\nStatus: ${done.status}${done.error ? ` (${done.error})` : ""}`);
console.log(done.counters);
for (const t of platform.repo.listTests(project.id as string)) {
    console.log(`  ${t.validationStatus.padEnd(18)} ${t.testKey}  ${t.suite} › ${t.title}`);
}
console.log(`\nScripts stored under ${path.join(dataDir, "generated-tests", project.id as string)}`);

await worker.stop();
platform.db.close();
sample?.kill();
process.exit(done.status === "FAILED" ? 1 : 0);
