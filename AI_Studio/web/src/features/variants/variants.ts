/**
 * Browser / screen-size variants as the UI shows them. The ids and names mirror the server's list
 * (src/engine/validation/variants.ts); tests/variants.test.ts checks the two stay in step. Whether a
 * variant can run on this server comes from GET /api/config, never from here.
 */
export type VariantId = "firefox" | "webkit" | "mobile-chrome" | "tablet";
export type CompatStatus = "passed" | "failed" | "unavailable" | "skipped";

export const VARIANT_UI: Array<{ id: VariantId; label: string; short: string; hint: string }> = [
    { id: "firefox", label: "Firefox", short: "Firefox", hint: "Mozilla’s browser, on a desktop screen." },
    { id: "webkit", label: "Safari (WebKit)", short: "Safari", hint: "The engine behind Safari on Mac and iPhone." },
    { id: "mobile-chrome", label: "Phone", short: "Phone", hint: "A phone-sized screen (390 × 844) with touch." },
    { id: "tablet", label: "Tablet", short: "Tablet", hint: "A tablet-sized screen (820 × 1180) with touch." },
];

const BY_ID = new Map<string, (typeof VARIANT_UI)[number]>(VARIANT_UI.map((v) => [v.id, v]));
export const variantLabel = (id: string) => BY_ID.get(id)?.label ?? id;
export const variantShort = (id: string) => BY_ID.get(id)?.short ?? id;

/** One entry of the matrix on the test page (GET /api/tests/:id → compatibility). */
export interface CompatEntry {
    status: CompatStatus;
    reason?: string;
    executionId: string;
    ranAt: string;
    durationMs: number | null;
    failedStep?: { index: number; title: string };
    artifacts: Array<{ id: string; kind: string }>;
    /** A newer main run exists: this result may describe an older version of the test. */
    stale?: boolean;
}

/** Compact summary on each row of the tests list (GET /api/projects/:id/tests → compat). */
export interface CompatBrief {
    failing: string[];
    unavailable: string[];
    passed: string[];
    severity: { severity: "medium"; basis: string } | null;
}

export interface CompatDetail {
    compatibility: Record<string, CompatEntry>;
    variantCheck: { eligible: boolean; reason?: string };
}

/** "Fails on Safari", "Fails on Safari and Phone", "Fails on 3 browsers or sizes". */
export function failsOn(failing: string[]): string {
    const names = failing.map(variantShort);
    if (names.length <= 2) return `Fails on ${names.join(" and ")}`;
    return `Fails on ${names.length} browsers or sizes`;
}

/** The "validation" line of a running / finished browser-check job (the generic text talks about validating tests). */
export function variantsPhaseText(state: string, c: { variantChecks?: number; variantFailures?: number }): { title: string; detail?: string } {
    if (state === "done") {
        const n = c.variantChecks ?? 0;
        return { title: "Browsers and screen sizes checked", detail: `${n} check${n === 1 ? "" : "s"} ran, ${c.variantFailures ?? 0} failed` };
    }
    if (state === "running") return { title: "Checking browsers and screen sizes…", detail: "Repeating your passing web tests" };
    return { title: "Check browsers and screen sizes" };
}
