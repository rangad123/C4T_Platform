/**
 * Testing the tests: a test that still passes when the application is broken proves nothing.
 *
 * Each validated web test is replayed with one deliberate fault at a time, all of them in the test's own browser only:
 *   error    the application's pages and data calls, from the action the checked step depends on, come back as a server error
 *   empty    ... come back empty (an empty page, an empty list)
 *   changed  the text or value the test checks comes back changed (in the responses; else changed in the page just before the check)
 *   hidden   the element the test checks is hidden with an injected style
 * A run that fails under a fault "caught" it; one that passes "missed" it; a fault that found nothing to change does not count.
 *
 * Requests are never changed on their way to the application: every request the browser makes is sent exactly as it was
 * (`route.fetch()` replays it unchanged), and only the response the browser receives is altered. Fault runs are never recorded
 * as the test's executions.
 */
import { throwIfAborted, type EngineContext } from "../context.js";
import { localExecutor, renderWithAdapter, type ScriptExecutor } from "../frameworks/index.js";
import type { RenderContext } from "../generators/index.js";
import { lit, locatorCall } from "../generators/render-utils.js";
import { runTagOf } from "../cleanup/helper.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { RunEnv, ScriptInput, ScriptRun } from "../validation/runner.js";
import { variantEligibility } from "../validation/variants.js";
import { isSocketFault, socketFaults, socketFaultScript, type SocketFaultKind } from "../web/socket-faults.js";

export type FaultKind = "error" | "empty" | "changed" | "hidden" | SocketFaultKind;

export interface Fault {
    kind: FaultKind;
    /** Plain words: "the page's data comes back as a server error". Also the end of the strengthening note. */
    label: string;
}

/** What is stored on the test (generation meta `strength`) and shown on its page. */
export interface Strength {
    caught: number;
    /** Faults that really took effect (a fault that found nothing to change is not counted). */
    total: number;
    /** Labels of the faults the test missed. */
    missed: string[];
    /** The test was given a stronger assertion after missing faults (the score is the stronger version's). */
    strengthened?: boolean;
    checkedAt: string;
}

export const NOT_APPLIED = "DELIBERATE_FAULT_NOT_APPLIED";
const CHANGED = "~changed by a deliberate fault~";
const CONTENT_CHECKS = new Set(["visible", "text", "value", "count", "url", "title", "enabled", "disabled"]);
const ELEMENT_CHECKS = new Set(["visible", "text", "value", "enabled", "disabled"]);

type AssertStep = Extract<Step, { action: "assert" }>;

/** The checked step (the last assertion on what a user sees) and the action before it whose responses it depends on. */
export function keyStep(spec: TestSpec): { key: number; trigger: number } | undefined {
    const key = spec.steps.findLastIndex((s) => s.action === "assert" && CONTENT_CHECKS.has(s.check));
    if (key < 0) return undefined;
    const trigger = spec.steps.slice(0, key).findLastIndex((s) => s.action !== "assert" && s.action !== "wait");
    return { key, trigger: Math.max(0, trigger) };
}

/** Whether a test is worth (and safe) replaying with faults; the reason when not. */
export function faultEligibility(spec: TestSpec, validationStatus: string): { eligible: true } | { eligible: false; reason: string } {
    const v = variantEligibility(spec, validationStatus);
    if (!v.eligible) return v;
    // A test that creates records would create them again on every replay, with nobody to remove them.
    if (runTagOf(spec)) return { eligible: false, reason: "It creates records, so it is not replayed." };
    if (spec.steps.some((s) => s.action === "email")) return { eligible: false, reason: "It reads emails, so it is not replayed." };
    if (!keyStep(spec)) return { eligible: false, reason: "It has no check on what the page shows." };
    return { eligible: true };
}

/** The text a response-level "changed" fault looks for: the asserted text, when it is a literal long enough to find safely. */
function changeableText(step: AssertStep): string | undefined {
    const e = step.expected;
    if (typeof e !== "string" || e.trim().length < 3 || e.includes("{{")) return undefined;
    return ["text", "value", "visible", "title"].includes(step.check) ? e : undefined;
}

/** The locator expression of the element the checked step looks at, as the generator renders it (undefined: no element). */
function targetOf(step: AssertStep): string | undefined {
    if (step.inPopup) return undefined;
    if (step.locator) return locatorCall("page", step.locator);
    if (step.expected !== undefined && step.check === "visible") return `page.getByText(${lit(String(step.expected))})`;
    return undefined;
}

