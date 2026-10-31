/**
 * Types, wording and calls for text tests (a test written as one line per step). The grammar itself lives on the platform
 * (src/engine/dsl): this file only talks to it, so the editor never carries a second copy of the rules.
 */
import { capi, CodeError, errorText, type Diagnostic } from "../code/code";

export { errorText };

export interface DslDiagnostic {
    line: number;
    column: number;
    endColumn: number;
    message: string;
    suggestion?: string;
    severity: "error" | "warning";
}

export interface ParsedStep {
    action: string;
    description?: string;
    [k: string]: unknown;
}
export interface ParsedSpec {
    title: string;
    kind: string;
    category: string;
    description: string;
    type: string;
    priority: string;
    preconditions: string[];
    expectedResults: string[];
    tags: string[];
    testData: Record<string, string>;
    steps: ParsedStep[];
}
export interface ParseAnswer {
    spec: ParsedSpec | null;
    diagnostics: DslDiagnostic[];
    truncated: boolean;
    stepLines: number[];
}
export interface PrintAnswer {
    text: string;
    expressible: boolean;
    reasons: string[];
}
export interface SaveTextAnswer {
    testId: string;
    changed: boolean;
    jobId: string | null;
    note?: string;
    scriptVersion?: number;
    diagnostics: Array<{ message: string; severity: string; stepIndex?: number }>;
}
export interface CreateTextAnswer {
    testId: string;
    key: string;
    jobId: string | null;
    note?: string;
}
export interface Reference {
    headers: Array<{ key: string; line: string; about: string; repeats: boolean }>;
    phrases: Array<{ id: string; group: string; for: string; about: string; template: string; example: string; aliases: string[] }>;
    notes: string[];
}

/** A refusal that carries the problems found, line by line. */
export class DslError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly diagnostics: DslDiagnostic[] = [],
    ) {
        super(message);
    }
}

const asDiagnostics = (v: unknown): DslDiagnostic[] =>
    Array.isArray(v)
        ? v
              .filter((d): d is Record<string, unknown> => !!d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string" && typeof (d as { line?: unknown }).line === "number")
              .map((d) => ({
                  line: d.line as number,
                  column: typeof d.column === "number" ? d.column : 1,
                  endColumn: typeof d.endColumn === "number" ? d.endColumn : (typeof d.column === "number" ? d.column : 1) + 1,
                  message: d.message as string,
                  ...(typeof d.suggestion === "string" ? { suggestion: d.suggestion } : {}),
                  severity: d.severity === "warning" ? ("warning" as const) : ("error" as const),
              }))
        : [];

export async function dapi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    try {
        return await capi<T>(path, init);
    } catch (e) {
        if (e instanceof CodeError) throw new DslError(e.message, e.status, asDiagnostics(e.body.diagnostics));
        throw e;
    }
}

export const parseText = (text: string) => dapi<ParseAnswer>("/dsl/parse", { method: "POST", body: { text } });

/** The editor's marker form of a problem. The suggestion goes into the same message so it shows on the line too. */
export const asMarker = (d: DslDiagnostic): Diagnostic => ({ severity: d.severity, line: d.line, column: d.column, message: d.suggestion ? `${d.message} ${d.suggestion}` : d.message });

export const bytesOf = (s: string) => new TextEncoder().encode(s).length;
export const TEXT_MAX_BYTES = 50 * 1024;

/** The two lines a new text test starts with, per kind. Plain examples the person replaces. */
export function starterText(kind: "web" | "api"): string {
    return kind === "api"
        ? `Test: The service answers\nKind: api\n\nSend a GET request to /\nExpect the status to be below 500\n`
        : `Test: The home page opens\nKind: web\n\nGo to /\nExpect the page title to contain "Home"\n`;
}

/** Saves the text as a file the browser downloads. */
export function downloadText(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fileNameFor = (title: string): string => `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "test"}.txt`;

/** The parts of a test that the text carries and the steps view does not show; they ride along when the view changes. */
export type Extras = Partial<Pick<ParsedSpec, "description" | "type" | "priority" | "tags" | "preconditions" | "expectedResults">>;
