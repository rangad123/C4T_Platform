/**
 * Browser / screen-size variants and conditions as the UI shows them. The ids and names mirror the server's list
 * (src/engine/validation/variants.ts EXTRA_VARIANT_IDS / VARIANTS); tests/variants-ui.test.ts checks the two stay in step.
 * Whether a variant can run on this server comes from GET /api/config, never from here.
 */
export type VariantId = "firefox" | "webkit" | "mobile-chrome" | "tablet" | "dark" | "locale" | "high-contrast" | "reduced-motion" | "no-js";
export type CompatStatus = "passed" | "failed" | "unavailable" | "skipped";
/** "browser": another browser or screen size. "condition": desktop Chrome under another setting. */
export type VariantGroup = "browser" | "condition";

export const VARIANT_GROUPS: Array<{ id: VariantGroup; title: string }> = [
    { id: "browser", title: "Browsers and screen sizes" },
    { id: "condition", title: "Conditions" },
];

export const VARIANT_UI: Array<{ id: VariantId; label: string; short: string; hint: string; group: VariantGroup }> = [
    { id: "firefox", label: "Firefox", short: "Firefox", hint: "Mozilla’s browser, on a desktop screen.", group: "browser" },
    { id: "webkit", label: "Safari (WebKit)", short: "Safari", hint: "The engine behind Safari on Mac and iPhone.", group: "browser" },
    { id: "mobile-chrome", label: "Phone", short: "Phone", hint: "A phone-sized screen (390 × 844) with touch.", group: "browser" },
    { id: "tablet", label: "Tablet", short: "Tablet", hint: "A tablet-sized screen (820 × 1180) with touch.", group: "browser" },
    { id: "dark", label: "Dark mode", short: "Dark mode", hint: "Chrome with the computer set to dark mode.", group: "condition" },
    { id: "locale", label: "Another language and time zone", short: "Another language and time zone", hint: "Chrome in German, in the New Zealand time zone.", group: "condition" },
    { id: "high-contrast", label: "High contrast", short: "High contrast", hint: "Chrome with forced colours and more contrast, as people with low vision set it.", group: "condition" },
    { id: "reduced-motion", label: "Reduced motion", short: "Reduced motion", hint: "Chrome with the computer asking for less animation.", group: "condition" },
    { id: "no-js", label: "JavaScript off", short: "JavaScript off", hint: "Chrome with JavaScript turned off. Only tests that open pages and read them are repeated.", group: "condition" },
];

/** The variants of one group, in the server's order. */
export const variantsIn = (group: VariantGroup) => VARIANT_UI.filter((v) => v.group === group);

const BY_ID = new Map<string, (typeof VARIANT_UI)[number]>(VARIANT_UI.map((v) => [v.id, v]));
export const variantLabel = (id: string) => BY_ID.get(id)?.label ?? id;
export const variantShort = (id: string) => BY_ID.get(id)?.short ?? id;
/** Which group a variant id the server sent belongs to (an id this UI does not know yet counts as a browser). */
export const variantGroup = (id: string): VariantGroup => BY_ID.get(id)?.group ?? "browser";

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

/** "Fails on Safari", "Fails on Safari and Phone", "Fails on 3 browsers, sizes or conditions". */
export function failsOn(failing: string[]): string {
    const names = failing.map(variantShort);
    if (names.length <= 2) return `Fails on ${names.join(" and ")}`;
    return `Fails on ${names.length} browsers, sizes or conditions`;
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
