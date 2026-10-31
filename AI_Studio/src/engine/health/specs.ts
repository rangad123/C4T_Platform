/**
 * Deterministic page-health specs (no LLM): one "health" spec per important anonymous page = open the
 * page and assert the five health checks (JavaScript errors, failed requests, broken links, mixed
 * content, page basics). Also classifies a failed health run as an application finding.
 *
 * The five asserts are "soft" in the rendered script: each is its own step and a failure does not stop
 * the next one, so a single run reports every kind of problem the page has (see generators/playwright.ts).
 */
import { selectKeyPages } from "../a11y/specs.js";
import type { DraftSpec } from "../api/test-specs.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import { HEALTH_ADVICE, HEALTH_CHECKS, HEALTH_FAILURE_PREFIX, healthCheckOf, isHealthCheck, worstTag, type HealthCheck } from "./checks.js";

export interface HealthGenOptions {
    maxPages: number;
}

const STEP_TEXT: Record<HealthCheck, string> = {
    noConsoleErrors: "No JavaScript errors are reported",
    noFailedRequests: "No request to this site fails",
    noBrokenLinks: "No link to this site's own pages is broken",
    noMixedContent: "No insecure (http://) content is loaded on a secure page",
    pageBasics: "Title, language, viewport setting and one main heading are present",
};

export function generateHealthSpecs(model: AppModel, opts: HealthGenOptions): DraftSpec[] {
    return selectKeyPages(model, opts.maxPages).map(({ page, label, priority }) => {
        const path = page.path || "/";
        const name = page.title?.trim() || path;
        const steps: Step[] = [
            { action: "navigate", url: path, description: `Open ${path}` },
            ...HEALTH_CHECKS.map((check): Step => ({ action: "assert", check, description: STEP_TEXT[check] })),
        ];
        return {
            title: `${label ? `${label} page` : "Page"} is healthy: no script errors, failed requests or broken links (${path})`,
            description: `Opens "${name}" like a visitor and watches what happens: JavaScript errors, failed requests to this site, broken links, insecure content and basic page details. Nothing is clicked or submitted.`,
            kind: "web",
            category: "Health checks",
            type: "health",
            priority,
            preconditions: [],
            steps,
            expectedResults: [
                "No JavaScript errors",
                "No failed requests to the site (HTTP 4xx / 5xx or network errors)",
                "No broken links to the site's own pages",
                "No http:// resources on an https page",
                "The page has a title, a language, a viewport setting and exactly one main heading",
            ],
            testData: {},
            tags: ["health"],
            source: { origin: "health-check" },
        };
    });
}

/** The failure text of one health step, minus any call log Playwright appended. */
function ownMessage(text: string): string | undefined {
    const at = text.indexOf(HEALTH_FAILURE_PREFIX);
    if (at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim();
}

/**
 * When `run` failed *because of page-health problems* (a failed step that is a health assert and whose
 * error is the check's own message) return the findings with how to fix them; otherwise undefined —
 * e.g. the page did not load, which is an ordinary validation failure. Every failed health step is
 * reported, not just the first.
 */
export function healthFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const isHealthStep = (s: Step | undefined) => s?.action === "assert" && isHealthCheck(s.check);
    const messages: string[] = [];
    for (const st of run.steps) {
        if (st.status !== "failed" || !isHealthStep(spec.steps[st.index])) continue;
        const m = ownMessage(st.error ?? "");
        if (m) messages.push(m);
    }
    // Playwright reported no numbered steps: rely on the message alone.
    if (messages.length === 0 && run.steps.length === 0 && spec.steps.some(isHealthStep)) {
        const m = ownMessage(run.error ?? "");
        if (m) messages.push(m);
    }
    if (messages.length === 0) return undefined;

    const checks = new Set<HealthCheck>();
    const body = messages
        .map((m, i) => {
            const tail = m.slice(HEALTH_FAILURE_PREFIX.length).trim();
            const check = healthCheckOf(tail);
            if (check) checks.add(check);
            return i === 0 ? m : tail;
        })
        .join("\n");
    const advice = [...checks].map((c) => HEALTH_ADVICE[c]).join(" ");
    return `${body}${advice ? `\nHow to fix: ${advice}` : ""}`.slice(0, 2500);
}

/** Worst severity and its basis for a health finding reason (undefined if it is not one). */
export function parseHealthReason(reason: string): Array<{ check: HealthCheck | undefined; severity: ReturnType<typeof worstTag> }> {
    if (!reason.includes(HEALTH_FAILURE_PREFIX)) return [];
    const blocks: string[][] = [];
    for (const line of reason.split("\n")) {
        if (/^how to fix:/i.test(line)) break;
        if (line.startsWith("- ")) blocks.at(-1)?.push(line);
        else blocks.push([line]);
    }
    return blocks.map((b) => ({ check: healthCheckOf(b[0] ?? ""), severity: worstTag(b.slice(1).join("\n")) }));
}
