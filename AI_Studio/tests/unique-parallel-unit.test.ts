/**
 * `{{unique}}` in rendered scripts: two Playwright workers that load their scripts in the same millisecond must still get different values,
 * or two tests that each register a fresh account send the same e-mail and the second is refused (409). Playwright gives each concurrently
 * running worker its own TEST_PARALLEL_INDEX; outside Playwright the value is the timestamp alone, as before.
 */
import { describe, expect, it } from "vitest";
import { dataDeclaration } from "../src/engine/generators/render-utils.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";

const spec = TestSpecSchema.parse({ testId: "API-001", title: "Health check", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/" }] });
const NOW = 1795392931538;
// The line that declares `unique` (the rest of the declaration is TypeScript).
const uniqueIn = (env: Record<string, string>) =>
    new Function("process", "Date", `${dataDeclaration(spec).split("\n")[0]}\nreturn unique;`)({ env }, { now: () => NOW }) as string;

describe("{{unique}} across parallel workers", () => {
    it("differs between two workers in the same millisecond", () => {
        expect(uniqueIn({ TEST_PARALLEL_INDEX: "0" })).not.toBe(uniqueIn({ TEST_PARALLEL_INDEX: "1" }));
    });
    it("is the timestamp followed by the worker's index, and the timestamp alone outside Playwright", () => {
        expect(uniqueIn({ TEST_PARALLEL_INDEX: "1" })).toBe(`${NOW}1`);
        expect(uniqueIn({})).toBe(String(NOW));
    });
});
