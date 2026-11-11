/**
 * Types, wording and helpers for the code editor feature (custom tests, versions, helpers, Git import).
 * The API shapes are fixed in .scratch/briefs/CODE-API-SHAPES.md. Nothing here imports CodeMirror, so every page that
 * touches this file stays light: the editor itself is a separate, lazily loaded module.
 */
import { ApiError, getKey } from "../../api.js";
import type { PlatformConfig } from "../../api.js";

export interface Diagnostic {
    severity: "error" | "warning";
    line: number;
    column: number;
    message: string;
    rule?: string;
}
export type Origin = "taken-over" | "git" | "written";
export interface CustomInfo {
    since: string;
    origin: Origin;
    canRestoreGenerated: boolean;
    git?: { host: string; path: string; ref: string; commit: string; importedAt: string };
}
export type VersionKind = "generated" | "taken-over" | "edited" | "git" | "restored";
export interface VersionRow {
    version: number;
    createdAt: string;
    note: string | null;
    bytes: number;
    kind: VersionKind;
    by: string | null;
}
export interface SaveResult {
    version?: number;
    diagnostics: Diagnostic[];
    jobId?: string | null;
    note?: string;
    testId?: string;
}
export interface CodeConfig {
    platform: boolean;
    maxBytes: number;
    guard: string[];
}
export type ConfigWithCode = PlatformConfig & { customScripts?: CodeConfig };

export const ORIGIN_LABEL: Record<Origin, string> = { "taken-over": "Switched to code", git: "From Git", written: "Written as code" };
export const VERSION_KIND_LABEL: Record<VersionKind, string> = { generated: "Generated", "taken-over": "Switched to code", edited: "Edited", git: "From Git", restored: "Restored" };

export const HELPER_NAME = /^[a-z][a-z0-9-]{0,40}$/;
export const helperNameProblem = (name: string): string =>
    HELPER_NAME.test(name) ? "" : "Use a lowercase name that starts with a letter and has only letters, numbers and dashes (up to 41 characters).";

/** Git addresses must be https: say so in words before the platform has to. */
export function gitUrlProblem(raw: string): string {
    const url = raw.trim();
    if (!url) return "Enter the address of the repository.";
    if (/^(ssh:|git@|git:|file:|http:)/i.test(url)) return "Use an address that starts with https://. Other kinds of address (ssh, file or plain http) cannot be used.";
    if (!/^https:\/\/[^\s/]+\/\S+/i.test(url)) return "Enter a full address that starts with https://, for example https://github.com/your-team/your-tests.";
    return "";
}

export const shortCommit = (c: string) => c.slice(0, 7);

/** The problems a 422 lists (`diagnostics`, or `details` from older routes). */
export function asDiagnostics(v: unknown): Diagnostic[] {
    if (!Array.isArray(v)) return [];
    return v.filter((d): d is Diagnostic => !!d && typeof d === "object" && typeof (d as Diagnostic).message === "string" && typeof (d as Diagnostic).line === "number");
}

/** The script as plain text (the script route answers text/plain, not JSON). */
export async function fetchScriptText(testId: string): Promise<string> {
    const res = await fetch(`/api/tests/${testId}/script`, { headers: getKey() ? { "x-api-key": getKey() } : {} }).catch(() => null);
    if (!res) throw new ApiError(0, "We couldn’t reach the platform server. Check that it is running and try again.");
    if (!res.ok) throw new ApiError(res.status, res.status === 404 ? "This test has no script yet." : res.statusText);
    return res.text();
}

// ── What the platform can run ───────────────────────────────────────────────

export const NOT_ENABLED_TITLE = "Code tests cannot run yet";
export const NOT_ENABLED_TEXT =
    "Running a script you wrote means running your code. Set up your runner in Settings and switch on Run code scripts there, or, on a platform you host yourself, set ALLOW_CUSTOM_SCRIPTS=true (that runs your code on the server). You can still write and save scripts now.";

// ── Starter templates (kept free of the literals the generated scripts must never contain) ──

