/**
 * Existing tests as a source of application knowledge: each written test case and each test script becomes a text document of numbered
 * lines with a stable ref, for rule extraction (a rule must cite the lines it comes from). The cases and scripts are passed in; nothing is
 * read from a store here. Every line passes the shared redaction, and a value typed into a field that looks secret (password, code, card,
 * token...) or a secret test-data value never appears.
 */
import { SECRET_KEY } from "../../../shared/redact-text.js";
import { describeStep, type Step, type TestSpec } from "../../spec/schema.js";
import { hideSecrets } from "./hide-secrets.js";

export const MAX_TEST_DOCUMENTS = 500;
const MAX_LINES = 200;
const MAX_LINE = 500;

export interface TestDocument {
    /** `manual-case:TC-001` or `test-script:WEB-001`: the same test always has the same ref. */
    ref: string;
    kind: "manual_case" | "test_script";
    title: string;
    lines: string[];
}

export interface WrittenCase {
    ref: string;
    title: string;
    area?: string;
    requirement?: string;
    steps: { action: string; expected?: string }[];
}

export interface StoredScript {
    /** The script's key in its project (WEB-001). */
    key: string;
    spec: TestSpec;
}

/** The lines with their numbers, as cited by extraction: `12| text`. */
export const numbered = (doc: TestDocument): string => doc.lines.map((l, i) => `${i + 1}| ${l}`).join("\n");

const SECRET_WORDS = new RegExp(`${SECRET_KEY}|one[- ]?time|\\botp\\b|\\btotp\\b|\\bpin\\b|\\bcv[vc]\\b|security code|card|verification code`, "i");
/** Short secret words that only count as a whole part of a name (`pw`, `user_pw`, `userPin`), not inside other words. */
const SECRET_PARTS = new Set(["pw", "pwd", "pin", "otp", "totp", "cvv", "cvc", "passcode", "answer", "secret"]);
const secretName = (name: string) =>
    SECRET_WORDS.test(name) ||
    name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((p) => SECRET_PARTS.has(p));
const PLACEHOLDER = /^\{\{[\w.-]+\}\}$/;

type Secrets = readonly string[];
const line = (secrets: Secrets) => (s: string) => hideSecrets(s.slice(0, MAX_LINE * 2).replace(/\s+/g, " ").trim(), { secrets, max: MAX_LINE });

/** A fill or select step with its value hidden when the field looks secret (or cannot be told) and the value is not a {{placeholder}}. */
function safeStep(step: Step): string {
    if (step.action !== "fill" && step.action !== "select") return describeStep(step);
    const words = JSON.stringify(step.locator ?? {});
    const secret = "ref" in step.locator || secretName(words);
    if (!secret || PLACEHOLDER.test(step.value)) return describeStep(step);
    // A written description could repeat the value, so the generated wording is used.
    return describeStep({ ...step, description: "", value: "[hidden]" });
}

function caseDocument(c: WrittenCase, secrets: Secrets): TestDocument {
    const lines = [`Test case ${c.ref}: ${c.title}`];
    if (c.area) lines.push(`Area: ${c.area}`);
    if (c.requirement) lines.push(`Requirement: ${c.requirement}`);
    c.steps.forEach((s, i) => {
        lines.push(`Step ${i + 1}: ${s.action}`);
        if (s.expected) lines.push(`Expected after step ${i + 1}: ${s.expected}`);
    });
    return { ref: `manual-case:${c.ref}`, kind: "manual_case", title: line(secrets)(c.title), lines: lines.slice(0, MAX_LINES).map(line(secrets)) };
}

function scriptDocument(s: StoredScript, secrets: Secrets): TestDocument {
    const spec = s.spec;
    const lines = [`Test script ${s.key}: ${spec.title}`];
    if (spec.description) lines.push(`Description: ${spec.description}`);
    for (const p of spec.preconditions ?? []) lines.push(`Precondition: ${p}`);
    spec.steps.forEach((step, i) => lines.push(`Step ${i + 1}: ${safeStep(step as Step)}`));
    for (const e of spec.expectedResults ?? []) lines.push(`Expected result: ${e}`);
    for (const [k, v] of Object.entries(spec.testData ?? {})) lines.push(`Test data: ${k} = ${secretName(k) || typeof v !== "string" ? "[hidden]" : v}`);
    return { ref: `test-script:${s.key}`, kind: "test_script", title: line(secrets)(spec.title), lines: lines.slice(0, MAX_LINES).map(line(secrets)) };
}

export function existingTestDocuments(input: { cases: WrittenCase[]; scripts: StoredScript[]; secrets?: readonly string[] }): { documents: TestDocument[]; notes: string[] } {
    const secrets = input.secrets ?? [];
    const all = [...input.cases.map((c) => caseDocument(c, secrets)), ...input.scripts.map((x) => scriptDocument(x, secrets))].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    const notes: string[] = [];
    if (all.length > MAX_TEST_DOCUMENTS) notes.push(`Only ${MAX_TEST_DOCUMENTS} of ${all.length} tests were read.`);
    return { documents: all.slice(0, MAX_TEST_DOCUMENTS), notes };
}
