/**
 * Spec → Windows desktop test (UI Automation through a PowerShell helper).
 *
 * The output is an ordinary Playwright Test file that never uses `page`: that keeps the existing runner, report parsing,
 * artifacts, cancel and agent protocol working unchanged, and starts no browser. Everything specific to the desktop is in the
 * helper text pasted into the script (../desktop/helper.ts), so the script is self-contained and downloadable.
 *
 * The spec's application target travels as DATA in one marked line (`aitp:target`); a second marked line (`aitp:policy`) is
 * where the computer that runs the test puts its allow-list. Nothing from the spec is ever pasted into code or into a command.
 */
import { describeDesktopStep, desktopSpecIssues } from "../desktop/spec.js";
import { DESKTOP_HELPER_SOURCE, jsLit } from "../desktop/helper.js";
import { DESKTOP_POLICY_LINE } from "../desktop/policy.js";
import { EVIDENCE_HELPER_SOURCE } from "../evidence/capture.js";
import { dataSetNameOf } from "../testdata/dataset.js";
import { describeStep, type Locator, type Step, type TestSpec } from "../spec/schema.js";
import type { RenderContext, RenderedScript, ScriptGenerator } from "./types.js";
import { concreteLocator, dataDeclaration, expr, fileHeader, lit, scriptFilename } from "./render-utils.js";

/** The locator as an object literal for the helper: a spec's `value` may hold {{placeholders}}, so it is rendered as an expression. */
function locatorLiteral(l: Locator): string {
    concreteLocator(l);
    const parts = [`by: ${lit(l.by)}`];
    if (l.value !== undefined) parts.push(`value: ${expr(l.value)}`);
    if (l.role !== undefined) parts.push(`role: ${lit(l.role)}`);
    if (l.exact) parts.push("exact: true");
    if (l.nth !== undefined) parts.push(`nth: ${l.nth}`);
    return `{ ${parts.join(", ")} }`;
}

function renderStep(step: Step): string {
    switch (step.action) {
        case "launchApp":
            return "await desk.launch();";
        case "closeApp":
            return "await desk.closeApp();";
        case "click":
            return `await desk.click(${locatorLiteral(step.locator)});`;
        case "fill":
            return `await desk.fill(${locatorLiteral(step.locator)}, ${expr(step.value)});`;
        case "select":
            return `await desk.select(${locatorLiteral(step.locator)}, ${expr(step.value)});`;
        case "check":
            return `await desk.check(${locatorLiteral(step.locator)}, ${step.checked});`;
        case "wait":
            return `await desk.wait(${step.ms});`;
        case "assert":
            return `await desk.expect(${lit(step.check)}, ${locatorLiteral(step.locator!)}${step.expected !== undefined ? `, ${expr(String(step.expected))}` : ""});`;
        default:
            throw new Error(`Step "${step.action}" cannot be rendered as a Windows desktop test`);
    }
}

export const windowsGenerator: ScriptGenerator = {
    framework: "windows-uia",
    kind: "desktop",
    executable: true,
    render(spec: TestSpec, _ctx: RenderContext): RenderedScript {
        const issues = desktopSpecIssues(spec);
        if (issues.length) throw new Error(`This desktop test cannot be rendered: ${issues[0]}`);
        if (dataSetNameOf(spec.testData)) throw new Error("Test data sets are not supported for Windows desktop tests yet.");
        const steps = spec.steps
            .map((step, i) => {
                const title = `${i + 1}. ${describeDesktopStep(step) ?? describeStep(step)}`;
                return `    await test.step(${lit(title)}, async () => {\n        ${renderStep(step)}\n    });`;
            })
            .join("\n");
        const target = jsLit(spec.desktop);
        const content = `${fileHeader(spec, "Windows UI Automation")}
import { test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// The application this test starts. The computer that runs the test decides whether it may (an allow-list it keeps itself).
const DESKTOP_TARGET = ${target}; // aitp:target
${DESKTOP_POLICY_LINE}
${dataDeclaration(spec)}
${EVIDENCE_HELPER_SOURCE}
${DESKTOP_HELPER_SOURCE}
// One test, one application, one helper process. Whatever happens, afterEach closes them (and attaches a picture of the
// application's window when the test failed).
let desk: any;

test.afterEach(async ({}, testInfo) => {
    await desk?.finish(testInfo);
});

test(${lit(`${spec.testId}: ${spec.title}`)}, { tag: ${JSON.stringify(spec.tags.map((t) => `@${t}`))} }, async ({}) => {
    test.setTimeout(${Math.max(120, Math.ceil((spec.desktop?.startTimeoutMs ?? 15_000) / 1000) + 90) * 1000});
    desk = desktopSession(DESKTOP_TARGET, DESKTOP_POLICY);
${steps}
});
`;
        return { framework: "windows-uia", filename: scriptFilename(spec, ".desktop.spec.ts"), content, language: "typescript" };
    },
};
