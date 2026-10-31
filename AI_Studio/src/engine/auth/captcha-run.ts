/**
 * A failed web run whose page loaded a captcha: the failure is the captcha, not the test or the application, so it is reported with the
 * captcha sentence (never sent to repair). Judged from the run's failure evidence (the requests the page made, kept on failure).
 */
import fs from "node:fs";
import type { TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";
import { captchaFromRequests, captchaMessage } from "./captcha.js";

const MAX_EVIDENCE_BYTES = 2_000_000;

export function captchaFinding(spec: Pick<TestSpec, "kind">, run: Pick<ScriptRun, "artifacts" | "status">): string | undefined {
    if (spec.kind !== "web" || run.status === "passed") return undefined;
    const file = run.artifacts.find((a) => a.kind === "evidence")?.path;
    if (!file) return undefined;
    try {
        if (fs.statSync(file).size > MAX_EVIDENCE_BYTES) return undefined;
        const ev = JSON.parse(fs.readFileSync(file, "utf8")) as { requests?: Array<{ host?: string; path?: string }> };
        const kind = captchaFromRequests((ev.requests ?? []).filter((r) => typeof r.path === "string").map((r) => ({ host: r.host, path: r.path! })));
        return kind ? captchaMessage(kind) : undefined;
    } catch {
        return undefined;
    }
}
