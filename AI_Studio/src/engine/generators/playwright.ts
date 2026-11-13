/**
 * Spec → Playwright Test (web).
 *
 * The action→Playwright mapping is adapted from autospec (MIT, Copyright (c) 2024 Zach Blume —
 * src/reporter.ts `actionToPlaywright`) but is driven by the canonical spec instead of a recorded
 * trace, adds real assertions (autospec's replay files contain none), wraps every step in
 * `test.step` so the validator can pinpoint the failing step, and keeps secrets out of the file.
 */
import { A11Y_FAILURE_PREFIX, A11Y_MAX_RULES, A11Y_MAX_TARGETS, a11yThreshold, WCAG_TAGS } from "../a11y/audit.js";
import { EVIDENCE_HELPER_SOURCE } from "../evidence/capture.js";
import { CLEANUP_HELPER_SOURCE, runTagOf, webCleanupScriptSource } from "../cleanup/helper.js";
import { HEALTH_HELPER_SOURCE, isHealthCheck } from "../health/checks.js";
import { ACCESS_HELPER_SOURCE } from "../identity/access.js";
import { TOTP_HELPER_SOURCE, usesTotp } from "../identity/totp.js";

/** Scripts that sign in with a one-time code carry the TOTP helper: ones that use {{credentials.totp}}, and access checks (which sign in as accounts). */
const needsTotp = (spec: TestSpec) => usesTotp(JSON.stringify(spec)) || spec.steps.some((s) => s.action === "assert" && s.check === "accessDenied");
import { INPUT_HELPER_SOURCE } from "../inputs/checks.js";
import { VISION_HELPER_SOURCE } from "../vision/capture.js";
import { PERF_HELPER_SOURCE } from "../performance/checks.js";
import { assertCredentialsStayHome, CREDENTIAL_ORIGIN_HELPER_SOURCE, specUsesCredentials, stepUsesCredentials } from "../spec/credential-origin.js";
import { RUN_ADDRESS_HELPER_SOURCE, RUN_ADDRESS_IMPORT } from "../spec/run-address.js";
import { describeStep, type Step, type TestSpec } from "../spec/schema.js";
import type { RenderContext, RenderedScript, ScriptGenerator } from "./types.js";
import {
    dataDeclaration,
    dataRowsFor,
    dataSetDeclaration,
    ROW_SETUP,
    rowTitle,
    expr,
    fileHeader,
    lit,
    locatorCall,
    regexFromText,
    scriptFilename,
} from "./render-utils.js";
import { maxDiffPixels, snapshotName } from "../visual/baseline.js";
import { MAIN_PAGE_ONLY_CHECKS, POPUP_SETUP, UPLOAD_HELPER_SOURCE, UPLOAD_IMPORTS, usesPopups } from "../web/pages.js";
import { EMAIL_HELPER_SOURCE, renderEmailStep, usesEmail } from "../auth/email-step.js";

function renderStep(step: Step, snapshotName: string): string {
    const L = (l: Parameters<typeof locatorCall>[1]) => locatorCall("page", l);
    switch (step.action) {
        case "navigate":
            return `await page.goto(await allowedAddress(${expr(step.url)}, BASE_URL));`;
        case "click":
            // A click that opens a popup or a new tab: wait for it while clicking, then later "in the popup" steps work in it.
            return step.opensPopup
                ? `const popupOpened = page.waitForEvent("popup");\n        await ${L(step.locator)}.click();\n        popup = await popupOpened;\n        await popup.waitForLoadState("domcontentloaded");`
                : `await ${L(step.locator)}.click();`;
        case "upload":
            return `await uploadTestFile(page, ${L(step.locator)}, ${lit(step.file)});`;
        case "drag":
            // dragTo moves the pointer the way a person does, which fires the HTML5 drag events (dragstart, dragover, drop).
            return `await ${L(step.locator)}.dragTo(${L(step.target)});`;
        case "fill":
            return `await ${L(step.locator)}.fill(${expr(step.value)});`;
        case "select":
            return `await ${L(step.locator)}.selectOption(${expr(step.value)});`;
        case "check":
            return `await ${L(step.locator)}.setChecked(${step.checked});`;
        case "press":
            return step.locator
                ? `await ${L(step.locator)}.press(${lit(step.key)});`
                : `await page.keyboard.press(${lit(step.key)});`;
        case "hover":
            return `await ${L(step.locator)}.hover();`;
        case "wait":
            return `await page.waitForTimeout(${step.ms});`;
        case "assert":
            return renderAssert(step, snapshotName);
        case "request":
        case "assertResponse":
            throw new Error(`Step "${step.action}" is API-only and cannot be rendered by the Playwright web generator`);
        case "launchApp":
        case "closeApp":
            throw new Error(`Step "${step.action}" is for Windows desktop tests and cannot be rendered by the Playwright web generator`);
        case "useBlock":
            // Reusable steps are expanded before rendering (see ../blocks/expand.ts); seeing one here is a bug in the caller.
            throw new Error(`The reusable steps “${step.block}” were not expanded before the script was rendered`);
        case "email":
            // Emailed codes and magic links: the platform reads the test mailbox and answers the script (see ../auth/email-step.ts).
            return renderEmailStep(step, L, expr, lit);
    }
}