export function starterTemplate(kind: "web" | "api"): string {
    if (kind === "api") {
        return `import { test, expect } from "@playwright/test";

// API_BASE_URL is the address of the API under test.
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

test("the service answers", async ({ request }) => {
    const response = await request.get(new URL("/", API_BASE_URL).toString());
    expect(response.status()).toBeLessThan(500);
});
`;
    }
    return `import { test, expect } from "@playwright/test";

// BASE_URL is the address of the application under test.
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

test("the home page opens", async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator("body")).toBeVisible();
    await expect(page).toHaveTitle(/.+/);
});
`;
}

export const helperStarter = (name: string): string => `// Shared by code tests: import { greet } from "./helpers/${name}";
export function greet(who: string): string {
    return \`Hello, \${who}\`;
}
`;

// ── Line diff ───────────────────────────────────────────────────────────────

export interface DiffCell {
    n: number;
    text: string;
}
export type DiffRow = { kind: "same" | "change"; left?: DiffCell; right?: DiffCell } | { kind: "gap"; count: number };

/** Longest-common-subsequence line diff. Unchanged runs are folded to three lines of context. Big inputs fall back to "everything replaced". */
export function lineDiff(before: string, after: string, context = 3): DiffRow[] {
    const a = before.split("\n");
    const b = after.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    // Edit script for the middle part: "=" same, "-" removed, "+" added.
    const ops: Array<"=" | "-" | "+"> = [];
    if (midA.length * midB.length > 4_000_000) {
        for (let i = 0; i < midA.length; i++) ops.push("-");
        for (let i = 0; i < midB.length; i++) ops.push("+");
    } else {
        const w = midB.length + 1;
        const t = new Uint32Array((midA.length + 1) * w);
        for (let i = midA.length - 1; i >= 0; i--)
            for (let j = midB.length - 1; j >= 0; j--) t[i * w + j] = midA[i] === midB[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
        let i = 0;
        let j = 0;
        while (i < midA.length && j < midB.length) {
            if (midA[i] === midB[j]) (ops.push("="), i++, j++);
            else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) (ops.push("-"), i++);
            else (ops.push("+"), j++);
        }
        while (i++ < midA.length) ops.push("-");
        while (j++ < midB.length) ops.push("+");
    }

    const rows: DiffRow[] = [];
    for (let k = 0; k < start; k++) rows.push({ kind: "same", left: { n: k + 1, text: a[k]! }, right: { n: k + 1, text: a[k]! } });
    let ia = start;
    let ib = start;
    let k = 0;
    while (k < ops.length) {
        if (ops[k] === "=") {
            rows.push({ kind: "same", left: { n: ia + 1, text: a[ia]! }, right: { n: ib + 1, text: b[ib]! } });
            ia++;
            ib++;
            k++;
            continue;
        }
        const removed: DiffCell[] = [];
        const added: DiffCell[] = [];
        while (k < ops.length && ops[k] !== "=") {
            if (ops[k] === "-") removed.push({ n: ++ia, text: a[ia - 1]! });
            else added.push({ n: ++ib, text: b[ib - 1]! });
            k++;
        }
        for (let r = 0; r < Math.max(removed.length, added.length); r++) rows.push({ kind: "change", left: removed[r], right: added[r] });
    }
    for (let x = endA; x < a.length; x++) rows.push({ kind: "same", left: { n: x + 1, text: a[x]! }, right: { n: endB + (x - endA) + 1, text: a[x]! } });

    // Fold long unchanged runs.
    const keep = new Array<boolean>(rows.length).fill(false);
    rows.forEach((r, idx) => {
        if (r.kind === "change") for (let d = -context; d <= context; d++) if (idx + d >= 0 && idx + d < rows.length) keep[idx + d] = true;
    });
    if (!rows.some((r) => r.kind === "change")) return [];
    const out: DiffRow[] = [];
    let skipped = 0;
    rows.forEach((r, idx) => {
        if (keep[idx]) {
            if (skipped) (out.push({ kind: "gap", count: skipped }), (skipped = 0));
            out.push(r);
        } else skipped++;
    });
    if (skipped) out.push({ kind: "gap", count: skipped });
    return out;
}

export const diffStats = (rows: DiffRow[]) => ({
    added: rows.filter((r) => r.kind === "change" && r.right).length,
    removed: rows.filter((r) => r.kind === "change" && r.left).length,
});
