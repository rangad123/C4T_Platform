/**
 * Rules and workflows stated by existing tests (written test cases and test scripts): explicit, with the test as their source. The tests
 * arrive as numbered documents (sources/existing-tests.ts); each rule cites the test it comes from.
 */
import type { LlmClient } from "../../llm/provider.js";
import type { ModelFragment } from "../fragment.js";
import type { TestDocument } from "../sources/existing-tests.js";
import { extractRules } from "./rules.js";

export function extractFromTests(llm: LlmClient, documents: TestDocument[], opts: { ref?: string; knownWorkflows?: { id: string; name: string }[]; now?: string; signal?: AbortSignal } = {}): Promise<ModelFragment> {
    return extractRules(llm, {
        source: { kind: "existing_tests", ref: opts.ref ?? "existing-tests" },
        sourceType: "existing_test",
        documents: documents.map((d) => ({ ref: d.ref, lines: d.lines })),
        knownWorkflows: opts.knownWorkflows,
        now: opts.now,
        signal: opts.signal,
    });
}
