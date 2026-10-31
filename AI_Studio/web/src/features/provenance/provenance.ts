/**
 * Where a test came from, in words, read only from what the test answer stores (spec.source, generationMeta, the custom block, the
 * scripts' dates). A fact the answer does not carry is left out: nothing here guesses what the AI saw or why it chose a test.
 */
import { PRIORITY_LABEL, typeLabel } from "../../lib/labels.js";

export interface OriginInput {
    testId: string;
    type: string;
    priority: keyof typeof PRIORITY_LABEL;
    validationStatus: string;
    attempts: number;
    spec: { description?: string; source?: { origin?: string; journey?: string; requirements?: string[] } };
    generationMeta?: {
        model?: string;
        endpoint?: string;
        authoring?: string;
        explanation?: string;
        imported?: boolean;
        restored?: boolean;
        source?: string;
        /** A test the AI made by exploring a phone app: the screens it went through, in order (for example Home, Sign in, Home). */
        screenPath?: string[];
        /** What the platform keeps for a test made by exploring a phone app: the app, the idea and the screens it goes through. */
        phone?: { appPackage?: string; ideaId?: string; family?: string; path?: string[] };
        scenario?: { description?: string; priority?: string; startPath?: string; journey?: string; screenPath?: string[] };
        plain?: { description?: string };
    } | null;
    custom?: { origin: "taken-over" | "git" | "written"; since: string; git?: { host: string; path: string; ref: string } };
    scripts?: Array<{ createdAt?: string }>;
    executions?: Array<{ attempt: number; status: string; error: string | null; startedAt: string }>;
}

/** What made the test, by `spec.source.origin`. */
const MADE_BY: Record<string, string> = {
    "browser-agent": "Created by exploration",
    exploration: "Created by exploring the Android app",
    "mobile-exploration": "Created by exploring the Android app",
    openapi: "Created from the OpenAPI document",
    network: "Created from the requests seen during exploration",
    documentation: "Created from the project’s documentation",
    requirements: "Created from your requirements document",
    "a11y-audit": "Created by the accessibility check",
    "visual-baseline": "Created from an approved screenshot",
    "health-check": "Created by the page health check",
    "security-check": "Created by the security check",
    "performance-check": "Created by the speed check",
    "input-check": "Created by the form input check",
    "contract-check": "Created by the API contract check",
    "access-check": "Created by the access check",
    "vision-check": "Created by the AI screen review",
    "plain-english": "Written from your description",
    recorded: "Recorded in a browser",
    imported: "Imported from a file",
    manual: "Written as steps or text",
};

export interface Origin {
    /** The facts of the strip, in reading order. */
    parts: string[];
    /** "Why this test?": stored sentences only. Empty when the answer carries none. */
    why: Array<{ label: string; text: string }>;
    /** A test that was corrected or run again on its way to passing: what the run history says. */
    autoFix: { attempts: number; failed: Array<{ attempt: number; reason: string }> } | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const clean = (s: string | null | undefined) => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "";

export function originOf(t: OriginInput): Origin {
    const meta = t.generationMeta ?? {};
    const origin = t.spec.source?.origin ?? "manual";
    const parts: string[] = [];

    if (t.custom) {
        const g = t.custom.git;
        parts.push(t.custom.origin === "git" ? `Imported from Git${g ? ` (${g.host}${g.path.startsWith("/") ? "" : "/"}${g.path}, ${g.ref})` : ""}` : t.custom.origin === "written" ? "Written as code" : "Switched to code");
    } else if (meta.authoring === "built-in-editor") {
        parts.push("Built step by step in the editor");
    } else if (meta.restored) {
        parts.push("Restored from a backup");
    } else if (meta.source === "git-import") {
        parts.push("Imported from Git");
    } else {
        parts.push(MADE_BY[origin] ?? "Created by the platform");
    }

    // A test the AI made on a phone: the date, then the screens it went through (only what the test stored).
    const storedPath = meta.phone?.path ?? meta.screenPath ?? meta.scenario?.screenPath ?? (t.spec.source?.journey ? t.spec.source.journey.split(" → ") : []);
    const phonePath = storedPath.filter((x) => typeof x === "string" && x.trim());
    const fromPhone = !t.custom && (origin === "exploration" || origin === "mobile-exploration");
    if (fromPhone) {
        const first = (t.scripts ?? []).map((x) => x.createdAt).filter((d): d is string => !!d).sort()[0];
        if (first) parts.push(day(first));
        if (phonePath.length > 0) parts.push(`path: ${phonePath.join(" → ")}`);
        if (meta.model) parts.push(`model ${meta.model}`);
    }

    // What it was based on: only what the test stored.
    if (!fromPhone && meta.endpoint && !t.custom) parts.push(origin === "openapi" ? `from the endpoint ${meta.endpoint}` : `about ${meta.endpoint}`);
    else if (origin === "browser-agent" && t.spec.source?.journey) parts.push(`journey “${t.spec.source.journey}”`);
    if (meta.scenario?.startPath && !t.custom && !fromPhone) parts.push(`starting at ${meta.scenario.startPath}`);
    if (meta.model && !fromPhone) parts.push(`model ${meta.model}`);
    const made = (t.scripts ?? []).map((s) => s.createdAt).filter((d): d is string => !!d).sort()[0];
    if (made && !fromPhone) parts.push(day(made));

    const why: Origin["why"] = [];
    const described = meta.plain?.description;
    if (described) why.push({ label: "You asked for", text: described });
    const scenario = meta.scenario?.description;
    if (scenario && scenario !== t.spec.description) why.push({ label: "The idea behind it", text: scenario });
    if (meta.explanation && origin !== "plain-english" && meta.authoring !== "complete" && meta.authoring !== "blocked") why.push({ label: "What the AI noted", text: meta.explanation });
    if (t.spec.source?.requirements?.length) why.push({ label: "Covers requirements", text: t.spec.source.requirements.join(", ") });
    if (why.length > 0) {
        const prio = meta.scenario?.priority && meta.scenario.priority in PRIORITY_LABEL ? PRIORITY_LABEL[meta.scenario.priority as keyof typeof PRIORITY_LABEL] : PRIORITY_LABEL[t.priority];
        why.push({ label: "How it is rated", text: `${typeLabel(t.type)} test, ${prio.toLowerCase()}.` });
    }

    // `attempts` counts every run the platform made on the way to the verdict (a correction, or a straight re-run). The failed attempts are in the run history.
    const autoFix =
        t.validationStatus === "VALIDATED" && t.attempts > 1
            ? { attempts: t.attempts, failed: (t.executions ?? []).filter((e) => e.status !== "passed").sort((a, b) => a.attempt - b.attempt).slice(0, 5).map((e) => ({ attempt: e.attempt, reason: clean(e.error) })) }
            : null;
    return { parts, why, autoFix };
}
