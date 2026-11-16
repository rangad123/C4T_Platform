/**
 * A failed web run whose page showed a captcha: the failure is the captcha, not the test or the application, so it is reported with the
 * captcha sentence (never sent to repair). Judged from the run's failure evidence: the captcha widget a person could see on the page when
 * the test failed, as the evidence helper recorded it. A captcha script or frame that only loaded (an ad or analytics script loading
 * reCAPTCHA's hidden frame) is not counted, and the requests the page made never decide it.
 */
import fs from "node:fs";
import type { TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";
import { captchaSeenMessage, type CaptchaSeen } from "./captcha.js";

const MAX_EVIDENCE_BYTES = 2_000_000;
const KINDS = new Set(["reCAPTCHA", "hCaptcha", "Turnstile"]);

export function captchaFinding(spec: Pick<TestSpec, "kind">, run: Pick<ScriptRun, "artifacts" | "status">): string | undefined {
    if (spec.kind !== "web" || run.status === "passed") return undefined;
    const file = run.artifacts.find((a) => a.kind === "evidence")?.path;
    if (!file) return undefined;
    try {
        if (fs.statSync(file).size > MAX_EVIDENCE_BYTES) return undefined;
        const c = (JSON.parse(fs.readFileSync(file, "utf8")) as { captcha?: Partial<CaptchaSeen> }).captcha;
        if (!c || !KINDS.has(c.kind as string) || typeof c.w !== "number" || typeof c.h !== "number" || typeof c.path !== "string") return undefined;
        return captchaSeenMessage({ kind: c.kind!, w: c.w, h: c.h, inForm: c.inForm === true, ...(typeof c.form === "string" && c.form ? { form: c.form.slice(0, 60) } : {}), path: c.path.slice(0, 200) });
    } catch {
        return undefined;
    }
}
