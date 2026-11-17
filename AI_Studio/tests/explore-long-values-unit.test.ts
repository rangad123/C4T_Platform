/**
 * Long input values end to end (fast tier, pure; CP1 finding, queue row 161). An input class may be thousands of characters long (a
 * maxlength 2000 field's "above" value has 2001). The scenario prompt writes such a value short, as a {{repeat.<c>.<n>}} placeholder the
 * runtime renders, so the prompt stays small, the step the agent records types the exact value, and operatorApplied recognises it.
 */
import { describe, expect, it } from "vitest";
import { objectivesFrom, type Objective } from "../src/engine/explore/objectives.js";
import { inputClassesFor } from "../src/engine/explore/input-classes.js";
import { operatorApplied, perturbInputClassOf, scenarioFor } from "../src/engine/explore/perturb.js";
import { expr } from "../src/engine/generators/render-utils.js";
import { interpolate, type Step } from "../src/engine/spec/schema.js";

const budget = { steps: 30, minutes: 10, tokens: 300_000 };
const objectiveFor = (field: Record<string, unknown>): Objective =>
    objectivesFrom({ pages: [{ id: "P-note", path: "/note", forms: [{ name: "note", fields: [{ name: "body", ...field }] }] }] }, [], [], { maxObjectives: 10, budget }).objectives[0]!;
const nav = (url: string): Step => ({ action: "navigate", url, description: `Open ${url}` });
const click = (name: string): Step => ({ action: "click", locator: { by: "role", role: "button", value: name }, description: `Click ${name}` });
const fill = (value: string): Step => ({ action: "fill", locator: { by: "label", value: "Body" }, value, description: "Fill Body" });

function boundaryScenario(field: Record<string, unknown>) {
    const o = objectiveFor(field);
    const classes = inputClassesFor({ name: "body", ...field }, o.source.ref);
    const r = scenarioFor(o, "boundary_input", { dataOperators: true, inputClasses: classes });
    if (r.status !== "ready") throw new Error(`skipped: ${r.reason}`);
    return r;
}

describe("a maxlength 2000 field: the 2001-character class", () => {
    const r = boundaryScenario({ maxLength: 2000 });
    const long = "a".repeat(2001);

    it("is listed with its exact value, and the prompt writes it short", () => {
        expect(r.check.values).toContain(long);
        expect(r.scenario.description).toContain('"{{repeat.a.2001}}"');
        expect(r.scenario.description).not.toContain("a".repeat(100));
        expect(r.scenario.description.length).toBeLessThan(4000);
        expect(r.scenario.requiredData.some((d) => d.includes('"{{repeat.a.2001}}"'))).toBe(true);
        expect(r.scenario.requiredData.join("\n")).not.toContain("a".repeat(100));
    });

    it("the placeholder the agent copies renders the exact value, live and in the rendered script", () => {
        expect(interpolate("{{repeat.a.2001}}", {})).toBe(long);
        expect(new Function(`return ${expr("{{repeat.a.2001}}")};`)()).toBe(long);
    });

    it("counts as applied when the recorded step types it, as the placeholder or literally, then submits", () => {
        expect(operatorApplied([nav("/note"), fill("{{repeat.a.2001}}"), click("Save")], "boundary_input", r.check)).toBe(true);
        expect(operatorApplied([nav("/note"), fill(long), click("Save")], "boundary_input", r.check)).toBe(true);
        // A value cut short is not the class.
        expect(operatorApplied([nav("/note"), fill("a".repeat(1100)), click("Save")], "boundary_input", r.check)).toBe(false);
        expect(operatorApplied([nav("/note"), fill("{{repeat.a.2000}}x"), click("Save")], "boundary_input", { values: [long] })).toBe(false);
    });

    it("an email field's long value keeps its format around the placeholder", () => {
        const e = boundaryScenario({ type: "email", maxLength: 2000 });
        const value = `${"a".repeat(1996)}@x.io`;
        expect(e.check.values).toContain(value);
        expect(e.scenario.description).toContain('"{{repeat.a.1996}}@x.io"');
        expect(operatorApplied([fill("{{repeat.a.1996}}@x.io"), click("Save")], "boundary_input", e.check)).toBe(true);
    });
});

describe("short values", () => {
    it("are written as they are", () => {
        const r = boundaryScenario({ maxLength: 20 });
        expect(r.check.values).toContain("a".repeat(21));
        expect(r.scenario.description).toContain(JSON.stringify("a".repeat(21)));
        expect(r.scenario.description).not.toContain("{{repeat.");
        expect(operatorApplied([fill("a".repeat(21)), click("Save")], "boundary_input", r.check)).toBe(true);
    });

    it("text that only looks like a repeat placeholder stays as written", () => {
        for (const t of ["{{repeat.a.0}}", "{{repeat.ab.3}}", "{{repeat.a.10001}}", "{{repeat.-.3}}"]) expect(interpolate(t, {})).toBe(t);
        expect(interpolate("x{{repeat.Z.3}}y", {})).toBe("xZZZy");
    });
});

describe("perturbInputClassOf", () => {
    it("maps an input class onto the operator's input: accepted from the expected result, boundary for a value at or past a limit", () => {
        const classes = inputClassesFor({ name: "body", required: true, maxLength: 2000 }, "P-note#body");
        const by = (key: string) => perturbInputClassOf(classes.find((c) => c.key === key)!);
        expect(by("P-note#body#empty")).toEqual({ name: "empty", value: "", accepted: false, boundary: false });
        expect(by("P-note#body#boundary:at:maxLength")).toEqual({ name: "boundary at (maxLength)", value: "a".repeat(2000), accepted: true, boundary: true });
        expect(by("P-note#body#long:maxLength")).toEqual({ name: "long (maxLength)", value: "a".repeat(2001), accepted: false, boundary: true });
        const unlimited = inputClassesFor({ name: "body" }, "P-note#body").find((c) => c.class === "long")!;
        expect(perturbInputClassOf(unlimited)).toMatchObject({ accepted: true, boundary: false });
    });
});