/** The faults that apply to a test, in a fixed order. */
export function faultsFor(spec: TestSpec, opts: { webSockets?: boolean } = {}): Fault[] {
    const k = keyStep(spec);
    if (!k) return [];
    const step = spec.steps[k.key] as AssertStep;
    const out: Fault[] = [
        { kind: "error", label: "the page's data comes back as a server error" },
        { kind: "empty", label: "the page's data comes back empty" },
    ];
    const text = changeableText(step);
    const target = ELEMENT_CHECKS.has(step.check) ? targetOf(step) : undefined;
    if (text) out.push({ kind: "changed", label: `the text "${text.slice(0, 60)}" comes back changed` });
    else if (target) out.push({ kind: "changed", label: "the checked element shows different content" });
    if (target) out.push({ kind: "hidden", label: "the checked element is hidden" });
    // Socket and offline faults (../web/socket-faults.ts): only for an application exploring saw use a WebSocket.
    // Offline only after an action on the page: a navigate that triggers the check would just fail to load, which proves nothing about the test.
    const navigates = spec.steps[k.trigger]?.action === "navigate";
    out.push(...socketFaults(opts.webSockets === true).filter((f) => !(navigates && f.kind === "offline")));
    return out;
}

/** Added to a fault script. Only responses are changed; `route.fetch()` sends each request exactly as the browser made it. */
const FAULT_HELPER = `
// ── Deliberate fault (testing the test): only what the browser receives is changed, never what is sent ──
const FAULT: { kind: string; text?: string; applied: boolean } = { kind: "", applied: false };
test.beforeEach(() => { FAULT.applied = false; });
test.afterEach(async ({}, testInfo) => {
    // Nothing was changed: this run says nothing about the test.
    if (testInfo.status === "passed" && !FAULT.applied) throw new Error(${lit(NOT_APPLIED)});
});
async function faultResponses(page: import("@playwright/test").Page): Promise<void> {
    const origin = new URL(BASE_URL).origin;
    await page.context().route("**/*", async (route) => {
        const req = route.request();
        if (!["document", "fetch", "xhr"].includes(req.resourceType()) || new URL(req.url()).origin !== origin) return route.fallback();
        const res = await route.fetch({ maxRedirects: 0 });
        if (res.status() >= 300 && res.status() < 400) return route.fulfill({ response: res });
        const type = res.headers()["content-type"] ?? "";
        if (FAULT.kind === "error") {
            FAULT.applied = true;
            return route.fulfill({ status: 500, contentType: "text/plain", body: "Deliberate fault: server error" });
        }
        if (FAULT.kind === "empty") {
            FAULT.applied = true;
            if (/json/.test(type)) return route.fulfill({ response: res, body: (await res.text()).trim().startsWith("[") ? "[]" : "{}" });
            if (/html/.test(type)) return route.fulfill({ response: res, body: "<!doctype html><html><head><title></title></head><body></body></html>" });
            return route.fulfill({ response: res, body: "" });
        }
        const body = /json|html|text|xml|javascript/.test(type) ? await res.text() : undefined;
        if (body === undefined || !FAULT.text || !body.includes(FAULT.text)) return route.fulfill({ response: res });
        FAULT.applied = true;
        return route.fulfill({ response: res, body: body.split(FAULT.text).join(${lit(CHANGED)}) });
    });
}
async function faultElement(page: import("@playwright/test").Page, target: import("@playwright/test").Locator): Promise<void> {
    await page.waitForLoadState("load").catch(() => undefined);
    if (!(await target.first().waitFor({ state: "attached", timeout: 8_000 }).then(() => true, () => false))) return;
    const n = await target.evaluateAll((els, a) => {
        for (const el of els as HTMLElement[]) {
            if (a.kind === "hidden") el.style.setProperty("display", "none", "important");
            else if ("value" in el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) (el as HTMLInputElement).value = a.changed;
            else el.textContent = a.changed;
        }
        return els.length;
    }, { kind: FAULT.kind, changed: ${lit(CHANGED)} });
    if (n > 0) FAULT.applied = true;
}
`;

