import type { TestSpec } from "../engine/spec/schema.js";

/** A test's stored spec, or undefined when it cannot be read (not JSON, or not an object with a list of steps: a damaged or very old record). */
export function readStoredSpec(json: unknown): TestSpec | undefined {
    if (typeof json !== "string") return undefined;
    try {
        const v = JSON.parse(json) as unknown;
        return v && typeof v === "object" && Array.isArray((v as { steps?: unknown }).steps) ? (v as TestSpec) : undefined;
    } catch {
        return undefined;
    }
}