function renderAssert(step: Extract<Step, { action: "assert" }>, snapshotName: string): string {
    const target = step.locator
        ? locatorCall("page", step.locator)
        : step.expected !== undefined && (step.check === "visible" || step.check === "hidden")
          ? `page.getByText(${expr(String(step.expected))})`
          : `page.locator("body")`;
    const exp = step.expected !== undefined ? expr(String(step.expected)) : '""';
    switch (step.check) {
        case "visible":
            return `await expect(${target}).toBeVisible();`;
        case "hidden":
            return `await expect(${target}).toBeHidden();`;
        case "enabled":
            return `await expect(${target}).toBeEnabled();`;
        case "disabled":
            return `await expect(${target}).toBeDisabled();`;
        case "text":
            return `await expect(${target}).toContainText(${exp});`;
        case "value":
            return `await expect(${target}).toHaveValue(${exp});`;
        case "count":
            return `await expect(${target}).toHaveCount(${Number(step.expected ?? 0)});`;
        case "url":
            return `await expect(page).toHaveURL(${regexFromText(step.expected ?? "")});`;
        case "title":
            return `await expect(page).toHaveTitle(${regexFromText(step.expected ?? "")});`;
        case "a11y": {
            // axe only takes CSS selectors: a plain css locator is passed through; any other
            // strategy (or css + nth) is resolved by Playwright and tagged inside a11yAudit().
            const threshold = lit(a11yThreshold(step.expected));
            const l = step.locator;
            if (!l) return `await a11yAudit(page, ${threshold});`;
            const scope = l.by === "css" && l.nth === undefined ? expr(l.value ?? "") : locatorCall("page", l);
            return `await a11yAudit(page, ${threshold}, ${scope});`;
        }
        case "noConsoleErrors":
        case "noFailedRequests":
        case "noBrokenLinks":
        case "noMixedContent":
        case "pageBasics":
            // `health` is the collector installed at the top of the test (see render()).
            return `await healthAssert(page, health, ${lit(step.check)});`;
        case "accessDenied":
            // Probing signs in as another account, so the default 60 s test limit is not enough.
            return `test.setTimeout(120_000);\n        await allowedAddress(JSON.parse(${lit(typeof step.expected === "string" ? step.expected : "{}")}).path, BASE_URL);\n        await accessAssert(page, BASE_URL, ${lit(typeof step.expected === "string" ? step.expected : "{}")});`;
        case "looksRight": {
            // No model call in a script (it would need secrets): the script only saves the screenshot, and the platform judges it
            // after the run (see ../vision/judge.ts). The step number comes from the snapshot name ("WEB-001-3.png" = step 3).
            const index = Number(/-(\d+)\.png$/.exec(snapshotName)?.[1] ?? 1) - 1;
            const scope = step.locator ? locatorCall("page", step.locator) : "undefined";
            return `// AI judgement ("looks right"): this only saves a screenshot. The model that judges it runs inside the platform.\n        await visionCapture(page, test.info(), ${index}, ${lit(typeof step.expected === "string" ? step.expected : "")}, ${scope});`;
        }
        case "inputHandling":
            // Probing reloads the page for every try, so the default 60 s test limit is not enough.
            return `test.setTimeout(180_000);\n        await inputAssert(page, ${lit(typeof step.expected === "string" ? step.expected : "safe")});`;
        case "pageSpeed":
            // The measured values are attached to the run: that is the speed history.
            return `await pageSpeedAssert(page, ${lit(typeof step.expected === "string" ? step.expected : "")}, (name, body) => test.info().attach(name, { body, contentType: "application/json" }));`;
        case "screenshot": {
            // Compared with the approved baseline the validator places at __baselines__/<snapshotName>.
            const target = step.locator ? locatorCall("page", step.locator) : "page";
            const opts = `{ animations: "disabled", caret: "hide", maxDiffPixels: ${maxDiffPixels(step.expected)}${step.locator ? "" : ", fullPage: true"} }`;
            return `await expect(${target}).toHaveScreenshot(${lit(snapshotName)}, ${opts});`;
        }
    }
}

