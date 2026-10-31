/** Types and wording for locator-healing suggestions (the API shape lives in src/platform/routes/healing.ts). */
export interface Locator {
    by: "role" | "label" | "text" | "placeholder" | "testId" | "css";
    role?: string;
    value?: string;
    exact?: boolean;
    nth?: number;
}

export interface Suggestion {
    id: string;
    stepIndex: number;
    stepTitle: string | null;
    oldLocator: Locator;
    newLocator: Locator;
    oldDescription: string;
    newDescription: string;
    confidence: number;
    confidenceLabel: "high" | "medium" | "low";
    reason: string;
    status: "proposed" | "applied" | "dismissed";
    createdAt: string;
    decidedAt: string | null;
    canApply: boolean;
    blockedReason?: string;
    /** Only when the step uses a shared element: fixing it changes that element, so the other tests that use it change too. */
    shared?: { name: string; otherTests: number; tests: Array<{ id: string; testId: string; title: string }> };
}

export interface SuggestionList {
    testId: string;
    validationStatus: string;
    proposals: Suggestion[];
}

export const CONFIDENCE_TEXT: Record<Suggestion["confidenceLabel"], string> = {
    high: "high confidence",
    medium: "medium confidence",
    low: "low confidence: please check it",
};

/** A locator the way a person reads it (button called “Add to cart”), not as JSON. */
export function locatorText(l: Locator): string {
    const v = l.value ?? "";
    switch (l.by) {
        case "role":
            return `${l.role ?? "element"}${v ? ` called “${v}”` : ""}`;
        case "label":
            return `field labelled “${v}”`;
        case "text":
            return `text “${v}”`;
        case "placeholder":
            return `field with the hint “${v}”`;
        case "testId":
            return `element marked “${v}”`;
        case "css":
            return `element matching ${v}`;
    }
}

/** “Add to basket” when the new locator has a readable name, for the headline. */
export function newName(l: Locator): string {
    return l.value ? `“${l.value}”` : "a different element";
}

/** The same way of finding an element (compared on the fields that decide it; a shared element's `ref` form never matches). */
export function sameLocator(a: unknown, b: unknown): boolean {
    const key = (l: unknown) => {
        const x = (l ?? {}) as Partial<Locator>;
        return JSON.stringify([x.by ?? null, x.role ?? null, x.value ?? null, x.exact ?? null, x.nth ?? null]);
    };
    return key(a) === key(b) && !!(a as Locator | undefined)?.by;
}
