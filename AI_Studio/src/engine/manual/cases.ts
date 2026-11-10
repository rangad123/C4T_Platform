/**
 * Manual test cases: the checks a person does by hand (exploratory, visual, hardware, "ask the finance team").
 *
 * Pure types and validation, shared by the API, the import/export code and the tests. Every piece of text is untrusted:
 * it is trimmed, stripped of control characters and length-capped here, and escaped again wherever it is shown.
 */
import { z } from "zod";

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type CasePriority = (typeof PRIORITIES)[number];
/** Whether a written case can be checked by a tool (a test script can be made from it) or needs a person. */
export const CASE_AUTOMATION = ["automated", "manual"] as const;
export type CaseAutomation = (typeof CASE_AUTOMATION)[number];

export const MAX_CASES = 500;
export const MAX_STEPS = 30;
export const MAX_TITLE = 160;
export const MAX_AREA = 80;
export const MAX_STEP_TEXT = 500;
export const MAX_REQUIREMENT = 500;
export const MAX_LINKED = 50;
export const DEFAULT_AREA = "General";

/** Control characters other than newline and tab never belong in a title or a step. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const clean = (s: string): string => s.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();

const text = (max: number, what: string) =>
    z
        .string({ error: (iss) => (iss.input === undefined ? `${what} is required` : `${what} must be text`) })
        .transform(clean)
        .pipe(z.string().min(1, `${what} is required`).max(max, `${what} can be at most ${max} characters`));
const optionalText = (max: number, what: string) =>
    z
        .string()
        .transform(clean)
        .pipe(z.string().max(max, `${what} can be at most ${max} characters`));

export const ManualStepSchema = z.object({
    action: text(MAX_STEP_TEXT, "A step’s action"),
    expected: optionalText(MAX_STEP_TEXT, "A step’s expected result").default(""),
});
export type ManualStep = z.infer<typeof ManualStepSchema>;

export const ManualCaseInputSchema = z.object({
    title: text(MAX_TITLE, "The title"),
    steps: z.array(ManualStepSchema).max(MAX_STEPS, `A case can have at most ${MAX_STEPS} steps`).default([]),
    area: optionalText(MAX_AREA, "The area")
        .default(DEFAULT_AREA)
        .transform((a) => a || DEFAULT_AREA),
    priority: z.enum(PRIORITIES).default("medium"),
    linkedTestIds: z.array(z.string().min(1).max(100)).max(MAX_LINKED, `A case can be linked to at most ${MAX_LINKED} tests`).default([]),
    requirement: optionalText(MAX_REQUIREMENT, "The requirement").default(""),
    /** Absent: a new case is Manual, a changed case keeps its type. */
    automation: z.enum(CASE_AUTOMATION, { error: () => "The type is automated or manual" }).optional(),
    /** The requirement record the case comes from (Requirements place). Absent keeps it on a change; null clears it. */
    requirementId: z.string().min(1).max(64).nullable().optional(),
});
export type ManualCaseInput = z.infer<typeof ManualCaseInputSchema>;

export interface ManualCase extends Omit<ManualCaseInput, "automation" | "requirementId"> {
    id: string;
    /** The case's number in its project (1, 2, ...), shown as `ref`. */
    number: number;
    /** TC-001: the id people read. */
    ref: string;
    automation: CaseAutomation;
    requirementId: string | null;
    createdAt: string;
    updatedAt: string;
}

/** The id people read for a case's number: TC-001, TC-002, ... TC-1000. */
export const caseRef = (n: number): string => `TC-${String(n).padStart(3, "0")}`;

export const RESULTS = ["not_run", "passed", "failed", "blocked", "skipped"] as const;
export type ManualResult = (typeof RESULTS)[number];
export const MAX_NOTE = 1000;
export const MAX_NAME = 80;

/** Words for the results, used by the page, the report and the issue text. */
export const RESULT_LABEL: Record<ManualResult, string> = { not_run: "Not run", passed: "Passed", failed: "Failed", blocked: "Blocked", skipped: "Skipped" };

export const ResultInputSchema = z.object({
    result: z.enum(RESULTS),
    /** Absent keeps the note already there; an empty string clears it. */
    note: optionalText(MAX_NOTE, "The note").optional(),
    by: optionalText(MAX_NAME, "The name").optional(),
});
export type ResultInput = z.infer<typeof ResultInputSchema>;

/** Rank used to order cases: critical first. */
export const priorityRank = (p: CasePriority): number => PRIORITIES.indexOf(p);

/** Duplicate key used by import: the same title in the same area counts as the same case. */
export const caseKey = (c: { title: string; area: string }): string => `${c.area.toLowerCase()}\u0000${c.title.toLowerCase()}`;
