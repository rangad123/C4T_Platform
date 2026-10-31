/**
 * Test quality: does a test actually check anything?
 *
 * AI-written (and hand-written) tests can pass without verifying much: open a page, click around, assert nothing.
 * They show up green and give false confidence. These deterministic rules read the canonical spec and flag such
 * tests as "weak". It is advice, never a status change, and — like severity — computed on read, so improving a
 * rule re-scores existing tests with no migration.
 */
import type { Step, TestSpec } from "../spec/schema.js";

export interface Quality {
    level: "good" | "weak";
    /** Plain-language reasons (empty when good). */
    reasons: string[];
}

type Checked = Pick<TestSpec, "type" | "kind" | "steps">;

/** Single-purpose families whose one built-in assertion *is* the test; judging them as "weak" would be wrong. */
export const EXEMPT_TYPES: ReadonlySet<string> = new Set(["accessibility", "visual", "health", "security", "performance"]);

const INTERACTIONS = new Set(["click", "fill", "select", "check", "press"]);
const isAssertion = (s: Step) => s.action === "assert" || s.action === "assertResponse";
/** Containers that exist on every page, so "it is visible" says nothing about the feature under test. */
const GENERIC = /^(body|html|main|#root|#app|#__next|\[role=["']?main["']?\])$/i;

function trivialWebAssertion(s: Step): boolean {
    if (s.action !== "assert") return false;
    if (s.check === "url" || s.check === "title") return true;
    if (s.check === "visible" && (!s.locator || (s.locator.by === "css" && GENERIC.test((s.locator.value ?? "").trim())))) return true;
    return false;
}

const isSuccessStatus = (s: Step) =>
    s.action === "assertResponse" &&
    ((s.check === "statusClass" && String(s.expected ?? "").startsWith("2")) || (s.check === "status" && Number(s.expected) >= 200 && Number(s.expected) < 300) || s.check === "statusBelow");
const isStatusOnly = (s: Step) => s.action === "assertResponse" && (s.check === "status" || s.check === "statusClass" || s.check === "statusBelow");

export function assessQuality(spec: Checked): Quality {
    if (EXEMPT_TYPES.has(spec.type)) return { level: "good", reasons: [] };
    const reasons: string[] = [];
    const assertions = spec.steps.filter(isAssertion);

    if (assertions.length === 0) {
        reasons.push("This test never checks anything — it only performs actions, so it would pass even if the feature were broken.");
    } else if (spec.kind === "api") {
        // Checking "2xx" on a call that returns data proves the endpoint answered, not that it answered correctly.
        // Error-path tests (expecting 4xx) legitimately check only the status, and a response value reused later counts as used.
        const usesResponse = spec.steps.some((s) => s.action === "request" && s.extract && Object.keys(s.extract).length > 0);
        const onlyStatus = assertions.every(isStatusOnly);
        if (onlyStatus && assertions.some(isSuccessStatus) && !usesResponse) {
            reasons.push("This test only checks that the request succeeded, not what came back — it would pass even if the data were wrong or empty.");
        }
    } else if (assertions.every(trivialWebAssertion)) {
        reasons.push("This test only checks that a page loaded (its address, title or a container every page has) — it would still pass if the feature on the page were missing.");
    }

    // Interactions whose result is never verified: every check happens before the first interaction.
    const firstInteraction = spec.steps.findIndex((s) => INTERACTIONS.has(s.action));
    if (firstInteraction >= 0 && assertions.length > 0 && !spec.steps.slice(firstInteraction + 1).some(isAssertion)) {
        reasons.push("The checks all happen before the first click or entry, so the result of those actions is never verified.");
    }
    return { level: reasons.length ? "weak" : "good", reasons };
}

/** Two tests with the same steps verify the same thing twice. */
const fingerprint = (spec: Checked) =>
    JSON.stringify(spec.steps.map((s) => ({ ...s, description: undefined })));

/**
 * Quality of every test in a project, including duplicate detection (the later test is the duplicate).
 * `tests` must be in creation order.
 */
export function assessProjectQuality(tests: Array<{ id: string; testKey: string; spec: Checked }>): Map<string, Quality> {
    const out = new Map<string, Quality>();
    const seen = new Map<string, string>();
    for (const t of tests) {
        const q = assessQuality(t.spec);
        if (!EXEMPT_TYPES.has(t.spec.type)) {
            const fp = fingerprint(t.spec);
            const first = seen.get(fp);
            if (first) {
                q.reasons.push(`It has exactly the same steps as ${first}, so it checks nothing new.`);
                q.level = "weak";
            } else seen.set(fp, t.testKey);
        }
        out.set(t.id, q);
    }
    return out;
}
