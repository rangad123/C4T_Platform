/** Turns a recording into a canonical web spec (the platform's normal import shape: no testId, the platform assigns one). */
import { hasSavableSteps } from "./normalise.js";
import { isSecretKind, SECRET_PLACEHOLDERS, type RecLocator, type RecStep } from "./model.js";

type SpecLocator = { by: string; role?: string; value?: string; exact?: boolean } | { ref: string };

export function toSpecLocator(l: RecLocator): { by: string; role?: string; value?: string; exact?: boolean } {
    if (l.strategy === "role") return { by: "role", role: l.value, ...(l.name !== undefined ? { value: l.name } : {}), ...(l.exact ? { exact: true } : {}) };
    return { by: l.strategy, value: l.value, ...(l.exact ? { exact: true } : {}) };
}

/** A shared element is used as it is; a concrete locator carries the frames the element was recorded in. */
const loc = (s: RecStep): SpecLocator | undefined => (s.ref ? { ref: s.ref } : s.locator ? { ...toSpecLocator(s.locator), ...(s.frame?.length ? { frame: s.frame } : {}) } : undefined);
/** The popup fields of a step, only when set (a recording without popups gives exactly the steps it gave before). */
const popupFields = (s: RecStep): Record<string, boolean> => ({ ...(s.opensPopup ? { opensPopup: true } : {}), ...(s.inPopup ? { inPopup: true } : {}) });

/** A path (same site) or the full address (another site). */
function urlForSpec(url: string, origin: string): string {
    try {
        const u = new URL(url);
        return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : url;
    } catch {
        return url;
    }
}

const SECRET_VALUES = new Set<string>(Object.values(SECRET_PLACEHOLDERS));

/** The site (origin) a step list opens that is not the start site, if any. */
export function foreignOrigins(steps: RecStep[], startUrl: string): string[] {
    const base = new URL(startUrl).origin;
    const seen = new Set<string>();
    for (const s of steps) {
        if (s.kind !== "goto" || !s.url) continue;
        try {
            const o = new URL(s.url).origin;
            if (o !== base) seen.add(o);
        } catch {
            /* a malformed address is reported by the spec check */
        }
    }
    return [...seen];
}

export function buildRecordedSpec(input: { title: string; category?: string; startUrl: string; steps: RecStep[]; recordedAt?: string }): { spec: Record<string, unknown>; problems: string[] } {
    const problems: string[] = [];
    if (!hasSavableSteps(input.steps)) problems.push("There is nothing to save yet: click through the application first.");
    const origin = new URL(input.startUrl).origin;
    const out: Array<Record<string, unknown>> = [];
    if (input.steps[0]?.kind !== "goto") out.push({ action: "navigate", url: urlForSpec(input.startUrl, origin), description: `Open ${input.startUrl}` });
    for (const s of input.steps) {
        const l = loc(s);
        const description = s.describe;
        // A secret step must carry its stand-in, never anything else.
        if (s.secret && (s.value === undefined || !SECRET_VALUES.has(s.value))) problems.push(`Step ${s.index + 1} is marked secret but holds a value; delete or re-record it.`);
        switch (s.kind) {
            case "goto":
                out.push({ action: "navigate", url: urlForSpec(s.url ?? input.startUrl, origin), description });
                break;
            case "click":
                out.push({ action: "click", locator: l, ...popupFields(s), description });
                break;
            case "fill":
                out.push({ action: "fill", locator: l, value: s.value ?? "", ...popupFields(s), description });
                break;
            case "select":
                out.push({ action: "select", locator: l, value: s.value ?? "", ...popupFields(s), description });
                break;
            case "check":
            case "uncheck":
                out.push({ action: "check", locator: l, checked: s.kind === "check", ...popupFields(s), description });
                break;
            case "press":
                out.push({ action: "press", key: s.value ?? "Enter", ...(l ? { locator: l } : {}), ...popupFields(s), description });
                break;
            case "assert":
                if (s.assert) out.push({ action: "assert", check: s.assert.check, ...(l ? { locator: l } : {}), ...(s.assert.expected !== undefined ? { expected: s.assert.expected } : {}), ...popupFields(s), description });
                break;
            case "upload":
                // Only the file name was recorded: the file itself comes from the project's test files when the test runs.
                out.push({ action: "upload", locator: l, file: s.value ?? "", ...popupFields(s), description });
                break;
            case "drag":
                if (!s.target) problems.push(`Step ${s.index + 1} has no place to drop on.`);
                else out.push({ action: "drag", locator: l, target: { ...toSpecLocator(s.target), ...(s.frame?.length ? { frame: s.frame } : {}) }, ...popupFields(s), description });
                break;
        }
        if (s.kind !== "goto" && s.kind !== "assert" && !l) problems.push(`Step ${s.index + 1} has no locator.`);
        if (s.secret && s.kind === "fill" && !isSecretKind(Object.entries(SECRET_PLACEHOLDERS).find(([, p]) => p === s.value)?.[0])) problems.push(`Step ${s.index + 1} holds an unknown secret stand-in.`);
    }
    const asserts = input.steps.filter((s) => s.kind === "assert").map((s) => s.describe);
    return {
        problems,
        spec: {
            title: input.title,
            description: `Recorded by clicking through ${origin}${input.recordedAt ? ` on ${input.recordedAt.slice(0, 10)}` : ""}.`,
            kind: "web",
            category: input.category?.trim() || "Recorded",
            type: "functional",
            priority: "medium",
            steps: out,
            expectedResults: asserts,
            tags: ["recorded"],
            source: { origin: "recorded" },
        },
    };
}
