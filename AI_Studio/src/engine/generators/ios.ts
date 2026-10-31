/**
 * Spec → iOS Taqwright test. The same generator as Android (same getBy* vocabulary, same script text), after the checks for the few
 * things iOS does differently (see ../mobile/ios-spec.ts). Only the framework label of the result differs.
 */
import { iosSpecIssues } from "../mobile/ios-spec.js";
import type { TestSpec } from "../spec/schema.js";
import { taqwrightGenerator } from "./taqwright.js";
import type { RenderContext, RenderedScript, ScriptGenerator } from "./types.js";

export const iosGenerator: ScriptGenerator = {
    framework: "taqwright-ios",
    kind: "mobile",
    executable: true,
    render(spec: TestSpec, ctx: RenderContext): RenderedScript {
        if (spec.platform !== "ios") throw new Error('An iOS script is rendered from a mobile test with platform "ios".');
        const issues = iosSpecIssues(spec);
        if (issues.length) throw new Error(issues.join(" "));
        return { ...taqwrightGenerator.render(spec, ctx), framework: "taqwright-ios" };
    },
};