/**
 * Self-contained axe-core audit emitted into scripts that contain an a11y step. Mirrors
 * runA11yAudit/formatA11yViolations in ../a11y/audit.ts (same tags, threshold and message);
 * tests/a11y.test.ts checks the two produce identical failure messages.
 */
const A11Y_HELPER = `const A11Y_IMPACTS = ["minor", "moderate", "serious", "critical"];

/** axe-core audit, WCAG 2.0/2.1 A + AA. Fails on violations at or above \`minImpact\`. */
async function a11yAudit(page: Page, minImpact: string, scope?: string | Locator): Promise<void> {
    await page.waitForLoadState("load");
    const builder = new AxeBuilder({ page }).withTags(${JSON.stringify(WCAG_TAGS)});
    if (typeof scope === "string") {
        await page.locator(scope).first().waitFor({ state: "attached" });
        builder.include(scope);
    } else if (scope) {
        // axe only understands CSS selectors: tag the element Playwright resolved, then include it.
        const mark = "a11y-" + Math.random().toString(36).slice(2, 10);
        await scope.first().evaluate((el, m) => el.setAttribute("data-a11y-scope", m), mark);
        builder.include(\`[data-a11y-scope="\${mark}"]\`);
    }
    const { violations } = await builder.analyze();
    const rank = (i?: string | null) => Math.max(0, A11Y_IMPACTS.indexOf(i ?? "minor"));
    const clip = (s: string, n: number) => {
        const t = s.replace(/\\s+/g, " ").trim();
        return t.length > n ? t.slice(0, n - 3) + "..." : t;
    };
    const failing = violations.filter((v) => rank(v.impact) >= rank(minImpact)).sort((a, b) => rank(b.impact) - rank(a.impact));
    if (failing.length === 0) return;
    const lines = failing.slice(0, ${A11Y_MAX_RULES}).map((v) => {
        const targets = v.nodes
            .slice(0, ${A11Y_MAX_TARGETS})
            .map((n) => clip((n.target as unknown[]).map((t) => (Array.isArray(t) ? t.join(" >> ") : String(t))).join(" >> "), 60));
        const more = v.nodes.length > ${A11Y_MAX_TARGETS} ? ", ..." : "";
        const count = \`\${v.nodes.length} node\${v.nodes.length === 1 ? "" : "s"}\`;
        return \`- \${v.id} [\${v.impact ?? "minor"}]: \${clip(v.help, 100)} (\${count}: \${targets.join(", ")}\${more})\`;
    });
    if (failing.length > ${A11Y_MAX_RULES}) lines.push(\`- ...and \${failing.length - ${A11Y_MAX_RULES}} more rule(s)\`);
    const n = failing.length;
    throw new Error(\`${A11Y_FAILURE_PREFIX} \${n} WCAG rule\${n === 1 ? "" : "s"} violated at "\${minImpact}" impact or above\\n\${lines.join("\\n")}\`);
}
`;

