#!/usr/bin/env node
// `ai-test-agent` command: the runner agent that runs the platform's tests on this computer. TypeScript, run through tsx like
// `ai-test`. It reuses the platform's own execution code, so it must run from a checkout of the platform with its
// dependencies installed (npm install) and, for web and API tests, the Playwright browsers (npx playwright install chromium).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
for (const [pkg, hint] of [
    ["tsx", "the platform's dependencies"],
    ["@playwright/test", "Playwright"],
]) {
    try {
        require.resolve(pkg);
    } catch {
        console.error(`ai-test-agent cannot start: ${pkg} was not found.`);
        console.error(`The agent runs from a checkout of the AI Testing Platform with ${hint} installed.`);
        console.error("Run `npm install` in the platform folder first, then start the agent again (see docs/features/runner-agent-setup.md).");
        process.exit(1);
    }
}

const { register } = await import("tsx/esm/api");
register();
await import("../src/agent/index.ts");
