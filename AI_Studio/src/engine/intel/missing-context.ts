/**
 * What the model could not work out, and which source would answer it: plain sentences derived from the model and its sources only, so
 * the same inputs always give the same sentences in the same order.
 */
import { SOURCE_KINDS, type AppModel, type MissingContext, type SourceKind, type SourceRecord } from "./model.js";

const LABEL: Record<SourceKind, string> = {
    exploration: "exploration",
    openapi: "API description",
    requirements: "requirements document",
    db_schema: "database schema",
    repository: "repository artefact",
    existing_tests: "existing tests",
};

const MAX_TEXT = 500;
const clip = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface MissingContextOptions {
    /** The crawl came from a runner without the newer discovery (no form constraints, page structures or requests per control). */
    oldRunner?: boolean;
}

export function missingContext(model: Pick<AppModel, "endpoints">, sources: readonly SourceRecord[], o: MissingContextOptions = {}): MissingContext[] {
    const out: MissingContext[] = [];
    const processed = (kind: SourceKind) => sources.some((s) => s.kind === kind && s.status === "processed");

    if (!processed("openapi")) {
        const n = model.endpoints.filter((e) => e.origin === "observed" && !e.responseSchema).length;
        if (n > 0) out.push({ text: `No API description: ${plural(n, "observed endpoint has", "observed endpoints have")} no response schema. Add the OpenAPI document to fill them in.`, source: "openapi" });
    }
    if (!processed("requirements")) out.push({ text: "No requirements document: rules are inferred only, and none is expected behaviour until a person confirms it.", source: "requirements" });
    if (o.oldRunner) out.push({ text: "The pages came from an older runner: download the runner again to capture form constraints, dialogs, menus, tables and the requests each control makes.", source: "exploration" });

    const failed = sources
        .filter((s) => s.status === "failed")
        .sort((a, b) => SOURCE_KINDS.indexOf(a.kind) - SOURCE_KINDS.indexOf(b.kind) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    for (const s of failed) out.push({ text: clip(`The ${LABEL[s.kind]} ${s.ref} could not be used: ${s.error ?? "it failed."}`), source: s.kind });
    return out;
}