export const playwrightGenerator: ScriptGenerator = {
    framework: "playwright",
    kind: "web",
    executable: true,
    render(spec: TestSpec, ctx: RenderContext): RenderedScript {
        // Health asserts are "soft": a failing one is recorded (its step is reported as failed) but the next
        // one still runs, so one run lists every kind of problem a page has. The test fails at the end.
        const isHealth = (s: Step) => s.action === "assert" && isHealthCheck(s.check);
        const health = spec.steps.some(isHealth);
        // Stored sign-in details are only ever typed on the application's own site: refused here when a step goes elsewhere first, and checked
        // again in the script against the page's real address right before the value is used (a redirect cannot get around it).
        assertCredentialsStayHome(spec, ctx);
        const usesCredentials = specUsesCredentials(spec);
        const originCheck = (step: Step): string =>
            !usesCredentials || !stepUsesCredentials(step, spec.testData)
                ? ""
                : step.action === "navigate"
                  ? `assertOwnOrigin(new URL(${expr(step.url)}, BASE_URL).toString(), BASE_URL);\n        `
                  : "assertOwnOrigin(page.url(), BASE_URL);\n        ";
        // A step "in the popup" works in the window an earlier click opened: inside its body `page` is that window (popupPage() says so plainly when none is open).
        const inPopup = (step: Step): string => {
            if (!("inPopup" in step) || step.inPopup !== true) return "";
            if (step.action === "assert" && MAIN_PAGE_ONLY_CHECKS.has(step.check)) throw new Error(`The check "${step.check}" works on the page the test started on, not in a popup`);
            return "const page = popupPage();\n        ";
        };
        const steps = spec.steps
            .map((step, i) => {
                const title = `${i + 1}. ${describeStep(step)}`;
                const body = `async () => {\n        ${inPopup(step)}${originCheck(step)}${renderStep(step, snapshotName(spec.testId, i))}\n    }`;
                // The evidence recorder labels what happens from here on with this step's number.
                return isHealth(step)
                    ? `    evidenceStep(page, ${i + 1});\n    await test.step(${lit(title)}, ${body}).catch((e) => healthFailures.push(e));`
                    : `    evidenceStep(page, ${i + 1});\n    await test.step(${lit(title)}, ${body});`;
            })
            .join("\n");
        // The collector listens from the very first moment, i.e. before the first navigation.
        const healthSetup = health ? `    const health = installHealthCollector(page, new URL(BASE_URL).origin);\n    const healthFailures: unknown[] = [];\n` : "";
        const healthEnd = health ? `\n    if (healthFailures.length) throw healthFailures[0];` : "";
        // Popups and uploads add their pieces only to the scripts that use them, so every other script stays exactly as it was.
        const popupSetup = usesPopups(spec) ? POPUP_SETUP : "";
        const uploads = spec.steps.some((s) => s.action === "upload");

        // Only scripts that audit accessibility depend on @axe-core/playwright.
        const a11y = spec.steps.some((s) => s.action === "assert" && s.check === "a11y");
        const a11yImports = a11y
            ? `import type { Locator, Page } from "@playwright/test";\nimport { AxeBuilder } from "@axe-core/playwright";\n`
            : "";
        const dataRows = dataRowsFor(spec, ctx);
        // Generated test data (testData.runTag): the records the page creates with it are written down for cleanup.
        const runTag = runTagOf(spec);
        const content = `${fileHeader(spec, "Playwright")}
import { test, expect } from "@playwright/test";
${RUN_ADDRESS_IMPORT}${a11yImports}${needsTotp(spec) ? 'import { createHmac } from "node:crypto";\n' : ""}${uploads ? UPLOAD_IMPORTS : ""}${runTag ? 'import * as cleanupFs from "node:fs";\nimport * as cleanupPath from "node:path";\n' : ""}
const BASE_URL = process.env.BASE_URL ?? ${lit(ctx.baseUrl)};
${dataRows ? dataSetDeclaration(spec, dataRows) : dataDeclaration(spec)}
${RUN_ADDRESS_HELPER_SOURCE}
${EVIDENCE_HELPER_SOURCE}
// Failure evidence: the page's network calls and console lines are kept in memory and attached to the result only when the test fails.
test.beforeEach(async ({ page }) => {
    installEvidence(page, BASE_URL);
});
test.afterEach(async ({ page }, testInfo) => {
    await evidenceAttach(page, testInfo);
});
${a11y ? `\n${A11Y_HELPER}` : ""}${usesCredentials ? `\n${CREDENTIAL_ORIGIN_HELPER_SOURCE}` : ""}${needsTotp(spec) ? `\n${TOTP_HELPER_SOURCE}` : ""}${spec.steps.some((s) => s.action === "assert" && s.check === "accessDenied") ? `\n${ACCESS_HELPER_SOURCE}` : ""}${health ? `\n${HEALTH_HELPER_SOURCE}` : ""}${spec.steps.some((s) => s.action === "assert" && s.check === "pageSpeed") ? `\n${PERF_HELPER_SOURCE}` : ""}${spec.steps.some((s) => s.action === "assert" && s.check === "inputHandling") ? `\n${INPUT_HELPER_SOURCE}` : ""}${spec.steps.some((s) => s.action === "assert" && s.check === "looksRight") ? `\n${VISION_HELPER_SOURCE}` : ""}${uploads ? `\n${UPLOAD_HELPER_SOURCE}` : ""}${usesEmail(spec) ? `\n${EMAIL_HELPER_SOURCE}` : ""}${runTag ? `\n${CLEANUP_HELPER_SOURCE}${webCleanupScriptSource({ testId: spec.testId, tag: runTag })}` : ""}
${dataRows ? "for (const [rowIndex, row] of ROWS.entries()) {\n" : ""}test(${dataRows ? rowTitle(spec) : lit(`${spec.testId}: ${spec.title}`)}, { tag: ${JSON.stringify(spec.tags.map((t) => `@${t}`))} }, async ({ page }) => {
${dataRows ? `    ${ROW_SETUP}\n` : ""}${healthSetup}${popupSetup}${steps}${healthEnd}
});
${dataRows ? "}\n" : ""}`;
        return { framework: "playwright", filename: scriptFilename(spec), content, language: "typescript" };
    },
};
