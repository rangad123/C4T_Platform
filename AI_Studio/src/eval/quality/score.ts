/**
 * The test-quality model (testing-engine Phase 1, docs/ai-testing-engine/TEST_QUALITY_MODEL.md): ten dimensions, each worked out by code
 * from what is stored (a test's steps and links, its runs, its deliberate-fault result, the application intelligence model). No model
 * scores anything here. A dimension without the evidence it needs says "not measurable" instead of guessing.
 *
 * Quality is not detection: a well-written test can miss every defect. The benchmark's seeded-defect results measure detection; this
 * measures how a test is built. Pure functions only.
 */
import type { ExpectedOutcome } from "../../engine/intel/model.js";
import { STATING_SOURCES } from "../../engine/intel/model.js";
import type { TestSpec } from "../../engine/spec/schema.js";

export const DIMENSIONS = [
    "requirementRelevance",
    "expectedResultReliability",
    "assertionQuality",
    "workflowCoverage",
    "businessRuleCoverage",
    "stateTransitionCoverage",
    "inputDiversity",
    "boundaryNegativeCoverage",
    "reproducibility",
    "executionStability",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface DimensionScore {
    dimension: Dimension;
    /** 0..1, or null: not measurable with the evidence available. */
    score: number | null;
    /** How it was worked out, in one line. */
    method: string;
    /** What it was worked out from (step numbers, refs, counts); empty when not measurable. */
    evidence: string[];
    /** Why it is not measurable, when it is not. */
    notMeasurable?: string;
}

/** What is known about the rules a test or suite can be measured against. */
export interface RuleFact {
    ref: string;
    kind: string;
    status: "unverified" | "confirmed" | "rejected";
    explicitness: "explicit" | "inferred";
}

export interface TestQualityInput {
    spec: TestSpec;
    /** Verdicts of the test's runs, oldest first (true passed, false failed, null not run). */
    runs?: Array<boolean | null>;
    /** The deliberate-fault result (mutation/faults.ts Strength), when the test was scored. */
    strength?: { caught: number; total: number };
    /** The intelligence scenario the test implements, with its expected outcomes and their sources. */
    expectedOutcomes?: ExpectedOutcome[];
    /** Rules this test is linked to (by ref). */
    ruleRefs?: string[];
    /** Requirement refs that exist in the project (to tell a real link from a stale one). */
    knownRequirements?: ReadonlySet<string>;
    /** The project's rules. */
    rules?: readonly RuleFact[];
}

// ── assertion strength ───────────────────────────────────────────────────────

/** How much each check pins down. Exact values and comparisons are strong; presence checks are weak; "no server error" is weakest. */
export const CHECK_WEIGHT: Readonly<Record<string, number>> = {
    exactText: 1,
    remembered: 1,
    value: 1,
    count: 1,
    ariaSnapshot: 1,
    accessibleErrorMessage: 1,
    urlPattern: 0.8,
    text: 0.7,
    notText: 0.6,
    url: 0.7,
    title: 0.6,
    attribute: 0.6,
    css: 0.6,
    class: 0.5,
    accessibleName: 0.6,
    checked: 0.5,
    unchecked: 0.5,
    visible: 0.3,
    hidden: 0.3,
    enabled: 0.3,
    disabled: 0.4,
    focused: 0.3,
    editable: 0.3,
    inViewport: 0.2,
    // response checks
    jsonPath: 1,
    matchesSchema: 0.8,
    bodyContains: 0.6,
    bodyNotContains: 0.5,
    status: 0.5,
    jsonType: 0.4,
    header: 0.4,
    statusClass: 0.2,
    statusBelow: 0.1,
};
const DEFAULT_WEIGHT = 0.3;

type AnyStep = TestSpec["steps"][number] & { check?: string; expected?: unknown; value?: unknown; ms?: number; until?: string; type?: string };
const isAssertion = (s: AnyStep) => s.action === "assert" || s.action === "assertResponse";
const isAction = (s: AnyStep) => !isAssertion(s) && s.action !== "wait" && s.action !== "remember" && s.action !== "condition";

export function weightOf(s: AnyStep): number {
    const w = CHECK_WEIGHT[String(s.check)] ?? DEFAULT_WEIGHT;
    // A content check without an expected value only says the element is there.
    if (["text", "exactText", "value", "count", "jsonPath", "bodyContains"].includes(String(s.check)) && (s.expected === undefined || s.expected === "")) return Math.min(w, 0.3);
    return w;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const none = (dimension: Dimension, method: string, why: string): DimensionScore => ({ dimension, score: null, method, evidence: [], notMeasurable: why });

function assertionQuality(i: TestQualityInput): DimensionScore {
    const method = "mean strength of the outcome assertions (after the last action); with a deliberate-fault result, averaged with the share of faults caught";
    const steps = i.spec.steps as AnyStep[];
    let lastAction = -1;
    steps.forEach((s, n) => {
        if (isAction(s)) lastAction = n;
    });
    const outcome = steps.map((s, n) => ({ s, n })).filter(({ s, n }) => isAssertion(s) && n > lastAction);
    if (!steps.some(isAssertion)) return { dimension: "assertionQuality", score: 0, method, evidence: ["no assertion"] };
    const evidence = outcome.map(({ s, n }) => `step ${n + 1}: ${s.check} (${weightOf(s)})`);
    const fixed = outcome.length ? outcome.reduce((a, { s }) => a + weightOf(s), 0) / outcome.length : 0;
    if (!outcome.length) evidence.push("no assertion after the last action");
    if (i.strength && i.strength.total > 0) {
        evidence.push(`faults caught ${i.strength.caught} of ${i.strength.total}`);
        return { dimension: "assertionQuality", score: round((fixed + i.strength.caught / i.strength.total) / 2), method, evidence };
    }
    return { dimension: "assertionQuality", score: round(fixed), method, evidence };
}

// ── links and sources ────────────────────────────────────────────────────────

function requirementRelevance(i: TestQualityInput): DimensionScore {
    const method = "1 when linked to an existing requirement or a confirmed/explicit rule, 0.5 when linked only to unconfirmed inferred rules, 0 when linked to nothing";
    const reqs = (i.spec.source.requirements ?? []).filter((r) => !i.knownRequirements || i.knownRequirements.has(r));
    const rules = (i.ruleRefs ?? []).map((ref) => i.rules?.find((r) => r.ref === ref)).filter((r): r is RuleFact => Boolean(r) && r!.status !== "rejected");
    if (!i.knownRequirements?.size && !i.rules?.length) return none("requirementRelevance", method, "the project has no requirements and no rules to relate tests to");
    const evidence = [...reqs.map((r) => `requirement ${r}`), ...rules.map((r) => `rule ${r.ref} (${r.explicitness}, ${r.status})`)];
    if (reqs.length || rules.some((r) => r.status === "confirmed" || r.explicitness === "explicit")) return { dimension: "requirementRelevance", score: 1, method, evidence };
    if (rules.length) return { dimension: "requirementRelevance", score: 0.5, method, evidence };
    return { dimension: "requirementRelevance", score: 0, method, evidence: ["linked to no requirement or rule"] };
}

function expectedResultReliability(i: TestQualityInput): DimensionScore {
    const method = "share of expected outcomes whose source states intended behaviour (requirement, document, OpenAPI, code, schema, existing test, confirmed by a person); inferred and observed count 0";
    if (!i.expectedOutcomes?.length) return none("expectedResultReliability", method, "the test's expected outcomes carry no source (tests generated before sources were recorded)");
    const confirmed = new Set((i.rules ?? []).filter((r) => r.status === "confirmed").map((r) => r.ref));
    const stated = i.expectedOutcomes.filter((o) => STATING_SOURCES.has(o.sourceType) || (o.ruleRef && confirmed.has(o.ruleRef)));
    return {
        dimension: "expectedResultReliability",
        score: round(stated.length / i.expectedOutcomes.length),
        method,
        evidence: i.expectedOutcomes.map((o) => `${o.sourceType}${o.ruleRef ? ` ${o.ruleRef}` : ""}: ${o.text.slice(0, 80)}`),
    };
}

// ── inputs ───────────────────────────────────────────────────────────────────

export const INPUT_CLASSES = ["empty", "whitespace", "zero", "negative", "decimal", "large-number", "long", "special", "unicode", "email", "ordinary"] as const;
export type InputClass = (typeof INPUT_CLASSES)[number];

/** The class of one typed value, by its shape ({{vars}} are resolved from the test's own data first). */
export function classOf(raw: string): InputClass {
    const v = String(raw);
    if (v === "") return "empty";
    if (!v.trim()) return "whitespace";
    if (/^-?\d+(\.\d+)?$/.test(v.trim())) {
        const n = Number(v);
        if (n === 0) return "zero";
        if (n < 0) return "negative";
        if (!Number.isInteger(n)) return "decimal";
        if (Math.abs(n) >= 1_000_000) return "large-number";
    }
    if (v.length > 100) return "long";
    if (/[^\u0000-\u007f]/.test(v)) return "unicode";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "email";
    if (/[<>'"`;\\{}%$&|]/.test(v)) return "special";
    return "ordinary";
}

const BOUNDARY_CLASSES: ReadonlySet<InputClass> = new Set(["empty", "whitespace", "zero", "negative", "large-number", "long", "special", "unicode"]);

function typedValues(spec: TestSpec): string[] {
    const data = spec.testData ?? {};
    const resolve = (v: string) => v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in data ? data[k]! : m));
    return (spec.steps as AnyStep[]).filter((s) => s.action === "fill" || s.action === "select").map((s) => resolve(String(s.value ?? "")));
}

function inputDiversity(i: TestQualityInput): DimensionScore {
    const method = "distinct input classes among typed values, divided by 4 (capped at 1)";
    const values = typedValues(i.spec);
    if (!values.length) return none("inputDiversity", method, "the test types nothing");
    const classes = [...new Set(values.map(classOf))];
    return { dimension: "inputDiversity", score: round(Math.min(1, classes.length / 4)), method, evidence: classes.map((c) => `class ${c}`) };
}

/** Whether the test probes a boundary or a negative case, and why (used per test and for the suite share). */
export function boundaryOrNegative(spec: TestSpec): string[] {
    const why: string[] = [];
    if (spec.type === "negative" || spec.type === "boundary" || spec.type === "validation") why.push(`type ${spec.type}`);
    for (const c of new Set(typedValues(spec).map(classOf))) if (BOUNDARY_CLASSES.has(c)) why.push(`input ${c}`);
    for (const s of spec.steps as AnyStep[]) {
        if (s.check === "accessibleErrorMessage") why.push("asserts a validation message");
        if (s.action === "assertResponse" && s.check === "statusClass" && String(s.expected) === "4xx") why.push("expects a 4xx answer");
        if (s.action === "assertResponse" && s.check === "status" && /^4\d\d$/.test(String(s.expected))) why.push(`expects ${s.expected}`);
    }
    return [...new Set(why)];
}

function boundaryNegative(i: TestQualityInput): DimensionScore {
    const method = "1 when the test probes a boundary or negative case (its type, a boundary input class, or an asserted rejection), else 0";
    const why = boundaryOrNegative(i.spec);
    return { dimension: "boundaryNegativeCoverage", score: why.length ? 1 : 0, method, evidence: why.length ? why : ["happy path only"] };
}

// ── running ──────────────────────────────────────────────────────────────────

function reproducibility(i: TestQualityInput): DimensionScore {
    const method = "share of three conditions met: starts by opening its own page or request; no fixed pause; uses only its own test data";
    const steps = i.spec.steps as AnyStep[];
    const ownStart = steps[0]?.action === "navigate" || steps[0]?.action === "request" || steps[0]?.action === "launchApp";
    const fixedPause = steps.some((s) => s.action === "wait" && !s.until && Number(s.ms ?? 0) > 0);
    const data = i.spec.testData ?? {};
    const outside = new Set<string>();
    for (const s of steps) for (const m of JSON.stringify(s).matchAll(/\{\{(\w+)\}\}/g)) if (m[1] !== "unique" && !(m[1]! in data) && !extracted(steps).has(m[1]!)) outside.add(m[1]!);
    const met = [ownStart, !fixedPause, outside.size === 0];
    return {
        dimension: "reproducibility",
        score: round(met.filter(Boolean).length / 3),
        method,
        evidence: [ownStart ? "opens its own start" : "does not open its own start", fixedPause ? "has a fixed pause" : "no fixed pause", outside.size ? `needs values it does not set: ${[...outside].join(", ")}` : "own data only"],
    };
}

function extracted(steps: AnyStep[]): Set<string> {
    const out = new Set<string>();
    for (const s of steps as Array<AnyStep & { extract?: Record<string, string>; name?: string }>) {
        for (const k of Object.keys(s.extract ?? {})) out.add(k);
        if (s.action === "remember" && s.name) out.add(s.name);
    }
    return out;
}

export const MIN_RUNS_FOR_STABILITY = 3;

function executionStability(i: TestQualityInput): DimensionScore {
    const method = `share of runs that agree with the most common verdict, over at least ${MIN_RUNS_FOR_STABILITY} runs that ran`;
    const ran = (i.runs ?? []).filter((r): r is boolean => r !== null);
    if (ran.length < MIN_RUNS_FOR_STABILITY) return none("executionStability", method, `${ran.length} run(s) recorded; ${MIN_RUNS_FOR_STABILITY} needed`);
    const passed = ran.filter(Boolean).length;
    return { dimension: "executionStability", score: round(Math.max(passed, ran.length - passed) / ran.length), method, evidence: [`${passed} passed, ${ran.length - passed} failed of ${ran.length}`] };
}

/** The dimensions that belong to one test (coverage dimensions are suite-level: see scoreSuite). */
export function scoreTest(i: TestQualityInput): DimensionScore[] {
    return [requirementRelevance(i), expectedResultReliability(i), assertionQuality(i), inputDiversity(i), boundaryNegative(i), reproducibility(i), executionStability(i)];
}

// ── suite level ──────────────────────────────────────────────────────────────

export interface SuiteQualityInput {
    tests: Array<{ spec: TestSpec; workflows?: string[]; ruleRefs?: string[] }>;
    /** Workflow ids of the application model. */
    workflows?: readonly string[];
    rules?: readonly RuleFact[];
}

export function scoreSuite(i: SuiteQualityInput): DimensionScore[] {
    const out: DimensionScore[] = [];
    const touchedWorkflows = new Set(i.tests.flatMap((t) => t.workflows ?? []));
    const wf = i.workflows ?? [];
    out.push(
        wf.length
            ? { dimension: "workflowCoverage", score: round(wf.filter((w) => touchedWorkflows.has(w)).length / wf.length), method: "workflows of the model reached by at least one test", evidence: wf.map((w) => `${w}: ${touchedWorkflows.has(w) ? "covered" : "not covered"}`) }
            : none("workflowCoverage", "workflows of the model reached by at least one test", "the application model has no workflows"),
    );
    const referenced = new Set(i.tests.flatMap((t) => t.ruleRefs ?? []));
    const trusted = (i.rules ?? []).filter((r) => r.status === "confirmed" || (r.explicitness === "explicit" && r.status !== "rejected"));
    out.push(
        trusted.length
            ? { dimension: "businessRuleCoverage", score: round(trusted.filter((r) => referenced.has(r.ref)).length / trusted.length), method: "confirmed or explicit rules referenced by at least one test", evidence: trusted.map((r) => `${r.ref}: ${referenced.has(r.ref) ? "covered" : "not covered"}`) }
            : none("businessRuleCoverage", "confirmed or explicit rules referenced by at least one test", "no confirmed or explicit rules"),
    );
    const transitions = trusted.filter((r) => r.kind === "transition");
    out.push(
        transitions.length
            ? { dimension: "stateTransitionCoverage", score: round(transitions.filter((r) => referenced.has(r.ref)).length / transitions.length), method: "trusted state-transition rules referenced by at least one test", evidence: transitions.map((r) => `${r.ref}: ${referenced.has(r.ref) ? "covered" : "not covered"}`) }
            : none("stateTransitionCoverage", "trusted state-transition rules referenced by at least one test", "no confirmed or explicit state-transition rules"),
    );
    const withInputs = i.tests.filter((t) => typedValues(t.spec).length || t.spec.kind === "api");
    const probing = withInputs.filter((t) => boundaryOrNegative(t.spec).length);
    out.push(
        withInputs.length
            ? { dimension: "boundaryNegativeCoverage", score: round(probing.length / withInputs.length), method: "share of tests with inputs (or API tests) that probe a boundary or negative case", evidence: [`${probing.length} of ${withInputs.length}`] }
            : none("boundaryNegativeCoverage", "share of tests with inputs (or API tests) that probe a boundary or negative case", "no test types anything"),
    );
    const classes = new Set(i.tests.flatMap((t) => typedValues(t.spec).map(classOf)));
    out.push(classes.size ? { dimension: "inputDiversity", score: round(classes.size / INPUT_CLASSES.length), method: "distinct input classes across the suite, of all classes", evidence: [...classes].map((c) => `class ${c}`) } : none("inputDiversity", "distinct input classes across the suite, of all classes", "no test types anything"));
    return out;
}