/** Insert a line just before step n (1-based) of a rendered script. Undefined when the marker is not there. */
function before(content: string, n: number, line: string): string | undefined {
    const marker = `\n    evidenceStep(page, ${n});\n`;
    const at = content.indexOf(marker);
    return at < 0 ? undefined : `${content.slice(0, at)}\n    ${line}${content.slice(at)}`;
}

/** The test's script with one fault built in. Undefined when the script does not have the shape it expects. */
export function faultScript(spec: TestSpec, render: RenderContext, fault: Fault): ScriptInput | undefined {
    const k = keyStep(spec);
    if (!k) return undefined;
    if (isSocketFault(fault.kind)) return socketFaultScript(spec, render, fault.kind);
    const step = spec.steps[k.key] as AssertStep;
    const script = renderWithAdapter(spec, "playwright", render);
    const text = fault.kind === "changed" ? changeableText(step) : undefined;
    let content: string | undefined = script.content + FAULT_HELPER;
    content = before(content, 1, `FAULT.kind = ${lit(fault.kind)};${text ? ` FAULT.text = ${lit(text)};` : ""}`);
    if (!content) return undefined;
    if (fault.kind === "error" || fault.kind === "empty" || text) content = before(content, k.trigger + 1, "await faultResponses(page);");
    else {
        const target = targetOf(step);
        if (!target) return undefined;
        content = before(content, k.key + 1, `await faultElement(page, ${target});`);
    }
    if (!content) return undefined;
    return { testId: `${spec.testId}~fault-${fault.kind}`, filename: script.filename.replace(/\.spec\.ts$/, `.fault-${fault.kind}.spec.ts`), content, framework: "playwright" };
}

export type FaultResult = "caught" | "missed" | "not_applied" | "no_result";

export function classifyFaultRun(run: ScriptRun | undefined): FaultResult {
    if (!run || run.notRun || run.status === "error" || run.status === "skipped") return "no_result";
    if (run.status === "passed") return "missed";
    const failed = run.steps.find((s) => s.status === "failed");
    if (!failed && (run.error ?? "").includes(NOT_APPLIED)) return "not_applied";
    return "caught";
}

export interface FaultDeps {
    scratchDir: string;
    env: RunEnv;
    render: RenderContext;
    workers: number;
    executor?: ScriptExecutor;
    /** Exploring saw the application use a WebSocket: socket and offline faults are tried too. */
    webSockets?: boolean;
}

/** Replay every test once per fault; one score per test (undefined: no fault took effect, so there is no score). */
export async function scoreTests(ctx: EngineContext, deps: FaultDeps, specs: TestSpec[]): Promise<Map<string, Strength | undefined>> {
    throwIfAborted(ctx.signal);
    const jobs = specs.flatMap((spec) => faultsFor(spec, { webSockets: deps.webSockets }).flatMap((fault) => {
        const input = faultScript(spec, deps.render, fault);
        return input ? [{ spec, fault, input }] : [];
    }));
    const runs = jobs.length
        ? await (deps.executor ?? ctx.executor ?? localExecutor).execute("playwright", { scratchDir: deps.scratchDir, scripts: jobs.map((j) => j.input) }, { run: deps.env }, { workers: Math.max(1, deps.workers), signal: ctx.signal })
        : [];
    const byId = new Map(runs.map((r) => [r.testId, r]));
    const out = new Map<string, Strength | undefined>();
    const checkedAt = new Date().toISOString();
    for (const spec of specs) {
        const s: Strength = { caught: 0, total: 0, missed: [], checkedAt };
        for (const j of jobs.filter((x) => x.spec === spec)) {
            const r = classifyFaultRun(byId.get(j.input.testId));
            if (r === "caught") (s.caught++, s.total++);
            else if (r === "missed") (s.total++, s.missed.push(j.fault.label));
        }
        out.set(spec.testId, s.total ? s : undefined);
    }
    return out;
}

/** "Catches 3 of 4 deliberate faults" */
export function strengthText(s: Pick<Strength, "caught" | "total">): string {
    return `catches ${s.caught} of ${s.total} deliberate fault${s.total === 1 ? "" : "s"}`;
}

/** The note a test that missed faults goes to the review path with. */
export function strengthenNote(missed: readonly string[]): string {
    return missed.map((m) => `- add an assertion that would fail when ${m}`).join("\n");
}
