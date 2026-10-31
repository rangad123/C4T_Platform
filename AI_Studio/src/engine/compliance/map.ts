/**
 * Map tests to compliance controls and report coverage.
 *
 * Mapping rules follow ai-testing-agent's `ControlMapper` (MIT, Copyright (c) 2026 dannicolau7):
 * a control applies when (1) its method filter, if any, matches, and (2) a path keyword, a tag keyword,
 * or — for controls with no keywords — any test at all matches.
 *
 * Differences from the original, all fixing false positives:
 *  - keywords match whole *words* (with simple plurals), not substrings: upstream tags `/api/catalog`
 *    as audit logging because "log" is inside "catalog", and `/api/comments` as authentication ("me");
 *  - path parameters (`{id}`) are ignored, so `/products/{id}` is not "unique user identification";
 *  - web tests are supported too: their signals come from visited paths, title, area and tags, and
 *    "uses POST/PUT/PATCH" is inferred from steps that submit input.
 * Computed on read from the stored specs, so changing the rules re-maps existing tests with no migration.
 */
import type { TestSpec } from "../spec/schema.js";
import { CONTROLS, FRAMEWORKS, type Control, type Framework } from "./controls.js";

export { FRAMEWORKS, type Control, type Framework };

const singular = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

/** Lower-cased words of `text`, split on punctuation and camelCase, each also in singular form. */
export function words(text: string): Set<string> {
    const out = new Set<string>();
    for (const raw of text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) {
        if (!raw) continue;
        out.add(raw);
        out.add(singular(raw));
    }
    return out;
}

/** A keyword like "api-key" matches when all its words are present. */
function keywordMatches(keyword: string, haystack: Set<string>): boolean {
    const parts = keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => haystack.has(p) || haystack.has(singular(p)));
}

/** What a test exposes to the mapper. */
export interface TestSignals {
    pathWords: Set<string>;
    tagWords: Set<string>;
    methods: Set<string>;
}

const stripParams = (p: string) => p.replace(/\{[^}]*\}/g, " ").replace(/\{\{[^}]*\}\}/g, " ");

export function signalsOf(spec: Pick<TestSpec, "title" | "category" | "tags" | "steps">): TestSignals {
    const paths: string[] = [];
    const methods = new Set<string>();
    let submitsInput = false;
    for (const s of spec.steps) {
        if (s.action === "navigate") paths.push(stripParams(s.url));
        else if (s.action === "request") {
            paths.push(stripParams(s.path));
            methods.add(s.method);
        } else if (s.action === "fill" || s.action === "select" || s.action === "check") submitsInput = true;
    }
    if (submitsInput) ["POST", "PUT", "PATCH"].forEach((m) => methods.add(m));
    return {
        pathWords: words(paths.join(" ")),
        // Title words matter most for web tests ("Login fails with an incorrect password").
        tagWords: words([spec.category, spec.title, ...spec.tags].join(" ")),
        methods,
    };
}

export function mapControls(spec: Pick<TestSpec, "title" | "category" | "tags" | "steps">, frameworks: readonly Framework[] = FRAMEWORKS): Control[] {
    const sig = signalsOf(spec);
    return CONTROLS.filter((c) => {
        if (!frameworks.includes(c.framework)) return false;
        if (c.methods.length && ![...sig.methods].some((m) => c.methods.includes(m))) return false;
        if (c.pathKeywords.length === 0 && c.tagKeywords.length === 0) return true; // applies to everything
        return c.pathKeywords.some((k) => keywordMatches(k, sig.pathWords)) || c.tagKeywords.some((k) => keywordMatches(k, sig.tagWords));
    });
}

// ── Coverage report ─────────────────────────────────────────────────────────

export type ControlStatus = "covered" | "attention" | "gap";

export interface ControlCoverage {
    id: string;
    title: string;
    description: string;
    status: ControlStatus;
    tests: { total: number; validated: number; needsReview: number; failed: number };
    /** Database ids and display ids of the mapped tests. */
    testRefs: Array<{ id: string; testId: string; title: string; validationStatus: string }>;
}

export interface FrameworkCoverage {
    framework: Framework;
    summary: { total: number; covered: number; attention: number; gap: number };
    controls: ControlCoverage[];
}

export interface CoverageInput {
    id: string;
    testKey: string;
    spec: Pick<TestSpec, "title" | "category" | "tags" | "steps">;
    validationStatus: string;
}

/**
 * covered   = at least one mapped test passed and none has an open finding;
 * attention = a mapped test needs review or failed validation (something to look at);
 * gap       = no test maps to the control (or none has run yet).
 */
export function complianceReport(tests: CoverageInput[], frameworks: readonly Framework[] = FRAMEWORKS): FrameworkCoverage[] {
    const mapped = tests.map((t) => ({ t, controls: new Set(mapControls(t.spec, frameworks).map((c) => c.id)) }));
    return frameworks.map((framework) => {
        const controls: ControlCoverage[] = CONTROLS.filter((c) => c.framework === framework).map((c) => {
            const hits = mapped.filter((m) => m.controls.has(c.id)).map((m) => m.t);
            const count = (s: string) => hits.filter((h) => h.validationStatus === s).length;
            const validated = count("VALIDATED");
            const needsReview = count("NEEDS_REVIEW");
            const failed = count("FAILED_VALIDATION");
            const status: ControlStatus = needsReview + failed > 0 ? "attention" : validated > 0 ? "covered" : "gap";
            return {
                id: c.id,
                title: c.title,
                description: c.description,
                status,
                tests: { total: hits.length, validated, needsReview, failed },
                testRefs: hits.map((h) => ({ id: h.id, testId: h.testKey, title: h.spec.title, validationStatus: h.validationStatus })),
            };
        });
        const n = (s: ControlStatus) => controls.filter((c) => c.status === s).length;
        return { framework, summary: { total: controls.length, covered: n("covered"), attention: n("attention"), gap: n("gap") }, controls };
    });
}
